// Package adapters launches coding agents headlessly and turns their output
// into a common event stream. It is the only code that knows about specific
// agent CLIs.
package adapters

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"unicode/utf8"
)

// EventType classifies adapter events.
type EventType string

// Event types.
const (
	EventSystem     EventType = "system"      // agent started / environment notes
	EventText       EventType = "text"        // assistant prose
	EventTool       EventType = "tool"        // tool call / command execution
	EventToolResult EventType = "tool_result" // tool output (usually only errors are reported)
	EventFinal      EventType = "final"       // the agent's final answer
	EventError      EventType = "error"       // agent-reported error
	EventLog        EventType = "log"         // stderr / unparsed output (local log only)
	EventExit       EventType = "exit"        // process ended; always the last event
)

// Event is one normalised agent event.
type Event struct {
	Type     EventType
	Text     string
	Tool     string
	IsError  bool
	ExitCode int
	Err      error
}

// Adapter runs one agent session.
type Adapter interface {
	Name() string
	// Start launches the agent in workdir. The returned channel is closed
	// after an EventExit has been delivered.
	Start(ctx context.Context, workdir, prompt, mcpConfigPath string) (<-chan Event, error)
	// Stop terminates the agent (and its child processes).
	Stop() error
}

// Options configures an adapter instance.
type Options struct {
	Command      string
	ExtraArgs    []string
	MCPOverrides []string // codex only: values for -c, {mcp_url} is substituted
	// Env is the complete child environment (see AgentEnv). nil = AgentEnv(os.Environ()).
	Env []string
	// SystemPrompt is appended to the agent's system prompt when supported.
	SystemPrompt string
	Log          *slog.Logger
}

// Names lists supported adapters.
var Names = []string{"claude-code", "codex", "echo"}

// New returns the adapter by name.
func New(name string, o Options) (Adapter, error) {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	switch name {
	case "claude-code", "claude":
		if o.Command == "" {
			o.Command = "claude"
		}
		return &Claude{opts: o}, nil
	case "codex":
		if o.Command == "" {
			o.Command = "codex"
		}
		return &Codex{opts: o}, nil
	case "echo":
		return &Echo{opts: o}, nil
	}
	return nil, fmt.Errorf("unknown adapter %q", name)
}

// Truncate shortens s to at most n runes, appending an ellipsis.
func Truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}

// oneLine collapses whitespace so tool summaries stay on one line.
func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
