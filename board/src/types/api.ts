/**
 * ACP 接口类型，逐字对应 contracts/API.md 第 1 节与各接口的请求/响应。
 * 改契约时先改 API.md，再同步这里。
 */

// ---------- 通用 ----------

export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
export type TaskType = 'requirement' | 'subtask' | 'help'
export type Priority = 'low' | 'normal' | 'high' | 'urgent'
export type Source = 'feishu' | 'board' | 'agent' | 'api' | 'gitlab'

export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_state'
  | 'validation_error'
  | 'conflict'
  | 'rate_limited'
  | (string & {})

export interface ApiErrorBody {
  error: ApiErrorCode
  message: string
}

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export type Role = 'member' | 'developer' | 'reviewer' | 'admin' | 'connector' | 'agent_caller'

// ---------- 数据类型 ----------

export interface MemberRef {
  id: string
  name: string
  avatar_url: string | null
}

export interface Member extends MemberRef {
  roles: string[]
  team: string | null
  gitlab_username: string | null
  feishu_open_id: string | null
  is_active: boolean
  created_at: string
  last_login_at: string | null
  stats: { open: number; working: number; completed_30d: number }
}

/** kind: claude-code | codex | echo | other */
export type AgentKind = 'claude-code' | 'codex' | 'echo' | 'other' | (string & {})
export type AgentStatus = 'online' | 'busy' | 'offline'

export interface Agent {
  id: string
  member: MemberRef
  name: string
  kind: AgentKind
  version: string | null
  host: string | null
  skills: string[]
  repos: string[]
  max_concurrency: number
  auto_accept_help: boolean
  status: AgentStatus
  last_heartbeat_at: string | null
  current_task_ids: number[]
  created_at: string
}

export type CiStatus = 'none' | 'pending' | 'running' | 'success' | 'failed'

export interface TaskAgentRef {
  id: string
  name: string
  kind: string
}

export interface TaskSummary {
  id: number
  key: string
  title: string
  state: TaskState
  type: TaskType
  priority: Priority
  source: Source
  repos: string[]
  skills: string[]
  labels: string[]
  creator: MemberRef | null
  assignee: MemberRef | null
  assignee_agent: TaskAgentRef | null
  suggested_assignee: MemberRef | null
  parent_id: number | null
  root_id: number
  depth: number
  children_count: number
  mr_count: number
  mr_merged: number
  ci_status: CiStatus
  created_at: string
  updated_at: string
  state_changed_at: string
  closed_at: string | null
  is_demo: boolean
}

export type MrState = 'none' | 'opened' | 'merged' | 'closed'
export type PipelineStatus = 'none' | 'pending' | 'running' | 'success' | 'failed' | 'canceled'

export interface MergeRequest {
  id: number
  repo: string
  branch: string
  iid: number | null
  url: string | null
  state: MrState
  pipeline_status: PipelineStatus
  updated_at: string
}

export type ApprovalGate = 'claim' | 'merge' | 'high_risk'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface Approval {
  id: number
  gate: ApprovalGate
  status: ApprovalStatus
  requested_by: MemberRef | null
  decided_by: MemberRef | null
  comment: string | null
  created_at: string
  decided_at: string | null
}

export type ActorType = 'member' | 'agent' | 'system' | 'connector'

export interface TimelineItem {
  /** "e<事件id>" 或 "m<消息id>" */
  id: string
  kind: 'event' | 'message'
  /** 事件类型，如 task.created / state.changed / mr.opened；消息为 "message" */
  type: string
  at: string
  actor: { type: ActorType; id: string | null; name: string }
  /** 已格式化的中文描述或消息正文 */
  text: string
  data: Record<string, unknown> | null
}

export type Scenario =
  | 'intake'
  | 'dispatch'
  | 'help_routing'
  | 'input_answer'
  | 'ci_triage'
  | 'qa'
  | 'patrol'
export type AutonomyLevel = 'L0' | 'L1' | 'L2'
export type SuggestionStatus = 'proposed' | 'accepted' | 'rejected' | 'executed' | 'undone'

export interface Suggestion {
  id: number
  task_id: number | null
  scenario: Scenario
  level: AutonomyLevel
  status: SuggestionStatus
  summary: string
  payload: Record<string, unknown>
  created_at: string
  decided_by: MemberRef | null
}

/** allowed_actions 的取值 */
export type TaskAction =
  | 'claim'
  | 'accept'
  | 'decline'
  | 'cancel'
  | 'message'
  | 'input'
  | 'request_approval'
  | 'approve'
  | 'reject'
  | 'complete'
  | 'edit'
  | 'assign'

export interface TaskDetail extends TaskSummary {
  description: string
  source_ref: Record<string, unknown>
  merge_requests: MergeRequest[]
  approvals: Approval[]
  children: TaskSummary[]
  /** 按时间升序 */
  timeline: TimelineItem[]
  suggestions: Suggestion[]
  /** 当前用户可做的动作（见 TaskAction）；保留 string 以兼容后端新增动作 */
  allowed_actions: string[]
}

export type SourceEventSource = 'feishu' | 'gitlab' | 'board' | 'agent' | 'system'

export interface SourceEvent {
  id: number
  source: SourceEventSource
  kind: string
  summary: string
  status: 'processed' | 'ignored' | 'error'
  task_id: number | null
  task_key: string | null
  at: string
}

// ---------- 认证 ----------

export interface AuthProviders {
  feishu: boolean
  local: boolean
  dev: boolean
}

export interface LoginResponse {
  token: string
  member: Member
}

export interface RefreshResponse {
  token: string
}

export interface DeviceApproveResponse {
  ok: true
  client: string
  hostname: string
}

/** JWT claims（RS256，aud = acp） */
export interface JwtClaims {
  sub: string
  name: string
  roles: string[]
  act: 'member' | 'agent' | 'service'
  task_id?: number
  agent_id?: string
  exp: number
  iat: number
  jti: string
  iss?: string
  aud?: string | string[]
}

// ---------- REST 请求 ----------

export interface TaskListQuery {
  demo?: boolean
  q?: string
  /** 逗号分隔的多个状态 */
  state?: string
  /** 成员 id / me / none */
  assignee?: string
  creator?: string
  source?: Source
  repo?: string
  priority?: Priority
  type?: TaskType
  parent?: number
  page?: number
  page_size?: number
  /** 如 -updated_at、created_at、priority；前缀 - 表示降序 */
  sort?: string
}

export interface CreateTaskBody {
  title: string
  description?: string
  repos?: string[]
  priority?: Priority
  skills?: string[]
  labels?: string[]
  parent_id?: number
  suggested_assignee_id?: string
}

export interface UpdateTaskBody {
  title?: string
  description?: string
  repos?: string[]
  priority?: Priority
  labels?: string[]
  skills?: string[]
}

export interface RequestApprovalBody {
  gate: 'merge' | 'high_risk'
  note?: string
}

export interface DecideApprovalBody {
  decision: 'approve' | 'reject'
  comment?: string
}

export interface UpdateMemberBody {
  roles?: string[]
  team?: string | null
  gitlab_username?: string | null
  is_active?: boolean
}

// ---------- 总览 ----------

export interface OverviewRecentItem extends TimelineItem {
  task_id: number
  task_key: string
  task_title: string
}

export interface Overview {
  counts: { total: number; open: number; by_state: Record<TaskState, number> }
  kpis: {
    created_7d: number
    completed_7d: number
    avg_lead_time_hours: number | null
    ci_pass_rate: number | null
    agents_online: number
    members_active: number
  }
  /** 最近 days 天，按日 */
  trend: { date: string; created: number; completed: number }[]
  by_source: { source: Source; count: number }[]
  by_assignee: { member: MemberRef; open: number; working: number; completed: number }[]
  by_repo: { repo: string; open: number; total: number }[]
  /** 最近 20 条 */
  recent: OverviewRecentItem[]
  /** 需要关注：待补充、待审批、长时间无进展 */
  attention: TaskSummary[]
}

// ---------- 数据来源 ----------

export type SourceStatus = 'connected' | 'idle' | 'error' | 'unconfigured'

export interface SourceInfo {
  source: string
  label: string
  status: SourceStatus
  last_event_at: string | null
  events_24h: number
  events_7d: number
  detail: string | null
}

// ---------- 设置 ----------

export type AutonomySetting = 'off' | AutonomyLevel
export type IntakeMode = 'at_mention' | 'shortcut' | 'all'

export interface Settings {
  autonomy: Record<Scenario, AutonomySetting>
  intake_modes: string[]
  feishu_chat_ids: string[]
  notify_mode: string
  llm_enabled: boolean
  version: string
  public_url: string
  n8n_url: string | null
}

/** PUT /api/settings：上述字段的部分更新 */
export interface UpdateSettingsBody {
  autonomy?: Partial<Record<Scenario, AutonomySetting>>
  intake_modes?: string[]
  feishu_chat_ids?: string[]
}

// ---------- 自动化流程（n8n） ----------

export interface Workflow {
  id: string
  name: string
  active: boolean
  updated_at: string
}

export interface WorkflowExecution {
  id: string
  workflow_name: string
  status: string
  started_at: string
  stopped_at: string | null
  mode: string
}

export interface WorkflowsResponse {
  enabled: boolean
  /** enabled 为 false 时的原因：没配 Key、Key 失效、连不上、n8n 报错 */
  reason?: 'no_key' | 'unauthorized' | 'unreachable' | 'error'
  /** 给人看的原因说明 */
  message?: string
  n8n_url: string | null
  workflows: Workflow[]
  executions: WorkflowExecution[]
}

// ---------- 个人令牌（手动配置 Claude Code / Codex 的 MCP 用） ----------
// GET /api/me/tokens、POST /api/me/tokens、DELETE /api/me/tokens/{id}

export type PersonalTokenId = string | number

export interface PersonalToken {
  id: PersonalTokenId
  name: string
  created_at: string
  expires_at: string
  revoked_at: string | null
}

export interface CreatePersonalTokenBody {
  name: string
  /** 有效天数 1-90 */
  days: number
}

/** 令牌明文只在创建时返回这一次 */
export interface CreatedPersonalToken {
  id: PersonalTokenId
  token: string
  expires_at: string
  mcp_url: string
}
