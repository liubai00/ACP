import { Bot, Clock, GitPullRequest, ListTodo, LoaderCircle, Plus, TrendingDown, TrendingUp, Users, CircleCheck, Sparkles, type LucideIcon } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Label, Pie, PieChart, XAxis, YAxis } from 'recharts'
import { EmptyState, ErrorState } from '@/components/empty-state'
import { PageContainer } from '@/components/layout/page-container'
import { MemberAvatar } from '@/components/member-avatar'
import { PageSkeleton } from '@/components/page-skeleton'
import { DemoBadge, StateBadge } from '@/components/status-badge'
import { useNewTaskDialog } from '@/components/tasks/new-task-dialog'
import { ActorIcon } from '@/components/tasks/timeline'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useAuth } from '@/lib/auth'
import { formatAge, formatHours, formatNumber, formatPercent, formatRelative } from '@/lib/format'
import { SOURCE_COLOR, SOURCE_LABEL, STATE_COLOR, STATE_LABEL, TASK_STATES } from '@/lib/labels'
import { useOverview } from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { Overview, TaskSummary } from '@/types/api'

export default function OverviewPage() {
  const { member } = useAuth()
  const { data, isPending, error, refetch } = useOverview(14)
  const newTask = useNewTaskDialog()

  const hour = new Date().getHours()
  const greeting = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'

  if (isPending) return <PageSkeleton />

  return (
    <PageContainer
      title={`${greeting}，${member?.name ?? ''}`}
      description="团队实际任务的进度、趋势和负载。示例任务可在「查找任务」单独查看。"
      actions={
        <>
          <Button variant="outline" nativeButton={false} render={<Link to="/board" />}>
            任务进展
          </Button>
          <Button onClick={() => newTask.open()}>
            <Plus />
            新建任务
          </Button>
        </>
      }
    >
      {error || !data ? (
        <Card>
          <ErrorState error={error} onRetry={() => void refetch()} />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <KpiGrid data={data} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-7">
            {/* 先看要处理的事，再看趋势和分布 */}
            <AttentionCard tasks={data.attention} className="lg:col-span-4" />
            <StateDonutCard data={data} className="lg:col-span-3" />
            <TrendCard data={data} className="lg:col-span-4" />
            <SourceBarCard data={data} className="lg:col-span-3" />
            <WorkloadCard data={data} className="lg:col-span-4" />
            <RecentCard items={data.recent} className="lg:col-span-3" />
          </div>
        </div>
      )}
    </PageContainer>
  )
}

// ---------- KPI ----------

function sumLast(trend: Overview['trend'], key: 'created' | 'completed', from: number, to: number) {
  return trend.slice(Math.max(0, trend.length - to), trend.length - from).reduce((a, b) => a + b[key], 0)
}

function changeRatio(trend: Overview['trend'], key: 'created' | 'completed') {
  if (trend.length < 14) return null
  const recent = sumLast(trend, key, 0, 7)
  const before = sumLast(trend, key, 7, 14)
  if (before === 0) return null
  return (recent - before) / before
}

function Kpi({
  label,
  value,
  icon: Icon,
  footer,
  hint,
  change,
}: {
  label: string
  value: string
  icon: LucideIcon
  footer: string
  hint?: string
  change?: number | null
}) {
  return (
    <Card className="@container/card gap-1 bg-gradient-to-t from-primary/5 to-card py-3.5 shadow-xs dark:bg-card">
      <div className="flex items-center gap-1.5 px-4 text-sm text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </div>
      <div className="px-4 text-2xl leading-tight font-semibold tabular-nums @[250px]/card:text-3xl">{value}</div>
      <p className="truncate px-4 text-xs text-muted-foreground">
        {change !== undefined && change !== null && (
          <span className={cn('mr-1.5 inline-flex items-center gap-0.5 align-bottom font-medium', change >= 0 ? 'text-success' : 'text-danger')}>
            {change >= 0 ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
            {change >= 0 ? '+' : ''}
            {formatPercent(change)}
          </span>
        )}
        <span className="text-foreground/80">{footer}</span>
        {hint && <span className="hidden @[230px]/card:inline"> · {hint}</span>}
      </p>
    </Card>
  )
}

function KpiGrid({ data }: { data: Overview }) {
  const s = data.counts.by_state
  const k = data.kpis
  // 前 7 天没有数据时算不出变化，这时不写“较前 7 天”
  const createdChange = changeRatio(data.trend, 'created')
  const completedChange = changeRatio(data.trend, 'completed')
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <Kpi label="总任务" icon={ListTodo} value={formatNumber(data.counts.total)} footer={`未结束 ${data.counts.open} 个`} hint={`已完成 ${s.completed} · 失败 ${s.failed}`} />
      <Kpi label="进行中" icon={LoaderCircle} value={formatNumber(s.working)} footer={`待补充 ${s['input-required']} · 待审批 ${s['auth-required']}`} hint={`待认领 ${s.submitted}`} />
      <Kpi label="7 天新建" icon={Plus} value={formatNumber(k.created_7d)} footer={createdChange === null ? '所有来源合计' : '较前 7 天'} hint={createdChange === null ? undefined : '所有来源合计'} change={createdChange} />
      <Kpi label="7 天完成" icon={CircleCheck} value={formatNumber(k.completed_7d)} footer={completedChange === null ? 'MR 合并或验收通过' : '较前 7 天'} hint={completedChange === null ? undefined : 'MR 合并或验收通过'} change={completedChange} />
      <Kpi label="平均交付时长" icon={Clock} value={formatHours(k.avg_lead_time_hours)} footer="从建单到完成" hint="近 7 天完成的任务" />
      <Kpi label="CI 通过率" icon={GitPullRequest} value={formatPercent(k.ci_pass_rate)} footer="已结束的流水线" hint="失败会触发 CI 分诊" />
      <Kpi label="在线 Agent" icon={Bot} value={formatNumber(k.agents_online)} footer="在线与忙碌合计" hint="30 分钟无心跳视为离线" />
      <Kpi label="活跃成员" icon={Users} value={formatNumber(k.members_active)} footer="近 7 天登录过" hint="含飞书与任务榜" />
    </div>
  )
}

// ---------- 趋势 ----------

const trendConfig = {
  created: { label: '新建', color: 'var(--chart-1)' },
  completed: { label: '完成', color: 'var(--success)' },
} satisfies ChartConfig

function TrendCard({ data, className }: { data: Overview; className?: string }) {
  const chartData = data.trend.map((d) => ({ ...d, label: d.date.slice(5).replace('-', '/') }))
  const created = data.trend.reduce((a, b) => a + b.created, 0)
  const completed = data.trend.reduce((a, b) => a + b.completed, 0)
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>近 {data.trend.length} 天新建与完成</CardTitle>
        <CardDescription>
          共新建 {created} 个，完成 {completed} 个
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={trendConfig} className="aspect-auto h-[260px] w-full">
          <AreaChart data={chartData} margin={{ left: 0, right: 8, top: 8 }}>
            <defs>
              {(['created', 'completed'] as const).map((key) => (
                <linearGradient key={key} id={`fill-${key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={`var(--color-${key})`} stopOpacity={0.35} />
                  <stop offset="95%" stopColor={`var(--color-${key})`} stopOpacity={0.05} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
            <YAxis tickLine={false} axisLine={false} width={28} allowDecimals={false} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
            <Area dataKey="created" type="monotone" fill="url(#fill-created)" stroke="var(--color-created)" strokeWidth={2} />
            <Area dataKey="completed" type="monotone" fill="url(#fill-completed)" stroke="var(--color-completed)" strokeWidth={2} />
            <ChartLegend content={<ChartLegendContent />} />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

// ---------- 状态分布 ----------

function StateDonutCard({ data, className }: { data: Overview; className?: string }) {
  const navigate = useNavigate()
  const rows = TASK_STATES.map((s) => ({ state: s, label: STATE_LABEL[s], count: data.counts.by_state[s], fill: STATE_COLOR[s] })).filter((r) => r.count > 0)
  const config = Object.fromEntries(TASK_STATES.map((s) => [s, { label: STATE_LABEL[s], color: STATE_COLOR[s] }])) satisfies ChartConfig
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader>
        <CardTitle>任务状态分布</CardTitle>
        <CardDescription>点击图例查看对应任务</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col items-center justify-center gap-5 sm:flex-row lg:flex-col">
        <ChartContainer config={config} className="aspect-square h-[200px] shrink-0">
          <PieChart>
            <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel nameKey="state" />} />
            <Pie data={rows} dataKey="count" nameKey="state" innerRadius={58} outerRadius={88} strokeWidth={2} paddingAngle={2} cornerRadius={4}>
              {rows.map((r) => (
                <Cell key={r.state} fill={r.fill} stroke="var(--card)" />
              ))}
              <Label
                content={({ viewBox }) => {
                  if (!viewBox || !('cx' in viewBox)) return null
                  return (
                    <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                      <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-2xl font-bold">
                        {data.counts.total}
                      </tspan>
                      <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) + 22} className="fill-muted-foreground text-xs">
                        全部任务
                      </tspan>
                    </text>
                  )
                }}
              />
            </Pie>
          </PieChart>
        </ChartContainer>
        <ul className="grid w-full max-w-sm grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {TASK_STATES.map((s) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => navigate(`/tasks?state=${s}`)}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted"
              >
                <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: STATE_COLOR[s] }} />
                <span className="flex-1 truncate text-muted-foreground">{STATE_LABEL[s]}</span>
                <span className="font-mono tabular-nums">{data.counts.by_state[s]}</span>
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

// ---------- 负责人负载 ----------

const WORKLOAD_PARTS = [
  { key: 'working', label: '进行中', className: 'bg-primary' },
  { key: 'open', label: '其他未结束', className: 'bg-warning' },
  { key: 'completed', label: '已完成', className: 'bg-success/70' },
] as const

function WorkloadCard({ data, className }: { data: Overview; className?: string }) {
  const rows = data.by_assignee.slice(0, 10)
  const max = Math.max(1, ...rows.map((r) => r.working + r.open + r.completed))
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>负责人负载</CardTitle>
        <CardDescription>每人手上的任务（前 10 位），点一行看这个人的任务</CardDescription>
        <CardAction className="hidden items-center gap-3 text-xs text-muted-foreground sm:flex">
          {WORKLOAD_PARTS.map((p) => (
            <span key={p.key} className="inline-flex items-center gap-1.5">
              <span className={cn('size-2 rounded-sm', p.className)} />
              {p.label}
            </span>
          ))}
        </CardAction>
      </CardHeader>
      <CardContent className="px-2">
        {rows.length === 0 ? (
          <EmptyState title="还没有人认领任务" />
        ) : (
          <ul>
            {rows.map((r) => {
              const total = r.working + r.open + r.completed
              return (
                <li key={r.member.id}>
                  <Link
                    to={`/tasks?assignee=${encodeURIComponent(r.member.id)}`}
                    className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted"
                    title={`${r.member.name}：进行中 ${r.working}，其他未结束 ${r.open}，已完成 ${r.completed}`}
                  >
                    <MemberAvatar member={r.member} size="sm" />
                    <span className="w-16 shrink-0 truncate text-sm sm:w-24">{r.member.name}</span>
                    <span className="flex h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                      <span className="flex h-full gap-px" style={{ width: `${(total / max) * 100}%` }}>
                        {WORKLOAD_PARTS.map((p) =>
                          r[p.key] > 0 ? <span key={p.key} className={cn('h-full', p.className)} style={{ flexGrow: r[p.key], flexBasis: 0 }} /> : null,
                        )}
                      </span>
                    </span>
                    <span className="w-28 shrink-0 text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                      <span className="text-sm font-medium text-foreground">{r.working + r.open}</span> 未结束 · {r.completed} 完成
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ---------- 来源 ----------

function SourceBarCard({ data, className }: { data: Overview; className?: string }) {
  const rows = data.by_source.map((r) => ({ source: r.source, label: SOURCE_LABEL[r.source] ?? r.source, count: r.count, fill: SOURCE_COLOR[r.source] ?? 'var(--chart-2)' }))
  const config = { count: { label: '任务数' } } satisfies ChartConfig
  const total = rows.reduce((a, b) => a + b.count, 0)
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>任务来源</CardTitle>
        <CardDescription>
          飞书 {formatPercent(total ? (rows.find((r) => r.source === 'feishu')?.count ?? 0) / total : null)} 的任务来自群聊
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
          <BarChart data={rows} margin={{ top: 16, left: 0, right: 8 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis tickLine={false} axisLine={false} width={28} allowDecimals={false} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel={false} />} />
            <Bar dataKey="count" radius={6} barSize={36}>
              {rows.map((r) => (
                <Cell key={r.source} fill={r.fill} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

// ---------- 需要关注 ----------

function attentionReason(t: TaskSummary) {
  if (t.state === 'input-required') return { text: '等人补充信息', tone: 'text-warning' }
  if (t.state === 'auth-required') return { text: '等待审批', tone: 'text-warning' }
  if (t.state === 'submitted') return { text: t.priority === 'urgent' ? '紧急任务无人认领' : '无人认领', tone: 'text-danger' }
  return { text: '长时间无进展', tone: 'text-danger' }
}

function AttentionCard({ tasks, className }: { tasks: TaskSummary[]; className?: string }) {
  const navigate = useNavigate()
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>需要关注</CardTitle>
        <CardDescription>待补充、待审批和长时间没有进展的任务{tasks.length > 6 ? `，共 ${tasks.length} 个，先列 6 个` : ''}</CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/tasks?state=input-required,auth-required" />}>
            查看全部
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0">
        {tasks.length === 0 ? (
          <EmptyState icon={Sparkles} title="一切顺利" description="目前没有卡住的任务。" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-full pl-4">任务</TableHead>
                <TableHead className="hidden sm:table-cell">状态</TableHead>
                <TableHead className="hidden md:table-cell">负责人</TableHead>
                <TableHead className="pr-4 text-right">停留</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.slice(0, 6).map((t) => {
                const reason = attentionReason(t)
                return (
                  <TableRow key={t.id} className="cursor-pointer" onClick={() => navigate(`/tasks/${t.id}`)}>
                    <TableCell className="w-full max-w-0 pl-4">
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">{t.key}</span>
                        <span className="truncate font-medium">{t.title}</span>
                        {t.is_demo && <DemoBadge />}
                      </div>
                      <div className={cn('text-xs', reason.tone)}>{reason.text}</div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <StateBadge state={t.state} />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <div className="flex items-center gap-2">
                        <MemberAvatar member={t.assignee} size="sm" />
                        <span className={cn('text-sm', !t.assignee && 'text-muted-foreground')}>{t.assignee?.name ?? '未分配'}</span>
                      </div>
                    </TableCell>
                    <TableCell className="pr-4 text-right text-sm whitespace-nowrap text-muted-foreground tabular-nums">{formatAge(t.state_changed_at)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

// ---------- 最近动态 ----------

function RecentCard({ items, className }: { items: Overview['recent']; className?: string }) {
  const list = useMemo(() => items.slice(0, 20), [items])
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader>
        <CardTitle>最近动态</CardTitle>
        <CardDescription>所有任务的最新 {list.length} 条事件与消息</CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 px-0">
        {list.length === 0 ? (
          <EmptyState title="暂无动态" />
        ) : (
          <ScrollArea className="h-[360px] px-4">
            <ol className="space-y-4">
              {list.map((item) => (
                <li key={`${item.task_id}-${item.id}`} className="flex gap-3">
                  <ActorIcon actor={item.actor} />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="text-sm leading-snug">
                      <span className="font-medium">{item.actor.name}</span>
                      <span className="text-muted-foreground"> · {formatRelative(item.at)}</span>
                    </p>
                    <p className={cn('line-clamp-2 text-sm', item.kind === 'event' && 'text-muted-foreground')}>{item.text}</p>
                    <Link to={`/tasks/${item.task_id}`} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                      <span className="font-mono">{item.task_key}</span>
                      <span className="truncate">{item.task_title}</span>
                    </Link>
                  </div>
                </li>
              ))}
            </ol>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}
