/* eslint-disable react-refresh/only-export-components */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { TagInput } from '@/components/tag-input'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api, errorMessage } from '@/lib/api'
import { PRIORITIES, PRIORITY_LABEL } from '@/lib/labels'
import { applyTaskDetail, useMemberOptions } from '@/lib/queries'
import { useRepoOptions } from '@/lib/use-options'
import type { CreateTaskBody, Priority } from '@/types/api'

interface OpenOptions {
  parentId?: number
  parentKey?: string
}

const NewTaskContext = createContext<{ open: (opts?: OpenOptions) => void } | null>(null)

export function useNewTaskDialog() {
  const ctx = useContext(NewTaskContext)
  if (!ctx) throw new Error('useNewTaskDialog 必须在 NewTaskDialogProvider 内使用')
  return ctx
}

const NONE = '__none'

export function NewTaskDialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; opts: OpenOptions }>({ open: false, opts: {} })
  const open = useCallback((opts: OpenOptions = {}) => setState({ open: true, opts }), [])
  const ctx = useMemo(() => ({ open }), [open])
  return (
    <NewTaskContext.Provider value={ctx}>
      {children}
      <NewTaskDialog
        // 每次打开时重置表单
        key={state.open ? `open-${state.opts.parentId ?? ''}` : 'closed'}
        open={state.open}
        opts={state.opts}
        onOpenChange={(v) => setState((s) => ({ ...s, open: v }))}
      />
    </NewTaskContext.Provider>
  )
}

function NewTaskDialog({
  open,
  opts,
  onOpenChange,
}: {
  open: boolean
  opts: OpenOptions
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const client = useQueryClient()
  const members = useMemberOptions()
  const repoOptions = useRepoOptions()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [repos, setRepos] = useState<string[]>([])
  const [skills, setSkills] = useState<string[]>([])
  const [labels, setLabels] = useState<string[]>([])
  const [priority, setPriority] = useState<Priority>('normal')
  const [assignee, setAssignee] = useState<string>(NONE)
  const [error, setError] = useState<string | null>(null)

  const memberItems = useMemo(
    () => [
      { value: NONE, label: '不指定（由协调 Agent 推荐）' },
      ...(members.data?.items ?? []).filter((m) => m.is_active).map((m) => ({ value: m.id, label: m.team ? `${m.name} · ${m.team}` : m.name })),
    ],
    [members.data],
  )
  const priorityItems = PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))

  const mutation = useMutation({
    mutationFn: (body: CreateTaskBody) => api.tasks.create(body),
    onSuccess: (task) => {
      applyTaskDetail(client, task)
      toast.success(`已创建 ${task.key}`, { description: task.title })
      onOpenChange(false)
      navigate(`/tasks/${task.id}`)
    },
    onError: (err) => setError(errorMessage(err)),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const t = title.trim()
    if (!t) {
      setError('请填写标题')
      return
    }
    setError(null)
    mutation.mutate({
      title: t,
      description: description.trim() || undefined,
      repos: repos.length ? repos : undefined,
      skills: skills.length ? skills : undefined,
      labels: labels.length ? labels : undefined,
      priority,
      parent_id: opts.parentId,
      suggested_assignee_id: assignee !== NONE ? assignee : undefined,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{opts.parentKey ? `新建子任务（${opts.parentKey}）` : '新建任务'}</DialogTitle>
            <DialogDescription>任务创建后进入「待认领」，协调 Agent 会给出派工建议。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="nt-title">
              标题 <span className="text-danger">*</span>
            </Label>
            <Input id="nt-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="一句话说明要做什么，如：订单列表页支持导出 Excel" maxLength={200} autoFocus />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="nt-desc">描述</Label>
            <Textarea id="nt-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="背景、验收标准、注意事项…" rows={4} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
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
              <Label>建议负责人</Label>
              <Select items={memberItems} value={assignee} onValueChange={(v) => setAssignee(typeof v === 'string' ? v : NONE)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {memberItems.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="nt-repos">涉及仓库</Label>
            <TagInput id="nt-repos" value={repos} onChange={setRepos} suggestions={repoOptions} placeholder="如 shop/web-mall，回车添加" mono />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="nt-skills">期望技能</Label>
              <TagInput id="nt-skills" value={skills} onChange={setSkills} placeholder="react、java…" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="nt-labels">标签</Label>
              <TagInput id="nt-labels" value={labels} onChange={setLabels} placeholder="运营需求、线上问题…" />
            </div>
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <LoaderCircle className="animate-spin" />}
              创建任务
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
