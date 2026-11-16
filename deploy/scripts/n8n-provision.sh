#!/usr/bin/env bash
# 导入并激活 ACP 的 n8n 工作流（n8n/workflows/*.json）。重复执行安全，工作流内容以仓库为准覆盖。
# n8n 1.12x 起有工作流版本：命令行导入不会生成版本记录，所以这里补一条版本记录并直接激活，再重启 n8n 让 Webhook 生效。
set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"
docker compose up -d postgres redis >/dev/null
until docker compose exec -T postgres pg_isready -U acp >/dev/null 2>&1; do sleep 2; done
docker compose run --rm n8n-import
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U n8n -d n8n <<'SQL'
INSERT INTO workflow_history ("versionId", "workflowId", authors, "createdAt", "updatedAt", nodes, connections, name, autosaved)
SELECT "versionId", id, 'acp-provision', now(), now(), nodes, connections, name, false
FROM workflow_entity WHERE id LIKE 'acp%'
ON CONFLICT ("versionId") DO UPDATE SET nodes = EXCLUDED.nodes, connections = EXCLUDED.connections, "updatedAt" = now();
UPDATE workflow_entity SET active = true, "activeVersionId" = "versionId" WHERE id LIKE 'acp%';
SELECT id, name, active FROM workflow_entity WHERE id LIKE 'acp%' ORDER BY id;
SQL
docker compose up -d n8n n8n-worker >/dev/null
docker compose restart n8n n8n-worker >/dev/null
echo "n8n 工作流已导入并激活"
