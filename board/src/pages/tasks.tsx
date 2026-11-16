import { getCoreRowModel, useReactTable, type SortingState, type VisibilityState } from '@tanstack/react-table'
import { Plus, Search, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { DataTable } from '@/components/data-table/data-table'
import { DataTableFacetedFilter, type FilterOption } from '@/components/data-table/data-table-faceted-filter'
import { DataTablePagination } from '@/components/data-table/data-table-pagination'
import { DataTableViewOptions } from '@/components/data-table/data-table-view-options'
import { ErrorState } from '@/components/empty-state'
import { PageContainer } from '@/components/layout/page-container'
import { SourceIcon, StateIcon } from '@/components/status-badge'
import { SORT_FIELD, taskColumns } from '@/components/tasks/task-columns'
import { useNewTaskDialog } from '@/components/tasks/new-task-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/lib/auth'
import { PRIORITIES, PRIORITY_LABEL, SOURCES, SOURCE_LABEL, STATE_LABEL, TASK_STATES } from '@/lib/labels'
import { useMemberOptions, useOverview, useTasks } from '@/lib/queries'
import { useRepoOptions } from '@/lib/use-options'
import type { Priority, Source, TaskListQuery } from '@/types/api'

const VISIBILITY_KEY = 'acp_tasks_columns'
const DEFAULT_VISIBILITY: VisibilityState = { created_at: false }

function loadVisibility(): VisibilityState {
  try {
    const raw = localStorage.getItem(VISIBILITY_KEY)
    return raw ? { ...DEFAULT_VISIBILITY, ...(JSON.parse(raw) as VisibilityState) } : DEFAULT_VISIBILITY
  } catch {
    return DEFAULT_VISIBILITY
  }
}

const FILTER_KEYS = ['q', 'state', 'source', 'priority', 'assignee', 'repo', 'creator'] as const

type Scope = 'all' | 'mine' | 'created' | 'approval'

export default function TasksPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { member } = useAuth()
  const newTask = useNewTaskDialog()
  const demo = params.get('demo') === 'true'
  const overview = useOverview(14, demo)
  const members = useMemberOptions()
  const repoOptions = useRepoOptions(demo)

  const page = Math.max(1, Number(params.get('page')) || 1)
  const pageSize = [10, 20, 30, 50, 100].includes(Number(params.get('page_size'))) ? Number(params.get('page_size')) : 20
  const sortParam = params.get('sort') || '-updated_at'
  const states = (params.get('state') ?? '').split(',').filter(Boolean)
  const source = params.get('source') ?? ''
  const priority = params.get('priority') ?? ''
  const assignee = params.get('assignee') ?? ''
  const repo = params.get('repo') ?? ''
  const creator = params.get('creator') ?? ''
  const q = params.get('q') ?? ''

  const query: TaskListQuery = {
    demo,
    q: q || undefined,
    state: states.length ? states.join(',') : undefined,
    source: (source || undefined) as Source | undefined,
    priority: (priority || undefined) as Priority | undefined,
    assignee: assignee || undefined,
    repo: repo || undefined,
    creator: creator || undefined,
    page,
    page_size: pageSize,
    sort: sortParam,
  }
  const { data, isFetching, isPending, error, refetch } = useTasks(query)

  const update = (patch: Record<string, string | null>, resetPage = true) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === '') next.delete(k)
          else next.set(k, v)
        }
        if (resetPage) next.delete('page')
        return next
      },
      { replace: true },
    )
  }

  // 搜索框：本地输入，300ms 后写入 URL
  const [draft, setDraft] = useState(q)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const onSearch = (value: string) => {
    setDraft(value)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => update({ q: value.trim() || null }), 300)
  }

  const sorting: SortingState = useMemo(() => {
    const desc = sortParam.startsWith('-')
    const field = desc ? sortParam.slice(1) : sortParam
    const id = Object.entries(SORT_FIELD).find(([, f]) => f === field)?.[0]
    return id ? [{ id, desc }] : []
  }, [sortParam])

  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(loadVisibility)

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table v8 的 API 不可被 React Compiler 记忆化，这是官方已知用法
  const table = useReactTable({
    data: data?.items ?? [],
    columns: taskColumns,
    state: { sorting, columnVisibility },
    manualSorting: true,
    manualPagination: true,
    manualFiltering: true,
    enableMultiSort: false,
    enableSortingRemoval: true,
    getRowId: (row) => String(row.id),
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater
      const s = next[0]
      update({ sort: s ? `${s.desc ? '-' : ''}${SORT_FIELD[s.id] ?? s.id}` : null })
    },
    onColumnVisibilityChange: (updater) => {
      setColumnVisibility((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater
        try {
          localStorage.setItem(VISIBILITY_KEY, JSON.stringify(next))
        } catch {
          /* ignore */
        }
        return next
      })
    },
  })

  const byState = overview.data?.counts.by_state
  const stateOptions: FilterOption[] = TASK_STATES.map((s) => ({
    value: s,
    label: STATE_LABEL[s],
    icon: ({ className }) => <StateIcon state={s} className={className} />,
    count: byState?.[s],
  }))
  const sourceOptions: FilterOption[] = SOURCES.map((s) => ({
    value: s,
    label: SOURCE_LABEL[s],
    icon: ({ className }) => <SourceIcon source={s} className={className} />,
  }))
  const priorityOptions: FilterOption[] = PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))
  const assigneeOptions: FilterOption[] = [
    { value: 'me', label: '我' },
    { value: 'none', label: '未分配' },
    ...(members.data?.items ?? []).filter((m) => m.id !== member?.id).map((m) => ({ value: m.id, label: m.name })),
  ]
  const repoFilterOptions: FilterOption[] = repoOptions.map((r) => ({ value: r, label: r }))

  const isFiltered = FILTER_KEYS.some((k) => params.get(k))

  const scope: Scope =
    assignee === 'me' && !creator && !states.length
      ? 'mine'
      : creator && creator === member?.id && !assignee
        ? 'created'
        : states.length === 1 && states[0] === 'auth-required' && !assignee && !creator
          ? 'approval'
          : !isFiltered
            ? 'all'
            : ('custom' as Scope)

  const setScope = (value: Scope) => {
    const clear = Object.fromEntries(FILTER_KEYS.map((k) => [k, null])) as Record<string, null>
    setDraft('')
    if (value === 'mine') update({ ...clear, assignee: 'me' })
    else if (value === 'created') update({ ...clear, creator: member?.id ?? null })
    else if (value === 'approval') update({ ...clear, state: 'auth-required' })
    else update(clear)
  }

  return (
    <PageContainer
      title="查找任务"
      description="按状态、来源、优先级、负责人和仓库筛选全部任务，点击一行查看详情。"
      actions={
        <Button onClick={() => newTask.open()}>
          <Plus />
          新建任务
        </Button>
      }
    >
      <Tabs value={scope} onValueChange={(v) => setScope(v as Scope)} className="mb-3">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="all">全部</TabsTrigger>
          <TabsTrigger value="mine">我负责的</TabsTrigger>
          <TabsTrigger value="created">我发布的</TabsTrigger>
          <TabsTrigger value="approval">待审批</TabsTrigger>
        </TabsList>
      </Tabs>
      {error && !data ? (
        <ErrorState error={error} onRetry={() => void refetch()} className="rounded-lg border" />
      ) : (
        <DataTable
          table={table}
          loading={isPending || isFetching}
          onRowClick={(t) => navigate(`/tasks/${t.id}`)}
          emptyText={isFiltered ? '没有符合筛选条件的任务' : '还没有任务，点右上角「新建任务」发布第一条'}
          toolbar={
            <div className="flex w-full items-start justify-between gap-2 p-1">
              <div className="flex flex-1 flex-wrap items-center gap-2">
                <div className="relative w-full sm:w-56 lg:w-64">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={draft} onChange={(e) => onSearch(e.target.value)} placeholder="搜索编号、标题、描述…" className="pl-8" aria-label="搜索任务" />
                </div>
                <DataTableFacetedFilter title="状态" options={stateOptions} selected={states} onChange={(v) => update({ state: v.join(',') || null })} />
                <Button type="button" variant={demo ? 'secondary' : 'outline'} size="sm" aria-pressed={demo} onClick={() => update({ demo: demo ? null : 'true' })}>仅看示例</Button>
                <DataTableFacetedFilter title="来源" options={sourceOptions} selected={source ? [source] : []} onChange={(v) => update({ source: v[0] ?? null })} multiple={false} />
                <DataTableFacetedFilter title="优先级" options={priorityOptions} selected={priority ? [priority] : []} onChange={(v) => update({ priority: v[0] ?? null })} multiple={false} />
                <DataTableFacetedFilter title="负责人" options={assigneeOptions} selected={assignee ? [assignee] : []} onChange={(v) => update({ assignee: v[0] ?? null })} multiple={false} />
                <DataTableFacetedFilter title="仓库" options={repoFilterOptions} selected={repo ? [repo] : []} onChange={(v) => update({ repo: v[0] ?? null })} multiple={false} />
                {isFiltered && (
                  <Button
                    variant="outline"
                    className="border-dashed"
                    onClick={() => {
                      setDraft('')
                      update(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])))
                    }}
                  >
                    <X />
                    重置
                  </Button>
                )}
              </div>
              <DataTableViewOptions table={table} />
            </div>
          }
          footer={
            <DataTablePagination
              page={page}
              pageSize={pageSize}
              total={data?.total ?? 0}
              onPageChange={(p) => update({ page: p > 1 ? String(p) : null }, false)}
              onPageSizeChange={(s) => update({ page_size: s === 20 ? null : String(s) })}
            />
          }
        />
      )}
    </PageContainer>
  )
}
