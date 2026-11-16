package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"time"

	"acp/acp-link/internal/adapters"
	"acp/acp-link/internal/api"
	"acp/acp-link/internal/auth"
	"acp/acp-link/internal/config"
)

// PersonalTokenDays is the lifetime requested for the mcp-config token.
const PersonalTokenDays = 90

// cmdMCPConfig prints a snippet for the "light" integration: the developer
// adds the platform MCP server to their own Claude Code / Codex and uses the
// tools manually. It mints a revocable 90-day personal access token
// (POST /api/me/tokens) so the setup does not break when the 7-day member
// token rotates; if that fails it falls back to the member token.
func cmdMCPConfig(args []string, out, errOut io.Writer) error {
	fs, cfgPath := newFlags("mcp-config")
	placeholder := fs.Bool("placeholder", false, "用 <TOKEN> 占位，不创建也不输出真实令牌")
	// Accept the target before or after flags.
	target := "claude"
	if len(args) > 0 && len(args[0]) > 0 && args[0][0] != '-' {
		target, args = args[0], args[1:]
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		target = fs.Arg(0)
	}
	switch target {
	case "claude", "claude-code", "codex":
	default:
		return fmt.Errorf("未知目标 %q（可选 claude | codex）", target)
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}

	url := cfg.MCPURL()
	token := "<TOKEN>"
	var notes []string
	if !*placeholder {
		creds, err := auth.LoadCredentials(cfg.CredentialsPath())
		if err != nil {
			return err
		}
		if time.Now().After(creds.ExpiresAt) {
			return fmt.Errorf("登录已过期，请先运行 acp-link login")
		}
		pat, perr := createPersonalToken(cfg)
		if perr == nil {
			token = pat.Token
			if u := strings.TrimSpace(pat.MCPURL); u != "" {
				if strings.HasPrefix(u, "/") {
					u = cfg.Server + u
				}
				url = u
			}
			exp := pat.ExpiresAt
			if t, err := time.Parse(time.RFC3339, exp); err == nil {
				exp = t.Local().Format("2006-01-02 15:04")
			}
			notes = append(notes,
				fmt.Sprintf("上面是新建的个人访问令牌（id %s，有效期至 %s）。不要提交到代码仓库或发给别人。", pat.ID, exp),
				"在平台上查看：GET /api/me/tokens；不用了或泄露时撤销：DELETE /api/me/tokens/"+string(pat.ID)+"。")
		} else {
			token = creds.AccessToken
			fmt.Fprintf(errOut, "警告：无法创建个人访问令牌（%v），改用登录令牌。\n", perr)
			notes = append(notes, fmt.Sprintf("上面是你的登录令牌，有效期至 %s，过期后要重新 acp-link login 并再次运行本命令。不要提交到代码仓库或发给别人。",
				creds.ExpiresAt.Local().Format("2006-01-02 15:04")))
		}
	}

	switch target {
	case "claude", "claude-code":
		cfgJSON, _ := json.MarshalIndent(adapters.BuildMCPConfig(url, token), "", "  ")
		fmt.Fprintf(out, "# Claude Code：用 claude 命令添加（加 --scope user 则所有项目可用）\n")
		fmt.Fprintf(out, "claude mcp add --transport http %s %s --header \"Authorization: Bearer %s\"\n\n", adapters.MCPServerName, url, token)
		fmt.Fprintf(out, "# 或写入项目根目录的 .mcp.json（不要提交令牌），也可用 claude --mcp-config <文件>\n%s\n", cfgJSON)
	case "codex":
		fmt.Fprintf(out, "# Codex：写入 ~/.codex/config.toml（较旧版本需在顶层另加 experimental_use_rmcp_client = true）\n[mcp_servers.%s]\nurl = %q\nbearer_token_env_var = \"ACP_TOKEN\"\n\n", adapters.MCPServerName, url)
		fmt.Fprintf(out, "# 然后在启动 codex 的环境里设置令牌：\n# macOS / Linux（可写进 ~/.zshrc）:\nexport ACP_TOKEN=%s\n# Windows PowerShell（当前会话）:\n$env:ACP_TOKEN = \"%s\"\n# Windows 用户级永久设置:\nsetx ACP_TOKEN %s\n", token, token, token)
	}
	if len(notes) > 0 {
		fmt.Fprintln(errOut)
		for _, n := range notes {
			fmt.Fprintln(errOut, "注意："+n)
		}
	}
	fmt.Fprintln(errOut, "提示：平台工具经网关聚合后可能带前缀，按后缀匹配工具名（如 *get_task）。")
	return nil
}

func createPersonalToken(cfg *config.Config) (*api.PersonalToken, error) {
	c, err := newClients(cfg, true, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		return nil, err
	}
	host, _ := os.Hostname()
	if host == "" {
		host = cfg.AgentName
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return c.api.CreatePersonalToken(ctx, "acp-link mcp-config "+host, PersonalTokenDays)
}
