package adapters

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// MCPConfig is the Claude Code --mcp-config file format. The codex adapter
// reads the same file to build its -c overrides.
type MCPConfig struct {
	MCPServers map[string]MCPServer `json:"mcpServers"`
}

// MCPServer is one streamable-HTTP MCP server entry.
type MCPServer struct {
	Type    string            `json:"type"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
}

// BuildMCPConfig returns the config for the platform MCP endpoint.
func BuildMCPConfig(url, token string) MCPConfig {
	return MCPConfig{MCPServers: map[string]MCPServer{
		MCPServerName: {Type: "http", URL: url, Headers: map[string]string{"Authorization": "Bearer " + token}},
	}}
}

// WriteMCPConfig writes the MCP config with 0600 permissions.
func WriteMCPConfig(path, url, token string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(BuildMCPConfig(url, token), "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// ReadMCPConfig returns the platform server's URL and bearer token.
func ReadMCPConfig(path string) (url, token string, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", err
	}
	var c MCPConfig
	if err := json.Unmarshal(data, &c); err != nil {
		return "", "", err
	}
	s, ok := c.MCPServers[MCPServerName]
	if !ok || s.URL == "" {
		return "", "", errors.New("mcp config has no acp server")
	}
	return s.URL, strings.TrimPrefix(s.Headers["Authorization"], "Bearer "), nil
}
