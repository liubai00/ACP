package adapters

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestMain doubles as a fake agent CLI: when ACP_FAKE_AGENT is set the test
// binary prints a fixture to stdout instead of running tests, so the real
// process/pipe/kill path is exercised without Claude Code or Codex installed.
func TestMain(m *testing.M) {
	if mode := os.Getenv("ACP_FAKE_AGENT"); mode != "" {
		os.Exit(fakeAgent(mode))
	}
	os.Exit(m.Run())
}

func fakeAgent(mode string) int {
	if rec := os.Getenv("ACP_FAKE_RECORD"); rec != "" {
		info := map[string]any{"args": os.Args[1:], "gitlab_token": os.Getenv("GITLAB_TOKEN"),
			"task_token": os.Getenv(CodexTokenEnv), "credential_helper": os.Getenv("GIT_CONFIG_VALUE_0"), "cwd": mustGetwd()}
		b, _ := json.Marshal(info)
		_ = os.WriteFile(rec, b, 0o600)
	}
	switch mode {
	case "sleep":
		fmt.Println(`{"type":"system","subtype":"init","model":"fake","tools":[]}`)
		time.Sleep(60 * time.Second)
		return 0
	default:
		data, err := os.ReadFile(os.Getenv("ACP_FAKE_FIXTURE"))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		os.Stdout.Write(data)
		fmt.Fprintln(os.Stderr, "fake agent stderr line")
		code, _ := strconv.Atoi(os.Getenv("ACP_FAKE_EXIT"))
		return code
	}
}

func mustGetwd() string { d, _ := os.Getwd(); return d }

func parseFixture(t *testing.T, name string, p lineParser) []Event {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var evs []Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		evs = append(evs, p.Parse(sc.Bytes())...)
	}
	return append(evs, p.Finish()...)
}

type ev struct {
	T    EventType
	Text string
	Err  bool
}

func simplify(evs []Event) []ev {
	out := make([]ev, 0, len(evs))
	for _, e := range evs {
		out = append(out, ev{e.Type, e.Text, e.IsError})
	}
	return out
}

func TestClaudeParserFixture(t *testing.T) {
	got := simplify(parseFixture(t, "claude_stream.jsonl", NewClaudeParser()))
	want := []ev{
		{EventSystem, "Claude Code 已启动（模型 claude-sonnet-4-5，9 个工具，权限模式 acceptEdits）", false},
		{EventSystem, "MCP 服务 other 状态 failed，平台工具可能不可用", true},
		{EventText, "我先读一下 ACP_TASK.md。", false},
		{EventTool, "Read: /ws/42/ACP_TASK.md", false},
		{EventToolResult, "# ACP-42 Add hello endpoint ...", false},
		{EventTool, "Bash: go test ./... -run Hello", false},
		{EventToolResult, "Claude requested permissions to use Bash, but you haven't granted it yet.", true},
		{EventTool, `mcp__acp__post_message {"content":"进行中","task_id":42}`, false},
		{EventTool, "Edit: /ws/42/demo/main.go", false},
		{EventLog, "not json: some stray output line", false},
		{EventFinal, "已添加 /hello 接口并补充测试。", false},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("claude events mismatch\n got: %#v\nwant: %#v", got, want)
	}
	// tool_result carries the tool name from the matching tool_use.
	evs := parseFixture(t, "claude_stream.jsonl", NewClaudeParser())
	if evs[6].Tool != "Bash" {
		t.Errorf("tool_result tool = %q", evs[6].Tool)
	}

	errEvs := parseFixture(t, "claude_error.jsonl", NewClaudeParser())
	last := errEvs[len(errEvs)-1]
	if last.Type != EventFinal || !last.IsError || !strings.Contains(last.Text, "error_max_turns") {
		t.Fatalf("error result: %+v", last)
	}
}

func TestCodexParserFixture(t *testing.T) {
	got := simplify(parseFixture(t, "codex_events.jsonl", NewCodexParser()))
	want := []ev{
		{EventSystem, "Codex 已启动", false},
		{EventTool, "执行命令: bash -lc 'cat ACP_TASK.md'", false},
		{EventToolResult, "# ACP-42 Add hello endpoint", false},
		{EventTool, "调用 MCP acp.get_task", false},
		{EventTool, "修改文件: update demo/main.go, add demo/hello_test.go", false},
		{EventToolResult, "命令退出码 1: --- FAIL: TestHello FAIL", true},
		{EventText, "测试先失败了，我修一下。", false},
		{EventText, "已添加 /hello 接口，go test 通过。", false},
		{EventFinal, "已添加 /hello 接口，go test 通过。", false},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("codex events mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestCodexLegacyFixture(t *testing.T) {
	got := simplify(parseFixture(t, "codex_legacy.jsonl", NewCodexParser()))
	want := []ev{
		{EventTool, "执行命令: bash -lc ls", false},
		{EventTool, "调用 MCP acp.get_task", false},
		{EventTool, "修改文件: demo/main.go", false},
		{EventToolResult, "命令退出码 2: permission denied", true},
		{EventText, "改好了。", false},
		{EventFinal, "已添加 /hello 接口。", false},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("legacy codex events mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestCodexFailureFinal(t *testing.T) {
	p := NewCodexParser()
	p.Parse([]byte(`{"type":"turn.failed","error":{"message":"stream disconnected"}}`))
	fin := p.Finish()
	if len(fin) != 1 || !fin[0].IsError || fin[0].Text != "stream disconnected" {
		t.Fatalf("finish after failure: %+v", fin)
	}
}

func TestArgs(t *testing.T) {
	c := &Claude{opts: Options{Command: "claude", SystemPrompt: "rules", ExtraArgs: []string{"--allowedTools", "Bash(npm test:*)"}}}
	got := c.Args("do it", "/p/mcp.json")
	want := []string{"-p", "do it", "--output-format", "stream-json", "--verbose", "--mcp-config", "/p/mcp.json",
		"--allowedTools", "mcp__acp", "--permission-mode", "acceptEdits", "--append-system-prompt", "rules",
		"--allowedTools", "Bash(npm test:*)"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("claude args\n got %q\nwant %q", got, want)
	}
	if got := c.Args("x", ""); strings.Contains(strings.Join(got, " "), "mcp") {
		t.Errorf("no MCP flags expected without config: %q", got)
	}
	x := &Codex{opts: Options{ExtraArgs: []string{"--full-auto"}, MCPOverrides: []string{`mcp_servers.acp.url="{mcp_url}"`}}}
	got = x.Args("/ws/1", "--do it", "http://h/mcp")
	want = []string{"exec", "--json", "-C", "/ws/1", "--skip-git-repo-check", "-c", `mcp_servers.acp.url="http://h/mcp"`, "--full-auto", "--", "--do it"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("codex args\n got %q\nwant %q", got, want)
	}
}

func TestAgentEnv(t *testing.T) {
	base := []string{"PATH=/bin", "GITLAB_TOKEN=glpat-secret", "ACP_TOKEN=member", "ACP_LINK_CONFIG=/x", "SSH_AUTH_SOCK=/tmp/s",
		"GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=url.x.insteadOf", "GIT_CONFIG_VALUE_0=y", "HOME=/home/u", "ACP_TASK_ID=old"}
	env := AgentEnv(base, map[string]string{"ACP_TASK_ID": "42"})
	m := map[string]string{}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		if _, dup := m[k]; dup {
			t.Errorf("duplicate env key %s", k)
		}
		m[k] = v
	}
	for _, k := range []string{"GITLAB_TOKEN", "ACP_TOKEN", "ACP_LINK_CONFIG", "SSH_AUTH_SOCK"} {
		if _, ok := m[k]; ok {
			t.Errorf("%s must not reach the agent", k)
		}
	}
	if m["PATH"] != "/bin" || m["HOME"] != "/home/u" || m["ACP_TASK_ID"] != "42" {
		t.Errorf("kept/extra vars wrong: %v", m)
	}
	if m["GIT_CONFIG_KEY_0"] != "credential.helper" || m["GIT_CONFIG_VALUE_0"] != "" || m["GIT_TERMINAL_PROMPT"] != "0" {
		t.Errorf("git credential neutralisation missing: %v", m)
	}
}

func fakeEnv(t *testing.T, mode, fixture, record string, exit int) []string {
	t.Helper()
	abs, _ := filepath.Abs(filepath.Join("testdata", fixture))
	return AgentEnv(append(os.Environ(), "GITLAB_TOKEN=leak"), map[string]string{
		"ACP_FAKE_AGENT": mode, "ACP_FAKE_FIXTURE": abs, "ACP_FAKE_RECORD": record, "ACP_FAKE_EXIT": strconv.Itoa(exit),
	})
}

func collect(t *testing.T, ch <-chan Event) []Event {
	t.Helper()
	var out []Event
	timeout := time.After(60 * time.Second)
	for {
		select {
		case e, ok := <-ch:
			if !ok {
				return out
			}
			out = append(out, e)
		case <-timeout:
			t.Fatal("adapter did not finish")
		}
	}
}

func TestClaudeProcess(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Skip(err)
	}
	dir := t.TempDir()
	rec := filepath.Join(t.TempDir(), "rec.json")
	ad, _ := New("claude-code", Options{Command: exe, Env: fakeEnv(t, "claude", "claude_stream.jsonl", rec, 0)})
	ch, err := ad.Start(context.Background(), dir, "prompt text", "")
	if err != nil {
		t.Fatal(err)
	}
	evs := collect(t, ch)
	last := evs[len(evs)-1]
	if last.Type != EventExit || last.Err != nil || last.ExitCode != 0 {
		t.Fatalf("exit event: %+v", last)
	}
	var final, stderr bool
	for _, e := range evs {
		final = final || (e.Type == EventFinal && e.Text == "已添加 /hello 接口并补充测试。")
		stderr = stderr || (e.Type == EventLog && e.Text == "fake agent stderr line")
	}
	if !final || !stderr {
		t.Fatalf("missing final or stderr events: %+v", evs)
	}
	var info map[string]any
	b, _ := os.ReadFile(rec)
	_ = json.Unmarshal(b, &info)
	if info["gitlab_token"] != "" {
		t.Error("GITLAB_TOKEN leaked to the agent process")
	}
	if !samePath(info["cwd"].(string), dir) {
		t.Errorf("agent cwd = %v, want %s", info["cwd"], dir)
	}
	args := info["args"].([]any)
	if args[0] != "-p" || args[1] != "prompt text" {
		t.Errorf("args: %v", args)
	}
}

func TestClaudeProcessFailure(t *testing.T) {
	exe, _ := os.Executable()
	ad, _ := New("claude-code", Options{Command: exe, Env: fakeEnv(t, "claude", "claude_error.jsonl", "", 1)})
	ch, err := ad.Start(context.Background(), t.TempDir(), "x", "")
	if err != nil {
		t.Fatal(err)
	}
	evs := collect(t, ch)
	last := evs[len(evs)-1]
	if last.Type != EventExit || last.ExitCode != 1 || last.Err == nil || !strings.Contains(last.Err.Error(), "fake agent stderr line") {
		t.Fatalf("want exit 1 with stderr tail, got %+v", last)
	}
}

func TestStopKillsAgent(t *testing.T) {
	exe, _ := os.Executable()
	ad, _ := New("claude-code", Options{Command: exe, Env: fakeEnv(t, "sleep", "", "", 0)})
	ch, err := ad.Start(context.Background(), t.TempDir(), "x", "")
	if err != nil {
		t.Fatal(err)
	}
	first := <-ch
	if first.Type != EventSystem {
		t.Fatalf("first event %+v", first)
	}
	start := time.Now()
	go func() { _ = ad.Stop() }()
	evs := collect(t, ch)
	if time.Since(start) > 20*time.Second {
		t.Fatal("Stop took too long")
	}
	if last := evs[len(evs)-1]; last.Type != EventExit || last.Err == nil {
		t.Fatalf("killed agent should report an exit error: %+v", last)
	}
}

func TestCodexProcessWithMCP(t *testing.T) {
	exe, _ := os.Executable()
	dir := t.TempDir()
	mcp := filepath.Join(t.TempDir(), "mcp.json")
	if err := WriteMCPConfig(mcp, "http://h/mcp", "task-tok"); err != nil {
		t.Fatal(err)
	}
	rec := filepath.Join(t.TempDir(), "rec.json")
	ad, _ := New("codex", Options{Command: exe, Env: fakeEnv(t, "codex", "codex_events.jsonl", rec, 0),
		ExtraArgs: []string{"--full-auto"}, MCPOverrides: []string{`mcp_servers.acp.url="{mcp_url}"`, `mcp_servers.acp.bearer_token_env_var="ACP_TASK_TOKEN"`}})
	ch, err := ad.Start(context.Background(), dir, "do", mcp)
	if err != nil {
		t.Fatal(err)
	}
	evs := collect(t, ch)
	if last := evs[len(evs)-1]; last.Type != EventExit || last.Err != nil {
		t.Fatalf("exit: %+v", last)
	}
	var info map[string]any
	b, _ := os.ReadFile(rec)
	_ = json.Unmarshal(b, &info)
	if info["task_token"] != "task-tok" {
		t.Errorf("codex should receive the task token via %s, got %v", CodexTokenEnv, info["task_token"])
	}
	joined := fmt.Sprint(info["args"])
	if !strings.Contains(joined, `mcp_servers.acp.url="http://h/mcp"`) || strings.Contains(joined, "task-tok") {
		t.Errorf("codex args (token must not be on the command line): %s", joined)
	}

	// Without overrides: a warning event, no token in env.
	rec2 := filepath.Join(t.TempDir(), "rec2.json")
	ad2, _ := New("codex", Options{Command: exe, Env: fakeEnv(t, "codex", "codex_events.jsonl", rec2, 0)})
	ch2, err := ad2.Start(context.Background(), dir, "do", mcp)
	if err != nil {
		t.Fatal(err)
	}
	evs2 := collect(t, ch2)
	if evs2[0].Type != EventSystem || !evs2[0].IsError || !strings.Contains(evs2[0].Text, "mcp_overrides") {
		t.Errorf("expected MCP warning first, got %+v", evs2[0])
	}
}

func TestEcho(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "b-repo", ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "a-repo", ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "ACP_TASK.md"), []byte("# task"), 0o644)
	ad, _ := New("echo", Options{})
	ch, err := ad.Start(context.Background(), dir, "hello", "")
	if err != nil {
		t.Fatal(err)
	}
	evs := collect(t, ch)
	if _, err := os.Stat(filepath.Join(dir, "a-repo", EchoFile)); err != nil {
		t.Fatal("echo file not written into the first repo")
	}
	var final string
	for _, e := range evs {
		if e.Type == EventFinal {
			final = e.Text
		}
	}
	if !strings.Contains(final, "a-repo") || evs[len(evs)-1].Type != EventExit || evs[len(evs)-1].Err != nil {
		t.Fatalf("echo events: %+v", evs)
	}

	// No repo: no change, still a final answer.
	empty := t.TempDir()
	ch, _ = ad.Start(context.Background(), empty, "hello", "")
	evs = collect(t, ch)
	entries, _ := os.ReadDir(empty)
	if len(entries) != 0 {
		t.Error("echo must not write when there is no repo")
	}
	if evs[len(evs)-2].Type != EventFinal {
		t.Errorf("expected final before exit: %+v", evs)
	}
}

func samePath(a, b string) bool {
	ea, _ := filepath.EvalSymlinks(a)
	eb, _ := filepath.EvalSymlinks(b)
	return strings.EqualFold(filepath.Clean(ea), filepath.Clean(eb))
}
