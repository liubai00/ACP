import { useQueryClient } from '@tanstack/react-query'
import { CornerDownRight, ExternalLink, GitBranch, GitPullRequest, LoaderCircle, Plus, SendHorizontal, ShieldCheck, Sparkles, Undo2 } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { EmptyState } from '@/components/empty-state'
import { MemberAvatar, MemberChip } from '@/components/member-avatar'
import { PipelineBadge, StateBadge, ToneBadge } from '@/components/status-badge'
import { useNewTaskDialog } from '@/components/tasks/new-task-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { mergeTimeline } from '@/hooks/use-task-stream'
import { api, errorMessage } from '@/lib/api'
import { formatDateTime, formatRelative } from '@/lib/format'
import {
  APPROVAL_STATUS_LABEL,
  APPROVAL_STATUS_TONE,
  AUTONOMY_LABEL,
  GATE_LABEL,
  MR_STATE_LABEL,
  MR_STATE_TONE,
  SCENARIO_LABEL,
  SUGGESTION_STATUS_LABEL,
  SUGGESTION_STATUS_TONE,
  TERMINAL_STATES,
} from '@/lib/labels'
import { applyTaskDetail, qk, useSuggestionMutation } from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { TaskDetail, TaskSummary } from '@/types/api'

// ---------- 消息输入 ----------

export function MessageComposer({ task }: { task: TaskDetail }) {
  const client = useQueryClient()
  const canMessage = task.allowed_actions.includes('message')
  const canInput = task.allowed_actions.includes('input') && task.state === 'input-required'
  const [text, setText] = useState('')
  const [asInput, setAsInput] = useState(canInput)
  const [sending, setSending] = useState(false)

  if (!canMessage && !canInput) return null

  const send = async () => {
    const content = text.trim()
    if (!content || sending) return
    setSending(true)
    try {
      if (canInput && asInput) {
        const detail = await api.tasks.input(task.id, content)
        applyTaskDetail(client, detail)
        toast.success('已提交补充信息，Agent 将继续执行')
      } else {
        const item = await api.tasks.message(task.id, content)
        client.setQueryData<TaskDetail>(qk.task(task.id), (prev) => (prev ? mergeTimeline(prev, item) : prev))
      }
      setText('')
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div className="rounded-lg border bg-card p-2 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={canInput && asInput ? '回答 Agent 的问题，提交后任务回到进行中…' : '发消息给负责人和 Agent…'}
        rows={3}
        className="resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
        aria-label="消息内容"
      />
      <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
        {canInput && (
          <div className="flex items-center gap-2">
            <Checkbox id="as-input" checked={asInput} onCheckedChange={(v) => setAsInput(v === true)} />
            <Label htmlFor="as-input" className="text-xs font-normal text-muted-foreground">
              作为「补充信息」提交
            </Label>
          </div>
        )}
        <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">Ctrl + Enter 发送</span>
        <Button size="sm" onClick={() => void send()} disabled={!text.trim() || sending}>
          {sending ? <LoaderCircle className="animate-spin" /> : <SendHorizontal />}
          {canInput && asInput ? '提交补充' : '发送'}
        </Button>
      </div>
    </div>
  )
}

// ---------- 代码与 CI ----------

export function MergeRequestsSection({ task }: { task: TaskDetail }) {
  if (task.merge_requests.length === 0) {
    return (
      <EmptyState
        icon={GitPullRequest}
        title="还没有 MR"
        description={task.repos.length ? `Agent 推送分支并开 MR 后会出现在这里（分支命名 acp/${task.id}-…）。` : '这个任务没有关联代码仓库。'}
      />
    )
  }
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader className="bg-muted">
          <TableRow className="hover:bg-transparent">
            <TableHead>仓库</TableHead>
            <TableHead>分支</TableHead>
            <TableHead>MR</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>流水线</TableHead>
            <TableHead className="text-right">更新</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {task.merge_requests.map((mr) => (
            <TableRow key={mr.id}>
              <TableCell className="font-mono text-xs">{mr.repo}</TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                  <GitBranch className="size-3.5" />
                  {mr.branch}
                </span>
              </TableCell>
              <TableCell>
                {mr.url ? (
                  <a href={mr.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-sm text-primary hover:underline">
                    !{mr.iid ?? '—'}
                    <ExternalLink className="size-3" />
                  </a>
                ) : (
                  <span className="text-muted-foreground">{mr.iid ? `!${mr.iid}` : '—'}</span>
                )}
              </TableCell>
              <TableCell>
                <ToneBadge tone={MR_STATE_TONE[mr.state]}>{MR_STATE_LABEL[mr.state]}</ToneBadge>
              </TableCell>
              <TableCell>
                <PipelineBadge status={mr.pipeline_status} />
              </TableCell>
              <TableCell className="text-right text-sm whitespace-nowrap text-muted-foreground">{formatRelative(mr.updated_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// ---------- 审批 ----------

export function ApprovalsSection({ task }: { task: TaskDetail }) {
  if (task.approvals.length === 0) {
    return <EmptyState icon={ShieldCheck} title="没有审批记录" description="合并 MR 或执行高风险操作前会在这里发起审批。" />
  }
  const sorted = [...task.approvals].sort((a, b) => b.created_at.localeCompare(a.created_at))
  return (
    <ul className="space-y-3">
      {sorted.map((a) => (
        <li key={a.id} className={cn('rounded-lg border p-4', a.status === 'pending' && 'border-warning/50 bg-warning/5')}>
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="size-4 text-muted-foreground" />
            <span className="font-medium">{GATE_LABEL[a.gate]}</span>
            <ToneBadge tone={APPROVAL_STATUS_TONE[a.status]}>{APPROVAL_STATUS_LABEL[a.status]}</ToneBadge>
            <span className="ml-auto text-xs text-muted-foreground">#{a.id}</span>
          </div>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div className="flex items-center gap-2">
              <dt className="text-muted-foreground">发起</dt>
              <dd className="flex items-center gap-1.5">
                <MemberChip member={a.requested_by} fallback="系统" />
                <span className="text-xs text-muted-foreground">{formatRelative(a.created_at)}</span>
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="text-muted-foreground">审批</dt>
              <dd className="flex items-center gap-1.5">
                {a.decided_by ? (
                  <>
                    <MemberChip member={a.decided_by} />
                    <span className="text-xs text-muted-foreground">{formatRelative(a.decided_at)}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">等待审批人处理</span>
                )}
              </dd>
            </div>
          </dl>
          {a.comment && <p className="mt-3 rounded-md bg-muted/60 px-3 py-2 text-sm whitespace-pre-wrap">{a.comment}</p>}
          {a.status === 'pending' && task.allowed_actions.includes('approve') && (
            <p className="mt-3 text-xs text-muted-foreground">用页面顶部的「同意 / 驳回」按钮处理，也可以在飞书审批卡片上操作。</p>
          )}
        </li>
      ))}
    </ul>
  )
}

// ---------- 子任务 ----------

interface TreeNode {
  task: TaskSummary
  children: TreeNode[]
}

function buildTree(rootId: number, list: TaskSummary[]): TreeNode[] {
  const byParent = new Map<number, TaskSummary[]>()
  list.forEach((t) => {
    if (t.parent_id === null) return
    byParent.set(t.parent_id, [...(byParent.get(t.parent_id) ?? []), t])
  })
  const walk = (pid: number, seen: Set<number>): TreeNode[] =>
    (byParent.get(pid) ?? [])
      .filter((t) => !seen.has(t.id))
      .map((t) => ({ task: t, children: walk(t.id, new Set([...seen, t.id])) }))
  const nodes = walk(rootId, new Set([rootId]))
  // 后端若只返回了直接子任务以外的条目（parent 不在列表里），兜底挂到根下
  const placed = new Set<number>()
  const mark = (ns: TreeNode[]) => ns.forEach((n) => (placed.add(n.task.id), mark(n.children)))
  mark(nodes)
  list.filter((t) => !placed.has(t.id) && t.id !== rootId).forEach((t) => nodes.push({ task: t, children: [] }))
  return nodes
}

function TreeRows({ nodes, level }: { nodes: TreeNode[]; level: number }) {
  return (
    <>
      {nodes.map((n) => (
        <li key={n.task.id}>
          <Link
            to={`/tasks/${n.task.id}`}
            className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-muted"
            style={{ paddingLeft: `${0.5 + level * 1.25}rem` }}
          >
            <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{n.task.key}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{n.task.title}</span>
            {n.task.type === 'help' && <ToneBadge tone="primary" className="hidden sm:inline-flex">求助</ToneBadge>}
            <MemberAvatar member={n.task.assignee} size="sm" tooltip={!!n.task.assignee} className="hidden sm:flex" />
            <StateBadge state={n.task.state} className="shrink-0" />
          </Link>
          {n.children.length > 0 && (
            <ul>
              <TreeRows nodes={n.children} level={level + 1} />
            </ul>
          )}
        </li>
      ))}
    </>
  )
}

export function SubtasksSection({ task }: { task: TaskDetail }) {
  const newTask = useNewTaskDialog()
  const tree = buildTree(task.id, task.children)
  const canCreate = task.depth < 2 && !['completed', 'failed', 'canceled', 'rejected'].includes(task.state)
  return (
    <div className="space-y-3">
      {task.parent_id !== null && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm">
          <span className="text-muted-foreground">上级任务</span>
          <Link to={`/tasks/${task.parent_id}`} className="font-mono text-primary hover:underline">
            ACP-{task.parent_id}
          </Link>
          {task.root_id !== task.parent_id && (
            <>
              <span className="text-muted-foreground">· 根任务</span>
              <Link to={`/tasks/${task.root_id}`} className="font-mono text-primary hover:underline">
                ACP-{task.root_id}
              </Link>
            </>
          )}
        </div>
      )}
      {tree.length === 0 ? (
        <EmptyState
          icon={CornerDownRight}
          title="没有子任务"
          description="Agent 遇到超出能力的部分会发起求助子任务；也可以手工拆分。（深度不超过 2 层，每个根任务最多 5 个子任务）"
          action={
            canCreate ? (
              <Button variant="outline" size="sm" onClick={() => newTask.open({ parentId: task.id, parentKey: task.key })}>
                <Plus />
                新建子任务
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          <ul className="rounded-lg border p-1">
            <TreeRows nodes={tree} level={0} />
          </ul>
          {canCreate && (
            <Button variant="outline" size="sm" onClick={() => newTask.open({ parentId: task.id, parentKey: task.key })}>
              <Plus />
              新建子任务
            </Button>
          )}
        </>
      )}
    </div>
  )
}

// ---------- 协调建议 ----------

export function SuggestionsSection({ task }: { task: TaskDetail }) {
  const mutation = useSuggestionMutation(task.id)
  if (task.suggestions.length === 0) {
    return <EmptyState icon={Sparkles} title="暂无协调建议" description="协调 Agent 在建单、派工、求助、待补充、CI 失败和巡检时会给出建议。" />
  }
  const sorted = [...task.suggestions].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const ended = TERMINAL_STATES.includes(task.state)
  return (
    <ul className="space-y-3">
      {sorted.map((s) => {
        const busy = mutation.isPending && mutation.variables?.id === s.id
        return (
          <li key={s.id} className={cn('rounded-lg border p-4', s.status === 'proposed' && 'border-primary/30 bg-primary/5')}>
            <div className="flex flex-wrap items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              <span className="font-medium">{SCENARIO_LABEL[s.scenario]}</span>
              <ToneBadge tone="neutral" title={AUTONOMY_LABEL[s.level]}>
                {s.level}
              </ToneBadge>
              <ToneBadge tone={SUGGESTION_STATUS_TONE[s.status]}>{SUGGESTION_STATUS_LABEL[s.status]}</ToneBadge>
              <span className="ml-auto text-xs text-muted-foreground" title={formatDateTime(s.created_at)}>
                {formatRelative(s.created_at)}
              </span>
            </div>
            <p className="mt-2 text-sm leading-relaxed">{s.summary}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {s.decided_by && (
                <span className="text-xs text-muted-foreground">
                  {SUGGESTION_STATUS_LABEL[s.status]} · {s.decided_by.name}
                </span>
              )}
              <span className="ml-auto flex gap-2">
                {s.status === 'proposed' && (
                  <>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => mutation.mutate({ id: s.id, action: 'reject' })}>
                      忽略
                    </Button>
                    {ended ? (
                      <span className="self-center text-xs text-muted-foreground">任务已结束，建议已失效</span>
                    ) : (
                      <Button size="sm" disabled={busy} onClick={() => mutation.mutate({ id: s.id, action: 'accept' })}>
                        {busy && <LoaderCircle className="animate-spin" />}
                        采纳
                      </Button>
                    )}
                  </>
                )}
                {s.status === 'executed' && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => mutation.mutate({ id: s.id, action: 'undo' })}>
                    {busy ? <LoaderCircle className="animate-spin" /> : <Undo2 />}
                    撤销
                  </Button>
                )}
              </span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
