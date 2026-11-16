import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table'
import { Bot, GitBranch, LayoutList, MessageSquare, RefreshCw, Server, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { DataTable } from '@/components/data-table/data-table'
import { DataTablePagination } from '@/components/data-table/data-table-pagination'
import { ErrorState } from '@/components/empty-state'
import { PageContainer } from '@/components/layout/page-container'
import { ToneBadge } from '@/components/status-badge'
import { ToggleChips } from '@/components/toggle-chips'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format'
import {
  EVENT_SOURCE_LABEL,
  SOURCE_EVENT_STATUS_LABEL,
  SOURCE_EVENT_STATUS_TONE,
  SOURCE_STATUS_LABEL,
  SOURCE_STATUS_TONE,
} from '@/lib/labels'
import { useSourceEvents, useSources } from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { SourceEvent, SourceEventSource, SourceInfo } from '@/types/api'

const ICON: Record<string, LucideIcon> = {
  feishu: MessageSquare,
  gitlab: GitBranch,
  board: LayoutList,
  agent: Bot,
  system: Server,
}

const ORDER: SourceEventSource[] = ['feishu', 'gitlab', 'board', 'agent', 'system']

function SourceCard({ info, active, onSelect }: { info: SourceInfo; active: boolean; onSelect: () => void }) {
  const Icon = ICON[info.source] ?? Server
  return (
    <Card
      className={cn(
        'cursor-pointer bg-gradient-to-t from-primary/5 to-card shadow-xs transition-shadow hover:ring-primary/40 dark:bg-card',
        active && 'ring-2 ring-primary',
        info.status === 'error' && 'from-danger/5',
      )}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect())}
    >
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-4" />
          </span>
          <span className="font-medium text-foreground">{info.label}</span>
        </CardDescription>
        <CardAction>
          <ToneBadge tone={SOURCE_STATUS_TONE[info.status]}>
            <span className={cn('size-1.5 rounded-full bg-current', info.status === 'connected' && 'animate-pulse')} />
            {SOURCE_STATUS_LABEL[info.status]}
          </ToneBadge>
        </CardAction>
        <CardTitle className="pt-1 text-2xl font-semibold tabular-nums">
          {formatNumber(info.events_24h)}
          <span className="ml-1 text-xs font-normal text-muted-foreground">件 / 24 小时</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        <p className="line-clamp-2 min-h-8">{info.detail ?? '—'}</p>
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span>7 天 {formatNumber(info.events_7d)} 件</span>
        <span title={formatDateTime(info.last_event_at)}>最近 {formatRelative(info.last_event_at)}</span>
      </CardFooter>
    </Card>
  )
}

const columns: ColumnDef<SourceEvent>[] = [
  {
    id: 'at',
    header: '时间',
    cell: ({ row }) => (
      <Tooltip>
        <TooltipTrigger render={<span className="text-sm whitespace-nowrap text-muted-foreground tabular-nums" />}>{formatRelative(row.original.at)}</TooltipTrigger>
        <TooltipContent>{formatDateTime(row.original.at, true)}</TooltipContent>
      </Tooltip>
    ),
    meta: { label: '时间', className: 'w-28' },
  },
  {
    id: 'source',
    header: '来源',
    cell: ({ row }) => {
      const Icon = ICON[row.original.source] ?? Server
      return (
        <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
          <Icon className="size-3.5 text-muted-foreground" />
          {EVENT_SOURCE_LABEL[row.original.source] ?? row.original.source}
        </span>
      )
    },
    meta: { label: '来源' },
  },
  {
    id: 'kind',
    header: '类型',
    cell: ({ row }) => <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">{row.original.kind}</span>,
    meta: { label: '类型' },
  },
  {
    id: 'summary',
    header: '摘要',
    cell: ({ row }) => <span className="line-clamp-2 min-w-[240px] text-sm">{row.original.summary}</span>,
    meta: { label: '摘要' },
  },
  {
    id: 'status',
    header: '处理结果',
    cell: ({ row }) => <ToneBadge tone={SOURCE_EVENT_STATUS_TONE[row.original.status]}>{SOURCE_EVENT_STATUS_LABEL[row.original.status]}</ToneBadge>,
    meta: { label: '处理结果' },
  },
  {
    id: 'task',
    header: '关联任务',
    cell: ({ row }) =>
      row.original.task_id ? (
        <Link to={`/tasks/${row.original.task_id}`} className="font-mono text-xs whitespace-nowrap text-primary hover:underline">
          {row.original.task_key ?? `ACP-${row.original.task_id}`}
        </Link>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    meta: { label: '关联任务' },
  },
]

export default function SourcesPage() {
  const sources = useSources()
  const [source, setSource] = useState<SourceEventSource | 'all'>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const events = useSourceEvents({ source: source === 'all' ? undefined : source, page, page_size: pageSize })

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table v8 的已知用法
  const table = useReactTable({
    data: events.data?.items ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    getRowId: (r) => String(r.id),
  })

  const pick = (s: SourceEventSource | 'all') => {
    setSource(s)
    setPage(1)
  }

  const items = [...(sources.data?.items ?? [])].sort((a, b) => ORDER.indexOf(a.source as SourceEventSource) - ORDER.indexOf(b.source as SourceEventSource))

  return (
    <PageContainer
      title="数据来源"
      description="任务从哪里来：飞书群消息、GitLab 事件、任务榜、Agent 求助和系统巡检。点卡片按来源筛选下方事件。"
      actions={
        <Button
          variant="outline"
          onClick={() => {
            void sources.refetch()
            void events.refetch()
          }}
        >
          <RefreshCw className={cn((sources.isFetching || events.isFetching) && 'animate-spin')} />
          刷新
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        {sources.error ? (
          <ErrorState error={sources.error} onRetry={() => void sources.refetch()} className="rounded-xl border" />
        ) : (
          <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {sources.isPending
              ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)
              : items.map((info) => (
                  <SourceCard key={info.source} info={info} active={source === info.source} onSelect={() => pick(source === info.source ? 'all' : (info.source as SourceEventSource))} />
                ))}
          </div>
        )}

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">来源事件</h2>
            <div className="max-w-full overflow-x-auto">
              <ToggleChips
                value={source}
                onChange={pick}
                options={[{ value: 'all' as const, label: '全部' }, ...ORDER.map((s) => ({ value: s, label: EVENT_SOURCE_LABEL[s] }))]}
              />
            </div>
          </div>
          {events.error && !events.data ? (
            <ErrorState error={events.error} onRetry={() => void events.refetch()} className="rounded-lg border" />
          ) : (
            <DataTable
              table={table}
              loading={events.isPending || events.isFetching}
              emptyText="这个来源还没有事件"
              rowClassName={(e) => (e.status === 'error' ? 'bg-danger/5' : undefined)}
              footer={
                <DataTablePagination
                  page={page}
                  pageSize={pageSize}
                  total={events.data?.total ?? 0}
                  onPageChange={setPage}
                  onPageSizeChange={(s) => {
                    setPageSize(s)
                    setPage(1)
                  }}
                />
              }
            />
          )}
        </section>
      </div>
    </PageContainer>
  )
}
