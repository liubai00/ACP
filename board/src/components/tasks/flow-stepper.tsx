import { Check, LoaderCircle, Minus, X, type LucideIcon } from 'lucide-react'
import { Fragment, useEffect, useRef } from 'react'
import { formatDate, formatRelative } from '@/lib/format'
import { CI_LABEL, SOURCE_LABEL, STATE_LABEL } from '@/lib/labels'
import { cn } from '@/lib/utils'
import type { TaskDetail } from '@/types/api'

type StepStatus = 'done' | 'current' | 'blocked' | 'error' | 'pending' | 'skipped'

interface Step {
  key: string
  label: string
  status: StepStatus
  detail: string
}

/** 根据任务状态推出生命周期各步的进度（任务榜内的流程视图，代替 n8n 画布） */
function computeFlow(t: TaskDetail): Step[] {
  const terminal = ['completed', 'failed', 'canceled', 'rejected'].includes(t.state)
  const stopped = t.state === 'canceled' || t.state === 'rejected'
  const hasMr = t.merge_requests.length > 0 || t.mr_count > 0
  const pendingApproval = t.approvals.find((a) => a.status === 'pending')
  const lastApproval = [...t.approvals].sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1)
  const merged = t.merge_requests.filter((m) => m.state === 'merged').length

  const steps: Step[] = []
  steps.push({ key: 'create', label: '建单', status: 'done', detail: `${SOURCE_LABEL[t.source]} · ${formatDate(t.created_at)}` })

  // 认领
  if (t.assignee) steps.push({ key: 'claim', label: '认领', status: 'done', detail: t.assignee.name })
  else if (t.state === 'submitted')
    steps.push({ key: 'claim', label: '认领', status: 'current', detail: t.suggested_assignee ? `推荐 ${t.suggested_assignee.name}` : '等待认领' })
  else steps.push({ key: 'claim', label: '认领', status: stopped ? 'skipped' : 'pending', detail: '—' })

  // 执行
  if (!t.assignee) steps.push({ key: 'run', label: '执行', status: stopped ? 'skipped' : 'pending', detail: '—' })
  else if (t.state === 'input-required') steps.push({ key: 'run', label: '执行', status: 'blocked', detail: '待补充信息' })
  else if (t.state === 'working' && !hasMr)
    steps.push({ key: 'run', label: '执行', status: 'current', detail: t.assignee_agent ? `${t.assignee_agent.name} 执行中` : '执行中' })
  else if (t.state === 'failed' && !hasMr) steps.push({ key: 'run', label: '执行', status: 'error', detail: 'Agent 报错退出' })
  else if (stopped && !hasMr) steps.push({ key: 'run', label: '执行', status: 'skipped', detail: '已中止' })
  else steps.push({ key: 'run', label: '执行', status: 'done', detail: t.assignee_agent?.name ?? '已完成' })

  // 提交 MR
  if (hasMr) steps.push({ key: 'mr', label: '提交 MR', status: 'done', detail: `${t.mr_count || t.merge_requests.length} 个 MR` })
  else if (t.state === 'completed') steps.push({ key: 'mr', label: '提交 MR', status: 'skipped', detail: '无代码改动' })
  else steps.push({ key: 'mr', label: '提交 MR', status: stopped || t.state === 'failed' ? 'skipped' : 'pending', detail: '—' })

  // CI
  if (!hasMr) steps.push({ key: 'ci', label: 'CI', status: terminal ? 'skipped' : 'pending', detail: '—' })
  else if (t.ci_status === 'success') steps.push({ key: 'ci', label: 'CI', status: 'done', detail: '流水线通过' })
  else if (t.ci_status === 'failed')
    steps.push({ key: 'ci', label: 'CI', status: t.state === 'working' ? 'blocked' : 'error', detail: t.state === 'working' ? '失败，修复中' : '流水线失败' })
  else if (t.ci_status === 'running' || t.ci_status === 'pending') steps.push({ key: 'ci', label: 'CI', status: 'current', detail: `流水线${CI_LABEL[t.ci_status]}` })
  else steps.push({ key: 'ci', label: 'CI', status: terminal ? 'skipped' : 'pending', detail: '—' })

  // 审批
  if (pendingApproval || t.state === 'auth-required') steps.push({ key: 'approval', label: '审批', status: 'current', detail: '等待审批' })
  else if (lastApproval?.status === 'approved') steps.push({ key: 'approval', label: '审批', status: 'done', detail: lastApproval.decided_by ? `${lastApproval.decided_by.name} 同意` : '已同意' })
  else if (lastApproval?.status === 'rejected' && !terminal) steps.push({ key: 'approval', label: '审批', status: 'blocked', detail: '被驳回，修改中' })
  else if (t.state === 'completed') steps.push({ key: 'approval', label: '审批', status: 'skipped', detail: '无需审批' })
  else steps.push({ key: 'approval', label: '审批', status: terminal ? 'skipped' : 'pending', detail: '—' })

  // 合并 / 完成
  if (t.state === 'completed')
    steps.push({ key: 'done', label: '合并/完成', status: 'done', detail: merged ? `已合并 ${merged} 个 MR` : `已验收 · ${formatRelative(t.closed_at)}` })
  else if (t.state === 'failed' || t.state === 'canceled' || t.state === 'rejected')
    steps.push({ key: 'done', label: '合并/完成', status: 'error', detail: STATE_LABEL[t.state] })
  else steps.push({ key: 'done', label: '合并/完成', status: 'pending', detail: '—' })

  return steps
}

const STYLE: Record<StepStatus, { ring: string; icon?: LucideIcon; text: string; line: string }> = {
  done: { ring: 'bg-primary text-primary-foreground border-primary', icon: Check, text: 'text-foreground', line: 'bg-primary' },
  current: { ring: 'border-primary bg-primary/10 text-primary ring-4 ring-primary/15', icon: LoaderCircle, text: 'text-primary font-semibold', line: 'bg-border' },
  blocked: { ring: 'border-warning bg-warning/15 text-[color-mix(in_oklch,var(--warning),black_25%)] dark:text-warning ring-4 ring-warning/15', text: 'text-[color-mix(in_oklch,var(--warning),black_25%)] dark:text-warning font-semibold', line: 'bg-border' },
  error: { ring: 'border-danger bg-danger/10 text-danger', icon: X, text: 'text-danger font-semibold', line: 'bg-border' },
  pending: { ring: 'border-border bg-background text-muted-foreground', text: 'text-muted-foreground', line: 'bg-border' },
  skipped: { ring: 'border-dashed border-muted-foreground/40 bg-background text-muted-foreground/60', icon: Minus, text: 'text-muted-foreground/70', line: 'bg-border' },
}

export function FlowStepper({ task, className }: { task: TaskDetail; className?: string }) {
  const steps = computeFlow(task)
  const scroller = useRef<HTMLDivElement>(null)
  const activeIndex = steps.findIndex((s) => s.status === 'current' || s.status === 'blocked' || s.status === 'error')

  // 窄屏下流程条可横向滚动：把当前步骤滚到可见区域中间
  useEffect(() => {
    const box = scroller.current
    if (!box || activeIndex < 0 || box.scrollWidth <= box.clientWidth) return
    const el = box.querySelector<HTMLElement>(`[data-step-index="${activeIndex}"]`)
    if (el) box.scrollLeft = el.offsetLeft - box.clientWidth / 2 + el.clientWidth / 2
  }, [activeIndex])

  return (
    <div ref={scroller} className={cn('relative overflow-x-auto', className)}>
      <ol className="flex min-w-[600px] items-start" aria-label="任务流程">
        {steps.map((step, i) => {
          const s = STYLE[step.status]
          const Icon = s.icon
          const next = steps[i + 1]
          return (
            <Fragment key={step.key}>
              <li data-step-index={i} className="flex w-20 shrink-0 flex-col items-center gap-1.5 text-center" aria-current={step.status === 'current' || step.status === 'blocked' ? 'step' : undefined}>
                <span className={cn('flex size-8 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors', s.ring)}>
                  {Icon ? <Icon className={cn('size-4', step.status === 'current' && 'animate-spin [animation-duration:2.5s]')} /> : i + 1}
                </span>
                <span className={cn('text-xs whitespace-nowrap', s.text)}>{step.label}</span>
                <span className="line-clamp-2 max-w-full px-0.5 text-[11px] leading-tight text-muted-foreground">{step.detail}</span>
              </li>
              {next && (
                <li aria-hidden className="mt-4 flex-1">
                  <div className={cn('h-0.5 rounded-full', step.status === 'done' && (next.status === 'done' || next.status === 'skipped' || next.status === 'current' || next.status === 'blocked' || next.status === 'error') ? 'bg-primary' : 'bg-border')} />
                </li>
              )}
            </Fragment>
          )
        })}
      </ol>
    </div>
  )
}
