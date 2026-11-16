import type { ColumnDef } from '@tanstack/react-table'
import { Link } from 'react-router'
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header'
import { AgentChip, MemberAvatar } from '@/components/member-avatar'
import { DemoBadge, PriorityLabel, SourceLabel, StateBadge, ToneBadge } from '@/components/status-badge'
import { MrCiCell, RepoList } from './task-cells'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDateTime, formatRelative } from '@/lib/format'
import { TASK_TYPE_LABEL } from '@/lib/labels'
import type { TaskSummary } from '@/types/api'

/** 列 id → 后端 sort 字段 */
export const SORT_FIELD: Record<string, string> = {
  key: 'id',
  title: 'title',
  state: 'state',
  priority: 'priority',
  updated_at: 'updated_at',
  created_at: 'created_at',
}

export const taskColumns: ColumnDef<TaskSummary>[] = [
  {
    id: 'key',
    accessorKey: 'key',
    header: ({ column }) => <DataTableColumnHeader column={column} label="编号" />,
    cell: ({ row }) => (
      <Link to={`/tasks/${row.original.id}`} className="font-mono text-xs whitespace-nowrap text-muted-foreground hover:text-foreground hover:underline">
        {row.original.key}
      </Link>
    ),
    enableHiding: false,
    meta: { label: '编号', className: 'w-24' },
  },
  {
    id: 'title',
    accessorKey: 'title',
    header: ({ column }) => <DataTableColumnHeader column={column} label="标题" />,
    cell: ({ row }) => {
      const t = row.original
      return (
        <div className="flex min-w-[200px] flex-col gap-1">
          <div className="flex items-center gap-1.5">
            {t.type !== 'requirement' && (
              <ToneBadge tone={t.type === 'help' ? 'primary' : 'neutral'} className="shrink-0">
                {TASK_TYPE_LABEL[t.type]}
              </ToneBadge>
            )}
            <span className="line-clamp-1 font-medium">{t.title}</span>
            {t.is_demo && <DemoBadge className="shrink-0" />}
          </div>
          <div className="flex flex-wrap items-center gap-2 md:hidden">
            <StateBadge state={t.state} />
            <span className="text-xs text-muted-foreground">{t.assignee?.name ?? '未分配'}</span>
          </div>
          {t.labels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {t.labels.slice(0, 3).map((l) => (
                <span key={l} className="rounded bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground">
                  {l}
                </span>
              ))}
            </div>
          )}
        </div>
      )
    },
    enableHiding: false,
    meta: { label: '标题' },
  },
  {
    id: 'state',
    accessorKey: 'state',
    header: ({ column }) => <DataTableColumnHeader column={column} label="状态" />,
    cell: ({ row }) => <StateBadge state={row.original.state} />,
    meta: { label: '状态' },
  },
  {
    id: 'priority',
    accessorKey: 'priority',
    header: ({ column }) => <DataTableColumnHeader column={column} label="优先级" />,
    cell: ({ row }) => <PriorityLabel priority={row.original.priority} />,
    meta: { label: '优先级' },
  },
  {
    id: 'source',
    accessorKey: 'source',
    header: '来源',
    cell: ({ row }) => <SourceLabel source={row.original.source} />,
    enableSorting: false,
    meta: { label: '来源' },
  },
  {
    id: 'assignee',
    accessorFn: (t) => t.assignee?.name ?? '',
    header: '负责人',
    cell: ({ row }) => {
      const t = row.original
      const person = t.assignee ?? t.suggested_assignee
      return (
        <div className="flex min-w-[120px] items-center gap-2">
          <MemberAvatar member={person} size="sm" />
          <div className="flex min-w-0 flex-col">
            <span className={!person ? 'text-sm text-muted-foreground' : 'truncate text-sm'}>
              {t.assignee ? t.assignee.name : t.suggested_assignee ? `${t.suggested_assignee.name}（推荐）` : '未分配'}
            </span>
            <AgentChip agent={t.assignee_agent} />
          </div>
        </div>
      )
    },
    enableSorting: false,
    meta: { label: '负责人' },
  },
  {
    id: 'repos',
    accessorFn: (t) => t.repos.join(','),
    header: '仓库',
    cell: ({ row }) => (
      <div className="max-w-[180px]">
        <RepoList repos={row.original.repos} />
      </div>
    ),
    enableSorting: false,
    meta: { label: '仓库' },
  },
  {
    id: 'mr',
    accessorFn: (t) => t.mr_count,
    header: 'MR / CI',
    cell: ({ row }) => <MrCiCell task={row.original} />,
    enableSorting: false,
    meta: { label: 'MR / CI' },
  },
  {
    id: 'updated_at',
    accessorKey: 'updated_at',
    header: ({ column }) => <DataTableColumnHeader column={column} label="更新时间" />,
    cell: ({ row }) => (
      <Tooltip>
        <TooltipTrigger render={<span className="text-sm whitespace-nowrap text-muted-foreground" />}>{formatRelative(row.original.updated_at)}</TooltipTrigger>
        <TooltipContent>{formatDateTime(row.original.updated_at)}</TooltipContent>
      </Tooltip>
    ),
    meta: { label: '更新时间' },
  },
  {
    id: 'created_at',
    accessorKey: 'created_at',
    header: ({ column }) => <DataTableColumnHeader column={column} label="创建时间" />,
    cell: ({ row }) => <span className="text-sm whitespace-nowrap text-muted-foreground">{formatDateTime(row.original.created_at)}</span>,
    meta: { label: '创建时间' },
  },
]
