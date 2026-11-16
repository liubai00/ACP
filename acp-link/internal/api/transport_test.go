package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBypassProxy(t *testing.T) {
	np := "corp.local, .internal.example.com,10.0.0.0/8, 192.168.1.5, gitlab.example.com:8443"
	cases := map[string]bool{
		"localhost:8080":             true,
		"127.0.0.1:80":               true,
		"[::1]:443":                  true,
		"corp.local":                 true,
		"a.corp.local:443":           true,
		"x.internal.example.com":     true,
		"internal.example.com":       true,
		"10.2.3.4:443":               true,
		"192.168.1.5":                true,
		"192.168.1.6":                false,
		"gitlab.example.com:8443":    true,
		"gitlab.example.com:443":     false,
		"acp.example.com:443":        false,
		"notcorp.local.evil.com:443": false,
	}
	for host, want := range cases {
		if got := BypassProxy(host, np); got != want {
			t.Errorf("BypassProxy(%q) = %v want %v", host, got, want)
		}
	}
	if !BypassProxy("anything:1", "*") {
		t.Error("* should bypass everything")
	}
}

func TestExplicitProxy(t *testing.T) {
	t.Setenv("NO_PROXY", "skip.example.com")
	got, err := EffectiveProxy("http://user:pw@10.1.1.1:3128", "https://acp.example.com/healthz")
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://user:%2A%2A%2A@10.1.1.1:3128" && got != "http://user:***@10.1.1.1:3128" {
		t.Errorf("proxy not used or not redacted: %q", got)
	}
	got, _ = EffectiveProxy("http://10.1.1.1:3128", "https://skip.example.com/")
	if got != "" {
		t.Errorf("NO_PROXY ignored: %q", got)
	}
}

func TestErrorDecoding(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":"unauthorized","message":"登录已过期"}`))
			return
		}
		_, _ = w.Write([]byte(`{"member":{"id":"m1","name":"张三","roles":["member"]}}`))
	}))
	defer srv.Close()
	c := New(srv.URL, nil, StaticToken("bad"))
	_, err := c.Me(context.Background())
	if !IsUnauthorized(err) {
		t.Fatalf("want unauthorized, got %v", err)
	}
	c.Tokens = StaticToken("tok")
	m, err := c.Me(context.Background())
	if err != nil || m.Name != "张三" {
		t.Fatalf("me: %v %+v", err, m)
	}
}
