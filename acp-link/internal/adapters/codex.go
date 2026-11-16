package adapters

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// CodexTokenEnv carries the task-scoped token to Codex for MCP auth
// (referenced from mcp_overrides via bearer_token_env_var).
const CodexTokenEnv = "ACP_TASK_TOKEN"

// Codex runs `codex exec --json`.
type Codex struct {
	opts Options
	proc process
	// Warnings are produced while building the command line.
	Warnings []string
}

// Name implements Adapter.
func (c *Codex) Name() string { return "codex" }

// Args builds the codex command line. mcpURL may be empty.
func (c *Codex) Args(workdir, prompt, mcpURL string) []string {
	args := []string{"exec", "--json", "-C", workdir, "--skip-git-repo-check"}
	if mcpURL != "" {
		for _, o := range c.opts.MCPOverrides {
			args = append(args, "-c", strings.ReplaceAll(o, "{mcp_url}", mcpURL))
		}
	}
	args = append(args, c.opts.ExtraArgs...)
	// "--" guarantees the prompt is never parsed as a flag.
	return append(args, "--", prompt)
}

// Start implements Adapter.
func (c *Codex) Start(ctx context.Context, workdir, prompt, mcpConfigPath string) (<-chan Event, error) {
	env := c.opts.Env
	if env == nil {
		env = AgentEnv(nil, nil)
	}
	var pre []Event
	mcpURL := ""
	if mcpConfigPath != "" {
		url, token, err := ReadMCPConfig(mcpConfigPath)
		switch {
		case err != nil:
			pre = append(pre, Event{Type: EventSystem, IsError: true, Text: "读取 MCP 配置失败，Codex 不带平台工具运行: " + err.Error()})
		case len(c.opts.MCPOverrides) == 0:
			pre = append(pre, Event{Type: EventSystem, IsError: true, Text: "未配置 codex.mcp_overrides，Codex 不带平台 MCP 工具运行"})
		default:
			mcpURL = url
			env = append(append([]string(nil), env...), CodexTokenEnv+"="+token)
		}
	}
	ch, err := c.proc.start(ctx, c.opts.Command, c.Args(workdir, prompt, mcpURL), workdir, env, NewCodexParser())
	if err != nil || len(pre) == 0 {
		return ch, err
	}
	out := make(chan Event, 256)
	go func() {
		for _, e := range pre {
			out <- e
		}
		for e := range ch {
			out <- e
		}
		close(out)
	}()
	return out, nil
}

// Stop implements Adapter.
func (c *Codex) Stop() error { return c.proc.stop() }

// CodexParser parses `codex exec --json` JSONL. Both the item-based format
// (thread.started / item.completed / turn.completed) and the older
// {"id":..,"msg":{"type":..}} format are understood; unknown events are ignored.
type CodexParser struct {
	lastMessage string
	final       bool
	failed      string
}

// NewCodexParser returns a parser.
func NewCodexParser() *CodexParser { return &CodexParser{} }

type codexItem struct {
	ID               string          `json:"id"`
	Type             string          `json:"type"`
	ItemType         string          `json:"item_type"`
	Text             string          `json:"text"`
	Command          json.RawMessage `json:"command"`
	AggregatedOutput string          `json:"aggregated_output"`
	ExitCode         *int            `json:"exit_code"`
	Status           string          `json:"status"`
	Server           string          `json:"server"`
	Tool             string          `json:"tool"`
	Query            string          `json:"query"`
	Message          string          `json:"message"`
	Changes          json.RawMessage `json:"changes"`
}

type codexLine struct {
	Type  string     `json:"type"`
	Item  *codexItem `json:"item"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
	Message string          `json:"message"`
	Msg     json.RawMessage `json:"msg"`
}

// Parse implements lineParser.
func (p *CodexParser) Parse(line []byte) []Event {
	s := strings.TrimSpace(string(line))
	if s == "" {
		return nil
	}
	if !strings.HasPrefix(s, "{") {
		return []Event{{Type: EventLog, Text: s}}
	}
	var l codexLine
	if err := json.Unmarshal([]byte(s), &l); err != nil {
		return []Event{{Type: EventLog, Text: Truncate(s, 300)}}
	}
	if len(l.Msg) > 0 {
		return p.parseLegacy(l.Msg)
	}
	switch l.Type {
	case "thread.started":
		return []Event{{Type: EventSystem, Text: "Codex 已启动"}}
	case "item.started":
		if l.Item == nil {
			return nil
		}
		switch itemType(l.Item) {
		case "command_execution":
			return []Event{{Type: EventTool, Tool: "shell", Text: "执行命令: " + Truncate(oneLine(commandString(l.Item.Command)), 200)}}
		case "mcp_tool_call":
			return []Event{{Type: EventTool, Tool: l.Item.Tool, Text: fmt.Sprintf("调用 MCP %s.%s", l.Item.Server, l.Item.Tool)}}
		}
		return nil
	case "item.completed", "item.updated":
		if l.Item == nil || l.Type == "item.updated" {
			return nil
		}
		return p.completedItem(l.Item)
	case "turn.failed":
		msg := "Codex 回合失败"
		if l.Error != nil && l.Error.Message != "" {
			msg = l.Error.Message
		}
		p.failed = msg
		return []Event{{Type: EventError, IsError: true, Text: msg}}
	case "error":
		msg := l.Message
		if msg == "" && l.Error != nil {
			msg = l.Error.Message
		}
		if msg == "" {
			return nil
		}
		p.failed = msg
		return []Event{{Type: EventError, IsError: true, Text: msg}}
	}
	return nil
}

func itemType(it *codexItem) string {
	if it.Type != "" {
		return it.Type
	}
	return it.ItemType
}

func (p *CodexParser) completedItem(it *codexItem) []Event {
	switch itemType(it) {
	case "agent_message", "assistant_message":
		t := strings.TrimSpace(it.Text)
		if t == "" {
			return nil
		}
		p.lastMessage = t
		return []Event{{Type: EventText, Text: t}}
	case "command_execution":
		if it.ExitCode != nil && *it.ExitCode != 0 {
			return []Event{{Type: EventToolResult, Tool: "shell", IsError: true,
				Text: fmt.Sprintf("命令退出码 %d: %s", *it.ExitCode, Truncate(oneLine(it.AggregatedOutput), 300))}}
		}
		return []Event{{Type: EventToolResult, Tool: "shell", Text: Truncate(oneLine(it.AggregatedOutput), 200)}}
	case "file_change":
		var changes []struct {
			Path string `json:"path"`
			Kind string `json:"kind"`
		}
		_ = json.Unmarshal(it.Changes, &changes)
		var parts []string
		for _, c := range changes {
			parts = append(parts, c.Kind+" "+c.Path)
		}
		return []Event{{Type: EventTool, Tool: "apply_patch", Text: "修改文件: " + Truncate(strings.Join(parts, ", "), 300)}}
	case "mcp_tool_call":
		if it.Status == "failed" {
			return []Event{{Type: EventToolResult, Tool: it.Tool, IsError: true, Text: fmt.Sprintf("MCP %s.%s 调用失败", it.Server, it.Tool)}}
		}
	case "web_search":
		return []Event{{Type: EventTool, Tool: "web_search", Text: "搜索: " + Truncate(it.Query, 200)}}
	case "error":
		if it.Message != "" {
			return []Event{{Type: EventError, IsError: true, Text: it.Message}}
		}
	}
	return nil
}

func (p *CodexParser) parseLegacy(raw json.RawMessage) []Event {
	var m struct {
		Type             string          `json:"type"`
		Message          string          `json:"message"`
		Command          json.RawMessage `json:"command"`
		ExitCode         *int            `json:"exit_code"`
		Stderr           string          `json:"stderr"`
		LastAgentMessage *string         `json:"last_agent_message"`
		Changes          map[string]any  `json:"changes"`
		Invocation       *struct {
			Server string `json:"server"`
			Tool   string `json:"tool"`
		} `json:"invocation"`
	}
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	switch m.Type {
	case "agent_message":
		t := strings.TrimSpace(m.Message)
		if t == "" {
			return nil
		}
		p.lastMessage = t
		return []Event{{Type: EventText, Text: t}}
	case "exec_command_begin":
		return []Event{{Type: EventTool, Tool: "shell", Text: "执行命令: " + Truncate(oneLine(commandString(m.Command)), 200)}}
	case "exec_command_end":
		if m.ExitCode != nil && *m.ExitCode != 0 {
			return []Event{{Type: EventToolResult, Tool: "shell", IsError: true, Text: fmt.Sprintf("命令退出码 %d: %s", *m.ExitCode, Truncate(oneLine(m.Stderr), 300))}}
		}
	case "patch_apply_begin":
		var files []string
		for f := range m.Changes {
			files = append(files, f)
		}
		return []Event{{Type: EventTool, Tool: "apply_patch", Text: "修改文件: " + Truncate(strings.Join(files, ", "), 300)}}
	case "mcp_tool_call_begin":
		if m.Invocation != nil {
			return []Event{{Type: EventTool, Tool: m.Invocation.Tool, Text: fmt.Sprintf("调用 MCP %s.%s", m.Invocation.Server, m.Invocation.Tool)}}
		}
	case "task_complete":
		text := p.lastMessage
		if m.LastAgentMessage != nil && strings.TrimSpace(*m.LastAgentMessage) != "" {
			text = strings.TrimSpace(*m.LastAgentMessage)
		}
		p.final = true
		return []Event{{Type: EventFinal, Text: text}}
	case "error", "stream_error":
		p.failed = m.Message
		return []Event{{Type: EventError, IsError: true, Text: m.Message}}
	}
	return nil
}

// Finish synthesises the final answer from the last agent message.
func (p *CodexParser) Finish() []Event {
	if p.final {
		return nil
	}
	p.final = true
	if p.failed != "" && p.lastMessage == "" {
		return []Event{{Type: EventFinal, IsError: true, Text: p.failed}}
	}
	return []Event{{Type: EventFinal, Text: p.lastMessage}}
}

// commandString accepts a string or an argv array.
func commandString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var argv []string
	if json.Unmarshal(raw, &argv) == nil {
		return strings.Join(argv, " ")
	}
	return string(raw)
}
