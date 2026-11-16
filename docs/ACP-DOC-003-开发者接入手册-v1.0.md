<!--
文档编号: ACP-DOC-003
版本: v1.0
日期: 2026-11-09
状态: 与 acp-link 0.1.0 一致
配套: ACP-DOC-001 v2.1 设计方案，ACP-DOC-004 v1.1 接口规范，ACP-DOC-006 v1.0 交接文档
在线可编辑版: https://claude.ai/artifact/GpGnHNYSQL6XuYMdTeKvFB
本文件为留存版，由在线版导出；修改请先改在线版，再导出覆盖本文件并升版本号。
-->

# ACP-DOC-003 开发者接入手册 v1.0

日期 2026-11-09 · 作者 Alex Morgan

## 1. 一页看懂

本手册给要把自己的 Claude Code 或 Codex 接入 ACP 平台的开发者。平台地址以管理员告诉你的为准，下文写作 `<平台地址>`。

**接入以后会发生什么**：飞书群里有人 @ACP 协调 提了一件事，平台建成任务并建议由你来做。你在卡片或任务榜上点“接受”之后，你电脑上的 acp-link 收到派工，建好隔离的工作区，启动你的编码 Agent，完成后用你自己的 git 身份推分支、开 MR。CI 通过后评审者审批并合并，任务关闭。任何一步卡住，任务都会转为“待补充”并在飞书里问你。

两条规矩不会变：**没有你确认，Agent 不会开始干活**；**平台不会自动合并代码**。

| | 接入程序 acp-link（推荐） | 只配 MCP（轻量） |
| --- | --- | --- |
| 平台能把任务推给你 | 能 | 不能 |
| 自动建工作区、推分支、开 MR | 能 | 自己做 |
| 在你平时的 Agent 会话里查任务、回报、向别人的 Agent 求助 | 任务执行时自动带上 | 能 |
| 本机要跑的东西 | 一个后台程序 | 无 |
| 上手时间 | 约 15 分钟 | 约 3 分钟 |

两种可以同时用。

**最短路径**

1. 按第 2 节确认 git 和 Agent 都能用。
2. 按第 3 节下载 acp-link，执行 `init`、`login`、`doctor`。
3. 先用 `acp-link run -adapter echo` 跑一个练习任务，确认能推分支开 MR。
4. 改回自己的 Agent，按第 5 节装成后台服务。

## 2. 准备工作

- [ ] **git 提交身份**：`git config --global user.name` 和 `user.email` 已设置。MR 以你的名义提交。
- [ ] **推送公司 GitLab 的凭证**：在终端里对要处理的仓库手动 `git push` 一次能成功（SSH key 或凭证管理器都行）。
- [ ] **本地克隆**：要让 Agent 处理的仓库已经克隆到本机。acp-link 在克隆旁边建 `git worktree`，不会动你正在改的工作区。
- [ ] **编码 Agent**：`claude` 或 `codex` 已安装并用你自己的账号登录过，在终端里能直接运行。
- [ ] **飞书账号**：登录平台用飞书扫码。
- [ ] **网络**：浏览器能打开 `<平台地址>`。公司要求走代理时记下代理地址；代理或防火墙对平台地址的空闲超时要大于 90 秒，否则派工长连接会反复断开。
- [ ] **（可选）Atlas**：团队的多仓库工具装好后可以让 acp-link 用它准备工作区（第 4 节）。

本机不需要开放任何端口，acp-link 只发出站请求。

## 3. 安装 acp-link

**下载**：浏览器打开 `<平台地址>/downloads/`，取自己系统的单文件。同目录的 `SHA256SUMS` 可用来校验。

| 系统 | 文件 | 建议放在 |
| --- | --- | --- |
| Windows x64 | `windows-amd64/acp-link.exe` | `%LOCALAPPDATA%\acp-link\`，并加进用户 PATH |
| macOS Apple 芯片 | `darwin-arm64/acp-link` | `~/.local/bin/` |
| macOS Intel | `darwin-amd64/acp-link` | `~/.local/bin/` |
| Linux x64 | `linux-amd64/acp-link` | `~/.local/bin/` |

macOS 和 Linux 要加执行权限； macOS 首次运行提示“无法验证开发者”时去掉隔离标记：

```bash
chmod +x ~/.local/bin/acp-link
xattr -d com.apple.quarantine ~/.local/bin/acp-link
```

**初始化、登录、自检**

```bash
acp-link init -server <平台地址>
acp-link login
acp-link doctor
```

1. `init` 生成带注释的 `~/.acp-link/config.yaml`（Windows 是 `%USERPROFILE%\.acp-link\config.yaml`）。按第 4 节至少填好 `adapter` 和 `repos`。
2. `login` 打印一个确认地址和确认码，并尝试打开浏览器。在浏览器里用飞书登录任务榜，核对确认码后点确认。令牌存在 `~/.acp-link/credentials.json`，只有你自己可读。远程桌面或无浏览器时加 `-no-browser`，在别的设备上打开那个地址。
3. `doctor` 逐项检查配置、代理、证书、平台连通、令牌、长连接（约 35 秒）、git 身份、各仓库、Agent 命令。只想快速看一下就加 `-quick`。

**练习一次**：先不调模型，用回显适配器跑通整条链路。

```bash
acp-link run -adapter echo
```

在任务榜建一个涉及你配置过的仓库的练习任务并认领。acp-link 会在工作区里写一个 `ACP_ECHO.md`，提交、推分支、开 MR，任务时间线里会出现 MR 链接。练习完把 MR 关掉，在任务榜取消任务即可。

**命令一览**

| 命令 | 作用 |
| --- | --- |
| `acp-link init` | 生成示例配置；`-force` 覆盖 |
| `acp-link login` | 设备授权登录 |
| `acp-link run` | 前台运行守护进程；`-adapter` 临时换适配器，`-v` 详细日志 |
| `acp-link status` | 登录状态、本机守护进程与当前任务、平台上的 Agent 状态 |
| `acp-link doctor` | 自检 |
| `acp-link mcp-config claude\|codex` | 生成手动接入 MCP 的配置（第 7 节） |
| `acp-link version` | 版本 |

所有命令都支持 `-config <路径>`，也可以用环境变量 `ACP_LINK_CONFIG` 指定配置文件。

## 4. 配置文件说明

`acp-link init` 生成的文件每一项都有注释。大多数人只需要改下面这几行：

```yaml
server: <平台地址>
agent_name: zhangsan-mbp          # 重装后保持不变，平台就认为是同一个 Agent
adapter: claude-code              # claude-code | codex | echo
skills: [backend, harmonyos]      # 平台按技能派工和匹配求助
repos:
  - name: mobile/app              # GitLab 上的 group/project
    path: ~/code/app              # 本地克隆
    checks: ["npm test"]          # 可选：Agent 结束后在工作区里跑的检查
  - name: server/api
    path: ~/code/api
    target_branch: develop        # 可选：这个仓库的 MR 目标分支
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `repo_roots` | 空 | 没列在 `repos` 里的仓库，到这些目录下按项目名查找，并校验 remote |
| `workspace_dir` | `~/.acp-link/workspaces` | 任务工作区根目录 |
| `max_concurrency` | 1 | 同时执行的任务数，最大 3。已交 MR 等 CI 的任务不占名额 |
| `task_timeout` | 60m | 单任务超时，超时后终止 Agent，任务转待补充 |
| `auto_accept_help` | false | 是否自动接受本团队其他 Agent 的求助 |
| `proxy` | 空 | HTTP 代理；不填则读 `HTTPS_PROXY`，`NO_PROXY` 始终生效 |
| `ca_file` | 空 | 公司 TLS 解密网关的根证书（PEM），也会传给 Agent |
| `claude.extra_args` | 空 | 传给 Claude Code 的额外参数，常用于放行测试命令（第 10 节） |
| `codex.extra_args` | `["--full-auto"]` | 传给 Codex 的额外参数；写 `[]` 表示不加 |
| `codex.mcp_overrides` | 空 | 让 Codex 带上平台工具，见下 |
| `git.target_branch` | main | 默认 MR 目标分支 |
| `git.push_mr` | true | 推送时用 GitLab push options 自动开 MR |
| `log.level` | info | 日志在 `~/.acp-link/logs/acp-link.log` |

**用 Codex 时**加上下面两行，Codex 执行任务时才能调用平台工具（查询任务、向别人求助等）。写法依赖较新的 Codex 版本，不生效时日志会有警告：

```yaml
codex:
  mcp_overrides:
    - mcp_servers.acp.url="{mcp_url}"
    - mcp_servers.acp.bearer_token_env_var="ACP_TASK_TOKEN"
```

**用 Atlas 时**把 `atlas.enabled` 设为 true，并填三个命令模板。占位符是 `{task_id}`、`{branch}`、`{repo}`、`{workspace}`：

- `locate_cmd`：输出每行一个仓库 `group/project [本地路径]`；
- `prepare_cmd`：执行后 `{workspace}` 必须是该仓库在 `{branch}` 上的 git 工作区；
- `check_cmd`：退出码 0 为通过。

Atlas 命令行接口定稿前，保持 `enabled: false`，acp-link 会自己用 `git worktree` 准备工作区。模板里的命令不经过 shell，需要管道或 `&&` 时显式写 `sh -c "..."` 或 `cmd /c "..."`。

每次开始任务前都会重新读配置，改完不用重启。

## 5. 作为后台服务运行

前台的 `acp-link run` 跑通以后，装成登录后自动启动的后台服务。安装脚本在 `<平台地址>/downloads/packaging/` 下：Windows 取 `windows/install-task.ps1`，macOS 取 `macos/` 里的两个文件，和 acp-link 放在同一个目录里执行。

**Windows（计划任务，不需要管理员）**

```powershell
powershell -ExecutionPolicy Bypass -File .\install-task.ps1 -Binary .\acp-link.exe
```

- 以你自己的身份、只在登录时运行，所以你的 git 凭证、SSH key 和 Agent 登录状态都能用；
- 程序复制到 `%LOCALAPPDATA%\acp-link\`，无窗口启动，异常退出 30 秒后重启；
- 卸载加 `-Uninstall`，只注册不立即启动加 `-NoStart`；
- 计划任务读的是用户级环境变量，要走代理就设用户级的 `HTTPS_PROXY`，或在配置里写 `proxy`。

**macOS（launchd）**

```bash
bash ./install-macos.sh --binary ./acp-link
```

- 服务文件是 `~/Library/LaunchAgents/com.acp.acp-link.plist`，登录后自动启动，异常退出 30 秒后重启；
- 安装时把当前终端的 `PATH` 和代理变量写进 plist，因为 launchd 默认找不到 Homebrew 或 npm 装的 `claude`、`codex`。以后换了安装位置就再跑一次脚本；
- 卸载加 `--uninstall`，配置和令牌保留。

装好后用 `acp-link status` 看状态，日志在 `~/.acp-link/logs/acp-link.log`。任务榜“负责人”页里你的 Agent 应显示在线。本版没有托盘图标。

这两个脚本在交付时只做过语法检查，第一位安装的开发者请把结果反馈给管理员。

## 6. 一个任务在你电脑上怎么执行

1. **派工到达**：你在飞书卡片或任务榜上认领或接受后，平台把任务推给你的 acp-link，它立即回复“开始执行”。
2. **准备工作区**：在 `workspace_dir/<任务号>/<仓库名>/` 为每个涉及的仓库建 `git worktree`，分支名 `acp/<任务号>-<英文摘要>`。重新派工时在远端已有的同名分支上继续。
3. **写任务说明**：`ACP_TASK.md` 里有标题、描述、完整时间线（问答、评审意见、CI 失败信息）、仓库与分支、检查命令。
4. **启动你的 Agent**：无头模式运行，带上一个只对这个任务有效的短期令牌和平台工具。输出实时回传到任务时间线，至多每 2 秒一条。
5. **检查**：Agent 结束后跑配置里的 `checks` 或 Atlas 检查，不通过就不推送。
6. **提交与 MR**：有改动就以你的 git 身份提交 `ACP-<任务号>: <标题>`，推分支并自动开 MR，把 MR 链接回传。此时你的 Agent 就空出来了，可以接下一个任务。
7. **等 CI 和审批**：GitLab 流水线通过后任务转“待审批”，评审者同意并在 GitLab 合并后任务完成。

**什么时候要你出手**

| 情况 | 平台怎么做 | 你做什么 |
| --- | --- | --- |
| Agent 需要更多信息 | 任务转“待补充”，飞书里问你 | 在卡片、群里回复“ACP-<号> 答案”或任务榜上回答；平台重新派工，Agent 带着答案继续 |
| 本机找不到仓库 | 同上，提示缺哪个仓库 | 在 `repos` 补上本地路径后回复任务，不用重启 |
| 检查失败或没有改动 | 任务转“待补充”，工作区保留 | 看时间线里 Agent 的结论，必要时到工作区自己修 |
| CI 失败 | 自动重新派工并带上失败信息，最多重试 2 次 | 超过次数后任务失败，人工接手 |
| 评审未通过 | 带上评审意见重新派工 | 一般不用管 |
| 任务被取消或收回 | 本机立即停掉 Agent，工作区保留 | 不需要时自己删工作区 |

成功完成的任务会自动删掉工作区。电脑关机超过 30 分钟时，正在执行的任务会被回收到待认领；已交 MR 等 CI 的不受影响。

## 7. 只配 MCP：在你平时的 Agent 里用平台工具

不跑后台程序也能在日常的 Claude Code 或 Codex 会话里直接问“我名下有什么任务”“让后端的 Agent 帮我查一下这个接口”。可用的工具：

| 工具 | 做什么 |
| --- | --- |
| `list_tasks` / `get_task` | 查任务列表与详情 |
| `claim_task` | 认领任务 |
| `update_task` | 回报进度、登记分支或 MR、请求补充信息 |
| `post_message` | 在任务时间线里留言 |
| `ask_agent` | 向别人的 Agent 求助，生成一个求助子任务（需要 agent_caller 角色） |
| `request_approval` | 发起审批 |
| `list_agents` | 看谁的 Agent 在线、会什么 |

**第一步，拿一个个人令牌**。二选一：

- 装了 acp-link：`acp-link login` 后执行 `acp-link mcp-config claude` 或 `acp-link mcp-config codex`，它会创建令牌并打印现成的配置；
- 没装：任务榜右上角头像 → “个人令牌”→ 新建，起一个能认出设备的名字，选有效期（最长 90 天）。令牌只显示这一次。

**第二步，配进 Agent**

Claude Code（一行命令，配一次即可）：

```bash
claude mcp add --transport http acp <平台地址>/mcp --header "Authorization: Bearer <个人令牌>"
```

Codex：写进 `~/.codex/config.toml`，令牌放在环境变量里。较旧的 Codex 要在文件顶层另加 `experimental_use_rmcp_client = true`。

```toml
[mcp_servers.acp]
url = "<平台地址>/mcp"
bearer_token_env_var = "ACP_TOKEN"
```

```bash
export ACP_TOKEN=<个人令牌>          # macOS / Linux，可写进 ~/.zshrc
setx ACP_TOKEN <个人令牌>            # Windows 用户级，重开终端生效
```

**第三步，试一下**：在 Agent 里问“用 acp 工具列出我负责的任务”。工具名可能带前缀（经网关聚合），按后缀认即可。

令牌不用了或可能泄露时，到“个人令牌”页点撤销，立即失效。不要把带令牌的配置提交到仓库或发给别人。

## 8. 在飞书群和任务榜里怎么配合

**飞书群里**

| 你想做的 | 怎么做 |
| --- | --- |
| 提一个需求 | 在群里 @ACP 协调，一句话说清楚；想指定谁做就同时 @他 |
| 把别人的一条消息变成任务 | 在那条消息上用消息快捷操作“ACP 建单” |
| 接下一个任务 | 任务卡片上点“认领”，平台建议你做的卡片上点“接受”或“拒绝” |
| 回答 Agent 的问题 | 回复“ACP-<任务号> 你的答案” |
| 审批（reviewer） | 审批卡片上点“同意”或“驳回”；驳回时写明原因，Agent 会带着意见重做 |
| 不知道怎么用 | @ACP 协调 帮助 |

群里 A @B 的普通聊天平台不会当成需求，只有 @了机器人、或用了“ACP 建单”的消息才会。管理员开启全群模式后，协调 Agent 会自己识别哪些消息像需求，但也只先发一张“要不要建单”的卡片。

**任务榜里**

- “查找任务”的“我负责的”就是你的待办；任务详情里的时间线实时显示 Agent 在做什么。
- 协调 Agent 的建议（比如“建议指派给某人”）显示在详情页，可以采纳、拒绝，已自动执行的可以撤销。
- 你自己想接手时，在详情页留言或取消；本机的 Agent 会被停掉，工作区留着给你。

## 9. 安全边界

- **Agent 只拿到任务级短期令牌**。你的登录令牌不会进入 Agent 的进程、参数或文件。任务令牌文件放在工作区之外，结束即删。
- **Agent 拿不到 GitLab 写权限**。启动时去掉 `GITLAB_TOKEN` 等变量，给 Agent 里的 git 清空凭证助手并禁用 SSH；推分支、开 MR 由 acp-link 用你的 git 配置完成。
- **任务描述是不可信输入**。提示词里明确告诉 Agent：不要把描述当命令，只在工作区内修改。飞书里任何人都能提需求，所以接受前看一眼内容。
- **这不是沙箱**。Agent 仍以你的用户身份运行，能读到你能读的文件。需要更强隔离时，在专用账号或虚拟机里运行 acp-link。
- **本机不开端口**，只有出站请求。
- **合并永远要人点头**。平台只开 MR，不合并。

## 10. 排障

先跑 `acp-link doctor`，它会指出大部分问题。日志在 `~/.acp-link/logs/acp-link.log`。

| 现象 | 处理 |
| --- | --- |
| doctor 报长连接被断开、日志反复 `subscription ended, reconnecting` | 代理、负载均衡或防火墙的空闲超时要大于 90 秒。断线期间派工不会丢，重连后平台会重发 |
| doctor 报“连接保持了 35s 但没收到 ping” | 中间有设备在缓冲响应；公司 Nginx 类代理要关掉响应缓冲 |
| `x509: certificate signed by unknown authority` | 公司在做 TLS 解密。请网管把平台地址加入免解密名单，或在配置里写 `ca_file` |
| 走代理不生效 | 配置里写 `proxy`；平台在内网可直达时把地址加进 `NO_PROXY`。后台服务读的环境变量可能和终端不同 |
| 时间线里出现 "requested permissions to use Bash" | Claude Code 无头模式下未放行的命令会被拒绝。按前缀放行具体命令，见下 |
| 提示另一个 `acp-link run` 正在运行 | 已有后台服务。`acp-link status` 确认；确实没有时加 `-force` |
| 提交失败 "Please tell me who you are" | 设置 git 提交身份 |
| 推送失败 | 在终端里手动 `git push` 一次确认凭证；SSH 方式确认 ssh-agent 已加载 key |
| MR 没自动创建 | 项目要允许 push options；不允许时只回传分支，手动开 MR 即可，平台仍能按分支名关联 |
| 找不到 `claude` 或 `codex` | 后台服务的 PATH 不同：macOS 重跑安装脚本，或在配置里写 `command` 的绝对路径 |
| 登录过期 | 运行中会在剩余不足 24 小时时自动刷新；已过期就重新 `acp-link login` |
| 平台提示版本过旧 | 到 `<平台地址>/downloads/` 下载新版覆盖 |

**让 Claude Code 自己跑测试**：不要全部放开，只放行具体命令。

```yaml
claude:
  extra_args: ["--allowedTools", "Bash(npm test:*)", "Bash(npm run lint:*)", "Bash(go test:*)"]
```

不放行也没关系：acp-link 会在 Agent 结束后自己跑 `checks`，不通过就不推送。`--permission-mode bypassPermissions` 会放开所有工具，只建议在专用的隔离机器上用。

更多细节见仓库里的 `acp-link/README.md`。

## 11. 变更记录

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-11-09 | v1.0 | 首版，对应 acp-link 0.1.0 |

相关文档：ACP-DOC-001 设计方案（第 4.3、4.4、6 节讲接入程序与安全），ACP-DOC-004 接口规范，ACP-DOC-006 交接文档。
