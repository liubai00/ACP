// Package config loads and validates ~/.acp-link/config.yaml.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Supported adapter names.
const (
	AdapterClaude = "claude-code"
	AdapterCodex  = "codex"
	AdapterEcho   = "echo"
)

// Defaults.
const (
	DefaultMaxConcurrency = 1
	MaxConcurrencyLimit   = 3
	DefaultTaskTimeout    = 60 * time.Minute
	DefaultRemote         = "origin"
	DefaultTargetBranch   = "main"
)

// ErrNotFound is returned by Load when the config file does not exist.
var ErrNotFound = errors.New("config file not found")

// Config is the on-disk configuration. Paths are expanded (~) by ApplyDefaults.
type Config struct {
	Server         string              `yaml:"server"`
	AgentName      string              `yaml:"agent_name"`
	Adapter        string              `yaml:"adapter"`
	Skills         []string            `yaml:"skills"`
	Repos          []Repo              `yaml:"repos"`
	RepoRoots      []string            `yaml:"repo_roots"`
	WorkspaceDir   string              `yaml:"workspace_dir"`
	MaxConcurrency int                 `yaml:"max_concurrency"`
	TaskTimeout    Duration            `yaml:"task_timeout"`
	AutoAcceptHelp bool                `yaml:"auto_accept_help"`
	Proxy          string              `yaml:"proxy"`
	CAFile         string              `yaml:"ca_file"`
	Claude         AgentCLI            `yaml:"claude"`
	Codex          CodexCLI            `yaml:"codex"`
	Atlas          Atlas               `yaml:"atlas"`
	Checks         map[string][]string `yaml:"checks"`
	Git            Git                 `yaml:"git"`
	Log            Log                 `yaml:"log"`

	// Path is the file the config was loaded from; Home is its directory
	// (credentials, state and logs live next to the config file).
	Path string `yaml:"-"`
	Home string `yaml:"-"`
	// Warnings collects non-fatal problems found while applying defaults.
	Warnings []string `yaml:"-"`
}

// Repo maps a GitLab project path to a local clone.
type Repo struct {
	Name         string   `yaml:"name"`
	Path         string   `yaml:"path"`
	TargetBranch string   `yaml:"target_branch,omitempty"`
	Checks       []string `yaml:"checks,omitempty"`
}

// AgentCLI configures a coding agent command line.
type AgentCLI struct {
	Command   string   `yaml:"command"`
	ExtraArgs []string `yaml:"extra_args"`
}

// CodexCLI adds the optional MCP "-c" overrides for Codex.
type CodexCLI struct {
	Command      string   `yaml:"command"`
	ExtraArgs    []string `yaml:"extra_args"`
	MCPOverrides []string `yaml:"mcp_overrides"`
}

// Atlas holds command templates for the team's multi-repo tool.
// Placeholders: {task_id} {branch} {repo} {workspace}.
type Atlas struct {
	Enabled    bool   `yaml:"enabled"`
	LocateCmd  string `yaml:"locate_cmd"`
	PrepareCmd string `yaml:"prepare_cmd"`
	CheckCmd   string `yaml:"check_cmd"`
}

// Git controls commit/push behaviour.
type Git struct {
	Remote       string `yaml:"remote"`
	TargetBranch string `yaml:"target_branch"`
	PushMR       *bool  `yaml:"push_mr"`
}

// Log controls the log file.
type Log struct {
	Level      string `yaml:"level"`
	MaxSizeMB  int    `yaml:"max_size_mb"`
	MaxBackups int    `yaml:"max_backups"`
}

// PushMREnabled returns git.push_mr with its default (true).
func (g Git) PushMREnabled() bool { return g.PushMR == nil || *g.PushMR }

// Duration accepts "60m", "1h30m" or a bare integer number of minutes.
type Duration struct{ time.Duration }

// UnmarshalYAML implements yaml.Unmarshaler.
func (d *Duration) UnmarshalYAML(n *yaml.Node) error {
	s := strings.TrimSpace(n.Value)
	if s == "" {
		d.Duration = 0
		return nil
	}
	if m, err := strconv.Atoi(s); err == nil {
		d.Duration = time.Duration(m) * time.Minute
		return nil
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("line %d: invalid duration %q (use e.g. 60m or 1h30m)", n.Line, s)
	}
	d.Duration = v
	return nil
}

// MarshalYAML implements yaml.Marshaler.
func (d Duration) MarshalYAML() (interface{}, error) { return d.String(), nil }

// HomeDir returns the user's home directory (USERPROFILE on Windows).
func HomeDir() string {
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return h
	}
	return "."
}

// DefaultHome is ~/.acp-link (Windows: %USERPROFILE%\.acp-link).
func DefaultHome() string { return filepath.Join(HomeDir(), ".acp-link") }

// DefaultPath returns $ACP_LINK_CONFIG or ~/.acp-link/config.yaml.
func DefaultPath() string {
	if p := os.Getenv("ACP_LINK_CONFIG"); p != "" {
		return ExpandPath(p)
	}
	return filepath.Join(DefaultHome(), "config.yaml")
}

// ExpandPath expands a leading ~ and environment variables, and cleans the path.
func ExpandPath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if p == "~" {
		p = HomeDir()
	} else if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, "~\\") {
		p = filepath.Join(HomeDir(), p[2:])
	}
	p = os.ExpandEnv(p)
	return filepath.Clean(p)
}

// Load reads, parses and validates the config at path ("" = DefaultPath).
func Load(path string) (*Config, error) {
	if path == "" {
		path = DefaultPath()
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("%w: %s（先运行 acp-link init 生成示例配置）", ErrNotFound, path)
		}
		return nil, err
	}
	cfg, err := Parse(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	abs, _ := filepath.Abs(path)
	cfg.Path = abs
	cfg.Home = filepath.Dir(abs)
	cfg.ApplyDefaults()
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return cfg, nil
}

// Parse decodes YAML without applying defaults. Unknown keys are rejected so
// typos surface early.
func Parse(data []byte) (*Config, error) {
	var cfg Config
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&cfg); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return &cfg, nil
}

// ApplyDefaults fills defaults and expands paths. Safe to call twice.
func (c *Config) ApplyDefaults() {
	if c.Home == "" {
		c.Home = DefaultHome()
	}
	c.Server = strings.TrimRight(strings.TrimSpace(c.Server), "/")
	if c.AgentName == "" {
		h, _ := os.Hostname()
		if h == "" {
			h = "dev"
		}
		c.AgentName = strings.ToLower(h)
	}
	if c.Adapter == "" {
		c.Adapter = AdapterClaude
	}
	if c.WorkspaceDir == "" {
		c.WorkspaceDir = filepath.Join(c.Home, "workspaces")
	}
	c.WorkspaceDir = ExpandPath(c.WorkspaceDir)
	if c.MaxConcurrency <= 0 {
		c.MaxConcurrency = DefaultMaxConcurrency
	}
	if c.MaxConcurrency > MaxConcurrencyLimit {
		c.Warnings = append(c.Warnings, fmt.Sprintf("max_concurrency=%d 超过上限，按 %d 处理", c.MaxConcurrency, MaxConcurrencyLimit))
		c.MaxConcurrency = MaxConcurrencyLimit
	}
	if c.TaskTimeout.Duration <= 0 {
		c.TaskTimeout.Duration = DefaultTaskTimeout
	}
	c.CAFile = ExpandPath(c.CAFile)
	if c.Claude.Command == "" {
		c.Claude.Command = "claude"
	}
	if c.Codex.Command == "" {
		c.Codex.Command = "codex"
	}
	if c.Codex.ExtraArgs == nil {
		c.Codex.ExtraArgs = []string{"--full-auto"}
	}
	for i := range c.Repos {
		c.Repos[i].Name = strings.Trim(strings.TrimSpace(c.Repos[i].Name), "/")
		c.Repos[i].Path = ExpandPath(c.Repos[i].Path)
	}
	for i := range c.RepoRoots {
		c.RepoRoots[i] = ExpandPath(c.RepoRoots[i])
	}
	if c.Git.Remote == "" {
		c.Git.Remote = DefaultRemote
	}
	if c.Git.TargetBranch == "" {
		c.Git.TargetBranch = DefaultTargetBranch
	}
	if c.Log.Level == "" {
		c.Log.Level = "info"
	}
	if c.Log.MaxSizeMB <= 0 {
		c.Log.MaxSizeMB = 10
	}
	if c.Log.MaxBackups <= 0 {
		c.Log.MaxBackups = 3
	}
}

// Validate checks required fields and value ranges.
func (c *Config) Validate() error {
	var errs []string
	if c.Server == "" {
		errs = append(errs, "server 未配置（例如 https://acp.example.com）")
	} else if u, err := url.Parse(c.Server); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		errs = append(errs, fmt.Sprintf("server %q 不是合法的 http(s) 地址", c.Server))
	}
	switch c.Adapter {
	case AdapterClaude, AdapterCodex, AdapterEcho:
	default:
		errs = append(errs, fmt.Sprintf("adapter %q 不支持（可选 claude-code | codex | echo）", c.Adapter))
	}
	if c.Proxy != "" {
		if u, err := url.Parse(c.Proxy); err != nil || u.Host == "" {
			errs = append(errs, fmt.Sprintf("proxy %q 不是合法的地址（例如 http://127.0.0.1:7890）", c.Proxy))
		}
	}
	seen := map[string]bool{}
	for i, r := range c.Repos {
		if r.Name == "" || r.Path == "" {
			errs = append(errs, fmt.Sprintf("repos[%d] 需要 name 和 path", i))
			continue
		}
		key := strings.ToLower(r.Name)
		if seen[key] {
			errs = append(errs, fmt.Sprintf("repos 中 %s 重复", r.Name))
		}
		seen[key] = true
	}
	if c.Atlas.Enabled && c.Atlas.LocateCmd == "" && c.Atlas.PrepareCmd == "" && c.Atlas.CheckCmd == "" {
		c.Warnings = append(c.Warnings, "atlas.enabled=true 但没有配置任何命令，将按普通 git worktree 方式准备工作区")
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

// FindRepo returns the configured repo with the given GitLab path (case-insensitive).
func (c *Config) FindRepo(name string) (Repo, bool) {
	name = strings.Trim(strings.TrimSpace(name), "/")
	for _, r := range c.Repos {
		if strings.EqualFold(r.Name, name) {
			return r, true
		}
	}
	return Repo{}, false
}

// ChecksFor returns the check commands for a repo: repos[].checks first, then
// the top-level checks map.
func (c *Config) ChecksFor(name string) []string {
	var out []string
	if r, ok := c.FindRepo(name); ok {
		out = append(out, r.Checks...)
	}
	for k, v := range c.Checks {
		if strings.EqualFold(strings.Trim(k, "/"), name) {
			out = append(out, v...)
		}
	}
	return out
}

// TargetBranchFor returns the repo's target branch or git.target_branch.
func (c *Config) TargetBranchFor(name string) string {
	if r, ok := c.FindRepo(name); ok && r.TargetBranch != "" {
		return r.TargetBranch
	}
	return c.Git.TargetBranch
}

// RepoNames lists the configured GitLab project paths (sent at register time).
func (c *Config) RepoNames() []string {
	out := make([]string, 0, len(c.Repos))
	for _, r := range c.Repos {
		out = append(out, r.Name)
	}
	return out
}

// CredentialsPath is where the member token is stored (0600).
func (c *Config) CredentialsPath() string { return filepath.Join(c.Home, "credentials.json") }

// StatePath is where the daemon publishes its status for `acp-link status`.
func (c *Config) StatePath() string { return filepath.Join(c.Home, "state.json") }

// LogDir is the log directory.
func (c *Config) LogDir() string { return filepath.Join(c.Home, "logs") }

// MCPURL is the platform MCP endpoint.
func (c *Config) MCPURL() string { return c.Server + "/mcp" }
