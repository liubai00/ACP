#!/usr/bin/env bash
# 打部署包：在仓库根目录执行 bash deploy/make-bundle.sh，产出 .local/dist/acp-<时间>.tar.gz
# 包里是源码 + 部署文件 + 接入程序二进制，不含 .env、密钥、node_modules、虚拟环境。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VER="$(date +%Y%m%d-%H%M)"
mkdir -p .local/dist
OUT=".local/dist/acp-${VER}.tar.gz"
items=(coordinator feishu-bridge board n8n deploy docs contracts README.md)
# 在 Windows 上编辑过的文件可能带 CRLF，到 Linux 上脚本会直接报错：发现就拒绝打包
crlf=$(find "${items[@]}" \( -name node_modules -o -name .venv -o -name dist -o -name __pycache__ \) -prune -o -type f \( -name '*.sh' -o -name '*.py' -o -name '*.yaml' -o -name '*.yml' -o -name '*.json' -o -name '*.tmpl' -o -name '*.conf' -o -name Caddyfile -o -name Dockerfile -o -name .env.example \) -print 2>/dev/null | while IFS= read -r f; do [[ "$(wc -c < "$f")" == "$(tr -d '\r' < "$f" | wc -c)" ]] || echo "$f"; done)
if [[ -n "$crlf" ]]; then
  echo "以下文件是 CRLF 换行，先转成 LF 再打包（例如 sed -i 's/\r$//' <文件>）：" >&2
  echo "$crlf" >&2
  exit 1
fi
[[ -d acp-link ]] && items+=(acp-link)
tar czf "$OUT" \
  --exclude='.venv' --exclude='node_modules' --exclude='board/dist' --exclude='__pycache__' \
  --exclude='.pytest_cache' --exclude='.ruff_cache' --exclude='*.pyc' \
  --exclude='deploy/.env' --exclude='deploy/secrets' --exclude='deploy/agentgateway/config.yaml' \
  --exclude='acp-link/.gocache' --exclude='acp-link/.gomodcache' \
  "${items[@]}"
echo "$OUT ($(du -h "$OUT" | cut -f1))"
