// Package runner is the acp-link daemon: registration, heartbeat, token
// refresh, the A2A assignment subscription, and per-task execution.
package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"acp/acp-link/internal/a2a"
	"acp/acp-link/internal/adapters"
	"acp/acp-link/internal/api"
	"acp/acp-link/internal/auth"
	"acp/acp-link/internal/config"
	"acp/acp-link/internal/gitops"
	"acp/acp-link/internal/version"
)

// TokenSource is the member token used by the daemon (auth.Manager).
type TokenSource interface {
	api.TokenProvider
	RefreshIfNeeded(ctx context.Context, threshold time.Duration) (bool, error)
	Refresh(ctx context.Context) error
}

// Options configures the daemon. Zero durations take production defaults.
type Options struct {
	Config *config.Config
	Tokens TokenSource
	API    *api.Client
	A2A    *a2a.Client
	Log    *slog.Logger
	Git    *gitops.Git

	// ConfigReload re-reads the config before each task (repo mappings may
	// have been edited after a request_input). nil = keep the startup config.
	ConfigReload func() (*config.Config, error)
	// AdapterFactory overrides adapters.New (tests).
	AdapterFactory func(name string, o adapters.Options) (adapters.Adapter, error)

	HeartbeatInterval time.Duration // 30s
	ReportInterval    time.Duration // 2s
	IdleTimeout       time.Duration // 95s (server pings every 30s)
	TaskPollInterval  time.Duration // 60s
	TokenCheckEvery   time.Duration // 1h
	BackoffBase       time.Duration // 1s
	BackoffMax        time.Duration // 60s
	ShutdownGrace     time.Duration // 20s
}

// Daemon is a running acp-link instance.
type Daemon struct {
	o   Options
	log *slog.Logger
	cfg atomic.Pointer[config.Config]

	agentMu sync.RWMutex
	agentID string

	sem chan struct{}

	mu           sync.Mutex
	tasks        map[int64]*taskRun
	shuttingDown bool
	lastBeat     time.Time
	minWarned    string
	startedAt    time.Time

	connected atomic.Bool
	tasksCtx  context.Context
	stopTasks context.CancelCauseFunc
	wg        sync.WaitGroup

	subMu     sync.Mutex
	subCancel context.CancelFunc

	stateMu sync.Mutex
	// beat asks the heartbeat loop for an immediate heartbeat (task set changed).
	beat chan struct{}
}

type taskRun struct {
	ID        int64     `json:"id"`
	Key       string    `json:"key"`
	Title     string    `json:"title"`
	Reason    string    `json:"reason,omitempty"`
	State     string    `json:"state"`
	StartedAt time.Time `json:"started_at"`
	Workspace string    `json:"workspace,omitempty"`
	cancel    context.CancelCauseFunc
}

// Sentinel causes for task cancellation.
var (
	ErrShutdown       = errors.New("acp-link 正在停止")
	ErrTaskTimeout    = errors.New("任务执行超时")
	ErrRemoteCanceled = errors.New("任务已在平台上结束或被取消")
	ErrReassigned     = errors.New("任务已改派给其他 Agent")
	ErrRevoked        = errors.New("任务已被平台撤回")
)

// New validates options and returns a daemon.
func New(o Options) (*Daemon, error) {
	if o.Config == nil || o.API == nil || o.A2A == nil || o.Tokens == nil {
		return nil, errors.New("runner: Config, API, A2A and Tokens are required")
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.Git == nil {
		o.Git = gitops.New()
	}
	if o.AdapterFactory == nil {
		o.AdapterFactory = adapters.New
	}
	def := func(d *time.Duration, v time.Duration) {
		if *d <= 0 {
			*d = v
		}
	}
	def(&o.HeartbeatInterval, 30*time.Second)
	def(&o.ReportInterval, 2*time.Second)
	def(&o.IdleTimeout, 95*time.Second)
	def(&o.TaskPollInterval, 60*time.Second)
	def(&o.TokenCheckEvery, time.Hour)
	def(&o.BackoffBase, time.Second)
	def(&o.BackoffMax, 60*time.Second)
	def(&o.ShutdownGrace, 20*time.Second)
	d := &Daemon{o: o, log: o.Log, tasks: map[int64]*taskRun{}, sem: make(chan struct{}, o.Config.MaxConcurrency), beat: make(chan struct{}, 1)}
	d.cfg.Store(o.Config)
	return d, nil
}

// AgentID returns the registered agent id ("" before registration).
func (d *Daemon) AgentID() string {
	d.agentMu.RLock()
	defer d.agentMu.RUnlock()
	return d.agentID
}

func (d *Daemon) config() *config.Config { return d.cfg.Load() }

// Run blocks until ctx is cancelled, then shuts down gracefully.
func (d *Daemon) Run(ctx context.Context) error {
	d.startedAt = time.Now()
	d.tasksCtx, d.stopTasks = context.WithCancelCause(context.Background())
	defer d.stopTasks(nil)
	cfg := d.config()
	d.log.Info("acp-link starting", "version", version.Version, "server", cfg.Server, "agent", cfg.AgentName,
		"adapter", cfg.Adapter, "max_concurrency", cfg.MaxConcurrency, "workspace", cfg.WorkspaceDir)
	if err := os.MkdirAll(cfg.WorkspaceDir, 0o755); err != nil {
		return fmt.Errorf("无法创建工作区目录 %s: %w", cfg.WorkspaceDir, err)
	}
	if _, err := d.o.Tokens.RefreshIfNeeded(ctx, auth.RefreshThreshold); err != nil {
		d.log.Warn("token refresh at startup failed", "err", err)
	}
	if err := d.registerWithRetry(ctx); err != nil {
		d.shutdown()
		return nil
	}
	var bg sync.WaitGroup
	bg.Add(2)
	go func() { defer bg.Done(); d.heartbeatLoop(ctx) }()
	go func() { defer bg.Done(); d.tokenLoop(ctx) }()
	d.subscribeLoop(ctx)
	bg.Wait()
	d.shutdown()
	return nil
}

func (d *Daemon) registerReq() api.RegisterRequest {
	cfg := d.config()
	host, _ := os.Hostname()
	skills := cfg.Skills
	if skills == nil {
		skills = []string{}
	}
	return api.RegisterRequest{
		Name: cfg.AgentName, Kind: cfg.Adapter, Version: version.Version, Host: host,
		Skills: skills, Repos: cfg.RepoNames(), MaxConcurrency: cfg.MaxConcurrency, AutoAcceptHelp: cfg.AutoAcceptHelp,
	}
}

func (d *Daemon) register(ctx context.Context) error {
	ag, err := d.o.API.Register(ctx, d.registerReq())
	if err != nil {
		return err
	}
	d.agentMu.Lock()
	changed := d.agentID != "" && d.agentID != ag.ID
	d.agentID = ag.ID
	d.agentMu.Unlock()
	d.log.Info("agent registered", "agent_id", ag.ID, "name", ag.Name, "member", ag.Member.Name)
	if changed {
		d.restartSubscription()
	}
	d.writeState()
	return nil
}

func (d *Daemon) registerWithRetry(ctx context.Context) error {
	bo := NewBackoff(d.o.BackoffBase, d.o.BackoffMax)
	for {
		err := d.register(ctx)
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if api.IsUnauthorized(err) {
			if rerr := d.o.Tokens.Refresh(ctx); rerr != nil {
				d.log.Error("登录已失效，请重新运行 acp-link login", "err", err)
			}
		}
		wait := bo.Next()
		d.log.Warn("register failed, retrying", "err", err, "retry_in", wait.Round(time.Millisecond))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
}

func (d *Daemon) restartSubscription() {
	d.subMu.Lock()
	if d.subCancel != nil {
		d.subCancel()
	}
	d.subMu.Unlock()
}

func (d *Daemon) subscribeLoop(ctx context.Context) {
	bo := NewBackoff(d.o.BackoffBase, d.o.BackoffMax)
	for ctx.Err() == nil {
		sctx, cancel := context.WithCancel(ctx)
		d.subMu.Lock()
		d.subCancel = cancel
		d.subMu.Unlock()
		start := time.Now()
		agentID := d.AgentID()
		err := d.o.A2A.Subscribe(sctx, a2a.SubscribeOptions{
			AgentID:     agentID,
			IdleTimeout: d.o.IdleTimeout,
			OnOpen: func(id string) {
				d.connected.Store(true)
				d.log.Info("subscribed to assignments", "subscription", id)
				d.writeState()
			},
			OnItem: d.onItem,
		})
		cancel()
		wasConnected := d.connected.Swap(false)
		if wasConnected {
			d.writeState()
		}
		if ctx.Err() != nil {
			return
		}
		if time.Since(start) > time.Minute {
			bo.Reset() // the connection was healthy for a while
		}
		switch {
		case api.IsUnauthorized(err):
			if rerr := d.o.Tokens.Refresh(ctx); rerr != nil {
				d.log.Error("订阅被拒绝且令牌刷新失败，请重新运行 acp-link login", "err", rerr)
			}
		case api.IsStatus(err, http.StatusNotFound) || api.IsCode(err, "not_found"):
			if rerr := d.register(ctx); rerr != nil {
				d.log.Warn("re-register failed", "err", rerr)
			}
		}
		wait := bo.Next()
		level := slog.LevelWarn
		if errors.Is(err, context.Canceled) {
			level = slog.LevelInfo // restart requested
			wait = 0
		}
		d.log.Log(ctx, level, "subscription ended, reconnecting", "err", err, "retry_in", wait.Round(time.Millisecond), "attempt", bo.Attempt())
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func (d *Daemon) onItem(it a2a.StreamItem) {
	switch {
	case it.Assignment != nil:
		d.onAssignment(*it.Assignment, it.Reason)
	case it.DataType == a2a.DataRevoked:
		d.revoke(it.DataTaskID, it.Reason)
	case it.DataType == a2a.DataMessage:
		d.log.Info("task message", "task", fmt.Sprintf("ACP-%d", it.DataTaskID), "from", it.From, "text", clip(it.Text, 300))
	case it.DataType == a2a.DataTaskState:
		if it.Task != nil {
			d.log.Info("task state", "task", keyOf(*it.Task), "state", it.Task.State)
		}
	case it.DataType == a2a.DataPing:
		d.log.Debug("subscription ping")
	case it.Kind == "invalid":
		d.log.Warn("invalid subscription update ignored", "err", it.Text)
	default:
		d.log.Debug("subscription update", "kind", it.Kind, "state", it.State, "data_type", it.DataType)
	}
}

// revoke stops a running task that was canceled or reclaimed on the platform.
// The agent is killed, the workspace kept, and nothing more is reported.
func (d *Daemon) revoke(id int64, reason string) {
	d.mu.Lock()
	run, ok := d.tasks[id]
	d.mu.Unlock()
	log := d.log.With("task", fmt.Sprintf("ACP-%d", id))
	if !ok {
		log.Info("revocation for a task that is not running", "reason", reason)
		return
	}
	log.Warn("task revoked by the platform, stopping agent (workspace kept)", "reason", reason, "workspace", run.Workspace)
	run.cancel(fmt.Errorf("%w: %s", ErrRevoked, reason))
}

func (d *Daemon) onAssignment(ts api.TaskSummary, reason string) {
	log := d.log.With("task", keyOf(ts), "reason", reason)
	if api.Terminal(ts.State) {
		log.Info("assignment for finished task ignored", "state", ts.State)
		return
	}
	d.mu.Lock()
	if d.shuttingDown {
		d.mu.Unlock()
		return
	}
	if _, dup := d.tasks[ts.ID]; dup {
		d.mu.Unlock()
		log.Info("assignment ignored: task is already queued or running here")
		return
	}
	ahead := 0
	for _, t := range d.tasks {
		if t.State == "queued" || t.State == "running" {
			ahead++
		}
	}
	ahead -= d.config().MaxConcurrency - 1
	if ahead < 0 {
		ahead = 0
	}
	tctx, cancel := context.WithCancelCause(d.tasksCtx)
	run := &taskRun{ID: ts.ID, Key: keyOf(ts), Title: ts.Title, Reason: reason, State: "queued", StartedAt: time.Now(), cancel: cancel}
	d.tasks[ts.ID] = run
	d.wg.Add(1)
	d.mu.Unlock()
	log.Info("assignment received", "title", ts.Title, "queued_ahead", ahead)
	d.writeState()
	go d.runTask(tctx, run, ts, reason, ahead)
}

func keyOf(ts api.TaskSummary) string {
	if ts.Key != "" {
		return ts.Key
	}
	return fmt.Sprintf("ACP-%d", ts.ID)
}

func (d *Daemon) setTaskState(run *taskRun, state, workspace string) {
	d.mu.Lock()
	run.State = state
	if workspace != "" {
		run.Workspace = workspace
	}
	d.mu.Unlock()
	d.writeState()
}

func (d *Daemon) runTask(ctx context.Context, run *taskRun, ts api.TaskSummary, reason string, ahead int) {
	defer d.wg.Done()
	defer func() {
		run.cancel(nil)
		d.mu.Lock()
		delete(d.tasks, run.ID)
		d.mu.Unlock()
		d.writeState()
		d.kickHeartbeat()
	}()
	ex := newExecution(ctx, d, run, ts, reason)
	ex.ack(ahead)
	ex.rep.Start(ex.rctx)
	defer ex.rep.Stop(ex.rctx)
	select {
	case d.sem <- struct{}{}:
	case <-ctx.Done():
		ex.interrupted(ctx, false)
		return
	}
	defer func() { <-d.sem }()
	d.setTaskState(run, "running", "")
	d.kickHeartbeat()
	ex.execute(ctx)
}

// kickHeartbeat requests an immediate heartbeat without blocking.
func (d *Daemon) kickHeartbeat() {
	select {
	case d.beat <- struct{}{}:
	default:
	}
}

// snapshot returns current task ids and whether all slots are used.
func (d *Daemon) snapshot() ([]int64, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	ids := make([]int64, 0, len(d.tasks))
	running := 0
	for id, t := range d.tasks {
		ids = append(ids, id)
		if t.State == "running" {
			running++
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids, running >= d.config().MaxConcurrency
}

func (d *Daemon) heartbeatLoop(ctx context.Context) {
	t := time.NewTicker(d.o.HeartbeatInterval)
	defer t.Stop()
	d.heartbeat(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.heartbeat(ctx)
			d.writeState()
		case <-d.beat:
			d.heartbeat(ctx)
			t.Reset(d.o.HeartbeatInterval)
		}
	}
}

func (d *Daemon) heartbeat(ctx context.Context) {
	ids, busy := d.snapshot()
	status := "online"
	if busy {
		status = "busy"
	}
	resp, err := d.o.API.Heartbeat(ctx, d.AgentID(), api.HeartbeatRequest{Status: status, CurrentTaskIDs: ids})
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		switch {
		case api.IsStatus(err, http.StatusNotFound) || api.IsCode(err, "not_found"):
			d.log.Warn("agent unknown to server, re-registering")
			if rerr := d.register(ctx); rerr != nil {
				d.log.Warn("re-register failed", "err", rerr)
			}
		case api.IsUnauthorized(err):
			if rerr := d.o.Tokens.Refresh(ctx); rerr != nil {
				d.log.Error("心跳被拒绝且令牌刷新失败，请重新运行 acp-link login", "err", rerr)
			}
		default:
			d.log.Warn("heartbeat failed", "err", err)
		}
		return
	}
	d.mu.Lock()
	d.lastBeat = time.Now()
	warn := resp.MinLinkVersion != "" && resp.MinLinkVersion != d.minWarned && version.Older(version.Version, resp.MinLinkVersion)
	if warn {
		d.minWarned = resp.MinLinkVersion
	}
	d.mu.Unlock()
	if warn {
		d.log.Warn("acp-link 版本过旧，请更新", "current", version.Version, "min_required", resp.MinLinkVersion,
			"download", d.config().Server+"/downloads/")
	}
	d.log.Debug("heartbeat ok", "status", status, "tasks", ids)
	d.writeState()
}

func (d *Daemon) tokenLoop(ctx context.Context) {
	t := time.NewTicker(d.o.TokenCheckEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if _, err := d.o.Tokens.RefreshIfNeeded(ctx, auth.RefreshThreshold); err != nil {
				d.log.Error("token refresh failed", "err", err)
			}
		}
	}
}

// shutdown interrupts running tasks and waits up to ShutdownGrace.
func (d *Daemon) shutdown() {
	d.mu.Lock()
	d.shuttingDown = true
	n := len(d.tasks)
	d.mu.Unlock()
	if n > 0 {
		d.log.Info("stopping running tasks", "count", n)
	}
	d.stopTasks(ErrShutdown)
	done := make(chan struct{})
	go func() { d.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(d.o.ShutdownGrace):
		d.log.Warn("tasks did not stop within grace period")
	}
	d.connected.Store(false)
	d.writeState()
	d.log.Info("acp-link stopped")
}

// State is what `acp-link status` reads from state.json.
type State struct {
	Version         string     `json:"version"`
	PID             int        `json:"pid"`
	Server          string     `json:"server"`
	AgentID         string     `json:"agent_id"`
	AgentName       string     `json:"agent_name"`
	Adapter         string     `json:"adapter"`
	Connected       bool       `json:"connected"`
	Running         bool       `json:"running"`
	StartedAt       time.Time  `json:"started_at"`
	LastHeartbeatAt *time.Time `json:"last_heartbeat_at,omitempty"`
	Tasks           []taskRun  `json:"tasks"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

func (d *Daemon) writeState() {
	cfg := d.config()
	if cfg.Home == "" {
		return
	}
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	d.mu.Lock()
	st := State{
		Version: version.Version, PID: os.Getpid(), Server: cfg.Server, AgentID: d.AgentID(),
		AgentName: cfg.AgentName, Adapter: cfg.Adapter, Connected: d.connected.Load(), Running: !d.shuttingDown,
		StartedAt: d.startedAt, UpdatedAt: time.Now(), Tasks: []taskRun{},
	}
	if !d.lastBeat.IsZero() {
		t := d.lastBeat
		st.LastHeartbeatAt = &t
	}
	for _, t := range d.tasks {
		st.Tasks = append(st.Tasks, *t)
	}
	d.mu.Unlock()
	sort.Slice(st.Tasks, func(i, j int) bool { return st.Tasks[i].ID < st.Tasks[j].ID })
	data, _ := json.MarshalIndent(st, "", "  ")
	_ = auth.WriteFileAtomic(cfg.StatePath(), data, 0o600)
}

// ReadState loads state.json.
func ReadState(path string) (*State, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var s State
	return &s, json.Unmarshal(data, &s)
}
