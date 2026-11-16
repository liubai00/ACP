package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"acp/acp-link/internal/auth"
	"acp/acp-link/internal/config"
	"acp/acp-link/internal/runner"
)

func cmdInit(args []string, out io.Writer) error {
	fs, cfgPath := newFlags("init")
	server := fs.String("server", "", "平台地址，例如 https://acp.example.com")
	name := fs.String("agent-name", "", "本机 Agent 名称（默认主机名）")
	force := fs.Bool("force", false, "覆盖已有配置文件")
	if err := fs.Parse(args); err != nil {
		return err
	}
	path := *cfgPath
	if path == "" {
		path = config.DefaultPath()
	}
	if _, err := os.Stat(path); err == nil && !*force {
		return fmt.Errorf("%s 已存在（加 -force 覆盖）", path)
	}
	agent := *name
	if agent == "" {
		h, _ := os.Hostname()
		agent = strings.ToLower(h)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(config.Sample(strings.TrimRight(*server, "/"), agent)), 0o600); err != nil {
		return err
	}
	fmt.Fprintf(out, "已生成示例配置：%s\n\n下一步：\n  1. 编辑配置：至少填写 server、adapter 和 repos\n  2. acp-link login\n  3. acp-link doctor\n  4. acp-link run\n", path)
	return nil
}

func cmdLogin(args []string, out io.Writer) error {
	fs, cfgPath := newFlags("login")
	server := fs.String("server", "", "覆盖配置中的平台地址")
	noBrowser := fs.Bool("no-browser", false, "不自动打开浏览器")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		if !errors.Is(err, config.ErrNotFound) || *server == "" {
			return err
		}
		// No config yet: allow `acp-link login -server ...` and store next to the default config path.
		cfg = &config.Config{Server: *server}
		if *cfgPath != "" {
			cfg.Home = filepath.Dir(*cfgPath)
		}
		cfg.ApplyDefaults()
		if err := cfg.Validate(); err != nil {
			return err
		}
	}
	if *server != "" {
		cfg.Server = strings.TrimRight(*server, "/")
	}
	c, err := newClients(cfg, false, slog.Default())
	if err != nil {
		return err
	}
	host, _ := os.Hostname()
	opts := auth.DeviceLoginOptions{Hostname: host, Out: out}
	if !*noBrowser {
		opts.OpenBrowser = auth.OpenBrowser
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	fmt.Fprintf(out, "登录平台 %s …\n", cfg.Server)
	creds, err := auth.DeviceLogin(ctx, c.api, opts)
	if err != nil {
		return err
	}
	if err := creds.Save(cfg.CredentialsPath()); err != nil {
		return fmt.Errorf("保存令牌失败: %w", err)
	}
	fmt.Fprintf(out, "\n登录成功：%s，令牌有效期至 %s\n令牌已保存到 %s（仅本人可读）\n",
		creds.MemberName, creds.ExpiresAt.Local().Format("2006-01-02 15:04"), cfg.CredentialsPath())
	return nil
}

func cmdRun(args []string) error {
	fs, cfgPath := newFlags("run")
	adapter := fs.String("adapter", "", "临时覆盖适配器（claude-code | codex | echo）")
	verbose := fs.Bool("v", false, "输出 debug 日志")
	force := fs.Bool("force", false, "即使检测到另一个 acp-link run 也启动")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}
	if *adapter != "" {
		cfg.Adapter = *adapter
		if err := cfg.Validate(); err != nil {
			return err
		}
	}
	if !*force {
		if st, err := runner.ReadState(cfg.StatePath()); err == nil && st.Running && st.PID != os.Getpid() &&
			time.Since(st.UpdatedAt) < 90*time.Second && processAlive(st.PID) {
			return fmt.Errorf("另一个 acp-link run 正在运行（pid %d）；如确认没有，加 -force 启动", st.PID)
		}
	}
	level := parseLevel(cfg.Log.Level)
	if *verbose {
		level = slog.LevelDebug
	}
	lf, err := newRotatingFile(filepath.Join(cfg.LogDir(), "acp-link.log"), int64(cfg.Log.MaxSizeMB)<<20, cfg.Log.MaxBackups)
	if err != nil {
		return fmt.Errorf("无法打开日志文件: %w", err)
	}
	defer lf.Close()
	log := newLogger(level, lf)
	slog.SetDefault(log)
	for _, w := range cfg.Warnings {
		log.Warn("config", "warning", w)
	}
	c, err := newClients(cfg, true, log)
	if err != nil {
		return err
	}
	if c.tokens.Expired(time.Now()) {
		return errors.New("登录已过期，请重新运行 acp-link login")
	}
	path := cfg.Path
	d, err := runner.New(runner.Options{
		Config: cfg, Tokens: c.tokens, API: c.api, A2A: c.a2a, Log: log,
		ConfigReload: func() (*config.Config, error) {
			nc, err := config.Load(path)
			if err == nil && *adapter != "" {
				nc.Adapter = *adapter
			}
			return nc, err
		},
	})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sig := make(chan os.Signal, 2)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		s := <-sig
		log.Info("signal received, shutting down (press Ctrl+C again to force)", "signal", s.String())
		cancel()
		<-sig
		log.Warn("forced exit")
		os.Exit(130)
	}()
	return d.Run(ctx)
}

func cmdStatus(args []string, out io.Writer) error {
	fs, cfgPath := newFlags("status")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "配置      %s\n平台      %s\nAgent     %s（适配器 %s，并发 %d）\n", cfg.Path, cfg.Server, cfg.AgentName, cfg.Adapter, cfg.MaxConcurrency)
	creds, err := auth.LoadCredentials(cfg.CredentialsPath())
	switch {
	case err != nil:
		fmt.Fprintf(out, "登录      未登录（%v）\n", err)
	default:
		left := time.Until(creds.ExpiresAt)
		state := fmt.Sprintf("剩余 %s", left.Round(time.Minute))
		if left <= 0 {
			state = "已过期，请重新 acp-link login"
		}
		fmt.Fprintf(out, "登录      %s，令牌至 %s（%s）\n", orDash(creds.MemberName), creds.ExpiresAt.Local().Format("2006-01-02 15:04"), state)
	}
	st, serr := runner.ReadState(cfg.StatePath())
	switch {
	case serr != nil:
		fmt.Fprintln(out, "守护进程  未运行过（没有 state.json）")
	case !st.Running || time.Since(st.UpdatedAt) > 90*time.Second || !processAlive(st.PID):
		fmt.Fprintf(out, "守护进程  未运行（最后更新 %s）\n", st.UpdatedAt.Local().Format("2006-01-02 15:04:05"))
	default:
		conn := "已连接"
		if !st.Connected {
			conn = "未连接（重连中）"
		}
		hb := "-"
		if st.LastHeartbeatAt != nil {
			hb = st.LastHeartbeatAt.Local().Format("15:04:05")
		}
		fmt.Fprintf(out, "守护进程  运行中 pid %d，版本 %s，订阅%s，最近心跳 %s\n", st.PID, st.Version, conn, hb)
		if len(st.Tasks) == 0 {
			fmt.Fprintln(out, "任务      空闲")
		}
		for _, t := range st.Tasks {
			fmt.Fprintf(out, "任务      %s %s [%s] 已运行 %s %s\n", t.Key, t.Title, t.State, time.Since(t.StartedAt).Round(time.Second), t.Workspace)
		}
	}
	if err == nil {
		c, cerr := newClients(cfg, true, slog.Default())
		if cerr != nil {
			fmt.Fprintf(out, "平台状态  %v\n", cerr)
			return nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		agents, aerr := c.api.Agents(ctx)
		if aerr != nil {
			fmt.Fprintf(out, "平台状态  查询失败：%v\n", aerr)
			return nil
		}
		found := false
		for _, a := range agents {
			if (st != nil && a.ID == st.AgentID) || (a.Member.ID == creds.MemberID && strings.EqualFold(a.Name, cfg.AgentName)) {
				hb := "-"
				if a.LastHeartbeatAt != nil {
					hb = *a.LastHeartbeatAt
				}
				fmt.Fprintf(out, "平台状态  %s（%s），最近心跳 %s，当前任务 %v\n", a.Status, a.ID, hb, a.CurrentTaskIDs)
				found = true
				break
			}
		}
		if !found {
			fmt.Fprintln(out, "平台状态  平台上还没有本机 Agent（运行 acp-link run 后注册）")
		}
	}
	return nil
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
