package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"acp/acp-link/internal/a2a"
	"acp/acp-link/internal/adapters"
	"acp/acp-link/internal/api"
	"acp/acp-link/internal/atlas"
	"acp/acp-link/internal/auth"
	"acp/acp-link/internal/config"
	"acp/acp-link/internal/gitops"
)

type doctor struct {
	out    io.Writer
	failed bool
	warned bool
}

func (d *doctor) ok(name, detail string) { fmt.Fprintf(d.out, "[ OK ] %-12s %s\n", name, detail) }
func (d *doctor) warn(name, detail string) {
	d.warned = true
	fmt.Fprintf(d.out, "[WARN] %-12s %s\n", name, detail)
}
func (d *doctor) fail(name, detail string) {
	d.failed = true
	fmt.Fprintf(d.out, "[FAIL] %-12s %s\n", name, detail)
}

// SSEMinOpen is how long the ping stream must stay open (server pings every 30s).
const SSEMinOpen = 35 * time.Second

func cmdDoctor(args []string, out io.Writer) (bool, error) {
	fs, cfgPath := newFlags("doctor")
	quick := fs.Bool("quick", false, "跳过约 35 秒的 SSE 长连接测试")
	if err := fs.Parse(args); err != nil {
		return false, err
	}
	d := &doctor{out: out}
	ctx := context.Background()

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		d.fail("配置", err.Error())
		return true, nil
	}
	d.ok("配置", fmt.Sprintf("%s（server %s，adapter %s，%d 个仓库）", cfg.Path, cfg.Server, cfg.Adapter, len(cfg.Repos)))
	for _, w := range cfg.Warnings {
		d.warn("配置", w)
	}

	// Workspace dir writable.
	if err := os.MkdirAll(cfg.WorkspaceDir, 0o755); err != nil {
		d.fail("工作区", err.Error())
	} else if f, err := os.CreateTemp(cfg.WorkspaceDir, ".doctor-*"); err != nil {
		d.fail("工作区", "不可写："+err.Error())
	} else {
		f.Close()
		os.Remove(f.Name())
		d.ok("工作区", cfg.WorkspaceDir)
	}

	// Proxy / CA.
	if p, err := api.EffectiveProxy(cfg.Proxy, cfg.Server); err != nil {
		d.fail("代理", err.Error())
	} else {
		src := "环境变量 HTTPS_PROXY/HTTP_PROXY"
		if cfg.Proxy != "" {
			src = "配置 proxy"
		}
		noProxy := firstNonEmpty(os.Getenv("NO_PROXY"), os.Getenv("no_proxy"))
		if p == "" {
			d.ok("代理", fmt.Sprintf("直连 %s（NO_PROXY=%s）", cfg.Server, orDash(noProxy)))
		} else {
			d.ok("代理", fmt.Sprintf("经 %s 访问平台（来源：%s；NO_PROXY=%s）", p, src, orDash(noProxy)))
		}
	}
	if cfg.CAFile != "" {
		if _, err := api.LoadCAPool(cfg.CAFile); err != nil {
			d.fail("CA 证书", err.Error())
		} else {
			d.ok("CA 证书", cfg.CAFile)
		}
	}

	c, cerr := newClients(cfg, false, slog.Default())
	if cerr != nil {
		d.fail("网络", cerr.Error())
		return true, nil
	}

	// Server reachable.
	hctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	h, date, err := c.api.Healthz(hctx)
	cancel()
	if err != nil {
		d.fail("平台", fmt.Sprintf("%s/healthz 不可达：%v%s", cfg.Server, err, tlsHint(err)))
	} else {
		detail := fmt.Sprintf("%s/healthz status=%s version=%s db=%s", cfg.Server, h.Status, h.Version, h.DB)
		if h.Status != "ok" || (h.DB != "" && h.DB != "ok") {
			d.warn("平台", detail)
		} else {
			d.ok("平台", detail)
		}
		if !date.IsZero() {
			if skew := time.Since(date); skew > 2*time.Minute || skew < -2*time.Minute {
				d.warn("时钟", fmt.Sprintf("本机时间与服务器相差 %s，令牌校验可能失败，请同步系统时间", skew.Round(time.Second)))
			}
		}
	}

	// Token.
	creds, err := auth.LoadCredentials(cfg.CredentialsPath())
	switch {
	case err != nil:
		d.fail("登录", err.Error())
	case !strings.EqualFold(strings.TrimRight(creds.Server, "/"), cfg.Server):
		d.fail("登录", fmt.Sprintf("令牌属于 %s，与配置的 server 不一致，请重新 acp-link login", creds.Server))
	case time.Now().After(creds.ExpiresAt):
		d.fail("登录", "令牌已过期，请重新 acp-link login")
	default:
		ac, _ := newClients(cfg, true, slog.Default())
		mctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		me, err := ac.api.Me(mctx)
		cancel()
		left := time.Until(creds.ExpiresAt).Round(time.Minute)
		switch {
		case err != nil && api.IsUnauthorized(err):
			d.fail("登录", "平台拒绝了令牌（可能已吊销或服务器换了密钥），请重新 acp-link login")
		case err != nil:
			d.warn("登录", fmt.Sprintf("令牌未过期（剩余 %s），但 /api/me 调用失败：%v", left, err))
		default:
			msg := fmt.Sprintf("%s，角色 %s，剩余 %s", me.Name, strings.Join(me.Roles, ","), left)
			if left < 24*time.Hour {
				d.warn("登录", msg+"（不足 24 小时，acp-link run 会自动刷新）")
			} else {
				d.ok("登录", msg)
			}
		}
	}

	// SSE long-lived connection.
	if *quick {
		d.warn("SSE", "已跳过（-quick）")
	} else {
		fmt.Fprintf(out, "       %-12s 测试 /api/ping/stream 长连接，约 %d 秒…\n", "SSE", int(SSEMinOpen.Seconds()))
		checkSSE(ctx, d, c.api)
	}

	// git.
	g := gitops.New()
	if v, err := g.Version(ctx); err != nil {
		d.fail("git", "未找到 git："+err.Error())
	} else {
		d.ok("git", v)
		name, email := g.Identity(ctx, "")
		if name == "" || email == "" {
			d.fail("git 身份", "未配置 user.name / user.email（提交会失败）：git config --global user.name ... && git config --global user.email ...")
		} else {
			d.ok("git 身份", fmt.Sprintf("%s <%s>", name, email))
		}
	}
	for _, r := range cfg.Repos {
		label := "仓库"
		switch {
		case !g.IsRepo(ctx, r.Path):
			d.fail(label, fmt.Sprintf("%s → %s 不存在或不是 git 仓库", r.Name, r.Path))
			continue
		}
		u, err := g.RemoteURL(ctx, r.Path, cfg.Git.Remote)
		if err != nil {
			d.fail(label, fmt.Sprintf("%s → %s 没有 remote %q", r.Name, r.Path, cfg.Git.Remote))
			continue
		}
		target := cfg.Git.Remote + "/" + cfg.TargetBranchFor(r.Name)
		if !g.RefExists(ctx, r.Path, "refs/remotes/"+target) {
			d.warn(label, fmt.Sprintf("%s → %s 本地还没有 %s（先 git fetch）", r.Name, r.Path, target))
			continue
		}
		if !strings.Contains(strings.ToLower(u), strings.ToLower(r.Name)) {
			d.warn(label, fmt.Sprintf("%s → %s 的 remote %s 与项目路径不一致，确认配置是否正确", r.Name, r.Path, redactRemote(u)))
			continue
		}
		d.ok(label, fmt.Sprintf("%s → %s（%s）", r.Name, r.Path, target))
	}

	// Adapter CLI.
	checkAdapter(ctx, d, cfg)

	// Atlas.
	if cfg.Atlas.Enabled {
		for name, tpl := range map[string]string{"locate_cmd": cfg.Atlas.LocateCmd, "prepare_cmd": cfg.Atlas.PrepareCmd, "check_cmd": cfg.Atlas.CheckCmd} {
			if strings.TrimSpace(tpl) == "" {
				continue
			}
			args, err := atlas.Split(tpl)
			if err != nil || len(args) == 0 {
				d.fail("Atlas", fmt.Sprintf("%s 无法解析：%v", name, err))
				continue
			}
			if _, err := exec.LookPath(args[0]); err != nil {
				d.fail("Atlas", fmt.Sprintf("%s 的命令 %s 找不到", name, args[0]))
				continue
			}
			d.ok("Atlas", fmt.Sprintf("%s：%s", name, tpl))
		}
	}

	fmt.Fprintln(out)
	switch {
	case d.failed:
		fmt.Fprintln(out, "有检查未通过，请按 [FAIL] 行提示处理后重新运行 acp-link doctor。")
	case d.warned:
		fmt.Fprintln(out, "基本可用，[WARN] 行建议处理。")
	default:
		fmt.Fprintln(out, "全部通过，可以运行 acp-link run。")
	}
	return d.failed, nil
}

func checkSSE(ctx context.Context, d *doctor, c *api.Client) {
	sctx, cancel := context.WithTimeout(ctx, SSEMinOpen+10*time.Second)
	defer cancel()
	req, err := c.NewRequest(sctx, http.MethodGet, "/api/ping/stream", nil, false)
	if err != nil {
		d.fail("SSE", err.Error())
		return
	}
	req.Header.Set("Accept", "text/event-stream")
	start := time.Now()
	resp, err := c.Stream.Do(req)
	if err != nil {
		d.fail("SSE", "连接失败："+err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		d.fail("SSE", fmt.Sprintf("HTTP %d", resp.StatusCode))
		return
	}
	pings := 0
	var firstPing time.Duration
	done := make(chan error, 1)
	go func() {
		done <- a2a.ReadSSE(resp.Body, func(ev a2a.SSEEvent) error {
			pings++
			if pings == 1 {
				firstPing = time.Since(start)
			}
			return nil
		}, nil)
	}()
	timer := time.NewTimer(SSEMinOpen)
	defer timer.Stop()
	select {
	case err := <-done:
		open := time.Since(start).Round(time.Second)
		reason := "服务端或中间代理关闭了连接"
		if err != nil {
			reason = err.Error()
		}
		d.fail("SSE", fmt.Sprintf("连接在 %s 后被断开（%s）：检查代理/网关的空闲超时（需 ≥90 秒）和响应缓冲设置", open, reason))
	case <-timer.C:
		cancel()
		if pings == 0 {
			d.warn("SSE", fmt.Sprintf("连接保持了 %s，但没收到 ping：中间代理可能在缓冲响应体", SSEMinOpen))
		} else {
			d.ok("SSE", fmt.Sprintf("连接保持 ≥%s，收到 %d 个事件（首个 %s）", SSEMinOpen, pings, firstPing.Round(time.Second)))
		}
	}
}

func checkAdapter(ctx context.Context, d *doctor, cfg *config.Config) {
	var cmd string
	switch cfg.Adapter {
	case config.AdapterEcho:
		if err := echoSelfTest(ctx); err != nil {
			d.fail("Agent", "echo 适配器自检失败："+err.Error())
		} else {
			d.ok("Agent", "echo 适配器自检通过（不调用模型）")
		}
		return
	case config.AdapterClaude:
		cmd = cfg.Claude.Command
	case config.AdapterCodex:
		cmd = cfg.Codex.Command
	}
	path, err := exec.LookPath(cmd)
	if err != nil {
		d.fail("Agent", fmt.Sprintf("找不到 %s 命令 %q：确认已安装并在 PATH 中（服务方式运行时 PATH 可能不同）", cfg.Adapter, cmd))
		return
	}
	vctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(vctx, path, "--version").CombinedOutput()
	v := strings.TrimSpace(firstLine(string(out)))
	if err != nil {
		d.warn("Agent", fmt.Sprintf("%s --version 失败：%v %s", path, err, v))
		return
	}
	d.ok("Agent", fmt.Sprintf("%s %s（%s）", cfg.Adapter, v, path))
	if cfg.Adapter == config.AdapterCodex && len(cfg.Codex.MCPOverrides) == 0 {
		d.warn("Agent", "未配置 codex.mcp_overrides：Codex 将不带平台 MCP 工具运行")
	}
	if cfg.Adapter == config.AdapterClaude && !hasAllowedTools(cfg.Claude.ExtraArgs) {
		d.warn("Agent", "claude 无头模式默认只放行文件编辑，Bash 命令（如跑测试）会被拒绝；需要时在 claude.extra_args 加 --allowedTools，见 README")
	}
}

func hasAllowedTools(args []string) bool {
	for _, a := range args {
		if strings.HasPrefix(a, "--allowedTools") || strings.HasPrefix(a, "--allowed-tools") || strings.Contains(a, "bypassPermissions") {
			return true
		}
	}
	return false
}

// echoSelfTest runs the echo adapter against a throwaway directory.
func echoSelfTest(ctx context.Context) error {
	dir, err := os.MkdirTemp("", "acp-link-doctor-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	if err := os.MkdirAll(filepath.Join(dir, "demo", ".git"), 0o755); err != nil {
		return err
	}
	ad, err := adapters.New("echo", adapters.Options{})
	if err != nil {
		return err
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	ch, err := ad.Start(cctx, dir, "doctor self-test", "")
	if err != nil {
		return err
	}
	var final string
	var exitErr error
	for ev := range ch {
		switch ev.Type {
		case adapters.EventFinal:
			final = ev.Text
		case adapters.EventExit:
			exitErr = ev.Err
		}
	}
	if exitErr != nil {
		return exitErr
	}
	if _, err := os.Stat(filepath.Join(dir, "demo", adapters.EchoFile)); err != nil {
		return errors.New("回显文件没有写入")
	}
	if final == "" {
		return errors.New("没有收到最终结论事件")
	}
	return nil
}

func tlsHint(err error) string {
	s := err.Error()
	switch {
	case strings.Contains(s, "x509") || strings.Contains(s, "certificate"):
		return "（证书校验失败：公司网络可能做了 TLS 解密，在配置里设置 ca_file 指向公司根证书，或让网管把平台域名加入免解密名单）"
	case strings.Contains(s, "proxyconnect"):
		return "（代理连接失败：检查 proxy / HTTPS_PROXY 设置）"
	}
	return ""
}

func redactRemote(u string) string {
	if i := strings.Index(u, "@"); i > 0 && strings.Contains(u[:i], "://") {
		return u[:strings.Index(u, "://")+3] + "***" + u[i:]
	}
	return u
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
