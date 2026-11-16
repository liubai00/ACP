// Package auth implements device login, token storage and refresh.
package auth

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ErrNoCredentials means `acp-link login` has not been run.
var ErrNoCredentials = errors.New("尚未登录：请先运行 acp-link login")

// Credentials is the persisted member token (credentials.json, mode 0600).
type Credentials struct {
	Server      string    `json:"server"`
	AccessToken string    `json:"access_token"`
	TokenType   string    `json:"token_type"`
	ExpiresAt   time.Time `json:"expires_at"`
	MemberID    string    `json:"member_id"`
	MemberName  string    `json:"member_name"`
	ObtainedAt  time.Time `json:"obtained_at"`
}

// LoadCredentials reads path.
func LoadCredentials(path string) (*Credentials, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrNoCredentials
		}
		return nil, err
	}
	var c Credentials
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("%s 已损坏，请重新运行 acp-link login: %w", path, err)
	}
	if c.AccessToken == "" {
		return nil, ErrNoCredentials
	}
	return &c, nil
}

// Save writes credentials atomically with 0600 permissions. On Windows the
// file inherits the ACL of the user profile directory (owner-only by default).
func (c *Credentials) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return WriteFileAtomic(path, data, 0o600)
}

// WriteFileAtomic writes to a temp file in the same directory, then renames.
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	cleanup := func() { _ = os.Remove(name) }
	if err := tmp.Chmod(perm); err != nil && !isWindows() {
		tmp.Close()
		cleanup()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(name, path); err != nil {
		cleanup()
		return err
	}
	return os.Chmod(path, perm)
}

// Claims are the JWT claims acp-link cares about. The signature is NOT
// verified locally; the server verifies every request.
type Claims struct {
	Sub     string   `json:"sub"`
	Name    string   `json:"name"`
	Roles   []string `json:"roles"`
	Act     string   `json:"act"`
	TaskID  any      `json:"task_id"`
	AgentID string   `json:"agent_id"`
	Exp     int64    `json:"exp"`
	Iat     int64    `json:"iat"`
	Iss     string   `json:"iss"`
}

// Expiry returns exp as time (zero when absent).
func (c Claims) Expiry() time.Time {
	if c.Exp == 0 {
		return time.Time{}
	}
	return time.Unix(c.Exp, 0)
}

// ParseClaims decodes the payload of a JWT without verifying it.
func ParseClaims(token string) (Claims, error) {
	var c Claims
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return c, errors.New("令牌不是 JWT 格式")
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return c, fmt.Errorf("令牌 payload 解码失败: %w", err)
	}
	if err := json.Unmarshal(payload, &c); err != nil {
		return c, fmt.Errorf("令牌 payload 解析失败: %w", err)
	}
	return c, nil
}

// ExpiryOf returns the token expiry from its claims, falling back to fallback.
func ExpiryOf(token string, fallback time.Time) time.Time {
	if c, err := ParseClaims(token); err == nil && c.Exp > 0 {
		return c.Expiry()
	}
	return fallback
}
