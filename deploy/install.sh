#!/usr/bin/env bash
# ACP 一键安装 / 升级脚本（在云服务器上以 root 运行）。
#
# 用法（在解压后的 acp 目录里）：
#   bash deploy/install.sh --host <服务器IP>            # 只有 IP，先用 HTTP 跑起来
#   bash deploy/install.sh --domain acp.example.com --n8n-domain n8n.acp.example.com --email you@example.com
# 可选：
#   --demo            写入示例数据（任务榜预览用，之后 acp-admin purge-demo 删除）
#   --cn-mirror       国内服务器：Docker 安装与 PyPI / npm 使用国内镜像
#   --no-docker-install  不自动安装 Docker
#
# 重复运行是安全的：已存在的 .env、密钥、数据卷都会保留，只会补齐缺失项、重建镜像、重启服务。
set -euo pipefail

HOST=""; DOMAIN=""; N8N_DOMAIN=""; EMAIL=""; DEMO="false"; CN="false"; INSTALL_DOCKER="true"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2;;
    --domain) DOMAIN="$2"; shift 2;;
    --n8n-domain) N8N_DOMAIN="$2"; shift 2;;
    --email) EMAIL="$2"; shift 2;;
    --demo) DEMO="true"; shift;;
    --cn-mirror) CN="true"; shift;;
    --no-docker-install) INSTALL_DOCKER="false"; shift;;
    -h|--help) sed -n '2,15p' "$0"; exit 0;;
    *) echo "未知参数 $1"; exit 1;;
  esac
done

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
cd "$DEPLOY_DIR"

log() { printf '\033[1;34m[ACP]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[ACP] 失败：\033[0m%s\n' "$*"; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行（或 sudo bash deploy/install.sh ...）"

# ---------------------------------------------------------------- 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  [[ "$INSTALL_DOCKER" == "true" ]] || die "未安装 Docker"
  log "安装 Docker ..."
  if [[ "$CN" == "true" ]]; then
    curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun
  else
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || die "缺少 docker compose 插件（apt/yum install docker-compose-plugin）"
command -v openssl >/dev/null 2>&1 || die "缺少 openssl"

# ---------------------------------------------------------------- 2. .env
rand() { openssl rand -hex "${1:-24}"; }
if [[ ! -f .env ]]; then
  log "生成 .env ..."
  cp .env.example .env
  while grep -q '<random32>' .env; do
    sed -i "0,/<random32>/s//$(rand 32)/" .env
  done
  while grep -q '<random>' .env; do
    sed -i "0,/<random>/s//$(rand 24)/" .env
  done
fi
setenv() {  # setenv KEY VALUE —— 覆盖或追加 .env 里的一项
  local k="$1" v="$2"
  if grep -qE "^${k}=" .env; then sed -i "s|^${k}=.*|${k}=${v}|" .env; else echo "${k}=${v}" >> .env; fi
}
getenv() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }

if [[ -n "$DOMAIN" ]]; then
  [[ -n "$N8N_DOMAIN" ]] || N8N_DOMAIN="n8n.${DOMAIN}"
  setenv ACP_PUBLIC_URL "https://${DOMAIN}"
  setenv N8N_PUBLIC_URL "https://${N8N_DOMAIN}"
  setenv ACP_SITE_ADDRESS "${DOMAIN}"
  setenv N8N_SITE_ADDRESS "${N8N_DOMAIN}"
  setenv N8N_HOST "${N8N_DOMAIN}"
  setenv N8N_PROTOCOL https
  setenv N8N_SECURE_COOKIE true
elif [[ -n "$HOST" ]]; then
  setenv ACP_PUBLIC_URL "http://${HOST}"
  setenv N8N_PUBLIC_URL "http://${HOST}:5678"
  setenv ACP_SITE_ADDRESS ":80"
  setenv N8N_SITE_ADDRESS ":5678"
  setenv N8N_HOST "${HOST}"
  setenv N8N_PROTOCOL http
  setenv N8N_SECURE_COOKIE false
elif grep -q '<server-ip>' .env; then
  HOST="$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
  log "未指定 --host/--domain，使用探测到的地址 ${HOST}"
  sed -i "s/<server-ip>/${HOST}/g" .env
fi
[[ -n "$EMAIL" ]] && setenv ACME_EMAIL "$EMAIL"
[[ "$DEMO" == "true" ]] && setenv ACP_SEED_DEMO true
if [[ "$CN" == "true" ]]; then
  setenv PIP_INDEX_URL https://mirrors.cloud.tencent.com/pypi/simple
  setenv NPM_REGISTRY https://registry.npmmirror.com
fi
chmod 600 .env

# ---------------------------------------------------------------- 3. 密钥
mkdir -p secrets && chmod 700 secrets
if [[ ! -f secrets/jwt_private.pem ]]; then
  log "生成 JWT 签名私钥 ..."
  openssl genrsa -out secrets/jwt_private.pem 2048 2>/dev/null
fi
chown 10001:10001 secrets/jwt_private.pem && chmod 600 secrets/jwt_private.pem
getenv ACP_ADMIN_PASSWORD > secrets/admin-password.txt && chmod 600 secrets/admin-password.txt

# ---------------------------------------------------------------- 4. 网关配置
bash scripts/render-gateway.sh

# ---------------------------------------------------------------- 5. 构建与启动
log "构建镜像（首次约 5~10 分钟）..."
docker compose build
log "启动数据库与队列 ..."
docker compose up -d postgres redis
log "导入并激活 n8n 工作流 ..."
bash scripts/n8n-provision.sh || log "n8n 工作流导入失败，可稍后重试：bash scripts/n8n-provision.sh"
log "启动全部服务 ..."
docker compose up -d
log "等待协调服务器就绪 ..."
for i in $(seq 1 60); do
  if docker compose exec -T coordinator python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=3).status==200 else 1)" >/dev/null 2>&1; then
    break
  fi
  sleep 3
done
docker compose ps

# ---------------------------------------------------------------- 6. 定时任务：备份与健康巡检
chmod +x scripts/*.sh
mkdir -p /etc/cron.d
CRON_FILE=/etc/cron.d/acp
cat > "$CRON_FILE" <<EOF
# ACP 平台：每日 02:30 备份；每 5 分钟健康巡检
30 2 * * * root ${DEPLOY_DIR}/scripts/backup.sh >> /var/log/acp-backup.log 2>&1
*/5 * * * * root ${DEPLOY_DIR}/scripts/healthcheck.sh >> /var/log/acp-health.log 2>&1
EOF
chmod 644 "$CRON_FILE"

PUB="$(getenv ACP_PUBLIC_URL)"; N8N_PUB="$(getenv N8N_PUBLIC_URL)"
cat <<EOF

================================================================
 ACP 已启动
   任务榜：      ${PUB}
   n8n：         ${N8N_PUB}   （首次打开请创建 owner 账号）
   引导管理员：  用户名 $(getenv ACP_ADMIN_USERNAME)，密码在 ${DEPLOY_DIR}/secrets/admin-password.txt
   健康检查：    curl ${PUB}/healthz
 下一步：
   1. 云厂商安全组放行 TCP 80、443、5678（只有 IP 时 5678 用于 n8n 与 GitLab Webhook）
   2. 按 docs/ACP-DOC-002 配置飞书与 GitLab，把凭证填进 ${DEPLOY_DIR}/.env 后执行：
        cd ${DEPLOY_DIR} && docker compose up -d
   3. 开发者电脑安装 acp-link，见 docs/ACP-DOC-003
================================================================
EOF
