#!/usr/bin/env bash
# 部署后冒烟测试：bash deploy/scripts/smoke-test.sh
# 只读检查 + 两条不产生数据的事件链路（飞书未知事件、GitLab 非 acp/ 分支推送都会被记录为“已忽略”）。
set -uo pipefail
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"
env_get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
PUB="$(env_get ACP_PUBLIC_URL)"; PUB="${PUB%/}"
N8N="$(env_get N8N_PUBLIC_URL)"; N8N="${N8N%/}"
pass=0; fail=0
check() {  # check 名称 期望 实际
  if [[ "$3" == *"$2"* ]]; then printf '  \033[32m通过\033[0m %s\n' "$1"; pass=$((pass+1)); else printf '  \033[31m失败\033[0m %s（期望含 %s，实际 %s）\n' "$1" "$2" "${3:0:200}"; fail=$((fail+1)); fi
}
echo "目标：$PUB  n8n：$N8N"
check "健康检查" '"status":"ok"' "$(curl -s --max-time 10 "$PUB/healthz")"
check "JWKS 公钥" '"kty":"RSA"' "$(curl -s --max-time 10 "$PUB/.well-known/jwks.json")"
check "Agent Card" 'subscribe_assignments' "$(curl -s --max-time 10 "$PUB/.well-known/agent-card.json")"
check "无令牌访问 API 被网关拦截" '401' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PUB/api/me")"
check "任务榜首页" '200' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PUB/")"
login="$(curl -s --max-time 10 -X POST "$PUB/auth/local" -H 'content-type: application/json' -d "{\"username\":\"$(env_get ACP_ADMIN_USERNAME)\",\"password\":\"$(env_get ACP_ADMIN_PASSWORD)\"}")"
TOK="$(printf '%s' "$login" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
check "引导管理员登录" 'eyJ' "$TOK"
check "带令牌经网关访问 API" '200' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Authorization: Bearer $TOK" "$PUB/api/me")"
tools="$(curl -s --max-time 15 -H "Authorization: Bearer $TOK" -H 'Accept: application/json, text/event-stream' -H 'content-type: application/json' "$PUB/mcp" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
check "MCP 工具列表（经网关）" 'list_tasks' "$tools"
check "SSE 测试端点" 'event: ping' "$(curl -s -N --max-time 3 "$PUB/api/ping/stream")"
fs="$(curl -s --max-time 20 -X POST "$N8N/webhook/feishu-events" -H 'content-type: application/json' -H "X-Bridge-Token: $(env_get BRIDGE_FORWARD_TOKEN)" -d "{\"header\":{\"event_id\":\"smoke-$(date +%s)\",\"event_type\":\"acp.smoke_test\"},\"event\":{}}")"
check "飞书事件链路（bridge → n8n → 协调服务器）" '"ok":true' "$fs"
gl="$(curl -s --max-time 20 -X POST "$N8N/webhook/gitlab" -H 'content-type: application/json' -H "X-Gitlab-Token: $(env_get GITLAB_WEBHOOK_TOKEN)" -H "X-Gitlab-Event-UUID: smoke-$(date +%s)" -d '{"object_kind":"push","ref":"refs/heads/smoke-test","project":{"path_with_namespace":"smoke/test"}}')"
check "GitLab 事件链路（n8n → 协调服务器）" '"ok":true' "$gl"
check "GitLab 直连通路" '"ok":true' "$(curl -s --max-time 10 -X POST "$PUB/api/hooks/gitlab" -H 'content-type: application/json' -H "X-Gitlab-Token: $(env_get GITLAB_WEBHOOK_TOKEN)" -d '{"object_kind":"push","ref":"refs/heads/smoke-test","project":{"path_with_namespace":"smoke/test"}}')"
check "接入程序下载目录" '200' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PUB/downloads/")"
echo "通过 $pass 项，失败 $fail 项"
[[ $fail -eq 0 ]]
