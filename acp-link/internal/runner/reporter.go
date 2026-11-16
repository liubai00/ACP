package runner

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"acp/acp-link/internal/a2a"
)

const (
	maxLineRunes    = 1500
	maxMessageRunes = 3500
)

// reporter throttles progress/tool messages: at most one message per
// interval; everything that arrives in between is merged into one message.
type reporter struct {
	interval time.Duration
	send     func(ctx context.Context, kind, text string) error

	mu       sync.Mutex
	lines    []string
	allTool  bool
	lastSend time.Time
	sending  sync.Mutex // serialises sends (keeps the 1/interval guarantee)
	stop     chan struct{}
	done     chan struct{}
}

func newReporter(interval time.Duration, send func(ctx context.Context, kind, text string) error) *reporter {
	if interval <= 0 {
		interval = 2 * time.Second
	}
	return &reporter{interval: interval, send: send, allTool: true}
}

// Add queues one line. kind is a2a.KindProgress or a2a.KindTool.
func (r *reporter) Add(kind, text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	if utf8.RuneCountInString(text) > maxLineRunes {
		text = string([]rune(text)[:maxLineRunes]) + "…"
	}
	if kind == a2a.KindTool {
		text = "[工具] " + text
	}
	r.mu.Lock()
	if kind != a2a.KindTool {
		r.allTool = false
	}
	r.lines = append(r.lines, text)
	r.mu.Unlock()
}

// Start runs the periodic flusher until Stop.
func (r *reporter) Start(ctx context.Context) {
	r.stop, r.done = make(chan struct{}), make(chan struct{})
	go func() {
		defer close(r.done)
		t := time.NewTicker(r.interval)
		defer t.Stop()
		for {
			select {
			case <-r.stop:
				return
			case <-t.C:
				r.Flush(ctx)
			}
		}
	}()
}

// Stop stops the flusher and sends anything still pending.
func (r *reporter) Stop(ctx context.Context) {
	if r.stop != nil {
		close(r.stop)
		<-r.done
		r.stop = nil
	}
	r.Flush(ctx)
}

// Flush sends pending lines as one message, waiting if the last message was
// sent less than interval ago.
func (r *reporter) Flush(ctx context.Context) {
	r.sending.Lock()
	defer r.sending.Unlock()
	r.mu.Lock()
	if len(r.lines) == 0 {
		r.mu.Unlock()
		return
	}
	wait := r.interval - time.Since(r.lastSend)
	r.mu.Unlock()
	if wait > 0 {
		select {
		case <-time.After(wait):
		case <-ctx.Done():
		}
	}
	r.mu.Lock()
	lines, allTool := r.lines, r.allTool
	r.lines, r.allTool = nil, true
	r.lastSend = time.Now()
	r.mu.Unlock()
	if len(lines) == 0 {
		return
	}
	kind := a2a.KindProgress
	if allTool {
		kind = a2a.KindTool
	}
	_ = r.send(ctx, kind, mergeLines(lines))
}

// mergeLines joins lines, keeping the message under maxMessageRunes.
func mergeLines(lines []string) string {
	var b strings.Builder
	n := 0
	for i, l := range lines {
		lr := utf8.RuneCountInString(l)
		if n > 0 && n+lr+1 > maxMessageRunes {
			fmt.Fprintf(&b, "\n…（另有 %d 条已省略）", len(lines)-i)
			break
		}
		if n > 0 {
			b.WriteByte('\n')
			n++
		}
		b.WriteString(l)
		n += lr
	}
	return b.String()
}
