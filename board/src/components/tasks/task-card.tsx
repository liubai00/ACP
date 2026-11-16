import { Clock, GitPullRequest } from 'lucide-react'
import { Link } from 'react-router'
import { AgentChip, MemberAvatar } from '@/components/member-avatar'
import { CiDot, DemoBadge, PriorityLabel, ToneBadge } from '@/components/status-badge'
import { ageHours, formatAge } from '@/lib/format'
import { CI_LABEL, OPEN_STATES, TASK_TYPE_LABEL } from '@/lib/labels'
import { cn } from '@/lib/utils'
import type { TaskSummary } from '@/types/api'

/** 看板卡片 */
export function TaskCard({ task }: { task: TaskSummary }) {
  const open = OPEN_STATES.includes(task.state)
  const hours = ageHours(task.state_changed_at)
  const ageTone = !open ? 'text-muted-foreground' : hours > 72 ? 'text-danger' : hours > 24 ? 'text-[color-mix(in_oklch,var(--warning),black_20%)] dark:text-warning' : 'text-muted-foreground'
  const person = task.assignee ?? task.suggested_assignee
  return (
    <Link
      to={`/tasks/${task.id}`}
      className={cn(
        'group block rounded-lg border bg-card p-3 text-card-foreground shadow-xs transition-colors outline-none hover:border-primary/40 hover:bg-[color-mix(in_oklch,var(--card),var(--primary)_3%)] focus-visible:ring-3 focus-visible:ring-ring/50',
        task.priority === 'urgent' && open && 'border-l-2 border-l-danger',
      )}
    >
      <div className="mb-1.5 flex items-center gap-2 text-xs">
        <span className="font-mono text-muted-foreground">{task.key}</span>
        {task.type !== 'requirement' && (
          <ToneBadge tone={task.type === 'help' ? 'primary' : 'neutral'} className="h-4 px-1.5 text-[10px]">
            {TASK_TYPE_LABEL[task.type]}
          </ToneBadge>
        )}
        {task.is_demo && <DemoBadge className="h-4 px-1.5 text-[10px]" />}
        <span className="ml-auto">
          <PriorityLabel priority={task.priority} />
        </span>
      </div>
      <p className="line-clamp-2 text-sm leading-snug font-medium group-hover:text-primary">{task.title}</p>
      {task.repos.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {task.repos.slice(0, 2).map((r) => (
            <span key={r} className="max-w-full truncate rounded bg-muted px-1.5 font-mono text-[11px] leading-5 text-muted-foreground">
              {r}
            </span>
          ))}
          {task.repos.length > 2 && <span className="rounded bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground">+{task.repos.length - 2}</span>}
        </div>
      )}
      {/* 列窄时 MR 与停留时长换到下一行，不再把负责人名字挤成省略号 */}
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <MemberAvatar member={person} size="sm" tooltip={!!person} />
        <div className="flex min-w-20 flex-1 flex-col">
          <span className={cn('truncate text-xs', !person && 'text-muted-foreground')}>
            {task.assignee?.name ?? (task.suggested_assignee ? `推荐 ${task.suggested_assignee.name}` : '未分配')}
          </span>
          <AgentChip agent={task.assignee_agent} className="text-[11px]" />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {task.mr_count > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={`MR ${task.mr_merged}/${task.mr_count} · CI ${CI_LABEL[task.ci_status]}`}>
              <GitPullRequest className="size-3.5" />
              {task.mr_merged}/{task.mr_count}
              <CiDot status={task.ci_status} />
            </span>
          )}
          <span className={cn('inline-flex shrink-0 items-center gap-1 text-xs tabular-nums', ageTone)} title="在当前状态停留的时长">
            <Clock className="size-3" />
            {formatAge(task.state_changed_at)}
          </span>
        </div>
      </div>
    </Link>
  )
}
