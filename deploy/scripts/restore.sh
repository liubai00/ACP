#!/usr/bin/env bash
# 从备份恢复：bash scripts/restore.sh 2026-11-09   （日期对应 /var/backups/acp 下的文件）
# 会停掉服务、清空并恢复数据库与 n8n 数据卷。恢复到新机器时先把 config-<日期>.tgz 解到 deploy/ 目录。
set -euo pipefail
d="${1:?用法：restore.sh <日期，如 2026-11-09>}"
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${ACP_BACKUP_DIR:-/var/backups/acp}"
cd "$DEPLOY_DIR"
[[ -f "$BACKUP_DIR/pg-$d.sql.gz" ]] || { echo "找不到 $BACKUP_DIR/pg-$d.sql.gz"; exit 1; }
read -r -p "将用 $d 的备份覆盖当前数据，确认？输入 yes 继续：" ok
[[ "$ok" == "yes" ]] || exit 1
docker compose down
for v in $(docker volume ls -q | grep -E '(^|_)(pg_data|n8n_data)$'); do docker volume rm "$v"; done
docker compose up -d postgres
until docker compose exec -T postgres pg_isready -U acp >/dev/null 2>&1; do sleep 2; done
gunzip -c "$BACKUP_DIR/pg-$d.sql.gz" | docker compose exec -T postgres psql -U acp -d postgres >/dev/null
if [[ -f "$BACKUP_DIR/n8n-data-$d.tgz" ]]; then
  vol="$(docker volume ls -q | grep -E '(^|_)n8n_data$' | head -1)"
  [[ -n "$vol" ]] || { docker compose create n8n >/dev/null; vol="$(docker volume ls -q | grep -E '(^|_)n8n_data$' | head -1)"; }
  docker run --rm -v "$vol":/data -v "$BACKUP_DIR":/backup alpine sh -c "cd /data && tar xzf /backup/n8n-data-$d.tgz"
fi
docker compose up -d
echo "恢复完成。注意：N8N_ENCRYPTION_KEY 必须与备份时一致，否则 n8n 凭证无法解密。"
