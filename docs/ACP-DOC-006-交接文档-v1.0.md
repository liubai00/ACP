<!--
文档编号: ACP-DOC-006
版本: v1.0
日期: 2026-11-09
状态: 交接用；代码完成并本机验证，服务器部署与飞书、GitLab、开发者接入待执行
配套: ACP-DOC-001 v2.1，ACP-DOC-002 v1.2，ACP-DOC-003 v1.0，ACP-DOC-004 v1.1，ACP-DOC-005 v1.2
在线可编辑版: https://claude.ai/artifact/ARDSt6xH8ypENT6oCnTKys
本文件为留存版，由在线版导出；修改请先改在线版，再导出覆盖本文件并升版本号。
-->

# ACP 交接文档

日期 2026-11-09 · 作者 Alex Morgan

文档编号 ACP-DOC-006 · 版本 v1.0 · 留存于项目仓库 docs/ 目录，变更记录见文末

## 1. 一页看懂

ACP 把飞书群、GitLab、任务榜和每位开发者电脑上的个人 Agent（Claude Code / Codex）接成一个协作平台：飞书里 @机器人 说一句话就建单，有人认领后他电脑上的 Agent 自动干活、推分支开 MR，CI 通过后在飞书里审批，合并后自动关单；Agent 之间可以经平台互相求助。所有代码、部署文件和文档都在一个仓库里，用 Docker 部署，一台服务器跑全套，迁移就是“备份 → 在新机器装 → 恢复”。

**现在的状态（2026-11-09）**

| 部分 | 状态 |
| --- | --- |
| 协调服务器、飞书事件桥、n8n 工作流、网关配置、任务榜、接入程序 | 已开发，本地整套容器联调通过（见第 11 节） |
| 部署到云服务器 | 未完成：已准备好一键安装，由你执行（第 4 节） |
| 飞书、GitLab、开发者电脑 | 待配置，按第 5–7 节的清单做 |
| 真实需求跑通、验收门 | 未开始，需要上面三项完成 |

**接手后先做这三件事**

1. 服务器改用 SSH 密钥登录，并换一个只有你知道的 root 密码。
2. 按第 4 节一条命令部署，跑 `smoke-test.sh` 确认 13 项通过，用引导管理员登录任务榜看示例数据。
3. 按第 5–7 节配飞书、GitLab 和一台开发者电脑，用一个小需求走一遍全流程。

## 2. 系统组成与代码仓库

所有代码、部署文件和文档都在同一个仓库里，每个子目录都有自己的 README。

| 组件 | 目录 | 技术 | 做什么 |
| --- | --- | --- | --- |
| 协调服务器 | `coordinator/` | Python 3.12、FastAPI、SQLAlchemy、Alembic、MCP SDK | 确定性内核（任务库、状态机、权限、派工、审批、事件）加协调 Agent；对外 REST、A2A、MCP、登录 |
| 任务榜 | `board/` | React、Vite、TypeScript、shadcn/ui（Discord 主题） | 项目全貌、查找任务、任务进展、任务详情、数据来源、负责人、自动化流程、设置 |
| 接入程序 acp-link | `acp-link/` | Go 单二进制 | 装在开发者电脑：登录、订阅派工、拉起 Claude Code / Codex、推分支开 MR、回传进度 |
| 飞书事件桥 | `feishu-bridge/` | Python、lark-oapi | 飞书长连接，事件原样转给 n8n |
| n8n 工作流 | `n8n/` | n8n 1.123 | 飞书事件、GitLab 回执、通知出口三条，由 `build_workflows.py` 生成 |
| 网关 | `deploy/agentgateway/` | agentgateway v1.7.0 | JWT 验签、MCP 工具白名单、A2A、代理大模型 |
| 部署 | `deploy/` | Docker Compose、Caddy | 一键安装、备份、巡检、升级、冒烟测试 |
| 接口契约 | `contracts/API.md` |  | 各组件共同遵守的接口，改接口先改这里 |
| 文档 | `docs/` |  | 编号文档留存版，历史版在 `docs/archive/` |

**谁调谁**：浏览器和接入程序 → Caddy → agentgateway → 协调服务器；飞书 → 事件桥 → n8n → 协调服务器；GitLab → n8n → 协调服务器；协调服务器 → outbox → n8n → 飞书 / GitLab；协调服务器 → 网关 3001 → 大模型。完整架构和部署拓扑图见 ACP-DOC-001 第 2 节与 ACP-DOC-002 第 2 节。

**三条设计底线**（改代码时不要破坏）：任务库是唯一事实来源，所有状态变化只经过 `coordinator/acp/kernel/`；开始执行前成员本人确认、合并前评审者确认，平台不自动合并；Agent 拿不到 GitLab 写凭证和成员长期令牌。

## 3. 环境与凭证清单

本节只写位置，不写任何密钥的值。

**地址**（只有 IP 时；换域名后见 ACP-DOC-002 第 7 节）

| 用途 | 地址 |
| --- | --- |
| 任务榜 | `http://<服务器IP>/` |
| n8n | `http://<服务器IP>:5678/` |
| 接口文档 | `http://<服务器IP>/api/docs` |
| 接入程序下载 | `http://<服务器IP>/downloads/` |
| GitLab Webhook | `http://<服务器IP>:5678/webhook/gitlab` |
| 飞书登录回调 | `http://<服务器IP>/auth/feishu/callback` |
| MCP（个人 Agent 手动接入） | `http://<服务器IP>/mcp` |

**凭证在哪里**

| 凭证 | 位置 | 谁用 | 换了会怎样 |
| --- | --- | --- | --- |
| 服务器 root 登录 | 你自己保管 | 运维 | — |
| 引导管理员密码 | 服务器 `/opt/acp/deploy/secrets/admin-password.txt`，也在 `.env` 的 `ACP_ADMIN_PASSWORD` | 飞书登录配好前登录任务榜 | 改 `.env` 后 `docker compose up -d` |
| JWT 签名私钥 | `/opt/acp/deploy/secrets/jwt_private.pem` | 协调服务器签发令牌 | 所有人需重新登录、重新 `acp-link login` |
| 数据库密码 | `.env` 的 `POSTGRES_PASSWORD`、`N8N_DB_PASSWORD` | 容器内部 | 初始化后不要改（要改需同时改数据库用户密码） |
| n8n 加密密钥 | `.env` 的 `N8N_ENCRYPTION_KEY` | n8n | 绝对不要改；丢了 n8n 内的凭证无法解密 |
| 内部共享密钥 | `.env` 的 `ACP_CONNECTOR_TOKEN`、`ACP_NOTIFY_TOKEN`、`BRIDGE_FORWARD_TOKEN`、`AGW_SESSION_KEY` | 容器之间 | 改后 `docker compose up -d` 即可 |
| GitLab Webhook 密钥 | `.env` 的 `GITLAB_WEBHOOK_TOKEN` | GitLab → 平台 | 同步改每个项目的 Webhook Secret |
| 飞书 App ID / Secret | `.env` 的 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` | 事件桥、登录、n8n 发消息 | 飞书后台重置后更新 `.env` |
| GitLab 机器人令牌 | `.env` 的 `GITLAB_BOT_TOKEN`（可选） | n8n 写 MR 评论 | 到期前更新 |
| 大模型 key | `.env` 的 `LLM_API_KEY`（可选） | agentgateway | 更新后重跑 `install.sh` |
| n8n owner 账号 | 你在 n8n 里创建 | 维护 n8n | — |
| 开发者令牌 | 各人电脑 `~/.acp-link/`；个人访问令牌在任务榜“个人令牌”里管理 | 接入程序、手动 MCP | 可随时吊销 |

备份里的 `config-<日期>.tgz` 包含 `.env` 和 `secrets/`，属于敏感文件。`N8N_ENCRYPTION_KEY` 和 `jwt_private.pem` 建议另存一份到密码管理器。

另有一个可选项：`.env` 的 `N8N_API_KEY`（在 n8n 的 Settings → n8n API 里创建），只用于在任务榜“自动化流程”页显示工作流和执行记录，不填不影响通知投递。

## 4. 部署与迁移到新环境

全部组件都在 Docker 里，服务器只需要 Docker。详细步骤、参数、换域名见 ACP-DOC-002，这里是最短路径。

**从零部署**

1. 开发机（Git Bash，仓库根目录）：`bash deploy/make-bundle.sh`，得到 `.local/dist/acp-<时间>.tar.gz`。
2. 传到服务器 `/tmp/acp-bundle.tar.gz`（scp、或云控制台网页终端上传）。开发机走 Clash 等代理时，先给服务器 IP 加直连规则。
3. 服务器上（root）：

```bash
mkdir -p /opt/acp && tar xzf /tmp/acp-bundle.tar.gz -C /opt/acp
bash /opt/acp/deploy/install.sh --host <服务器IP> --demo
bash /opt/acp/deploy/scripts/smoke-test.sh
```

4. 安全组放行 TCP 80、5678；浏览器打开 `http://<服务器IP>`，用 `admin` 和 `secrets/admin-password.txt` 里的密码登录。

Windows 上也可以把 2–3 合成一条：`powershell -ExecutionPolicy Bypass -File deploy\deploy-to-server.ps1 -Server <服务器IP> -Demo`（提示时自己输入密码）。

**整体迁移到另一台服务器**

1. 旧服务器：`bash /opt/acp/deploy/scripts/backup.sh`，拷出 `/var/backups/acp` 里当天的 `pg-*`、`n8n-data-*`、`config-*` 三个文件。
2. 新服务器：解压部署包到 `/opt/acp`；把 `config-*.tgz` 解到 `/opt/acp/deploy`（还原 `.env` 与密钥，尤其是 `N8N_ENCRYPTION_KEY` 和 JWT 私钥）。
3. 新服务器：`install.sh --host <新IP>`，再 `scripts/restore.sh <日期>`，最后 `smoke-test.sh`。
4. 地址变了：飞书重定向 URL、GitLab Webhook、各开发者 acp-link 的 `server` 一起改。

**升级与回滚**：新部署包解压覆盖 `/opt/acp`（`.env` 与密钥不在包里，不会被覆盖）后 `bash /opt/acp/deploy/scripts/upgrade.sh`，它先备份再重建。回滚就是用上一版部署包再做一遍；数据库结构不兼容时用 `restore.sh` 恢复升级前的备份。

## 5. 飞书配置清单

在 open.feishu.cn 开发者后台，按顺序做。每一步的屏幕路径和验证方法见 ACP-DOC-002 第 9 节。

- [ ] 凭证与基础信息：把 App ID、App Secret 填进服务器 `/opt/acp/deploy/.env` 的 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`，执行 `cd /opt/acp/deploy && docker compose up -d`，确认 `docker compose logs feishu-bridge` 里连上了长连接
- [ ] 添加应用能力：机器人
- [ ] 权限：contact:user.base:readonly、im:message、im:message:send_as_bot、im:message.group_at_msg:readonly、im:message.p2p_msg:readonly、im:chat:readonly（可选 im:message.group_msg）
- [ ] 安全设置 → 重定向 URL：`http://<服务器IP>/auth/feishu/callback`
- [ ] 事件配置：长连接，添加 im.message.receive_v1
- [ ] 回调配置：长连接，添加 card.action.trigger
- [ ] 消息快捷操作“ACP 建单”：把它的事件类型填进 `.env` 的 `BRIDGE_EXTRA_EVENTS`
- [ ] 创建版本并发布，管理员审核通过
- [ ] 机器人加入试点群；群里发“@ACP 协调 帮助”有回复
- [ ] 用飞书登录一次任务榜：第一个飞书登录的人自动成为管理员
- [ ] （可选）运维群自定义机器人 Webhook 写进 `/opt/acp/deploy/secrets/ops_webhook`

控制台不接受 http 回调地址时，先按 ACP-DOC-002 第 7 节换域名。

## 6. GitLab 配置清单

GitLab 在公司内网。Webhook 是内网出站到云服务器，内网放行就通；云服务器一般访问不到内网 GitLab，所以 MR 评论是可选项。

- [ ] 服务器上取 Webhook 密钥：`grep GITLAB_WEBHOOK_TOKEN /opt/acp/deploy/.env`
- [ ] 每个试点项目 Settings → Webhooks：URL `http://<服务器IP>:5678/webhook/gitlab`，Secret token 填上一步的值，勾 Push（分支过滤 `acp/*`）、Merge request、Pipeline
- [ ] Test → Push events 返回 200；超时就是内网出口没放行到服务器 5678，找 IT
- [ ] 试点项目有 CI（平台靠流水线结果触发审批）
- [ ] （可选，服务器能访问 GitLab 时）建 `acp-bot` 用户（Developer）和 api 范围的个人访问令牌，填 `.env` 的 `GITLAB_URL`、`GITLAB_BOT_TOKEN`，`docker compose up -d`

开发者推代码用自己电脑上已有的 git 凭证，接入程序用 GitLab push options 开 MR，不需要额外令牌。分支名必须是 `acp/<任务号>-<摘要>`，平台靠它把推送、MR、流水线对到任务。

## 7. 开发者接入与个人 Agent 配置

有两种接法，可以同时用。完整说明见 ACP-DOC-003 和 `acp-link/README.md`。

|  | 接入程序 acp-link（推荐） | 只配 MCP（轻量） |
| --- | --- | --- |
| 能做什么 | 平台把任务派给你，本机自动建工作区、拉起 Agent、推分支开 MR、回传进度 | 在你平时的 Claude Code / Codex 里查任务、认领、回报、向别人的 Agent 求助 |
| 不能做什么 | — | 平台不会主动推任务给你 |
| 需要 | git 提交身份与推送凭证、已登录的 `claude` 或 `codex` | 已登录的 `claude` 或 `codex` |

**接入程序五步**

1. 下载：`http://<服务器IP>/downloads/` 里取自己系统的单文件（Windows x64、macOS Apple 芯片 / Intel、Linux x64），放进 PATH。
2. `acp-link init -server http://<服务器IP>`，编辑 `~/.acp-link/config.yaml`：`adapter`（claude-code 或 codex）、`skills`、`repos`（GitLab 项目路径对应本地克隆路径）。
3. `acp-link login`：浏览器里用飞书登录并确认确认码。
4. `acp-link doctor`：逐项检查，全绿再继续。先想不调模型跑通整条链路时用 `acp-link run -adapter echo`。
5. 装成后台服务：Windows 用 `packaging/windows/install-task.ps1`（不需管理员），macOS 用 `packaging/macos/install-macos.sh`。之后任务榜“负责人”页能看到你的 Agent 在线。

**只配 MCP**：`acp-link login` 后执行 `acp-link mcp-config claude` 或 `acp-link mcp-config codex`，把打印的一行命令或配置片段贴进去。它会创建一个 90 天、可随时吊销的个人访问令牌。不装 acp-link 时，也可以在任务榜右上角头像 → “个人令牌”里创建，页面会给出 Claude Code 与 Codex 的配置写法。Claude Code 的形式是：

```bash
claude mcp add --transport http acp http://<服务器IP>/mcp --header "Authorization: Bearer <个人令牌>"
```

**角色**：登录后默认是 developer。管理员在任务榜“负责人”页给人加 reviewer（能审批合并）、agent_caller（能让自己的 Agent 调用 `ask_agent` 向别人求助）、admin；也可以在服务器上用 `acp-admin grant-role`。

## 8. 任务榜使用说明

界面基于 shadcn/ui，样式沿用 Kiranism next-shadcn-dashboard-starter 的 Discord 主题（MIT 许可），右上角可切换主题与明暗。`Ctrl+K` 打开命令面板，可按任务号、标题或页面名跳转。

| 左侧导航 | 看什么 | 能做什么 |
| --- | --- | --- |
| 项目全貌 | 总任务、未结束、进行中、待补充、待审批、待认领；近 7 天新建与完成趋势、平均交付时长、CI 通过率；负载与需要关注的事项 | 点任一数字跳到对应的任务列表 |
| 查找任务 | 可排序、可筛选的任务表（编号、标题、状态、优先级、来源、负责人、仓库、MR / CI） | 按关键字、状态、来源、优先级、负责人、仓库筛选；“我负责的”“我发布的”“待审批”快捷视图；新建任务 |
| 任务进展 | 按状态分列的看板，卡片显示在当前状态停留多久，超过 24 小时标黄、72 小时标红 | 点卡片看详情；状态变化通过详情页的操作按钮，没有拖拽 |
| 任务详情 | 流程步骤条、时间线、MR 与流水线、审批、协调 Agent 建议、求助子任务 | 按你的权限显示可用操作：认领、指派、接受、回答问题、审批、采纳或撤销建议、取消；时间线实时刷新 |
| 数据来源 | 飞书、GitLab、任务榜、Agent 求助、系统巡检各自的连接状态、事件量和最近事件 | 点卡片按来源筛选事件，查某条事件对应哪个任务 |
| 负责人 | 成员的团队、角色、待处理与进行中的任务、最近登录；每人的 Agent 是否在线与负载 | 管理员点一行编辑角色、团队和 GitLab 账号 |
| 自动化流程 | n8n 工作流是否启用、最近执行结果 | 跳到 n8n 看执行详情。要在这里显示列表，先在 n8n 的 Settings → n8n API 里创建 API Key，填进服务器 `.env` 的 `N8N_API_KEY`，再 `docker compose up -d` |
| 设置（管理员） | 协调 Agent 各场景的自主等级 L0/L1/L2、飞书建单方式、监听的群 | 保存后立即生效，并记入事件表；建议先按 L0 运行两周再逐项调高 |

头像菜单里还有“个人令牌”（创建、查看、吊销 MCP 用的个人访问令牌）。`acp-link login` 打开的确认页也是任务榜的一部分。

**示例数据**：用 `--demo` 安装时会生成 13 个带“示例·”前缀的任务和成员，覆盖所有状态，用来熟悉界面。正式使用前删除：`docker compose exec coordinator acp-admin purge-demo`，只删示例，不影响真实数据。

**本地改界面**：`cd board && npm install && npm run dev:mock` 不依赖后端即可预览；导航在 `src/config/nav.ts`，页面在 `src/pages/`。

## 9. 本地开发、测试与修改指南

**开发机需要**：Docker Desktop、Python 3.12 与 uv、Node 22 以上、git。Go 不必装，acp-link 的构建脚本会用仓库 `.local/tools/go` 里的便携版。

| 组件 | 启动 | 测试 |
| --- | --- | --- |
| 协调服务器 | 见 `coordinator/README.md` | `pytest -q`（真实 uvicorn 加本地 Postgres 的端到端用例）、`ruff check acp tests` |
| 任务榜 | `npm run dev:mock`（不依赖后端）或 `npm run dev`（连本地协调服务器） | `npm run typecheck`、`npm run lint`、`npm run build` |
| acp-link | `go run ./cmd/acp-link` | `go vet ./...`、`go test ./...`（含模拟协调服务器的集成测试） |
| n8n 工作流 | 改 `n8n/build_workflows.py` 后 `python build_workflows.py` | 部署后 `scripts/n8n-provision.sh` 重新导入 |
| 整套 | `cd deploy && docker compose up -d`（`.env` 写法见 `deploy/README.md`） | `bash scripts/smoke-test.sh` |

**改动的顺序**

1. 接口变了先改 `contracts/API.md`，再改协调服务器、任务榜、acp-link 三处。
2. 改了 `coordinator/acp/models.py` 就要加 Alembic 迁移（文件编号接着 `0003` 往后排），容器启动时自动执行。
3. 状态和权限的规则只在 `coordinator/acp/kernel/` 里改，接口层和协调 Agent 只调用内核。
4. 飞书卡片样式在 `coordinator/acp/kernel/notify.py`；协调 Agent 的六个场景在 `coordinator/acp/agent/scenarios.py`。
5. 发版：`bash deploy/make-bundle.sh` 打包，服务器上解压后 `upgrade.sh`。acp-link 新版本要先重新构建（`acp-link/build.sh`），部署包会带上 `acp-link/dist` 供 `/downloads/` 下载。

Windows 上跑协调服务器要用 Selector 事件循环（psycopg 异步不支持默认的 Proactor），写法见 `.local/run_coord.py`；Git Bash 里给 `docker -v` 传路径时加 `MSYS_NO_PATHCONV=1`。

## 10. 日常运维与故障入口

全部命令在服务器 `/opt/acp/deploy` 目录下执行。

| 事情 | 命令或位置 |
| --- | --- |
| 看整体状态 | `docker compose ps`；`bash scripts/smoke-test.sh` |
| 看日志 | `docker compose logs -f --tail 200 coordinator`（把服务名换成 feishu-bridge、n8n、agentgateway、caddy） |
| 重启某个组件 | `docker compose restart coordinator` |
| 改配置后生效 | 改 `.env`，然后 `docker compose up -d` |
| 备份 | 每天 02:30 自动备份到 `/var/backups/acp`，保留 30 天；手动 `bash scripts/backup.sh` |
| 恢复 | `bash scripts/restore.sh <日期>` |
| 巡检告警 | 每 5 分钟 `scripts/healthcheck.sh`，失败发到 `secrets/ops_webhook` 里的飞书机器人 |
| 管理成员角色 | `docker compose exec coordinator acp-admin list-members`、`grant-role`、`revoke-role` |
| 删示例数据 | `docker compose exec coordinator acp-admin purge-demo` |
| 看 n8n 执行记录 | `http://<服务器>:5678` → Executions |

**常见故障**

| 现象 | 先查 |
| --- | --- |
| 任务榜打不开 | 安全组是否放行 80；`docker compose ps` 里 caddy 和 board 是否在运行 |
| 接口全部 401 | agentgateway 启动时要从协调服务器取 JWKS；换过 JWT 私钥或协调服务器长时间起不来后执行 `docker compose restart agentgateway` |
| 飞书群 @ 机器人没反应 | `logs feishu-bridge` 是否连上；n8n Executions 里“ACP · 飞书事件”是否有记录；应用版本是否已发布 |
| 群里不出卡片 | `logs coordinator` 里 outbox 投递结果；n8n“ACP · 通知出口”执行记录里飞书返回的错误码（多半是权限没开或版本没发布） |
| GitLab 推送后任务不动 | 分支名是不是 `acp/<任务号>-...`；GitLab Webhook 的 Recent events 返回码；Secret 是否与 `.env` 一致 |
| 开发者的 Agent 显示离线 | 对方电脑上 `acp-link status` 与 `acp-link doctor`；代理或防火墙的空闲超时要大于 90 秒 |
| 任务被自动回收 | 执行中的 Agent 30 分钟没心跳就会回收；已交 MR 等 CI 的任务不会被回收 |
| 磁盘满 | `docker system df`；`/var/backups/acp` 的大小；n8n 执行记录保留 30 天（`compose.yaml` 的 `EXECUTIONS_DATA_MAX_AGE`） |

## 11. 验证记录

2026-11-09 在开发机（Windows 11、Docker Desktop 29.7）上完成。飞书、GitLab、大模型都用模拟数据，没有连真实服务。

| 验证项 | 方法 | 结果 |
| --- | --- | --- |
| 从部署包在空白机器上安装 | 在全新的 docker:27-dind 容器里解压部署包，执行 `install.sh --host 127.0.0.1 --demo --no-docker-install` | 通过：约 9 分钟装完，9 个容器全部健康，冒烟测试 13 项全过，cron、`.env` 600、`secrets/` 700 都对 |
| 开发机上整套联调 | `deploy/compose.yaml` 全部容器加 `smoke-test.sh` | 通过：13 项全过 |
| 协调服务器端到端测试 | 真实 uvicorn 加 Postgres，13 个用例：完整流程、飞书建单与卡片认领、权限、求助上限、MCP、设备登录、全貌统计、SSE、个人令牌、交 MR 后释放并发名额 | 通过；代码规范检查无告警 |
| 网关授权 | 无令牌请求、无 agent_caller 角色时的工具列表、令牌透传到 MCP 与 A2A | 通过：无令牌 401，`ask_agent` 被隐藏 |
| 飞书事件链路 | 模拟的飞书原始事件经事件桥、n8n 到协调服务器 | 通过：建出任务并带上建议负责人；通知工作流能走到飞书接口（只因没配 App ID 被拒） |
| GitLab 事件链路 | 模拟的 push、pipeline、MR 合并事件，经 n8n 和直连两条路 | 通过：流水线成功转待审批，合并后关单，重复事件被去重 |
| acp-link | `go vet`、`go test`（含模拟协调服务器的集成测试，连续 5 次）；对本机协调服务器用回显适配器实跑 | 通过：设备登录、doctor（含 35 秒长连接）、派工到推分支登记 MR、缺仓库时转待补充再重派、个人令牌可用于 MCP |
| 任务榜 | 类型检查、lint、构建；无头浏览器在 1440px 与 375px 下点过全部页面；经 Caddy 与网关读真实数据 | 通过：Discord 主题，8 个页面都能读到数据 |

验证中发现并修掉的问题：

- Agent 交了 MR 后仍占着并发名额，默认 1 个名额时会卡住下一个任务；已加迁移 `0003` 修复，等 CI 的任务也不再被 30 分钟无心跳回收。
- 在 Windows 上编辑过的脚本带了 CRLF 换行，Linux 上 `install.sh` 会直接报错；已全部转成 LF，并加了 `.gitattributes`、打包前检查和 CI 检查。
- 接入程序的后台服务安装脚本没有放到下载页；现在在 `/downloads/packaging/`。

**没有验证的**：服务器上的实际安装；真实飞书租户、内网 GitLab、Claude Code 与 Codex；acp-link 的 Windows 计划任务与 macOS launchd 实际注册；大模型建议。这些对应 ACP-DOC-001 验收门，需要在试点中完成。

## 12. 已知限制与待办

**需要你来做的**

- 在服务器上执行第 4 节的安装，并改用 SSH 密钥登录。
- 按第 5、6 节配飞书和 GitLab；第 7 节找一位开发者试接。
- 换正式域名并启用 HTTPS（ACP-DOC-002 第 7 节）。用 IP 访问时令牌在公网明文传输，只适合试用。
- 仓库推到公司 GitLab，之后就能用平台自己来管理平台的开发任务。

**未经实测的部分**

- 真实飞书应用：事件格式与卡片按飞书开放平台文档和官方 SDK 实现，本地用模拟事件验证过，但没连过真实的飞书租户。
- 真实内网 GitLab：Webhook 与 push options 开 MR 用模拟数据和本地裸仓库验证过。
- 真实 Claude Code 与 Codex：acp-link 用回显适配器和模拟输出验证过；Codex 注入 MCP 的 `-c` 写法依赖 Codex 版本。
- acp-link 的 macOS 后台服务与 Windows 计划任务只做了语法检查，没有实际注册过；macOS 只交叉编译过。
- 大模型：不配 `LLM_API_KEY` 时协调 Agent 用规则给建议；配了之后的建议质量要试用一段时间再评估。

**本版不做的**

- 不自动合并 MR；审批通过后由评审者在 GitLab 里合并。
- acp-link 没有托盘图标，用 `acp-link status` 看状态。
- Atlas 的命令行接口未定稿，acp-link 只提供命令模板，定稿后填配置即可。
- 协调服务器是单实例（进程内消息总线），团队规模内够用；要横向扩展时把消息总线换成 Redis。

## 13. 文档索引与变更记录

全部编号文档的留存版在仓库 `docs/` 目录，历史版本在 `docs/archive/`，索引是 `docs/README.md`。

| 编号 | 文档 | 版本 | 给谁看 |
| --- | --- | --- | --- |
| ACP-DOC-001 | 多 Agent 协作平台设计方案 | v2.1 | 所有人，理解平台怎么工作 |
| ACP-DOC-002 | 云服务器部署手册 | v1.2 | 运维，部署、飞书与 GitLab 配置、换域名 |
| ACP-DOC-003 | 开发者接入手册 | v1.0 | 开发者，安装 acp-link 和配置个人 Agent |
| ACP-DOC-004 | 接口规范 | v1.0 | 二次开发者 |
| ACP-DOC-005 | 开发计划 | v1.2 | 项目负责人，工作包与完成情况 |
| ACP-DOC-006 | 交接文档（本文） | v1.0 | 接手的人 |

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-11-09 | v1.0 | 首版：全部组件开发完成并本地验证，服务器部署与飞书、GitLab、开发者接入待执行 |
