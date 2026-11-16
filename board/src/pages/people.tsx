import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table'
import { Bot, LoaderCircle, Pencil, Search } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { DataTable } from '@/components/data-table/data-table'
import { DataTablePagination } from '@/components/data-table/data-table-pagination'
import { ErrorState } from '@/components/empty-state'
import { PageContainer } from '@/components/layout/page-container'
import { MemberAvatar, MemberChip } from '@/components/member-avatar'
import { ToneBadge } from '@/components/status-badge'
import { ToggleChips } from '@/components/toggle-chips'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAuth } from '@/lib/auth'
import { formatDateTime, formatRelative } from '@/lib/format'
import { AGENT_KIND_LABEL, AGENT_STATUS_LABEL, ASSIGNABLE_ROLES, ROLE_LABEL } from '@/lib/labels'
import { useAgents, useMembers, useUpdateMember } from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { Agent, AgentStatus, Member } from '@/types/api'

// ---------- 成员 ----------

function RoleBadges({ roles }: { roles: string[] }) {
  const shown = roles.filter((r) => r !== 'member')
  if (shown.length === 0) return <span className="text-sm text-muted-foreground">成员</span>
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((r) => (
        <ToneBadge key={r} tone={r === 'admin' ? 'primary' : r === 'reviewer' ? 'warning' : 'neutral'}>
          {ROLE_LABEL[r] ?? r}
        </ToneBadge>
      ))}
    </div>
  )
}

function MemberSheet({ member, onClose }: { member: Member; onClose: () => void }) {
  const { member: me } = useAuth()
  const [roles, setRoles] = useState<string[]>(member.roles)
  const [team, setTeam] = useState(member.team ?? '')
  const [gitlab, setGitlab] = useState(member.gitlab_username ?? '')
  const [active, setActive] = useState(member.is_active)
  const mutation = useUpdateMember()
  const isSelf = me?.id === member.id

  const toggleRole = (role: string, on: boolean) => {
    setRoles((prev) => (on ? [...new Set([...prev, role])] : prev.filter((r) => r !== role)))
  }

  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <form
          className="flex h-full flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate(
              {
                id: member.id,
                body: {
                  roles: [...new Set(['member', ...roles])],
                  team: team.trim() || null,
                  gitlab_username: gitlab.trim() || null,
                  is_active: active,
                },
              },
              { onSuccess: onClose },
            )
          }}
        >
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <MemberAvatar member={member} />
              编辑成员
            </SheetTitle>
            <SheetDescription>
              {member.name}
              {member.feishu_open_id ? ` · 飞书 ${member.feishu_open_id.slice(0, 10)}…` : ''}
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-5 px-4">
            <fieldset className="grid gap-3">
              <legend className="mb-2 text-sm font-medium">角色</legend>
              {ASSIGNABLE_ROLES.map((role) => {
                const locked = role === 'member' || (isSelf && role === 'admin')
                return (
                  <div key={role} className="flex items-center gap-2">
                    <Checkbox
                      id={`role-${role}`}
                      checked={role === 'member' || roles.includes(role)}
                      disabled={locked}
                      onCheckedChange={(v) => toggleRole(role, v === true)}
                    />
                    <Label htmlFor={`role-${role}`} className="font-normal">
                      {ROLE_LABEL[role]}
                      <span className="text-xs text-muted-foreground">
                        {role === 'member' && '（所有登录者都有）'}
                        {role === 'developer' && '（可认领开发任务）'}
                        {role === 'reviewer' && '（可审批合并与高风险操作）'}
                        {role === 'admin' && (isSelf ? '（不能移除自己的管理员）' : '（管理成员与设置）')}
                        {role === 'agent_caller' && '（可发起 Agent 求助）'}
                      </span>
                    </Label>
                  </div>
                )
              })}
            </fieldset>
            <div className="grid gap-2">
              <Label htmlFor="m-team">团队</Label>
              <Input id="m-team" value={team} onChange={(e) => setTeam(e.target.value)} placeholder="如：交易组" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="m-gitlab">GitLab 用户名</Label>
              <Input id="m-gitlab" value={gitlab} onChange={(e) => setGitlab(e.target.value)} placeholder="用于匹配 MR 作者" className="font-mono" />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div>
                <Label htmlFor="m-active">启用账号</Label>
                <p className="text-xs text-muted-foreground">停用后无法登录，也不会被派工。</p>
              </div>
              <Switch id="m-active" checked={active} onCheckedChange={setActive} disabled={isSelf} />
            </div>
          </div>
          <SheetFooter className="mt-auto">
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <LoaderCircle className="animate-spin" />}
              保存
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function MembersTab() {
  const { isAdmin } = useAuth()
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [editing, setEditing] = useState<Member | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const members = useMembers({ q: q || undefined, page, page_size: pageSize })

  const columns = useMemo<ColumnDef<Member>[]>(
    () => [
      {
        id: 'name',
        header: '成员',
        cell: ({ row }) => (
          <div className="flex min-w-[140px] items-center gap-2.5">
            <MemberAvatar member={row.original} />
            <div className="flex min-w-0 flex-col">
              <span className={cn('font-medium', !row.original.is_active && 'text-muted-foreground line-through')}>{row.original.name}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">{row.original.gitlab_username ? `@${row.original.gitlab_username}` : '未绑定 GitLab'}</span>
            </div>
          </div>
        ),
        meta: { label: '成员' },
      },
      { id: 'team', header: '团队', cell: ({ row }) => <span className="text-sm whitespace-nowrap">{row.original.team ?? '—'}</span>, meta: { label: '团队' } },
      { id: 'roles', header: '角色', cell: ({ row }) => <RoleBadges roles={row.original.roles} />, meta: { label: '角色' } },
      {
        id: 'open',
        header: () => <span className="block text-right">待处理</span>,
        cell: ({ row }) => <span className="block text-right tabular-nums">{row.original.stats.open}</span>,
        meta: { label: '待处理' },
      },
      {
        id: 'working',
        header: () => <span className="block text-right">进行中</span>,
        cell: ({ row }) => <span className="block text-right font-medium tabular-nums">{row.original.stats.working}</span>,
        meta: { label: '进行中' },
      },
      {
        id: 'completed',
        header: () => <span className="block text-right whitespace-nowrap">30 天完成</span>,
        cell: ({ row }) => <span className="block text-right tabular-nums">{row.original.stats.completed_30d}</span>,
        meta: { label: '30 天完成' },
      },
      {
        id: 'last_login',
        header: '最近登录',
        cell: ({ row }) => (
          <span className="text-sm whitespace-nowrap text-muted-foreground" title={formatDateTime(row.original.last_login_at)}>
            {row.original.last_login_at ? formatRelative(row.original.last_login_at) : '从未登录'}
          </span>
        ),
        meta: { label: '最近登录' },
      },
      {
        id: 'status',
        header: '状态',
        cell: ({ row }) => <ToneBadge tone={row.original.is_active ? 'success' : 'muted'}>{row.original.is_active ? '启用' : '停用'}</ToneBadge>,
        meta: { label: '状态' },
      },
      ...(isAdmin
        ? [
            {
              id: 'actions',
              header: () => <span className="sr-only">操作</span>,
              cell: ({ row }) => (
                <Button variant="ghost" size="icon-sm" aria-label={`编辑 ${row.original.name}`} onClick={() => setEditing(row.original)}>
                  <Pencil />
                </Button>
              ),
              meta: { className: 'w-10' },
            } satisfies ColumnDef<Member>,
          ]
        : []),
    ],
    [isAdmin],
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table v8 的已知用法
  const table = useReactTable({
    data: members.data?.items ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    getRowId: (r) => r.id,
  })

  return (
    <>
      {members.error && !members.data ? (
        <ErrorState error={members.error} onRetry={() => void members.refetch()} className="rounded-lg border" />
      ) : (
        <DataTable
          table={table}
          loading={members.isPending || members.isFetching}
          emptyText={q ? '没有匹配的成员' : '还没有成员'}
          onRowClick={isAdmin ? (m) => setEditing(m) : undefined}
          toolbar={
            <div className="flex flex-wrap items-center justify-between gap-2 p-1">
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={draft}
                  onChange={(e) => {
                    const v = e.target.value
                    setDraft(v)
                    clearTimeout(timer.current)
                    timer.current = setTimeout(() => {
                      setQ(v.trim())
                      setPage(1)
                    }, 300)
                  }}
                  placeholder="搜索姓名、团队、GitLab 用户名…"
                  className="pl-8"
                  aria-label="搜索成员"
                />
              </div>
              {isAdmin && <p className="text-xs text-muted-foreground">点击一行编辑角色、团队和 GitLab 账号</p>}
            </div>
          }
          footer={
            <DataTablePagination
              page={page}
              pageSize={pageSize}
              total={members.data?.total ?? 0}
              onPageChange={setPage}
              onPageSizeChange={(s) => {
                setPageSize(s)
                setPage(1)
              }}
            />
          }
        />
      )}
      {editing && <MemberSheet key={editing.id} member={editing} onClose={() => setEditing(null)} />}
    </>
  )
}

// ---------- Agent ----------

const STATUS_DOT: Record<AgentStatus, string> = {
  online: 'bg-success',
  busy: 'bg-warning',
  offline: 'bg-muted-foreground/40',
}

function StatusDot({ status }: { status: AgentStatus }) {
  return (
    <span className="relative flex size-2.5 shrink-0" aria-label={AGENT_STATUS_LABEL[status]}>
      {status !== 'offline' && <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-50', STATUS_DOT[status])} />}
      <span className={cn('relative inline-flex size-2.5 rounded-full', STATUS_DOT[status])} />
    </span>
  )
}

const agentColumns: ColumnDef<Agent>[] = [
  {
    id: 'name',
    header: 'Agent',
    cell: ({ row }) => {
      const a = row.original
      return (
        <div className="flex min-w-[170px] items-center gap-2.5">
          <StatusDot status={a.status} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-mono text-sm font-medium">{a.name}</span>
            <span className="text-xs text-muted-foreground">
              {AGENT_STATUS_LABEL[a.status]}
              {a.host ? ` · ${a.host}` : ''}
            </span>
          </div>
        </div>
      )
    },
    meta: { label: 'Agent' },
  },
  {
    id: 'kind',
    header: '类型',
    cell: ({ row }) => (
      <div className="flex flex-col whitespace-nowrap">
        <span className="text-sm">{AGENT_KIND_LABEL[row.original.kind] ?? row.original.kind}</span>
        <span className="font-mono text-xs text-muted-foreground">{row.original.version ? `v${row.original.version}` : '—'}</span>
      </div>
    ),
    meta: { label: '类型' },
  },
  { id: 'owner', header: '所属成员', cell: ({ row }) => <MemberChip member={row.original.member} />, meta: { label: '所属成员' } },
  {
    id: 'skills',
    header: '技能',
    cell: ({ row }) => (
      <div className="flex max-w-[200px] min-w-[120px] flex-wrap gap-1">
        {row.original.skills.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          row.original.skills.map((s) => (
            <span key={s} className="rounded bg-secondary px-1.5 text-xs leading-5 text-secondary-foreground">
              {s}
            </span>
          ))
        )}
      </div>
    ),
    meta: { label: '技能' },
  },
  {
    id: 'repos',
    header: '仓库',
    cell: ({ row }) => (
      <div className="flex max-w-[220px] flex-col gap-0.5">
        {row.original.repos.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          row.original.repos.map((r) => (
            <span key={r} className="truncate font-mono text-xs">
              {r}
            </span>
          ))
        )}
      </div>
    ),
    meta: { label: '仓库' },
  },
  {
    id: 'tasks',
    header: '当前任务',
    cell: ({ row }) => {
      const a = row.original
      return (
        <div className="flex min-w-[100px] flex-col gap-0.5">
          <span className="text-xs text-muted-foreground tabular-nums">
            {a.current_task_ids.length} / {a.max_concurrency} 并发
          </span>
          <div className="flex flex-wrap gap-1">
            {a.current_task_ids.map((id) => (
              <Link key={id} to={`/tasks/${id}`} className="font-mono text-xs text-primary hover:underline">
                ACP-{id}
              </Link>
            ))}
          </div>
        </div>
      )
    },
    meta: { label: '当前任务' },
  },
  {
    id: 'help',
    header: '自动接求助',
    cell: ({ row }) => <ToneBadge tone={row.original.auto_accept_help ? 'primary' : 'muted'}>{row.original.auto_accept_help ? '开启' : '关闭'}</ToneBadge>,
    meta: { label: '自动接求助' },
  },
  {
    id: 'heartbeat',
    header: '最近心跳',
    cell: ({ row }) => (
      <Tooltip>
        <TooltipTrigger render={<span className={cn('text-sm whitespace-nowrap', row.original.status === 'offline' ? 'text-muted-foreground' : 'text-foreground')} />}>
          {row.original.last_heartbeat_at ? formatRelative(row.original.last_heartbeat_at) : '从未'}
        </TooltipTrigger>
        <TooltipContent>{formatDateTime(row.original.last_heartbeat_at, true)}</TooltipContent>
      </Tooltip>
    ),
    meta: { label: '最近心跳' },
  },
]

function AgentsTab() {
  const agents = useAgents()
  const [status, setStatus] = useState<AgentStatus | 'all'>('all')
  const list = agents.data?.items ?? []
  const filtered = status === 'all' ? list : list.filter((a) => a.status === status)
  const order: Record<AgentStatus, number> = { online: 0, busy: 1, offline: 2 }
  const sorted = [...filtered].sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name))
  const count = (s: AgentStatus) => list.filter((a) => a.status === s).length

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table v8 的已知用法
  const table = useReactTable({ data: sorted, columns: agentColumns, getCoreRowModel: getCoreRowModel(), getRowId: (r) => r.id })

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        {(['online', 'busy', 'offline'] as const).map((s) => (
          <Card key={s} className="bg-gradient-to-t from-primary/5 to-card shadow-xs dark:bg-card">
            <CardHeader>
              <CardDescription className="flex items-center gap-2">
                <StatusDot status={s} />
                {AGENT_STATUS_LABEL[s]}
              </CardDescription>
              <CardTitle className="text-2xl font-semibold tabular-nums">{agents.isPending ? '—' : count(s)}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
      {agents.error && !agents.data ? (
        <ErrorState error={agents.error} onRetry={() => void agents.refetch()} className="rounded-lg border" />
      ) : (
        <DataTable
          table={table}
          loading={agents.isPending}
          emptyText={
            <span className="inline-flex flex-col items-center gap-2">
              <Bot className="size-5" />
              还没有 Agent 接入。开发者在电脑上运行 acp-link 登录后会出现在这里。
            </span>
          }
          rowClassName={(a) => (a.status === 'offline' ? 'opacity-70' : undefined)}
          toolbar={
            <div className="flex flex-wrap items-center justify-between gap-2 p-1">
              <ToggleChips
                value={status}
                onChange={setStatus}
                options={[
                  { value: 'all', label: `全部 ${list.length}` },
                  { value: 'online', label: `在线 ${count('online')}` },
                  { value: 'busy', label: `忙碌 ${count('busy')}` },
                  { value: 'offline', label: `离线 ${count('offline')}` },
                ]}
              />
              <p className="text-xs text-muted-foreground">每 30 秒刷新 · 30 分钟无心跳视为离线</p>
            </div>
          }
        />
      )}
    </div>
  )
}

export default function PeoplePage() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'agents' ? 'agents' : 'members'
  return (
    <PageContainer title="负责人" description="团队成员的角色与负载，以及每个人电脑上接入的 Agent。">
      <Tabs
        value={tab}
        onValueChange={(v) => setParams(v === 'agents' ? { tab: 'agents' } : {}, { replace: true })}
        className="gap-4"
      >
        <TabsList>
          <TabsTrigger value="members">成员</TabsTrigger>
          <TabsTrigger value="agents">Agent</TabsTrigger>
        </TabsList>
        <TabsContent value="members">
          <MembersTab />
        </TabsContent>
        <TabsContent value="agents">
          <AgentsTab />
        </TabsContent>
      </Tabs>
    </PageContainer>
  )
}
