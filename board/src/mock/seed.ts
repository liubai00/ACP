/**
 * 模拟数据生成（仅 VITE_MOCK=1 时加载）。
 * 用固定种子的伪随机数，数据在每次刷新时保持一致；时间相对“现在”生成，看起来是实时的。
 */
import type {
  Agent,
  Approval,
  CiStatus,
  Member,
  MemberRef,
  MergeRequest,
  Priority,
  Settings,
  Source,
  SourceEvent,
  SourceEventSource,
  Suggestion,
  TaskDetail,
  TaskState,
  TaskType,
  TimelineItem,
  Workflow,
  WorkflowExecution,
} from '@/types/api'

// ---------- 工具 ----------

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const rand = mulberry32(20261109)
export const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]
export const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1))

export const NOW = Date.now()
const HOUR = 3_600_000
const MIN = 60_000

export function iso(ms: number) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function hex(len: number) {
  let out = ''
  for (let i = 0; i < len; i++) out += Math.floor(rand() * 16).toString(16)
  return out
}

function uuid() {
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`
}

export function ref(m: Member): MemberRef {
  return { id: m.id, name: m.name, avatar_url: m.avatar_url }
}

// ---------- 成员 ----------

interface MemberSeed {
  name: string
  roles: string[]
  team: string
  gitlab: string
  active?: boolean
  lastLoginHoursAgo: number | null
}

const MEMBER_SEEDS: MemberSeed[] = [
  { name: '张伟', roles: ['member', 'developer', 'reviewer', 'admin'], team: '平台组', gitlab: 'zhangwei', lastLoginHoursAgo: 0.2 },
  { name: '李娜', roles: ['member', 'developer'], team: '前端组', gitlab: 'lina', lastLoginHoursAgo: 1.5 },
  { name: '王强', roles: ['member', 'developer', 'reviewer'], team: '交易组', gitlab: 'wangqiang', lastLoginHoursAgo: 3 },
  { name: '刘洋', roles: ['member', 'developer'], team: '交易组', gitlab: 'liuyang', lastLoginHoursAgo: 26 },
  { name: '陈静', roles: ['member', 'developer', 'agent_caller'], team: '数据组', gitlab: 'chenjing', lastLoginHoursAgo: 5 },
  { name: '杨帆', roles: ['member', 'reviewer'], team: '测试组', gitlab: 'yangfan', lastLoginHoursAgo: 8 },
  { name: '赵磊', roles: ['member', 'developer'], team: '前端组', gitlab: 'zhaolei', lastLoginHoursAgo: 0.8 },
  { name: '黄敏', roles: ['member'], team: '产品组', gitlab: 'huangmin', lastLoginHoursAgo: 30 },
  { name: '周杰', roles: ['member', 'developer', 'agent_caller'], team: '平台组', gitlab: 'zhoujie', lastLoginHoursAgo: 2 },
  { name: '吴婷', roles: ['member'], team: '产品组', gitlab: 'wuting', lastLoginHoursAgo: 12 },
  { name: '孙浩', roles: ['member', 'developer'], team: '交易组', gitlab: 'sunhao', active: false, lastLoginHoursAgo: 24 * 40 },
]

export const members: Member[] = MEMBER_SEEDS.map((s, i) => ({
  id: uuid(),
  name: s.name,
  avatar_url: null,
  roles: s.roles,
  team: s.team,
  gitlab_username: s.gitlab,
  feishu_open_id: `ou_${hex(24)}`,
  is_active: s.active ?? true,
  created_at: iso(NOW - (60 - i) * 24 * HOUR),
  last_login_at: s.lastLoginHoursAgo === null ? null : iso(NOW - s.lastLoginHoursAgo * HOUR),
  stats: { open: 0, working: 0, completed_30d: 0 },
}))

export const M = Object.fromEntries(members.map((m) => [m.name, m])) as Record<string, Member>

// ---------- Agent ----------

interface AgentSeed {
  owner: string
  name: string
  kind: string
  version: string
  host: string
  skills: string[]
  repos: string[]
  status: Agent['status']
  heartbeatMinAgo: number | null
  max?: number
  autoHelp?: boolean
}

const AGENT_SEEDS: AgentSeed[] = [
  { owner: '张伟', name: 'zw-mbp-claude', kind: 'claude-code', version: '2.1.3', host: 'zw-mbp.local', skills: ['python', 'fastapi', 'postgres', 'devops'], repos: ['acp/coordinator', 'infra/deploy'], status: 'online', heartbeatMinAgo: 0.3, max: 2, autoHelp: true },
  { owner: '李娜', name: 'lina-claude', kind: 'claude-code', version: '2.1.3', host: 'lina-win11', skills: ['react', 'typescript', 'css', '前端'], repos: ['shop/web-mall', 'acp/board'], status: 'busy', heartbeatMinAgo: 0.5, max: 2, autoHelp: true },
  { owner: '王强', name: 'wq-codex', kind: 'codex', version: '0.48.0', host: 'wq-thinkpad', skills: ['java', 'spring', 'mysql', '支付'], repos: ['shop/order-service', 'shop/payment-service'], status: 'online', heartbeatMinAgo: 0.4 },
  { owner: '刘洋', name: 'ly-claude', kind: 'claude-code', version: '2.0.9', host: 'ly-mbp.local', skills: ['go', 'grpc', 'redis'], repos: ['shop/inventory-service'], status: 'offline', heartbeatMinAgo: 190 },
  { owner: '陈静', name: 'cj-claude', kind: 'claude-code', version: '2.1.3', host: 'cj-ubuntu', skills: ['python', 'spark', 'sql', '数据'], repos: ['data/etl-pipeline', 'data/report-api'], status: 'busy', heartbeatMinAgo: 0.2, max: 3, autoHelp: true },
  { owner: '赵磊', name: 'zl-codex', kind: 'codex', version: '0.48.0', host: 'zl-mbp.local', skills: ['vue', 'react', '小程序'], repos: ['shop/web-mall', 'shop/mini-app'], status: 'online', heartbeatMinAgo: 0.6 },
  { owner: '周杰', name: 'zj-echo', kind: 'echo', version: '0.4.2', host: 'zj-dev-vm', skills: ['test'], repos: ['acp/acp-link'], status: 'online', heartbeatMinAgo: 0.1, autoHelp: true },
  { owner: '张伟', name: 'zw-wsl-codex', kind: 'codex', version: '0.47.1', host: 'zw-desktop-wsl', skills: ['python', 'shell'], repos: ['infra/deploy'], status: 'offline', heartbeatMinAgo: 60 * 30 },
]

export const agents: Agent[] = AGENT_SEEDS.map((s, i) => ({
  id: uuid(),
  member: ref(M[s.owner]),
  name: s.name,
  kind: s.kind,
  version: s.version,
  host: s.host,
  skills: s.skills,
  repos: s.repos,
  max_concurrency: s.max ?? 1,
  auto_accept_help: s.autoHelp ?? false,
  status: s.status,
  last_heartbeat_at: s.heartbeatMinAgo === null ? null : iso(NOW - s.heartbeatMinAgo * MIN),
  current_task_ids: [],
  created_at: iso(NOW - (40 - i * 3) * 24 * HOUR),
}))

export function agentOf(memberName: string) {
  return agents.find((a) => a.member.name === memberName) ?? null
}

// ---------- 任务 ----------

export const REPOS = [
  'acp/coordinator',
  'acp/board',
  'acp/acp-link',
  'shop/web-mall',
  'shop/order-service',
  'shop/payment-service',
  'shop/inventory-service',
  'shop/mini-app',
  'data/etl-pipeline',
  'data/report-api',
  'infra/deploy',
]

interface TaskSeed {
  title: string
  slug: string
  description: string
  repos: string[]
  skills: string[]
  labels: string[]
  priority: Priority
  source: Source
  type?: TaskType
  state: TaskState
  creator: string
  assignee?: string
  suggested?: string
  /** 创建于几小时前 */
  created: number
  /** 最后更新于几小时前 */
  updated: number
  parent?: number
  demo?: boolean
  ci?: CiStatus
  noMr?: boolean
  question?: string
}

const TASK_SEEDS: TaskSeed[] = [
  // ---- 进行中 ----
  { title: '订单列表页支持导出 Excel', slug: 'order-export', description: '运营同学每周要手工整理订单数据，希望订单列表页增加「导出」按钮：\n- 按当前筛选条件导出\n- 字段：订单号、下单时间、用户、金额、状态、渠道\n- 单次最多 5 万行，超过时提示分批导出', repos: ['shop/web-mall', 'shop/order-service'], skills: ['react', 'java'], labels: ['运营需求', '导出'], priority: 'high', source: 'feishu', state: 'working', creator: '吴婷', assignee: '李娜', created: 52, updated: 0.4, ci: 'running' },
  { title: '修复支付回调偶发超时导致重复入账', slug: 'pay-callback-timeout', description: '线上监控发现微信支付回调偶发超过 5 秒，网关重试后出现重复入账（近 7 天 3 笔）。\n需要：回调处理加幂等键、慢查询优化、补一条告警。', repos: ['shop/payment-service'], skills: ['java', '支付'], labels: ['线上问题', 'P1'], priority: 'urgent', source: 'feishu', state: 'working', creator: '王强', assignee: '王强', created: 20, updated: 0.1, ci: 'pending' },
  { title: '任务榜看板卡片显示停留时长', slug: 'board-age', description: '看板每张卡片显示在当前状态停留的时长，超过 24 小时标黄、超过 72 小时标红。', repos: ['acp/board'], skills: ['react', 'typescript'], labels: ['任务榜'], priority: 'normal', source: 'board', state: 'working', creator: '张伟', assignee: '赵磊', created: 30, updated: 1.2, ci: 'success' },
  { title: 'ETL 日报任务改为增量同步', slug: 'etl-incremental', description: '目前日报 ETL 每天全量跑 3 小时，改为按 updated_at 增量同步，保留每周日全量校验。', repos: ['data/etl-pipeline'], skills: ['python', 'spark'], labels: ['性能'], priority: 'high', source: 'board', state: 'working', creator: '陈静', assignee: '陈静', created: 70, updated: 2.5, noMr: false, ci: 'failed' },
  { title: 'coordinator 增加任务超时回收', slug: 'task-timeout-reclaim', description: 'Agent 30 分钟无心跳时回收任务并通知负责人，任务回到待认领。', repos: ['acp/coordinator'], skills: ['python', 'fastapi'], labels: ['平台'], priority: 'high', source: 'board', state: 'working', creator: '张伟', assignee: '张伟', created: 26, updated: 0.7 },
  { title: '库存服务扣减接口压测与优化', slug: 'inventory-bench', description: '大促前对库存扣减接口做压测，目标 3000 QPS、P99 < 80ms。', repos: ['shop/inventory-service'], skills: ['go', 'redis'], labels: ['大促'], priority: 'high', source: 'feishu', state: 'working', creator: '黄敏', assignee: '刘洋', created: 96, updated: 50 },
  { title: '小程序首页瀑布流图片懒加载', slug: 'mini-lazyload', description: '首页商品瀑布流图片改为懒加载，首屏只加载 6 张。', repos: ['shop/mini-app'], skills: ['小程序'], labels: ['性能', '体验'], priority: 'normal', source: 'feishu', state: 'working', creator: '黄敏', assignee: '赵磊', created: 40, updated: 3, ci: 'success' },
  { title: '报表接口增加按渠道聚合', slug: 'report-by-channel', description: 'report-api 的销售日报接口增加 group_by=channel 参数。', repos: ['data/report-api'], skills: ['python', 'sql'], labels: ['数据'], priority: 'normal', source: 'agent', type: 'help', state: 'working', creator: '李娜', assignee: '陈静', created: 18, updated: 0.9, parent: 0 },
  { title: 'acp-link 支持 Windows 服务方式运行', slug: 'link-win-service', description: '开发者希望 acp-link 开机自启，Windows 下注册为服务。', repos: ['acp/acp-link'], skills: ['go'], labels: ['接入程序'], priority: 'low', source: 'board', state: 'working', creator: '周杰', assignee: '周杰', created: 60, updated: 6 },
  { title: '订单导出接口（后端）', slug: 'order-export-api', description: '为订单导出提供异步导出接口：提交导出任务、查询进度、下载文件。', repos: ['shop/order-service'], skills: ['java'], labels: ['导出'], priority: 'high', source: 'agent', type: 'subtask', state: 'working', creator: '李娜', assignee: '王强', created: 46, updated: 1.5, parent: 0, ci: 'running' },

  // ---- 待认领 ----
  { title: '会员中心增加积分明细页', slug: 'points-detail', description: '会员中心新增「积分明细」，展示获取/消耗记录，支持按月筛选。', repos: ['shop/web-mall'], skills: ['react'], labels: ['会员'], priority: 'normal', source: 'feishu', state: 'submitted', creator: '吴婷', suggested: '李娜', created: 3, updated: 2.8 },
  { title: '优惠券过期前 3 天短信提醒', slug: 'coupon-remind', description: '用户优惠券过期前 3 天发送短信提醒，每人每天最多 1 条。', repos: ['shop/order-service'], skills: ['java'], labels: ['营销'], priority: 'normal', source: 'feishu', state: 'submitted', creator: '黄敏', suggested: '王强', created: 6, updated: 5.5 },
  { title: '部署脚本支持一键回滚', slug: 'deploy-rollback', description: 'infra/deploy 增加 rollback 子命令，回滚到上一个镜像版本并保留数据卷。', repos: ['infra/deploy'], skills: ['devops', 'shell'], labels: ['运维'], priority: 'high', source: 'board', state: 'submitted', creator: '周杰', created: 1.2, updated: 1.2 },
  { title: '商品详情页 SKU 选择器无障碍优化', slug: 'sku-a11y', description: 'SKU 选择器支持键盘操作和读屏。', repos: ['shop/web-mall'], skills: ['react', 'css'], labels: ['体验'], priority: 'low', source: 'board', state: 'submitted', creator: '赵磊', created: 30, updated: 29 },
  { title: '修复数据看板时区错误（差 8 小时）', slug: 'dashboard-tz', description: '数据看板的“今日”统计按 UTC 计算，导致早上 8 点前的订单算到前一天。', repos: ['data/report-api'], skills: ['python'], labels: ['线上问题'], priority: 'urgent', source: 'gitlab', state: 'submitted', creator: '陈静', suggested: '陈静', created: 0.5, updated: 0.5 },
  { title: '【示例】体验任务：给 README 增加构建徽章', slug: 'demo-readme-badge', description: '这是平台自带的示例任务，用来体验认领 → Agent 执行 → 提交 MR → 审批的完整流程。', repos: ['acp/acp-link'], skills: ['test'], labels: ['示例'], priority: 'low', source: 'board', state: 'submitted', creator: '张伟', created: 24 * 6, updated: 24 * 6, demo: true },
  { title: '登录页增加飞书扫码登录入口', slug: 'feishu-qr-login', description: 'web-mall 后台登录页增加飞书扫码登录。', repos: ['shop/web-mall'], skills: ['react'], labels: ['后台'], priority: 'normal', source: 'api', state: 'submitted', creator: '张伟', created: 8, updated: 7 },

  // ---- 待补充 ----
  { title: '退款单增加部分退款', slug: 'partial-refund', description: '目前只支持整单退款，客服希望支持按商品行部分退款。', repos: ['shop/order-service', 'shop/payment-service'], skills: ['java', '支付'], labels: ['客服需求'], priority: 'high', source: 'feishu', state: 'input-required', creator: '黄敏', assignee: '王强', created: 30, updated: 4, question: '部分退款时运费如何处理：按商品金额比例分摊，还是只在最后一件退款时退运费？' },
  { title: '大促活动页倒计时组件', slug: 'promo-countdown', description: '活动页顶部倒计时，结束后自动切换为“活动已结束”。', repos: ['shop/web-mall'], skills: ['react'], labels: ['大促'], priority: 'normal', source: 'feishu', state: 'input-required', creator: '吴婷', assignee: '赵磊', created: 22, updated: 9, question: '倒计时以服务器时间为准还是用户本地时间？如果用服务器时间，需要后端提供 /api/time 接口吗？' },
  { title: '同步 GitLab 用户到成员表', slug: 'sync-gitlab-users', description: '定时把 GitLab 用户名同步到成员表的 gitlab_username。', repos: ['acp/coordinator'], skills: ['python'], labels: ['平台'], priority: 'low', source: 'board', state: 'input-required', creator: '张伟', assignee: '周杰', created: 50, updated: 30, question: '飞书和 GitLab 的用户如何对应：按邮箱匹配，还是需要管理员手工确认？' },
  { title: '库存预警阈值可配置', slug: 'stock-alert-config', description: '低库存预警阈值改为按品类配置。', repos: ['shop/inventory-service'], skills: ['go'], labels: [], priority: 'normal', source: 'agent', type: 'subtask', state: 'input-required', creator: '刘洋', assignee: '刘洋', created: 70, updated: 26, question: '品类层级很深，阈值是配置在一级品类还是叶子品类？' },

  // ---- 待审批 ----
  { title: '订单详情页展示物流轨迹', slug: 'order-tracking', description: '对接快递 100 接口，在订单详情展示物流轨迹。', repos: ['shop/web-mall', 'shop/order-service'], skills: ['react', 'java'], labels: ['体验'], priority: 'normal', source: 'feishu', state: 'auth-required', creator: '吴婷', assignee: '李娜', created: 80, updated: 2, ci: 'success' },
  { title: '支付网关升级 TLS 1.3', slug: 'pay-tls13', description: '支付服务出站连接升级 TLS 1.3，涉及证书配置变更（高风险）。', repos: ['shop/payment-service'], skills: ['java', 'devops'], labels: ['安全', '高风险'], priority: 'high', source: 'board', state: 'auth-required', creator: '王强', assignee: '王强', created: 44, updated: 5, ci: 'success' },
  { title: 'coordinator 事件表增加分区', slug: 'events-partition', description: 'events 表按月分区，降低时间线查询延迟。', repos: ['acp/coordinator'], skills: ['postgres'], labels: ['平台', '性能'], priority: 'normal', source: 'board', state: 'auth-required', creator: '张伟', assignee: '张伟', created: 60, updated: 1, ci: 'success' },
  { title: '报表导出增加水印', slug: 'report-watermark', description: '导出的 PDF 报表加上导出人和时间水印。', repos: ['data/report-api'], skills: ['python'], labels: ['安全'], priority: 'low', source: 'feishu', state: 'auth-required', creator: '黄敏', assignee: '陈静', created: 100, updated: 20, ci: 'success' },

  // ---- 已完成 ----
  { title: '商品搜索支持拼音首字母', slug: 'search-pinyin', description: '搜索框支持拼音首字母匹配，如 “ydj” 匹配 “羽绒服”。', repos: ['shop/web-mall'], skills: ['react'], labels: ['搜索'], priority: 'normal', source: 'feishu', state: 'completed', creator: '吴婷', assignee: '李娜', created: 24 * 12, updated: 24 * 10, ci: 'success' },
  { title: '订单服务升级 Spring Boot 3.4', slug: 'springboot-34', description: '升级框架版本并修复废弃 API。', repos: ['shop/order-service'], skills: ['java'], labels: ['技术债'], priority: 'normal', source: 'board', state: 'completed', creator: '王强', assignee: '王强', created: 24 * 13, updated: 24 * 9, ci: 'success' },
  { title: 'acp-link 心跳间隔可配置', slug: 'link-heartbeat', description: '心跳默认 30 秒，允许 10~120 秒配置。', repos: ['acp/acp-link'], skills: ['go'], labels: ['接入程序'], priority: 'low', source: 'board', state: 'completed', creator: '周杰', assignee: '周杰', created: 24 * 11, updated: 24 * 8, ci: 'success' },
  { title: '飞书卡片增加“转给别人”按钮', slug: 'card-transfer', description: '派工卡片支持转给其他成员。', repos: ['acp/coordinator'], skills: ['python'], labels: ['飞书'], priority: 'normal', source: 'feishu', state: 'completed', creator: '张伟', assignee: '张伟', created: 24 * 9, updated: 24 * 7, ci: 'success' },
  { title: 'ETL 失败自动重试 2 次', slug: 'etl-retry', description: 'ETL 任务失败自动重试，间隔 5 分钟。', repos: ['data/etl-pipeline'], skills: ['python'], labels: ['稳定性'], priority: 'high', source: 'gitlab', state: 'completed', creator: '陈静', assignee: '陈静', created: 24 * 8, updated: 24 * 6.5, ci: 'success' },
  { title: '购物车页面适配深色模式', slug: 'cart-dark', description: '购物车页面适配系统深色模式。', repos: ['shop/web-mall'], skills: ['css'], labels: ['体验'], priority: 'low', source: 'board', state: 'completed', creator: '赵磊', assignee: '赵磊', created: 24 * 7, updated: 24 * 5.2, ci: 'success' },
  { title: '库存同步消息去重', slug: 'stock-dedupe', description: 'MQ 重复投递导致库存重复扣减，消费端按消息 ID 去重。', repos: ['shop/inventory-service'], skills: ['go'], labels: ['线上问题'], priority: 'urgent', source: 'feishu', state: 'completed', creator: '黄敏', assignee: '刘洋', created: 24 * 6, updated: 24 * 5, ci: 'success' },
  { title: '整理大促值班表并同步到群公告', slug: 'oncall-sheet', description: '整理双 11 值班表（非代码任务，确认后完成）。', repos: [], skills: [], labels: ['大促', '非代码'], priority: 'normal', source: 'feishu', state: 'completed', creator: '黄敏', assignee: '杨帆', created: 24 * 5, updated: 24 * 4.6, noMr: true },
  { title: '支付结果页增加“查看订单”按钮', slug: 'pay-result-btn', description: '支付成功页增加“查看订单”快捷入口。', repos: ['shop/web-mall'], skills: ['react'], labels: ['体验'], priority: 'low', source: 'feishu', state: 'completed', creator: '吴婷', assignee: '李娜', created: 24 * 4.5, updated: 24 * 3.8, ci: 'success' },
  { title: '报表 API 增加缓存', slug: 'report-cache', description: '日报接口结果缓存 10 分钟。', repos: ['data/report-api'], skills: ['python', 'redis'], labels: ['性能'], priority: 'normal', source: 'board', state: 'completed', creator: '陈静', assignee: '陈静', created: 24 * 4, updated: 24 * 3, ci: 'success' },
  { title: '任务榜登录页支持本地管理员', slug: 'board-local-login', description: '引导阶段用本地管理员登录。', repos: ['acp/board', 'acp/coordinator'], skills: ['react', 'python'], labels: ['任务榜'], priority: 'normal', source: 'board', state: 'completed', creator: '张伟', assignee: '赵磊', created: 24 * 3.5, updated: 24 * 2.4, ci: 'success' },
  { title: '订单号生成改为雪花算法', slug: 'order-snowflake', description: '替换数据库自增 ID，支持多机房。', repos: ['shop/order-service'], skills: ['java'], labels: ['技术债'], priority: 'normal', source: 'board', state: 'completed', creator: '王强', assignee: '王强', created: 24 * 3, updated: 24 * 1.8, ci: 'success' },
  { title: 'Agent 求助：解析 GitLab 流水线日志格式', slug: 'help-ci-log', description: '帮忙写一个解析 GitLab CI job 日志、提取失败用例的函数。', repos: ['acp/coordinator'], skills: ['python'], labels: ['求助'], priority: 'normal', source: 'agent', type: 'help', state: 'completed', creator: '周杰', assignee: '张伟', created: 24 * 2.5, updated: 24 * 1.5, ci: 'success' },
  { title: '小程序分享卡片标题可配置', slug: 'share-title', description: '运营后台配置分享卡片标题。', repos: ['shop/mini-app'], skills: ['小程序'], labels: ['营销'], priority: 'low', source: 'feishu', state: 'completed', creator: '吴婷', assignee: '赵磊', created: 24 * 2, updated: 24 * 0.9, ci: 'success' },
  { title: '部署手册补充 n8n 队列模式说明', slug: 'doc-n8n-queue', description: '文档任务，确认后完成。', repos: [], skills: [], labels: ['文档', '非代码'], priority: 'low', source: 'board', state: 'completed', creator: '张伟', assignee: '周杰', created: 30, updated: 10, noMr: true },
  { title: '【示例】体验任务：修正拼写错误', slug: 'demo-typo', description: '平台自带的示例任务。', repos: ['acp/acp-link'], skills: ['test'], labels: ['示例'], priority: 'low', source: 'board', state: 'completed', creator: '张伟', assignee: '周杰', created: 24 * 6, updated: 24 * 5.9, demo: true, ci: 'success' },
  { title: '订单列表筛选条件记忆', slug: 'order-filter-memo', description: '订单列表的筛选条件在刷新后保留。', repos: ['shop/web-mall'], skills: ['react'], labels: ['体验'], priority: 'low', source: 'board', state: 'completed', creator: '李娜', assignee: '李娜', created: 20, updated: 6, ci: 'success' },

  // ---- 失败 / 取消 / 拒绝 ----
  { title: '迁移订单历史数据到冷存储', slug: 'order-archive', description: '把 2 年前的订单迁移到对象存储。', repos: ['shop/order-service', 'data/etl-pipeline'], skills: ['java', 'python'], labels: ['数据'], priority: 'normal', source: 'board', state: 'failed', creator: '王强', assignee: '陈静', created: 24 * 5, updated: 24 * 2, ci: 'failed' },
  { title: '升级前端构建到 Vite 7', slug: 'vite7-upgrade', description: '构建提速。', repos: ['shop/web-mall'], skills: ['react'], labels: ['技术债'], priority: 'low', source: 'board', state: 'failed', creator: '赵磊', assignee: '赵磊', created: 24 * 3, updated: 24 * 1, ci: 'failed' },
  { title: '首页增加天气组件', slug: 'home-weather', description: '运营临时需求，已取消。', repos: ['shop/web-mall'], skills: ['react'], labels: [], priority: 'low', source: 'feishu', state: 'canceled', creator: '吴婷', created: 24 * 4, updated: 24 * 3.5 },
  { title: '重复需求：订单导出 CSV', slug: 'dup-export-csv', description: '与 ACP-101 重复。', repos: ['shop/web-mall'], skills: [], labels: ['重复'], priority: 'normal', source: 'feishu', state: 'canceled', creator: '黄敏', created: 50, updated: 48 },
  { title: '批量删除生产库测试订单', slug: 'delete-prod-orders', description: '直接在生产库执行批量删除。', repos: ['shop/order-service'], skills: ['sql'], labels: ['高风险'], priority: 'high', source: 'feishu', state: 'rejected', creator: '刘洋', created: 24 * 2, updated: 24 * 2 - 0.2 },
  { title: '让 Agent 直接修改线上 Nginx 配置', slug: 'prod-nginx', description: '超出 Agent 权限范围。', repos: ['infra/deploy'], skills: ['devops'], labels: ['高风险'], priority: 'normal', source: 'agent', type: 'help', state: 'rejected', creator: '周杰', created: 24 * 1.5, updated: 24 * 1.5 - 0.1 },
]

const FIRST_ID = 101
const STATE_CHAIN_LABEL: Record<TaskState, string> = {
  submitted: '待认领',
  working: '进行中',
  'input-required': '待补充',
  'auth-required': '待审批',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
  rejected: '已拒绝',
}

let eventSeq = 9000
let messageSeq = 4000
export function nextEventId() {
  eventSeq += 1
  return `e${eventSeq}`
}
export function nextMessageId() {
  messageSeq += 1
  return `m${messageSeq}`
}

let mrSeq = 700
let mrIid = 40
let approvalSeq = 300
let suggestionSeq = 500
export function nextApprovalId() {
  approvalSeq += 1
  return approvalSeq
}
export function nextSuggestionId() {
  suggestionSeq += 1
  return suggestionSeq
}
export function nextMr(repo: string, branch: string, state: MergeRequest['state'], pipeline: MergeRequest['pipeline_status'], at: string): MergeRequest {
  mrSeq += 1
  mrIid += between(1, 4)
  return {
    id: mrSeq,
    repo,
    branch,
    iid: mrIid,
    url: `https://gitlab.example.com/${repo}/-/merge_requests/${mrIid}`,
    state,
    pipeline_status: pipeline,
    updated_at: at,
  }
}

export function memberActor(m: MemberRef) {
  return { type: 'member' as const, id: m.id, name: m.name }
}
export function agentActor(a: Agent) {
  return { type: 'agent' as const, id: a.id, name: a.name }
}
export const SYSTEM_ACTOR = { type: 'system' as const, id: null, name: '协调服务器' }
export const COORDINATOR_AGENT_ACTOR = { type: 'system' as const, id: null, name: '协调 Agent' }
export const FEISHU_ACTOR = { type: 'connector' as const, id: null, name: '飞书连接器' }
export const GITLAB_ACTOR = { type: 'connector' as const, id: null, name: 'GitLab 连接器' }

const AGENT_ACKS = [
  '收到任务，正在准备工作区：已克隆 {repo}，创建分支 {branch}。',
  '已接单。先读一下相关代码和最近的提交记录，预计 10 分钟内给出方案。',
]
const AGENT_PLANS = [
  '方案：\n1. 先补测试用例复现需求场景\n2. 修改相关接口与数据结构，保持向后兼容\n3. 本地跑通全部测试后推分支开 MR',
  '已定位到相关代码，改动集中在 3 个文件；先写测试复现问题，再修复。',
  '分析完成：问题出在重试时没有带幂等键。计划在入账前按 out_trade_no 加分布式锁。',
  '计划拆成两步：先加配置项和默认值，再改调用方读取配置。',
]
const AGENT_TOOLS = [
  '执行 npm run test：128 项通过，0 项失败',
  '执行 mvn -q test：全部通过（用时 2 分 13 秒）',
  '执行 pytest -q：46 passed',
  '执行 go test ./...：ok',
]

interface Draft {
  task: TaskDetail
  /** 时间线的“步骤”，生成后按时间均匀铺开 */
  steps: Omit<TimelineItem, 'id' | 'at'>[]
}

function aggregateCi(mrs: MergeRequest[]): CiStatus {
  if (mrs.length === 0) return 'none'
  const s = mrs.map((m) => m.pipeline_status)
  if (s.includes('failed')) return 'failed'
  if (s.includes('running')) return 'running'
  if (s.includes('pending')) return 'pending'
  if (s.every((x) => x === 'success')) return 'success'
  return 'none'
}
export { aggregateCi }

function ev(type: string, actor: TimelineItem['actor'], text: string, data: Record<string, unknown> | null = null): Omit<TimelineItem, 'id' | 'at'> {
  return { kind: 'event', type, actor, text, data }
}
function msg(actor: TimelineItem['actor'], text: string, data: Record<string, unknown> | null = null): Omit<TimelineItem, 'id' | 'at'> {
  return { kind: 'message', type: 'message', actor, text, data }
}

function buildTask(seed: TaskSeed, id: number, parentId: number | null): TaskDetail {
  const createdMs = NOW - seed.created * HOUR
  const updatedMs = NOW - seed.updated * HOUR
  const creator = M[seed.creator]
  const assignee = seed.assignee ? M[seed.assignee] : null
  const agent = seed.assignee ? agentOf(seed.assignee) : null
  const branch = `acp/${id}-${seed.slug}`
  const repo = seed.repos[0] ?? '—'
  const st = seed.state
  const steps: Draft['steps'] = []
  const stateChange = (from: TaskState, to: TaskState, actor: TimelineItem['actor'] = SYSTEM_ACTOR) =>
    ev('state.changed', actor, `状态：${STATE_CHAIN_LABEL[from]} → ${STATE_CHAIN_LABEL[to]}`, { from, to })

  // 1. 建单
  switch (seed.source) {
    case 'feishu':
      steps.push(ev('task.created', FEISHU_ACTOR, `${creator.name} 在飞书群「交易研发群」@机器人 发布了需求`, { source: 'feishu' }))
      break
    case 'board':
      steps.push(ev('task.created', memberActor(creator), `${creator.name} 在任务榜创建了任务`, { source: 'board' }))
      break
    case 'agent': {
      const a = agentOf(seed.creator)
      steps.push(ev('task.created', a ? agentActor(a) : memberActor(creator), `Agent ${a?.name ?? creator.name} 发起${seed.type === 'help' ? '求助' : '子任务'}`, { source: 'agent' }))
      break
    }
    case 'gitlab':
      steps.push(ev('task.created', GITLAB_ACTOR, `${repo} 主干流水线连续失败，自动创建修复任务`, { source: 'gitlab' }))
      break
    case 'api':
      steps.push(ev('task.created', SYSTEM_ACTOR, `通过 API 创建（调用方：n8n 建单流）`, { source: 'api' }))
      break
  }
  if (seed.source === 'feishu' || seed.source === 'gitlab') {
    steps.push(ev('suggestion.created', COORDINATOR_AGENT_ACTOR, `协调 Agent 整理了需求：涉及仓库 ${seed.repos.join('、') || '无'}，所需技能 ${seed.skills.join('、') || '无'}`, { scenario: 'intake' }))
  }

  if (st === 'rejected') {
    steps.push(ev('state.changed', SYSTEM_ACTOR, seed.type === 'help' ? '平台拒绝：请求修改生产环境配置，超出 Agent 权限范围' : '平台拒绝：涉及生产库批量删除，触发安全规则', { from: 'submitted', to: 'rejected' }))
  }
  if (st === 'canceled') {
    steps.push(msg(memberActor(creator), seed.slug === 'dup-export-csv' ? '和 ACP-101 重复了，这条先取消。' : '活动方案调整，这个需求先不做了。'))
    steps.push(ev('task.canceled', memberActor(creator), `${creator.name} 取消了任务`, { reason: '需求变更' }))
  }
  if (st === 'submitted' && seed.suggested) {
    steps.push(ev('task.suggested', COORDINATOR_AGENT_ACTOR, `协调 Agent 建议派给 ${seed.suggested}（技能匹配：${seed.skills.join('、')}）`, { member: seed.suggested }))
    steps.push(ev('notify.sent', SYSTEM_ACTOR, `已向 ${seed.suggested} 发送派工卡片`, null))
  }

  // 2. 认领与执行
  if (assignee && st !== 'canceled' && st !== 'rejected') {
    if (seed.source === 'feishu') {
      steps.push(ev('task.claimed', memberActor(assignee), `${assignee.name} 在飞书卡片上认领了任务`))
    } else {
      steps.push(ev('task.claimed', memberActor(assignee), `${assignee.name} 认领了任务`))
    }
    steps.push(stateChange('submitted', 'working'))
    if (agent) {
      steps.push(ev('agent.assigned', SYSTEM_ACTOR, `派发给 Agent ${agent.name}（${agent.kind}）`, { agent_id: agent.id }))
      steps.push(msg(agentActor(agent), pick(AGENT_ACKS).replace('{repo}', repo).replace('{branch}', branch), { kind: 'ack' }))
      steps.push(msg(agentActor(agent), pick(AGENT_PLANS), { kind: 'progress' }))
      if (seed.source === 'feishu' && rand() > 0.4) {
        steps.push(msg(memberActor(creator), '方案可以，注意别影响现有接口。'))
      }
      steps.push(ev('agent.tool', agentActor(agent), pick(AGENT_TOOLS), { kind: 'tool' }))
    }
  }

  if (st === 'input-required' && agent) {
    steps.push(msg(agentActor(agent), `需要确认：${seed.question ?? '有一处需求不明确，请补充。'}`, { kind: 'question' }))
    steps.push(stateChange('working', 'input-required', agentActor(agent)))
  }

  // 3. MR 与 CI
  const mrs: MergeRequest[] = []
  const hasMrStage =
    !seed.noMr &&
    seed.repos.length > 0 &&
    (st === 'auth-required' || st === 'completed' || st === 'failed' || (st === 'working' && seed.ci !== undefined))
  if (hasMrStage) {
    for (const r of seed.repos) {
      const mrState: MergeRequest['state'] = st === 'completed' ? 'merged' : st === 'failed' ? 'opened' : 'opened'
      const pipeline: MergeRequest['pipeline_status'] =
        st === 'completed' || st === 'auth-required' ? 'success' : st === 'failed' ? 'failed' : seed.ci === 'running' ? (r === seed.repos[0] ? 'running' : 'success') : seed.ci === 'pending' ? 'pending' : seed.ci === 'failed' ? 'failed' : 'success'
      const mr = nextMr(r, branch, mrState, pipeline, iso(updatedMs))
      mrs.push(mr)
      steps.push(ev('mr.opened', agent ? agentActor(agent) : memberActor(assignee ?? creator), `提交 MR !${mr.iid}（${r}）：${seed.title}`, { mr_id: mr.id, url: mr.url, repo: r }))
      steps.push(ev('pipeline.updated', GITLAB_ACTOR, `流水线 #${between(18000, 19999)} 开始运行（${r}）`, { status: 'running', repo: r }))
      if (pipeline === 'success') steps.push(ev('pipeline.updated', GITLAB_ACTOR, `流水线通过（${r}）`, { status: 'success', repo: r }))
      if (pipeline === 'failed') steps.push(ev('pipeline.updated', GITLAB_ACTOR, `流水线失败：单元测试 2 项未通过（${r}）`, { status: 'failed', repo: r }))
    }
  }

  if (st === 'working' && seed.ci === 'failed' && agent) {
    steps.push(ev('suggestion.executed', COORDINATOR_AGENT_ACTOR, 'CI 分诊：日志显示单测超时，判定为 Agent 可自修，已通知 Agent 重试', { scenario: 'ci_triage' }))
    steps.push(msg(agentActor(agent), '看到失败日志了，是测试数据集太大导致超时，正在改为抽样数据。', { kind: 'progress' }))
  }

  const approvals: Approval[] = []
  if (st === 'auth-required' || (st === 'completed' && mrs.length > 0)) {
    const reviewer = seed.repos.some((r) => r.startsWith('shop/order') || r.startsWith('shop/payment')) ? M['王强'] : M['张伟']
    const gate = seed.labels.includes('高风险') ? 'high_risk' : 'merge'
    const requested = assignee ?? creator
    const approval: Approval = {
      id: nextApprovalId(),
      gate,
      status: st === 'completed' ? 'approved' : 'pending',
      requested_by: ref(requested),
      decided_by: st === 'completed' ? ref(reviewer === requested ? M['杨帆'] : reviewer) : null,
      comment: st === 'completed' ? pick(['代码看过了，没问题', 'LGTM，注意上线后观察一下监控', '同意合并']) : null,
      created_at: iso(updatedMs - 2 * HOUR),
      decided_at: st === 'completed' ? iso(updatedMs - 0.5 * HOUR) : null,
    }
    approvals.push(approval)
    steps.push(ev('approval.requested', memberActor(requested), `${requested.name} 请求${gate === 'high_risk' ? '高风险操作' : '合并'}审批`, { approval_id: approval.id, gate }))
    steps.push(stateChange('working', 'auth-required'))
    if (st === 'completed' && approval.decided_by) {
      steps.push(ev('approval.decided', memberActor(approval.decided_by), `${approval.decided_by.name} 同意了审批：${approval.comment}`, { approval_id: approval.id, decision: 'approve' }))
      for (const mr of mrs) steps.push(ev('mr.merged', GITLAB_ACTOR, `MR !${mr.iid} 已合并到 main（${mr.repo}）`, { mr_id: mr.id }))
    }
  }

  if (st === 'completed') {
    if (mrs.length === 0) {
      steps.push(ev('task.completed', memberActor(creator), `${creator.name} 确认完成：已验收`, null))
    }
    steps.push(stateChange(mrs.length > 0 ? 'auth-required' : 'working', 'completed'))
  }
  if (st === 'failed') {
    steps.push(ev('ci.retry', SYSTEM_ACTOR, '流水线失败，自动重试（第 2 次）', null))
    steps.push(ev('state.changed', SYSTEM_ACTOR, '流水线连续 3 次失败，超过重试上限，任务标记为失败', { from: 'working', to: 'failed' }))
  }
  if (st === 'working' && seed.updated > 40) {
    steps.push(ev('patrol.reminded', COORDINATOR_AGENT_ACTOR, '定时巡检：任务超过 48 小时无进展，已提醒负责人', { scenario: 'patrol' }))
  }

  // 时间铺开
  const span = Math.max(updatedMs - createdMs, 10 * MIN)
  const timeline: TimelineItem[] = steps.map((s, i) => {
    const at = steps.length === 1 ? createdMs : createdMs + Math.round((span * i) / (steps.length - 1))
    return { ...s, id: s.kind === 'message' ? nextMessageId() : nextEventId(), at: iso(at) }
  })

  // 建议
  const suggestions: Suggestion[] = []
  const sugBase = { task_id: id, created_at: iso(createdMs + 2 * MIN), decided_by: null }
  if (seed.source === 'feishu') {
    suggestions.push({ ...sugBase, id: nextSuggestionId(), scenario: 'intake', level: 'L0', status: 'accepted', summary: `整理为结构化任务：「${seed.title}」，涉及 ${seed.repos.join('、') || '无代码仓库'}`, payload: { repos: seed.repos, skills: seed.skills }, decided_by: ref(creator) })
  }
  if (st === 'submitted' && seed.suggested) {
    const target = M[seed.suggested]
    suggestions.push({ ...sugBase, id: nextSuggestionId(), scenario: 'dispatch', level: 'L0', status: 'proposed', summary: `建议派给 ${target.name}：技能匹配 ${seed.skills.join('、')}，熟悉 ${seed.repos[0]}，当前负载 ${between(0, 2)} 个任务`, payload: { member_id: target.id, member_name: target.name } })
  } else if (st === 'submitted' && !seed.demo) {
    const cand = members.find((m) => m.roles.includes('developer') && m.name !== seed.creator && m.is_active) ?? M['周杰']
    suggestions.push({ ...sugBase, id: nextSuggestionId(), scenario: 'dispatch', level: 'L0', status: 'proposed', summary: `建议派给 ${cand.name}：最近 30 天完成过同仓库任务`, payload: { member_id: cand.id, member_name: cand.name } })
  }
  if (st === 'input-required') {
    suggestions.push({ ...sugBase, id: nextSuggestionId(), scenario: 'input_answer', level: 'L0', status: 'proposed', summary: '在 ACP-128 的讨论里找到类似结论：按商品金额比例分摊，可直接作为回答', payload: { answer: '按商品金额比例分摊运费', reference: 'ACP-128' }, created_at: iso(updatedMs + 5 * MIN) })
  }
  if (seed.ci === 'failed') {
    suggestions.push({ ...sugBase, id: nextSuggestionId(), scenario: 'ci_triage', level: 'L1', status: st === 'failed' ? 'undone' : 'executed', summary: st === 'failed' ? '判定为环境问题并自动重试（已被撤销，转人工处理）' : '判定为 Agent 可自修：单测超时，已通知 Agent 重试', payload: { category: 'agent_fixable', retry: 1 }, decided_by: st === 'failed' ? ref(assignee ?? creator) : null, created_at: iso(updatedMs - HOUR) })
  }
  if (st === 'working' && seed.updated > 40) {
    suggestions.push({ ...sugBase, id: nextSuggestionId(), scenario: 'patrol', level: 'L1', status: 'executed', summary: '任务超过 48 小时无进展，已在飞书提醒负责人', payload: { reminded: assignee?.name ?? null }, created_at: iso(NOW - 2 * HOUR) })
  }

  const closed = st === 'completed' || st === 'failed' || st === 'canceled' || st === 'rejected'
  const lastStateChange = [...timeline].reverse().find((t) => t.type === 'state.changed' || t.type === 'task.canceled')

  return {
    id,
    key: `ACP-${id}`,
    title: seed.title,
    state: st,
    type: seed.type ?? (parentId ? 'subtask' : 'requirement'),
    priority: seed.priority,
    source: seed.source,
    repos: seed.repos,
    skills: seed.skills,
    labels: seed.labels,
    creator: ref(creator),
    assignee: assignee ? ref(assignee) : null,
    assignee_agent: agent && assignee && !closed ? { id: agent.id, name: agent.name, kind: agent.kind } : agent && closed && assignee ? { id: agent.id, name: agent.name, kind: agent.kind } : null,
    suggested_assignee: st === 'submitted' && seed.suggested ? ref(M[seed.suggested]) : null,
    parent_id: parentId,
    root_id: id,
    depth: 0,
    children_count: 0,
    mr_count: mrs.length,
    mr_merged: mrs.filter((m) => m.state === 'merged').length,
    ci_status: aggregateCi(mrs),
    created_at: iso(createdMs),
    updated_at: iso(updatedMs),
    state_changed_at: lastStateChange?.at ?? iso(createdMs),
    closed_at: closed ? iso(updatedMs) : null,
    is_demo: seed.demo ?? false,
    description: seed.description,
    source_ref: buildSourceRef(seed, creator),
    merge_requests: mrs,
    approvals,
    children: [],
    timeline,
    suggestions,
    allowed_actions: [],
  }
}

function buildSourceRef(seed: TaskSeed, creator: Member): Record<string, unknown> {
  switch (seed.source) {
    case 'feishu':
      return {
        chat_id: `oc_${hex(32)}`,
        chat_name: pick(['交易研发群', '大促作战室', '数据需求群']),
        message_id: `om_${hex(32)}`,
        sender_name: creator.name,
        text: `@派活 机器人 ${seed.title}，${seed.description.split('\n')[0]}`,
        intake_mode: pick(['at_mention', 'shortcut']),
      }
    case 'gitlab':
      return { project: seed.repos[0], pipeline_id: between(18000, 19999), ref: 'main', url: `https://gitlab.example.com/${seed.repos[0]}/-/pipelines` }
    case 'agent': {
      const a = agentOf(seed.creator)
      return { agent_id: a?.id ?? null, agent_name: a?.name ?? null }
    }
    case 'api':
      return { client: 'n8n', workflow: '建单流' }
    default:
      return {}
  }
}

export const tasks: TaskDetail[] = (() => {
  // parent: 0 表示挂到第一个任务（订单导出）下
  const list = TASK_SEEDS.map((seed, i) => buildTask(seed, FIRST_ID + i, seed.parent !== undefined ? FIRST_ID + seed.parent : null))
  const byId = new Map(list.map((t) => [t.id, t]))
  for (const t of list) {
    if (t.parent_id !== null) {
      const parent = byId.get(t.parent_id)
      if (parent) {
        t.root_id = parent.root_id
        t.depth = parent.depth + 1
      }
    }
  }
  // 给 Agent 回填当前任务
  for (const a of agents) {
    a.current_task_ids = list
      .filter((t) => t.assignee_agent?.id === a.id && (t.state === 'working' || t.state === 'input-required'))
      .map((t) => t.id)
    a.max_concurrency = Math.max(a.max_concurrency, a.current_task_ids.length)
  }
  return list
})()

// ---------- 数据来源事件 ----------

const SOURCE_EVENT_KINDS: Record<SourceEventSource, { kind: string; summary: string }[]> = {
  feishu: [
    { kind: 'message', summary: '群消息 @机器人：{title}' },
    { kind: 'card_action', summary: '卡片按钮「认领」：{key}' },
    { kind: 'shortcut', summary: '消息快捷操作「转为任务」' },
    { kind: 'message', summary: '群消息（未 @机器人，全群读取判定为非需求）' },
  ],
  gitlab: [
    { kind: 'pipeline', summary: '流水线 #{pipe} 状态变更：success' },
    { kind: 'merge_request', summary: 'MR !{iid} 已打开' },
    { kind: 'push', summary: '推送到分支 acp/{id}-*' },
    { kind: 'pipeline', summary: '流水线 #{pipe} 状态变更：failed' },
  ],
  board: [
    { kind: 'task.create', summary: '任务榜创建任务：{title}' },
    { kind: 'task.claim', summary: '任务榜认领：{key}' },
  ],
  agent: [
    { kind: 'report_progress', summary: 'Agent 上报进度：{key}' },
    { kind: 'create_task', summary: 'Agent 发起求助子任务' },
    { kind: 'request_input', summary: 'Agent 请求补充信息：{key}' },
  ],
  system: [
    { kind: 'patrol', summary: '定时巡检：发现 {n} 个卡住的任务' },
    { kind: 'heartbeat_timeout', summary: 'Agent 心跳超时，回收任务' },
  ],
}

export const sourceEvents: SourceEvent[] = (() => {
  const out: SourceEvent[] = []
  const weights: [SourceEventSource, number][] = [
    ['feishu', 0.34],
    ['gitlab', 0.3],
    ['agent', 0.2],
    ['board', 0.12],
    ['system', 0.04],
  ]
  let id = 20000
  for (let i = 0; i < 160; i++) {
    const r = rand()
    let acc = 0
    let source: SourceEventSource = 'feishu'
    for (const [s, w] of weights) {
      acc += w
      if (r <= acc) {
        source = s
        break
      }
    }
    const tpl = pick(SOURCE_EVENT_KINDS[source])
    const task = pick(tasks)
    const linked = !tpl.summary.includes('非需求') && rand() > 0.15
    const status: SourceEvent['status'] = tpl.summary.includes('非需求') ? 'ignored' : rand() < 0.06 ? 'error' : rand() < 0.08 ? 'ignored' : 'processed'
    // 越近越密：前 40 条集中在 24 小时内
    const agoH = i < 40 ? rand() * 24 : 24 + rand() * 24 * 6
    id += 1
    out.push({
      id,
      source,
      kind: tpl.kind,
      summary: tpl.summary
        .replace('{title}', task.title)
        .replace('{key}', task.key)
        .replace('{id}', String(task.id))
        .replace('{pipe}', String(between(18000, 19999)))
        .replace('{n}', String(between(1, 3)))
        .replace('{iid}', String(between(30, 90))) + (status === 'error' ? '（处理失败：签名校验不通过）' : ''),
      status,
      task_id: linked ? task.id : null,
      task_key: linked ? task.key : null,
      at: iso(NOW - agoH * HOUR),
    })
  }
  return out.sort((a, b) => b.at.localeCompare(a.at))
})()

// ---------- n8n ----------

export const workflows: Workflow[] = [
  { id: 'acpFeishuEvents1', name: 'ACP · 飞书事件', active: true, updated_at: iso(NOW - 26 * HOUR) },
  { id: 'acpGitlabEvents1', name: 'ACP · GitLab 回执', active: true, updated_at: iso(NOW - 3 * 24 * HOUR) },
  { id: 'acpNotifyOutbox1', name: 'ACP · 通知出口', active: true, updated_at: iso(NOW - 2 * 24 * HOUR) },
]

export const executions: WorkflowExecution[] = (() => {
  const out: WorkflowExecution[] = []
  for (let i = 0; i < 60; i++) {
    const wf = pick(workflows)
    const startedMs = NOW - (i * 11 + between(1, 9)) * MIN
    const r = rand()
    // 通知出口偶尔失败（飞书限流之类），其余基本成功
    const status = i === 0 ? 'running' : wf.id === 'acpNotifyOutbox1' && r < 0.22 ? 'error' : r < 0.03 ? 'error' : 'success'
    out.push({
      id: String(88000 - i),
      workflow_name: wf.name,
      status,
      started_at: iso(startedMs),
      stopped_at: status === 'running' ? null : iso(startedMs + between(1, 40) * 1000),
      mode: r > 0.97 ? 'manual' : 'webhook',
    })
  }
  return out
})()

// ---------- 设置 ----------

export const settings: Settings = {
  autonomy: {
    intake: 'L0',
    dispatch: 'L0',
    help_routing: 'L0',
    input_answer: 'L0',
    ci_triage: 'L1',
    qa: 'L1',
    patrol: 'L1',
  },
  intake_modes: ['at_mention', 'shortcut'],
  feishu_chat_ids: ['oc_8f3a2c1d9e7b6a5f4c3b2a1d0e9f8a7b', 'oc_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d'],
  notify_mode: 'n8n',
  llm_enabled: true,
  version: '0.9.0-mock',
  public_url: 'https://acp.example.com',
  n8n_url: 'https://n8n.example.com',
}
