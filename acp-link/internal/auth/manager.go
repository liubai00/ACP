package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"acp/acp-link/internal/api"
)

// RefreshThreshold: refresh when less than this is left.
const RefreshThreshold = 24 * time.Hour

// Manager holds the member token in memory, persists refreshes and implements
// api.TokenProvider. The member token is never handed to coding agents.
type Manager struct {
	path string
	log  *slog.Logger

	mu    sync.RWMutex
	creds *Credentials
	// refresher is set by Bind; it uses this manager as its token source.
	refresher func(ctx context.Context) (string, error)
}

// NewManager loads credentials from path.
func NewManager(path string, log *slog.Logger) (*Manager, error) {
	c, err := LoadCredentials(path)
	if err != nil {
		return nil, err
	}
	if log == nil {
		log = slog.Default()
	}
	return &Manager{path: path, creds: c, log: log}, nil
}

// Bind attaches the API client used for refresh.
func (m *Manager) Bind(c *api.Client) { m.refresher = c.Refresh }

// Token implements api.TokenProvider.
func (m *Manager) Token() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.creds.AccessToken
}

// Credentials returns a copy of the current credentials.
func (m *Manager) Credentials() Credentials {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return *m.creds
}

// ExpiresAt returns the token expiry.
func (m *Manager) ExpiresAt() time.Time {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.creds.ExpiresAt
}

// CheckServer ensures the token was issued for server.
func (m *Manager) CheckServer(server string) error {
	c := m.Credentials()
	if c.Server != "" && !strings.EqualFold(strings.TrimRight(c.Server, "/"), strings.TrimRight(server, "/")) {
		return fmt.Errorf("已保存的登录属于 %s，而配置的 server 是 %s；请重新运行 acp-link login", c.Server, server)
	}
	return nil
}

// Expired reports whether the token has already expired.
func (m *Manager) Expired(now time.Time) bool {
	exp := m.ExpiresAt()
	return !exp.IsZero() && now.After(exp)
}

// RefreshIfNeeded refreshes when less than threshold is left.
func (m *Manager) RefreshIfNeeded(ctx context.Context, threshold time.Duration) (bool, error) {
	exp := m.ExpiresAt()
	if exp.IsZero() || time.Until(exp) > threshold {
		return false, nil
	}
	if time.Now().After(exp) {
		return false, errors.New("登录已过期，请重新运行 acp-link login")
	}
	return true, m.Refresh(ctx)
}

// Refresh exchanges the token and persists the new one.
func (m *Manager) Refresh(ctx context.Context) error {
	if m.refresher == nil {
		return errors.New("token manager not bound to a client")
	}
	tok, err := m.refresher(ctx)
	if err != nil {
		return fmt.Errorf("刷新令牌失败: %w", err)
	}
	m.mu.Lock()
	c := *m.creds
	c.AccessToken = tok
	c.ExpiresAt = ExpiryOf(tok, time.Now().Add(7*24*time.Hour))
	c.ObtainedAt = time.Now()
	m.creds = &c
	m.mu.Unlock()
	if err := c.Save(m.path); err != nil {
		return fmt.Errorf("保存新令牌失败: %w", err)
	}
	m.log.Info("member token refreshed", "expires_at", c.ExpiresAt.Format(time.RFC3339))
	return nil
}
