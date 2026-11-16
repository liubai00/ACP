import { ChevronLeft, ChevronRight, Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { DataTableFacetedFilter } from '@/components/data-table/data-table-faceted-filter'
import { ErrorState } from '@/components/empty-state'
import { PageContainer } from '@/components/layout/page-container'
import { StateIcon } from '@/components/status-badge'
import { TaskCard } from '@/components/tasks/task-card'
import { useNewTaskDialog } from '@/components/tasks/new-task-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/lib/auth'
import { STATE_COLOR, STATE_DESCRIPTION, STATE_LABEL } from '@/lib/labels'
import { useTasks } from '@/lib/queries'
import { useRepoOptions } from '@/lib/use-options'
import { cn } from '@/lib/utils'
import type { TaskListQuery, TaskState, TaskSummary } from '@/types/api'

const COLUMNS: TaskState[] = ['submitted', 'working', 'input-required', 'auth-required', 'completed']
const CLOSED: TaskState[] = ['failed', 'canceled', 'rejected']
type Scope = 'all' | 'mine' | 'created'

function Column({
  state,
  tasks,
  loading,
  note,
}: {
  state: TaskState
  tasks: TaskSummary[]
  loading: boolean
  note?: string
}) {
  return (
    <section className="flex w-[82vw] max-w-80 shrink-0 snap-start flex-col rounded-xl bg-muted/50 sm:w-64 lg:max-w-none lg:min-w-60 lg:flex-1" aria-label={STATE_LABEL[state]}>
      <header className="flex items-center gap-2 px-3 pt-3 pb-2" title={STATE_DESCRIPTION[state]}>
        <span className="size-2 rounded-full" style={{ backgroundColor: STATE_COLOR[state] }} />
        <h2 className="text-sm font-semibold">{STATE_LABEL[state]}</h2>
        <Badge variant="secondary" className="tabular-nums">
          {tasks.length}
        </Badge>
        {note && <span className="ml-auto text-xs text-muted-foreground">{note}</span>}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {loading && tasks.length === 0 ? (
          Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-28 rounded-lg" />)
        ) : tasks.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed px-3 py-8 text-center text-xs text-muted-foreground">
            暂无任务
          </div>
        ) : (
          tasks.map((t) => <TaskCard key={t.id} task={t} />)
        )}
      </div>
    </section>
  )
}

export default function BoardPage() {
  const { member } = useAuth()
  const newTask = useNewTaskDialog()
  const repoOptions = useRepoOptions()
  const [scope, setScope] = useState<Scope>('all')
  const [repo, setRepo] = useState<string>('')
  const [showClosed, setShowClosed] = useState(false)

  const base: TaskListQuery = {
    demo: false,
    assignee: scope === 'mine' ? 'me' : undefined,
    creator: scope === 'created' ? member?.id : undefined,
    repo: repo || undefined,
    sort: '-updated_at',
  }
  const openQ = useTasks({ ...base, state: 'submitted,working,input-required,auth-required', page_size: 100 }, { refetchInterval: 30_000 })
  const doneQ = useTasks({ ...base, state: 'completed', page_size: 20 }, { refetchInterval: 60_000 })
  const closedQ = useTasks({ ...base, state: CLOSED.join(','), page_size: 20 }, { refetchInterval: 60_000 })

  const byState = (s: TaskState): TaskSummary[] => {
    if (s === 'completed') return doneQ.data?.items ?? []
    return (openQ.data?.items ?? []).filter((t) => t.state === s)
  }
  const closedTasks = closedQ.data?.items ?? []
  const error = openQ.error ?? doneQ.error
  const fetching = openQ.isFetching || doneQ.isFetching || closedQ.isFetching

  return (
    <PageContainer
      title="任务进展"
      description="按状态分列查看所有进行中的任务；卡片右下角是在当前状态停留的时长，超过 24 小时标黄、72 小时标红。"
      actions={
        <>
          <Button
            variant="outline"
            size="icon"
            aria-label="刷新"
            onClick={() => {
              void openQ.refetch()
              void doneQ.refetch()
              void closedQ.refetch()
            }}
          >
            <RefreshCw className={cn(fetching && 'animate-spin')} />
          </Button>
          <Button onClick={() => newTask.open()}>
            <Plus />
            新建任务
          </Button>
        </>
      }
      className="min-h-0"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Tabs value={scope} onValueChange={(v) => setScope(v as Scope)}>
          <TabsList>
            <TabsTrigger value="all">全部</TabsTrigger>
            <TabsTrigger value="mine">我负责的</TabsTrigger>
            <TabsTrigger value="created">我发布的</TabsTrigger>
          </TabsList>
        </Tabs>
        <DataTableFacetedFilter
          title="仓库"
          options={repoOptions.map((r) => ({ value: r, label: r }))}
          selected={repo ? [repo] : []}
          onChange={(v) => setRepo(v[0] ?? '')}
          multiple={false}
        />
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void openQ.refetch()} className="rounded-xl border" />
      ) : (
        <div className="-mx-4 flex min-h-[calc(100svh-15rem)] snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-2 md:-mx-6 md:h-[calc(100svh-13.5rem)] md:min-h-[420px] md:scroll-px-6 md:px-6">
          {COLUMNS.map((s) => (
            <Column
              key={s}
              state={s}
              tasks={byState(s)}
              loading={s === 'completed' ? doneQ.isPending : openQ.isPending}
              note={s === 'completed' ? '最近 20 条' : undefined}
            />
          ))}
          {showClosed ? (
            <section className="flex w-[82vw] max-w-80 shrink-0 snap-start flex-col rounded-xl bg-muted/50 sm:w-64 lg:max-w-none lg:min-w-60 lg:flex-1" aria-label="已结束">
              <header className="flex items-center gap-2 px-3 pt-3 pb-2">
                <span className="size-2 rounded-full bg-muted-foreground" />
                <h2 className="text-sm font-semibold">失败 / 取消 / 拒绝</h2>
                <Badge variant="secondary">{closedTasks.length}</Badge>
                <Button variant="ghost" size="icon-xs" className="ml-auto" onClick={() => setShowClosed(false)} aria-label="收起">
                  <ChevronLeft />
                </Button>
              </header>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                {closedTasks.length === 0 ? (
                  <div className="rounded-lg border border-dashed px-3 py-8 text-center text-xs text-muted-foreground">暂无任务</div>
                ) : (
                  closedTasks.map((t) => <TaskCard key={t.id} task={t} />)
                )}
              </div>
            </section>
          ) : (
            <button
              type="button"
              onClick={() => setShowClosed(true)}
              className="flex w-12 shrink-0 snap-start flex-col items-center gap-3 rounded-xl bg-muted/50 py-3 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="展开失败、已取消、已拒绝的任务"
            >
              <ChevronRight className="size-4" />
              <Badge variant="secondary">{closedTasks.length}</Badge>
              <span className="flex flex-col items-center gap-1 text-xs [writing-mode:vertical-rl]">
                失败 · 已取消 · 已拒绝
              </span>
              <span className="mt-auto flex flex-col gap-1.5">
                {CLOSED.map((s) => (
                  <StateIcon key={s} state={s} className="size-3.5" />
                ))}
              </span>
            </button>
          )}
        </div>
      )}
    </PageContainer>
  )
}
