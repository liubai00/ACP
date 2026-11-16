import { GitPullRequest } from 'lucide-react'
import { CiDot } from '@/components/status-badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CI_LABEL } from '@/lib/labels'
import type { TaskSummary } from '@/types/api'

export function RepoList({ repos, max = 1 }: { repos: string[]; max?: number }) {
  if (repos.length === 0) return <span className="text-muted-foreground">—</span>
  const shown = repos.slice(0, max)
  const rest = repos.length - shown.length
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {shown.map((r) => (
        <span key={r} className="truncate font-mono text-xs">
          {r}
        </span>
      ))}
      {rest > 0 && (
        <Tooltip>
          <TooltipTrigger render={<span className="shrink-0 rounded bg-muted px-1 text-xs text-muted-foreground" />}>+{rest}</TooltipTrigger>
          <TooltipContent>{repos.join('、')}</TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}

export function MrCiCell({ task }: { task: Pick<TaskSummary, 'mr_count' | 'mr_merged' | 'ci_status'> }) {
  if (task.mr_count === 0) return <span className="text-sm text-muted-foreground">—</span>
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex items-center gap-1.5 text-sm" />}>
        <GitPullRequest className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="tabular-nums">
          {task.mr_merged}/{task.mr_count}
        </span>
        <CiDot status={task.ci_status} />
      </TooltipTrigger>
      <TooltipContent>
        {task.mr_count} 个 MR，已合并 {task.mr_merged} 个 · CI {CI_LABEL[task.ci_status]}
      </TooltipContent>
    </Tooltip>
  )
}
