#!/usr/bin/env bash
# 升级：先备份，再用新代码重建并重启。新代码包解压覆盖 /opt/acp 后执行：bash deploy/scripts/upgrade.sh
set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"
bash scripts/backup.sh
# 网关配置模板可能有变化，按当前 .env 重新生成
bash install.sh --no-docker-install
echo "升级完成。回滚：解压上一版代码包覆盖后再执行本脚本；数据库结构不兼容时用 scripts/restore.sh 恢复升级前的备份。"
