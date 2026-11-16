import {
  Ban,
  CircleCheck,
  Ellipsis,
  Hand,
  LoaderCircle,
  MessageSquareReply,
  Pencil,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  UserPlus,
  UserX,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { TagInput } from '@/components/tag-input'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { GATE_LABEL, PRIORITIES, PRIORITY_LABEL } from '@/lib/labels'
import { useMemberOptions, useTaskMutation } from '@/lib/queries'
import { useRepoOptions } from '@/lib/use-options'
import type { Priority, TaskDetail, UpdateTaskBody } from '@/types/api'

type DialogKind = 'decline' | 'cancel' | 'input' | 'request_approval' | 'approve' | 'reject' | 'complete' | 'assign' | null

function PromptDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  placeholder,
  required = false,
  confirmText,
  destructive = false,
  pending,
  onSubmit,
  children,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  description?: string
  label?: string
  placeholder?: string
  required?: boolean
  confirmText: string
  destructive?: boolean
  pending: boolean
  onSubmit: (text: string) => void
  children?: ReactNode
}) {
  const [text, setText] = useState('')
  const [touched, setTouched] = useState(false)
  const invalid = required && !text.trim()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            setTouched(true)
            if (invalid) return
            onSubmit(text.trim())
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          {label !== undefined && (
            <div className="grid gap-2">
              <Label htmlFor="prompt-text">
                {label}
                {required ? <span className="text-danger"> *</span> : <span className="text-muted-foreground">（可选）</span>}
              </Label>
              <Textarea id="prompt-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} rows={4} autoFocus aria-invalid={touched && invalid} />
              {touched && invalid && <p className="text-xs text-danger">请填写{label}</p>}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={pending}>
              {pending && <LoaderCircle className="animate-spin" />}
              {confirmText}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function EditSheet({ task, open, onOpenChange }: { task: TaskDetail; open: boolean; onOpenChange: (v: boolean) => void }) {
  const repoOptions = useRepoOptions()
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [priority, setPriority] = useState<Priority>(task.priority)
  const [repos, setRepos] = useState(task.repos)
  const [skills, setSkills] = useState(task.skills)
  const [labels, setLabels] = useState(task.labels)
  const mutation = useTaskMutation((body: UpdateTaskBody) => api.tasks.update(task.id, body), '已保存修改')
  const priorityItems = PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <form
          className="flex h-full flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            if (!title.trim()) return
            mutation.mutate(
              { title: title.trim(), description, priority, repos, skills, labels },
              { onSuccess: () => onOpenChange(false) },
            )
          }}
        >
          <SheetHeader>
            <SheetTitle>编辑 {task.key}</SheetTitle>
            <SheetDescription>修改会记录到时间线，并通知负责人。</SheetDescription>
          </SheetHeader>
          <div className="grid gap-4 px-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-title">标题</Label>
              <Input id="edit-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} aria-invalid={!title.trim()} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-desc">描述</Label>
              <Textarea id="edit-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={8} />
            </div>
            <div className="grid gap-2">
              <Label>优先级</Label>
              <Select items={priorityItems} value={priority} onValueChange={(v) => v && setPriority(v as Priority)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {priorityItems.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>涉及仓库</Label>
              <TagInput value={repos} onChange={setRepos} suggestions={repoOptions} mono placeholder="回车添加" aria-label="涉及仓库" />
            </div>
            <div className="grid gap-2">
              <Label>期望技能</Label>
              <TagInput value={skills} onChange={setSkills} placeholder="回车添加" aria-label="期望技能" />
            </div>
            <div className="grid gap-2">
              <Label>标签</Label>
              <TagInput value={labels} onChange={setLabels} placeholder="回车添加" aria-label="标签" />
            </div>
          </div>
          <SheetFooter className="mt-auto">
            <Button type="submit" disabled={mutation.isPending || !title.trim()}>
              {mutation.isPending && <LoaderCircle className="animate-spin" />}
              保存
            </Button>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

/** 详情页头部的操作按钮，完全由 allowed_actions 决定显示哪些 */
export function TaskActions({ task }: { task: TaskDetail }) {
  const can = (a: string) => task.allowed_actions.includes(a)
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [editing, setEditing] = useState(false)
  const [gate, setGate] = useState<'merge' | 'high_risk'>(task.merge_requests.length > 0 ? 'merge' : 'high_risk')
  const [assignTo, setAssignTo] = useState<string>('')
  const members = useMemberOptions()
  const pendingApproval = task.approvals.find((a) => a.status === 'pending')
  const close = () => setDialog(null)

  const claim = useTaskMutation(() => api.tasks.claim(task.id), (t) => `已认领 ${t.key}`)
  const accept = useTaskMutation(() => api.tasks.accept(task.id), '已接受派工')
  const decline = useTaskMutation((reason: string) => api.tasks.decline(task.id, reason || undefined), '已拒绝派工')
  const cancel = useTaskMutation((reason: string) => api.tasks.cancel(task.id, reason || undefined), '任务已取消')
  const input = useTaskMutation((content: string) => api.tasks.input(task.id, content), '已提交补充信息，Agent 将继续执行')
  const requestApproval = useTaskMutation((note: string) => api.tasks.requestApproval(task.id, { gate, note: note || undefined }), '已发起审批')
  const decide = useTaskMutation(
    ({ decision, comment }: { decision: 'approve' | 'reject'; comment: string }) =>
      api.approvals.decide(pendingApproval?.id ?? 0, { decision, comment: comment || undefined }),
    (t) => (t.approvals.some((a) => a.id === pendingApproval?.id && a.status === 'approved') ? '已同意' : '已驳回'),
  )
  const complete = useTaskMutation((note: string) => api.tasks.complete(task.id, note || undefined), '已确认完成')
  const assign = useTaskMutation((memberId: string) => api.tasks.assign(task.id, memberId), '已派工，派工卡片已发出')

  const memberItems = (members.data?.items ?? []).filter((m) => m.is_active).map((m) => ({ value: m.id, label: m.team ? `${m.name} · ${m.team}` : m.name }))
  const gateItems = (['merge', 'high_risk'] as const).map((g) => ({ value: g, label: GATE_LABEL[g] }))

  const hasMore = can('edit') || can('assign') || can('cancel')

  return (
    <div className="flex flex-wrap items-center gap-2">
      {can('claim') && (
        <Button onClick={() => claim.mutate(undefined)} disabled={claim.isPending}>
          {claim.isPending ? <LoaderCircle className="animate-spin" /> : <Hand />}
          认领
        </Button>
      )}
      {can('accept') && (
        <Button onClick={() => accept.mutate(undefined)} disabled={accept.isPending}>
          {accept.isPending ? <LoaderCircle className="animate-spin" /> : <CircleCheck />}
          接受
        </Button>
      )}
      {can('decline') && (
        <Button variant="outline" onClick={() => setDialog('decline')}>
          <UserX />
          拒绝
        </Button>
      )}
      {can('input') && (
        <Button onClick={() => setDialog('input')}>
          <MessageSquareReply />
          补充信息
        </Button>
      )}
      {can('approve') && pendingApproval && (
        <Button onClick={() => setDialog('approve')}>
          <ThumbsUp />
          同意
        </Button>
      )}
      {can('reject') && pendingApproval && (
        <Button variant="destructive" onClick={() => setDialog('reject')}>
          <ThumbsDown />
          驳回
        </Button>
      )}
      {can('request_approval') && (
        <Button variant="outline" onClick={() => setDialog('request_approval')}>
          <ShieldCheck />
          请求审批
        </Button>
      )}
      {can('complete') && (
        <Button variant="outline" onClick={() => setDialog('complete')}>
          <CircleCheck />
          确认完成
        </Button>
      )}
      {hasMore && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label="更多操作" />}>
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {can('edit') && (
              <DropdownMenuItem onClick={() => setEditing(true)}>
                <Pencil />
                编辑任务
              </DropdownMenuItem>
            )}
            {can('assign') && (
              <DropdownMenuItem onClick={() => setDialog('assign')}>
                <UserPlus />
                派工给…
              </DropdownMenuItem>
            )}
            {can('cancel') && (
              <>
                {(can('edit') || can('assign')) && <DropdownMenuSeparator />}
                <DropdownMenuItem variant="destructive" onClick={() => setDialog('cancel')}>
                  <Ban />
                  取消任务
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* 对话框：用 key 保证每次打开都是空表单 */}
      <PromptDialog
        key={`decline-${dialog === 'decline'}`}
        open={dialog === 'decline'}
        onOpenChange={(v) => !v && close()}
        title="拒绝派工"
        description="任务会回到待认领，协调 Agent 会重新推荐负责人。"
        label="原因"
        placeholder="如：本周排满了 / 不熟悉这个仓库"
        confirmText="拒绝"
        destructive
        pending={decline.isPending}
        onSubmit={(t) => decline.mutate(t, { onSuccess: close })}
      />
      <PromptDialog
        key={`cancel-${dialog === 'cancel'}`}
        open={dialog === 'cancel'}
        onOpenChange={(v) => !v && close()}
        title={`取消 ${task.key}？`}
        description="取消后任务进入终态，不能恢复；要返工请新建任务。负责人的 Agent 会停止执行。"
        label="原因"
        placeholder="如：需求变更 / 与其他任务重复"
        confirmText="取消任务"
        destructive
        pending={cancel.isPending}
        onSubmit={(t) => cancel.mutate(t, { onSuccess: close })}
      />
      <PromptDialog
        key={`input-${dialog === 'input'}`}
        open={dialog === 'input'}
        onOpenChange={(v) => !v && close()}
        title="补充信息"
        description="回答 Agent 的问题，提交后任务回到进行中。"
        label="回答"
        required
        placeholder="直接回答 Agent 提出的问题…"
        confirmText="提交"
        pending={input.isPending}
        onSubmit={(t) => input.mutate(t, { onSuccess: close })}
      />
      <PromptDialog
        key={`ra-${dialog === 'request_approval'}`}
        open={dialog === 'request_approval'}
        onOpenChange={(v) => !v && close()}
        title="请求审批"
        description="审批卡片会发给审批人；通过后合并 MR 或继续高风险操作。"
        label="说明"
        placeholder="改动摘要、风险点、需要审批人关注的地方…"
        confirmText="发起审批"
        pending={requestApproval.isPending}
        onSubmit={(t) => requestApproval.mutate(t, { onSuccess: close })}
      >
        <div className="grid gap-2">
          <Label>审批卡点</Label>
          <Select items={gateItems} value={gate} onValueChange={(v) => v && setGate(v as 'merge' | 'high_risk')}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {gateItems.map((g) => (
                <SelectItem key={g.value} value={g.value}>
                  {g.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </PromptDialog>
      <PromptDialog
        key={`approve-${dialog === 'approve'}`}
        open={dialog === 'approve'}
        onOpenChange={(v) => !v && close()}
        title={`同意${pendingApproval ? GATE_LABEL[pendingApproval.gate] : '审批'}`}
        description={pendingApproval?.gate === 'merge' ? '同意后 MR 将被合并，任务完成。' : '同意后 Agent 继续执行。'}
        label="意见"
        placeholder="如：代码看过了，没问题"
        confirmText="同意"
        pending={decide.isPending}
        onSubmit={(comment) => decide.mutate({ decision: 'approve', comment }, { onSuccess: close })}
      />
      <PromptDialog
        key={`reject-${dialog === 'reject'}`}
        open={dialog === 'reject'}
        onOpenChange={(v) => !v && close()}
        title="驳回审批"
        description="任务回到进行中，Agent 会根据意见修改。"
        label="驳回意见"
        required
        placeholder="需要修改的地方…"
        confirmText="驳回"
        destructive
        pending={decide.isPending}
        onSubmit={(comment) => decide.mutate({ decision: 'reject', comment }, { onSuccess: close })}
      />
      <PromptDialog
        key={`complete-${dialog === 'complete'}`}
        open={dialog === 'complete'}
        onOpenChange={(v) => !v && close()}
        title="确认完成"
        description="适用于没有 MR 的任务：确认验收后任务进入已完成。"
        label="验收说明"
        placeholder="如：已验收，符合预期"
        confirmText="确认完成"
        pending={complete.isPending}
        onSubmit={(note) => complete.mutate(note, { onSuccess: close })}
      />
      <Dialog open={dialog === 'assign'} onOpenChange={(v) => !v && close()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>派工</DialogTitle>
            <DialogDescription>选择负责人，系统会把派工卡片发给对方，对方接受后即认领。</DialogDescription>
          </DialogHeader>
          <Select items={memberItems} value={assignTo || null} onValueChange={(v) => setAssignTo(typeof v === 'string' ? v : '')}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择成员" />
            </SelectTrigger>
            <SelectContent>
              {memberItems.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              取消
            </Button>
            <Button disabled={!assignTo || assign.isPending} onClick={() => assign.mutate(assignTo, { onSuccess: close })}>
              {assign.isPending && <LoaderCircle className="animate-spin" />}
              发送派工
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {editing && <EditSheet task={task} open={editing} onOpenChange={setEditing} />}
    </div>
  )
}
