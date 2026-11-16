package adapters

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// MCPServerName is the MCP server key used in generated configs; Claude Code
// exposes its tools as mcp__acp__<tool>.
const MCPServerName = "acp"

// Claude runs `claude -p ... --output-format stream-json`.
type Claude struct {
	opts Options
	proc process
}

// Name implements Adapter.
func (c *Claude) Name() string { return "claude-code" }

// Args builds the claude command line. The prompt directly follows -p so that
// variadic flags (--mcp-config, --allowedTools) can never swallow it.
func (c *Claude) Args(prompt, mcpConfigPath string) []string {
	args := []string{"-p", prompt, "--output-format", "stream-json", "--verbose"}
	if mcpConfigPath != "" {
		args = append(args, "--mcp-config", mcpConfigPath, "--allowedTools", "mcp__"+MCPServerName)
	}
	args = append(args, "--permission-mode", "acceptEdits")
	if c.opts.SystemPrompt != "" {
		args = append(args, "--append-system-prompt", c.opts.SystemPrompt)
	}
	return append(args, c.opts.ExtraArgs...)
}

// Start implements Adapter.
func (c *Claude) Start(ctx context.Context, workdir, prompt, mcpConfigPath string) (<-chan Event, error) {
	env := c.opts.Env
	if env == nil {
		env = AgentEnv(nil, nil)
	}
	return c.proc.start(ctx, c.opts.Command, c.Args(prompt, mcpConfigPath), workdir, env, NewClaudeParser())
}

// Stop implements Adapter.
func (c *Claude) Stop() error { return c.proc.stop() }

// ClaudeParser parses Claude Code stream-json lines.
type ClaudeParser struct {
	tools     map[string]string // tool_use id -> name
	gotResult bool
}

// NewClaudeParser returns a parser.
func NewClaudeParser() *ClaudeParser { return &ClaudeParser{tools: map[string]string{}} }

type claudeLine struct {
	Type       string   `json:"type"`
	Subtype    string   `json:"subtype"`
	Model      string   `json:"model"`
	Tools      []string `json:"tools"`
	MCPServers []struct {
		Name   string `json:"name"`
		Status string `json:"status"`
	} `json:"mcp_servers"`
	PermissionMode string `json:"permissionMode"`
	Message        *struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
	ParentToolUseID *string  `json:"parent_tool_use_id"`
	Result          *string  `json:"result"`
	IsError         bool     `json:"is_error"`
	NumTurns        int      `json:"num_turns"`
	TotalCostUSD    float64  `json:"total_cost_usd"`
	Errors          []string `json:"errors"`
}

type claudeBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

// Parse implements lineParser.
func (p *ClaudeParser) Parse(line []byte) []Event {
	s := strings.TrimSpace(string(line))
	if s == "" {
		return nil
	}
	if !strings.HasPrefix(s, "{") {
		return []Event{{Type: EventLog, Text: s}}
	}
	var l claudeLine
	if err := json.Unmarshal([]byte(s), &l); err != nil {
		return []Event{{Type: EventLog, Text: Truncate(s, 300)}}
	}
	switch l.Type {
	case "system":
		if l.Subtype != "init" {
			return nil
		}
		evs := []Event{{Type: EventSystem, Text: fmt.Sprintf("Claude Code 已启动（模型 %s，%d 个工具，权限模式 %s）", orDash(l.Model), len(l.Tools), orDash(l.PermissionMode))}}
		for _, m := range l.MCPServers {
			if m.Status != "" && m.Status != "connected" {
				evs = append(evs, Event{Type: EventSystem, IsError: true, Text: fmt.Sprintf("MCP 服务 %s 状态 %s，平台工具可能不可用", m.Name, m.Status)})
			}
		}
		return evs
	case "assistant":
		if l.Message == nil {
			return nil
		}
		var blocks []claudeBlock
		if json.Unmarshal(l.Message.Content, &blocks) != nil {
			return nil
		}
		var evs []Event
		for _, b := range blocks {
			switch b.Type {
			case "text":
				if t := strings.TrimSpace(b.Text); t != "" {
					evs = append(evs, Event{Type: EventText, Text: t})
				}
			case "tool_use":
				p.tools[b.ID] = b.Name
				evs = append(evs, Event{Type: EventTool, Tool: b.Name, Text: summarizeToolInput(b.Name, b.Input)})
			}
		}
		return evs
	case "user":
		if l.Message == nil {
			return nil
		}
		var blocks []claudeBlock
		if json.Unmarshal(l.Message.Content, &blocks) != nil {
			return nil
		}
		var evs []Event
		for _, b := range blocks {
			if b.Type != "tool_result" {
				continue
			}
			evs = append(evs, Event{Type: EventToolResult, Tool: p.tools[b.ToolUseID], IsError: b.IsError, Text: Truncate(oneLine(contentText(b.Content)), 300)})
		}
		return evs
	case "result":
		p.gotResult = true
		text := ""
		if l.Result != nil {
			text = strings.TrimSpace(*l.Result)
		}
		isErr := l.IsError || (l.Subtype != "" && l.Subtype != "success")
		if text == "" && len(l.Errors) > 0 {
			text = strings.Join(l.Errors, "; ")
		}
		if text == "" && isErr {
			text = "Claude Code 结束：" + l.Subtype
		}
		return []Event{{Type: EventFinal, Text: text, IsError: isErr}}
	}
	return nil
}

// Finish implements lineParser.
func (p *ClaudeParser) Finish() []Event { return nil }

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// contentText flattens tool_result content (string or [{type:text,text}]).
func contentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		var b strings.Builder
		for _, p := range parts {
			if p.Text != "" {
				if b.Len() > 0 {
					b.WriteByte(' ')
				}
				b.WriteString(p.Text)
			}
		}
		return b.String()
	}
	return string(raw)
}

// summarizeToolInput renders a short, single-line description of a tool call.
func summarizeToolInput(tool string, raw json.RawMessage) string {
	var in map[string]any
	if json.Unmarshal(raw, &in) != nil || len(in) == 0 {
		return tool
	}
	for _, k := range []string{"command", "file_path", "path", "notebook_path", "pattern", "url", "query", "description", "prompt"} {
		if v, ok := in[k].(string); ok && v != "" {
			return fmt.Sprintf("%s: %s", tool, Truncate(oneLine(v), 200))
		}
	}
	b, _ := json.Marshal(in) // map keys are emitted sorted
	return fmt.Sprintf("%s %s", tool, Truncate(string(b), 200))
}
