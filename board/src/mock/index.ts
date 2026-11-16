/**
 * 模拟后端（VITE_MOCK=1 时由 main.tsx 动态加载）。
 * 拦截 window.fetch 中属于 coordinator 的路径（/api、/auth、/healthz…），在内存里实现契约行为；
 * 同时把任务详情的 SSE 换成内存事件流，并定时模拟 Agent 上报进度。
 */
import { setTaskStreamFactory, type TaskStreamHandlers } from '@/lib/api'
import type {
  Agent,
  Member,
  Overview,
  Paged,
  Priority,
  Source,
  TaskDetail,
  TaskState,
  TaskSummary,
  TimelineItem,
} from '@/types/api'
import {
  COORDINATOR_AGENT_ACTOR,
  NOW,
  SYSTEM_ACTOR,
  agentActor,
  agents,
  aggregateCi,
  executions,
  iso,
  members,
  memberActor,
  nextApprovalId,
  nextEventId,
  nextMessageId,
  nextMr,
  pick,
  ref,
  settings,
  sourceEvents,
  tasks,
  workflows,
} from './seed'

const STATE_LABEL: Record<TaskState, string> = {
  submitted: '待认领',
  working: '进行中',
  'input-required': '待补充',
  'auth-required': '待审批',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
  rejected: '已拒绝',
}
const OPEN: TaskState[] = ['submitted', 'working', 'input-required', 'auth-required']
const TERMINAL: TaskState[] = ['completed', 'failed', 'canceled', 'rejected']
const PRIORITY_RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, urgent: 3 }
const STATE_RANK: Record<TaskState, number> = {
  submitted: 0,
  working: 1,
  'input-required': 2,
  'auth-required': 3,
  completed: 4,
  failed: 5,
  canceled: 6,
  rejected: 7,
}

// ---------- 错误与响应 ----------

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function json(body: unknown, status = 200) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

const now = () => iso(Date.now())

// ---------- 令牌 ----------

function b64url(input: string) {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  bytes.forEach((b) => (binary += String.fromCharCode(b)))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(input: string) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4))
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
}

export function mockToken(m: Member, ttlSeconds = 7 * 24 * 3600) {
  const iat = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'mock' }))
  const payload = b64url(
    JSON.stringify({
      iss: location.origin,
      aud: 'acp',
      sub: m.id,
      name: m.name,
      roles: m.roles,
      act: 'member',
      iat,
      exp: iat + ttlSeconds,
      jti: Math.random().toString(36).slice(2),
    }),
  )
  return `${header}.${payload}.mock-signature`
}

function currentMember(req: Request): Member {
  const auth = req.headers.get('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : new URL(req.url).searchParams.get('access_token')
  if (!token) throw new HttpError(401, 'unauthorized', '请先登录')
  try {
    const claims = JSON.parse(fromB64url(token.split('.')[1] ?? '')) as { sub?: string; exp?: number }
    if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error('expired')
    const m = members.find((x) => x.id === claims.sub)
    if (!m || !m.is_active) throw new Error('no member')
    return m
  } catch {
    throw new HttpError(401, 'unauthorized', '登录已失效，请重新登录')
  }
}

// ---------- 任务工具 ----------

function summarize(t: TaskDetail): TaskSummary {
  return {
    id: t.id,
    key: t.key,
    title: t.title,
    state: t.state,
    type: t.type,
    priority: t.priority,
    source: t.source,
    repos: t.repos,
    skills: t.skills,
    labels: t.labels,
    creator: t.creator,
    assignee: t.assignee,
    assignee_agent: t.assignee_agent,
    suggested_assignee: t.suggested_assignee,
    parent_id: t.parent_id,
    root_id: t.root_id,
    depth: t.depth,
    children_count: tasks.filter((c) => c.parent_id === t.id).length,
    mr_count: t.merge_requests.length,
    mr_merged: t.merge_requests.filter((m) => m.state === 'merged').length,
    ci_status: aggregateCi(t.merge_requests),
    created_at: t.created_at,
    updated_at: t.updated_at,
    state_changed_at: t.state_changed_at,
    closed_at: t.closed_at,
    is_demo: t.is_demo,
  }
}

function descendants(id: number): TaskSummary[] {
  const out: TaskSummary[] = []
  const walk = (pid: number) => {
    for (const c of tasks.filter((x) => x.parent_id === pid)) {
      out.push(summarize(c))
      walk(c.id)
    }
  }
  walk(id)
  return out
}

function allowedActions(t: TaskDetail, me: Member): string[] {
  const a = new Set<string>()
  const isAdmin = me.roles.includes('admin')
  const isDev = me.roles.includes('developer')
  const isReviewer = me.roles.includes('reviewer') || isAdmin
  const isCreator = t.creator?.id === me.id
  const isAssignee = t.assignee?.id === me.id
  a.add('message')
  if (TERMINAL.includes(t.state)) return [...a]
  if (isCreator || isAdmin) {
    a.add('edit')
    a.add('cancel')
  }
  switch (t.state) {
    case 'submitted':
      if (!t.assignee && isDev) a.add('claim')
      if (isAdmin) a.add('assign')
      if (t.suggested_assignee?.id === me.id) {
        a.add('accept')
        a.add('decline')
      }
      break
    case 'working':
      if (isAssignee || isAdmin) a.add('request_approval')
      if ((isCreator || isAdmin) && t.merge_requests.length === 0) a.add('complete')
      break
    case 'input-required':
      if (isCreator || isAssignee || isAdmin) a.add('input')
      break
    case 'auth-required':
      if (isReviewer && t.approvals.some((p) => p.status === 'pending')) {
        a.add('approve')
        a.add('reject')
      }
      break
  }
  return [...a]
}

function detail(t: TaskDetail, me: Member): TaskDetail {
  return {
    ...t,
    ...summarize(t),
    children: descendants(t.id),
    timeline: [...t.timeline].sort((x, y) => x.at.localeCompare(y.at)),
    allowed_actions: allowedActions(t, me),
  }
}

function findTask(id: number) {
  const t = tasks.find((x) => x.id === id)
  if (!t) throw new HttpError(404, 'not_found', `任务 ACP-${id} 不存在`)
  return t
}

function requireState(t: TaskDetail, states: TaskState[], action: string) {
  if (!states.includes(t.state)) {
    throw new HttpError(409, 'invalid_state', `任务处于「${STATE_LABEL[t.state]}」，不能${action}`)
  }
}

function requireAction(t: TaskDetail, me: Member, action: string, label: string) {
  if (!allowedActions(t, me).includes(action)) {
    throw new HttpError(403, 'forbidden', `你没有权限${label}`)
  }
}

// ---------- 实时流 ----------

const subscribers = new Map<number, Set<TaskStreamHandlers>>()

function publish(t: TaskDetail, items: TimelineItem[]) {
  const subs = subscribers.get(t.id)
  if (!subs) return
  const summary = summarize(t)
  // 稍作延迟，模拟服务端推送
  setTimeout(() => {
    subs.forEach((h) => {
      items.forEach((item) => h.onTimeline(item))
      h.onTask(summary)
    })
  }, 120)
}

function push(t: TaskDetail, item: Omit<TimelineItem, 'id' | 'at'>, at = now()): TimelineItem {
  const full: TimelineItem = {
    ...item,
    id: item.kind === 'message' ? nextMessageId() : nextEventId(),
    at,
  }
  t.timeline.push(full)
  t.updated_at = at
  return full
}

function setState(t: TaskDetail, to: TaskState, actor: TimelineItem['actor'] = SYSTEM_ACTOR) {
  const from = t.state
  if (from === to) return null
  t.state = to
  t.state_changed_at = now()
  if (TERMINAL.includes(to)) t.closed_at = now()
  return push(t, {
    kind: 'event',
    type: 'state.changed',
    actor,
    text: `状态：${STATE_LABEL[from]} → ${STATE_LABEL[to]}`,
    data: { from, to },
  })
}

function agentFor(memberId: string): Agent | null {
  return (
    agents.find((a) => a.member.id === memberId && a.status !== 'offline') ??
    agents.find((a) => a.member.id === memberId) ??
    null
  )
}

const AGENT_PROGRESS = [
  '已完成接口层改动，正在补充单元测试。',
  '本地测试通过，正在整理提交说明。',
  '发现一处边界情况：空列表时返回 null，已改为返回空数组。',
  '依赖升级后有 2 个废弃 API，已替换。',
  '正在跑完整测试集，预计 3 分钟。',
  '代码已推送到分支，等待流水线结果。',
  '对照需求逐条自查完毕，没有遗漏。',
]

/** 认领后模拟 Agent 自动开工 */
function simulateAgentStart(t: TaskDetail) {
  const agent = t.assignee_agent ? agents.find((a) => a.id === t.assignee_agent?.id) : null
  if (!agent) return
  const branch = `acp/${t.id}-${t.title.length > 0 ? 'task' : 'x'}`
  setTimeout(() => {
    if (t.state !== 'working') return
    const item = push(t, {
      kind: 'message',
      type: 'message',
      actor: agentActor(agent),
      text: `收到任务，正在准备工作区：已克隆 ${t.repos[0] ?? '仓库'}，创建分支 ${branch}。`,
      data: { kind: 'ack' },
    })
    publish(t, [item])
  }, 2500)
  setTimeout(() => {
    if (t.state !== 'working') return
    const item = push(t, {
      kind: 'message',
      type: 'message',
      actor: agentActor(agent),
      text: '已读完相关代码，改动范围不大，开始实现。',
      data: { kind: 'progress' },
    })
    publish(t, [item])
  }, 7000)
}

function startTicker() {
  setInterval(() => {
    const watched = [...subscribers.keys()]
      .map((id) => tasks.find((t) => t.id === id))
      .filter((t): t is TaskDetail => !!t && t.state === 'working' && !!t.assignee_agent)
    const pool = watched.length > 0 && Math.random() < 0.7 ? watched : tasks.filter((t) => t.state === 'working' && t.assignee_agent)
    if (pool.length === 0) return
    const t = pick(pool)
    const agent = agents.find((a) => a.id === t.assignee_agent?.id)
    if (!agent) return
    const item = push(t, {
      kind: 'message',
      type: 'message',
      actor: agentActor(agent),
      text: pick(AGENT_PROGRESS),
      data: { kind: 'progress' },
    })
    publish(t, [item])
  }, 15_000)
}

// ---------- 总览 ----------

function overview(days: number, tasks: TaskDetail[]): Overview {
  const by_state = Object.fromEntries(Object.keys(STATE_LABEL).map((s) => [s, 0])) as Record<TaskState, number>
  tasks.forEach((t) => (by_state[t.state] += 1))
  const DAY = 24 * 3600 * 1000
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const trend = Array.from({ length: days }, (_, i) => {
    const dayStart = start.getTime() - (days - 1 - i) * DAY
    const dayEnd = dayStart + DAY
    const inDay = (s: string | null) => {
      if (!s) return false
      const ms = Date.parse(s)
      return ms >= dayStart && ms < dayEnd
    }
    // 模拟数据量较小，叠加一点稳定的基线让曲线更像真实团队
    const base = Math.round(2 + 1.5 * Math.sin(i / 2) + ((i * 7) % 3))
    return {
      date: new Date(dayStart).toISOString().slice(0, 10),
      created: base + tasks.filter((t) => inDay(t.created_at)).length,
      completed: Math.max(0, base - 1 + tasks.filter((t) => t.state === 'completed' && inDay(t.closed_at)).length),
    }
  })
  const weekAgo = Date.now() - 7 * DAY
  const completed7 = tasks.filter((t) => t.state === 'completed' && t.closed_at && Date.parse(t.closed_at) >= weekAgo)
  const lead = completed7.map((t) => (Date.parse(t.closed_at ?? t.updated_at) - Date.parse(t.created_at)) / 3600_000)
  const allMrs = tasks.flatMap((t) => t.merge_requests).filter((m) => m.pipeline_status === 'success' || m.pipeline_status === 'failed')
  const sources: Source[] = ['feishu', 'board', 'agent', 'gitlab', 'api']
  const assigneeMap = new Map<string, Overview['by_assignee'][number]>()
  tasks.forEach((t) => {
    if (!t.assignee) return
    const row = assigneeMap.get(t.assignee.id) ?? { member: t.assignee, open: 0, working: 0, completed: 0 }
    if (t.state === 'working') row.working += 1
    else if (OPEN.includes(t.state)) row.open += 1
    else if (t.state === 'completed') row.completed += 1
    assigneeMap.set(t.assignee.id, row)
  })
  const repoMap = new Map<string, { repo: string; open: number; total: number }>()
  tasks.forEach((t) =>
    t.repos.forEach((r) => {
      const row = repoMap.get(r) ?? { repo: r, open: 0, total: 0 }
      row.total += 1
      if (OPEN.includes(t.state)) row.open += 1
      repoMap.set(r, row)
    }),
  )
  const recent = tasks
    .flatMap((t) => t.timeline.map((item) => ({ ...item, task_id: t.id, task_key: t.key, task_title: t.title })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20)
  const stale = Date.now() - 48 * 3600 * 1000
  const attention = tasks
    .filter((t) => t.state === 'input-required' || t.state === 'auth-required' || (t.state === 'working' && Date.parse(t.updated_at) < stale) || (t.state === 'submitted' && t.priority === 'urgent'))
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
    .map(summarize)

  return {
    counts: { total: tasks.length, open: tasks.filter((t) => OPEN.includes(t.state)).length, by_state },
    kpis: {
      created_7d: tasks.filter((t) => Date.parse(t.created_at) >= weekAgo).length + 9,
      completed_7d: completed7.length + 6,
      avg_lead_time_hours: lead.length ? Math.round((lead.reduce((a, b) => a + b, 0) / lead.length) * 10) / 10 : null,
      ci_pass_rate: allMrs.length ? allMrs.filter((m) => m.pipeline_status === 'success').length / allMrs.length : null,
      agents_online: agents.filter((a) => a.status !== 'offline').length,
      members_active: members.filter((m) => m.is_active && m.last_login_at && Date.parse(m.last_login_at) > weekAgo).length,
    },
    trend,
    by_source: sources.map((s) => ({ source: s, count: tasks.filter((t) => t.source === s).length })),
    by_assignee: [...assigneeMap.values()].sort((a, b) => b.open + b.working - (a.open + a.working)),
    by_repo: [...repoMap.values()].sort((a, b) => b.total - a.total),
    recent,
    attention,
  }
}

// ---------- 路由 ----------

type Handler = (ctx: { req: Request; url: URL; params: string[]; body: Record<string, unknown> }) => unknown

const routes: [string, RegExp, Handler][] = []
function route(method: string, pattern: string, handler: Handler) {
  const re = new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$')
  routes.push([method, re, handler])
}

function paged<T>(items: T[], url: URL): Paged<T> {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('page_size') ?? 20) || 20))
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, page_size: pageSize }
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

// 认证
route('GET', '/auth/providers', () => ({ feishu: true, local: true, dev: true }))
route('POST', '/auth/local', ({ body }) => {
  if (str(body.username) !== 'admin' || str(body.password) !== 'admin') {
    throw new HttpError(401, 'unauthorized', '用户名或密码错误（示例模式请用 admin / admin）')
  }
  const m = members[0]
  m.last_login_at = now()
  return { token: mockToken(m), member: m }
})
route('POST', '/auth/dev', ({ body }) => {
  const name = str(body.name)
  const asAdmin = body.admin === true
  if (!name) throw new HttpError(422, 'validation_error', '请输入名字')
  let m = members.find((x) => x.name === name)
  if (!m) {
    m = {
      id: crypto.randomUUID(),
      name,
      avatar_url: null,
      roles: asAdmin ? ['member', 'developer', 'reviewer', 'admin'] : ['member', 'developer'],
      team: null,
      gitlab_username: null,
      feishu_open_id: null,
      is_active: true,
      created_at: now(),
      last_login_at: now(),
      stats: { open: 0, working: 0, completed_30d: 0 },
    }
    members.push(m)
  }
  if (asAdmin && !m.roles.includes('admin')) m.roles = [...m.roles, 'admin']
  m.last_login_at = now()
  return { token: mockToken(m), member: m }
})
route('POST', '/auth/refresh', ({ req }) => ({ token: mockToken(currentMember(req)) }))
route('GET', '/healthz', () => ({ status: 'ok', version: settings.version, db: 'ok' }))

// 我
route('GET', '/api/me', ({ req }) => ({ member: withStats(currentMember(req)) }))

function withStats(m: Member): Member {
  const thirty = Date.now() - 30 * 24 * 3600 * 1000
  return {
    ...m,
    stats: {
      open: tasks.filter((t) => t.assignee?.id === m.id && OPEN.includes(t.state) && t.state !== 'working').length,
      working: tasks.filter((t) => t.assignee?.id === m.id && t.state === 'working').length,
      completed_30d: tasks.filter((t) => t.assignee?.id === m.id && t.state === 'completed' && t.closed_at && Date.parse(t.closed_at) > thirty).length,
    },
  }
}

route('GET', '/api/overview', ({ req, url }) => {
  currentMember(req)
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 14) || 14))
  const demo = url.searchParams.get('demo')
  return overview(days, demo === null ? tasks : tasks.filter((t) => t.is_demo === (demo === 'true')))
})

// 任务
route('GET', '/api/tasks', ({ req, url }) => {
  const me = currentMember(req)
  const p = url.searchParams
  let list = [...tasks]
  if (p.has('demo')) list = list.filter((t) => t.is_demo === (p.get('demo') === 'true'))
  const q = p.get('q')?.trim().toLowerCase()
  if (q) list = list.filter((t) => t.title.toLowerCase().includes(q) || t.key.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
  const states = p.get('state')?.split(',').filter(Boolean)
  if (states?.length) list = list.filter((t) => states.includes(t.state))
  const assignee = p.get('assignee')
  if (assignee === 'me') list = list.filter((t) => t.assignee?.id === me.id)
  else if (assignee === 'none') list = list.filter((t) => !t.assignee)
  else if (assignee) list = list.filter((t) => t.assignee?.id === assignee)
  const creator = p.get('creator')
  if (creator) list = list.filter((t) => t.creator?.id === (creator === 'me' ? me.id : creator))
  const source = p.get('source')
  if (source) list = list.filter((t) => t.source === source)
  const repo = p.get('repo')
  if (repo) list = list.filter((t) => t.repos.includes(repo))
  const priority = p.get('priority')
  if (priority) list = list.filter((t) => t.priority === priority)
  const type = p.get('type')
  if (type) list = list.filter((t) => t.type === type)
  const parent = p.get('parent')
  if (parent) list = list.filter((t) => String(t.parent_id) === parent)
  const sort = p.get('sort') || '-updated_at'
  const desc = sort.startsWith('-')
  const field = desc ? sort.slice(1) : sort
  const value = (t: TaskDetail): string | number => {
    switch (field) {
      case 'priority':
        return PRIORITY_RANK[t.priority]
      case 'state':
        return STATE_RANK[t.state]
      case 'id':
        return t.id
      case 'title':
        return t.title
      case 'created_at':
        return t.created_at
      case 'state_changed_at':
        return t.state_changed_at
      default:
        return t.updated_at
    }
  }
  list.sort((a, b) => {
    const va = value(a)
    const vb = value(b)
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'zh-CN')
    return desc ? -c : c
  })
  return paged(list.map(summarize), url)
})

route('POST', '/api/tasks', ({ req, body }) => {
  const me = currentMember(req)
  const title = str(body.title)
  if (!title) throw new HttpError(422, 'validation_error', '标题不能为空')
  if (title.length > 200) throw new HttpError(422, 'validation_error', '标题不能超过 200 字')
  const id = Math.max(...tasks.map((t) => t.id)) + 1
  const parentId = typeof body.parent_id === 'number' ? body.parent_id : null
  const parent = parentId ? findTask(parentId) : null
  const suggested = typeof body.suggested_assignee_id === 'string' ? members.find((m) => m.id === body.suggested_assignee_id) : undefined
  const at = now()
  const t: TaskDetail = {
    id,
    key: `ACP-${id}`,
    title,
    state: 'submitted',
    type: parent ? 'subtask' : 'requirement',
    priority: (['low', 'normal', 'high', 'urgent'] as const).includes(body.priority as Priority) ? (body.priority as Priority) : 'normal',
    source: 'board',
    repos: Array.isArray(body.repos) ? (body.repos as string[]) : [],
    skills: Array.isArray(body.skills) ? (body.skills as string[]) : [],
    labels: Array.isArray(body.labels) ? (body.labels as string[]) : [],
    creator: ref(me),
    assignee: null,
    assignee_agent: null,
    suggested_assignee: suggested ? ref(suggested) : null,
    parent_id: parent?.id ?? null,
    root_id: parent?.root_id ?? id,
    depth: parent ? parent.depth + 1 : 0,
    children_count: 0,
    mr_count: 0,
    mr_merged: 0,
    ci_status: 'none',
    created_at: at,
    updated_at: at,
    state_changed_at: at,
    closed_at: null,
    is_demo: false,
    description: str(body.description),
    source_ref: {},
    merge_requests: [],
    approvals: [],
    children: [],
    timeline: [],
    suggestions: [],
    allowed_actions: [],
  }
  push(t, { kind: 'event', type: 'task.created', actor: memberActor(me), text: `${me.name} 在任务榜创建了任务`, data: { source: 'board' } }, at)
  if (suggested) {
    push(t, { kind: 'event', type: 'notify.sent', actor: SYSTEM_ACTOR, text: `已向 ${suggested.name} 发送派工卡片`, data: null }, at)
  }
  tasks.unshift(t)
  return detail(t, me)
})

route('GET', '/api/tasks/:id', ({ req, params }) => detail(findTask(Number(params[0])), currentMember(req)))

route('PATCH', '/api/tasks/:id', ({ req, params, body }) => {
  const me = currentMember(req)
  const t = findTask(Number(params[0]))
  requireAction(t, me, 'edit', '编辑这个任务')
  const changed: string[] = []
  if (typeof body.title === 'string' && body.title.trim() && body.title !== t.title) {
    t.title = body.title.trim()
    changed.push('标题')
  }
  if (typeof body.description === 'string' && body.description !== t.description) {
    t.description = body.description
    changed.push('描述')
  }
  if (Array.isArray(body.repos)) {
    t.repos = body.repos as string[]
    changed.push('仓库')
  }
  if (Array.isArray(body.labels)) {
    t.labels = body.labels as string[]
    changed.push('标签')
  }
  if (Array.isArray(body.skills)) {
    t.skills = body.skills as string[]
    changed.push('技能')
  }
  if (typeof body.priority === 'string' && body.priority !== t.priority) {
    t.priority = body.priority as Priority
    changed.push('优先级')
  }
  if (changed.length) {
    const item = push(t, { kind: 'event', type: 'task.updated', actor: memberActor(me), text: `${me.name} 修改了${changed.join('、')}`, data: { fields: changed } })
    publish(t, [item])
  }
  return detail(t, me)
})

route('POST', '/api/tasks/:id/claim', ({ req, params }) => {
  const me = currentMember(req)
  const t = findTask(Number(params[0]))
  requireState(t, ['submitted'], '认领')
  if (t.assignee) throw new HttpError(409, 'conflict', `已被 ${t.assignee.name} 认领`)
  requireAction(t, me, 'claim', '认领任务（需要开发角色）')
  return doClaim(t, me, `${me.name} 认领了任务`)
})

function doClaim(t: TaskDetail, me: Member, text: string) {
  t.assignee = ref(me)
  t.suggested_assignee = null
  const agent = agentFor(me.id)
  t.assignee_agent = agent ? { id: agent.id, name: agent.name, kind: agent.kind } : null
  const items = [push(t, { kind: 'event', type: 'task.claimed', actor: memberActor(me), text, data: null })]
  const sc = setState(t, 'working')
  if (sc) items.push(sc)
  if (agent) {
    items.push(push(t, { kind: 'event', type: 'agent.assigned', actor: SYSTEM_ACTOR, text: agent.status === 'offline' ? `Agent ${agent.name} 离线，上线后自动开始` : `派发给 Agent ${agent.name}（${agent.kind}）`, data: { agent_id: agent.id } }))
    if (!agent.current_task_ids.includes(t.id)) agent.current_task_ids.push(t.id)
  }
  t.suggestions.filter((s) => s.scenario === 'dispatch' && s.status === 'proposed').forEach((s) => (s.status = 'rejected'))
  publish(t, items)
  if (agent && agent.status !== 'offline') simulateAgentStart(t)
  return detail(t, me)
}

route('POST', '/api/tasks/:id/assign', ({ req, params, body }) => {
  const me = currentMember(req)
  const t = findTask(Number(params[0]))
  requireAction(t, me, 'assign', '派工（需要管理员）')
  const target = members.find((m) => m.id === body.member_id)
  if (!target) throw new HttpError(422, 'validation_error', '成员不存在')
  t.suggested_assignee = ref(target)
  const item = push(t, { kind: 'event', type: 'task.assigned', actor: memberActor(me), text: `${me.name} 派工给 ${target.name}，已发送派工卡片`, data: { member_id: target.id } })
  publish(t, [item])
  return detail(t, me)
})

route('POST', '/api/tasks/:id/accept', ({ req, params }) => {
  const me = currentMember(req)
  const t = findTask(Number(params[0]))
  requireState(t, ['submitted'], '接受')
  if (t.suggested_assignee?.id !== me.id) throw new HttpError(403, 'forbidden', '这个任务没有派给你')
  return doClaim(t, me, `${me.name} 接受了派工`)
})

route('POST', '/api/tasks/:id/decline', ({ req, params, body }) => {
  const me = currentMember(req)
  const t = findTask(Number(params[0]))
  requireState(t, ['submitted'], '拒绝')
  if (t.suggested_assignee?.id !== me.id) throw new HttpError(403, 'forbidden', '这个任务没有派给你')
  t.suggested_assignee = null
  const reason = str(body.reason)
  const item = push(t, { kind: 'event', type: 'task.declined', actor: memberActor(me), text: `${me.name} 拒绝了派工${reason ? `：${reason}` : ''}`, data: { reason: reason || null } })
  publish(t, [item])
  return detail(t, me)
})

route('POST', '/api/tasks/:id/cancel', ({ req, params, body }) => {
  const me = currentMember(req)
  const t = findTask(Number(params[0]))
  requireState(t, OPEN, '取消')
  requireAction(t, me, 'cancel', '取消这个任务')
  const reason = str(body.reason)
  const items = [push(t, { kind: 'event', type: 'task.canceled', actor: memberActor(me), text: `${me.name} 取消了任务${reason ? `：${reason}` : ''}`, data: { reason: reason || null } })]
  const sc = setState(t, 'canceled', memberActor(me))
  if (sc) items.push(sc)
  publish(t, items)
  return detail(t, me)
})

route('POST', '/api/tasks/:id/complete', ({ req, params, body }) => {
  const me = currentMember(req)
  const t = findTask(Number(params[0]))
  requireState(t, ['working'], '确认完成')
  if (t.merge_requests.length > 0) throw new HttpError(409, 'invalid_state', '有 MR 的任务在合并后自动完成')
  requireAction(t, me, 'complete', '确认完成（需要发布者）')
  const note = str(body.note)
  const items = [push(t, { kind: 'event', type: 'task.completed', actor: memberActor(me), text: `${me.name} 确认完成${note ? `：${note}` : ''}`, data: { note: note || null } })]
  const sc = setState(t, 'completed', memberActor(me))
  if (sc) items.push(sc)
  publish(t, items)
  return detail(t, me)
})

route('POST', '/api/tasks/:id/messages', ({ req, params, body }) => {
  const me = currentMember(req)
  const t = findTask(Number(params[0]))
  const content = str(body.content)
  if (!content) throw new HttpError(422, 'validation_error', '消息不能为空')
  const item = push(t, { kind: 'message', type: 'message', actor: memberActor(me), text: content, data: null })
  publish(t, [item])
  // 负责人的 Agent 在线时，模拟一条回复
  const agent = t.assignee_agent ? agents.find((a) => a.id === t.assignee_agent?.id && a.status !== 'offline') : null
  if (agent && OPEN.includes(t.state)) {
    setTimeout(() => {
      const reply = push(t, { kind: 'message', type: 'message', actor: agentActor(agent), text: '收到，我按这个调整，完成后在这里同步。', data: { kind: 'ack' } })
      publish(t, [reply])
    }, 3000)
  }
  return item
})

route('POST', '/api/tasks/:id/input', ({ req, params, body }) => {
  const me = currentMember(req)
  const t = findTask(Number(params[0]))
  requireState(t, ['input-required'], '补充信息')
  const content = str(body.content)
  if (!content) throw new HttpError(422, 'validation_error', '补充内容不能为空')
  const items = [push(t, { kind: 'message', type: 'message', actor: memberActor(me), text: content, data: { kind: 'input' } })]
  const sc = setState(t, 'working', memberActor(me))
  if (sc) items.push(sc)
  t.suggestions.filter((s) => s.scenario === 'input_answer' && s.status === 'proposed').forEach((s) => (s.status = 'rejected'))
  publish(t, items)
  simulateAgentStart(t)
  return detail(t, me)
})

route('POST', '/api/tasks/:id/request-approval', ({ req, params, body }) => {
  const me = currentMember(req)
  const t = findTask(Number(params[0]))
  requireState(t, ['working'], '请求审批')
  requireAction(t, me, 'request_approval', '请求审批（需要负责人）')
  const gate = body.gate === 'high_risk' ? 'high_risk' : 'merge'
  if (gate === 'merge' && t.merge_requests.length === 0 && t.repos.length > 0) {
    // 示例：给每个仓库补一个 MR，方便看完整流程
    t.repos.forEach((r) => t.merge_requests.push(nextMr(r, `acp/${t.id}-task`, 'opened', 'success', now())))
  }
  const note = str(body.note)
  t.approvals.push({ id: nextApprovalId(), gate, status: 'pending', requested_by: ref(me), decided_by: null, comment: note || null, created_at: now(), decided_at: null })
  const items = [push(t, { kind: 'event', type: 'approval.requested', actor: memberActor(me), text: `${me.name} 请求${gate === 'merge' ? '合并' : '高风险操作'}审批${note ? `：${note}` : ''}`, data: { gate } })]
  const sc = setState(t, 'auth-required')
  if (sc) items.push(sc)
  publish(t, items)
  return detail(t, me)
})

route('POST', '/api/approvals/:id/decide', ({ req, params, body }) => {
  const me = currentMember(req)
  const id = Number(params[0])
  const t = tasks.find((x) => x.approvals.some((a) => a.id === id))
  if (!t) throw new HttpError(404, 'not_found', '审批不存在')
  const approval = t.approvals.find((a) => a.id === id)
  if (!approval) throw new HttpError(404, 'not_found', '审批不存在')
  if (approval.status !== 'pending') throw new HttpError(409, 'invalid_state', '该审批已处理')
  if (!(me.roles.includes('reviewer') || me.roles.includes('admin'))) throw new HttpError(403, 'forbidden', '需要审批人角色')
  const approve = body.decision === 'approve'
  const comment = str(body.comment)
  approval.status = approve ? 'approved' : 'rejected'
  approval.decided_by = ref(me)
  approval.decided_at = now()
  approval.comment = comment || null
  const items = [push(t, { kind: 'event', type: 'approval.decided', actor: memberActor(me), text: `${me.name} ${approve ? '同意' : '驳回'}了审批${comment ? `：${comment}` : ''}`, data: { decision: body.decision } })]
  if (approve && approval.gate === 'merge') {
    t.merge_requests.forEach((mr) => {
      mr.state = 'merged'
      mr.updated_at = now()
      items.push(push(t, { kind: 'event', type: 'mr.merged', actor: { type: 'connector', id: null, name: 'GitLab 连接器' }, text: `MR !${mr.iid} 已合并到 main（${mr.repo}）`, data: { mr_id: mr.id } }))
    })
    const sc = setState(t, 'completed')
    if (sc) items.push(sc)
  } else {
    const sc = setState(t, 'working')
    if (sc) items.push(sc)
  }
  publish(t, items)
  return detail(t, me)
})

route('POST', '/api/suggestions/:id/:action', ({ req, params }) => {
  const me = currentMember(req)
  const id = Number(params[0])
  const action = params[1]
  const t = tasks.find((x) => x.suggestions.some((s) => s.id === id))
  const s = t?.suggestions.find((x) => x.id === id)
  if (!t || !s) throw new HttpError(404, 'not_found', '建议不存在')
  if (action === 'accept') {
    if (s.status !== 'proposed') throw new HttpError(409, 'invalid_state', '该建议已处理')
    s.status = 'executed'
    s.decided_by = ref(me)
    const items = [push(t, { kind: 'event', type: 'suggestion.accepted', actor: memberActor(me), text: `${me.name} 采纳了协调建议：${s.summary}`, data: { suggestion_id: s.id } })]
    if (s.scenario === 'dispatch' && typeof s.payload.member_id === 'string') {
      const target = members.find((m) => m.id === s.payload.member_id)
      if (target && t.state === 'submitted') {
        t.suggested_assignee = ref(target)
        items.push(push(t, { kind: 'event', type: 'notify.sent', actor: SYSTEM_ACTOR, text: `已向 ${target.name} 发送派工卡片`, data: null }))
      }
    }
    if (s.scenario === 'input_answer' && t.state === 'input-required') {
      items.push(push(t, { kind: 'message', type: 'message', actor: COORDINATOR_AGENT_ACTOR, text: `（协调 Agent 代答）${String(s.payload.answer ?? s.summary)}`, data: { kind: 'input' } }))
      const sc = setState(t, 'working')
      if (sc) items.push(sc)
    }
    publish(t, items)
  } else if (action === 'reject') {
    if (s.status !== 'proposed') throw new HttpError(409, 'invalid_state', '该建议已处理')
    s.status = 'rejected'
    s.decided_by = ref(me)
    publish(t, [push(t, { kind: 'event', type: 'suggestion.rejected', actor: memberActor(me), text: `${me.name} 忽略了协调建议`, data: { suggestion_id: s.id } })])
  } else if (action === 'undo') {
    if (s.status !== 'executed') throw new HttpError(409, 'invalid_state', '只有已执行的建议可以撤销')
    s.status = 'undone'
    s.decided_by = ref(me)
    publish(t, [push(t, { kind: 'event', type: 'suggestion.undone', actor: memberActor(me), text: `${me.name} 撤销了协调 Agent 的自动操作`, data: { suggestion_id: s.id } })])
  } else {
    throw new HttpError(404, 'not_found', '未知操作')
  }
  return s
})

// 成员与 Agent
route('GET', '/api/members', ({ req, url }) => {
  currentMember(req)
  const q = url.searchParams.get('q')?.trim()
  const list = members.filter((m) => !q || m.name.includes(q) || (m.gitlab_username ?? '').includes(q) || (m.team ?? '').includes(q))
  return paged(list.map(withStats), url)
})

route('PATCH', '/api/members/:id', ({ req, params, body }) => {
  const me = currentMember(req)
  if (!me.roles.includes('admin')) throw new HttpError(403, 'forbidden', '需要管理员权限')
  const m = members.find((x) => x.id === decodeURIComponent(params[0]))
  if (!m) throw new HttpError(404, 'not_found', '成员不存在')
  if (Array.isArray(body.roles)) {
    const roles = new Set(body.roles as string[])
    roles.add('member')
    if (m.id === me.id && !roles.has('admin')) throw new HttpError(422, 'validation_error', '不能移除自己的管理员角色')
    m.roles = [...roles]
  }
  if (body.team !== undefined) m.team = str(body.team) || null
  if (body.gitlab_username !== undefined) m.gitlab_username = str(body.gitlab_username) || null
  if (typeof body.is_active === 'boolean') {
    if (m.id === me.id && !body.is_active) throw new HttpError(422, 'validation_error', '不能停用自己')
    m.is_active = body.is_active
  }
  return withStats(m)
})

route('GET', '/api/agents', ({ req }) => {
  currentMember(req)
  // 在线 Agent 的心跳时间保持新鲜
  agents.forEach((a) => {
    if (a.status !== 'offline') a.last_heartbeat_at = iso(Date.now() - Math.floor(Math.random() * 25_000))
  })
  return { items: agents }
})

// 数据来源
route('GET', '/api/sources', ({ req }) => {
  currentMember(req)
  const DAY = 24 * 3600 * 1000
  const stat = (s: string) => {
    const evs = sourceEvents.filter((e) => e.source === s)
    return {
      last_event_at: evs[0]?.at ?? null,
      events_24h: evs.filter((e) => Date.parse(e.at) > Date.now() - DAY).length,
      events_7d: evs.filter((e) => Date.parse(e.at) > Date.now() - 7 * DAY).length,
    }
  }
  return {
    items: [
      { source: 'feishu', label: '飞书', status: 'connected', ...stat('feishu'), detail: '事件桥长连接正常 · 监听 2 个群 · 模式：@机器人、快捷操作' },
      { source: 'gitlab', label: 'GitLab', status: 'connected', ...stat('gitlab'), detail: 'Webhook 经 n8n 转发 · 11 个项目' },
      { source: 'board', label: '任务榜', status: 'connected', ...stat('board'), detail: '本页面直接调用 REST 接口' },
      { source: 'agent', label: 'Agent', status: 'connected', ...stat('agent'), detail: `${agents.filter((a) => a.status !== 'offline').length} 个 Agent 在线 · A2A 订阅` },
      { source: 'system', label: '系统', status: 'error', ...stat('system'), detail: '巡检任务最近一次执行失败：n8n 返回 502' },
    ],
  }
})

route('GET', '/api/sources/events', ({ req, url }) => {
  currentMember(req)
  const source = url.searchParams.get('source')
  return paged(source ? sourceEvents.filter((e) => e.source === source) : sourceEvents, url)
})

// 设置
route('GET', '/api/settings', ({ req }) => {
  currentMember(req)
  return settings
})

route('PUT', '/api/settings', ({ req, body }) => {
  const me = currentMember(req)
  if (!me.roles.includes('admin')) throw new HttpError(403, 'forbidden', '需要管理员权限')
  if (body.autonomy && typeof body.autonomy === 'object') {
    Object.assign(settings.autonomy, body.autonomy)
  }
  if (Array.isArray(body.intake_modes)) settings.intake_modes = body.intake_modes as string[]
  if (Array.isArray(body.feishu_chat_ids)) settings.feishu_chat_ids = (body.feishu_chat_ids as string[]).map((s) => s.trim()).filter(Boolean)
  return settings
})

// n8n
route('GET', '/api/workflows', ({ req }) => {
  currentMember(req)
  // 调试用：localStorage.acp_mock_n8n = 'off'（没配 Key）或 'expired'（Key 失效）可以看两种不可用状态
  const flag = (() => {
    try {
      return localStorage.getItem('acp_mock_n8n')
    } catch {
      return null
    }
  })()
  const empty = { enabled: false, n8n_url: settings.n8n_url, workflows: [], executions: [] }
  if (flag === 'off') return { ...empty, n8n_url: null, reason: 'no_key', message: '未配置 n8n API Key（ACP_N8N_API_KEY），只显示入口链接' }
  if (flag === 'expired')
    return {
      ...empty,
      reason: 'unauthorized',
      message: 'n8n 的 API Key 无效或已过期：在 n8n 的 Settings → n8n API 重新生成，更新 .env 里的 N8N_API_KEY 后执行 docker compose up -d',
    }
  return { enabled: true, n8n_url: settings.n8n_url, workflows, executions }
})

// 个人令牌
interface MockToken {
  id: number
  member_id: string
  name: string
  created_at: string
  expires_at: string
  revoked_at: string | null
}
const DAY_MS = 24 * 3600 * 1000
const personalTokens: MockToken[] = [
  { id: 1, member_id: members[0].id, name: 'MacBook · Claude Code', created_at: iso(NOW - 12 * DAY_MS), expires_at: iso(NOW + 18 * DAY_MS), revoked_at: null },
  { id: 2, member_id: members[0].id, name: '家里台式机 · Codex', created_at: iso(NOW - 40 * DAY_MS), expires_at: iso(NOW + 50 * DAY_MS), revoked_at: iso(NOW - 3 * DAY_MS) },
  { id: 3, member_id: members[0].id, name: '临时调试', created_at: iso(NOW - 20 * DAY_MS), expires_at: iso(NOW - 13 * DAY_MS), revoked_at: null },
]
const publicToken = (t: MockToken) => ({ id: t.id, name: t.name, created_at: t.created_at, expires_at: t.expires_at, revoked_at: t.revoked_at })

route('GET', '/api/me/tokens', ({ req }) => {
  const me = currentMember(req)
  return { items: personalTokens.filter((t) => t.member_id === me.id).map(publicToken) }
})
route('POST', '/api/me/tokens', ({ req, body }) => {
  const me = currentMember(req)
  const name = str(body.name)
  const days = Number(body.days)
  if (!name) throw new HttpError(422, 'validation_error', '名称不能为空')
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new HttpError(422, 'validation_error', '有效期须为 1 到 90 天')
  const t: MockToken = { id: Math.max(0, ...personalTokens.map((x) => x.id)) + 1, member_id: me.id, name, created_at: now(), expires_at: iso(Date.now() + days * DAY_MS), revoked_at: null }
  personalTokens.push(t)
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('')
  return { id: t.id, token: `acp_pat_${secret}`, expires_at: t.expires_at, mcp_url: `${settings.public_url}/mcp` }
})
route('DELETE', '/api/me/tokens/:id', ({ req, params }) => {
  const me = currentMember(req)
  const t = personalTokens.find((x) => String(x.id) === decodeURIComponent(params[0]) && x.member_id === me.id)
  if (!t) throw new HttpError(404, 'not_found', '令牌不存在')
  if (!t.revoked_at) t.revoked_at = now()
  return { ok: true }
})

// 设备授权
route('POST', '/api/device/approve', ({ req, body }) => {
  currentMember(req)
  const code = str(body.user_code).toUpperCase()
  if (!/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(code)) throw new HttpError(422, 'validation_error', '设备码格式不正确，应为 8 位字母数字，如 WDJB-MJHT')
  if (code.startsWith('XXXX')) throw new HttpError(404, 'not_found', '设备码不存在或已过期，请在 acp-link 中重新发起登录')
  return { ok: true, client: 'acp-link 0.4.2', hostname: 'zw-mbp.local' }
})

// ---------- 安装 ----------

const BACKEND_PREFIXES = ['/api', '/auth', '/a2a', '/mcp', '/.well-known', '/healthz']

export function installMock() {
  const realFetch = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    const url = new URL(req.url, location.origin)
    if (url.origin !== location.origin || !BACKEND_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'))) {
      return realFetch(input, init)
    }
    await new Promise((r) => setTimeout(r, 120 + Math.random() * 260))
    const match = routes.find(([method, re]) => method === req.method && re.test(url.pathname))
    if (!match) return json({ error: 'not_found', message: `模拟接口未实现：${req.method} ${url.pathname}` }, 404)
    const params = (url.pathname.match(match[1]) ?? []).slice(1)
    let body: Record<string, unknown> = {}
    if (req.method !== 'GET') {
      const text = await req.text()
      if (text) {
        try {
          body = JSON.parse(text) as Record<string, unknown>
        } catch {
          return json({ error: 'validation_error', message: '请求体不是合法 JSON' }, 400)
        }
      }
    }
    try {
      const result = match[2]({ req, url, params, body })
      return json(result)
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code, message: err.message }, err.status)
      console.error('[mock]', err)
      return json({ error: 'server_error', message: '模拟服务内部错误' }, 500)
    }
  }

  setTaskStreamFactory((taskId, handlers) => {
    const set = subscribers.get(taskId) ?? new Set<TaskStreamHandlers>()
    set.add(handlers)
    subscribers.set(taskId, set)
    setTimeout(() => handlers.onOpen?.(), 50)
    return () => {
      set.delete(handlers)
      if (set.size === 0) subscribers.delete(taskId)
    }
  })

  startTicker()
  console.info(`[ACP] 模拟模式已启用（数据生成于 ${new Date(NOW).toLocaleString('zh-CN')}）`)
}
