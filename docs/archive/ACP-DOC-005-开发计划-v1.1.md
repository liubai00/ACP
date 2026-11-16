<!--
文档编号: ACP-DOC-005
版本: v1.1
日期: 2026-11-09
状态: 待你确认后启动 W0
依据: ACP-DOC-001 v2.0 设计方案，ACP-DOC-002 v1.1 部署手册
在线可编辑版: https://claude.ai/artifact/NGJCj23peKT7EGjFbHWs9X
本文件为留存版，由在线版导出；修改请先改在线版，再导出覆盖本文件并升版本号。
-->

# ACP 开发计划

日期 2026-11-09 · 作者 Alex Morgan

文档编号 ACP-DOC-005 · 版本 v1.1 · 依据 ACP-DOC-001 v2.0 与 ACP-DOC-002 v1.1 · 留存于项目仓库 docs/ 目录，变更记录见文末

## 1. 目标与完成标准

一次交付全部功能：飞书一句话变成任务，开发者电脑上的 Agent 执行，开 MR，过 CI 和审批，合并；Agent 之间可以互相求助；网关、协调 Agent 六个场景、规则派工首版即上。完成标准就是设计方案的验收门，唯一一道，六条都要满足。

| 验收标准 | 怎么验证 |
| --- | --- |
| 试点小组 Mac、Windows 各两台接入 | 任务榜在线 Agent 列表显示 4 台，每台至少完成 1 个任务 |
| 10 个真实需求从飞书到合并跑通，含至少 1 个跨两个仓库 | 任务榜里 10 条完成的任务，每条能追溯到飞书消息和已合并的 MR；跨仓库那条有 2 个 MR |
| 至少 1 次真实的跨 Agent 协作 | 一个求助子任务由另一人的 Agent 完成并合并，双方对话在详情页可见 |
| 权限矩阵的“否”全部被拦 | 按设计方案第 7.3 节逐项试，每项被网关或协调服务器拒绝且有审计记录 |
| 断线恢复 | 拔网线 5 分钟后重连，进行中的任务不丢 |
| 全程不需要人工改数据库 | 运维记录中没有用 psql 手工改数据的操作 |

**交付物**（对应设计方案第 10 节的六个工作包）

| 交付物 | 形态 | 由谁 |
| --- | --- | --- |
| 协调服务器内核 | `coordinator/`，Python，容器镜像；含规则派工、Agent 自荐、ask\_agent 与子任务树、审计与限流 | 我开发 |
| 协调 Agent | coordinator 内的模块，六个触发场景，每场景自主等级可配，经网关调模型 | 我开发，你提供模型 key |
| agentgateway 配置 | `deploy/agentgateway/config.yaml`：JWT 验签、CEL 工具白名单、A2A 路由、大模型代理 | 我写，你部署 |
| 飞书事件桥 | `feishu-bridge/`，Python，容器镜像 | 我开发 |
| 接入程序 acp-link | Go 单二进制，macOS 与 Windows 安装包，Claude Code 与 Codex 适配器，设备授权登录，自更新 | 我开发，Atlas 对接需要你给接口说明 |
| n8n 工作流 | `n8n/workflows/` 四条 JSON，队列模式下运行 | 我开发，你在服务器导入 |
| 任务榜 | `board/`，Vue 3，看板、详情、Agent 在线榜、我的、发布表单、管理页（自主等级调整） | 我开发 |
| 部署 | `deploy/` 与 ACP-DOC-002 | 我写，你执行 |
| 接入程序安装手册 | ACP-DOC-003 | 我写 |
| 接口规范 | ACP-DOC-004，A2A、MCP、REST、Webhook 契约 | 我写，随代码生成 |

## 2. 代码仓库与结构

单仓库 `acp`，建在你们的 GitLab 上。理由：五个组件的接口在开发期天天变，单仓库一次提交改完，CI 一起跑；`docs/` 也在里面，文档和代码同版本。将来若接入程序要独立发版再拆。

```
acp/
├── coordinator/        Python 3.12：FastAPI + a2a-sdk + MCP SDK + SQLAlchemy/Alembic
│   ├── acp/            kernel/（任务库、状态机、权限、派工、审批、子任务树） api/ a2a/ mcp/ auth/ agent/（协调 Agent）
│   ├── migrations/
│   ├── tests/
│   └── Dockerfile
├── feishu-bridge/      Python：lark-oapi 长连接客户端，转发到 n8n
├── acp-link/           Go 1.23：cmd/acp-link，internal/{auth,subscribe,runner,adapters,atlas,gitlab,update}
├── board/              Vue 3 + Vite + TypeScript
├── n8n/workflows/      四条工作流 JSON，从 n8n 导出后提交
├── deploy/             compose、Caddyfile、agentgateway/config.yaml、initdb、scripts、install.sh、.env.example
├── docs/               ACP-DOC-00x，当前 docs 目录原样搬入
├── .gitlab-ci.yml
└── README.md
```

**分支与标签**：`main` 受保护。前两个工作包我直接推 `main`，从 W2 起功能分支 `feat/<简述>` 走 MR，让平台自己的仓库也成为被管理的项目。部署版本打 `v0.<工作包号>.<修订>` 标签，例如 `v0.1.0` 是 W1 结束；验收通过后打 `v1.0.0`。

**CI**（GitLab CI，用你们现有 Runner）

| 阶段 | 内容 |
| --- | --- |
| lint | ruff 与 mypy；golangci-lint；eslint |
| test | pytest（带 Postgres 服务容器）；go test；vitest |
| build | 三个镜像构建验证（不推送，服务器自己 build）；acp-link 交叉编译 darwin/arm64、darwin/amd64、windows/amd64 |
| release（打标签时） | 安装包上传到 GitLab Release，协调服务器下发的最低版本号指向这里 |

Runner 需要能跑 Docker（构建镜像）和访问公网（拉依赖）；若现有 Runner 不行，CI 只跑 lint 和 test，镜像在服务器上 build。

## 3. 工作包与顺序

六个工作包串行，每个结束都有能演示的东西，你看完再进下一个。这是工程上的先后，不是分批交付：验收门只有一道，试点在 W5 之后开始。工期不写天数，写每个工作包需要你做什么；我这边的编码量估计在表后。

![开发顺序 · 6 个工作包，1 道验收门](images/07-开发顺序.png)

*图：开发顺序 · 6 个工作包，1 道验收门*

右栏的事在对应工作包开始前准备好，左栏才不会等。

| 工作包 | 内容 | 结束时能演示 | 需要你做 |
| --- | --- | --- | --- |
| W0 骨架与部署 | 仓库初始化、目录、CI、compose（含 agentgateway、Redis、n8n worker）、数据库迁移框架、`/healthz` 与 `/api/ping/stream`、网关配置与 JWKS、`deploy/` 全部文件、三个 Dockerfile | 服务器按 ACP-DOC-002 跑起空平台：证书、网关验签、n8n 队列、postgres 就位，内网连通性测试通过 | 建 GitLab 仓库；按手册部署服务器 |
| W1 内核与任务榜 | 数据模型（任务、成员、Agent、事件、审批）、状态机、权限矩阵、REST、飞书 OAuth 与 JWT/JWKS、任务榜全部页面、feishu-bridge、n8n 建单流（@机器人、消息快捷操作、全群读取三种入口） | 飞书里 @机器人 说一句话或在消息上点“转为任务”，任务榜出现任务，群里收到卡片，可认领 | 飞书应用配置（DOC-002 第 9 节）；导入工作流；建试点群 |
| W2 派工与接入程序 | A2A 服务端（subscribe\_assignments、report\_progress、request\_input、create\_task）、MCP 工具、规则派工与 Agent 自荐、acp-link（设备授权登录、订阅、心跳、Claude Code 适配器、工作区隔离、推分支开 MR）、Atlas 对接 | 认领后开发者电脑上 Claude Code 自动拉起，完成后 MR 链接回到任务榜；平台能给出派工建议卡 | Atlas 命令行接口说明；一台 Mac 一台 Windows 试装 |
| W3 CI 回执与审批 | n8n GitLab 回执流（push、MR、pipeline 进任务时间线）、审批流（飞书审批卡片、request\_approval）、MR 评论与批准回写、合并后关单、30 分钟无心跳回收、通知流 | 一个需求从飞书到合并完整走通 | GitLab Webhook 与 acp-bot（DOC-002 第 10 节）；两个试点项目 |
| W4 协调 Agent 与 Codex | 协调 Agent 六个触发场景、自主等级配置与一键撤销、建议与执行分开记录、Codex 适配器、macOS 与 Windows 安装包与自更新 | 建单解析、失败归类、待补充自答、巡检提醒都能看到建议卡；管理页能调等级 | 模型 key；Codex 运行方式 |
| W5 互调与网关授权 | ask\_agent 与子任务树（深度、数量、环检测）、求助路由、Agent 注册表与自荐匹配、CEL 工具白名单逐项验证、审计与限流、ACP-DOC-003 与 004、跑 10 个真实需求 | 一次跨 Agent 协作从求助到合并；权限矩阵的“否”全被拦；验收门全部通过 | 组织试点需求与一次真实跨 Agent 协作 |

我的编码量估计（纯开发，不含等待）：W0 约 1 天，W1 约 4 到 5 天，W2 约 5 到 7 天，W3 约 3 到 4 天，W4 约 4 到 5 天，W5 约 5 到 6 天，合计 22 到 28 天。联调和返工按同等时间预留，所以整体按 8 到 10 周考虑比较稳妙。

## 4. 开发期间需要你提供的东西

前三项现在就能给，给了我就能开始 W0。其余按“什么时候要”那一列准备即可。

| 需要 | 用在 | 什么时候要 | 说明 |
| --- | --- | --- | --- |
| GitLab 上的空仓库 `acp`，及你本机 git 对它的推送权限 | W0 | 现在 | 我用这台电脑推代码；确认本机 `git push` 到你们 GitLab 不需要我额外登录 |
| 同意在本机安装 Go 1.23 以上 | W0 | 现在 | 本机缺 Go，我用 winget 装，装前问你 |
| 大模型：提供商、模型、接入地址、key | W0 网关配置、W4 协调 Agent | W0 结束前 | key 只进服务器 `.env` 并只给 agentgateway；本机单元测试用模拟响应，不调真模型 |
| 飞书 App ID 与 App Secret | W1 联调 | W1 | 只进服务器 `.env`；本机开发用假身份登录，不需要 secret |
| 飞书“获取群组中所有消息”敏感权限的审批结果（可选） | W1 | W1 | 不批则全群监听模式不可用，@机器人 和快捷操作不受影响 |
| 飞书应用加本地回调地址（可选） | W1 | W1 | 只有想在我这台机器上直接测飞书登录才需要 |
| 试点群与 4 位开发者名单（姓名、系统、用的 Agent） | W1 到 W2 | W1 | 决定安装包和适配器的优先级 |
| Atlas 命令行接口说明 | W2 | W1 结束前 | 列仓库、建分支与工作区、跑检查三类命令的参数和输出格式；附一段真实输出最好 |
| 两个试点 GitLab 项目与 acp-bot 令牌 | W3 | W2 | 可以是测试项目，有 CI 配置即可 |
| Codex 在开发者电脑上的无头运行和登录方式 | W4 | W3 | 哪个版本、如何非交互执行、JSON 输出开关 |
| 一次真实的跨 Agent 协作场景（谁求助谁、什么需求） | W5 验收 | W4 | 验收门需要一次真实的，不是演示用的 |
| 任务榜前端框架是否接受 Vue 3 | W1 | W0 结束前 | 不说就按 Vue 3 |

## 5. 本机开发环境

这台 Windows 电脑上已有的工具够跑 coordinator、feishu-bridge、board 和整套 compose，只缺 Go。

| 工具 | 状态 | 版本 | 用途 |
| --- | --- | --- | --- |
| Python | 有 | 3.12.10 | coordinator、feishu-bridge |
| uv | 有 | 0.11 | Python 依赖与虚拟环境 |
| Node.js | 有 | 24.16 | board；npm 够用，不装 pnpm |
| Docker Desktop 与 compose | 有 | 29.7 / v5.5 | 本地 postgres、n8n，整套 compose 预演 |
| git | 有 | 2.54 | 推到你们 GitLab |
| Go | 缺 | 需 1.23 以上 | acp-link；`winget install GoLang.Go`，得你同意后装 |
| ruff、mypy、golangci-lint | 缺 | 随项目 | 装在项目内，不动全局 |

## 6. 开发与联调方式

- 本地运行：`deploy/compose.dev.yaml` 起 postgres、redis、n8n、agentgateway，coordinator 和 board 在宿主机热重载跑；feishu-bridge 本地可连真飞书（长连接是出站的），也可用录好的样本回放。
- 开发期登录：coordinator 的 `ACP_DEV_LOGIN=true` 开一个仅本地的假身份登录页，输入成员名即登录；这个变量在服务器 `.env` 中永不出现，ACP-DOC-002 第 16 节有检查项。
- 网关本地也在链路上：开发期就通过 agentgateway 访问协调服务器，JWT 和 CEL 规则从 W0 起就被测到。
- 接入程序本地测试：acp-link 连本机网关，适配器先用“回显 Agent”（不调真模型）跑通协议，再换 Claude Code。
- 服务器联调节奏：每个工作包结束我打标签，你按 ACP-DOC-002 第 13 节升级，当天联调；问题我改完再打修订标签。
- 代码进仓库：我在本机提交并推到你们 GitLab，提交信息写清工作包和模块；你随时在 GitLab 上看 diff。
- 测试：内核状态机、权限矩阵、子任务树上限有单元测试；REST、A2A、MCP 有起 Postgres 的集成测试；CEL 规则有一组“权限矩阵对照”测试；n8n 工作流用导出 JSON 做结构校验，行为靠联调。
- 文档：每个工作包结束同步 `docs/` 里受影响的文档和版本号，在线版先改、再导出覆盖。

## 7. 与设计方案的对应

部署手册和本计划定下的实现细节已全部写进设计方案 v2.0，这里只留对照清单便于核对。

- 飞书事件桥：设计方案第 2 节组件表、第 9 节选型表。
- n8n 队列模式加 Redis 与 worker：第 9 节选型表与部署拓扑。
- 协调服务器单端口 8000 按路径分三个面：第 5 节开头、第 7.1 节网关配置。
- 接入程序设备授权登录：第 6 节运行方式表、第 5.3 节 REST 接口。
- 不自动合并 MR：第 4.5 节。
- 大模型 key 只在网关，协调服务器经 `/llm` 路由调模型：第 7.1、7.4 节。
- 免登录 SSE 测试端点、飞书消息快捷操作与全群读取选项：第 4.1、5.3、5.4 节。
- 自主等级改为运行配置、一道验收门：第 2 节设计原则、第 9 节自主等级、第 10 节。

## 8. 风险与未决问题

| 风险或问题 | 影响 | 应对 |
| --- | --- | --- |
| 一次交付范围大，上线前没有真实用户反馈 | 方向偏了发现得晚 | 每个工作包结束演示；W1 结束后你自己先在服务器上用起来，不等试点 |
| Atlas 接口说明迟到 | W2 的仓库定位没法做 | W2 先按“任务里显式写仓库列表”实现，Atlas 到了再接，接口封在 `internal/atlas` 一处 |
| Codex 无头模式不稳定 | Codex 适配器延期 | 试点中用 Codex 的人先用 Claude Code 适配器，适配器接口不变 |
| agentgateway 对 a2a 路由的 JWT/CEL 未经验证 | W0 卡住 | W0 第一件事就验；不行则协调服务器自己验签，网关只做 MCP 白名单和大模型代理 |
| 飞书长连接要先有客户端在线才能在控制台保存 | 首次配置卡住 | 已写进 ACP-DOC-002 第 8.5 与 9.5 节，按顺序做 |
| 全群消息敏感权限不批 | 全群监听模式不可用 | 该模式是配置项，其余两种进单方式不受影响 |
| 服务器地域与备案决定晚 | 重装服务器 | 买服务器前定，ACP-DOC-002 第 3 节有说明 |
| a2a-sdk 1.0 的流式语义变化 | 订阅模块返工 | 订阅封在独立模块，锁小版本；必要时换自定义 WebSocket |
| 一次产出大量代码，你审阅压力大 | 质量风险 | 每个工作包结束一次演示，你挑模块看；权限、状态机、子任务树上限这三个关键模块我写测试覆盖 |
| GitLab Runner 不能跑 Docker | CI 不能构建镜像和安装包 | CI 只跑 lint 和 test，镜像在服务器 build，安装包我在本机交叉编译后上传 Release |

未决问题就是第 4 节表里的项，不再重复。

## 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.1 | 2026-11-09 | 配合设计方案 v2.0 取消分阶段：改为一次交付、一道验收门，五个冲刺改为六个工作包（新增 W5 互调与网关授权），网关与 Redis 进 W0，协调 Agent 六场景全在 W4；需要你提供的清单、联调方式、风险同步；第 7 节改为与设计方案的对应 |
| v1.0 | 2026-11-09 | 首版：验收标准与交付物、仓库结构、五个冲刺、需要你提供的清单、本机环境、联调方式、七条落地修正、风险 |
