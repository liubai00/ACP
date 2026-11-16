<!--
文档编号: ACP-DOC-005
版本: v1.0
日期: 2026-11-09
状态: 待你确认后启动 S0
依据: ACP-DOC-001 v1.2 设计方案，ACP-DOC-002 v1.0 部署手册
在线可编辑版: https://claude.ai/artifact/NGJCj23peKT7EGjFbHWs9X
本文件为留存版，由在线版导出；修改请先改在线版，再导出覆盖本文件并升版本号。
-->

# ACP 第一阶段开发计划

日期 2026-11-09 · 作者 Alex Morgan

文档编号 ACP-DOC-005 · 版本 v1.0 · 依据 ACP-DOC-001 v1.2 与 ACP-DOC-002 v1.0 · 留存于项目仓库 docs/ 目录，变更记录见文末

## 1. 目标与完成标准

第一阶段只求主线跑通：飞书一句话变成任务，开发者电脑上的 Agent 执行，开 MR，过 CI 和审批，合并；试点小组四台电脑接入。完成标准就是设计方案的验收门 1，四条都要满足。

| 验收标准 | 怎么验证 |
| --- | --- |
| 试点小组 Mac、Windows 各两台接入 | 任务榜在线 Agent 列表显示 4 台，每台至少完成 1 个任务 |
| 10 个真实需求从飞书到合并跑通 | 任务榜里 10 条状态为完成的任务，每条能追溯到飞书消息和已合并的 MR |
| 至少 1 个任务跨两个仓库 | 该任务有 2 个 MR 且都已合并，仓库由 Atlas 定位 |
| 全程不需要人工改数据库 | 运维记录中没有用 psql 手工改数据的操作 |

**交付物**（对应设计方案第 10 节第一阶段那一行）

| 交付物 | 形态 | 由谁 |
| --- | --- | --- |
| 协调服务器内核 | `coordinator/`，Python，容器镜像 | 我开发 |
| 协调 Agent（建单解析、飞书问答，L0 或只读） | coordinator 内的模块，可开关 | 我开发，你提供模型 key |
| 飞书事件桥 | `feishu-bridge/`，Python，容器镜像 | 我开发 |
| 接入程序 acp-link | Go 单二进制，macOS 与 Windows 安装包，Claude Code 与 Codex 适配器 | 我开发，Atlas 对接需要你给接口说明 |
| n8n 工作流 | `n8n/workflows/` 四条 JSON | 我开发，你在服务器导入 |
| 任务榜 | `board/`，看板与详情页 | 我开发 |
| 部署 | `deploy/` 与 ACP-DOC-002 | 我写，你执行 |
| 接入程序安装手册 | ACP-DOC-003 | 我写 |
| 接口规范 | ACP-DOC-004，A2A、MCP、REST、Webhook 契约 | 我写，随代码生成 |

## 2. 代码仓库与结构

单仓库 `acp`，建在你们的 GitLab 上。理由：五个组件的接口在第一阶段天天变，单仓库一次提交改完，CI 一起跑；`docs/` 也在里面，文档和代码同版本。第三阶段若接入程序要独立发版再拆。

```
acp/
├── coordinator/        Python 3.12：FastAPI + a2a-sdk + MCP SDK + SQLAlchemy/Alembic
│   ├── acp/            kernel/（任务库、状态机、权限、派工、审批） api/ a2a/ mcp/ auth/ agent/（协调 Agent）
│   ├── migrations/
│   ├── tests/
│   └── Dockerfile
├── feishu-bridge/      Python：lark-oapi 长连接客户端，转发到 n8n
├── acp-link/           Go 1.23：cmd/acp-link，internal/{auth,subscribe,runner,adapters,atlas,gitlab}
├── board/              Vue 3 + Vite + TypeScript（框架待你确认，否则 React）
├── n8n/workflows/      四条工作流 JSON，从 n8n 导出后提交
├── deploy/             compose、Caddyfile、initdb、scripts、install.sh、.env.example
├── docs/               ACP-DOC-00x，当前 docs 目录原样搬入
├── .gitlab-ci.yml
└── README.md
```

**分支与标签**：`main` 受保护。前两个冲刺我直接推 `main`，从 S2 起功能分支 `feat/<简述>` 走 MR，让平台自己的仓库也成为被管理的项目。部署版本打 `v0.<冲刺号>.<修订>` 标签，例如 `v0.1.0` 是 S1 结束。

**CI**（GitLab CI，用你们现有 Runner）

| 阶段 | 内容 |
| --- | --- |
| lint | ruff 与 mypy；golangci-lint；eslint |
| test | pytest（带 Postgres 服务容器）；go test；vitest |
| build | 三个镜像构建验证（不推送，第一阶段服务器自己 build）；acp-link 交叉编译 darwin/arm64、darwin/amd64、windows/amd64 |
| release（打标签时） | 安装包上传到 GitLab Release，协调服务器下发的最低版本号指向这里 |

Runner 需要能跑 Docker（构建镜像）和访问公网（拉依赖）；若现有 Runner 不行，第一阶段 CI 只跑 lint 和 test，镜像在服务器上 build。

## 3. 工作包与顺序

五个冲刺串行，每个结束都有能演示的东西，你看完再进下一个。工期不写天数，写每个冲刺需要你做什么；速度取决于反馈和联调的节奏，我这边的编码量估计在表后。

![冲刺顺序 · 5 个冲刺，1 道验收门](images/07-冲刺顺序.png)

*图：冲刺顺序 · 5 个冲刺，1 道验收门*

右栏的事在对应冲刺开始前准备好，左栏才不会等。

| 冲刺 | 内容 | 结束时能演示 | 需要你做 |
| --- | --- | --- | --- |
| S0 骨架 | 仓库初始化、目录、CI、compose、数据库迁移框架、`/healthz` 与 `/api/ping/stream`、`deploy/` 全部文件、三个 Dockerfile | 服务器按 ACP-DOC-002 跑起空平台：证书、n8n、postgres 就位，内网连通性测试通过 | 建 GitLab 仓库；按手册部署服务器 |
| S1 内核与任务榜 | 数据模型（任务、成员、Agent、事件、审批）、状态机、权限矩阵、REST、飞书 OAuth 与 JWT/JWKS、任务榜看板与详情页、feishu-bridge、n8n 建单流 | 飞书里 @机器人 说一句话，任务榜出现任务，群里收到卡片，在卡片或任务榜能认领 | 飞书应用配置（DOC-002 第 9 节）；导入工作流；建试点群 |
| S2 派工与接入程序 | A2A 服务端（subscribe\_assignments、report\_progress、request\_input、create\_task）、MCP 工具、acp-link（设备授权登录、订阅、心跳、Claude Code 适配器、工作区隔离、推分支开 MR）、Atlas 对接 | 认领后开发者电脑上 Claude Code 自动拉起，完成后 MR 链接回到任务榜 | Atlas 命令行接口说明；一台 Mac 一台 Windows 试装 |
| S3 CI 回执与审批 | n8n GitLab 回执流（push、MR、pipeline 进任务时间线）、审批流（飞书审批卡片、request\_approval）、MR 评论回写、合并后关单、30 分钟无心跳回收 | 一个需求从飞书到合并完整走通 | GitLab Webhook 与 acp-bot（DOC-002 第 10 节）；两个试点项目 |
| S4 协调 Agent 与收尾 | 协调 Agent L0 建单解析与飞书问答、Codex 适配器、macOS 与 Windows 安装包与自更新、ACP-DOC-003 与 004、跑 10 个真实需求 | 验收门 1 全部通过 | 模型 key；Codex 运行方式；组织试点需求 |

我的编码量估计（纯开发，不含等待）：S0 约 1 天，S1 约 4 到 5 天，S2 约 5 到 7 天，S3 约 3 到 4 天，S4 约 4 到 5 天。联调和返工按同等时间预留，所以第一阶段整体按 6 到 8 周考虑比较稳妙。

## 4. 开发期间需要你提供的东西

前三项现在就能给，给了我就能开始 S0。其余按“什么时候要”那一列准备即可。

| 需要 | 用在 | 什么时候要 | 说明 |
| --- | --- | --- | --- |
| GitLab 上的空仓库 `acp`，及你本机 git 对它的推送权限 | S0 | 现在 | 我用这台电脑推代码；确认本机 `git push` 到你们 GitLab 不需要我额外登录 |
| 同意在本机安装 Go 1.23 以上 | S0 | 现在 | 本机缺 Go，我用 winget 装，装前问你 |
| 任务榜前端框架偏好 | S1 | S0 结束前 | Vue 3 或 React，团队谁维护谁定；不说就 Vue 3 |
| 飞书 App ID 与 App Secret | S1 联调 | S1 | 只进服务器 `.env`；本机开发用假身份登录，不需要 secret |
| 飞书应用加本地回调地址（可选） | S1 | S1 | 只有想在我这台机器上直接测飞书登录才需要 |
| 试点群与 4 位开发者名单（姓名、系统、用的 Agent） | S1 到 S2 | S1 | 决定安装包和适配器的优先级 |
| Atlas 命令行接口说明 | S2 | S1 结束前 | 列仓库、建分支与工作区、跑检查三类命令的参数和输出格式；附一段真实输出最好 |
| 两个试点 GitLab 项目与 acp-bot 令牌 | S3 | S2 | 可以是测试项目，有 CI 配置即可 |
| 大模型：提供商、模型、接入地址、key | S4 | S3 结束前 | key 只进服务器 `.env`；本机单元测试用模拟响应，不调真模型 |
| Codex 在开发者电脑上的无头运行和登录方式 | S4 | S3 | 哪个版本、如何非交互执行、JSON 输出开关 |
| 第一阶段是否启用建单解析 | S4 | S3 | 不启用则 S4 的协调 Agent 只做飞书问答 |

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

- 本地运行：`deploy/compose.dev.yaml` 只起 postgres 和 n8n，coordinator 和 board 在宿主机热重载跑；feishu-bridge 本地不跑，飞书事件用录好的样本回放。
- 开发期登录：coordinator 的 `ACP_DEV_LOGIN=true` 开一个仅本地的假身份登录页，输入成员名即登录；这个变量在服务器 `.env` 中永不出现，ACP-DOC-002 第 16 节有检查项。
- 接入程序本地测试：acp-link 连本机 coordinator，适配器先用“回显 Agent”（不调真模型）跑通协议，再换 Claude Code。
- 服务器联调节奏：每个冲刺结束我打标签，你按 ACP-DOC-002 第 13 节升级，当天联调；问题我改完再打修订标签。
- 代码进仓库：我在本机提交并推到你们 GitLab，提交信息写清冲刺和模块；你随时在 GitLab 上看 diff。
- 测试：内核状态机和权限矩阵有单元测试；REST、A2A、MCP 有起 Postgres 的集成测试；n8n 工作流用导出 JSON 做结构校验，行为靠联调。
- 文档：每个冲刺结束同步 `docs/` 里受影响的文档和版本号，在线版先改、再导出覆盖。

## 7. 对设计方案的落地修正

下面七条是写部署手册和本计划时定下的实现细节，和 ACP-DOC-001 v1.2 有出入。你确认后我改在线版升到 v1.3 并重新导出。

1. 新增组件 feishu-bridge：维持飞书长连接并转发到 n8n。n8n 只能收 HTTP Webhook，维持不了长连接。
2. n8n 第一阶段用常规模式；队列模式依赖 Redis，第三阶段再上。
3. 协调服务器持有飞书 App ID 与 App Secret，仅用于 OAuth；第 7.4 节“飞书凭证只在 n8n 和接入程序里”改为“发消息的凭证只在 n8n”。
4. 协调服务器单端口 8000 按路径分三个面；第 7.1 节 agentgateway 示例中的 9999 端口改为 8000。
5. 接入程序登录改为设备授权流程：接入程序打开浏览器到平台的设备确认页，用户飞书登录后确认，接入程序轮询拿 JWT；不必在飞书登记本机回调地址。
6. 第一阶段不自动合并 MR：审批通过后 n8n 在 MR 上写审批评论并设置审批状态，合并由评审者在 GitLab 上点，合并事件回到平台关单。
7. 新增 `/api/ping/stream` 免登录 SSE 测试端点，供内网连通性测试。

## 8. 风险与未决问题

| 风险或问题 | 影响 | 应对 |
| --- | --- | --- |
| Atlas 接口说明迟到 | S2 的仓库定位没法做 | S2 先按“任务里显式写仓库列表”实现，Atlas 到了再接，接口封在 `internal/atlas` 一处 |
| Codex 无头模式不稳定 | Codex 适配器延期 | 试点中用 Codex 的人先用 Claude Code 适配器，或等第二阶段 |
| 飞书长连接要先有客户端在线才能在控制台保存 | 首次配置卡住 | 已写进 ACP-DOC-002 第 8.5 与 9.5 节，按顺序做 |
| 服务器地域与备案决定晚 | 重装服务器 | 买服务器前定，ACP-DOC-002 第 3 节有说明 |
| a2a-sdk 1.0 的流式语义变化 | 订阅模块返工 | 订阅封在独立模块，锁小版本；必要时换自定义 WebSocket |
| 一次产出大量代码，你审阅压力大 | 质量风险 | 每个冲刺结束一次演示，你挑模块看；权限和状态机这两个关键模块我写测试覆盖 |
| GitLab Runner 不能跑 Docker | CI 不能构建镜像和安装包 | 第一阶段 CI 只跑 lint 和 test，镜像在服务器 build，安装包我在本机交叉编译后上传 Release |

未决问题就是第 4 节表里的项，不再重复。

## 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.0 | 2026-11-09 | 首版：验收标准与交付物、仓库结构、五个冲刺、需要你提供的清单、本机环境、联调方式、七条落地修正、风险 |
