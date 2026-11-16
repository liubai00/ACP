package runner

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"acp/acp-link/internal/a2a"
	"acp/acp-link/internal/adapters"
	"acp/acp-link/internal/api"
	"acp/acp-link/internal/atlas"
	"acp/acp-link/internal/config"
	"acp/acp-link/internal/gitops"
	"acp/acp-link/internal/workspace"
)

// execution runs one task end to end.
type execution struct {
	d      *Daemon
	cfg    *config.Config
	run    *taskRun
	ts     api.TaskSummary
	detail *api.TaskDetail
	key    string
	log    *slog.Logger
	layout workspace.Layout
	branch string
	plans  []workspace.RepoPlan
	atlas  *atlas.Atlas
	git    *gitops.Git
	// rctx is used for reports; it survives task cancellation so the platform
	// is always told what happened.
	rctx context.Context
	// ctx is the task context (its cause tells whether reporting is still allowed).
	ctx    context.Context
	reason string
	// rep throttles every progress/tool message of this task (1 per ReportInterval).
	rep *reporter
}

func newExecution(ctx context.Context, d *Daemon, run *taskRun, ts api.TaskSummary, reason string) *execution {
	base := d.config()
	cfg := base
	if d.o.ConfigReload != nil {
		if c, err := d.o.ConfigReload(); err == nil {
			// Repos, checks, atlas and adapter settings may change between
			// tasks; identity and capacity stay as registered.
			c.Server, c.Home, c.AgentName, c.MaxConcurrency = base.Server, base.Home, base.AgentName, base.MaxConcurrency
			cfg = c
		} else {
			d.log.Warn("config reload failed, using startup config", "err", err)
		}
	}
	ex := &execution{
		d: d, cfg: cfg, run: run, ts: ts, key: keyOf(ts),
		log:    d.log.With("task", keyOf(ts)),
		layout: workspace.Layout{Root: cfg.WorkspaceDir},
		branch: workspace.BranchName(ts.ID, ts.Title),
		atlas:  &atlas.Atlas{Cfg: cfg.Atlas, Timeout: cfg.TaskTimeout.Duration},
		git:    d.o.Git,
		rctx:   context.Background(),
		ctx:    ctx,
		reason: reason,
	}
	ex.rep = newReporter(d.o.ReportInterval, func(_ context.Context, kind, text string) error {
		return ex.send(kind, "", text, nil)
	})
	return ex
}

func (ex *execution) taskDir() string { return ex.layout.TaskDir(ex.ts.ID) }

// ---- reporting ----

// silenced reports whether the platform took the task away (revoked,
// canceled, reassigned): from then on nothing more is reported.
func (ex *execution) silenced() bool {
	cause := context.Cause(ex.ctx)
	return errors.Is(cause, ErrRevoked) || errors.Is(cause, ErrRemoteCanceled) || errors.Is(cause, ErrReassigned)
}

// report sends a message to the platform. progress/tool messages go through
// the throttling reporter; everything else first flushes pending progress so
// the order on the timeline is preserved.
func (ex *execution) report(kind, state, text string, arts []a2a.Artifact) error {
	switch kind {
	case a2a.KindProgress, a2a.KindTool:
		if state == "" {
			ex.rep.Add(kind, text)
			return nil
		}
	default:
		ex.rep.Flush(ex.rctx)
	}
	return ex.send(kind, state, text, arts)
}

// send performs one report_progress call (with retries for important kinds).
func (ex *execution) send(kind, state, text string, arts []a2a.Artifact) error {
	if ex.silenced() {
		ex.log.Debug("report suppressed: task no longer ours", "kind", kind)
		return nil
	}
	attempts := 1
	switch kind {
	case a2a.KindAck, a2a.KindConclusion, a2a.KindArtifact:
		attempts = 3
	}
	var last error
	for i := 0; i < attempts; i++ {
		if i > 0 {
			time.Sleep(time.Duration(1<<i) * time.Second)
		}
		ctx, cancel := context.WithTimeout(ex.rctx, 20*time.Second)
		t, err := ex.d.o.A2A.ReportProgress(ctx, a2a.Progress{
			TaskID: ex.ts.ID, AgentID: ex.d.AgentID(), State: state, Kind: kind, Text: text, Artifacts: arts,
		})
		cancel()
		if err == nil {
			if !api.Terminal(state) { // we did not end it ourselves
				ex.observeState(t.State())
			}
			return nil
		}
		last = err
		var rpcErr *a2a.RPCError
		if errors.As(err, &rpcErr) || api.IsStatus(err, http.StatusForbidden) || api.IsStatus(err, http.StatusNotFound) {
			break // the server rejected it; retrying will not help
		}
	}
	ex.log.Warn("report_progress failed", "kind", kind, "err", last)
	return last
}

// observeState cancels the run when the platform says the task is over.
func (ex *execution) observeState(state string) {
	if state != "" && api.Terminal(state) {
		ex.log.Info("task ended on the platform, stopping", "state", state)
		ex.run.cancel(ErrRemoteCanceled)
	}
}

func (ex *execution) progress(text string) { _ = ex.report(a2a.KindProgress, "", text, nil) }

func (ex *execution) ack(ahead int) {
	text := "acp-link 已收到派工，正在准备工作区。"
	if ex.reason != "" && ex.reason != "new" {
		text = "acp-link 已收到重新派工（" + reasonText(ex.reason) + "），正在准备工作区。"
	}
	if ahead > 0 {
		text = fmt.Sprintf("acp-link 已收到派工，前面还有 %d 个任务在执行，排队中。", ahead)
	}
	_ = ex.report(a2a.KindAck, a2a.StateWorking, text, nil)
}

func (ex *execution) keptNote() string {
	return fmt.Sprintf("\n\n工作区已保留在本机：%s（可在该目录检查或继续修改；处理后回复本任务，平台重新派工时会复用该工作区）", ex.taskDir())
}

// fail reports a recoverable failure: the task goes to input-required.
func (ex *execution) fail(msg string, err error, keep bool) {
	text := msg
	if err != nil {
		text += "：" + clip(err.Error(), 1500)
	}
	if keep {
		text += ex.keptNote()
	}
	ex.log.Warn("task failed", "reason", msg, "err", err, "kept", keep)
	_ = ex.report(a2a.KindConclusion, a2a.StateInputRequired, text, nil)
	ex.cleanup(keep)
}

// interrupted handles cancellation by shutdown / platform / reassignment.
func (ex *execution) interrupted(ctx context.Context, keep bool) {
	cause := context.Cause(ctx)
	switch {
	case errors.Is(cause, ErrShutdown):
		text := "acp-link 已停止，任务执行被中断。"
		if keep {
			text += ex.keptNote()
		}
		_ = ex.report(a2a.KindConclusion, a2a.StateInputRequired, text, nil)
	case errors.Is(cause, ErrRevoked):
		ex.log.Warn("task revoked; agent stopped", "cause", cause)
		keep = keep || len(ex.plans) > 0
	default:
		ex.log.Info("task stopped", "cause", cause)
	}
	if keep {
		ex.log.Info("workspace kept", "path", ex.taskDir())
	}
	ex.cleanup(keep)
}

// ---- main flow ----

func (ex *execution) execute(ctx context.Context) {
	ex.log.Info("task started", "branch", ex.branch)
	detail, err := ex.d.o.API.Task(ctx, ex.ts.ID)
	if err != nil {
		if ctx.Err() != nil {
			ex.interrupted(ctx, false)
			return
		}
		ex.fail("acp-link 无法获取任务详情", err, false)
		return
	}
	if api.Terminal(detail.State) {
		ex.log.Info("task already finished, skipping", "state", detail.State)
		return
	}
	if detail.Title != "" && detail.Title != ex.ts.Title {
		ex.ts.Title = detail.Title
	}
	ex.detail = detail

	plans, problems, err := ex.planRepos(ctx)
	if err != nil {
		ex.fail("acp-link 定位仓库失败", err, false)
		return
	}
	if len(problems) > 0 {
		ex.requestRepoInput(problems)
		return
	}
	if len(plans) == 0 && detail.Type != "help" {
		ex.requestInput("任务没有指定涉及的代码仓库。请在任务里补充仓库（GitLab 项目路径，例如 group/project），然后回复本任务，平台重新派工后 acp-link 会继续。")
		return
	}

	if err := ex.prepare(ctx, plans); err != nil {
		if ctx.Err() != nil {
			ex.interrupted(ctx, true)
			return
		}
		ex.fail("acp-link 准备工作区失败", err, true)
		return
	}

	mcpPath := ex.issueToken(ctx)
	if ctx.Err() != nil {
		ex.interrupted(ctx, true)
		return
	}
	if mcpPath == "-" { // token refused: not our task any more
		ex.cleanup(false)
		return
	}
	if err := workspace.WriteContext(ex.layout.ContextFile(ex.ts.ID), workspace.ContextInput{
		Task: detail, Repos: ex.plans, AtlasEnabled: ex.atlas.HasCheck(), HasMCP: mcpPath != "",
		Reason: reasonText(ex.reason),
	}); err != nil {
		ex.fail("acp-link 写入 ACP_TASK.md 失败", err, true)
		return
	}

	out := ex.runAgent(ctx, mcpPath)
	_ = os.RemoveAll(ex.layout.PrivateDir(ex.ts.ID)) // task token no longer needed
	switch {
	case out.startErr != nil:
		ex.fail("无法启动编码 Agent（"+ex.cfg.Adapter+"）", out.startErr, true)
		return
	case errors.Is(out.cause, ErrTaskTimeout):
		ex.fail(fmt.Sprintf("Agent 执行超过 %s，已终止", ex.cfg.TaskTimeout.Duration), nil, true)
		return
	case out.cause != nil:
		ex.interrupted(ctx, true)
		return
	case out.isError || out.exitErr != nil:
		msg := "编码 Agent 异常结束"
		if out.final != "" {
			msg += "：" + clip(out.final, 1500)
		}
		ex.fail(msg, out.exitErr, true)
		return
	}

	changed, err := ex.stageChanges(ctx)
	if err != nil {
		ex.fail("检查工作区改动失败", err, true)
		return
	}
	if len(changed) == 0 {
		// A help sub-task without MRs is finished by its answer; anything
		// else needs a human to look at the conclusion.
		if detail.Type == "help" && len(detail.MergeRequests) == 0 && out.final != "" {
			_ = ex.report(a2a.KindConclusion, a2a.StateCompleted, clip(out.final, 6000), nil)
			ex.cleanup(false)
			ex.log.Info("help task answered")
			return
		}
		text := "Agent 已结束，没有产生代码改动。"
		if out.final != "" {
			text += "\n\nAgent 结论：\n" + clip(out.final, 3000)
		}
		_ = ex.report(a2a.KindConclusion, a2a.StateInputRequired, text, nil)
		ex.cleanup(false)
		ex.log.Info("task finished without changes")
		return
	}

	if ok, summary := ex.runChecks(ctx, changed); !ok {
		if ctx.Err() != nil {
			ex.interrupted(ctx, true)
			return
		}
		ex.fail("检查未通过，未推送代码\n"+summary, nil, true)
		return
	}

	arts, notes, err := ex.publish(ctx, changed)
	if err != nil {
		msg := "提交或推送失败"
		if len(notes) > 0 {
			msg += "（已完成：" + strings.Join(notes, "；") + "）"
		}
		ex.fail(msg, err, true)
		return
	}
	if len(arts) == 0 {
		text := "Agent 的改动在提交后与目标分支没有差异，未推送。"
		if out.final != "" {
			text += "\n\nAgent 结论：\n" + clip(out.final, 3000)
		}
		_ = ex.report(a2a.KindConclusion, a2a.StateInputRequired, text, nil)
		ex.cleanup(false)
		return
	}
	text := fmt.Sprintf("已推送 %d 个仓库：\n- %s", len(arts), strings.Join(notes, "\n- "))
	if out.final != "" {
		text += "\n\nAgent 总结：\n" + clip(out.final, 2500)
	}
	_ = ex.report(a2a.KindArtifact, a2a.StateWorking, text, arts)
	ex.cleanup(false)
	ex.log.Info("task published", "artifacts", len(arts))
}

func (ex *execution) requestInput(question string) {
	ex.rep.Flush(ex.rctx)
	if ex.silenced() {
		return
	}
	var last error
	for i := 0; i < 3; i++ {
		ctx, cancel := context.WithTimeout(ex.rctx, 20*time.Second)
		_, err := ex.d.o.A2A.RequestInput(ctx, ex.ts.ID, ex.d.AgentID(), question)
		cancel()
		if err == nil {
			ex.log.Info("requested input", "question", clip(question, 200))
			return
		}
		last = err
		time.Sleep(time.Duration(1<<i) * time.Second)
	}
	ex.log.Warn("request_input failed", "err", last)
}

func (ex *execution) requestRepoInput(problems []string) {
	var b strings.Builder
	b.WriteString("acp-link 无法为本任务准备工作区：\n")
	for _, p := range problems {
		b.WriteString("- " + p + "\n")
	}
	b.WriteString("\n请任务负责人在本机配置文件 ")
	b.WriteString(ex.cfg.Path)
	b.WriteString(" 的 repos 中补充本地克隆路径，例如：\nrepos:\n  - name: group/project\n    path: /path/to/local/clone\n然后回复本任务；平台重新派工后 acp-link 会读取新配置继续执行。")
	ex.requestInput(b.String())
}

// planRepos resolves every task repo to a local clone (or leaves it to Atlas).
func (ex *execution) planRepos(ctx context.Context) ([]workspace.RepoPlan, []string, error) {
	var names []string
	seen := map[string]bool{}
	add := func(n string) {
		n = workspace.NormalizeRepo(n)
		if n != "" && !seen[strings.ToLower(n)] {
			seen[strings.ToLower(n)] = true
			names = append(names, n)
		}
	}
	src := ex.detail.Repos
	if len(src) == 0 {
		src = ex.ts.Repos
	}
	for _, r := range src {
		add(r)
	}
	located := map[string]string{}
	if ex.atlas.Enabled() && strings.TrimSpace(ex.cfg.Atlas.LocateCmd) != "" {
		list, _, err := ex.atlas.Locate(ctx, atlas.Vars{
			TaskID: strconv.FormatInt(ex.ts.ID, 10), Branch: ex.branch, Repo: strings.Join(names, ","), Workspace: ex.taskDir(),
		}, ex.cfg.WorkspaceDir)
		if err != nil {
			return nil, nil, err
		}
		if len(list) > 0 {
			names, seen = nil, map[string]bool{}
			for _, l := range list {
				add(l.Name)
				if l.Path != "" {
					located[strings.ToLower(workspace.NormalizeRepo(l.Name))] = config.ExpandPath(l.Path)
				}
			}
			ex.progress("Atlas 定位到仓库：" + strings.Join(names, ", "))
		}
	}
	var (
		plans    []workspace.RepoPlan
		problems []string
	)
	dirs := workspace.RepoDirNames(names)
	for _, n := range names {
		if !workspace.ValidRepoName(n) {
			problems = append(problems, fmt.Sprintf("仓库名 %q 不合法", n))
			continue
		}
		source := located[strings.ToLower(n)]
		if source == "" {
			if r, ok := ex.cfg.FindRepo(n); ok {
				source = r.Path
			}
		}
		if source == "" {
			source = ex.searchRoots(ctx, n)
		}
		if !ex.atlas.HasPrepare() {
			if source == "" {
				problems = append(problems, fmt.Sprintf("本机没有配置仓库 %s 的本地克隆", n))
				continue
			}
			if !ex.git.IsRepo(ctx, source) {
				problems = append(problems, fmt.Sprintf("仓库 %s 配置的路径 %s 不存在或不是 git 仓库", n, source))
				continue
			}
		}
		plans = append(plans, workspace.RepoPlan{
			Name: n, Dir: dirs[n], Path: ex.layout.RepoDir(ex.ts.ID, dirs[n]), Source: source,
			Branch: ex.branch, Target: ex.cfg.TargetBranchFor(n), Checks: ex.cfg.ChecksFor(n),
		})
	}
	return plans, problems, nil
}

// searchRoots looks for <root>/<project>, <root>/<group>/<project> or
// <root>/<full/path> whose remote URL mentions the project path.
func (ex *execution) searchRoots(ctx context.Context, name string) string {
	parts := strings.Split(name, "/")
	project := parts[len(parts)-1]
	for _, root := range ex.cfg.RepoRoots {
		cands := []string{filepath.Join(root, project), filepath.Join(append([]string{root}, parts...)...)}
		if len(parts) >= 2 {
			cands = append(cands, filepath.Join(root, parts[len(parts)-2], project))
		}
		for _, c := range cands {
			if !ex.git.IsRepo(ctx, c) {
				continue
			}
			u, err := ex.git.RemoteURL(ctx, c, ex.cfg.Git.Remote)
			if err != nil {
				continue
			}
			u = strings.TrimSuffix(strings.ToLower(strings.TrimRight(u, "/")), ".git")
			if strings.HasSuffix(u, "/"+strings.ToLower(name)) || strings.HasSuffix(u, ":"+strings.ToLower(name)) {
				return c
			}
		}
	}
	return ""
}

func (ex *execution) prepare(ctx context.Context, plans []workspace.RepoPlan) error {
	dir := ex.taskDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	ex.d.setTaskState(ex.run, "running", dir)
	ex.plans = plans
	remote := ex.cfg.Git.Remote
	var notes []string
	if ex.atlas.HasPrepare() {
		tpl := ex.cfg.Atlas.PrepareCmd
		id := strconv.FormatInt(ex.ts.ID, 10)
		if atlas.PerRepo(tpl) {
			for _, p := range plans {
				if _, err := ex.atlas.Prepare(ctx, atlas.Vars{TaskID: id, Branch: ex.branch, Repo: p.Name, Workspace: p.Path}, dir); err != nil {
					return err
				}
			}
		} else {
			names := make([]string, 0, len(plans))
			for _, p := range plans {
				names = append(names, p.Name)
			}
			if _, err := ex.atlas.Prepare(ctx, atlas.Vars{TaskID: id, Branch: ex.branch, Repo: strings.Join(names, ","), Workspace: dir}, dir); err != nil {
				return err
			}
		}
		for i := range plans {
			p := &plans[i]
			if !ex.git.IsRepo(ctx, p.Path) {
				return fmt.Errorf("Atlas 准备后 %s 不是 git 工作区（prepare_cmd 应在 {workspace} 建好仓库 %s 的工作区）", p.Path, p.Name)
			}
			p.Base = remote + "/" + p.Target
			if ex.git.RefExists(ctx, p.Path, "refs/remotes/"+remote+"/"+p.Branch) {
				p.Base = remote + "/" + p.Branch
			}
			notes = append(notes, fmt.Sprintf("%s → %s（Atlas）", p.Name, p.Dir))
		}
	} else {
		for i := range plans {
			p := &plans[i]
			if err := ex.git.Fetch(ctx, p.Source, remote); err != nil {
				if ctx.Err() != nil {
					return err
				}
				if !ex.git.RefExists(ctx, p.Source, "refs/remotes/"+remote+"/"+p.Target) {
					return fmt.Errorf("git fetch %s 失败: %w", p.Name, err)
				}
				ex.progress(fmt.Sprintf("git fetch %s 失败，使用本地已有的 %s/%s 继续：%s", p.Name, remote, p.Target, clip(err.Error(), 300)))
			}
			// Re-delivery after an answer / review / CI failure: continue on the
			// task branch already pushed (or kept locally), even if the title
			// and therefore the slug changed since.
			if !ex.git.RefExists(ctx, p.Source, "refs/remotes/"+remote+"/"+p.Branch) && !ex.git.RefExists(ctx, p.Source, "refs/heads/"+p.Branch) {
				if b := ex.git.FindTaskBranch(ctx, p.Source, remote, ex.ts.ID); b != "" && b != p.Branch {
					ex.log.Info("continuing on existing task branch", "repo", p.Name, "branch", b)
					p.Branch = b
				}
			}
			wt, err := ex.git.PrepareWorktree(ctx, p.Source, p.Path, p.Branch, remote, p.Target)
			if err != nil {
				return fmt.Errorf("%s: %w", p.Name, err)
			}
			p.Base = wt.Base
			mode := map[string]string{"new": "新建分支", "remote-branch": "沿用已推送的任务分支", "local-branch": "沿用本地任务分支", "reused": "复用保留的工作区"}[wt.Mode]
			notes = append(notes, fmt.Sprintf("%s → %s（%s %s，基于 %s）", p.Name, p.Dir, mode, p.Branch, wt.Base))
		}
	}
	ex.plans = plans
	if len(notes) > 0 {
		ex.progress("工作区已就绪：\n" + strings.Join(notes, "\n"))
	}
	return nil
}

// issueToken gets the task-scoped token and writes the MCP config. It returns
// the config path, "" to run without MCP, or "-" when the platform refused.
func (ex *execution) issueToken(ctx context.Context) string {
	tok, err := ex.d.o.API.AgentToken(ctx, ex.ts.ID, ex.d.AgentID())
	if err != nil {
		if ctx.Err() != nil {
			return ""
		}
		if api.IsStatus(err, http.StatusForbidden) || api.IsStatus(err, http.StatusNotFound) || api.IsCode(err, "invalid_state") {
			ex.log.Warn("platform refused task token; task is no longer ours", "err", err)
			return "-"
		}
		ex.progress("未能获取任务令牌，Agent 将不带平台 MCP 工具运行：" + clip(err.Error(), 300))
		return ""
	}
	mcpURL := strings.TrimSpace(tok.MCPURL)
	switch {
	case mcpURL == "":
		mcpURL = ex.cfg.MCPURL()
	case strings.HasPrefix(mcpURL, "/"):
		mcpURL = ex.cfg.Server + mcpURL
	}
	path := ex.layout.MCPConfigFile(ex.ts.ID)
	if err := adapters.WriteMCPConfig(path, mcpURL, tok.Token); err != nil {
		ex.progress("写入 MCP 配置失败，Agent 将不带平台工具运行：" + err.Error())
		return ""
	}
	return path
}

type agentOutcome struct {
	final    string
	isError  bool
	exitErr  error
	startErr error
	cause    error
}

func (ex *execution) adapterOptions() adapters.Options {
	extra := map[string]string{
		"ACP_TASK_ID":   strconv.FormatInt(ex.ts.ID, 10),
		"ACP_TASK_KEY":  ex.key,
		"ACP_WORKSPACE": ex.taskDir(),
	}
	if ex.cfg.CAFile != "" && os.Getenv("NODE_EXTRA_CA_CERTS") == "" {
		extra["NODE_EXTRA_CA_CERTS"] = ex.cfg.CAFile
	}
	o := adapters.Options{SystemPrompt: workspace.SystemPrompt, Log: ex.log, Env: adapters.AgentEnv(os.Environ(), extra)}
	switch ex.cfg.Adapter {
	case config.AdapterClaude:
		o.Command, o.ExtraArgs = ex.cfg.Claude.Command, ex.cfg.Claude.ExtraArgs
	case config.AdapterCodex:
		o.Command, o.ExtraArgs, o.MCPOverrides = ex.cfg.Codex.Command, ex.cfg.Codex.ExtraArgs, ex.cfg.Codex.MCPOverrides
	}
	return o
}

func (ex *execution) runAgent(ctx context.Context, mcpPath string) agentOutcome {
	var out agentOutcome
	ad, err := ex.d.o.AdapterFactory(ex.cfg.Adapter, ex.adapterOptions())
	if err != nil {
		out.startErr = err
		return out
	}
	actx, cancel := context.WithTimeoutCause(ctx, ex.cfg.TaskTimeout.Duration, ErrTaskTimeout)
	defer cancel()
	prompt := workspace.Prompt(ex.key, ex.ts.Title)
	ch, err := ad.Start(actx, ex.taskDir(), prompt, mcpPath)
	if err != nil {
		out.startErr = err
		return out
	}
	defer func() { _ = ad.Stop() }()
	ex.log.Info("agent started", "adapter", ad.Name(), "workdir", ex.taskDir())

	rep := ex.rep
	stopWatch := ex.watchRemote(actx)

	lastText := ""
	for ev := range ch {
		switch ev.Type {
		case adapters.EventSystem:
			rep.Add(a2a.KindProgress, ev.Text)
		case adapters.EventText:
			lastText = ev.Text
			rep.Add(a2a.KindProgress, ev.Text)
		case adapters.EventTool:
			rep.Add(a2a.KindTool, ev.Text)
		case adapters.EventToolResult:
			if ev.IsError {
				rep.Add(a2a.KindTool, fmt.Sprintf("%s 出错：%s", orDefault(ev.Tool, "工具"), ev.Text))
			}
		case adapters.EventError:
			rep.Add(a2a.KindProgress, "Agent 报错："+ev.Text)
		case adapters.EventFinal:
			out.final, out.isError = strings.TrimSpace(ev.Text), ev.IsError
		case adapters.EventLog:
			ex.log.Debug("agent output", "line", clip(ev.Text, 500))
		case adapters.EventExit:
			if ev.Err != nil {
				out.exitErr = ev.Err
			} else if ev.ExitCode != 0 {
				out.exitErr = fmt.Errorf("退出码 %d", ev.ExitCode)
			}
		}
	}
	stopWatch()
	if out.final == "" {
		out.final = lastText
	}
	if actx.Err() != nil {
		out.cause = context.Cause(actx)
	}
	ex.log.Info("agent finished", "error", out.isError, "exit_err", out.exitErr, "cause", out.cause)
	return out
}

// watchRemote polls the task while the agent runs and cancels the run when
// the task was canceled or reassigned on the platform.
func (ex *execution) watchRemote(ctx context.Context) func() {
	wctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(ex.d.o.TaskPollInterval)
		defer t.Stop()
		for {
			select {
			case <-wctx.Done():
				return
			case <-t.C:
				d, err := ex.d.o.API.Task(wctx, ex.ts.ID)
				if err != nil {
					continue
				}
				if api.Terminal(d.State) {
					ex.log.Info("task ended on platform while running", "state", d.State)
					ex.run.cancel(ErrRemoteCanceled)
					return
				}
				if d.AssigneeAgent != nil && d.AssigneeAgent.ID != "" && d.AssigneeAgent.ID != ex.d.AgentID() {
					ex.log.Info("task reassigned while running", "agent", d.AssigneeAgent.Name)
					ex.run.cancel(ErrReassigned)
					return
				}
			}
		}
	}()
	return func() { cancel(); <-done }
}

// stageChanges stages all changes and returns the repos with work to publish
// (staged changes or commits ahead of their base). Staging before the checks
// keeps files produced by check commands out of the commit.
func (ex *execution) stageChanges(ctx context.Context) ([]workspace.RepoPlan, error) {
	var changed []workspace.RepoPlan
	for _, p := range ex.plans {
		if err := ex.git.StageAll(ctx, p.Path); err != nil {
			return nil, fmt.Errorf("%s: %w", p.Name, err)
		}
		staged, err := ex.git.HasStaged(ctx, p.Path)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", p.Name, err)
		}
		ahead := 0
		if ex.git.RefExists(ctx, p.Path, p.Base) {
			if ahead, err = ex.git.Ahead(ctx, p.Path, p.Base); err != nil {
				return nil, fmt.Errorf("%s: %w", p.Name, err)
			}
		}
		if staged || ahead > 0 {
			changed = append(changed, p)
		}
	}
	return changed, nil
}

func (ex *execution) runChecks(ctx context.Context, changed []workspace.RepoPlan) (bool, string) {
	timeout := ex.cfg.TaskTimeout.Duration
	if timeout > 30*time.Minute {
		timeout = 30 * time.Minute
	}
	id := strconv.FormatInt(ex.ts.ID, 10)
	var results []string
	ok := true
	record := func(label string, r atlas.Result) {
		line := label + "：" + r.Summary()
		results = append(results, line)
		ex.progress("检查 " + line)
		if !r.OK() {
			ok = false
		}
	}
	if ex.atlas.HasCheck() {
		tpl := ex.cfg.Atlas.CheckCmd
		if atlas.PerRepo(tpl) {
			for _, p := range changed {
				r, err := ex.atlas.Check(ctx, atlas.Vars{TaskID: id, Branch: p.Branch, Repo: p.Name, Workspace: p.Path}, p.Path)
				if err != nil {
					return false, err.Error()
				}
				record(p.Name, r)
			}
		} else {
			names := make([]string, 0, len(changed))
			for _, p := range changed {
				names = append(names, p.Name)
			}
			r, err := ex.atlas.Check(ctx, atlas.Vars{TaskID: id, Branch: ex.branch, Repo: strings.Join(names, ","), Workspace: ex.taskDir()}, ex.taskDir())
			if err != nil {
				return false, err.Error()
			}
			record("Atlas", r)
		}
		return ok, strings.Join(results, "\n")
	}
	for _, p := range changed {
		for _, c := range p.Checks {
			args, err := atlas.Render(c, atlas.Vars{TaskID: id, Branch: p.Branch, Repo: p.Name, Workspace: p.Path})
			if err != nil {
				return false, fmt.Sprintf("%s：检查命令 %q 无效：%v", p.Name, c, err)
			}
			record(p.Name, atlas.Run(ctx, args, p.Path, nil, timeout))
			if !ok {
				return false, strings.Join(results, "\n")
			}
		}
	}
	return ok, strings.Join(results, "\n")
}

func (ex *execution) publish(ctx context.Context, changed []workspace.RepoPlan) ([]a2a.Artifact, []string, error) {
	title := strings.Join(strings.Fields(ex.ts.Title), " ")
	commitMsg := fmt.Sprintf("%s: %s", ex.key, title)
	mrTitle := fmt.Sprintf("%s %s", ex.key, title)
	var (
		arts  []a2a.Artifact
		notes []string
	)
	for _, p := range changed {
		staged, err := ex.git.HasStaged(ctx, p.Path)
		if err != nil {
			return arts, notes, fmt.Errorf("%s: %w", p.Name, err)
		}
		if staged {
			if err := ex.git.CommitStaged(ctx, p.Path, commitMsg); err != nil {
				return arts, notes, fmt.Errorf("%s: %w", p.Name, err)
			}
		}
		if ex.git.RefExists(ctx, p.Path, p.Base) {
			if ahead, err := ex.git.Ahead(ctx, p.Path, p.Base); err == nil && ahead == 0 {
				continue
			}
		}
		res, err := ex.git.Push(ctx, p.Path, gitops.PushOptions{
			Remote: ex.cfg.Git.Remote, Branch: p.Branch, CreateMR: ex.cfg.Git.PushMREnabled(), Target: p.Target, Title: mrTitle,
		})
		if err != nil {
			return arts, notes, fmt.Errorf("%s: %w", p.Name, err)
		}
		art := a2a.Artifact{Name: p.Name + " 分支", Repo: p.Name, Branch: p.Branch}
		note := fmt.Sprintf("%s：分支 %s", p.Name, p.Branch)
		if res.MRURL != "" {
			u := res.MRURL
			art.URL = &u
			art.Name = p.Name + " MR"
			note += "，MR " + u
		} else {
			switch {
			case res.FallbackReason != "":
				note += "（" + res.FallbackReason + "）"
			case !ex.cfg.Git.PushMREnabled():
				note += "（git.push_mr=false，未创建 MR）"
			default:
				note += "（推送输出中没有 MR 链接）"
			}
		}
		ex.log.Info("pushed", "repo", p.Name, "branch", p.Branch, "mr", res.MRURL)
		arts = append(arts, art)
		notes = append(notes, note)
	}
	return arts, notes, nil
}

// cleanup removes the task token and, unless keep, the worktrees and task dir.
func (ex *execution) cleanup(keep bool) {
	_ = os.RemoveAll(ex.layout.PrivateDir(ex.ts.ID))
	if keep {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	for _, p := range ex.plans {
		if _, err := os.Stat(p.Path); err != nil {
			continue
		}
		if err := ex.git.RemoveWorktree(ctx, p.Source, p.Path); err != nil {
			ex.log.Warn("worktree remove failed", "path", p.Path, "err", err)
		}
	}
	dir := ex.taskDir()
	if _, err := os.Stat(dir); err == nil {
		if err := os.RemoveAll(dir); err != nil {
			ex.log.Warn("workspace cleanup failed", "path", dir, "err", err)
		}
	}
	for _, p := range ex.plans {
		if p.Source != "" {
			_, _ = ex.git.Run(ctx, p.Source, "worktree", "prune")
		}
	}
}

// reasonText describes why a task was (re)delivered.
func reasonText(reason string) string {
	switch reason {
	case "", "new":
		return "新派工"
	case "input_answered":
		return "负责人已回答之前的问题，答复见时间线"
	case "approval_rejected":
		return "评审未通过，请按时间线中的评审意见修改"
	case "ci_failed":
		return "CI 未通过，请根据时间线中的失败信息修复"
	case "approved_continue":
		return "审批已通过，继续执行"
	}
	return reason
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}
