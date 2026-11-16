package a2a

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"acp/acp-link/internal/api"
)

func readFixture(t *testing.T) []SSEEvent {
	t.Helper()
	f, err := os.Open("testdata/subscribe.sse")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var evs []SSEEvent
	var comments []string
	if err := ReadSSE(f, func(e SSEEvent) error { evs = append(evs, e); return nil }, func(c string) { comments = append(comments, c) }); err != nil {
		t.Fatal(err)
	}
	if len(comments) != 2 || comments[0] != "connected" || comments[1] != "ping" {
		t.Errorf("comments = %q", comments)
	}
	return evs
}

func TestReadSSEFixture(t *testing.T) {
	evs := readFixture(t)
	if len(evs) != 8 {
		t.Fatalf("got %d events, want 8 (unterminated trailing event dropped)", len(evs))
	}
	if evs[0].ID != "1" || evs[1].Event != "message" || evs[1].ID != "2" {
		t.Errorf("id/event fields: %+v %+v", evs[0], evs[1])
	}
	if !strings.Contains(evs[2].Data, "\n") {
		t.Error("multi-line data must be joined with newline")
	}
}

func TestReadSSELineEndings(t *testing.T) {
	in := "data: a\r\n\r\ndata: b\rdata: c\r\r: x\n\ndata: d\n\n"
	var got []string
	_ = ReadSSE(strings.NewReader(in), func(e SSEEvent) error { got = append(got, e.Data); return nil }, nil)
	want := []string{"a", "b\nc", "d"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestParseStreamFixture(t *testing.T) {
	evs := readFixture(t)
	var items []StreamItem
	for _, e := range evs {
		var r Response
		if err := json.Unmarshal([]byte(e.Data), &r); err != nil {
			t.Fatalf("bad JSON-RPC in fixture: %v\n%s", err, e.Data)
		}
		it, err := ParseStreamResult(r.Result)
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		items = append(items, it)
	}
	if items[0].Kind != "task" || items[0].TaskID != "sub-ag-1" || items[0].State != "working" {
		t.Errorf("first item: %+v", items[0])
	}
	a := items[1]
	if a.Assignment == nil || a.Assignment.ID != 42 || a.Assignment.Title != "Add hello endpoint" || a.Reason != "new" ||
		a.Assignment.AssigneeAgent == nil || a.Assignment.AssigneeAgent.ID != "ag-1" || a.Assignment.Repos[0] != "group/demo" {
		t.Errorf("assignment: %+v", a)
	}
	if items[2].DataType != DataPing || items[2].Assignment != nil {
		t.Errorf("ping: %+v", items[2])
	}
	if items[3].DataType != DataRevoked || items[3].DataTaskID != 42 || items[3].Reason != "canceled" {
		t.Errorf("revoked: %+v", items[3])
	}
	if items[4].DataType != DataMessage || items[4].DataTaskID != 42 || items[4].From != "李四" || items[4].Text != "请顺便更新文档" {
		t.Errorf("message: %+v", items[4])
	}
	if items[5].DataType != DataTaskState || items[5].Task == nil || items[5].Task.State != "auth-required" || items[5].DataTaskID != 42 {
		t.Errorf("task_state: %+v", items[5])
	}
	w := items[6] // A2A 1.0 wrapper + nested data + enum-style state
	if w.Kind != "status-update" || w.State != "working" || w.Assignment == nil || w.Assignment.ID != 43 || w.Reason != "ci_failed" {
		t.Errorf("1.0-style assignment: %+v", w)
	}
	if !items[7].Final || items[7].State != "canceled" {
		t.Errorf("final: %+v", items[7])
	}
}

func TestParseStreamErrors(t *testing.T) {
	if _, err := ParseStreamResult(json.RawMessage(`null`)); err == nil {
		t.Error("null result should error")
	}
	bad := `{"kind":"status-update","taskId":"s","status":{"state":"working","message":{"role":"agent","parts":[{"kind":"data","data":{"type":"assignment","task":{"title":"no id"}}}]}}}`
	if _, err := ParseStreamResult(json.RawMessage(bad)); err == nil {
		t.Error("assignment without id should error")
	}
	if NormalizeState("TASK_STATE_INPUT_REQUIRED") != "input-required" || NormalizeState("cancelled") != "canceled" {
		t.Error("NormalizeState")
	}
}

type rpcRecorder struct {
	mu   sync.Mutex
	reqs []Request
	raw  []map[string]any
}

func TestClientReportProgressAndSubscribe(t *testing.T) {
	rec := &rpcRecorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/a2a" || r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			fmt.Fprint(w, `{"error":"unauthorized","message":"no"}`)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var req Request
		var raw map[string]any
		_ = json.Unmarshal(body, &req)
		_ = json.Unmarshal(body, &raw)
		rec.mu.Lock()
		rec.reqs = append(rec.reqs, req)
		rec.raw = append(rec.raw, raw)
		rec.mu.Unlock()
		switch req.Method {
		case MethodSendMessage:
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%q,"result":{"kind":"task","id":"42","contextId":"root-42","status":{"state":"working"}}}`, req.ID)
		case MethodSendStreamingMessage:
			w.Header().Set("Content-Type", "text/event-stream")
			fl := w.(http.Flusher)
			fmt.Fprintf(w, "data: {\"jsonrpc\":\"2.0\",\"id\":%q,\"result\":{\"kind\":\"task\",\"id\":\"sub-ag\",\"status\":{\"state\":\"working\"}}}\n\n", req.ID)
			fl.Flush()
			fmt.Fprintf(w, "data: {\"jsonrpc\":\"2.0\",\"id\":%q,\"result\":{\"kind\":\"status-update\",\"taskId\":\"sub-ag\",\"status\":{\"state\":\"working\",\"message\":{\"role\":\"agent\",\"parts\":[{\"kind\":\"data\",\"data\":{\"type\":\"assignment\",\"task\":{\"id\":7,\"title\":\"x\",\"state\":\"working\"}}}]}},\"final\":false}}\n\n", req.ID)
			fl.Flush()
			<-r.Context().Done() // then go silent: the client idle timeout must fire
		}
	}))
	defer srv.Close()
	c := New(api.New(srv.URL, nil, api.StaticToken("tok")))

	url := "https://gitlab.example.com/g/p/-/merge_requests/3"
	task, err := c.ReportProgress(context.Background(), Progress{
		TaskID: 42, AgentID: "ag", State: StateWorking, Kind: KindArtifact, Text: "pushed",
		Artifacts: []Artifact{{Name: "g/p MR", Repo: "g/p", Branch: "acp/42-x", URL: &url}, {Name: "g/q 分支", Repo: "g/q", Branch: "acp/42-x"}},
	})
	if err != nil || task.State() != "working" || task.ID != "42" {
		t.Fatalf("report: %v %+v", err, task)
	}
	rec.mu.Lock()
	msg := rec.raw[0]["params"].(map[string]any)["message"].(map[string]any)
	rec.mu.Unlock()
	meta := msg["metadata"].(map[string]any)
	if meta["skill"] != "report_progress" || meta["task_id"].(float64) != 42 || meta["kind"] != "artifact" || meta["state"] != "working" {
		t.Errorf("metadata: %v", meta)
	}
	arts := meta["artifacts"].([]any)
	if len(arts) != 2 || arts[1].(map[string]any)["url"] != nil {
		t.Errorf("artifacts (url must be null when unknown): %v", arts)
	}
	if parts := msg["parts"].([]any); parts[0].(map[string]any)["text"] != "pushed" {
		t.Errorf("parts: %v", parts)
	}

	var got []StreamItem
	opened := ""
	start := time.Now()
	err = c.Subscribe(context.Background(), SubscribeOptions{
		AgentID: "ag", IdleTimeout: 300 * time.Millisecond,
		OnOpen: func(id string) { opened = id },
		OnItem: func(it StreamItem) { got = append(got, it) },
	})
	if !errors.Is(err, ErrIdle) {
		t.Fatalf("want idle timeout, got %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("idle timeout took too long")
	}
	if opened != "sub-ag" || len(got) != 2 || got[1].Assignment == nil || got[1].Assignment.ID != 7 {
		t.Fatalf("stream items: opened=%q %+v", opened, got)
	}
	rec.mu.Lock()
	last := rec.raw[len(rec.raw)-1]
	rec.mu.Unlock()
	if last["method"] != "SendStreamingMessage" {
		t.Errorf("method %v", last["method"])
	}
	sm := last["params"].(map[string]any)["message"].(map[string]any)["metadata"].(map[string]any)
	if sm["skill"] != "subscribe_assignments" || sm["agent_id"] != "ag" {
		t.Errorf("subscribe metadata: %v", sm)
	}

	// Unauthorized surfaces as *api.Error.
	c2 := New(api.New(srv.URL, nil, api.StaticToken("bad")))
	if err := c2.Subscribe(context.Background(), SubscribeOptions{AgentID: "ag"}); !api.IsUnauthorized(err) {
		t.Fatalf("want unauthorized, got %v", err)
	}
}

func TestCallRPCError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"jsonrpc":"2.0","id":"1","error":{"code":-32602,"message":"invalid_state","data":{"state":"completed"}}}`)
	}))
	defer srv.Close()
	c := New(api.New(srv.URL, nil, api.StaticToken("tok")))
	_, err := c.RequestInput(context.Background(), 1, "ag", "which path?")
	var rpcErr *RPCError
	if !errors.As(err, &rpcErr) || rpcErr.Code != -32602 {
		t.Fatalf("want RPCError, got %v", err)
	}
}
