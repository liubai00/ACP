package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"acp/acp-link/internal/auth"
)

func TestRotatingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "logs", "acp-link.log")
	r, err := newRotatingFile(path, 100, 2)
	if err != nil {
		t.Fatal(err)
	}
	line := strings.Repeat("x", 39) + "\n" // 40 bytes
	for i := 0; i < 10; i++ {
		if _, err := r.Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	r.Close()
	for _, p := range []string{path, path + ".1", path + ".2"} {
		st, err := os.Stat(p)
		if err != nil {
			t.Fatalf("%s missing: %v", p, err)
		}
		if st.Size() > 100 {
			t.Errorf("%s is %d bytes, over the limit", p, st.Size())
		}
	}
	if _, err := os.Stat(path + ".3"); !os.IsNotExist(err) {
		t.Error("only 2 backups should be kept")
	}
}

func runCLI(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := run(args, &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestInitVersionAndMCPConfig(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")

	if code, out, _ := runCLI(t, "version"); code != 0 || !strings.Contains(out, "acp-link") {
		t.Fatalf("version: %d %q", code, out)
	}
	if code, _, errOut := runCLI(t, "nonsense"); code != 2 || !strings.Contains(errOut, "未知命令") {
		t.Fatalf("unknown command: %d %q", code, errOut)
	}
	code, out, errOut := runCLI(t, "init", "-config", cfgPath, "-server", "http://10.1.2.3/", "-agent-name", "box")
	if code != 0 || !strings.Contains(out, "acp-link login") {
		t.Fatalf("init: %d %q %q", code, out, errOut)
	}
	data, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(data), "server: http://10.1.2.3\n") || !strings.Contains(string(data), "agent_name: box") {
		t.Fatalf("sample content:\n%s", data)
	}
	if code, _, _ := runCLI(t, "init", "-config", cfgPath); code == 0 {
		t.Fatal("init must not overwrite without -force")
	}

	// mcp-config without login fails with a hint; with -placeholder it works.
	if code, _, errOut := runCLI(t, "mcp-config", "claude", "-config", cfgPath); code == 0 || !strings.Contains(errOut, "login") {
		t.Fatalf("mcp-config before login: %d %q", code, errOut)
	}
	code, out, _ = runCLI(t, "mcp-config", "codex", "-config", cfgPath, "-placeholder")
	if code != 0 || !strings.Contains(out, `url = "http://10.1.2.3/mcp"`) || !strings.Contains(out, "bearer_token_env_var") {
		t.Fatalf("codex snippet: %d %q", code, out)
	}

	// A fake platform for the personal-access-token endpoint and /api/agents.
	h := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256"}`))
	p, _ := json.Marshal(map[string]any{"sub": "m1", "exp": time.Now().Add(48 * time.Hour).Unix()})
	tok := h + "." + base64.RawURLEncoding.EncodeToString(p) + ".s"
	var patReq map[string]any
	patOK := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+tok {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/api/me/tokens":
			if !patOK {
				w.WriteHeader(404)
				fmt.Fprint(w, `{"error":"not_found","message":"no such endpoint"}`)
				return
			}
			_ = json.NewDecoder(r.Body).Decode(&patReq)
			fmt.Fprint(w, `{"id":7,"token":"pat-90d","expires_at":"2027-02-07T08:00:00Z","mcp_url":"/mcp"}`)
		case "/api/agents":
			fmt.Fprint(w, `{"items":[]}`)
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	if code, _, errOut := runCLI(t, "init", "-force", "-config", cfgPath, "-server", srv.URL, "-agent-name", "box"); code != 0 {
		t.Fatalf("re-init: %q", errOut)
	}
	creds := &auth.Credentials{Server: srv.URL, AccessToken: tok, ExpiresAt: time.Now().Add(48 * time.Hour), MemberName: "张三"}
	if err := creds.Save(filepath.Join(dir, "credentials.json")); err != nil {
		t.Fatal(err)
	}

	code, out, errOut = runCLI(t, "mcp-config", "-config", cfgPath)
	if code != 0 {
		t.Fatalf("claude snippet: %d %q", code, errOut)
	}
	if want := "claude mcp add --transport http acp " + srv.URL + "/mcp --header \"Authorization: Bearer pat-90d\""; !strings.Contains(out, want) {
		t.Fatalf("claude one-liner missing %q in:\n%s", want, out)
	}
	if strings.Contains(out, tok) {
		t.Fatal("the 7-day member token must not be printed when a personal token was issued")
	}
	if name, _ := patReq["name"].(string); !strings.HasPrefix(name, "acp-link mcp-config ") || patReq["days"].(float64) != 90 {
		t.Errorf("PAT request: %v", patReq)
	}
	var js struct {
		MCPServers map[string]struct {
			Type, URL string
			Headers   map[string]string
		} `json:"mcpServers"`
	}
	start := strings.Index(out, "{")
	if err := json.Unmarshal([]byte(out[start:]), &js); err != nil || js.MCPServers["acp"].URL != srv.URL+"/mcp" ||
		js.MCPServers["acp"].Headers["Authorization"] != "Bearer pat-90d" {
		t.Fatalf("embedded .mcp.json invalid: %v\n%s", err, out[start:])
	}
	if !strings.Contains(errOut, "id 7") || !strings.Contains(errOut, "DELETE /api/me/tokens/7") {
		t.Errorf("expected token id / revoke hint on stderr: %q", errOut)
	}

	code, out, _ = runCLI(t, "mcp-config", "codex", "-config", cfgPath)
	if code != 0 || !strings.Contains(out, "[mcp_servers.acp]") || !strings.Contains(out, "export ACP_TOKEN=pat-90d") {
		t.Fatalf("codex snippet: %q", out)
	}

	// Endpoint unavailable: fall back to the member token with a warning.
	patOK = false
	code, out, errOut = runCLI(t, "mcp-config", "claude", "-config", cfgPath)
	if code != 0 || !strings.Contains(out, "Bearer "+tok) || !strings.Contains(errOut, "警告") {
		t.Fatalf("fallback: %d\n%s\n%s", code, out, errOut)
	}

	// status reports login + daemon state.
	code, out, _ = runCLI(t, "status", "-config", cfgPath)
	if code != 0 || !strings.Contains(out, "张三") || !strings.Contains(out, "守护进程") {
		t.Fatalf("status: %d %q", code, out)
	}
}

func TestDoctorFailsWithoutConfig(t *testing.T) {
	code, out, _ := runCLI(t, "doctor", "-config", filepath.Join(t.TempDir(), "missing.yaml"))
	if code != 1 || !strings.Contains(out, "[FAIL]") {
		t.Fatalf("doctor: %d %q", code, out)
	}
}
