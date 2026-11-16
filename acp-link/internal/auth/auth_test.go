package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"acp/acp-link/internal/api"
)

// FakeJWT builds an unsigned JWT-shaped token for tests.
func FakeJWT(sub string, exp time.Time) string {
	h := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	p, _ := json.Marshal(map[string]any{"sub": sub, "name": "测试", "act": "member", "exp": exp.Unix(), "iat": time.Now().Unix()})
	return h + "." + base64.RawURLEncoding.EncodeToString(p) + ".sig"
}

func TestParseClaims(t *testing.T) {
	exp := time.Now().Add(time.Hour).Truncate(time.Second)
	c, err := ParseClaims(FakeJWT("m1", exp))
	if err != nil {
		t.Fatal(err)
	}
	if c.Sub != "m1" || !c.Expiry().Equal(exp) || c.Act != "member" {
		t.Fatalf("claims: %+v", c)
	}
	if _, err := ParseClaims("not-a-jwt"); err == nil {
		t.Fatal("expected error")
	}
}

func TestDeviceLoginAndSave(t *testing.T) {
	var polls atomic.Int32
	exp := time.Now().Add(7 * 24 * time.Hour)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/auth/device/code":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["client"] != "acp-link" || body["hostname"] != "box" {
				w.WriteHeader(400)
				return
			}
			fmt.Fprint(w, `{"device_code":"dc1","user_code":"ABCD-EFGH","verification_uri":"http://x/device","verification_uri_complete":"http://x/device?code=ABCD-EFGH","expires_in":600,"interval":0}`)
		case "/auth/device/token":
			n := polls.Add(1)
			if n == 1 {
				w.WriteHeader(400)
				fmt.Fprint(w, `{"error":"authorization_pending"}`)
				return
			}
			if n == 2 {
				w.WriteHeader(400)
				fmt.Fprint(w, `{"error":"slow_down"}`)
				return
			}
			fmt.Fprintf(w, `{"access_token":%q,"token_type":"Bearer","expires_in":604800,"member":{"id":"m1","name":"张三","avatar_url":null}}`, FakeJWT("m1", exp))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	c := api.New(srv.URL, nil, nil)
	var opened string
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	creds, err := DeviceLogin(ctx, c, DeviceLoginOptions{
		Hostname:    "box",
		OpenBrowser: func(u string) error { opened = u; return nil },
		MinInterval: 10 * time.Millisecond, SlowDownStep: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	if opened != "http://x/device?code=ABCD-EFGH" {
		t.Errorf("browser opened %q", opened)
	}
	if creds.MemberName != "张三" || creds.Server != srv.URL || creds.ExpiresAt.Unix() != exp.Unix() {
		t.Fatalf("creds: %+v", creds)
	}
	path := filepath.Join(t.TempDir(), "sub", "credentials.json")
	if err := creds.Save(path); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && st.Mode().Perm() != 0o600 {
		t.Errorf("credentials perm = %v, want 0600", st.Mode().Perm())
	}
	back, err := LoadCredentials(path)
	if err != nil || back.AccessToken != creds.AccessToken {
		t.Fatalf("reload: %v", err)
	}
}

func TestDeviceLoginExpired(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/auth/device/code" {
			fmt.Fprint(w, `{"device_code":"dc1","user_code":"X","verification_uri":"http://x/device","expires_in":600,"interval":0}`)
			return
		}
		w.WriteHeader(400)
		fmt.Fprint(w, `{"error":"expired_token"}`)
	}))
	defer srv.Close()
	_, err := DeviceLogin(context.Background(), api.New(srv.URL, nil, nil), DeviceLoginOptions{MinInterval: time.Millisecond})
	if err == nil {
		t.Fatal("expected expiry error")
	}
}

func TestManagerRefresh(t *testing.T) {
	soon := FakeJWT("m1", time.Now().Add(2*time.Hour))
	later := FakeJWT("m1", time.Now().Add(7*24*time.Hour))
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/refresh" || r.Header.Get("Authorization") != "Bearer "+soon {
			w.WriteHeader(401)
			return
		}
		calls.Add(1)
		fmt.Fprintf(w, `{"token":%q}`, later)
	}))
	defer srv.Close()
	path := filepath.Join(t.TempDir(), "credentials.json")
	c := &Credentials{Server: srv.URL, AccessToken: soon, ExpiresAt: ExpiryOf(soon, time.Time{})}
	if err := c.Save(path); err != nil {
		t.Fatal(err)
	}
	m, err := NewManager(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	m.Bind(api.New(srv.URL, nil, m))
	did, err := m.RefreshIfNeeded(context.Background(), RefreshThreshold)
	if err != nil || !did {
		t.Fatalf("refresh: did=%v err=%v", did, err)
	}
	if m.Token() != later || calls.Load() != 1 {
		t.Fatal("token not swapped")
	}
	// Persisted.
	back, _ := LoadCredentials(path)
	if back.AccessToken != later {
		t.Fatal("refreshed token not saved")
	}
	// Not needed any more.
	did, err = m.RefreshIfNeeded(context.Background(), RefreshThreshold)
	if err != nil || did {
		t.Fatalf("second refresh should be skipped: %v %v", did, err)
	}
	if err := m.CheckServer("http://other"); err == nil {
		t.Fatal("server mismatch not detected")
	}
}
