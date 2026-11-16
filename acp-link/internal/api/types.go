// Package api is the REST client for the ACP coordinator (contracts/API.md §2-3).
package api

import "encoding/json"

// MemberRef is a lightweight member reference.
type MemberRef struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	AvatarURL *string `json:"avatar_url"`
}

// Member is the full member record.
type Member struct {
	MemberRef
	Roles          []string `json:"roles"`
	Team           *string  `json:"team"`
	GitlabUsername *string  `json:"gitlab_username"`
	IsActive       bool     `json:"is_active"`
}

// AgentRef is TaskSummary.assignee_agent.
type AgentRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// Agent is a registered agent.
type Agent struct {
	ID              string    `json:"id"`
	Member          MemberRef `json:"member"`
	Name            string    `json:"name"`
	Kind            string    `json:"kind"`
	Version         *string   `json:"version"`
	Host            *string   `json:"host"`
	Skills          []string  `json:"skills"`
	Repos           []string  `json:"repos"`
	MaxConcurrency  int       `json:"max_concurrency"`
	AutoAcceptHelp  bool      `json:"auto_accept_help"`
	Status          string    `json:"status"`
	LastHeartbeatAt *string   `json:"last_heartbeat_at"`
	CurrentTaskIDs  []int64   `json:"current_task_ids"`
}

// TaskSummary mirrors the contract type.
type TaskSummary struct {
	ID            int64      `json:"id"`
	Key           string     `json:"key"`
	Title         string     `json:"title"`
	State         string     `json:"state"`
	Type          string     `json:"type"`
	Priority      string     `json:"priority"`
	Source        string     `json:"source"`
	Repos         []string   `json:"repos"`
	Skills        []string   `json:"skills"`
	Labels        []string   `json:"labels"`
	Creator       *MemberRef `json:"creator"`
	Assignee      *MemberRef `json:"assignee"`
	AssigneeAgent *AgentRef  `json:"assignee_agent"`
	ParentID      *int64     `json:"parent_id"`
	RootID        int64      `json:"root_id"`
	Depth         int        `json:"depth"`
	CIStatus      string     `json:"ci_status"`
	CreatedAt     string     `json:"created_at"`
	UpdatedAt     string     `json:"updated_at"`
	IsDemo        bool       `json:"is_demo"`
}

// MergeRequest mirrors the contract type.
type MergeRequest struct {
	ID             int64   `json:"id"`
	Repo           string  `json:"repo"`
	Branch         string  `json:"branch"`
	IID            *int64  `json:"iid"`
	URL            *string `json:"url"`
	State          string  `json:"state"`
	PipelineStatus string  `json:"pipeline_status"`
}

// TimelineActor identifies who produced a timeline item.
type TimelineActor struct {
	Type string  `json:"type"`
	ID   *string `json:"id"`
	Name string  `json:"name"`
}

// TimelineItem mirrors the contract type.
type TimelineItem struct {
	ID    string          `json:"id"`
	Kind  string          `json:"kind"`
	Type  string          `json:"type"`
	At    string          `json:"at"`
	Actor TimelineActor   `json:"actor"`
	Text  string          `json:"text"`
	Data  json.RawMessage `json:"data"`
}

// TaskDetail is GET /api/tasks/{id}.
type TaskDetail struct {
	TaskSummary
	Description    string         `json:"description"`
	MergeRequests  []MergeRequest `json:"merge_requests"`
	Children       []TaskSummary  `json:"children"`
	Timeline       []TimelineItem `json:"timeline"`
	AllowedActions []string       `json:"allowed_actions"`
}

// DeviceCode is POST /auth/device/code.
type DeviceCode struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

// DeviceToken is a successful POST /auth/device/token.
type DeviceToken struct {
	AccessToken string    `json:"access_token"`
	TokenType   string    `json:"token_type"`
	ExpiresIn   int64     `json:"expires_in"`
	Member      MemberRef `json:"member"`
}

// RegisterRequest is POST /api/agents/register.
type RegisterRequest struct {
	Name           string   `json:"name"`
	Kind           string   `json:"kind"`
	Version        string   `json:"version"`
	Host           string   `json:"host"`
	Skills         []string `json:"skills"`
	Repos          []string `json:"repos"`
	MaxConcurrency int      `json:"max_concurrency"`
	AutoAcceptHelp bool     `json:"auto_accept_help"`
}

// HeartbeatRequest is POST /api/agents/{id}/heartbeat.
type HeartbeatRequest struct {
	Status         string  `json:"status"`
	CurrentTaskIDs []int64 `json:"current_task_ids"`
}

// HeartbeatResponse is the heartbeat reply.
type HeartbeatResponse struct {
	OK             bool   `json:"ok"`
	MinLinkVersion string `json:"min_link_version"`
}

// AgentToken is POST /api/tasks/{id}/agent-token.
type AgentToken struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expires_at"`
	MCPURL    string `json:"mcp_url"`
}

// Health is GET /healthz.
type Health struct {
	Status  string `json:"status"`
	Version string `json:"version"`
	DB      string `json:"db"`
}

// FlexString decodes a JSON string or number (ids whose type the contract leaves open).
type FlexString string

// UnmarshalJSON implements json.Unmarshaler.
func (f *FlexString) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		*f = FlexString(s)
		return nil
	}
	var n json.Number
	if err := json.Unmarshal(b, &n); err != nil {
		return err
	}
	*f = FlexString(n.String())
	return nil
}

// Terminal reports whether a task state is final.
func Terminal(state string) bool {
	switch state {
	case "completed", "failed", "canceled", "rejected":
		return true
	}
	return false
}
