#!/bin/sh
set -e

# 每次启动先迁移数据库（只向前）
alembic upgrade head

# 首次部署可写入示例数据预览任务榜；用 acp-admin purge-demo 删除
if [ "${ACP_SEED_DEMO:-false}" = "true" ]; then
  acp-admin seed-demo || true
fi

exec "$@"
