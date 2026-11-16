package adapters

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// lineParser turns one stdout line into events.
type lineParser interface {
	Parse(line []byte) []Event
	// Finish is called after stdout is drained (e.g. to synthesise a final answer).
	Finish() []Event
}

// process runs an agent CLI and streams parsed events.
type process struct {
	mu     sync.Mutex
	cmd    *exec.Cmd
	cancel context.CancelFunc
	done   chan struct{}
}

func (p *process) start(ctx context.Context, bin string, args []string, dir string, env []string, parser lineParser) (<-chan Event, error) {
	path, err := exec.LookPath(bin)
	if err != nil {
		return nil, fmt.Errorf("找不到 Agent 命令 %q（检查 PATH 或配置里的 command）: %w", bin, err)
	}
	cctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(cctx, path, args...)
	cmd.Dir = dir
	cmd.Env = env
	cmd.Stdin = nil
	setProcAttr(cmd)
	cmd.Cancel = func() error { return killTree(cmd.Process) }
	cmd.WaitDelay = 10 * time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("启动 %s 失败: %w", bin, err)
	}
	p.mu.Lock()
	p.cmd, p.cancel, p.done = cmd, cancel, make(chan struct{})
	p.mu.Unlock()

	events := make(chan Event, 256)
	var wg sync.WaitGroup
	tail := &tailBuffer{max: 30}
	wg.Add(2)
	go func() {
		defer wg.Done()
		readLines(stdout, func(line []byte) {
			for _, ev := range parser.Parse(line) {
				events <- ev
			}
		})
	}()
	go func() {
		defer wg.Done()
		readLines(stderr, func(line []byte) {
			s := strings.TrimSpace(string(line))
			if s == "" {
				return
			}
			tail.add(s)
			events <- Event{Type: EventLog, Text: s}
		})
	}()
	go func() {
		wg.Wait()
		for _, ev := range parser.Finish() {
			events <- ev
		}
		werr := cmd.Wait()
		code := 0
		if cmd.ProcessState != nil {
			code = cmd.ProcessState.ExitCode()
		}
		exit := Event{Type: EventExit, ExitCode: code}
		if werr != nil {
			if cctx.Err() != nil {
				exit.Err = fmt.Errorf("agent terminated: %w", context.Cause(cctx))
			} else if t := tail.String(); t != "" {
				exit.Err = fmt.Errorf("%v; stderr: %s", werr, t)
			} else {
				exit.Err = werr
			}
		}
		events <- exit
		close(events)
		cancel()
		close(p.done)
	}()
	return events, nil
}

func (p *process) stop() error {
	p.mu.Lock()
	cancel, done := p.cancel, p.done
	p.mu.Unlock()
	if cancel == nil {
		return nil
	}
	cancel()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		return errors.New("agent did not exit in time")
	}
	return nil
}

func readLines(r io.Reader, fn func([]byte)) {
	br := bufio.NewReaderSize(r, 256<<10)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			fn(bytes.TrimRight(line, "\r\n"))
		}
		if err != nil {
			return
		}
	}
}

type tailBuffer struct {
	mu    sync.Mutex
	max   int
	lines []string
}

func (t *tailBuffer) add(s string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.lines = append(t.lines, Truncate(s, 500))
	if len(t.lines) > t.max {
		t.lines = t.lines[len(t.lines)-t.max:]
	}
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := len(t.lines)
	if n > 5 {
		return strings.Join(t.lines[n-5:], " | ")
	}
	return strings.Join(t.lines, " | ")
}

// AgentEnv builds the environment for a coding agent from base (usually
// os.Environ()): it drops platform/GitLab credentials, neutralises git
// credential helpers and ssh agents, and adds extra (KEY=VALUE).
func AgentEnv(base []string, extra map[string]string) []string {
	if base == nil {
		base = os.Environ()
	}
	drop := map[string]bool{
		"ACP_TOKEN": true, "ACP_MEMBER_TOKEN": true, "ACP_ACCESS_TOKEN": true,
		"GITLAB_TOKEN": true, "GITLAB_PRIVATE_TOKEN": true, "GITLAB_ACCESS_TOKEN": true,
		"GITLAB_API_TOKEN": true, "GL_TOKEN": true, "CI_JOB_TOKEN": true, "GLAB_TOKEN": true,
		"GIT_ASKPASS": true, "SSH_ASKPASS": true, "SSH_AUTH_SOCK": true,
		"GIT_CONFIG_COUNT": true, "GIT_SSH": true, "GIT_SSH_COMMAND": true,
	}
	out := make([]string, 0, len(base)+12)
	for _, kv := range base {
		k := kv
		if i := strings.IndexByte(kv, '='); i > 0 {
			k = kv[:i]
		}
		uk := strings.ToUpper(k)
		if drop[uk] || strings.HasPrefix(uk, "GIT_CONFIG_KEY_") || strings.HasPrefix(uk, "GIT_CONFIG_VALUE_") ||
			strings.HasPrefix(uk, "ACP_LINK_") || strings.HasPrefix(uk, "ACP_TASK_") {
			continue
		}
		if _, overridden := extra[k]; overridden {
			continue
		}
		out = append(out, kv)
	}
	// Git run by the agent gets no credential helper, no prompts and no ssh,
	// so it cannot push with the developer's GitLab identity. acp-link pushes.
	out = append(out,
		"GIT_TERMINAL_PROMPT=0",
		"GCM_INTERACTIVE=never",
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=credential.helper",
		"GIT_CONFIG_VALUE_0=",
		"GIT_SSH_COMMAND=echo acp-link: git over ssh is disabled for agents >&2; exit 1",
	)
	for k, v := range extra {
		out = append(out, k+"="+v)
	}
	return out
}
