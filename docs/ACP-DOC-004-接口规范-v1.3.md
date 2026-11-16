<!--
文档编号: ACP-DOC-004
版本: v1.3
日期: 2026-11-10
状态: 与代码一致
来源: 本文件由仓库 contracts/API.md 复制而来，接口变更先改 contracts/API.md，再同步本文件并升版本号。
-->

# ACP 接口规范

文档编号 ACP-DOC-004 · 版本 v1.3 · 日期 2026-11-10 · 依据 ACP-DOC-001 v2.1

本文件是 coordinator、board（任务榜）、acp-link（接入程序）、n8n 工作流共同遵守的接口约定。
三方都按这里实现；有冲突时以本文件为准，改动先改这里。正式接口规范 ACP-DOC-004 由本文件整理而来。

## 0. 通用约定

- 同一个对外域名（或 IP）下按路径分：`/api/*`、`/a2a*`、`/mcp*`、`/auth/*`、`/.well-known/*`、`/healthz` 属于 coordinator；其余路径属于 board 单页应用。
- board 自己的路由**不得**以 `/api`、`/a2a`、`/mcp`、`/auth`、`/.well-known`、`/healthz` 开头。登录回调页用 `/login/callback`，设备授权确认页用 `/device`。
- 认证：`Authorization: Bearer <JWT>`。SSE（浏览器 EventSource）无法带头，改用查询参数 `?access_token=<JWT>`。
- JWT：RS256，`iss` = 平台对外地址，`aud` = `acp`。claims：`sub`（成员 id，uuid 字符串）、`name`、`roles`（数组）、`act`（`member` | `agent` | `service`）、`task_id`（仅 agent 令牌）、`agent_id`（仅 agent 令牌）、`exp`、`iat`、`jti`。公钥在 `/.well-known/jwks.json`。
- 角色：`member`（所有登录者都有）、`developer`、`reviewer`、`admin`、`connector`（n8n 服务令牌）、`agent_caller`（可发起 Agent 求助）。
- 时间一律 ISO 8601 带时区（UTC，`2026-11-09T08:00:00Z`）。
- 错误响应：HTTP 4xx/5xx，body `{"error": "<code>", "message": "<人话>"}`。常见 code：`unauthorized`、`forbidden`、`not_found`、`invalid_state`、`validation_error`、`conflict`、`rate_limited`。
- 分页：查询参数 `page`（从 1 开始）、`page_size`（默认 20，最大 100），返回 `Paged<T> = { items: T[], total: number, page: number, page_size: number }`。
- 任务编号：数字 `id`，展示用 `key` = `ACP-<id>`；分支名 `acp/<id>-<英文或拼音摘要>`。

## 1. 数据类型（TypeScript 记法）

```ts
type TaskState = "submitted" | "working" | "input-required" | "auth-required"
               | "completed" | "failed" | "canceled" | "rejected";
type TaskType = "requirement" | "subtask" | "help";
type Priority = "low" | "normal" | "high" | "urgent";
type Source = "feishu" | "board" | "agent" | "api" | "gitlab";

type MemberRef = { id: string; name: string; avatar_url: string | null };

type Member = MemberRef & {
  roles: string[]; team: string | null; gitlab_username: string | null;
  feishu_open_id: string | null; is_active: boolean;
  created_at: string; last_login_at: string | null;
  stats: { open: number; working: number; completed_30d: number };
};

type Agent = {
  id: string; member: MemberRef; name: string; kind: string;   // kind: claude-code | codex | echo | other
  version: string | null; host: string | null;
  skills: string[]; repos: string[]; max_concurrency: number; auto_accept_help: boolean;
  status: "online" | "busy" | "offline";
  last_heartbeat_at: string | null; current_task_ids: number[]; created_at: string;
};

type TaskSummary = {
  id: number; key: string; title: string; state: TaskState; type: TaskType;
  priority: Priority; source: Source; repos: string[]; skills: string[]; labels: string[];
  creator: MemberRef | null; assignee: MemberRef | null;
  assignee_agent: { id: string; name: string; kind: string } | null;
  suggested_assignee: MemberRef | null;
  parent_id: number | null; root_id: number; depth: number; children_count: number;
  mr_count: number; mr_merged: number;
  ci_status: "none" | "pending" | "running" | "success" | "failed";
  created_at: string; updated_at: string; state_changed_at: string; closed_at: string | null;
  is_demo: boolean;
};

type MergeRequest = {
  id: number; repo: string; branch: string; iid: number | null; url: string | null;
  state: "none" | "opened" | "merged" | "closed";
  pipeline_status: "none" | "pending" | "running" | "success" | "failed" | "canceled";
  updated_at: string;
};

type Approval = {
  id: number; gate: "claim" | "merge" | "high_risk";
  status: "pending" | "approved" | "rejected";
  requested_by: MemberRef | null; decided_by: MemberRef | null; comment: string | null;
  created_at: string; decided_at: string | null;
};

type TimelineItem = {
  id: string;                       // "e<事件id>" 或 "m<消息id>"
  kind: "event" | "message";
  type: string;                     // 事件类型，如 task.created / state.changed / mr.opened；消息为 "message"
  at: string;
  actor: { type: "member" | "agent" | "system" | "connector"; id: string | null; name: string };
  text: string;                     // 已格式化的中文描述或消息正文
  data: Record<string, unknown> | null;
};

type Suggestion = {
  id: number; task_id: number | null;
  scenario: "intake" | "dispatch" | "help_routing" | "input_answer" | "ci_triage" | "qa" | "patrol";
  level: "L0" | "L1" | "L2";
  status: "proposed" | "accepted" | "rejected" | "executed" | "undone";
  summary: string; payload: Record<string, unknown>;
  created_at: string; decided_by: MemberRef | null;
};

type TaskDetail = TaskSummary & {
  description: string; source_ref: Record<string, unknown>;
  merge_requests: MergeRequest[]; approvals: Approval[]; children: TaskSummary[];
  timeline: TimelineItem[];        // 按时间升序
  suggestions: Suggestion[];
  allowed_actions: string[];       // 当前用户可做：claim accept decline cancel message input
                                   // request_approval approve reject complete edit assign
};

type SourceEvent = {
  id: number; source: "feishu" | "gitlab" | "board" | "agent" | "system";
  kind: string; summary: string; status: "processed" | "ignored" | "error";
  task_id: number | null; task_key: string | null; at: string;
};
```

## 2. 认证接口（coordinator，前缀 `/auth`）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /auth/providers` | `{feishu: boolean, local: boolean, dev: boolean}`，登录页据此显示按钮 |
| `GET /auth/feishu/login?redirect=<board 内路径>` | 302 到飞书授权页 |
| `GET /auth/feishu/callback?code=&state=` | 换取身份后 302 到 `/login/callback#token=<JWT>&redirect=<路径>` |
| `POST /auth/local` `{username, password}` | 本地管理员登录（引导用），`{token, member}` |
| `POST /auth/dev` `{name, admin?: boolean}` | 仅开发模式，`{token, member}`；首次登录且 `admin` 为 true 时额外授予 reviewer 与 admin |
| `POST /auth/refresh`（Bearer） | `{token}` |
| `POST /auth/device/code` `{client, hostname}` | `{device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval}`，`verification_uri` 指向 board 的 `/device` |
| `POST /auth/device/token` `{device_code}` | 未确认：HTTP 400 `{"error":"authorization_pending"}`；过期 `expired_token`；成功 `{access_token, token_type:"Bearer", expires_in, member}` |
| `POST /api/device/approve`（Bearer，board 调） | `{user_code}` → `{ok: true, client, hostname}` |

## 3. REST 接口（前缀 `/api`，均需 Bearer）

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/me` | | `{member: Member}` |
| `GET /api/overview?days=14` | | 见下 |
| `GET /api/tasks` | 查询：`q state(逗号分隔) assignee(id/me/none) creator source repo priority type parent page page_size sort(-updated_at/created_at/priority...)` | `Paged<TaskSummary>` |
| `POST /api/tasks` | `{title, description?, repos?, priority?, skills?, labels?, parent_id?, suggested_assignee_id?}` | `TaskDetail` |
| `GET /api/tasks/{id}` | | `TaskDetail` |
| `PATCH /api/tasks/{id}` | `{title?, description?, repos?, priority?, labels?, skills?}` | `TaskDetail` |
| `GET /api/tasks/{id}/stream` | SSE；`event: timeline`（data=TimelineItem）、`event: task`（data=TaskSummary）、每 25 秒 `: ping` | |
| `POST /api/tasks/{id}/claim` | | `TaskDetail` |
| `POST /api/tasks/{id}/assign` | `{member_id}` | `TaskDetail`（发派工卡片给该成员） |
| `POST /api/tasks/{id}/accept` | | `TaskDetail`（被推荐人接受 = 认领） |
| `POST /api/tasks/{id}/decline` | `{reason?}` | `TaskDetail` |
| `POST /api/tasks/{id}/cancel` | `{reason?}` | `TaskDetail` |
| `POST /api/tasks/{id}/complete` | `{note?}` | `TaskDetail`（发布者确认验收，仅无 MR 的任务） |
| `POST /api/tasks/{id}/messages` | `{content}` | `TimelineItem` |
| `POST /api/tasks/{id}/input` | `{content}` | `TaskDetail`（回答待补充，状态回 working） |
| `POST /api/tasks/{id}/request-approval` | `{gate: "merge" \| "high_risk", note?}` | `TaskDetail` |
| `POST /api/approvals/{id}/decide` | `{decision: "approve" \| "reject", comment?}` | `TaskDetail` |
| `POST /api/suggestions/{id}/accept` / `reject` / `undo` | | `Suggestion`（任务状态已变、建议里的动作都无法落地时，`accept` 返回 409 `invalid_state`，可改为 `reject`） |
| `GET /api/members` | `q page page_size` | `Paged<Member>` |
| `PATCH /api/members/{id}`（admin） | `{roles?, team?, gitlab_username?, is_active?}` | `Member` |
| `GET /api/agents` | | `{items: Agent[]}` |
| `GET /api/sources` | | `{items: [{source, label, status: "connected"\|"idle"\|"error"\|"unconfigured", last_event_at, events_24h, events_7d, detail}]}` |
| `GET /api/sources/events` | `source page page_size` | `Paged<SourceEvent>` |
| `GET /api/settings` | | `{autonomy: Record<场景, "off"\|"L0"\|"L1"\|"L2">, intake_modes: string[], feishu_chat_ids: string[], notify_mode, llm_enabled, version, public_url, n8n_url}` |
| `PUT /api/settings`（admin） | 上述字段的部分更新 | 同 GET |
| `GET /api/workflows` | | `{enabled, reason?, message?, n8n_url, workflows: [{id, name, active, updated_at}], executions: [{id, workflow_name, status, started_at, stopped_at, mode}]}`；`executions` 是最新 100 次；`enabled` 为 false 时 `reason` 取 `no_key`（没配 Key）、`unauthorized`（Key 无效或过期）、`unreachable`（连不上 n8n）、`error`，`message` 是给人看的说明 |

`GET /api/overview` 响应：

```ts
{
  counts: { total: number; open: number; by_state: Record<TaskState, number> };
  kpis: { created_7d: number; completed_7d: number; avg_lead_time_hours: number | null;
          ci_pass_rate: number | null; agents_online: number; members_active: number };
  trend: { date: string; created: number; completed: number }[];      // 最近 days 天，按日
  by_source: { source: Source; count: number }[];
  by_assignee: { member: MemberRef; open: number; working: number; completed: number }[];
  by_repo: { repo: string; open: number; total: number }[];
  recent: (TimelineItem & { task_id: number; task_key: string; task_title: string })[]; // 最近 20 条
  attention: TaskSummary[];   // 需要关注：待补充、待审批、长时间无进展
}
```

### 个人访问令牌（成员本人，Agent 令牌不可调用）

用于手动给 Claude Code / Codex 配置平台 MCP。令牌是带 `pat: true` 声明的成员 JWT，每次请求都会检查是否已撤销。

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/me/tokens` | | `{items: [{id: string, name, created_at, expires_at, revoked_at: string \| null}]}`，按创建时间倒序 |
| `POST /api/me/tokens` | `{name?: string, days?: number}`（`days` 1–90，默认 90） | `{id, token, expires_at, mcp_url}`；`token` 只返回这一次 |
| `DELETE /api/me/tokens/{id}` | | `{ok: true}`；本人或管理员可撤销，立即失效 |

### 接入程序专用（成员令牌）

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `POST /api/agents/register` | `{name, kind, version, host, skills, repos, max_concurrency, auto_accept_help}` | `Agent`（同一成员同名视为同一 Agent，覆盖更新） |
| `POST /api/agents/{id}/heartbeat` | `{status: "online"\|"busy", current_task_ids: number[]}` | `{ok: true, min_link_version: string}` |

Agent 的并发占用只算“进行中且本轮执行未结束”的任务：Agent 用 `report_progress` 交了分支或 MR（`artifacts` 非空）后，任务留在进行中等 CI 与审批，但不再占名额，也不参与 30 分钟无心跳回收；重新派工（`ci_failed`、`approval_rejected`、`input_answered`）时重新计入。`Agent.current_task_ids` 按同一口径返回。
| `POST /api/tasks/{id}/agent-token` | `{agent_id}` | `{token, expires_at, mcp_url}`；只发给该任务负责人的 Agent，有效期为任务超时上限（默认 2 小时） |

### 连接器（n8n 服务令牌，角色 connector）

| 方法与路径 | 请求 |
| --- | --- |
| `POST /api/events/feishu` | `{event_id, event_type, kind: "message"\|"card_action"\|"shortcut"\|"other", chat_id, chat_type, message_id, sender_open_id, text, mentions: [{open_id, name, is_bot}], action: {value, operator_open_id, open_message_id} \| null, raw}` → `{ok, queued?, duplicate?, task_id?, reply?}`。启用模型时，自然语言消息先持久化并返回 `queued: true`，处理完成后通过 outbox 回复原消息。 |
| `POST /api/events/gitlab` | `{event_uuid, kind: "push"\|"merge_request"\|"pipeline", project, project_url, branch, sha, mr_iid, mr_url, mr_state, mr_action, pipeline_status, user, raw}` → `{ok, task_id?}` |

### 直连入口（无 JWT，靠共享密钥，n8n 不可用时的备用通路）

| 方法与路径 | 校验 |
| --- | --- |
| `POST /api/hooks/gitlab` | `X-Gitlab-Token` = `GITLAB_WEBHOOK_TOKEN`，body 为 GitLab 原始 Webhook |
| `POST /api/hooks/feishu-bridge` | `X-Bridge-Token` = `BRIDGE_FORWARD_TOKEN`，body 为 feishu-bridge 转发的原始事件 |
| `GET /api/ping/stream` | 无需认证；SSE，每 30 秒 `event: ping`，95 秒后服务端结束 |
| `GET /healthz` | 无需认证；`{status: "ok", version, db: "ok"}` |

## 4. A2A（`POST /a2a`，JSON-RPC 2.0，需 Bearer）

Agent Card：`GET /.well-known/agent-card.json`（经网关时同时可在 `/a2a/.well-known/agent-card.json` 取到）。
方法名同时接受 A2A 1.0 写法和旧写法：`SendMessage`=`message/send`，`SendStreamingMessage`=`message/stream`，`GetTask`=`tasks/get`，`CancelTask`=`tasks/cancel`，`SubscribeToTask`=`tasks/resubscribe`。

技能由 `params.message.metadata.skill` 指定：

| 技能 | 方法 | metadata | 结果 |
| --- | --- | --- | --- |
| `subscribe_assignments` | SendStreamingMessage | `{agent_id}` | SSE 流。第一条 `result` 为 Task `{kind:"task", id:"sub-<agent_id>", status:{state:"working"}}`；之后每条推送都是 `{kind:"status-update", taskId:"sub-<agent_id>", status:{state:"working", message:{role:"agent", parts:[{kind:"data", data:<推送内容>}]}}, final:false}`，推送内容见下表。断线重连后未确认（未回 ack）的派工会重发 |
| `report_progress` | SendMessage | `{task_id, agent_id, state?: "working"\|"input-required"\|"completed"\|"failed", kind?: "ack"\|"progress"\|"tool"\|"conclusion"\|"artifact", artifacts?: [{name, repo, branch, url}]}`，消息正文在 `parts[].text` | Task |
| `request_input` | SendMessage | `{task_id, agent_id, question}` | Task（状态 input-required） |
| `create_task` | SendMessage | `{parent_id, title, description, target_skill?, target_member_id?}` | Task（求助子任务；深度≤2、每个根任务≤5 个子任务、禁止环，超出返回 state=rejected） |

订阅流的推送内容（`data.type`）：

| type | 字段 | 接入程序要做的 |
| --- | --- | --- |
| `assignment` | `task: TaskSummary`, `reason: "new" \| "input_answered" \| "approval_rejected" \| "ci_failed" \| "approved_continue"` | 执行任务。同一任务可能多次派发（补充信息后、评审驳回后、CI 失败后），远端已有 `acp/<id>-…` 分支时在其上继续 |
| `revoked` | `task_id`, `reason` | 任务被取消或回收，停止正在运行的 Agent |
| `message` | `task_id`, `from`, `text` | 有人在任务里留言，记录即可 |
| `task_state` | `task: TaskSummary` | 任务状态变化，记录即可 |
| `ping` | | 心跳，每 30 秒一条，忽略 |

A2A Task 形状：`{kind:"task", id:"<任务 id>", contextId:"root-<root_id>", status:{state, timestamp, message?}, artifacts:[{artifactId, name, parts:[{kind:"text", text}]}], metadata:{key, title}}`。

SSE 每条 `data:` 是一个完整 JSON-RPC 响应 `{jsonrpc:"2.0", id, result: <Task|status-update>}`。

## 5. MCP（`/mcp`，Streamable HTTP，需 Bearer）

工具（经 agentgateway 聚合后名字会带前缀，以 `endsWith` 匹配）：

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `list_tasks` | `state? assignee? repo? q? limit?` | 列任务摘要 |
| `get_task` | `task_id` | 详情含时间线 |
| `claim_task` | `task_id` | 成员本人认领 |
| `update_task` | `task_id, state?, repo?, branch?, mr_url?, note?` | 负责人更新 |
| `post_message` | `task_id, content` | 发消息 |
| `ask_agent` | `task_id, title, description, target_skill?, target_member_id?` | 发起求助子任务 |
| `request_approval` | `task_id, gate, note?` | 触发审批 |
| `list_agents` | | 在线 Agent 与技能 |

业务错误（未登录、令牌已撤销、无权限、状态不允许等）以工具结果返回：`isError: true`，`structuredContent` 为 `{error, message}`，`content[0].text` 是同一内容的 JSON 文本。

## 6. 其他

- 交互式接口文档（OpenAPI）：`GET /api/docs`，机器可读版 `GET /api/openapi.json`。
- `GET /api/settings` 另含 `llm_model`、`feishu_enabled` 两个只读字段。
- `report_progress` 的 `state: "completed"` 只对没有 MR 的求助子任务直接结束；普通任务以 MR 合并为准。
- 速率限制：每个令牌每分钟 600 次（`ACP_RATE_LIMIT_PER_MINUTE`），超出返回 429 `rate_limited`。

## 7. 通知出口（coordinator → n8n 或直连）

coordinator 把要发的通知写进 outbox，后台按 `ACP_NOTIFY_MODE` 投递：

- `n8n`：`POST {N8N_NOTIFY_URL}`，头 `X-ACP-Token: <ACP_NOTIFY_TOKEN>`，body 为下面任一种。
- `direct`：coordinator 自己调飞书和 GitLab 接口。
- `log`：只记录不发送（未配置时的默认）。

```ts
{ kind: "feishu.card", receive_id_type: "chat_id" | "open_id", receive_id: string, card: object, update_message_id?: string }
{ kind: "feishu.text", receive_id_type: "chat_id" | "open_id", receive_id: string, text: string, reply_to_message_id?: string }
{ kind: "gitlab.comment", project: string, mr_iid: number, body: string }
```

飞书卡片按钮的 `value` 统一为 `{acp: 1, action: "<动作>", task_id?: number, approval_id?: number, suggestion_id?: number, payload?: object}`，动作：
`claim accept decline approve reject suggestion_accept suggestion_reject suggestion_undo create_from_message ignore`。

## 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.0 | 2026-11-09 | 首版：认证、REST、A2A、MCP、通知出口与数据类型，与第一版代码一致 |
| v1.1 | 2026-11-09 | 补个人访问令牌接口、开发登录的 admin 参数；明确 Agent 交 MR 后释放并发名额 |
| v1.2 | 2026-11-10 | 采纳已失效的协调建议返回 409；MCP 工具的业务错误统一带 `isError: true`；`GET /api/workflows` 返回最新 100 次执行，不可用时带 `reason` 与 `message` |
| v1.3 | 2026-11-10 | 飞书自然语言入站增加异步受理和重复投递回执，处理结果回复原消息 |
