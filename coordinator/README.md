# coordinator：协调服务器

对外是一个 A2A Agent，对内分两层：确定性内核（任务库、状态机、权限矩阵、派工、审批、事件）和协调 Agent 外壳（大模型或规则给建议，执行一律经内核）。

## 结构

```
acp/
├── main.py            应用入口（uvicorn acp.main:app），启动 outbox 投递与定时任务
├── config.py          全部配置，环境变量前缀 ACP_
├── models.py          数据模型（14 张表）
├── security.py        RS256 JWT、JWKS、调用方身份 Principal
├── broker.py          进程内发布订阅（SSE 与派工推送）
├── kernel/            确定性内核
│   ├── states.py        A2A 八个状态与状态转换表
│   ├── permissions.py   权限矩阵（按数据判断的部分）
│   ├── tasks.py         建单、认领、派工、审批、Agent 回报、求助子任务
│   ├── agents.py        Agent 注册、心跳、派工投递
│   ├── dispatch.py      规则派工（仓库、技能、在线、负载打分）
│   ├── feishu.py        飞书事件：@机器人、卡片按钮、消息快捷操作、全群模式
│   ├── gitlab.py        GitLab 事件：推送、MR、流水线 → 审批、关单、重试
│   ├── notify.py        飞书卡片模板与 outbox 投递（n8n / direct / log）
│   ├── jobs.py          离线判定、30 分钟无心跳回收、定时巡检
│   └── overview.py      项目全貌与数据来源统计
├── agent/             协调 Agent：llm.py（经网关调模型）、scenarios.py（六个场景）、suggestions.py（L0/L1/L2 与撤销）
├── api/               REST（tasks.py、misc.py）、登录（auth.py）、A2A（a2a.py）、MCP（mcp_server.py）
├── integrations/      飞书与 GitLab 接口
├── cli.py             acp-admin 管理命令
└── demo.py            示例数据（is_demo，可一键删除）
migrations/            Alembic 迁移（容器启动时自动执行）
tests/                 端到端测试：真实 uvicorn + 本地 Postgres
```

## 本地运行与测试

```bash
uv venv --python 3.12 .venv && uv pip install --python .venv -e ".[dev]"
docker run -d --name acp-dev-pg -e POSTGRES_USER=acp -e POSTGRES_PASSWORD=acp -e POSTGRES_DB=acp -p 127.0.0.1:56543:5432 postgres:16-alpine
echo 56543 > ../.local/devpg.port          # 测试从这里读端口
.venv/Scripts/python -m pytest -q          # 12 个端到端用例
.venv/Scripts/ruff check acp tests
```

开发时直接跑服务：设置 `ACP_DATABASE_URL`、`ACP_PUBLIC_URL`、`ACP_JWT_AUTOGEN=true`、`ACP_DEV_LOGIN=true`，执行 `alembic upgrade head` 后 `uvicorn acp.main:app --port 8000`。Windows 上需要 Selector 事件循环（见 `../.local/run_coord.py` 的写法），Linux 容器里不需要。

改了 `models.py` 后生成迁移：`alembic revision --autogenerate -m "说明" --rev-id 000N`，检查生成的文件再提交。

## 管理命令

```bash
docker compose exec coordinator acp-admin list-members
docker compose exec coordinator acp-admin grant-role --member <名字或ID> --role reviewer|admin|developer|agent_caller
docker compose exec coordinator acp-admin issue-service-token --name <名称> --role connector
docker compose exec coordinator acp-admin seed-demo | purge-demo
```

接口说明见 `../contracts/API.md`，运行中的服务另有 OpenAPI 页面 `/api/docs`。
