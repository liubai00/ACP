// Command acp-link is the ACP access program that runs on each developer's
// computer: it subscribes to task assignments over one outbound connection,
// runs the developer's own coding agent headlessly in an isolated workspace,
// streams progress back, pushes a branch and opens a GitLab merge request.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"

	"acp/acp-link/internal/a2a"
	"acp/acp-link/internal/api"
	"acp/acp-link/internal/auth"
	"acp/acp-link/internal/config"
	"acp/acp-link/internal/version"
)

const usage = `acp-link — ACP 多 Agent 协作平台接入程序

用法：
  acp-link <命令> [参数]

命令：
  init         生成带注释的示例配置（~/.acp-link/config.yaml）
  login        设备授权登录（浏览器确认），保存令牌
  run          前台运行守护进程：注册、订阅派工、执行任务
  status       查看登录、守护进程和平台上的 Agent 状态
  doctor       检查配置、网络、SSE 长连接、git 与 Agent 命令
  mcp-config   打印手动接入平台 MCP 工具的配置片段（claude | codex）
  version      显示版本

通用参数：
  -config <路径>   配置文件（默认 ~/.acp-link/config.yaml，或环境变量 ACP_LINK_CONFIG）

运行 acp-link <命令> -h 查看各命令参数。
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	cmd, rest := args[0], args[1:]
	var err error
	switch cmd {
	case "init":
		err = cmdInit(rest, stdout)
	case "login":
		err = cmdLogin(rest, stdout)
	case "run":
		err = cmdRun(rest)
	case "status":
		err = cmdStatus(rest, stdout)
	case "doctor":
		var failed bool
		failed, err = cmdDoctor(rest, stdout)
		if err == nil && failed {
			return 1
		}
	case "mcp-config":
		err = cmdMCPConfig(rest, stdout, stderr)
	case "version", "-v", "--version":
		fmt.Fprintln(stdout, version.String())
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usage)
	default:
		fmt.Fprintf(stderr, "未知命令 %q\n\n%s", cmd, usage)
		return 2
	}
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		fmt.Fprintf(stderr, "acp-link %s: %v\n", cmd, err)
		return 1
	}
	return 0
}

// newFlags creates a FlagSet with the common -config flag.
func newFlags(name string) (*flag.FlagSet, *string) {
	fs := flag.NewFlagSet("acp-link "+name, flag.ContinueOnError)
	cfgPath := fs.String("config", "", "配置文件路径（默认 ~/.acp-link/config.yaml）")
	return fs, cfgPath
}

// clients bundles what most commands need.
type clients struct {
	cfg    *config.Config
	tokens *auth.Manager
	api    *api.Client
	a2a    *a2a.Client
}

// newClients builds HTTP clients; withAuth loads the stored credentials.
func newClients(cfg *config.Config, withAuth bool, log *slog.Logger) (*clients, error) {
	rt, err := api.NewTransport(api.TransportOptions{Proxy: cfg.Proxy, CAFile: cfg.CAFile})
	if err != nil {
		return nil, err
	}
	c := &clients{cfg: cfg}
	var tp api.TokenProvider
	if withAuth {
		m, err := auth.NewManager(cfg.CredentialsPath(), log)
		if err != nil {
			return nil, err
		}
		if err := m.CheckServer(cfg.Server); err != nil {
			return nil, err
		}
		c.tokens, tp = m, m
	}
	c.api = api.New(cfg.Server, rt, tp)
	if c.tokens != nil {
		c.tokens.Bind(c.api)
	}
	c.a2a = a2a.New(c.api)
	return c, nil
}

func loadConfig(path string) (*config.Config, error) {
	cfg, err := config.Load(path)
	if err != nil {
		return nil, err
	}
	return cfg, nil
}

func indent(s, prefix string) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	for i, l := range lines {
		lines[i] = prefix + l
	}
	return strings.Join(lines, "\n")
}
