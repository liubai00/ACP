package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"acp/acp-link/internal/version"
)

// TokenProvider supplies the current bearer token.
type TokenProvider interface {
	Token() string
}

// StaticToken is a TokenProvider for a fixed token.
type StaticToken string

// Token implements TokenProvider.
func (s StaticToken) Token() string { return string(s) }

// Error is a non-2xx response ({"error": code, "message": text}).
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string {
	msg := e.Message
	if msg == "" {
		msg = http.StatusText(e.Status)
	}
	if e.Code != "" {
		return fmt.Sprintf("HTTP %d %s: %s", e.Status, e.Code, msg)
	}
	return fmt.Sprintf("HTTP %d: %s", e.Status, msg)
}

// IsCode reports whether err is an *Error with the given code.
func IsCode(err error, code string) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == code
}

// IsStatus reports whether err is an *Error with the given HTTP status.
func IsStatus(err error, status int) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == status
}

// IsUnauthorized reports a 401 / unauthorized error.
func IsUnauthorized(err error) bool {
	return IsStatus(err, http.StatusUnauthorized) || IsCode(err, "unauthorized")
}

// Client talks to the coordinator REST API.
type Client struct {
	BaseURL string
	// HTTP is used for request/response calls (has an overall timeout).
	HTTP *http.Client
	// Stream is used for SSE (no overall timeout).
	Stream *http.Client
	Tokens TokenProvider
}

// New creates a client for baseURL using transport rt.
func New(baseURL string, rt http.RoundTripper, tokens TokenProvider) *Client {
	if rt == nil {
		rt = http.DefaultTransport
	}
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP:    &http.Client{Transport: rt, Timeout: 30 * time.Second},
		Stream:  &http.Client{Transport: rt},
		Tokens:  tokens,
	}
}

// NewRequest builds a request with standard headers. body is JSON-encoded when non-nil.
func (c *Client) NewRequest(ctx context.Context, method, path string, body any, auth bool) (*http.Request, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rd)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", version.UserAgent())
	if auth && c.Tokens != nil {
		if t := c.Tokens.Token(); t != "" {
			req.Header.Set("Authorization", "Bearer "+t)
		}
	}
	return req, nil
}

// Do performs a JSON call; out may be nil.
func (c *Client) Do(ctx context.Context, method, path string, body, out any, auth bool) error {
	req, err := c.NewRequest(ctx, method, path, body, auth)
	if err != nil {
		return err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return DecodeResponse(resp, out)
}

// DecodeResponse turns non-2xx into *Error and decodes 2xx JSON into out.
func DecodeResponse(resp *http.Response, out any) error {
	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		e := &Error{Status: resp.StatusCode}
		var body struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		if json.Unmarshal(data, &body) == nil {
			e.Code, e.Message = body.Error, body.Message
		} else {
			e.Message = strings.TrimSpace(truncate(string(data), 300))
		}
		return e
	}
	if out == nil || len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("解析响应失败: %w", err)
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// Healthz calls GET /healthz and also returns the server Date header (for clock-skew checks).
func (c *Client) Healthz(ctx context.Context) (*Health, time.Time, error) {
	req, err := c.NewRequest(ctx, http.MethodGet, "/healthz", nil, false)
	if err != nil {
		return nil, time.Time{}, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, time.Time{}, err
	}
	defer resp.Body.Close()
	var h Health
	if err := DecodeResponse(resp, &h); err != nil {
		return nil, time.Time{}, err
	}
	date, _ := http.ParseTime(resp.Header.Get("Date"))
	return &h, date, nil
}

// DeviceCode starts the device authorization flow.
func (c *Client) DeviceCode(ctx context.Context, client, hostname string) (*DeviceCode, error) {
	var out DeviceCode
	err := c.Do(ctx, http.MethodPost, "/auth/device/code", map[string]string{"client": client, "hostname": hostname}, &out, false)
	return &out, err
}

// DeviceToken polls once. Pending/expired are returned as *Error with Code
// authorization_pending / slow_down / expired_token / access_denied.
func (c *Client) DeviceToken(ctx context.Context, deviceCode string) (*DeviceToken, error) {
	var out DeviceToken
	err := c.Do(ctx, http.MethodPost, "/auth/device/token", map[string]string{"device_code": deviceCode}, &out, false)
	return &out, err
}

// Refresh exchanges the current token for a new one.
func (c *Client) Refresh(ctx context.Context) (string, error) {
	var out struct {
		Token string `json:"token"`
	}
	if err := c.Do(ctx, http.MethodPost, "/auth/refresh", map[string]string{}, &out, true); err != nil {
		return "", err
	}
	if out.Token == "" {
		return "", errors.New("refresh 响应缺少 token")
	}
	return out.Token, nil
}

// Me returns the logged-in member.
func (c *Client) Me(ctx context.Context) (*Member, error) {
	var out struct {
		Member Member `json:"member"`
	}
	err := c.Do(ctx, http.MethodGet, "/api/me", nil, &out, true)
	return &out.Member, err
}

// Register registers (or updates) this agent.
func (c *Client) Register(ctx context.Context, r RegisterRequest) (*Agent, error) {
	var out Agent
	err := c.Do(ctx, http.MethodPost, "/api/agents/register", r, &out, true)
	if err == nil && out.ID == "" {
		err = errors.New("register 响应缺少 agent id")
	}
	return &out, err
}

// Heartbeat reports liveness.
func (c *Client) Heartbeat(ctx context.Context, agentID string, r HeartbeatRequest) (*HeartbeatResponse, error) {
	if r.CurrentTaskIDs == nil {
		r.CurrentTaskIDs = []int64{}
	}
	var out HeartbeatResponse
	err := c.Do(ctx, http.MethodPost, "/api/agents/"+url.PathEscape(agentID)+"/heartbeat", r, &out, true)
	return &out, err
}

// Agents lists agents.
func (c *Client) Agents(ctx context.Context) ([]Agent, error) {
	var out struct {
		Items []Agent `json:"items"`
	}
	err := c.Do(ctx, http.MethodGet, "/api/agents", nil, &out, true)
	return out.Items, err
}

// Task fetches task detail.
func (c *Client) Task(ctx context.Context, id int64) (*TaskDetail, error) {
	var out TaskDetail
	err := c.Do(ctx, http.MethodGet, fmt.Sprintf("/api/tasks/%d", id), nil, &out, true)
	return &out, err
}

// PersonalToken is a revocable personal access token (POST /api/me/tokens).
type PersonalToken struct {
	ID        FlexString `json:"id"`
	Token     string     `json:"token"`
	ExpiresAt string     `json:"expires_at"`
	MCPURL    string     `json:"mcp_url"`
}

// CreatePersonalToken creates a personal access token valid for days (1-90).
func (c *Client) CreatePersonalToken(ctx context.Context, name string, days int) (*PersonalToken, error) {
	var out PersonalToken
	err := c.Do(ctx, http.MethodPost, "/api/me/tokens", map[string]any{"name": name, "days": days}, &out, true)
	if err == nil && out.Token == "" {
		err = errors.New("/api/me/tokens 响应缺少 token")
	}
	return &out, err
}

// AgentToken obtains a task-scoped token for the agent.
func (c *Client) AgentToken(ctx context.Context, taskID int64, agentID string) (*AgentToken, error) {
	var out AgentToken
	err := c.Do(ctx, http.MethodPost, fmt.Sprintf("/api/tasks/%d/agent-token", taskID), map[string]string{"agent_id": agentID}, &out, true)
	if err == nil && out.Token == "" {
		err = errors.New("agent-token 响应缺少 token")
	}
	return &out, err
}
