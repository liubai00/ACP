/** react-query 的查询键与常用 hook */
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, errorMessage } from '@/lib/api'
import type {
  PersonalTokenId,
  Settings,
  SourceEventSource,
  Suggestion,
  TaskDetail,
  TaskListQuery,
  UpdateMemberBody,
  UpdateSettingsBody,
} from '@/types/api'

export const qk = {
  me: ['me'] as const,
  overview: (days: number, demo: boolean) => ['overview', days, demo] as const,
  tasks: (query: TaskListQuery) => ['tasks', query] as const,
  tasksAll: ['tasks'] as const,
  task: (id: number) => ['task', id] as const,
  members: (query: { q?: string; page?: number; page_size?: number }) => ['members', query] as const,
  membersAll: ['members'] as const,
  agents: ['agents'] as const,
  sources: ['sources'] as const,
  sourceEvents: (query: { source?: SourceEventSource; page?: number; page_size?: number }) =>
    ['source-events', query] as const,
  settings: ['settings'] as const,
  workflows: ['workflows'] as const,
  tokens: ['me', 'tokens'] as const,
}

export function useOverview(days = 14, demo = false) {
  return useQuery({
    queryKey: qk.overview(days, demo),
    queryFn: () => api.overview(days, demo),
    refetchInterval: 60_000,
  })
}

export function useTasks(query: TaskListQuery, options: { enabled?: boolean; refetchInterval?: number } = {}) {
  return useQuery({
    queryKey: qk.tasks(query),
    queryFn: ({ signal }) => api.tasks.list(query, signal),
    placeholderData: keepPreviousData,
    ...options,
  })
}

export function useTask(id: number) {
  return useQuery({
    queryKey: qk.task(id),
    queryFn: () => api.tasks.get(id),
    enabled: Number.isFinite(id) && id > 0,
  })
}

/** 成员列表（下拉选项用，取前 100 个） */
export function useMemberOptions() {
  return useQuery({
    queryKey: qk.members({ page: 1, page_size: 100 }),
    queryFn: () => api.members.list({ page: 1, page_size: 100 }),
    staleTime: 5 * 60_000,
  })
}

export function useMembers(query: { q?: string; page?: number; page_size?: number }) {
  return useQuery({
    queryKey: qk.members(query),
    queryFn: () => api.members.list(query),
    placeholderData: keepPreviousData,
  })
}

export function useAgents() {
  return useQuery({ queryKey: qk.agents, queryFn: api.agents.list, refetchInterval: 30_000 })
}

export function useSources() {
  return useQuery({ queryKey: qk.sources, queryFn: api.sources.list, refetchInterval: 60_000 })
}

export function useSourceEvents(query: { source?: SourceEventSource; page?: number; page_size?: number }) {
  return useQuery({
    queryKey: qk.sourceEvents(query),
    queryFn: () => api.sources.events(query),
    placeholderData: keepPreviousData,
  })
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: api.settings.get })
}

export function useWorkflows() {
  return useQuery({ queryKey: qk.workflows, queryFn: api.workflows.get, refetchInterval: 60_000 })
}

// ---------- 写操作 ----------

/** 写入新的任务详情并让列表类查询失效 */
export function applyTaskDetail(client: QueryClient, task: TaskDetail) {
  client.setQueryData(qk.task(task.id), task)
  void client.invalidateQueries({ queryKey: qk.tasksAll })
  void client.invalidateQueries({ queryKey: ['overview'] })
}

/** 任务动作通用 mutation：fn 返回最新 TaskDetail */
export function useTaskMutation<TVars>(
  fn: (vars: TVars) => Promise<TaskDetail>,
  successText?: string | ((task: TaskDetail) => string),
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (task) => {
      applyTaskDetail(client, task)
      if (successText) toast.success(typeof successText === 'function' ? successText(task) : successText)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
}

export function useSuggestionMutation(taskId: number | null) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'accept' | 'reject' | 'undo' }) =>
      api.suggestions[action](id),
    onSuccess: (suggestion: Suggestion, vars) => {
      if (taskId !== null) {
        client.setQueryData<TaskDetail>(qk.task(taskId), (prev) =>
          prev
            ? { ...prev, suggestions: prev.suggestions.map((s) => (s.id === suggestion.id ? suggestion : s)) }
            : prev,
        )
        // 采纳建议可能改变任务本身（派工、代答），再拉一次
        void client.invalidateQueries({ queryKey: qk.task(taskId) })
      }
      void client.invalidateQueries({ queryKey: qk.tasksAll })
      toast.success(vars.action === 'accept' ? '已采纳建议' : vars.action === 'reject' ? '已忽略建议' : '已撤销')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
}

export function useUpdateMember() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateMemberBody }) => api.members.update(id, body),
    onSuccess: (member) => {
      void client.invalidateQueries({ queryKey: qk.membersAll })
      toast.success(`已更新 ${member.name}`)
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
}

export function useUpdateSettings() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateSettingsBody) => api.settings.update(body),
    onSuccess: (settings: Settings) => {
      client.setQueryData(qk.settings, settings)
      toast.success('设置已保存')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
}

export function useTokens() {
  return useQuery({ queryKey: qk.tokens, queryFn: api.tokens.list })
}

export function useRevokeToken() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: PersonalTokenId) => api.tokens.revoke(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.tokens })
      toast.success('令牌已撤销，使用它的客户端将立即失效')
    },
    onError: (err) => toast.error(errorMessage(err)),
  })
}
