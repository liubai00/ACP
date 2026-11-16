package version

import "testing"

func TestCompare(t *testing.T) {
	cases := []struct {
		a, b string
		want int
		ok   bool
	}{
		{"1.2.3", "1.2.3", 0, true},
		{"v1.2.3", "1.2.4", -1, true},
		{"1.10.0", "1.9.9", 1, true},
		{"1.2", "1.2.0", 0, true},
		{"0.1.0-dev", "0.1.0", -1, true},
		{"0.1.0", "0.1.0-rc.1", 1, true},
		{"1.0.0+build5", "1.0.0", 0, true},
		{"dev", "1.0.0", 0, false},
		{"", "1.0.0", 0, false},
	}
	for _, c := range cases {
		got, ok := Compare(c.a, c.b)
		if got != c.want || ok != c.ok {
			t.Errorf("Compare(%q,%q) = %d,%v want %d,%v", c.a, c.b, got, ok, c.want, c.ok)
		}
	}
	if !Older("0.1.0", "0.2.0") || Older("0.3.0", "0.2.0") || Older("garbage", "0.2.0") {
		t.Fatal("Older misbehaves")
	}
}
