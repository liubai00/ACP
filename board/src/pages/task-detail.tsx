import { ArrowLeft, FileQuestionMark } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { EmptyState, ErrorState } from '@/components/empty-state'
import { PageSkeleton } from '@/components/page-skeleton'
import { DemoBadge, PriorityBadge, StateBadge, ToneBadge } from '@/components/status-badge'
import {
  ApprovalsSection,
  MergeRequestsSection,
  MessageComposer,
  SubtasksSection,
  SuggestionsSection,
} from '@/components/tasks/detail-sections'
import { FlowStepper } from '@/components/tasks/flow-stepper'
import { TaskActions } from '@/components/tasks/task-actions'
import { TaskSidePanel } from '@/components/tasks/task-side-panel'
import { Timeline } from '@/components/tasks/timeline'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleChips } from '@/components/toggle-chips'
import { useTaskStream, type StreamStatus } from '@/hooks/use-task-stream'
import { ApiError } from '@/lib/api'
import { STATE_DESCRIPTION, TASK_TYPE_LABEL } from '@/lib/labels'
import type { TaskDetail } from '@/types/api'
import { useTask } from '@/lib/queries'
import { cn } from '@/lib/utils'

function LiveIndicator({ status }: { status: StreamStatus }) {
  const label = status === 'live' ? '实时' : status === 'connecting' ? '连接中' : '重连中'
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title="任务详情通过 SSE 实时更新">
      <span className="relative flex size-2">
        {status === 'live' && <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />}
        <span className={cn('relative inline-flex size-2 rounded-full', status === 'live' ? 'bg-success' : 'bg-warning')} />
      </span>
      {label}
    </span>
  )
}

function CountBadge({ n, highlight = false }: { n: number; highlight?: boolean }) {
  if (!n) return null
  return (
    <Badge variant={highlight ? 'default' : 'secondary'} className="ml-0.5 h-4 min-w-4 px-1 text-[10px] tabular-nums">
      {n}
    </Badge>
  )
}

type TimelineFilter = 'all' | 'message' | 'event'

export default function TaskDetailPage() {
  const params = useParams()
  const id = Number(params.id)
  const { data: task, error, isPending, refetch } = useTask(id)
  const stream = useTaskStream(id, !!task)
  const [tab, setTab] = useState('timeline')
  const [filter, setFilter] = useState<TimelineFilter>('all')

  const timeline = useMemo(() => {
    if (!task) return []
    return filter === 'all' ? task.timeline : task.timeline.filter((t) => t.kind === filter)
  }, [task, filter])

  if (!Number.isFinite(id) || id <= 0 || (error instanceof ApiError && error.status === 404)) {
    return (
      <EmptyState
        icon={FileQuestionMark}
        title="任务不存在"
        description={`没有找到编号为 ACP-${params.id ?? ''} 的任务，可能已被删除或编号有误。`}
        action={
          <Button variant="outline" nativeButton={false} render={<Link to="/tasks" />}>
            返回任务列表
          </Button>
        }
        className="flex-1"
      />
    )
  }
  if (isPending) return <PageSkeleton />
  if (error || !task) return <ErrorState error={error} onRetry={() => void refetch()} className="flex-1" />

  const pendingApprovals = task.approvals.filter((a) => a.status === 'pending').length
  const proposed = task.suggestions.filter((s) => s.status === 'proposed').length
  const messages = task.timeline.filter((t) => t.kind === 'message').length

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 pt-2 pb-6 md:px-6 md:pt-4">
      {/* 头部 */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" nativeButton={false} render={<Link to="/tasks" />}>
            <ArrowLeft />
            任务列表
          </Button>
          <span className="font-mono text-muted-foreground">{task.key}</span>
          {task.type !== 'requirement' && <ToneBadge tone={task.type === 'help' ? 'primary' : 'neutral'}>{TASK_TYPE_LABEL[task.type]}</ToneBadge>}
          {task.is_demo && <DemoBadge />}
          <span className="ml-auto">
            <LiveIndicator status={stream} />
          </span>
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-2">
            <h1 className="text-xl font-bold tracking-tight break-words sm:text-2xl">{task.title}</h1>
            <div className="flex flex-wrap items-center gap-2">
              <StateBadge state={task.state} />
              <PriorityBadge priority={task.priority} />
              <span className="text-sm text-muted-foreground">{stateHint(task)}</span>
            </div>
          </div>
          <div className="shrink-0">
            <TaskActions task={task} />
          </div>
        </div>
      </div>

      {/* 流程 */}
      <Card size="sm">
        <CardContent>
          <FlowStepper task={task} />
        </CardContent>
      </Card>

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px]">
        <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="min-w-0 gap-3">
          <div className="-mx-1 overflow-x-auto px-1">
            <TabsList>
              <TabsTrigger value="timeline">
                时间线 <CountBadge n={task.timeline.length} />
              </TabsTrigger>
              <TabsTrigger value="code">
                代码与 CI <CountBadge n={task.merge_requests.length} />
              </TabsTrigger>
              <TabsTrigger value="approvals">
                审批 <CountBadge n={pendingApprovals || task.approvals.length} highlight={pendingApprovals > 0} />
              </TabsTrigger>
              <TabsTrigger value="children">
                子任务 <CountBadge n={task.children.length} />
              </TabsTrigger>
              <TabsTrigger value="suggestions">
                协调建议 <CountBadge n={proposed || task.suggestions.length} highlight={proposed > 0} />
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="timeline" className="space-y-4">
            <Card>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-muted-foreground">
                    共 {task.timeline.length} 条，其中消息 {messages} 条；Agent 的消息以紫色标出。
                  </p>
                  <ToggleChips
                    value={filter}
                    onChange={setFilter}
                    options={[
                      { value: 'all', label: '全部' },
                      { value: 'message', label: '消息' },
                      { value: 'event', label: '事件' },
                    ]}
                  />
                </div>
                {timeline.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">没有内容</p>
                ) : (
                  <Timeline items={timeline} />
                )}
                <MessageComposer task={task} />
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="code">
            <MergeRequestsSection task={task} />
          </TabsContent>
          <TabsContent value="approvals">
            <ApprovalsSection task={task} />
          </TabsContent>
          <TabsContent value="children">
            <SubtasksSection task={task} />
          </TabsContent>
          <TabsContent value="suggestions">
            <SuggestionsSection task={task} />
          </TabsContent>
        </Tabs>
        <aside className="min-w-0">
          <TaskSidePanel task={task} />
        </aside>
      </div>
    </div>
  )
}

/** 进行中的任务按有没有 Agent 在执行给出不同说明，避免没有 Agent 时还写“Agent 正在执行” */
function stateHint(task: TaskDetail): string {
  if (task.state !== 'working') return STATE_DESCRIPTION[task.state]
  if (task.assignee_agent) return `已有负责人，Agent「${task.assignee_agent.name}」正在执行`
  return '已有负责人，还没有 Agent 在执行；负责人的 Agent 上线后自动开始'
}
