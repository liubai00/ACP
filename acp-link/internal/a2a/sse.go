// Package a2a implements the A2A JSON-RPC client used by acp-link
// (contracts/API.md §4): subscribe_assignments over SSE, report_progress,
// request_input and create_task.
package a2a

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"strings"
)

// SSEEvent is one dispatched server-sent event.
type SSEEvent struct {
	Event string // "" means the default "message" event
	Data  string
	ID    string
}

// maxSSELine bounds a single line to protect memory.
const maxSSELine = 8 << 20

// ReadSSE parses an event stream and calls fn for each dispatched event.
// Comment lines (": ping") are reported to onComment when non-nil. It returns
// nil on clean EOF, or the first error from fn / the reader.
func ReadSSE(r io.Reader, fn func(SSEEvent) error, onComment func(string)) error {
	lr := &lineReader{br: bufio.NewReaderSize(r, 64<<10)}
	var (
		ev      SSEEvent
		data    strings.Builder
		hasData bool
	)
	dispatch := func() error {
		if !hasData {
			ev = SSEEvent{}
			return nil
		}
		ev.Data = strings.TrimSuffix(data.String(), "\n")
		out := ev
		ev = SSEEvent{}
		data.Reset()
		hasData = false
		return fn(out)
	}
	first := true
	for {
		line, err := lr.readLine()
		if err != nil {
			if errors.Is(err, io.EOF) {
				// An unterminated trailing event is discarded per the SSE spec.
				return nil
			}
			return err
		}
		if first {
			line = strings.TrimPrefix(line, string(rune(0xFEFF)))
			first = false
		}
		if line == "" {
			if err := dispatch(); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			if onComment != nil {
				onComment(strings.TrimSpace(line[1:]))
			}
			continue
		}
		field, value := line, ""
		if i := strings.IndexByte(line, ':'); i >= 0 {
			field, value = line[:i], line[i+1:]
			value = strings.TrimPrefix(value, " ")
		}
		switch field {
		case "event":
			ev.Event = value
		case "data":
			data.WriteString(value)
			data.WriteByte('\n')
			hasData = true
		case "id":
			if !strings.ContainsRune(value, 0) {
				ev.ID = value
			}
		case "retry":
			// reconnection is handled by the caller's backoff
		}
	}
}

// lineReader reads lines terminated by LF, CRLF or CR without blocking on a
// lone CR (it remembers to drop a directly following LF instead).
type lineReader struct {
	br     *bufio.Reader
	skipLF bool
}

func (l *lineReader) readLine() (string, error) {
	var buf bytes.Buffer
	for {
		b, err := l.br.ReadByte()
		if err != nil {
			if errors.Is(err, io.EOF) && buf.Len() > 0 {
				return "", io.EOF // partial line at EOF: discard
			}
			return "", err
		}
		if l.skipLF {
			l.skipLF = false
			if b == '\n' {
				continue
			}
		}
		switch b {
		case '\n':
			return buf.String(), nil
		case '\r':
			l.skipLF = true
			return buf.String(), nil
		default:
			if buf.Len() >= maxSSELine {
				return "", errors.New("sse line too long")
			}
			buf.WriteByte(b)
		}
	}
}
