#!/bin/bash
# 首次初始化数据卷时为 n8n 建库建用户（数据卷已存在时不会再执行）
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE ROLE n8n LOGIN PASSWORD '${N8N_DB_PASSWORD}';
    CREATE DATABASE n8n OWNER n8n;
EOSQL
