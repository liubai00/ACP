/** 界面上用到的中文标签与配色，集中放这里，页面只引用这里 */
import type {
  AgentStatus,
  ApprovalGate,
  ApprovalStatus,
  AutonomySetting,
  CiStatus,
  IntakeMode,
  MrState,
  PipelineStatus,
  Priority,
  Scenario,
  Source,
  SourceEvent,
  SourceEventSource,
  SourceStatus,
  SuggestionStatus,
  TaskState,
  TaskType,
} from '@/types/api'

/** 语义色调，对应 StatusBadge 的样式 */
export type Tone = 'neutral' | 'info' | 'primary' | 'warning' | 'success' | 'danger' | 'muted'

export const TASK_STATES: TaskState[] = [
  'submitted',
  'working',
  'input-required',
  'auth-required',
  'completed',
  'failed',
  'canceled',
  'rejected',
]

export const OPEN_STATES: TaskState[] = ['submitted', 'working', 'input-required', 'auth-required']
export const TERMINAL_STATES: TaskState[] = ['completed', 'failed', 'canceled', 'rejected']

export const STATE_LABEL: Record<TaskState, string> = {
  submitted: '待认领',
  working: '进行中',
  'input-required': '待补充',
  'auth-required': '待审批',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
  rejected: '已拒绝',
}

export const STATE_TONE: Record<TaskState, Tone> = {
  submitted: 'info',
  working: 'primary',
  'input-required': 'warning',
  'auth-required': 'warning',
  completed: 'success',
  failed: 'danger',
  canceled: 'muted',
  rejected: 'danger',
}

/** 图表用的颜色（CSS 变量），与徽标色调一致 */
export const STATE_COLOR: Record<TaskState, string> = {
  submitted: 'var(--info)',
  working: 'var(--chart-1)',
  'input-required': 'var(--warning)',
  'auth-required': 'oklch(0.68 0.17 45)',
  completed: 'var(--success)',
  failed: 'var(--danger)',
  canceled: 'var(--muted-foreground)',
  rejected: 'oklch(0.55 0.15 15)',
}

export const STATE_DESCRIPTION: Record<TaskState, string> = {
  submitted: '建单完成，等待认领或派工',
  working: '已有负责人，正在执行',
  'input-required': 'Agent 需要人补充信息才能继续',
  'auth-required': '到达审批卡点，等人批准（如合并前）',
  completed: 'MR 已合并，或需求方确认验收',
  failed: 'CI 连续失败超过重试次数，或 Agent 报错退出',
  canceled: '发布者或管理员主动取消',
  rejected: '超出 Agent 能力范围，或触发安全规则被平台拒绝',
}

export const PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low']

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: '紧急',
  high: '高',
  normal: '普通',
  low: '低',
}

export const PRIORITY_TONE: Record<Priority, Tone> = {
  urgent: 'danger',
  high: 'warning',
  normal: 'neutral',
  low: 'muted',
}

export const SOURCES: Source[] = ['feishu', 'board', 'agent', 'gitlab', 'api']

export const SOURCE_LABEL: Record<Source, string> = {
  feishu: '飞书',
  board: '任务榜',
  agent: 'Agent',
  gitlab: 'GitLab',
  api: 'API',
}

export const EVENT_SOURCE_LABEL: Record<SourceEventSource, string> = {
  feishu: '飞书',
  gitlab: 'GitLab',
  board: '任务榜',
  agent: 'Agent',
  system: '系统',
}

export const SOURCE_COLOR: Record<Source, string> = {
  feishu: 'var(--chart-1)',
  board: 'var(--chart-3)',
  agent: 'var(--chart-5)',
  gitlab: 'oklch(0.66 0.18 40)',
  api: 'var(--chart-2)',
}

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  requirement: '需求',
  subtask: '子任务',
  help: '求助',
}

export const CI_LABEL: Record<CiStatus, string> = {
  none: '无流水线',
  pending: '排队中',
  running: '运行中',
  success: '通过',
  failed: '失败',
}

export const CI_TONE: Record<CiStatus, Tone> = {
  none: 'muted',
  pending: 'neutral',
  running: 'info',
  success: 'success',
  failed: 'danger',
}

export const PIPELINE_LABEL: Record<PipelineStatus, string> = {
  none: '无流水线',
  pending: '排队中',
  running: '运行中',
  success: '通过',
  failed: '失败',
  canceled: '已取消',
}

export const PIPELINE_TONE: Record<PipelineStatus, Tone> = {
  none: 'muted',
  pending: 'neutral',
  running: 'info',
  success: 'success',
  failed: 'danger',
  canceled: 'muted',
}

export const MR_STATE_LABEL: Record<MrState, string> = {
  none: '未创建',
  opened: '待合并',
  merged: '已合并',
  closed: '已关闭',
}

export const MR_STATE_TONE: Record<MrState, Tone> = {
  none: 'muted',
  opened: 'info',
  merged: 'success',
  closed: 'muted',
}

export const GATE_LABEL: Record<ApprovalGate, string> = {
  claim: '认领审批',
  merge: '合并审批',
  high_risk: '高风险操作',
}

export const APPROVAL_STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: '待审批',
  approved: '已同意',
  rejected: '已驳回',
}

export const APPROVAL_STATUS_TONE: Record<ApprovalStatus, Tone> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
}

export const SCENARIOS: Scenario[] = [
  'intake',
  'dispatch',
  'help_routing',
  'input_answer',
  'ci_triage',
  'qa',
  'patrol',
]

export const SCENARIO_LABEL: Record<Scenario, string> = {
  intake: '新需求整理',
  dispatch: '派工推荐',
  help_routing: 'Agent 求助路由',
  input_answer: '待补充自动解答',
  ci_triage: 'CI 失败分诊',
  qa: '飞书问答',
  patrol: '定时巡检',
}

export const SCENARIO_DESCRIPTION: Record<Scenario, string> = {
  intake: '把一句话整理成结构化任务，建议拆分、涉及仓库；开启全群读取时识别哪条消息是需求',
  dispatch: '根据技能、仓库和负载推荐负责人，生成派工建议',
  help_routing: 'Agent 发起求助时选择目标 Agent，并整理必要上下文',
  input_answer: 'Agent 卡在待补充时，先从任务历史和相关 MR 找答案，找不到再问人',
  ci_triage: '把 CI 失败日志归类为 Agent 可自修或需人介入，决定重试还是升级',
  qa: '在飞书里 @机器人 提问时，回答任务进度、谁能做某事这类问题（只读）',
  patrol: '找出卡太久的任务、离线的 Agent，主动提醒相关人',
}

export const AUTONOMY_OPTIONS: AutonomySetting[] = ['off', 'L0', 'L1', 'L2']

export const AUTONOMY_LABEL: Record<AutonomySetting, string> = {
  off: '关闭',
  L0: 'L0 只建议',
  L1: 'L1 先做再通知',
  L2: 'L2 全自动',
}

export const AUTONOMY_DESCRIPTION: Record<AutonomySetting, string> = {
  off: '协调 Agent 不参与该场景',
  L0: '生成建议写进卡片，人点确认才执行',
  L1: '自动执行并通知相关人，可一键撤销',
  L2: '自动执行，不通知，只记日志',
}

export const SUGGESTION_STATUS_LABEL: Record<SuggestionStatus, string> = {
  proposed: '待处理',
  accepted: '已采纳',
  rejected: '已忽略',
  executed: '已执行',
  undone: '已撤销',
}

export const SUGGESTION_STATUS_TONE: Record<SuggestionStatus, Tone> = {
  proposed: 'warning',
  accepted: 'primary',
  rejected: 'muted',
  executed: 'success',
  undone: 'muted',
}

export const INTAKE_MODES: IntakeMode[] = ['at_mention', 'shortcut', 'all']

export const INTAKE_MODE_LABEL: Record<IntakeMode, string> = {
  at_mention: '群里 @机器人',
  shortcut: '消息快捷操作「转为任务」',
  all: '全群消息读取',
}

export const INTAKE_MODE_DESCRIPTION: Record<IntakeMode, string> = {
  at_mention: '群里 @机器人，用自己的话交办工作或提问。启用协调模型后，明确的工作直接建单，需要补充时会追问。',
  shortcut: '在任意消息上点快捷操作「转为任务」',
  all: '协调 Agent 识别疑似需求，先发确认卡，有人确认才建单',
}

export const ROLE_LABEL: Record<string, string> = {
  member: '成员',
  developer: '开发',
  reviewer: '审批人',
  admin: '管理员',
  connector: '连接器',
  agent_caller: 'Agent 求助',
}

/** 管理员可在界面上分配的角色（connector 是 n8n 服务令牌专用） */
export const ASSIGNABLE_ROLES = ['member', 'developer', 'reviewer', 'admin', 'agent_caller']

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  online: '在线',
  busy: '忙碌',
  offline: '离线',
}

export const AGENT_KIND_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  echo: 'Echo（测试）',
  other: '其他',
}

export const SOURCE_STATUS_LABEL: Record<SourceStatus, string> = {
  connected: '已连接',
  idle: '空闲',
  error: '异常',
  unconfigured: '未配置',
}

export const SOURCE_STATUS_TONE: Record<SourceStatus, Tone> = {
  connected: 'success',
  idle: 'neutral',
  error: 'danger',
  unconfigured: 'muted',
}

export const SOURCE_EVENT_STATUS_LABEL: Record<SourceEvent['status'], string> = {
  processed: '已处理',
  ignored: '已忽略',
  error: '出错',
}

export const SOURCE_EVENT_STATUS_TONE: Record<SourceEvent['status'], Tone> = {
  processed: 'success',
  ignored: 'muted',
  error: 'danger',
}

export const EXECUTION_STATUS_LABEL: Record<string, string> = {
  success: '成功',
  error: '失败',
  crashed: '崩溃',
  running: '运行中',
  waiting: '等待中',
  new: '排队中',
  canceled: '已取消',
  unknown: '未知',
}

export const EXECUTION_STATUS_TONE: Record<string, Tone> = {
  success: 'success',
  error: 'danger',
  crashed: 'danger',
  running: 'info',
  waiting: 'warning',
  new: 'neutral',
  canceled: 'muted',
}

export const EXECUTION_MODE_LABEL: Record<string, string> = {
  webhook: 'Webhook',
  trigger: '定时触发',
  manual: '手动',
  retry: '重试',
  integrated: '子流程',
  cli: '命令行',
}

export const NOTIFY_MODE_LABEL: Record<string, string> = {
  n8n: '经 n8n 投递',
  direct: 'coordinator 直连飞书 / GitLab',
  log: '只记录不发送',
}

export const ACTION_LABEL: Record<string, string> = {
  claim: '认领',
  accept: '接受',
  decline: '拒绝',
  cancel: '取消任务',
  message: '发消息',
  input: '补充信息',
  request_approval: '请求审批',
  approve: '同意',
  reject: '驳回',
  complete: '确认完成',
  edit: '编辑',
  assign: '派工',
}
