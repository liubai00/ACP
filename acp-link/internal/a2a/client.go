package a2a

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"acp/acp-link/internal/api"
)

// ErrIdle means the stream produced no bytes within the idle timeout.
var ErrIdle = errors.New("subscription idle timeout")

// ErrStreamClosed means the server ended the stream.
var ErrStreamClosed = errors.New("subscription stream closed by server")

// Client is the A2A JSON-RPC client. It shares transport and tokens with api.Client.
type Client struct {
	API  *api.Client
	Path string // default "/a2a"
	seq  atomic.Int64
}

// New creates an A2A client on top of the REST client.
func New(c *api.Client) *Client { return &Client{API: c, Path: "/a2a"} }

func (c *Client) nextID() string { return fmt.Sprintf("acp-link-%d", c.seq.Add(1)) }

// NewMessageID returns a random message id.
func NewMessageID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func newMessage(text string, meta map[string]any) Message {
	parts := []Part{{Kind: "text", Text: text}}
	return Message{Kind: "message", MessageID: NewMessageID(), Role: "user", Parts: parts, Metadata: meta}
}

// Call performs a non-streaming JSON-RPC call and returns the raw result.
func (c *Client) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	rpc := Request{JSONRPC: "2.0", ID: c.nextID(), Method: method, Params: params}
	req, err := c.API.NewRequest(ctx, http.MethodPost, c.Path, rpc, true)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := c.API.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, api.DecodeResponse(resp, nil)
	}
	var out Response
	if isEventStream(resp) {
		// Tolerate servers that answer SendMessage as a one-shot stream.
		got := false
		err = ReadSSE(resp.Body, func(ev SSEEvent) error {
			if got {
				return nil
			}
			got = true
			return json.Unmarshal([]byte(ev.Data), &out)
		}, nil)
		if err != nil {
			return nil, err
		}
		if !got {
			return nil, errors.New("empty event stream response")
		}
	} else {
		data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(data, &out); err != nil {
			return nil, fmt.Errorf("invalid JSON-RPC response: %w", err)
		}
	}
	if out.Error != nil {
		return nil, out.Error
	}
	return out.Result, nil
}

func isEventStream(resp *http.Response) bool {
	mt, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	return mt == "text/event-stream"
}

// SendSkill sends a SendMessage carrying metadata.skill and returns the Task.
func (c *Client) SendSkill(ctx context.Context, skill, text string, meta map[string]any) (*Task, error) {
	m := map[string]any{"skill": skill}
	for k, v := range meta {
		m[k] = v
	}
	raw, err := c.Call(ctx, MethodSendMessage, MessageSendParams{Message: newMessage(text, m)})
	if err != nil {
		return nil, err
	}
	var t Task
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &t); err != nil {
			return nil, fmt.Errorf("decode task: %w", err)
		}
		// Accept {"task": {...}} wrappers too.
		if t.ID == "" && t.Status.State == "" {
			var w struct {
				Task *Task `json:"task"`
			}
			if json.Unmarshal(raw, &w) == nil && w.Task != nil {
				t = *w.Task
			}
		}
	}
	return &t, nil
}

// Progress is a report_progress call.
type Progress struct {
	TaskID    int64
	AgentID   string
	State     string // "" = leave unchanged
	Kind      string
	Text      string
	Artifacts []Artifact
}

// ReportProgress sends report_progress.
func (c *Client) ReportProgress(ctx context.Context, p Progress) (*Task, error) {
	meta := map[string]any{"task_id": p.TaskID, "agent_id": p.AgentID}
	if p.State != "" {
		meta["state"] = p.State
	}
	if p.Kind != "" {
		meta["kind"] = p.Kind
	}
	if len(p.Artifacts) > 0 {
		meta["artifacts"] = p.Artifacts
	}
	return c.SendSkill(ctx, SkillReportProgress, p.Text, meta)
}

// RequestInput sends request_input (task goes to input-required).
func (c *Client) RequestInput(ctx context.Context, taskID int64, agentID, question string) (*Task, error) {
	return c.SendSkill(ctx, SkillRequestInput, question, map[string]any{
		"task_id": taskID, "agent_id": agentID, "question": question,
	})
}

// CreateTaskParams is create_task metadata.
type CreateTaskParams struct {
	ParentID       int64
	Title          string
	Description    string
	TargetSkill    string
	TargetMemberID string
}

// CreateTask creates a help sub-task.
func (c *Client) CreateTask(ctx context.Context, p CreateTaskParams) (*Task, error) {
	meta := map[string]any{"parent_id": p.ParentID, "title": p.Title, "description": p.Description}
	if p.TargetSkill != "" {
		meta["target_skill"] = p.TargetSkill
	}
	if p.TargetMemberID != "" {
		meta["target_member_id"] = p.TargetMemberID
	}
	return c.SendSkill(ctx, SkillCreateTask, p.Title, meta)
}

// SubscribeOptions configures Subscribe.
type SubscribeOptions struct {
	AgentID string
	// IdleTimeout closes the stream when no bytes arrive (server pings every 30s).
	IdleTimeout time.Duration
	// OnOpen is called once the server accepted the stream (first result received).
	OnOpen func(subTaskID string)
	// OnItem receives every parsed update (assignments, pings, others).
	OnItem func(StreamItem)
}

// Subscribe opens one subscribe_assignments stream and blocks until it ends.
// It always returns a non-nil error describing why (ctx.Err(), ErrIdle,
// ErrStreamClosed, *api.Error, *RPCError or a network error).
func (c *Client) Subscribe(ctx context.Context, o SubscribeOptions) error {
	if o.IdleTimeout <= 0 {
		o.IdleTimeout = 95 * time.Second
	}
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()

	params := MessageSendParams{Message: newMessage("subscribe", map[string]any{
		"skill": SkillSubscribeAssignments, "agent_id": o.AgentID,
	})}
	rpc := Request{JSONRPC: "2.0", ID: c.nextID(), Method: MethodSendStreamingMessage, Params: params}
	req, err := c.API.NewRequest(sctx, http.MethodPost, c.Path, rpc, true)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")

	var idle atomic.Bool
	timer := time.AfterFunc(o.IdleTimeout, func() { idle.Store(true); cancel() })
	defer timer.Stop()

	resp, err := c.API.Stream.Do(req)
	if err != nil {
		if idle.Load() {
			return ErrIdle
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return api.DecodeResponse(resp, nil)
	}
	if !isEventStream(resp) {
		// A JSON-RPC error answered as plain JSON.
		var out Response
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if json.Unmarshal(data, &out) == nil && out.Error != nil {
			return out.Error
		}
		return fmt.Errorf("unexpected content type %q for subscription", resp.Header.Get("Content-Type"))
	}

	body := &touchReader{r: resp.Body, touch: func() { timer.Reset(o.IdleTimeout) }}
	opened := false
	err = ReadSSE(body, func(ev SSEEvent) error {
		if strings.TrimSpace(ev.Data) == "" {
			return nil
		}
		var r Response
		if err := json.Unmarshal([]byte(ev.Data), &r); err != nil {
			return nil // ignore garbage, keep the stream
		}
		if r.Error != nil {
			return r.Error
		}
		item, err := ParseStreamResult(r.Result)
		if err != nil {
			if o.OnItem != nil {
				o.OnItem(StreamItem{Kind: "invalid", Text: err.Error()})
			}
			return nil
		}
		if !opened {
			opened = true
			if o.OnOpen != nil {
				o.OnOpen(item.TaskID)
			}
		}
		if o.OnItem != nil {
			o.OnItem(item)
		}
		if item.Final {
			return ErrStreamClosed
		}
		return nil
	}, nil)
	switch {
	case idle.Load():
		return ErrIdle
	case ctx.Err() != nil:
		return ctx.Err()
	case err != nil:
		return err
	default:
		return ErrStreamClosed
	}
}

type touchReader struct {
	r     io.Reader
	touch func()
}

func (t *touchReader) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	if n > 0 {
		t.touch()
	}
	return n, err
}
