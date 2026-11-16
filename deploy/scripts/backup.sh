#!/usr/bin/env bash
# 每日备份：两个数据库 + n8n 数据卷 + .env 与密钥。保留 30 天。
set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${ACP_BACKUP_DIR:-/var/backups/acp}"
cd "$DEPLOY_DIR"
mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
d="$(date +%F)"
docker compose exec -T postgres pg_dumpall -U acp --clean | gzip > "$BACKUP_DIR/pg-$d.sql.gz"
vol="$(docker volume ls -q | grep -E '(^|_)n8n_data$' | head -1)"
if [[ -n "$vol" ]]; then
  docker run --rm -v "$vol":/data:ro -v "$BACKUP_DIR":/backup alpine tar czf "/backup/n8n-data-$d.tgz" -C /data .
fi
tar czf "$BACKUP_DIR/config-$d.tgz" .env secrets agentgateway/config.yaml
chmod 600 "$BACKUP_DIR"/*-"$d".*
find "$BACKUP_DIR" -type f -mtime +30 -delete
echo "$(date -Is) backup ok $d -> $BACKUP_DIR"
