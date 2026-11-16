package config

import "strings"

// sampleTemplate is written by `acp-link init`. Every key is documented; the
// file must stay parseable (see TestSampleParses).
const sampleTemplate = `# acp-link 配置文件（YAML）
# 位置：~/.acp-link/config.yaml（Windows：%USERPROFILE%\.acp-link\config.yaml）
# 改完运行 acp-link doctor 检查。

# 平台地址：域名或 IP，http 或 https，不带结尾斜杠
server: {{SERVER}}

# 本机 Agent 名称；同一成员同名视为同一个 Agent（重装后保持不变即可）
agent_name: {{AGENT_NAME}}

# 使用哪个编码 Agent：claude-code | codex | echo（echo 为回显测试适配器，不调模型）
adapter: claude-code

# 技能标签，平台据此派工和匹配求助
skills:
  - backend
  # - frontend
  # - harmonyos

# 本机能处理的 GitLab 项目（group/project）和本地克隆路径
# 每个任务会在 workspace_dir 下用 git worktree 建隔离工作区，不会动你的原始工作目录
repos:
  - name: group/project
    path: ~/code/project
    # target_branch: main        # 可选，覆盖 git.target_branch
    # checks:                    # 可选，Agent 结束后在该仓库工作区运行的检查命令
    #   - go test ./...

# 可选：未在 repos 中列出的仓库，到这些目录下按 <根>/<project> 或 <根>/<group>/<project> 查找，
# 并校验 remote 地址包含 group/project
# repo_roots:
#   - ~/code

# 任务工作区根目录（每个任务一个子目录 <id>/<仓库名>）
workspace_dir: ~/.acp-link/workspaces

# 同时执行的任务数，默认 1，最大 3
max_concurrency: 1

# 单个任务超时，超时会终止 Agent，任务转为待补充（input-required）
task_timeout: 60m

# 是否自动接受来自本团队的求助子任务（由平台据此决定是否直接派给你）
auto_accept_help: false

# 可选：HTTP 代理。不填则读取 HTTPS_PROXY / HTTP_PROXY；NO_PROXY 始终生效
# proxy: http://127.0.0.1:7890

# 可选：额外信任的 CA 证书（PEM），用于公司 TLS 解密网关
# ca_file: ~/certs/corp-root.pem

# Claude Code 适配器
claude:
  command: claude
  # 追加参数。无头模式下默认 --permission-mode acceptEdits：可改文件，但 Bash 命令默认被拒绝，
  # 需要跑测试时按需放行，例如：
  # extra_args: ["--allowedTools", "Bash(npm test:*)", "Bash(go test:*)"]
  extra_args: []

# Codex 适配器
codex:
  command: codex
  # 默认 --full-auto（工作区内可写、按需执行命令）
  extra_args: ["--full-auto"]
  # 可选：通过 -c 覆盖项把平台 MCP 注入 Codex；{mcp_url} 会替换为任务 MCP 地址，
  # 任务令牌通过环境变量 ACP_TASK_TOKEN 提供。不配置则 Codex 不带平台工具运行（会有警告）。
  # mcp_overrides:
  #   - mcp_servers.acp.url="{mcp_url}"
  #   - mcp_servers.acp.bearer_token_env_var="ACP_TASK_TOKEN"

# Atlas（团队多仓库工具）。命令模板支持占位符 {task_id} {branch} {repo} {workspace}。
# 命令不经过 shell 直接执行；需要管道或 && 时写成 sh -c "..." 或 cmd /c "..."。
# 模板里含 {repo} 的命令按仓库逐个执行，否则整个任务执行一次。
atlas:
  enabled: false
  # 输出每行一个仓库：group/project [本地路径]
  locate_cmd: ""
  # 执行后 {workspace} 目录应是该仓库在任务分支 {branch} 上的工作区
  prepare_cmd: ""
  # 退出码非 0 视为检查失败
  check_cmd: ""

# 可选：按仓库配置检查命令（Atlas 未启用时使用），与 repos[].checks 合并
# checks:
#   group/project:
#     - npm test

git:
  remote: origin
  target_branch: main
  # 推送时用 GitLab push options 自动创建 MR
  push_mr: true

log:
  level: info        # debug | info | warn | error
  max_size_mb: 10
  max_backups: 3
`

// Sample renders the commented sample configuration.
func Sample(server, agentName string) string {
	if server == "" {
		server = "https://acp.example.com"
	}
	if agentName == "" {
		agentName = "my-laptop"
	}
	r := strings.NewReplacer("{{SERVER}}", server, "{{AGENT_NAME}}", agentName)
	return r.Replace(sampleTemplate)
}
