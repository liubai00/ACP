import { CircleAlert, CircleCheck, ExternalLink, KeyRound, LoaderCircle, RefreshCw, Unplug, Workflow as WorkflowIcon, X, type LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { EmptyState, ErrorState } from '@/components/empty-state'
import { PageContainer } from '@/components/layout/page-container'
import { ToneBadge } from '@/components/status-badge'
import { ToggleChips } from '@/components/toggle-chips'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateTime, formatDurationMs, formatPercent, formatRelative } from '@/lib/format'
import { EXECUTION_MODE_LABEL, EXECUTION_STATUS_LABEL, EXECUTION_STATUS_TONE } from '@/lib/labels'
import { useWorkflows } from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { WorkflowExecution, WorkflowsResponse } from '@/types/api'

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, '')}${path}`
}

const FAILED = new Set(['error', 'crashed'])
const ACTIVE = new Set(['running', 'waiting', 'new'])
type StatusFilter = 'all' | 'failed' | 'active'

/** 每次执行在“最近运行”小条里的颜色 */
const RUN_COLOR: Record<string, string> = {
  success: 'bg-success',
  error: 'bg-danger',
  crashed: 'bg-danger',
  running: 'bg-info',
  waiting: 'bg-warning',
  new: 'bg-muted-foreground/60',
  canceled: 'bg-muted-foreground/40',
}

const UNAVAILABLE: Record<string, { icon: LucideIcon; title: string }> = {
  no_key: { icon: KeyRound, title: '还没有连接 n8n' },
  unauthorized: { icon: KeyRound, title: 'n8n 的 API Key 失效了' },
  unreachable: { icon: Unplug, title: '连不上 n8n' },
  error: { icon: CircleAlert, title: 'n8n 返回了错误' },
}

function duration(e: WorkflowExecution) {
  return e.stopped_at ? formatDurationMs(Date.parse(e.stopped_at) - Date.parse(e.started_at)) : '—'
}

interface WorkflowStats {
  /** 新的在前 */
  runs: WorkflowExecution[]
  success: number
  failed: number
}

function useStats(data: WorkflowsResponse | undefined) {
  return useMemo(() => {
    const executions = data?.executions ?? []
    const byWorkflow = new Map<string, WorkflowStats>()
    let success = 0
    let failed = 0
    let active = 0
    let lastFailed: WorkflowExecution | null = null
    for (const e of executions) {
      const s = byWorkflow.get(e.workflow_name) ?? { runs: [], success: 0, failed: 0 }
      s.runs.push(e)
      if (e.status === 'success') {
        s.success++
        success++
      } else if (FAILED.has(e.status)) {
        s.failed++
        failed++
        if (!lastFailed || Date.parse(e.started_at) > Date.parse(lastFailed.started_at)) lastFailed = e
      } else if (ACTIVE.has(e.status)) {
        active++
      }
      byWorkflow.set(e.workflow_name, s)
    }
    const finished = success + failed
    return { byWorkflow, success, failed, active, lastFailed, rate: finished ? success / finished : null }
  }, [data])
}

function Stat({
  label,
  value,
  caption,
  icon: Icon,
  tone,
  onClick,
  active,
}: {
  label: string
  value: string
  caption: string
  icon: LucideIcon
  tone?: 'danger' | 'info'
  onClick?: () => void
  active?: boolean
}) {
  const body = (
    <>
      <div className="flex items-center gap-1.5 px-4 text-sm text-muted-foreground">
        <Icon className={cn('size-3.5 shrink-0', tone === 'danger' && 'text-danger', tone === 'info' && 'text-info')} aria-hidden />
        <span className="truncate">{label}</span>
      </div>
      <div className={cn('px-4 text-2xl leading-tight font-semibold tabular-nums', tone === 'danger' && 'text-danger')}>{value}</div>
      <p className="truncate px-4 text-xs text-muted-foreground">{caption}</p>
    </>
  )
  const className = cn(
    'gap-1 bg-gradient-to-t from-primary/5 to-card py-3.5 text-left shadow-xs dark:bg-card',
    tone === 'danger' && 'from-danger/5',
    onClick && 'cursor-pointer transition-shadow hover:ring-primary/40',
    active && 'ring-2 ring-primary',
  )
  if (!onClick) return <Card className={className}>{body}</Card>
  return (
    <Card className={className} role="button" tabIndex={0} aria-pressed={active} onClick={onClick} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick())}>
      {body}
    </Card>
  )
}

/** 最近 12 次执行的状态小条，旧的在左、新的在右 */
function RunStrip({ runs }: { runs: WorkflowExecution[] }) {
  const shown = runs.slice(0, 12).reverse()
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" role="img" aria-label={`最近 ${shown.length} 次执行：${shown.map((e) => EXECUTION_STATUS_LABEL[e.status] ?? e.status).join('、')}`}>
      {shown.map((e) => (
        <span
          key={e.id}
          className={cn('h-3.5 w-1.5 rounded-sm', RUN_COLOR[e.status] ?? 'bg-muted-foreground/40')}
          title={`#${e.id} ${EXECUTION_STATUS_LABEL[e.status] ?? e.status} · ${formatRelative(e.started_at)}`}
        />
      ))}
    </span>
  )
}

export default function WorkflowsPage() {
  const { data, error, isPending, isFetching, refetch } = useWorkflows()
  const base = data?.n8n_url ?? null
  const stats = useStats(data)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [workflow, setWorkflow] = useState<string | null>(null)

  const executions = useMemo(
    () =>
      (data?.executions ?? []).filter(
        (e) => (!workflow || e.workflow_name === workflow) && (status === 'all' || (status === 'failed' ? FAILED.has(e.status) : ACTIVE.has(e.status))),
      ),
    [data, status, workflow],
  )
  const total = data?.executions.length ?? 0
  const filtered = status !== 'all' || workflow !== null

  const refresh = (
    <Button variant="outline" onClick={() => void refetch()}>
      <RefreshCw className={cn(isFetching && 'animate-spin')} />
      刷新
    </Button>
  )

  const unavailable = data && !data.enabled ? (UNAVAILABLE[data.reason ?? 'no_key'] ?? UNAVAILABLE.error) : null

  return (
    <PageContainer
      title="自动化流程"
      description="n8n 里的三条工作流：飞书事件进单、GitLab 回执、通知出口。每次执行的节点输入输出请到 n8n 中查看。"
      actions={
        <>
          {refresh}
          {base && (
            <Button nativeButton={false} render={<a href={base} target="_blank" rel="noreferrer" />}>
              在 n8n 中打开
              <ExternalLink />
            </Button>
          )}
        </>
      }
    >
      {isPending ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-5">
            <Skeleton className="h-80 rounded-xl lg:col-span-2" />
            <Skeleton className="h-80 rounded-xl lg:col-span-3" />
          </div>
        </div>
      ) : error || !data ? (
        <Card>
          <ErrorState error={error} onRetry={() => void refetch()} />
        </Card>
      ) : unavailable ? (
        <Card>
          <EmptyState
            icon={unavailable.icon}
            title={unavailable.title}
            description={
              data.reason && data.reason !== 'no_key' && data.message ? (
                <>{data.message}。通知投递不受影响。</>
              ) : (
                <>
                  coordinator 没有配置 n8n 的 API Key，读不到工作流和执行记录。管理员在服务器环境变量里设置 <code className="rounded bg-muted px-1 font-mono text-xs">N8N_API_KEY</code>（以及{' '}
                  <code className="rounded bg-muted px-1 font-mono text-xs">N8N_URL</code>）并重启 coordinator 后，这里会显示工作流列表和最近执行。通知投递不受影响。
                </>
              )
            }
            action={
              base ? (
                <Button variant="outline" nativeButton={false} render={<a href={base} target="_blank" rel="noreferrer" />}>
                  直接打开 n8n
                  <ExternalLink />
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="工作流"
              icon={WorkflowIcon}
              value={`${data.workflows.filter((w) => w.active).length} / ${data.workflows.length}`}
              caption={data.workflows.every((w) => w.active) ? '全部已启用' : `未启用：${data.workflows.filter((w) => !w.active).map((w) => w.name).join('、')}`}
            />
            <Stat label="成功率" icon={CircleCheck} value={formatPercent(stats.rate)} caption={`最近 ${total} 次执行，成功 ${stats.success} 次`} />
            <Stat
              label="失败"
              icon={CircleAlert}
              value={String(stats.failed)}
              caption={stats.lastFailed ? `最近一次 ${formatRelative(stats.lastFailed.started_at)} · 点击只看失败` : '最近没有失败'}
              tone={stats.failed > 0 ? 'danger' : undefined}
              onClick={stats.failed > 0 ? () => setStatus(status === 'failed' ? 'all' : 'failed') : undefined}
              active={status === 'failed'}
            />
            <Stat label="运行中" icon={LoaderCircle} value={String(stats.active)} caption="含等待中与排队中" tone={stats.active > 0 ? 'info' : undefined} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <Card className="self-start lg:col-span-2">
              <CardHeader>
                <CardTitle>工作流</CardTitle>
                <CardDescription>点一条工作流，只看它的执行记录</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                {data.workflows.length === 0 ? (
                  <EmptyState icon={WorkflowIcon} title="n8n 里还没有工作流" description="按部署手册导入 n8n/ 目录下的工作流文件。" />
                ) : (
                  <ul className="divide-y">
                    {data.workflows.map((w) => {
                      const s = stats.byWorkflow.get(w.name)
                      const selected = workflow === w.name
                      const finished = s ? s.success + s.failed : 0
                      return (
                        <li key={w.id} className={cn('flex items-start gap-1 pr-2 transition-colors', selected ? 'bg-primary/10' : 'hover:bg-muted/50')}>
                          <button type="button" aria-pressed={selected} onClick={() => setWorkflow(selected ? null : w.name)} className="flex min-w-0 flex-1 items-start gap-3 py-3 pl-4 text-left">
                            <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg', w.active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')}>
                              <WorkflowIcon className="size-4" />
                            </span>
                            <span className="min-w-0 flex-1 space-y-1.5">
                              <span className="flex items-start gap-2">
                                <span className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug font-medium">{w.name}</span>
                                <ToneBadge tone={w.active ? 'success' : 'muted'}>{w.active ? '已启用' : '未启用'}</ToneBadge>
                              </span>
                              {s ? (
                                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                                  <RunStrip runs={s.runs} />
                                  <span className="whitespace-nowrap">
                                    {finished > 0 && (
                                      <>
                                        成功率 <span className={cn('font-medium', s.failed > 0 ? 'text-danger' : 'text-foreground')}>{formatPercent(s.success / finished)}</span> ·{' '}
                                      </>
                                    )}
                                    最近 {formatRelative(s.runs[0].started_at)}
                                  </span>
                                </span>
                              ) : (
                                <span className="block text-xs text-muted-foreground">最近没有执行 · 更新于 {formatRelative(w.updated_at)}</span>
                              )}
                            </span>
                          </button>
                          {base && (
                            <Button variant="ghost" size="icon-sm" className="mt-2.5 shrink-0" aria-label={`在 n8n 中打开 ${w.name}`} nativeButton={false} render={<a href={joinUrl(base, `/workflow/${encodeURIComponent(w.id)}`)} target="_blank" rel="noreferrer" />}>
                              <ExternalLink />
                            </Button>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card className="lg:col-span-3">
              <CardHeader>
                <CardTitle>最近执行</CardTitle>
                <CardDescription>
                  最新 {total} 次{filtered ? `，筛出 ${executions.length} 次` : ''}
                </CardDescription>
                {base && (
                  <CardAction>
                    <Button variant="ghost" size="sm" nativeButton={false} render={<a href={joinUrl(base, '/home/executions')} target="_blank" rel="noreferrer" />}>
                      全部执行
                      <ExternalLink />
                    </Button>
                  </CardAction>
                )}
              </CardHeader>
              <div className="flex flex-wrap items-center gap-2 px-4">
                <ToggleChips
                  value={status}
                  onChange={setStatus}
                  options={[
                    { value: 'all', label: `全部 ${total}` },
                    { value: 'failed', label: `失败 ${stats.failed}` },
                    { value: 'active', label: `运行中 ${stats.active}` },
                  ]}
                />
                {workflow && (
                  <Button variant="secondary" size="xs" className="max-w-full" onClick={() => setWorkflow(null)} aria-label={`取消只看 ${workflow}`}>
                    <span className="truncate">{workflow}</span>
                    <X />
                  </Button>
                )}
              </div>
              <CardContent className="px-0">
                {executions.length === 0 ? (
                  <EmptyState title={total === 0 ? '还没有执行记录' : '没有符合条件的执行'} description={total === 0 ? undefined : '换一个筛选条件，或点上方“全部”。'} />
                ) : (
                  <div className="max-h-[620px] overflow-auto">
                    {/* 手机上用两行一条的列表，表格在窄屏会被截断 */}
                    <ul className="divide-y sm:hidden">
                      {executions.map((e) => (
                        <li key={e.id} className={cn('px-4 py-2.5', FAILED.has(e.status) && 'bg-danger/5')}>
                          <div className="flex items-center gap-2">
                            <ToneBadge tone={EXECUTION_STATUS_TONE[e.status] ?? 'neutral'}>{EXECUTION_STATUS_LABEL[e.status] ?? e.status}</ToneBadge>
                            {base ? (
                              <a href={joinUrl(base, `/execution/${encodeURIComponent(e.id)}`)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm">
                                {e.workflow_name}
                              </a>
                            ) : (
                              <span className="min-w-0 flex-1 truncate text-sm">{e.workflow_name}</span>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            <span className="font-mono">#{e.id}</span> · {EXECUTION_MODE_LABEL[e.mode] ?? e.mode} · {formatRelative(e.started_at)} · {duration(e)}
                          </p>
                        </li>
                      ))}
                    </ul>
                    <div className="hidden sm:block">
                      <Table>
                        <TableHeader className="sticky top-0 z-10 bg-card">
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="w-24 pl-4">状态</TableHead>
                            <TableHead>工作流</TableHead>
                            <TableHead className="hidden md:table-cell">触发</TableHead>
                            <TableHead>开始</TableHead>
                            <TableHead className="pr-4 text-right">耗时</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {executions.map((e) => (
                            <TableRow key={e.id} className={cn(FAILED.has(e.status) && 'bg-danger/5 hover:bg-danger/10')}>
                              <TableCell className="pl-4">
                                <ToneBadge tone={EXECUTION_STATUS_TONE[e.status] ?? 'neutral'}>{EXECUTION_STATUS_LABEL[e.status] ?? e.status}</ToneBadge>
                              </TableCell>
                              <TableCell className="w-full max-w-0">
                                <div className="flex items-baseline gap-2">
                                  {base ? (
                                    <a href={joinUrl(base, `/execution/${encodeURIComponent(e.id)}`)} target="_blank" rel="noreferrer" className="truncate text-sm hover:text-primary hover:underline">
                                      {e.workflow_name}
                                    </a>
                                  ) : (
                                    <span className="truncate text-sm">{e.workflow_name}</span>
                                  )}
                                  <span className="shrink-0 font-mono text-xs text-muted-foreground">#{e.id}</span>
                                </div>
                              </TableCell>
                              <TableCell className="hidden text-sm whitespace-nowrap text-muted-foreground md:table-cell">{EXECUTION_MODE_LABEL[e.mode] ?? e.mode}</TableCell>
                              <TableCell className="text-sm whitespace-nowrap text-muted-foreground" title={formatDateTime(e.started_at, true)}>
                                {formatRelative(e.started_at)}
                              </TableCell>
                              <TableCell className="pr-4 text-right text-sm whitespace-nowrap text-muted-foreground tabular-nums">{duration(e)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </PageContainer>
  )
}
