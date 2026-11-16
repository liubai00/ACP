package runner

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"acp/acp-link/internal/a2a"
)

func TestBackoff(t *testing.T) {
	b := NewBackoff(time.Second, 60*time.Second)
	b.Rand = func() float64 { return 0.5 } // factor 1.0
	want := []time.Duration{1, 2, 4, 8, 16, 32, 60, 60, 60}
	for i, w := range want {
		if got := b.Next(); got != w*time.Second {
			t.Fatalf("attempt %d: got %v want %v", i, got, w*time.Second)
		}
	}
	b.Reset()
	if got := b.Next(); got != time.Second {
		t.Fatalf("after reset: %v", got)
	}
	// Jitter stays within [0.8, 1.2] of the step and never exceeds Max.
	for _, r := range []float64{0, 0.999} {
		jb := NewBackoff(time.Second, 60*time.Second)
		jb.Rand = func() float64 { return r }
		for i := 0; i < 12; i++ {
			d := jb.Next()
			if d > 60*time.Second || d < 800*time.Millisecond {
				t.Fatalf("jittered delay out of range: %v", d)
			}
		}
	}
	if NewBackoff(0, 0).Max != 60*time.Second {
		t.Fatal("default max")
	}
}

type sent struct {
	at   time.Time
	kind string
	text string
}

func TestReporterThrottleAndMerge(t *testing.T) {
	var mu sync.Mutex
	var msgs []sent
	r := newReporter(200*time.Millisecond, func(ctx context.Context, kind, text string) error {
		mu.Lock()
		msgs = append(msgs, sent{time.Now(), kind, text})
		mu.Unlock()
		return nil
	})
	r.Start(context.Background())
	for i := 0; i < 20; i++ {
		r.Add(a2a.KindTool, "Read: file")
	}
	time.Sleep(300 * time.Millisecond)
	r.Add(a2a.KindProgress, "thinking")
	r.Add(a2a.KindTool, "Edit: x")
	time.Sleep(50 * time.Millisecond)
	r.Add(a2a.KindProgress, "")
	r.Stop(context.Background())

	mu.Lock()
	defer mu.Unlock()
	if len(msgs) != 2 {
		t.Fatalf("want 2 merged messages, got %d: %+v", len(msgs), msgs)
	}
	if msgs[0].kind != a2a.KindTool || strings.Count(msgs[0].text, "[工具] Read: file") != 20 {
		t.Errorf("first message: %+v", msgs[0])
	}
	if msgs[1].kind != a2a.KindProgress || msgs[1].text != "thinking\n[工具] Edit: x" {
		t.Errorf("second message: %+v", msgs[1])
	}
	if gap := msgs[1].at.Sub(msgs[0].at); gap < 190*time.Millisecond {
		t.Errorf("messages %v apart, want >= interval", gap)
	}
}

func TestMergeLinesLimit(t *testing.T) {
	var lines []string
	for i := 0; i < 100; i++ {
		lines = append(lines, strings.Repeat("字", 100))
	}
	out := mergeLines(lines)
	if n := len([]rune(out)); n > maxMessageRunes+50 {
		t.Fatalf("merged message too long: %d runes", n)
	}
	if !strings.Contains(out, "已省略") {
		t.Fatal("expected omission note")
	}
}

func TestReasonText(t *testing.T) {
	for _, r := range []string{"new", "input_answered", "approval_rejected", "ci_failed", "approved_continue", "future"} {
		if reasonText(r) == "" {
			t.Errorf("empty text for %q", r)
		}
	}
}
