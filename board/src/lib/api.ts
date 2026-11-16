/**
 * ACP coordinator 的类型化客户端，按 contracts/API.md 实现。
 * - 同源调用（开发时由 Vite 代理到 :8000，线上由 Caddy 转发）
 * - 自动带 Authorization: Bearer <acp_token>
 * - 401：清掉令牌并通知应用跳转登录页
 * - SSE：EventSource('/api/tasks/{id}/stream?access_token=...')，事件 timeline / task
 */
import { tokenStore } from '@/lib/token'
import type {
  Agent,
  ApiErrorBody,
  CreatedPersonalToken,
  CreatePersonalTokenBody,
  AuthProviders,
  CreateTaskBody,
  DecideApprovalBody,
  DeviceApproveResponse,
  LoginResponse,
  Member,
  Overview,
  Paged,
  PersonalToken,
  PersonalTokenId,
  RefreshResponse,
  RequestApprovalBody,
  Settings,
  SourceEvent,
  SourceEventSource,
  SourceInfo,
  Suggestion,
  TaskDetail,
  TaskListQuery,
  TaskSummary,
  TimelineItem,
  UpdateMemberBody,
  UpdateSettingsBody,
  UpdateTaskBody,
  WorkflowsResponse,
} from '@/types/api'

// ---------- 错误 ----------

const ERROR_MESSAGES: Record<string, string> = {
  unauthorized: '登录已失效，请重新登录',
  forbidden: '没有权限执行该操作',
  not_found: '内容不存在或已被删除',
  invalid_state: '任务当前状态不允许该操作',
  validation_error: '提交的内容不符合要求',
  conflict: '数据已被他人修改，请刷新后重试',
  rate_limited: '操作太频繁，请稍后再试',
  network_error: '网络连接失败，请检查网络后重试',
  server_error: '服务暂时不可用，请稍后再试',
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message?: string) {
    super(message || ERROR_MESSAGES[code] || `请求失败（HTTP ${status}）`)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return '发生未知错误'
}

// ---------- 401 处理 ----------

type UnauthorizedListener = () => void
const unauthorizedListeners = new Set<UnauthorizedListener>()

/** 注册 401 回调（AuthProvider 用它跳转 /login） */
export function onUnauthorized(listener: UnauthorizedListener) {
  unauthorizedListeners.add(listener)
  return () => {
    unauthorizedListeners.delete(listener)
  }
}

function emitUnauthorized() {
  tokenStore.clear()
  unauthorizedListeners.forEach((l) => l())
}

// ---------- 请求 ----------

type QueryValue = string | number | boolean | null | undefined
type Query = Record<string, QueryValue>

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: Query
  body?: unknown
  signal?: AbortSignal
  /** 默认 true：401 时清令牌并跳登录。登录接口自身设为 false，以便在表单里提示错误 */
  handleUnauthorized?: boolean
}

export function buildQuery(query?: Query): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', query, body, signal, handleUnauthorized = true } = options
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = tokenStore.get()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let response: Response
  try {
    response = await fetch(path + buildQuery(query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: 'same-origin',
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new ApiError(0, 'network_error')
  }

  if (response.status === 204) return undefined as T

  const text = await response.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }

  if (!response.ok) {
    const errBody = (data ?? {}) as Partial<ApiErrorBody>
    const code =
      typeof errBody.error === 'string'
        ? errBody.error
        : response.status === 401
          ? 'unauthorized'
          : response.status === 403
            ? 'forbidden'
            : response.status === 404
              ? 'not_found'
              : response.status >= 500
                ? 'server_error'
                : 'http_error'
    if (response.status === 401 && handleUnauthorized) emitUnauthorized()
    throw new ApiError(response.status, code, errBody.message)
  }

  return data as T
}

const enc = encodeURIComponent

// ---------- 认证 /auth ----------

export const authApi = {
  providers: () => request<AuthProviders>('/auth/providers', { handleUnauthorized: false }),
  /** 浏览器整页跳转地址（302 到飞书授权页） */
  feishuLoginUrl: (redirect: string) => `/auth/feishu/login${buildQuery({ redirect })}`,
  local: (username: string, password: string) =>
    request<LoginResponse>('/auth/local', {
      method: 'POST',
      body: { username, password },
      handleUnauthorized: false,
    }),
  /** 契约为 {name}；admin 为开发后端额外支持的可选字段（以管理员身份登录），后端不认识时会忽略 */
  dev: (name: string, admin = false) =>
    request<LoginResponse>('/auth/dev', {
      method: 'POST',
      body: admin ? { name, admin: true } : { name },
      handleUnauthorized: false,
    }),
  refresh: () =>
    request<RefreshResponse>('/auth/refresh', { method: 'POST', handleUnauthorized: false }),
}

// ---------- REST /api ----------

export const api = {
  me: () => request<{ member: Member }>('/api/me'),

  /** 个人令牌：给手动配置 Claude Code / Codex MCP 的开发者用 */
  tokens: {
    list: () => request<{ items: PersonalToken[] }>('/api/me/tokens'),
    create: (body: CreatePersonalTokenBody) =>
      request<CreatedPersonalToken>('/api/me/tokens', { method: 'POST', body }),
    revoke: (id: PersonalTokenId) =>
      request<{ ok: true }>(`/api/me/tokens/${enc(String(id))}`, { method: 'DELETE' }),
  },

  overview: (days = 14, demo = false) => request<Overview>('/api/overview', { query: { days, demo } }),

  tasks: {
    list: (query: TaskListQuery = {}, signal?: AbortSignal) =>
      request<Paged<TaskSummary>>('/api/tasks', { query: { ...query }, signal }),
    create: (body: CreateTaskBody) =>
      request<TaskDetail>('/api/tasks', { method: 'POST', body }),
    get: (id: number) => request<TaskDetail>(`/api/tasks/${id}`),
    update: (id: number, body: UpdateTaskBody) =>
      request<TaskDetail>(`/api/tasks/${id}`, { method: 'PATCH', body }),
    claim: (id: number) => request<TaskDetail>(`/api/tasks/${id}/claim`, { method: 'POST' }),
    assign: (id: number, memberId: string) =>
      request<TaskDetail>(`/api/tasks/${id}/assign`, {
        method: 'POST',
        body: { member_id: memberId },
      }),
    accept: (id: number) => request<TaskDetail>(`/api/tasks/${id}/accept`, { method: 'POST' }),
    decline: (id: number, reason?: string) =>
      request<TaskDetail>(`/api/tasks/${id}/decline`, {
        method: 'POST',
        body: reason ? { reason } : {},
      }),
    cancel: (id: number, reason?: string) =>
      request<TaskDetail>(`/api/tasks/${id}/cancel`, {
        method: 'POST',
        body: reason ? { reason } : {},
      }),
    complete: (id: number, note?: string) =>
      request<TaskDetail>(`/api/tasks/${id}/complete`, {
        method: 'POST',
        body: note ? { note } : {},
      }),
    message: (id: number, content: string) =>
      request<TimelineItem>(`/api/tasks/${id}/messages`, { method: 'POST', body: { content } }),
    input: (id: number, content: string) =>
      request<TaskDetail>(`/api/tasks/${id}/input`, { method: 'POST', body: { content } }),
    requestApproval: (id: number, body: RequestApprovalBody) =>
      request<TaskDetail>(`/api/tasks/${id}/request-approval`, { method: 'POST', body }),
  },

  approvals: {
    decide: (id: number, body: DecideApprovalBody) =>
      request<TaskDetail>(`/api/approvals/${id}/decide`, { method: 'POST', body }),
  },

  suggestions: {
    accept: (id: number) =>
      request<Suggestion>(`/api/suggestions/${id}/accept`, { method: 'POST' }),
    reject: (id: number) =>
      request<Suggestion>(`/api/suggestions/${id}/reject`, { method: 'POST' }),
    undo: (id: number) => request<Suggestion>(`/api/suggestions/${id}/undo`, { method: 'POST' }),
  },

  members: {
    list: (query: { q?: string; page?: number; page_size?: number } = {}) =>
      request<Paged<Member>>('/api/members', { query }),
    update: (id: string, body: UpdateMemberBody) =>
      request<Member>(`/api/members/${enc(id)}`, { method: 'PATCH', body }),
  },

  agents: {
    list: () => request<{ items: Agent[] }>('/api/agents'),
  },

  sources: {
    list: () => request<{ items: SourceInfo[] }>('/api/sources'),
    events: (query: { source?: SourceEventSource; page?: number; page_size?: number } = {}) =>
      request<Paged<SourceEvent>>('/api/sources/events', { query }),
  },

  settings: {
    get: () => request<Settings>('/api/settings'),
    update: (body: UpdateSettingsBody) =>
      request<Settings>('/api/settings', { method: 'PUT', body }),
  },

  workflows: {
    get: () => request<WorkflowsResponse>('/api/workflows'),
  },

  device: {
    approve: (userCode: string) =>
      request<DeviceApproveResponse>('/api/device/approve', {
        method: 'POST',
        body: { user_code: userCode },
      }),
  },
}

// ---------- SSE：任务详情实时流 ----------

export interface TaskStreamHandlers {
  onTimeline: (item: TimelineItem) => void
  onTask: (task: TaskSummary) => void
  /** 连接建立或恢复 */
  onOpen?: () => void
  /** 连接中断（会自动重连） */
  onError?: () => void
}

/** 返回取消订阅函数 */
export type TaskStreamFactory = (taskId: number, handlers: TaskStreamHandlers) => () => void

function parseEventData<T>(event: MessageEvent): T | null {
  try {
    return JSON.parse(String(event.data)) as T
  } catch {
    return null
  }
}

const eventSourceFactory: TaskStreamFactory = (taskId, handlers) => {
  let source: EventSource | null = null
  let closed = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0

  const connect = () => {
    if (closed) return
    const token = tokenStore.get() ?? ''
    source = new EventSource(`/api/tasks/${taskId}/stream${buildQuery({ access_token: token })}`)
    source.addEventListener('open', () => {
      attempt = 0
      handlers.onOpen?.()
    })
    source.addEventListener('timeline', (event) => {
      const item = parseEventData<TimelineItem>(event as MessageEvent)
      if (item) handlers.onTimeline(item)
    })
    source.addEventListener('task', (event) => {
      const task = parseEventData<TaskSummary>(event as MessageEvent)
      if (task) handlers.onTask(task)
    })
    source.addEventListener('error', () => {
      handlers.onError?.()
      // CONNECTING：浏览器自己会重连；CLOSED（如 401/404）：我们退避后重建连接
      if (source && source.readyState === EventSource.CLOSED) {
        source.close()
        source = null
        // 顺便探测一次登录态：若已失效，request 会触发 401 跳转
        void api.me().catch(() => undefined)
        attempt += 1
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5))
        retryTimer = setTimeout(connect, delay)
      }
    })
  }

  connect()

  return () => {
    closed = true
    if (retryTimer) clearTimeout(retryTimer)
    source?.close()
    source = null
  }
}

let streamFactory: TaskStreamFactory = eventSourceFactory

/** 模拟模式用它替换为内存事件流 */
export function setTaskStreamFactory(factory: TaskStreamFactory) {
  streamFactory = factory
}

export function subscribeTaskStream(taskId: number, handlers: TaskStreamHandlers) {
  return streamFactory(taskId, handlers)
}

export const IS_MOCK = import.meta.env.VITE_MOCK === '1'
