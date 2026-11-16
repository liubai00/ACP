import {
  AlarmClock,
  ArrowRightLeft,
  Ban,
  Bell,
  Bot,
  Circle,
  CircleCheck,
  CircleX,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Hand,
  Hourglass,
  LifeBuoy,
  LoaderCircle,
  MessageCircleQuestionMark,
  Pencil,
  Plug,
  Plus,
  RotateCw,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  Undo2,
  UserPlus,
  UserX,
  type LucideIcon,
} from 'lucide-react'
import { Fragment } from 'react'
import { MemberAvatar } from '@/components/member-avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDate, formatDateTime, formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { TimelineItem } from '@/types/api'

export function ActorIcon({ actor, className }: { actor: TimelineItem['actor']; className?: string }) {
  if (actor.type === 'member') {
    return <MemberAvatar member={{ name: actor.name, avatar_url: null }} size="sm" className={cn('mt-0.5', className)} />
  }
  const Icon = actor.type === 'agent' ? Bot : actor.type === 'connector' ? Plug : actor.name.includes('Agent') ? Sparkles : Server
  return (
    <span
      className={cn(
        'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full',
        actor.type === 'agent' ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
        className,
      )}
      aria-hidden
    >
      <Icon className="size-3.5" />
    </span>
  )
}

function eventIcon(item: TimelineItem): { icon: LucideIcon; className?: string } {
  const status = typeof item.data?.status === 'string' ? item.data.status : null
  switch (item.type) {
    case 'task.created':
      return { icon: Plus, className: 'text-primary' }
    case 'state.changed': {
      const to = item.data?.to
      if (to === 'completed') return { icon: CircleCheck, className: 'text-success' }
      if (to === 'failed' || to === 'rejected') return { icon: CircleX, className: 'text-danger' }
      return { icon: ArrowRightLeft }
    }
    case 'task.claimed':
      return { icon: Hand, className: 'text-primary' }
    case 'task.assigned':
    case 'task.suggested':
      return { icon: UserPlus }
    case 'task.declined':
      return { icon: UserX }
    case 'task.updated':
      return { icon: Pencil }
    case 'task.canceled':
      return { icon: Ban }
    case 'task.completed':
      return { icon: CircleCheck, className: 'text-success' }
    case 'mr.opened':
      return { icon: GitPullRequest, className: 'text-info' }
    case 'mr.merged':
      return { icon: GitMerge, className: 'text-success' }
    case 'pipeline.updated':
      if (status === 'success') return { icon: CircleCheck, className: 'text-success' }
      if (status === 'failed') return { icon: CircleX, className: 'text-danger' }
      return { icon: LoaderCircle, className: 'text-info' }
    case 'ci.retry':
      return { icon: RotateCw }
    case 'approval.requested':
      return { icon: ShieldCheck, className: 'text-warning' }
    case 'approval.decided':
      return item.data?.decision === 'reject' ? { icon: ThumbsDown, className: 'text-danger' } : { icon: ThumbsUp, className: 'text-success' }
    case 'agent.tool':
      return { icon: Terminal }
    case 'agent.acked':
      return { icon: Bot, className: 'text-primary' }
    case 'agent.waiting':
      return { icon: Hourglass, className: 'text-warning' }
    case 'task.dispatched':
      return { icon: UserPlus, className: 'text-primary' }
    case 'git.pushed':
      return { icon: GitCommitHorizontal }
    case 'mr.reported':
      return { icon: GitPullRequest, className: 'text-info' }
    case 'ci.success':
      return { icon: CircleCheck, className: 'text-success' }
    case 'ci.failed':
      return { icon: CircleX, className: 'text-danger' }
    case 'ci.running':
    case 'ci.pending':
      return { icon: LoaderCircle, className: 'text-info' }
    case 'approval.approved':
      return { icon: ThumbsUp, className: 'text-success' }
    case 'approval.rejected':
      return { icon: ThumbsDown, className: 'text-danger' }
    case 'help.created':
    case 'help.auto_accepted':
      return { icon: LifeBuoy, className: 'text-primary' }
    case 'input.requested':
      return { icon: MessageCircleQuestionMark, className: 'text-warning' }
    case 'agent.assigned':
      return { icon: Bot, className: 'text-primary' }
    case 'notify.sent':
      return { icon: Bell }
    case 'patrol.reminded':
      return { icon: AlarmClock, className: 'text-warning' }
    case 'suggestion.undo':
    case 'suggestion.undone':
      return { icon: Undo2 }
    default:
      if (item.type.startsWith('suggestion.')) return { icon: Sparkles, className: 'text-primary' }
      return { icon: Circle }
  }
}

function dayLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  if (d.toDateString() === today.toDateString()) return '今天'
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  return formatDate(iso)
}

function Time({ at }: { at: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={at} className="shrink-0 text-xs text-muted-foreground tabular-nums" />}>{formatTime(at)}</TooltipTrigger>
      <TooltipContent>{formatDateTime(at, true)}</TooltipContent>
    </Tooltip>
  )
}

function EventRow({ item }: { item: TimelineItem }) {
  const { icon: Icon, className } = eventIcon(item)
  const isTool = item.type === 'agent.tool'
  return (
    <div className="relative flex items-start gap-3 py-1.5 pl-0.5">
      <span className="relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-border">
        <Icon className={cn('size-3', className ?? 'text-muted-foreground')} aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-medium">{item.actor.name}</span>
        <span className={cn('min-w-0 text-sm text-muted-foreground', isTool && 'font-mono text-xs')}>{item.text}</span>
      </div>
      <Time at={item.at} />
    </div>
  )
}

function MessageRow({ item }: { item: TimelineItem }) {
  const isAgent = item.actor.type === 'agent'
  const isSystem = item.actor.type === 'system' || item.actor.type === 'connector'
  const kind = typeof item.data?.kind === 'string' ? item.data.kind : null
  const isQuestion = kind === 'question'
  const isInput = kind === 'input'
  return (
    <div className="relative flex items-start gap-3 py-2">
      <ActorIcon actor={item.actor} className="relative z-10 ring-4 ring-background" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-x-2">
          <span className={cn('text-sm font-medium', isAgent && 'font-mono text-primary')}>{item.actor.name}</span>
          {isAgent && <span className="rounded bg-primary/10 px-1 text-[10px] font-medium text-primary">AGENT</span>}
          {isQuestion && (
            <span className="inline-flex items-center gap-1 rounded bg-warning/15 px-1 text-[10px] font-medium text-[color-mix(in_oklch,var(--warning),black_25%)] dark:text-warning">
              <MessageCircleQuestionMark className="size-3" />
              需要补充
            </span>
          )}
          {isInput && <span className="rounded bg-success/15 px-1 text-[10px] font-medium text-success">补充信息</span>}
          <span className="ml-auto">
            <Time at={item.at} />
          </span>
        </div>
        <div
          className={cn(
            'rounded-lg border px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap',
            isAgent && 'border-primary/20 bg-primary/5',
            !isAgent && !isSystem && 'border-border bg-muted/50',
            isSystem && 'border-dashed bg-transparent',
            isQuestion && 'border-warning/50 bg-warning/10',
          )}
        >
          {item.text}
        </div>
      </div>
    </div>
  )
}

/** 任务时间线（事件 + 消息），按时间升序；按天分组 */
export function Timeline({ items, className }: { items: TimelineItem[]; className?: string }) {
  const days = items.map((item) => dayLabel(item.at))
  return (
    <div className={cn('relative', className)}>
      <div className="absolute top-2 bottom-2 left-[12px] w-px bg-border" aria-hidden />
      {items.map((item, i) => {
        const day = days[i]
        const showDay = i === 0 || day !== days[i - 1]
        return (
          <Fragment key={item.id}>
            {showDay && (
              <div className="relative z-10 my-2 flex justify-center first:mt-0">
                <span className="rounded-full border bg-background px-2.5 py-0.5 text-xs text-muted-foreground">{day}</span>
              </div>
            )}
            {item.kind === 'message' ? <MessageRow item={item} /> : <EventRow item={item} />}
          </Fragment>
        )
      })}
    </div>
  )
}
