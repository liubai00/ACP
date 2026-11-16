import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bot,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Clock,
  FlaskConical,
  GitBranch,
  Hourglass,
  LayoutList,
  LoaderCircle,
  MessageSquare,
  Plug,
  ShieldCheck,
  Siren,
  Ban,
  CircleQuestionMark,
} from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import {
  CI_LABEL,
  CI_TONE,
  PIPELINE_LABEL,
  PIPELINE_TONE,
  PRIORITY_LABEL,
  SOURCE_LABEL,
  STATE_LABEL,
  STATE_TONE,
  type Tone,
} from '@/lib/labels'
import { cn } from '@/lib/utils'
import type { CiStatus, PipelineStatus, Priority, Source, TaskState } from '@/types/api'

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'border-border bg-background text-foreground',
  muted: 'border-transparent bg-muted text-muted-foreground',
  info: 'border-info/25 bg-info/10 text-info',
  primary: 'border-primary/25 bg-primary/10 text-[color-mix(in_oklch,var(--primary),black_20%)] dark:text-[color-mix(in_oklch,var(--primary),white_40%)]',
  warning: 'border-warning/30 bg-warning/12 text-[color-mix(in_oklch,var(--warning),black_25%)] dark:text-warning',
  success: 'border-success/25 bg-success/10 text-[color-mix(in_oklch,var(--success),black_15%)] dark:text-success',
  danger: 'border-danger/25 bg-danger/10 text-danger',
}

export function ToneBadge({
  tone,
  className,
  children,
  ...props
}: { tone: Tone; children: ReactNode } & Omit<ComponentProps<typeof Badge>, 'variant'>) {
  return (
    <Badge variant="outline" className={cn('font-medium', TONE_CLASS[tone], className)} {...props}>
      {children}
    </Badge>
  )
}

const STATE_ICON: Record<TaskState, typeof CircleDot> = {
  submitted: CircleDashed,
  working: LoaderCircle,
  'input-required': MessageSquare,
  'auth-required': ShieldCheck,
  completed: CircleCheck,
  failed: CircleX,
  canceled: Ban,
  rejected: CircleX,
}

export function StateIcon({ state, className }: { state: TaskState; className?: string }) {
  const Icon = STATE_ICON[state]
  return <Icon className={cn(state === 'working' && 'animate-[spin_3s_linear_infinite]', className)} aria-hidden />
}

export function StateBadge({ state, className }: { state: TaskState; className?: string }) {
  return (
    <ToneBadge tone={STATE_TONE[state]} className={className}>
      <StateIcon state={state} />
      {STATE_LABEL[state]}
    </ToneBadge>
  )
}

const PRIORITY_ICON: Record<Priority, typeof ArrowUp> = {
  urgent: Siren,
  high: ArrowUp,
  normal: ArrowRight,
  low: ArrowDown,
}

export function PriorityBadge({ priority, className }: { priority: Priority; className?: string }) {
  const Icon = PRIORITY_ICON[priority]
  const tone: Tone = priority === 'urgent' ? 'danger' : priority === 'high' ? 'warning' : 'muted'
  return (
    <ToneBadge tone={tone} className={cn(priority === 'normal' && 'bg-transparent border-border text-muted-foreground', className)}>
      <Icon />
      {PRIORITY_LABEL[priority]}
    </ToneBadge>
  )
}

export function PriorityLabel({ priority }: { priority: Priority }) {
  const Icon = PRIORITY_ICON[priority]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-sm whitespace-nowrap',
        priority === 'urgent' && 'text-danger font-medium',
        priority === 'high' && 'text-[color-mix(in_oklch,var(--warning),black_20%)] dark:text-warning font-medium',
        (priority === 'normal' || priority === 'low') && 'text-muted-foreground',
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {PRIORITY_LABEL[priority]}
    </span>
  )
}

const SOURCE_ICON: Record<Source, typeof Bot> = {
  feishu: MessageSquare,
  board: LayoutList,
  agent: Bot,
  gitlab: GitBranch,
  api: Plug,
}

export function SourceIcon({ source, className }: { source: Source; className?: string }) {
  const Icon = SOURCE_ICON[source] ?? CircleQuestionMark
  return <Icon className={className} aria-hidden />
}

export function SourceLabel({ source, className }: { source: Source; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm whitespace-nowrap text-muted-foreground', className)}>
      <SourceIcon source={source} className="size-3.5" />
      {SOURCE_LABEL[source] ?? source}
    </span>
  )
}

const CI_ICON: Record<CiStatus, typeof Clock> = {
  none: CircleDashed,
  pending: Hourglass,
  running: LoaderCircle,
  success: CircleCheck,
  failed: CircleX,
}

export function CiBadge({ status, className }: { status: CiStatus; className?: string }) {
  const Icon = CI_ICON[status]
  return (
    <ToneBadge tone={CI_TONE[status]} className={className}>
      <Icon className={cn(status === 'running' && 'animate-spin')} />
      CI {CI_LABEL[status]}
    </ToneBadge>
  )
}

const PIPELINE_ICON: Record<PipelineStatus, typeof Clock> = {
  none: CircleDashed,
  pending: Hourglass,
  running: LoaderCircle,
  success: CircleCheck,
  failed: CircleX,
  canceled: Ban,
}

export function PipelineBadge({ status, className }: { status: PipelineStatus; className?: string }) {
  const Icon = PIPELINE_ICON[status]
  return (
    <ToneBadge tone={PIPELINE_TONE[status]} className={className}>
      <Icon className={cn(status === 'running' && 'animate-spin')} />
      {PIPELINE_LABEL[status]}
    </ToneBadge>
  )
}

/** 只有图标的 CI 状态点（卡片、表格里用） */
export function CiDot({ status, className }: { status: CiStatus; className?: string }) {
  const Icon = CI_ICON[status]
  const color: Record<CiStatus, string> = {
    none: 'text-muted-foreground/60',
    pending: 'text-muted-foreground',
    running: 'text-info',
    success: 'text-success',
    failed: 'text-danger',
  }
  return <Icon className={cn('size-3.5', color[status], status === 'running' && 'animate-spin', className)} aria-label={`CI ${CI_LABEL[status]}`} />
}

export function DemoBadge({ className }: { className?: string }) {
  return (
    <ToneBadge tone="muted" className={cn('border-dashed border-muted-foreground/40', className)}>
      <FlaskConical />
      示例
    </ToneBadge>
  )
}
