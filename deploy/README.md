# deploy：部署文件

完整步骤见 `docs/ACP-DOC-002`（云服务器部署手册）。这里只列文件。

| 文件 | 作用 |
| --- | --- |
| `compose.yaml` | 9 个常驻容器 + 一次性的 `n8n-import`；构建上下文指向仓库里的源码目录 |
| `.env.example` | 全部配置项模板；`install.sh` 生成 `.env` 并填好随机密钥 |
| `install.sh` | 一键安装 / 升级：装 Docker、生成 `.env` 与密钥、渲染网关配置、构建、导入 n8n 工作流、启动、写 cron |
| `caddy/Caddyfile` | 入口与路由：直达协调服务器的路径、经网关的路径、任务榜、`/downloads/`、n8n |
| `agentgateway/config.yaml.tmpl` | 网关配置模板（JWT、MCP 工具白名单、A2A、大模型代理），`install.sh` 渲染成 `config.yaml` |
| `postgres/initdb/01-n8n-db.sh` | 首次初始化时创建 n8n 库 |
| `scripts/smoke-test.sh` | 部署后冒烟测试（13 项，不产生数据） |
| `scripts/n8n-provision.sh` | 导入并激活 n8n 工作流（n8n 1.12x 起需要补版本记录） |
| `scripts/backup.sh` / `restore.sh` | 每日备份到 `/var/backups/acp`，按日期恢复 |
| `scripts/healthcheck.sh` | 每 5 分钟巡检，失败时发到 `secrets/ops_webhook` 指定的飞书机器人 |
| `scripts/upgrade.sh` | 先备份再重跑 `install.sh` |
| `make-bundle.sh` | 在开发机上打部署包（不含 `.env` 与密钥） |
| `deploy-to-server.ps1` | 在 Windows 上一条命令上传部署包并远程安装 |

本地整套联调：`cp .env.example .env`，把 `<random>` / `<random32>` 换成随机值、`<server-ip>` 换成 `localhost`，端口改成不冲突的值（例如 `ACP_HTTP_PORT=18080`、`N8N_EXPOSE_PORT=15678`，同时把两个 PUBLIC_URL 带上端口），生成 `secrets/jwt_private.pem` 与 `agentgateway/config.yaml` 后 `docker compose up -d`，再执行 `bash scripts/n8n-provision.sh`。

**给协调服务接模型。** 在服务器的 `deploy/.env` 中启用 `ACP_LLM_ENABLED=true`，填写
`ACP_LLM_MODEL` 和 `LLM_API_KEY`。使用兼容 Chat Completions 的供应商时，选
`LLM_PROVIDER=openAI`，将 `LLM_UPSTREAM_HOST` 设为它的 HTTPS 主机名（不含 `https://` 或
`/v1`）；需要指定推理强度时再设 `ACP_LLM_REASONING_EFFORT`，如 `xhigh`。
在 `deploy/` 运行 `bash scripts/render-gateway.sh`，用该部署原有的 Compose 参数依次重建
`coordinator`、`agentgateway` 容器。网关负责校验上游 TLS 并注入密钥；飞书和 n8n 不需要配置模型。
可在试点群分别用业务原话委托一件工作、咨询 ACP 的用途、查询已有任务进度，核对任务卡和回复。入站事件的 `payload.intent` 和 `intent_model` 记录模型判断。模型调用异常时，直接发送需求的人会收到重试提示。
