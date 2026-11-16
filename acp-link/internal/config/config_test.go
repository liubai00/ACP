package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSampleParses(t *testing.T) {
	cfg, err := Parse([]byte(Sample("http://1.2.3.4", "box")))
	if err != nil {
		t.Fatalf("sample does not parse: %v", err)
	}
	cfg.Home = t.TempDir()
	cfg.ApplyDefaults()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("sample does not validate: %v", err)
	}
	if cfg.Server != "http://1.2.3.4" || cfg.AgentName != "box" || cfg.Adapter != AdapterClaude {
		t.Fatalf("unexpected sample values: %+v", cfg)
	}
	if cfg.TaskTimeout.Duration != 60*time.Minute || cfg.MaxConcurrency != 1 {
		t.Fatalf("defaults: timeout=%v conc=%d", cfg.TaskTimeout, cfg.MaxConcurrency)
	}
	if !cfg.Git.PushMREnabled() || cfg.Git.Remote != "origin" || cfg.Git.TargetBranch != "main" {
		t.Fatalf("git defaults: %+v", cfg.Git)
	}
}

func TestLoadFull(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	yml := `
server: https://acp.example.com/
agent_name: laptop-1
adapter: codex
skills: [backend, harmonyos]
repos:
  - name: /group/api/
    path: ~/code/api
    target_branch: develop
    checks: ["go test ./..."]
  - name: group/web
    path: ` + filepath.ToSlash(dir) + `/web
workspace_dir: ~/ws
max_concurrency: 5
task_timeout: 90
auto_accept_help: true
proxy: http://127.0.0.1:7890
claude:
  command: /usr/local/bin/claude
  extra_args: ["--allowedTools", "Bash(npm test:*)"]
codex:
  extra_args: []
atlas:
  enabled: true
  locate_cmd: atlas locate --task {task_id}
checks:
  group/web: ["npm test"]
  group/api: ["make lint"]
git:
  push_mr: false
`
	if err := os.WriteFile(path, []byte(yml), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server != "https://acp.example.com" {
		t.Errorf("server trailing slash not trimmed: %q", cfg.Server)
	}
	if cfg.Home != dir {
		t.Errorf("home = %q want %q", cfg.Home, dir)
	}
	if cfg.MaxConcurrency != 3 || len(cfg.Warnings) == 0 {
		t.Errorf("max_concurrency should clamp to 3 with a warning: %d %v", cfg.MaxConcurrency, cfg.Warnings)
	}
	if cfg.TaskTimeout.Duration != 90*time.Minute {
		t.Errorf("integer timeout should be minutes: %v", cfg.TaskTimeout)
	}
	if cfg.Git.PushMREnabled() {
		t.Error("push_mr false not honoured")
	}
	if len(cfg.Codex.ExtraArgs) != 0 {
		t.Errorf("explicit empty codex extra_args must not get defaults: %v", cfg.Codex.ExtraArgs)
	}
	if cfg.Codex.Command != "codex" || cfg.Claude.Command != "/usr/local/bin/claude" {
		t.Errorf("commands: %q %q", cfg.Codex.Command, cfg.Claude.Command)
	}
	r, ok := cfg.FindRepo("GROUP/API")
	if !ok || r.Name != "group/api" {
		t.Fatalf("FindRepo case-insensitive failed: %+v %v", r, ok)
	}
	if !strings.HasPrefix(r.Path, HomeDir()) {
		t.Errorf("~ not expanded: %q", r.Path)
	}
	if got := cfg.ChecksFor("group/api"); len(got) != 2 || got[0] != "go test ./..." || got[1] != "make lint" {
		t.Errorf("ChecksFor merge: %v", got)
	}
	if cfg.TargetBranchFor("group/api") != "develop" || cfg.TargetBranchFor("group/web") != "main" {
		t.Error("TargetBranchFor")
	}
	if !strings.HasPrefix(cfg.WorkspaceDir, HomeDir()) {
		t.Errorf("workspace_dir not expanded: %q", cfg.WorkspaceDir)
	}
}

func TestDefaultsWhenMinimal(t *testing.T) {
	cfg, err := Parse([]byte("server: http://10.0.0.1\n"))
	if err != nil {
		t.Fatal(err)
	}
	cfg.Home = "/tmp/acp-home"
	cfg.ApplyDefaults()
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Codex.ExtraArgs) != 1 || cfg.Codex.ExtraArgs[0] != "--full-auto" {
		t.Errorf("codex default extra args: %v", cfg.Codex.ExtraArgs)
	}
	if cfg.WorkspaceDir != filepath.Clean("/tmp/acp-home/workspaces") {
		t.Errorf("workspace default: %q", cfg.WorkspaceDir)
	}
	if cfg.AgentName == "" {
		t.Error("agent_name should default to hostname")
	}
}

func TestValidateErrors(t *testing.T) {
	cases := map[string]string{
		"missing server":  "adapter: echo\n",
		"bad scheme":      "server: ftp://x\n",
		"bad adapter":     "server: http://x\nadapter: gpt\n",
		"repo w/o path":   "server: http://x\nrepos:\n  - name: a/b\n",
		"duplicate repos": "server: http://x\nrepos:\n  - {name: a/b, path: /x}\n  - {name: A/B, path: /y}\n",
	}
	for name, y := range cases {
		cfg, err := Parse([]byte(y))
		if err != nil {
			t.Fatalf("%s: parse: %v", name, err)
		}
		cfg.ApplyDefaults()
		if err := cfg.Validate(); err == nil {
			t.Errorf("%s: expected validation error", name)
		}
	}
}

func TestUnknownKeyRejected(t *testing.T) {
	if _, err := Parse([]byte("server: http://x\nservr: typo\n")); err == nil {
		t.Fatal("unknown key should be rejected")
	}
	if _, err := Parse([]byte("server: http://x\ntask_timeout: forever\n")); err == nil {
		t.Fatal("bad duration should be rejected")
	}
}

func TestLoadMissing(t *testing.T) {
	_, err := Load(filepath.Join(t.TempDir(), "nope.yaml"))
	if err == nil || !strings.Contains(err.Error(), "acp-link init") {
		t.Fatalf("expected not-found with hint, got %v", err)
	}
}
