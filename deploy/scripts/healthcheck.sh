#!/usr/bin/env bash
# 健康巡检：平台、磁盘、备份。失败时发到飞书群自定义机器人（deploy/secrets/ops_webhook，可选）。
set -uo pipefail
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"
url="$(grep -E '^ACP_PUBLIC_URL=' .env | cut -d= -f2-)"
hook_file="secrets/ops_webhook"
problems=()
if ! docker compose exec -T coordinator python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=5).status==200 else 1)" >/dev/null 2>&1; then
  problems+=("协调服务器健康检查失败")
fi
if ! curl -fsS --max-time 10 "${url%/}/healthz" >/dev/null 2>&1; then
  problems+=("对外地址 ${url}/healthz 访问失败（Caddy 或网络）")
fi
for svc in postgres redis agentgateway n8n n8n-worker feishu-bridge board caddy; do
  state="$(docker compose ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk -v s="$svc" '$1==s{print $2}')"
  [[ "$state" == "running" ]] || problems+=("容器 ${svc} 状态：${state:-不存在}")
done
use="$(df -P / | awk 'NR==2{gsub("%","",$5);print $5}')"
[[ "$use" -lt 80 ]] || problems+=("磁盘使用 ${use}%")
latest="$(find "${ACP_BACKUP_DIR:-/var/backups/acp}" -name 'pg-*.sql.gz' -mmin -2160 2>/dev/null | head -1)"
[[ -n "$latest" ]] || problems+=("36 小时内没有新备份")
if [[ ${#problems[@]} -gt 0 ]]; then
  msg="ACP 巡检 $(date '+%m-%d %H:%M')：$(IFS='；'; echo "${problems[*]}")"
  echo "$msg"
  if [[ -s "$hook_file" ]]; then
    curl -fsS -X POST "$(cat "$hook_file")" -H 'Content-Type: application/json' \
      -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"${msg//\"/\\\"}\"}}" >/dev/null 2>&1 || true
  fi
  exit 1
fi
echo "$(date -Is) ok"
