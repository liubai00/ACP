<!--
文档编号: ACP-DOC-002
版本: v1.1
日期: 2026-11-09
状态: 可执行；第 3、4、9、10、11 节现在可做，第 5 到 8 节待代码仓库 deploy/ 目录就绪
配套: ACP-DOC-001 v2.0 设计方案，ACP-DOC-005 v1.1 开发计划
在线可编辑版: https://claude.ai/artifact/JzAmGw3x3PNzqE1vPoJUjA
本文件为留存版，由在线版导出；修改请先改在线版，再导出覆盖本文件并升版本号。
-->

# ACP 云服务器部署手册

日期 2026-11-09 · 作者 Alex Morgan

文档编号 ACP-DOC-002 · 版本 v1.1 · 配套设计方案 ACP-DOC-001 v2.0 · 留存于项目仓库 docs/ 目录，变更记录见文末

## 1. 目标与范围

按本手册做完，一台云服务器上就跑起全部服务端组件：网关、协调服务器、队列模式的 n8n、飞书事件桥、任务榜和数据库，试点小组的四台电脑可以接入。读者是执行部署的你，前提是能以管理员身份登录云服务器、能管理飞书自建应用和自部署的 GitLab 实例。

**覆盖**：服务器初始化；docker compose 全套（Caddy、agentgateway、协调服务器、飞书事件桥、n8n 主节点与 worker、Redis、PostgreSQL、任务榜）；飞书与 GitLab 两侧的配置；公司内网放行；备份、升级、日常运维；验收清单。

**不覆盖**：开发者电脑上接入程序的安装（ACP-DOC-003）；n8n 工作流的内容（随代码仓库 n8n/ 目录交付，导入步骤在第 8 节）；Kubernetes 扩容部署，单机资源不足时再做。

**执行顺序**：第 3、4、9、10、11 节不依赖代码仓库，现在就可以做；第 5 到 8 节要等仓库 deploy/ 目录就绪后再做。手册里的配置文件是说明用副本，以仓库 deploy/ 目录中的文件为准，两者不一致时以仓库为准并回头修订本手册。

**约定**：示例域名 `acp.example.com`（平台）和 `n8n.acp.example.com`（n8n），替换成你的域名；命令默认在服务器上以 `acp` 用户执行，需要管理员权限的地方带 `sudo`；尖括号 `<...>` 表示要替换的值。

## 2. 部署总览

一台云服务器上的 docker compose，对外只开 443，80 只用于签发证书和跳转。Caddy 终结 TLS：A2A、MCP、REST 流量交给 agentgateway 验签和授权后再到协调服务器，登录、JWKS、健康检查和免登录测试端点直达协调服务器，其余路径是任务榜，n8n 走自己的域名。所有服务共用一个 PostgreSQL，n8n 的队列用 Redis。所有外部连接要么是别人连进 443，要么是服务器主动出站，开发者电脑不需要任何入站端口。

![部署拓扑 · 9 个容器，4 个外部方](images/06-部署拓扑.png)

*图：部署拓扑 · 9 个容器，4 个外部方*

进 443 的只有开发者电脑、浏览器和 GitLab Webhook；A2A、MCP、REST 先过 agentgateway 再到协调服务器；飞书事件和大模型调用由服务器主动出站，大模型调用经网关；n8n 调飞书与 GitLab 的 API 也是出站，图中以文字标注。

**容器清单**

| 容器 | 镜像 | 监听 | 作用 | 数据 |
| --- | --- | --- | --- | --- |
| caddy | caddy:2 | 80、443 对外 | TLS 自动签发与续期、按路径反向代理 | caddy\_data 卷（证书） |
| agentgateway | ghcr.io/agentgateway/agentgateway 固定 1.7.x | 3000 仅内部 | JWT 验签、MCP 工具 CEL 白名单、A2A 路由、代理大模型 API 并持有 key、访问日志 | 无状态，配置文件只读挂载 |
| coordinator | 仓库 coordinator/ 构建 | 8000 仅内部 | 确定性内核与协调 Agent：REST `/api`、A2A `/a2a`、MCP `/mcp`、Agent Card 与 JWKS、飞书 OAuth 与设备授权登录、定时任务 | postgres 的 acp 库 |
| feishu-bridge | 仓库 feishu-bridge/ 构建 | 无，只出站 | 维持到飞书的事件长连接，把事件原样转发给 n8n 的 Webhook | 无状态 |
| n8n | n8nio/n8n 固定版本 | 5678 仅内部 | 主节点：界面、Webhook 接收、触发器；建单流、CI 回执流、审批流、通知流 | postgres 的 n8n 库、n8n\_data 卷 |
| n8n-worker | 同 n8n 镜像，命令 worker | 无 | 队列模式下执行工作流，可加副本 | 无 |
| redis | redis:7-alpine | 6379 仅内部 | n8n 队列 | 不持久化 |
| board | 仓库 board/ 构建 | 80 仅内部 | 任务榜单页应用的静态文件 | 无 |
| postgres | postgres:16-alpine | 5432 仅内部 | acp 与 n8n 两个库 | pg\_data 卷 |

**Caddy 路由**

| 外部地址 | 转到 | 说明 |
| --- | --- | --- |
| `https://acp.example.com/auth/*`、`/.well-known/*`、`/healthz`、`/api/ping/stream` | coordinator:8000 直达 | 登录、JWKS、健康检查、免登录 SSE 测试，不经网关 |
| `https://acp.example.com/api/*`、`/a2a/*`、`/mcp/*` | agentgateway:3000，再到 coordinator:8000 | 网关验 JWT、按 CEL 过滤工具、改写 Agent Card 的 url |
| `https://acp.example.com/*` 其余 | board:80 | 单页应用，未命中文件时回退到 index.html |
| `https://n8n.acp.example.com/*` | n8n:5678 | n8n 界面与 Webhook；GitLab Webhook 地址是这个域名下的 `/webhook/gitlab` |

**数据流**

- 飞书到平台：feishu-bridge 用长连接收事件，带共享密钥 POST 到 n8n 内部地址 `http://n8n:5678/webhook/feishu-events`，n8n 归一化后调协调服务器 REST。
- 平台到飞书：n8n 用 HTTP Request 节点调飞书开放平台 API 发消息、更新卡片，tenant\_access\_token 由一个子工作流缓存。协调服务器不直接发飞书消息。
- GitLab 到平台：项目 Webhook 推到 `https://n8n.acp.example.com/webhook/gitlab`，n8n 校验 `X-Gitlab-Token` 后归一化，再调 `/api/events/gitlab`。
- 平台到 GitLab：n8n 用机器人账号令牌调 GitLab API 写 MR 评论和审批状态。平台不自动合并，合并由评审者在 GitLab 上点，合并事件再由 Webhook 回到平台关单。
- 开发者电脑到平台：接入程序出站 HTTPS 到 `acp.example.com`，A2A 订阅是一条 SSE 长连接；个人 Agent 的 MCP 调用走同一域名的 `/mcp`。
- 任务榜用户到平台：浏览器访问 `acp.example.com`，飞书 OAuth 登录，平台签发 JWT。
- 协调 Agent 到大模型：coordinator 经 agentgateway 的 /llm 路由出站调模型 API，key 只在网关，网关计量用量。
- 任务榜不直接接触飞书：它只和协调服务器的 REST 和 SSE 通信，登录也是跳到协调服务器的 OAuth 入口。无论动作来自任务榜还是飞书卡片，内核产生同一个事件，再由 n8n 统一发飞书通知。协调 Agent 只在自然语言进来时被内核叫醒，卡片按钮这类结构化动作不经过大模型。

**与设计方案的关系**

本手册与设计方案 ACP-DOC-001 v2.0 一致。飞书事件桥、n8n 队列模式、协调服务器单端口、设备授权登录、不自动合并 MR、大模型 key 只在网关、免登录 SSE 测试端点，都已写进 v2.0 正文，不再单列差异。

## 3. 部署前准备清单

下表全部就绪再开始第 4 节。最后一列为“是”的项不依赖代码仓库，现在就可以做。

| 项 | 要求 | 产出 | 现在就做 |
| --- | --- | --- | --- |
| 云服务器 | 推荐 8 核 16 GB、100 GB SSD 系统盘、带宽 5 Mbps 以上，Ubuntu 24.04 LTS；最低 4 核 8 GB 可跑试点 | 公网 IP，带 sudo 的登录账号 | 是 |
| 地域与备案 | 中国大陆地域的服务器对外提供 80/443 需要域名完成 ICP 备案，否则会被云厂商拦截；不想备案就选香港或海外地域，前提是公司内网和你们的 GitLab 都能访问到它 | 地域决定 | 是 |
| 域名 | 两条 A 记录指向服务器公网 IP：`acp.example.com`、`n8n.acp.example.com` | `dig +short` 能解析出 IP | 是 |
| 安全组 | 入站只开 22（来源限你的出口 IP）、80、443；出站全放 | 安全组规则 | 是 |
| 飞书自建应用 | 已有并授予了用户身份；按第 9 节补权限、事件、回调、机器人、消息快捷操作；全群监听模式需另申请敏感权限（可选） | App ID、App Secret | 是 |
| GitLab | 机器人账号 `acp-bot` 及其个人访问令牌；试点的两个项目；一个 Webhook Secret | 令牌、项目 ID | 是 |
| 大模型 key | 协调 Agent 首版即启用，key 必须有：提供商、模型名、接入地址（私有化或中转时）、key | `.env` 的 `LLM_API_KEY`，只进 agentgateway 容器 | 是 |
| 证书邮箱 | 给 Let's Encrypt 的联系邮箱，只用于到期提醒 | 一个邮箱 | 是 |
| 内网放行 | 把第 11 节的清单交给 IT | IT 回执 | 是 |
| 代码仓库 | ACP 仓库建在你们的 GitLab 上，服务器用只读的 Deploy Token 或部署密钥 clone | clone 地址与凭证 | 否，等仓库建好 |

两个容易踩的点：备案问题要在买服务器前定，换地域等于重装；大陆服务器拉 Docker Hub 镜像可能很慢或失败，第 4 节有镜像加速的配法。

## 4. 服务器初始化

用云厂商给的初始账号登录一次，做完本节后一律用 `acp` 用户操作。本节不依赖代码仓库。

**4.1 系统、时区与用户**

```bash
sudo apt update && sudo apt -y upgrade
sudo timedatectl set-timezone Asia/Shanghai
sudo timedatectl set-ntp true
sudo adduser --disabled-password --gecos "" acp
sudo usermod -aG sudo acp
sudo mkdir -p /home/acp/.ssh
sudo cp ~/.ssh/authorized_keys /home/acp/.ssh/
sudo chown -R acp:acp /home/acp/.ssh
sudo chmod 700 /home/acp/.ssh && sudo chmod 600 /home/acp/.ssh/authorized_keys
```

**4.2 SSH 只允许密钥登录**

新建 `/etc/ssh/sshd_config.d/acp.conf`：

```
PasswordAuthentication no
PermitRootLogin prohibit-password
```

先另开一个终端用 `ssh acp@<服务器IP>` 确认能登录，再执行 `sudo systemctl restart ssh`。

**4.3 防火墙**

```bash
sudo apt -y install ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from <你的出口IP> to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Docker 发布的端口会绕过 ufw，所以 compose 里只有 caddy 发布 80 和 443，其余容器一律不发布端口，安全组再挡一层。

**4.4 安装 Docker**

按 Docker 官方 apt 源安装，自带 compose 插件：

```bash
sudo apt -y install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker acp
```

大陆服务器若 `download.docker.com` 很慢，把上面两处地址换成云厂商的 docker-ce 镜像源。然后写 `/etc/docker/daemon.json`，镜像加速地址用云厂商控制台给的那条，海外服务器去掉 `registry-mirrors` 这行：

```json
{
  "registry-mirrors": ["https://<云厂商提供的镜像加速地址>"],
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "5" }
}
```

```bash
sudo systemctl restart docker
sudo systemctl enable docker
```

重新登录为 `acp` 用户后验证：`docker --version`、`docker compose version`、`docker run --rm hello-world`。

**4.5 目录**

```bash
sudo mkdir -p /opt/acp && sudo chown acp:acp /opt/acp
su - acp
mkdir -p /opt/acp/secrets /opt/acp/backups
chmod 700 /opt/acp/secrets
```

**4.6 自动安全更新**

```bash
sudo apt -y install unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

只开安全更新即可，Docker 和内核的大版本升级手动做。

## 5. 获取代码与目录结构

服务器只需要仓库的只读权限：在 GitLab 的 ACP 项目里建一个 Deploy Token（范围 `read_repository`），或者给服务器生成一对 SSH 密钥登记为项目的 Deploy Key。

```bash
cd /opt/acp
git clone https://<deploy-token-用户名>:<deploy-token>@<你们的GitLab域名>/<组>/acp.git src
cd src && git checkout <发布标签，例如 v0.1.0> && cd ..
bash src/deploy/install.sh
```

`install.sh` 把 `deploy/` 下的 `compose.yaml`、`caddy/`、`postgres/`、`scripts/` 复制到 `/opt/acp`，不会碰 `.env` 和 `secrets/`；以后每次升级都重跑它。

**仓库中与部署有关的部分**

```
acp/
├── coordinator/        协调服务器（Python），含 Dockerfile 与数据库迁移
├── feishu-bridge/      飞书长连接桥（Python），含 Dockerfile
├── board/              任务榜前端，含 Dockerfile（构建后由 nginx 提供静态文件）
├── acp-link/           接入程序（Go），装在开发者电脑，不部署在服务器
├── n8n/workflows/      n8n 工作流 JSON，第 8 节导入
├── deploy/
│   ├── compose.yaml
│   ├── .env.example
│   ├── install.sh
│   ├── caddy/Caddyfile
│   ├── postgres/initdb/01-n8n-db.sh
│   └── scripts/backup.sh  restore.sh  healthcheck.sh
└── docs/               本手册与其他文档
```

**服务器上的最终布局**

```
/opt/acp/
├── src/                仓库检出，只读使用
├── compose.yaml        由 install.sh 复制
├── .env                你手写，600
├── caddy/Caddyfile
├── postgres/initdb/
├── scripts/
├── secrets/            jwt_private.pem 等，700
└── backups/            每日备份
```

`docker compose` 的所有命令都在 `/opt/acp` 下执行，compose 的构建上下文指向 `./src/...`。

## 6. 配置文件

五个文件：`.env`、`secrets/jwt_private.pem`、`caddy/Caddyfile`、`agentgateway/config.yaml`、`compose.yaml`。后三个由 `install.sh` 从仓库复制，一般不用改；前两个你来写。以下内容是说明用副本，以仓库 `deploy/` 为准。

**6.1 生成密钥**

```bash
cd /opt/acp
openssl genrsa -out secrets/jwt_private.pem 2048
chmod 600 secrets/jwt_private.pem
openssl rand -hex 32    # 每个需要随机值的变量单独跑一次，不要复用
```

JWT 用 RS256，协调服务器从私钥推导公钥并在 `/.well-known/jwks.json` 公布，接入程序和将来的 agentgateway 都能离线验签。换私钥等于让所有人重新登录，不影响数据。

**6.2 .env**

```bash
cp src/deploy/.env.example .env && chmod 600 .env
```

```dotenv
# ---- 域名与证书 ----
ACP_DOMAIN=acp.example.com
N8N_DOMAIN=n8n.acp.example.com
ACME_EMAIL=<证书到期提醒邮箱>

# ---- PostgreSQL ----
POSTGRES_USER=acp
POSTGRES_PASSWORD=<openssl rand -hex 32>
POSTGRES_DB=acp
N8N_DB_PASSWORD=<openssl rand -hex 32>

# ---- 协调服务器 ----
ACP_PUBLIC_URL=https://acp.example.com
ACP_JWT_ISSUER=https://acp.example.com
ACP_JWT_PRIVATE_KEY_FILE=/run/secrets/jwt_private
ACP_SESSION_SECRET=<openssl rand -hex 32>
ACP_FEISHU_APP_ID=<飞书 App ID，cli_ 开头>
ACP_FEISHU_APP_SECRET=<飞书 App Secret>
ACP_FEISHU_CHAT_IDS=<试点群 chat_id，多个用逗号分隔>
ACP_FEISHU_INTAKE_MODE=at_mention,shortcut   # 可选值 at_mention、shortcut、all，逗号组合；all 需敏感权限
ACP_HEARTBEAT_TIMEOUT_MINUTES=30
ACP_AGENT_LEVEL_DEFAULT=L0                   # 协调 Agent 各场景的初始自主等级，上线后在管理页逐项调
ACP_LLM_BASE_URL=http://agentgateway:3000/llm  # 模型调用经网关，协调服务器不持有 key
ACP_LLM_MODEL=<模型名>
ACP_LOG_LEVEL=info

# ---- agentgateway（大模型 key 只在这里）----
LLM_API_KEY=<你提供的 key>
LLM_BASE_URL=                                # 官方地址留空；中转或私有化接入地址填这里

# ---- 飞书事件桥 ----
BRIDGE_FORWARD_URL=http://n8n:5678/webhook/feishu-events
BRIDGE_FORWARD_TOKEN=<openssl rand -hex 32>

# ---- n8n（队列模式，主节点和 worker 共用）----
N8N_ENCRYPTION_KEY=<openssl rand -hex 32>   # 丢了它，n8n 里所有凭证作废，务必单独备份
GENERIC_TIMEZONE=Asia/Shanghai
```

还有两个值不进 `.env`，但要生成并记在 `secrets/` 下：GitLab Webhook 的 Secret Token（第 10 节填进 GitLab，第 8 节填进 n8n 凭证），以及协调服务器给 n8n 签发的服务令牌（第 8 节生成）。

**6.3 Caddyfile**

```
{
    email {$ACME_EMAIL}
}

{$ACP_DOMAIN} {
    encode zstd gzip

    # 登录、JWKS、健康检查、免登录测试：直达协调服务器，不经网关
    @direct path /auth/* /.well-known/* /healthz /api/ping/stream
    handle @direct {
        reverse_proxy coordinator:8000 {
            flush_interval -1
        }
    }

    # 三个接口面：先过 agentgateway
    @gateway path /api/* /a2a/* /mcp/*
    handle @gateway {
        reverse_proxy agentgateway:3000 {
            flush_interval -1
        }
    }

    handle {
        reverse_proxy board:80
    }

    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options nosniff
        -Server
    }
}

{$N8N_DOMAIN} {
    encode zstd gzip
    reverse_proxy n8n:5678 {
        flush_interval -1
    }
}
```

`flush_interval -1` 让 SSE 和 n8n 的流式响应不被缓冲。证书由 Caddy 向 Let's Encrypt 自动申请和续期，前提是 80 和 443 从公网可达。

**6.4 compose.yaml**

```yaml
name: acp

x-n8n-env: &n8n-env
  N8N_ENCRYPTION_KEY: ${N8N_ENCRYPTION_KEY}
  DB_TYPE: postgresdb
  DB_POSTGRESDB_HOST: postgres
  DB_POSTGRESDB_PORT: 5432
  DB_POSTGRESDB_DATABASE: n8n
  DB_POSTGRESDB_USER: n8n
  DB_POSTGRESDB_PASSWORD: ${N8N_DB_PASSWORD}
  EXECUTIONS_MODE: queue
  QUEUE_BULL_REDIS_HOST: redis
  QUEUE_BULL_REDIS_PORT: 6379
  GENERIC_TIMEZONE: ${GENERIC_TIMEZONE}
  TZ: ${GENERIC_TIMEZONE}
  N8N_RUNNERS_ENABLED: "true"
  N8N_DIAGNOSTICS_ENABLED: "false"

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
      N8N_DB_PASSWORD: ${N8N_DB_PASSWORD}
    volumes:
      - pg_data:/var/lib/postgresql/data
      - ./postgres/initdb:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 6
    networks: [internal]

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
    networks: [internal]

  coordinator:
    build: ./src/coordinator
    image: acp/coordinator:local
    restart: unless-stopped
    depends_on:
      postgres: { condition: service_healthy }
    environment:
      ACP_DATABASE_URL: postgresql+psycopg://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      ACP_PUBLIC_URL: ${ACP_PUBLIC_URL}
      ACP_JWT_ISSUER: ${ACP_JWT_ISSUER}
      ACP_JWT_PRIVATE_KEY_FILE: ${ACP_JWT_PRIVATE_KEY_FILE}
      ACP_SESSION_SECRET: ${ACP_SESSION_SECRET}
      ACP_FEISHU_APP_ID: ${ACP_FEISHU_APP_ID}
      ACP_FEISHU_APP_SECRET: ${ACP_FEISHU_APP_SECRET}
      ACP_FEISHU_CHAT_IDS: ${ACP_FEISHU_CHAT_IDS}
      ACP_FEISHU_INTAKE_MODE: ${ACP_FEISHU_INTAKE_MODE}
      ACP_HEARTBEAT_TIMEOUT_MINUTES: ${ACP_HEARTBEAT_TIMEOUT_MINUTES}
      ACP_AGENT_LEVEL_DEFAULT: ${ACP_AGENT_LEVEL_DEFAULT}
      ACP_LLM_BASE_URL: ${ACP_LLM_BASE_URL}
      ACP_LLM_MODEL: ${ACP_LLM_MODEL}
      ACP_LOG_LEVEL: ${ACP_LOG_LEVEL}
      TZ: ${GENERIC_TIMEZONE}
    secrets: [jwt_private]
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/healthz')"]
      interval: 30s
      timeout: 5s
      retries: 3
    networks: [internal]

  agentgateway:
    image: ghcr.io/agentgateway/agentgateway:<仓库 compose 中锁定的 1.7.x 版本>
    restart: unless-stopped
    command: ["-f", "/etc/agentgateway/config.yaml"]
    environment:
      LLM_API_KEY: ${LLM_API_KEY}
      LLM_BASE_URL: ${LLM_BASE_URL}
    volumes:
      - ./agentgateway/config.yaml:/etc/agentgateway/config.yaml:ro
    depends_on: [coordinator]
    networks: [internal]

  feishu-bridge:
    build: ./src/feishu-bridge
    image: acp/feishu-bridge:local
    restart: unless-stopped
    depends_on: [n8n]
    environment:
      FEISHU_APP_ID: ${ACP_FEISHU_APP_ID}
      FEISHU_APP_SECRET: ${ACP_FEISHU_APP_SECRET}
      BRIDGE_FORWARD_URL: ${BRIDGE_FORWARD_URL}
      BRIDGE_FORWARD_TOKEN: ${BRIDGE_FORWARD_TOKEN}
      TZ: ${GENERIC_TIMEZONE}
    networks: [internal]

  n8n:
    image: n8nio/n8n:<仓库 compose 中锁定的 1.x 版本>
    restart: unless-stopped
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment:
      <<: *n8n-env
      N8N_HOST: ${N8N_DOMAIN}
      N8N_PROTOCOL: https
      N8N_PORT: 5678
      WEBHOOK_URL: https://${N8N_DOMAIN}/
      N8N_EDITOR_BASE_URL: https://${N8N_DOMAIN}/
      N8N_PROXY_HOPS: 1
    volumes:
      - n8n_data:/home/node/.n8n
      - ./src/n8n/workflows:/import:ro
    networks: [internal]

  n8n-worker:
    image: n8nio/n8n:<与 n8n 相同的版本>
    command: worker
    restart: unless-stopped
    depends_on: [n8n]
    environment:
      <<: *n8n-env
    networks: [internal]

  board:
    build: ./src/board
    image: acp/board:local
    restart: unless-stopped
    networks: [internal]

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    environment:
      ACP_DOMAIN: ${ACP_DOMAIN}
      N8N_DOMAIN: ${N8N_DOMAIN}
      ACME_EMAIL: ${ACME_EMAIL}
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on: [coordinator, agentgateway, board, n8n]
    networks: [internal]

secrets:
  jwt_private:
    file: ./secrets/jwt_private.pem

volumes:
  pg_data:
  n8n_data:
  caddy_data:
  caddy_config:

networks:
  internal:
```

要点：只有 caddy 发布端口；大模型 key 只在 agentgateway 容器的环境变量里；数据库密码只出现在 `.env` 和容器环境变量里；JWT 私钥以 compose secret 挂载到 `/run/secrets/jwt_private`；n8n 队列模式，主节点加一个 worker，需要更多并发时 `docker compose up -d --scale n8n-worker=2`。

**6.5 agentgateway/config.yaml**

网关配置随仓库交付，内容与设计方案第 7.1 节一致：监听 3000，`/a2a`、`/mcp`、`/api` 三条路由用协调服务器的 JWKS 验签，`/mcp` 加 CEL 工具白名单，`/llm` 路由代理大模型并从环境变量读 key。需要你改的只有两处：`issuer` 和 `audiences` 里的域名换成你的；`/llm` 路由的 `provider` 按你的模型提供商选（anthropic 或 openai 兼容）。改完 `docker compose restart agentgateway` 生效。验证方法在第 8.2 节。

## 7. 数据库初始化

两个库都在同一个 PostgreSQL 实例里：`acp` 归协调服务器，`n8n` 归 n8n。首次启动时自动建好，不需要手工建表。

- `acp` 库和 `acp` 用户由 postgres 镜像按 `POSTGRES_*` 变量创建。
- `n8n` 用户和库由 `postgres/initdb/01-n8n-db.sh` 创建，内容如下，只在数据卷为空的首次启动执行一次。
- 协调服务器容器启动时自动执行数据库迁移（`alembic upgrade head`），再启动服务；升级版本时同样自动迁移。

```bash
#!/bin/bash
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE ROLE n8n LOGIN PASSWORD '${N8N_DB_PASSWORD}';
    CREATE DATABASE n8n OWNER n8n;
EOSQL
```

验证（第 8 节启动之后）：

```bash
docker compose exec postgres psql -U acp -d acp -c '\dt'          # 应看到 tasks、events、members 等表
docker compose exec postgres psql -U acp -d postgres -c '\l'      # 应看到 acp 与 n8n 两个库
```

如果数据卷不是全新的（例如先前试启动过），初始化脚本不会再跑，手工补：

```bash
docker compose exec postgres psql -U acp -d postgres -c "CREATE ROLE n8n LOGIN PASSWORD '<N8N_DB_PASSWORD>'; CREATE DATABASE n8n OWNER n8n;"
```

手动执行迁移（排查问题时用）：`docker compose run --rm coordinator alembic upgrade head`。

## 8. 启动与验证

**8.1 构建与启动**

```bash
cd /opt/acp
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f --tail=100 coordinator
```

`ps` 里所有服务应为 `running`，postgres、redis、coordinator 显示 `healthy`，n8n 和 n8n-worker 都在。coordinator 日志里应看到迁移完成和监听 8000 的记录，agentgateway 日志里应看到四条路由加载。

**8.2 外部检查**

在你的电脑上执行：

```bash
curl -s https://acp.example.com/healthz                              # {"status":"ok",...}
curl -s https://acp.example.com/.well-known/jwks.json | head -c 200         # 含 keys
curl -sI https://acp.example.com/ | head -1                           # HTTP/2 200，任务榜
curl -sI https://n8n.acp.example.com/ | head -1                       # HTTP/2 200，n8n
curl -s -o /dev/null -w '%{http_code}\n' https://acp.example.com/api/tasks   # 401，网关拦下无令牌请求
curl -s https://acp.example.com/a2a/.well-known/agent-card.json | head -c 400   # 经网关的 Agent Card，url 应为公网域名
curl -N -sS --max-time 35 https://acp.example.com/api/ping/stream      # 30 秒内收到一行 event: ping
```

证书签发要几十秒，`caddy` 日志出现 `certificate obtained successfully` 后再测。

**8.3 首个管理员**

浏览器打开 `https://acp.example.com`，用飞书登录。第一个成功登录的用户自动成为管理员，之后用命令行给他人授权：

```bash
docker compose exec coordinator acp-admin list-members
docker compose exec coordinator acp-admin grant-role --member <成员ID> --role admin
```

飞书登录依赖第 9 节的重定向 URL 已登记，先做第 9 节的 9.1 到 9.4 再回来。

**8.4 n8n 初始化**

1. 打开 `https://n8n.acp.example.com`，由你亲自创建 owner 账号并开启两步验证（Settings → Personal）。
2. 生成协调服务器给 n8n 的服务令牌，输出保存到 `secrets/n8n_service_token`：

```bash
docker compose exec coordinator acp-admin issue-service-token --sub n8n --role connector > secrets/n8n_service_token
chmod 600 secrets/n8n_service_token
```

3. 导入工作流：

```bash
docker compose exec -u node n8n n8n import:workflow --separate --input=/import
```

4. 在 n8n 的 Credentials 里按下表建凭证，名称要和工作流里引用的一致：

| 凭证名 | 类型 | 值 | 用在哪 |
| --- | --- | --- | --- |
| acp-service-token | Header Auth，名 `Authorization`，值 `Bearer <服务令牌>` | `secrets/n8n_service_token` | 所有调用协调服务器 REST 的节点 |
| bridge-token | Header Auth，名 `X-Bridge-Token` | `.env` 的 `BRIDGE_FORWARD_TOKEN` | `feishu-events` Webhook 节点 |
| gitlab-webhook-token | Header Auth，名 `X-Gitlab-Token` | 你生成的 Webhook Secret（第 10 节同一个值） | `gitlab` Webhook 节点 |
| gitlab-bot | GitLab API（n8n 内置），服务器填你们的 GitLab 地址 | `acp-bot` 的个人访问令牌 | 写 MR 评论、设置审批 |
| feishu-app | Header Auth 不适用，用 n8n 的 Variables 存 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` | 飞书应用凭证 | 取 tenant\_access\_token 的子工作流 |

5. 逐个打开工作流，确认凭证已绑定，然后激活：`feishu-events`（建单与卡片按钮）、`gitlab`（CI 与 MR 回执）、`approvals`（审批）、`notify`（通知与巡检提醒）。

**8.5 启动飞书事件桥并开通长连接**

飞书控制台只有在应用已有长连接客户端在线时才允许把订阅方式改成“长连接”，所以顺序是：先确认 `feishu-bridge` 容器在跑并且日志里有 `connected`，再去控制台做第 9 节的 9.5。

```bash
docker compose logs --tail=50 feishu-bridge
```

**8.6 端到端冒烟**

在试点群里 @机器人 说一句“测试建单”。预期：任务榜出现一条新任务，群里收到一张任务卡片。再在任一试点项目推一个 `acp/<任务号>-test` 分支，任务详情的时间线应出现 Push 事件。两条都通，服务端就算部署完成，后面是开发者电脑接入（ACP-DOC-003）。

## 9. 飞书自建应用配置

在飞书开放平台开发者后台操作，应用已经存在。9.1 到 9.4 和 9.8 现在就能做；9.5 要等服务器上的 feishu-bridge 起来（第 8.5 节）；9.6 每次改完权限或事件都要做一次。

**9.1 凭证**

凭证与基础信息 → 记下 App ID 和 App Secret，填进 `.env` 的 `ACP_FEISHU_APP_ID` 和 `ACP_FEISHU_APP_SECRET`。

**9.2 开启机器人能力**

添加应用能力 → 机器人 → 启用。名字建议叫“ACP 协调”，群里 @它 就是建单入口。

**9.3 权限**

权限管理 → 开通下表权限。标识以控制台显示为准；后面添加事件和回调时控制台若提示还缺权限，按提示补齐。

| 权限 | 标识 | 用途 |
| --- | --- | --- |
| 获取用户基本信息 | contact:user.base:readonly | OAuth 登录拿姓名、头像、open\_id |
| 获取与发送单聊、群组消息 | im:message | 发任务卡片、回复 |
| 以应用的身份发消息 | im:message:send\_as\_bot | 机器人主动通知 |
| 接收群聊中 @机器人 消息事件 | im:message.group\_at\_msg:readonly | 群里 @机器人 建单 |
| 读取用户发给机器人的单聊消息 | im:message.p2p\_msg:readonly | 私聊问进度 |
| 获取群组信息 | im:chat:readonly | 识别试点群 |
| 获取群组中所有消息（可选） | im:message.group\_msg | 全群监听模式；敏感权限，需企业管理员审批，不开不影响其他功能 |

**9.4 OAuth 重定向 URL**

安全设置 → 重定向 URL → 添加 `https://acp.example.com/auth/feishu/callback`。开发联调期间可以再加一条 `http://127.0.0.1:8000/auth/feishu/callback`，上线前删掉。

**9.5 事件与回调（长连接）**

先确认服务器上 `feishu-bridge` 日志有 `connected`（第 8.5 节），否则控制台不让保存长连接方式。

1. 事件与回调 → 事件配置 → 订阅方式选“使用长连接接收事件”→ 保存。
2. 添加事件 → “接收消息 v2.0”（`im.message.receive_v1`）。
3. 回调配置 → 同样选长连接 → 添加“卡片回传交互”（`card.action.trigger`）。

长连接模式不需要填请求地址、Verification Token 和 Encrypt Key，服务器也不需要被飞书反向访问。

**9.5 补充：消息快捷操作与全群监听**

应用功能 → 消息快捷操作 → 新建，名称“ACP 建单”，触发方式选回调（走已配置的长连接），可用范围选群聊。保存并发布版本后，群里任意消息的更多菜单会出现“ACP 建单”。事件名以控制台显示为准，bridge 原样转发，n8n 的 `feishu-events` 工作流按事件类型分流。

全群监听模式是可选项：权限管理里申请“获取群组中所有消息”，这是敏感权限，需企业管理员审批通过并重新发布版本；开启后把 `.env` 的 `ACP_FEISHU_INTAKE_MODE` 加上 `all`，协调 Agent 会对疑似需求发确认卡，不自动建单。不开则只有 @机器人 和快捷操作两种进单方式。

**9.6 发布版本**

版本管理与发布 → 创建版本 → 可用范围先选试点小组成员（或全员）→ 申请发布 → 企业管理员在管理后台审核通过。权限和事件的变更只在发布后生效。

**9.7 机器人入群**

试点群 → 设置 → 群机器人 → 添加机器人 → 选这个应用。然后在群里 @它 说一句，服务器上 `docker compose logs feishu-bridge` 应看到这条事件，n8n 的 `feishu-events` 工作流应有一次执行记录。

**9.8 自定义机器人（告警用）**

在你自己的运维群（或试点群）再加一个“自定义机器人”，得到一条 Webhook 地址，存到服务器 `secrets/ops_webhook`（600），第 14 节的健康巡检用它报警。它不依赖应用和 n8n，平台整体挂了也能发出来。

## 10. GitLab 配置

**10.1 机器人账号**

管理员区域 → 用户 → 新建普通用户 `acp-bot`，邮箱用一个能收信的地址，设好密码后不再用它登录。把它加入两个试点项目，角色 Developer：写 MR 评论和设置审批状态需要它，Maintainer 不给。

以 `acp-bot` 身份（或管理员代为）创建个人访问令牌：Preferences → Access Tokens → 范围 `api`，有效期 1 年，到期前在 n8n 的 `gitlab-bot` 凭证里换新。值记到服务器 `secrets/gitlab_bot_token`（600）。

**10.2 Webhook**

在服务器上生成 Secret：`openssl rand -hex 32 | tee /opt/acp/secrets/gitlab_webhook_token`。然后每个试点项目 Settings → Webhooks → Add new webhook：

| 字段 | 值 |
| --- | --- |
| URL | `https://n8n.acp.example.com/webhook/gitlab` |
| Secret token | 上面生成的值，和 n8n 的 `gitlab-webhook-token` 凭证一致 |
| Trigger | Push events（分支过滤可填通配符 `acp/*`）、Merge request events、Pipeline events |
| Enable SSL verification | 勾选 |

保存后点 Test → Push events，Recent events 里应显示 200（前提是 n8n 的 `gitlab` 工作流已激活）。

**10.3 出站请求**

GitLab 管理员区域 → Settings → Network → Outbound requests：确认允许 Webhook 访问公网；若开了域名白名单，加上 `n8n.acp.example.com`。若 GitLab 本身限制了访问来源 IP，把云服务器的出口 IP 加进去，n8n 要调它的 API。

**10.4 ACP 代码仓库**

- 新建项目 `acp`（放在新建的 `acp` 组或现有组下），默认分支 `main`，设为受保护分支：Maintainer 可合并，其他人走 MR。
- Settings → Repository → Deploy tokens → 建一个只有 `read_repository` 的 Deploy Token，给服务器 clone 用（第 5 节）。
- 开发机器的推送用你本机 git 已有的 GitLab 凭证，不需要额外账号。
- 部署版本用标签 `v0.x.y` 标记，第 13 节按标签升级。

**10.5 可选：分支命名规则**

试点项目 Settings → Repository → Push rules → Branch name：`^(main|develop|release/.*|hotfix/.*|acp/.*)$`，按你们现有分支习惯调整。不做也不影响平台，只是防止手误的分支名匹配不到任务。

## 11. 公司内网放行与代理

开发者电脑只需要一条出站 HTTPS，不需要任何入站端口。下面的清单可以直接转给 IT。

**11.1 给 IT 的清单**

| 方向 | 源 | 目的 | 端口与协议 | 用途 |
| --- | --- | --- | --- | --- |
| 出站 | 试点开发者的 4 台电脑 | `acp.example.com`（服务器公网 IP） | TCP 443，HTTPS | 接入程序的 A2A 订阅（SSE 长连接）、MCP 调用、任务榜页面 |
| 出站 | 同上 | 你们的 GitLab | 既有 | 推分支、开 MR，和现在一样 |
| 出站 | 同上 | Claude、Codex 等服务 | 既有 | 个人 Agent 自己的通路，和现在一样 |
| 入站 | 无 | 开发者电脑 | 无 | 平台从不主动连开发者电脑 |
| 入站 | GitLab 服务器 | `n8n.acp.example.com` | TCP 443 | Webhook，已确认可达 |

另附三点要求：

1. 到 `acp.example.com` 的 HTTPS 连接空闲超时不低于 90 秒（接入程序每 30 秒一次心跳），且不要缓冲响应体；否则 SSE 会被反复切断，表现为接入程序频繁重连。
2. 若内网出口做 TLS 解密，要么把 `acp.example.com` 加入免解密名单，要么把公司根证书装进开发者电脑的系统信任库；接入程序也支持在配置里指定 CA 文件。
3. 若内网强制走 HTTP 代理，提供代理地址和认证方式；接入程序读 `HTTPS_PROXY` 和 `NO_PROXY` 环境变量，或在配置文件的 `proxy` 字段填写。

**11.2 连通性测试**

在一台内网开发者电脑上执行。Windows 的 PowerShell 里要写 `curl.exe`，写 `curl` 会调到 Invoke-WebRequest。

```bash
curl -sS https://acp.example.com/healthz
curl -N -sS --max-time 95 https://acp.example.com/api/ping/stream
```

第一条返回 `{"status":"ok"}`。第二条是专门的免登录 SSE 测试端点，应每 30 秒打印一行 `event: ping`，到 95 秒自行退出。如果在 60 秒左右就断开报错，就是中间设备的空闲超时，拿着这个结果找 IT。

走代理时：

```bash
HTTPS_PROXY=http://<代理地址>:<端口> curl -N -sS --max-time 95 https://acp.example.com/api/ping/stream
```

```powershell
$env:HTTPS_PROXY = "http://<代理地址>:<端口>"; curl.exe -N -sS --max-time 95 https://acp.example.com/api/ping/stream
```

## 12. 备份与恢复

**12.1 要备份的东西**

| 内容 | 位置 | 频率 | 丢了会怎样 |
| --- | --- | --- | --- |
| 两个数据库 | postgres 容器 | 每日 | 任务、成员、事件、n8n 工作流与凭证全丢 |
| n8n 数据卷 | `acp_n8n_data` | 每日 | 工作流在库里，卷里主要是本地配置，可重建 |
| `N8N_ENCRYPTION_KEY` | `.env` | 一次性，离线保存 | n8n 内所有凭证无法解密，要全部重填 |
| `.env` 与 `secrets/` | `/opt/acp` | 每次修改后 | 重新生成全部密钥，所有人重新登录，飞书与 GitLab 凭证重填，大模型 key 重填 |
| Redis | `redis` 容器 | 不需要 | 只是 n8n 队列，重启后未完成的执行会重跑，有幂等保护 |
| Caddy 证书 | `acp_caddy_data` | 不需要 | 自动重新申请 |

**12.2 每日自动备份**

`scripts/backup.sh` 随仓库交付，内容如下：

```bash
#!/bin/bash
set -euo pipefail
cd /opt/acp
set -a; . ./.env; set +a
d=$(date +%F)
docker compose exec -T postgres pg_dumpall -U "$POSTGRES_USER" --clean | gzip > "backups/pg-$d.sql.gz"
docker run --rm -v acp_n8n_data:/data:ro -v /opt/acp/backups:/backup alpine tar czf "/backup/n8n-data-$d.tgz" -C /data .
tar czf "backups/config-$d.tgz" .env secrets
find backups -type f -mtime +30 -delete
echo "$(date -Is) backup ok $d"
```

`acp` 用户的 crontab（`crontab -e`）：

```
30 2 * * * /opt/acp/scripts/backup.sh >> /opt/acp/backups/backup.log 2>&1
```

备份留在同一台机器上只能防误操作，防不了机器没了。至少每周把 `backups/` 同步到另一处：云厂商对象存储（用其命令行工具或 rclone），或者 `scp` 到你的办公电脑。`N8N_ENCRYPTION_KEY` 和 `jwt_private.pem` 另外抄一份放进密码管理器。

**12.3 恢复**

```bash
cd /opt/acp
docker compose down
docker volume rm acp_pg_data acp_n8n_data
docker compose up -d postgres
until docker compose exec postgres pg_isready -U acp; do sleep 2; done
gunzip -c backups/pg-<日期>.sql.gz | docker compose exec -T postgres psql -U acp -d postgres
docker run --rm -v acp_n8n_data:/data -v /opt/acp/backups:/backup alpine sh -c 'cd /data && tar xzf /backup/n8n-data-<日期>.tgz'
docker compose up -d
```

恢复到全新机器时先做第 4 到 6 节，`.env` 和 `secrets/` 从 config 备份解出来，`N8N_ENCRYPTION_KEY` 必须和备份时一致。导入 SQL 时出现 `role "n8n" already exists` 一类提示可以忽略，是初始化脚本先建过。

第一次部署完成后做一次恢复演练，没演练过的备份不算备份。

## 13. 升级与回滚

**升级**

```bash
cd /opt/acp
scripts/backup.sh
cd src && git fetch --tags && git checkout <新标签> && cd ..
bash src/deploy/install.sh
docker compose build --pull
docker compose up -d
docker compose ps
curl -s https://acp.example.com/healthz
docker compose logs -f --since 5m coordinator n8n
```

coordinator 启动时自动迁移数据库，迁移只向前，所以升级前的备份是回滚的唯一依据。n8n 的版本号写在仓库的 compose 里，随 `install.sh` 一起更新，只在 1.x 大版本内升，n8n 自己迁库。服务端升级后，协调服务器下发接入程序的最低版本要求，开发者电脑上的接入程序会提示更新。

**回滚**

```bash
cd /opt/acp/src && git checkout <上一个标签> && cd ..
bash src/deploy/install.sh
docker compose build
docker compose up -d
```

若新版本改了数据库结构导致旧版本起不来，按第 12.3 节用升级前的备份恢复，再启动旧版本。

## 14. 日常运维与监控

| 事项 | 命令或位置 | 频率 |
| --- | --- | --- |
| 看日志 | `docker compose logs -f --tail=200 <服务名>` | 出问题时 |
| 容器状态 | `docker compose ps`；重启单个服务 `docker compose restart <服务名>` | 出问题时 |
| 磁盘 | `df -h /`、`docker system df`；`docker image prune -f` 清旧镜像 | 每月 |
| 证书 | Caddy 自动续期，`docker compose logs caddy` 搜 `renew`；前提是 80 和 443 一直开着 | 告警时看 |
| 时间同步 | `timedatectl`，NTP 应为 active；JWT 校验对时间敏感 | 每月 |
| 系统更新 | 安全更新自动；`sudo apt upgrade` 手动，重启前先 `docker compose down` | 每季 |
| 备份 | `backups/backup.log` 最后一行是今天 | 每周 |
| 平台自检 | 任务榜管理页：在线 Agent、积压任务、最近失败的 Webhook | 每天看一眼 |

**健康巡检告警**

`scripts/healthcheck.sh` 随仓库交付，每 5 分钟跑一次，失败时通过飞书群自定义机器人（第 9.8 节）通知你，不依赖 n8n：

```bash
#!/bin/bash
url=https://acp.example.com/healthz
hook=$(cat /opt/acp/secrets/ops_webhook)
if ! curl -fsS --max-time 10 "$url" >/dev/null; then
  curl -sS -X POST "$hook" -H 'Content-Type: application/json' \
    -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"ACP 健康检查失败 $(date '+%m-%d %H:%M') $url\"}}" >/dev/null
fi
```

```
*/5 * * * * /opt/acp/scripts/healthcheck.sh
```

磁盘使用超过 80%、备份超过 36 小时没更新这两项也在同一个脚本里一起报，细节以仓库脚本为准。Grafana 那套等团队规模上来再上，试点期这些够用。

## 15. 故障排查速查表

| 现象 | 先看 | 常见原因与处理 |
| --- | --- | --- |
| 浏览器打不开 `acp.example.com` 或证书错误 | `docker compose logs caddy` | DNS 未生效；80 端口被安全组挡住导致签证失败；大陆服务器未备案被拦截 |
| `/healthz` 报 502 或 coordinator 反复重启 | `docker compose logs coordinator` | 数据库未就绪或密码不对；迁移失败；`secrets/jwt_private.pem` 不存在或权限不对 |
| 带令牌访问 `/api` 仍返回 401 或 403 | `docker compose logs agentgateway` | JWKS 地址不可达（coordinator 未起）；配置里的 issuer 与 `ACP_JWT_ISSUER` 不一致；403 多半是 CEL 规则把该工具过滤掉了 |
| Agent 看不到某个 MCP 工具 | `agentgateway/config.yaml` 的 rules | 该角色不在规则里，按设计方案第 7.3 节权限矩阵核对；工具名带 `<server>-<port>_` 前缀 |
| 飞书里 @机器人 没反应 | `docker compose logs feishu-bridge`；n8n 的执行记录 | 长连接未建立（订阅方式没选长连接、权限没发布）；事件未添加；`BRIDGE_FORWARD_TOKEN` 和 n8n 凭证不一致；工作流未激活；该群不在 `ACP_FEISHU_CHAT_IDS` 里 |
| 飞书登录回调报错 | `docker compose logs coordinator` | 重定向 URL 未在飞书安全设置登记；App Secret 错；`ACP_PUBLIC_URL` 与实际域名不一致 |
| GitLab Webhook 测试返回 4xx 或 5xx | GitLab Webhook 页的 Recent events；n8n 执行记录 | Secret Token 不一致；`gitlab` 工作流未激活；n8n 的 `WEBHOOK_URL` 配错 |
| n8n 工作流触发了但一直排队不执行 | `docker compose ps n8n-worker`；`docker compose logs n8n-worker redis` | worker 没起或 Redis 不通；worker 的 `N8N_ENCRYPTION_KEY` 与主节点不一致 |
| 接入程序连上又断，或任务榜显示 Agent 时在线时离线 | 接入程序日志；`docker compose logs coordinator` | 内网代理切断空闲连接（第 11 节）；JWT 过期未刷新；服务器或开发者电脑时间不同步 |
| 协调 Agent 不出建议卡 | `docker compose logs coordinator agentgateway` | `/llm` 路由的 key 或 provider 配错；`ACP_LLM_MODEL` 不存在；该场景等级被设为关闭 |
| n8n 打开提示凭证解密失败 | `docker compose logs n8n` | `N8N_ENCRYPTION_KEY` 变了；恢复时没用原 key |
| 任务半天没动，状态卡在 working | 任务榜详情页心跳时间；对应开发者的接入程序 | 开发者电脑休眠或关机，30 分钟无心跳后自动回收并通知；未回收则看 coordinator 定时任务日志 |
| 磁盘满 | `df -h`；`docker system df`；`du -sh /opt/acp/backups` | 日志未轮转（查 `daemon.json`）；备份未清理；镜像残留 |
| 容器里时间或时区不对 | `date`；`docker compose exec coordinator date` | `GENERIC_TIMEZONE` 未设；宿主机 NTP 未开 |

## 16. 安全基线检查表

上线前逐项打勾，以后每季度复核一次。

- [ ] SSH 仅密钥登录，root 不能用密码，22 端口限来源 IP
- [ ] 安全组和 ufw 只开 22、80、443；compose 里只有 caddy 发布端口
- [ ] `.env` 为 600、`secrets/` 为 700，属主 `acp`，两者都不在 git 里
- [ ] PostgreSQL、Redis、n8n、agentgateway、coordinator、board 均未暴露宿主机端口（`docker compose ps` 的 PORTS 列只有 caddy 有值）
- [ ] 不带令牌访问 `/api/tasks` 返回 401，说明网关在链路上
- [ ] agentgateway 的 CEL 规则与设计方案第 7.3 节权限矩阵一致，`ask_agent` 只对 agent\_caller 角色可见
- [ ] 大模型 key 只在 agentgateway 容器的环境变量里，coordinator 的环境里没有 key
- [ ] n8n 已建 owner 并开启两步验证，未开放注册
- [ ] GitLab 机器人账号角色不高于 Developer，令牌有有效期并记了到期日
- [ ] 飞书 App Secret 只出现在 `.env` 和 n8n 的 Variables 里
- [ ] 协调 Agent 各场景的自主等级为初始值（全 L0 或只读），调高需管理员操作
- [ ] 协调服务器未设置任何开发期变量（`ACP_DEV_*` 一律不出现在服务器 `.env`）
- [ ] 飞书重定向 URL 里没有 `127.0.0.1` 这条
- [ ] 自动安全更新和 NTP 都开着
- [ ] 备份在跑，并且做过一次恢复演练
- [ ] `N8N_ENCRYPTION_KEY` 和 `jwt_private.pem` 在密码管理器里有副本

## 17. 部署验收清单

全部打勾即服务端部署完成，可以开始给试点开发者装接入程序。

- [ ] `https://acp.example.com/healthz` 返回 ok，证书有效
- [ ] 经网关的 Agent Card 和 JWKS 都能访问，Agent Card 里的 url 是公网域名
- [ ] 不带令牌访问 `/api/tasks` 返回 401，登录后任务榜能正常列出任务
- [ ] 飞书登录任务榜成功，首个用户是管理员
- [ ] n8n 四条工作流已导入、凭证齐全、全部激活；n8n-worker 在跑，执行记录显示由 worker 处理
- [ ] 飞书控制台长连接状态正常；群里 @机器人 一句话，任务榜出现任务并收到卡片；在一条消息上点“ACP 建单”同样建单
- [ ] 协调 Agent 对新需求给出结构化建议卡（说明网关 `/llm` 路由和 key 正常）
- [ ] GitLab Webhook 测试事件返回 200；推送 `acp/` 开头的分支后，任务时间线出现事件
- [ ] 一台内网开发者电脑上 `curl -N` 测试端点连续收到 3 次心跳不断
- [ ] 备份脚本手动跑一次成功，`backups/` 下有三个当天文件
- [ ] 健康巡检告警手动触发一次（暂时停掉 coordinator），飞书收到通知
- [ ] 第 16 节全部打勾

## 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.1 | 2026-11-09 | 配合设计方案 v2.0 取消分阶段：agentgateway 首版即上（新增 6.5 节与 Caddy 分流），n8n 改队列模式加 Redis 与 worker，大模型 key 只在网关，飞书权限表增加全群消息与消息快捷操作，故障表、安全基线、验收清单相应增补；删去“第一阶段”措辞 |
| v1.0 | 2026-11-09 | 首版：单机 docker compose 部署，17 节正文加部署拓扑图 |
