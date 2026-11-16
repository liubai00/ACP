# n8n 工作流

三条工作流，全部只用环境变量，不依赖 n8n 凭证，导入即可用：

| ID | 名称 | Webhook | 作用 |
| --- | --- | --- | --- |
| `acpFeishuEvents1` | ACP · 飞书事件 | `POST /webhook/feishu-events`（头 `X-Bridge-Token`） | 校验 feishu-bridge 转来的飞书事件并归一化，提交 `/api/events/feishu`，把卡片按钮的处理结果返回给事件桥 |
| `acpGitlabEvents1` | ACP · GitLab 回执 | `POST /webhook/gitlab`（头 `X-Gitlab-Token`） | 校验 GitLab Webhook 并归一化 push / MR / pipeline，提交 `/api/events/gitlab` |
| `acpNotifyOutbox1` | ACP · 通知出口 | `POST /webhook/acp-notify`（头 `X-ACP-Token`） | 协调服务器 outbox 投递到这里，调飞书发卡片 / 回复 / 更新卡片，或调 GitLab 写 MR 评论 |

修改方式：改 `build_workflows.py` → `python build_workflows.py` 重新生成 `workflows/*.json` → 服务器上 `bash deploy/scripts/n8n-provision.sh`。不要只在 n8n 界面里改，否则下次导入会被仓库版本覆盖。

工作流用到的环境变量由 `deploy/compose.yaml` 注入 n8n 主节点与 worker：`ACP_API_URL`、`ACP_CONNECTOR_TOKEN`、`ACP_NOTIFY_TOKEN`、`BRIDGE_FORWARD_TOKEN`、`GITLAB_WEBHOOK_TOKEN`、`GITLAB_URL`、`GITLAB_BOT_TOKEN`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_BASE_URL`，并需要 `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`。
