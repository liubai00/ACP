package a2a

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"acp/acp-link/internal/api"
)

// Method names (A2A 1.0 spelling; the server also accepts the legacy ones).
const (
	MethodSendMessage          = "SendMessage"
	MethodSendStreamingMessage = "SendStreamingMessage"
)

// Skills used by acp-link.
const (
	SkillSubscribeAssignments = "subscribe_assignments"
	SkillReportProgress       = "report_progress"
	SkillRequestInput         = "request_input"
	SkillCreateTask           = "create_task"
)

// Progress kinds (report_progress metadata.kind).
const (
	KindAck        = "ack"
	KindProgress   = "progress"
	KindTool       = "tool"
	KindConclusion = "conclusion"
	KindArtifact   = "artifact"
)

// Task states.
const (
	StateWorking       = "working"
	StateInputRequired = "input-required"
	StateCompleted     = "completed"
	StateFailed        = "failed"
)

// Request is a JSON-RPC 2.0 request.
type Request struct {
	JSONRPC string `json:"jsonrpc"`
	ID      string `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

// Response is a JSON-RPC 2.0 response (also each SSE data payload).
type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *RPCError       `json:"error"`
}

// RPCError is a JSON-RPC error object.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	if len(e.Data) > 0 && string(e.Data) != "null" {
		return fmt.Sprintf("a2a error %d: %s (%s)", e.Code, e.Message, string(e.Data))
	}
	return fmt.Sprintf("a2a error %d: %s", e.Code, e.Message)
}

// Part is a message part (text or data).
type Part struct {
	Kind string          `json:"kind"`
	Text string          `json:"text,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
}

// Message is an A2A message.
type Message struct {
	Kind      string         `json:"kind,omitempty"`
	MessageID string         `json:"messageId,omitempty"`
	Role      string         `json:"role"`
	Parts     []Part         `json:"parts"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

// MessageSendParams is params for SendMessage / SendStreamingMessage.
type MessageSendParams struct {
	Message Message `json:"message"`
}

// TaskStatus is an A2A task status.
type TaskStatus struct {
	State     string   `json:"state"`
	Timestamp string   `json:"timestamp,omitempty"`
	Message   *Message `json:"message,omitempty"`
}

// ArtifactPart is the A2A artifact as returned on Task.
type ArtifactPart struct {
	ArtifactID string `json:"artifactId"`
	Name       string `json:"name"`
	Parts      []Part `json:"parts"`
}

// Task is the A2A Task shape returned by SendMessage.
type Task struct {
	Kind      string         `json:"kind"`
	ID        string         `json:"id"`
	ContextID string         `json:"contextId"`
	Status    TaskStatus     `json:"status"`
	Artifacts []ArtifactPart `json:"artifacts"`
	Metadata  map[string]any `json:"metadata"`
}

// State returns the normalised task state.
func (t *Task) State() string { return NormalizeState(t.Status.State) }

// Artifact is a report_progress artifact (metadata.artifacts[]).
type Artifact struct {
	Name   string  `json:"name"`
	Repo   string  `json:"repo"`
	Branch string  `json:"branch"`
	URL    *string `json:"url"`
}

// NormalizeState maps "TASK_STATE_INPUT_REQUIRED" style values to "input-required".
func NormalizeState(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.TrimPrefix(s, "task_state_")
	s = strings.ReplaceAll(s, "_", "-")
	if s == "cancelled" {
		s = "canceled"
	}
	return s
}

// StreamItem is one parsed subscribe_assignments update.
type StreamItem struct {
	Kind     string // task | status-update | other
	TaskID   string // A2A task id of the update (the subscription "sub-<agent_id>")
	State    string
	Final    bool
	DataType string // assignment | revoked | message | task_state | ping | ...
	Text     string // first text part, or data.text for "message"

	// Assignment is set for data.type "assignment"; Reason is
	// new | input_answered | approval_rejected | ci_failed | approved_continue.
	Assignment *api.TaskSummary
	Reason     string
	// DataTaskID is data.task_id (revoked / message) or data.task.id.
	DataTaskID int64
	// From is the sender name of a "message".
	From string
	// Task is data.task for "task_state".
	Task *api.TaskSummary
}

// Data types pushed on the subscription stream.
const (
	DataAssignment = "assignment"
	DataRevoked    = "revoked"
	DataMessage    = "message"
	DataTaskState  = "task_state"
	DataPing       = "ping"
)

// ParseStreamResult interprets the `result` of one SSE JSON-RPC response.
// Unknown fields are ignored; both the contract's `kind` discriminator and the
// A2A 1.0 wrapper style ({"statusUpdate": {...}} / {"task": {...}}) are accepted.
func ParseStreamResult(raw json.RawMessage) (StreamItem, error) {
	var item StreamItem
	if len(bytes.TrimSpace(raw)) == 0 || string(raw) == "null" {
		return item, errors.New("empty result")
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil {
		return item, fmt.Errorf("result is not an object: %w", err)
	}
	var kind string
	if k, ok := probe["kind"]; ok {
		_ = json.Unmarshal(k, &kind)
	}
	// A2A 1.0 wrappers.
	if kind == "" {
		if inner, ok := probe["statusUpdate"]; ok {
			raw, kind = inner, "status-update"
		} else if inner, ok := probe["task"]; ok && bytes.HasPrefix(bytes.TrimSpace(inner), []byte("{")) {
			raw, kind = inner, "task"
		}
	}
	var body struct {
		ID     string     `json:"id"`
		TaskID string     `json:"taskId"`
		Status TaskStatus `json:"status"`
		Final  bool       `json:"final"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return item, fmt.Errorf("decode result: %w", err)
	}
	if kind == "" {
		switch {
		case body.TaskID != "":
			kind = "status-update"
		case body.ID != "":
			kind = "task"
		default:
			kind = "other"
		}
	}
	item.Kind = kind
	item.TaskID = body.TaskID
	if item.TaskID == "" {
		item.TaskID = body.ID
	}
	item.State = NormalizeState(body.Status.State)
	item.Final = body.Final
	if body.Status.Message == nil {
		return item, nil
	}
	for _, p := range body.Status.Message.Parts {
		if p.Text != "" && item.Text == "" {
			item.Text = p.Text
		}
		if len(p.Data) == 0 {
			continue
		}
		dt, payload := decodeDataPart(p.Data)
		if dt == "" {
			continue
		}
		item.DataType = dt
		var g struct {
			Task   *api.TaskSummary `json:"task"`
			TaskID json.RawMessage  `json:"task_id"`
			Reason string           `json:"reason"`
			From   string           `json:"from"`
			Text   string           `json:"text"`
		}
		if err := json.Unmarshal(payload, &g); err != nil {
			return item, fmt.Errorf("data part %q: %w", dt, err)
		}
		item.Reason, item.From = g.Reason, g.From
		item.DataTaskID = parseID(g.TaskID)
		if item.DataTaskID == 0 && g.Task != nil {
			item.DataTaskID = g.Task.ID
		}
		if g.Text != "" {
			item.Text = g.Text
		}
		switch dt {
		case DataAssignment:
			if g.Task == nil || g.Task.ID == 0 {
				return item, errors.New("assignment without valid task")
			}
			item.Assignment = g.Task
			if item.Reason == "" {
				item.Reason = "new"
			}
		case DataTaskState:
			item.Task = g.Task
		}
		return item, nil
	}
	return item, nil
}

// parseID accepts a JSON number or a numeric string.
func parseID(raw json.RawMessage) int64 {
	if len(raw) == 0 {
		return 0
	}
	var n int64
	if json.Unmarshal(raw, &n) == nil {
		return n
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		var v int64
		if _, err := fmt.Sscan(strings.TrimPrefix(strings.TrimSpace(s), "ACP-"), &v); err == nil {
			return v
		}
	}
	return 0
}

// decodeDataPart returns data.type and the object holding it. It accepts
// {"type":...} directly or nested once as {"data":{"type":...}}.
func decodeDataPart(d json.RawMessage) (string, json.RawMessage) {
	var obj map[string]json.RawMessage
	if json.Unmarshal(d, &obj) != nil {
		return "", nil
	}
	var t string
	if v, ok := obj["type"]; ok && json.Unmarshal(v, &t) == nil && t != "" {
		return t, d
	}
	if inner, ok := obj["data"]; ok {
		var in map[string]json.RawMessage
		if json.Unmarshal(inner, &in) == nil {
			if v, ok := in["type"]; ok && json.Unmarshal(v, &t) == nil && t != "" {
				return t, inner
			}
		}
	}
	return "", nil
}
