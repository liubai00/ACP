package runner

import (
	"math/rand"
	"sync"
	"time"
)

// Backoff is exponential backoff with jitter: base*2^n capped at max, then
// scaled by a random factor in [0.8, 1.2] (and capped at max again).
type Backoff struct {
	Base time.Duration
	Max  time.Duration
	// Rand returns a value in [0,1); nil uses math/rand.
	Rand func() float64

	mu      sync.Mutex
	attempt int
}

// NewBackoff returns a backoff with the given bounds (defaults 1s / 60s).
func NewBackoff(base, max time.Duration) *Backoff {
	if base <= 0 {
		base = time.Second
	}
	if max <= 0 {
		max = 60 * time.Second
	}
	return &Backoff{Base: base, Max: max}
}

// Next returns the next delay and advances the attempt counter.
func (b *Backoff) Next() time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	d := b.Base
	for i := 0; i < b.attempt && d < b.Max; i++ {
		d *= 2
	}
	if d > b.Max {
		d = b.Max
	}
	b.attempt++
	r := rand.Float64
	if b.Rand != nil {
		r = b.Rand
	}
	j := time.Duration(float64(d) * (0.8 + 0.4*r()))
	if j > b.Max {
		j = b.Max
	}
	if j <= 0 {
		j = time.Millisecond
	}
	return j
}

// Reset starts over from Base.
func (b *Backoff) Reset() {
	b.mu.Lock()
	b.attempt = 0
	b.mu.Unlock()
}

// Attempt returns how many delays have been handed out since the last Reset.
func (b *Backoff) Attempt() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.attempt
}
