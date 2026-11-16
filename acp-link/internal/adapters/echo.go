package adapters

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// EchoFile is the file the echo adapter writes into the first repo worktree.
const EchoFile = "ACP_ECHO.md"

// Echo is a model-free test adapter: it reads ACP_TASK.md, writes a small file
// into the first repository worktree under workdir and emits a few events.
type Echo struct {
	opts Options
	// Delay between events (tests use it to exercise throttling).
	Delay time.Duration

	mu     sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}
}

// Name implements Adapter.
func (e *Echo) Name() string { return "echo" }

// Start implements Adapter.
func (e *Echo) Start(ctx context.Context, workdir, prompt, mcpConfigPath string) (<-chan Event, error) {
	if st, err := os.Stat(workdir); err != nil || !st.IsDir() {
		return nil, fmt.Errorf("workdir %s 不存在", workdir)
	}
	cctx, cancel := context.WithCancel(ctx)
	e.mu.Lock()
	e.cancel, e.done = cancel, make(chan struct{})
	done := e.done
	e.mu.Unlock()
	ch := make(chan Event, 32)
	go func() {
		defer close(done)
		defer close(ch)
		defer cancel()
		emit := func(ev Event) bool {
			if e.Delay > 0 {
				select {
				case <-cctx.Done():
					return false
				case <-time.After(e.Delay):
				}
			}
			if cctx.Err() != nil {
				return false
			}
			ch <- ev
			return true
		}
		fail := func(err error) {
			ch <- Event{Type: EventExit, ExitCode: 1, Err: err}
		}
		if !emit(Event{Type: EventSystem, Text: "回显 Agent 已启动（不调用模型）"}) {
			fail(context.Cause(cctx))
			return
		}
		ctxFile := filepath.Join(workdir, "ACP_TASK.md")
		if b, err := os.ReadFile(ctxFile); err == nil {
			emit(Event{Type: EventText, Text: fmt.Sprintf("已读取 ACP_TASK.md（%d 字节）", len(b))})
		} else {
			emit(Event{Type: EventText, Text: "未找到 ACP_TASK.md"})
		}
		if mcpConfigPath != "" {
			if u, _, err := ReadMCPConfig(mcpConfigPath); err == nil {
				emit(Event{Type: EventText, Text: "平台 MCP 地址：" + u})
			}
		}
		repo := firstRepoDir(workdir)
		if repo == "" {
			emit(Event{Type: EventFinal, Text: "回显 Agent：工作区里没有仓库，未修改任何文件。收到的提示：" + Truncate(prompt, 200)})
			ch <- Event{Type: EventExit}
			return
		}
		target := filepath.Join(repo, EchoFile)
		if !emit(Event{Type: EventTool, Tool: "Write", Text: "Write: " + filepath.Base(repo) + "/" + EchoFile}) {
			fail(context.Cause(cctx))
			return
		}
		sum := sha256.Sum256([]byte(prompt))
		body := fmt.Sprintf("# ACP echo\n\n由 acp-link 回显适配器生成。\n\n- 时间：%s\n- 提示摘要：%s\n", time.Now().UTC().Format(time.RFC3339Nano), hex.EncodeToString(sum[:8]))
		if err := os.WriteFile(target, []byte(body), 0o644); err != nil {
			ch <- Event{Type: EventFinal, IsError: true, Text: "写入失败：" + err.Error()}
			fail(err)
			return
		}
		emit(Event{Type: EventToolResult, Tool: "Write", Text: "ok"})
		if !emit(Event{Type: EventFinal, Text: fmt.Sprintf("回显 Agent 已完成：在 %s/%s 写入回显文件。", filepath.Base(repo), EchoFile)}) {
			fail(context.Cause(cctx))
			return
		}
		ch <- Event{Type: EventExit}
	}()
	return ch, nil
}

// Stop implements Adapter.
func (e *Echo) Stop() error {
	e.mu.Lock()
	cancel, done := e.cancel, e.done
	e.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
	return nil
}

// firstRepoDir returns the first (sorted) direct child of dir that contains .git.
func firstRepoDir(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, n := range names {
		if _, err := os.Stat(filepath.Join(dir, n, ".git")); err == nil {
			return filepath.Join(dir, n)
		}
	}
	return ""
}
