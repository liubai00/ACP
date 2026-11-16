// Package version holds build metadata injected via -ldflags and a small
// semantic-version comparator used for the server's min_link_version hint.
package version

import (
	"fmt"
	"runtime"
	"strconv"
	"strings"
)

// Injected at build time:
//
//	-X acp/acp-link/internal/version.Version=0.1.0
//	-X acp/acp-link/internal/version.Commit=abc123
//	-X acp/acp-link/internal/version.BuildDate=2026-11-09T08:00:00Z
var (
	Version   = "0.0.0-dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

// String returns a human readable one-line version description.
func String() string {
	return fmt.Sprintf("acp-link %s (commit %s, built %s, %s/%s, %s)",
		Version, Commit, BuildDate, runtime.GOOS, runtime.GOARCH, runtime.Version())
}

// UserAgent is sent with every HTTP request.
func UserAgent() string {
	return fmt.Sprintf("acp-link/%s (%s/%s)", Version, runtime.GOOS, runtime.GOARCH)
}

type semver struct {
	nums [3]int
	pre  string
}

func parse(v string) (semver, bool) {
	var s semver
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(strings.TrimPrefix(v, "v"), "V")
	if v == "" {
		return s, false
	}
	if i := strings.IndexByte(v, '+'); i >= 0 { // build metadata is ignored
		v = v[:i]
	}
	if i := strings.IndexByte(v, '-'); i >= 0 {
		s.pre = v[i+1:]
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) > 3 {
		return s, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return s, false
		}
		s.nums[i] = n
	}
	return s, true
}

// Compare compares two versions like "1.2.3", "v1.2", "1.2.3-rc.1".
// It returns -1, 0 or 1 and ok=false when either side cannot be parsed.
// A pre-release sorts before the corresponding release.
func Compare(a, b string) (int, bool) {
	va, ok1 := parse(a)
	vb, ok2 := parse(b)
	if !ok1 || !ok2 {
		return 0, false
	}
	for i := 0; i < 3; i++ {
		if va.nums[i] != vb.nums[i] {
			if va.nums[i] < vb.nums[i] {
				return -1, true
			}
			return 1, true
		}
	}
	switch {
	case va.pre == vb.pre:
		return 0, true
	case va.pre == "":
		return 1, true
	case vb.pre == "":
		return -1, true
	case va.pre < vb.pre:
		return -1, true
	default:
		return 1, true
	}
}

// Older reports whether current is strictly older than min. Unparseable
// versions (for example local dev builds) never count as older.
func Older(current, min string) bool {
	c, ok := Compare(current, min)
	return ok && c < 0
}
