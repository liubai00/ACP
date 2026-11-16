import { useMutation, useQueryClient } from '@tanstack/react-query'
import { KeyRound, LoaderCircle, Plus, ShieldAlert, TerminalSquare, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { CodeBlock, CopyButton } from '@/components/copy-button'
import { EmptyState, ErrorState } from '@/components/empty-state'
import { PageContainer } from '@/components/layout/page-container'
import { ToneBadge } from '@/components/status-badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, errorMessage } from '@/lib/api'
import { formatDate, formatDateTime, formatRelative } from '@/lib/format'
import { qk, useRevokeToken, useTokens } from '@/lib/queries'
import type { CreatedPersonalToken, PersonalToken } from '@/types/api'

const DAY_OPTIONS = [7, 30, 60, 90].map((d) => ({ value: String(d), label: `${d} 天` }))

function tokenStatus(t: PersonalToken): { label: string; tone: 'success' | 'muted' | 'danger' } {
  if (t.revoked_at) return { label: '已撤销', tone: 'muted' }
  if (Date.parse(t.expires_at) <= Date.now()) return { label: '已过期', tone: 'danger' }
  return { label: '有效', tone: 'success' }
}

function expiresLabel(t: PersonalToken) {
  if (t.revoked_at) return `撤销于 ${formatRelative(t.revoked_at)}`
  const ms = Date.parse(t.expires_at) - Date.now()
  if (ms <= 0) return `已于 ${formatDate(t.expires_at)} 过期`
  const days = Math.ceil(ms / 86_400_000)
  return `${formatDate(t.expires_at)} 到期（剩 ${days} 天）`
}

/** 三段可直接粘贴的配置 */
function snippets(created: CreatedPersonalToken) {
  return {
    claude: `claude mcp add --transport http acp ${created.mcp_url} --header "Authorization: Bearer ${created.token}"`,
    codex: `[mcp_servers.acp]\nurl = "${created.mcp_url}"\nbearer_token_env_var = "ACP_TOKEN"`,
    env: `ACP_TOKEN=${created.token}`,
  }
}

function CreatedView({ created, onDone }: { created: CreatedPersonalToken; onDone: () => void }) {
  const s = snippets(created)
  return (
    <>
      <DialogHeader>
        <DialogTitle>令牌已创建</DialogTitle>
        <DialogDescription>{formatDateTime(created.expires_at)} 过期。</DialogDescription>
      </DialogHeader>
      <div className="grid min-w-0 gap-4">
        <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-[color-mix(in_oklch,var(--warning),black_30%)] dark:text-warning">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          令牌只显示这一次，关闭后无法再查看。请立即复制保存，不要提交到代码仓库或发到群里；泄露后在本页撤销即可。
        </p>
        <div className="grid gap-2">
          <Label htmlFor="pat-token">令牌</Label>
          <div className="flex min-w-0 gap-2">
            <Input id="pat-token" readOnly value={created.token} className="min-w-0 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <CopyButton text={created.token} />
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="pat-mcp">MCP 地址</Label>
          <div className="flex min-w-0 gap-2">
            <Input id="pat-mcp" readOnly value={created.mcp_url} className="min-w-0 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <CopyButton text={created.mcp_url} />
          </div>
        </div>
        <div className="grid min-w-0 gap-2">
          <p className="text-sm font-medium">Claude Code：在终端执行</p>
          <CodeBlock label="命令行" code={s.claude} wrap />
        </div>
        <div className="grid min-w-0 gap-2">
          <p className="text-sm font-medium">Codex：写入 ~/.codex/config.toml，并设置环境变量</p>
          <CodeBlock label="~/.codex/config.toml" code={s.codex} />
          <CodeBlock label="环境变量（写进 shell 配置或启动脚本）" code={s.env} wrap />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={onDone}>我已保存</Button>
      </DialogFooter>
    </>
  )
}

function CreateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const client = useQueryClient()
  const [name, setName] = useState('')
  const [days, setDays] = useState('30')
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedPersonalToken | null>(null)
  const mutation = useMutation({
    mutationFn: () => api.tokens.create({ name: name.trim(), days: Number(days) }),
    onSuccess: (res) => {
      setCreated(res)
      void client.invalidateQueries({ queryKey: qk.tokens })
    },
    onError: (err) => setError(errorMessage(err)),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('请给令牌起个名字，方便以后辨认')
      return
    }
    setError(null)
    mutation.mutate()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        // 令牌明文展示期间，只允许通过「我已保存」关闭，避免误点遮罩丢失
        if (!v && created) return
        onOpenChange(v)
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl" showCloseButton={!created}>
        {created ? (
          <CreatedView created={created} onDone={() => onOpenChange(false)} />
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>新建个人令牌</DialogTitle>
              <DialogDescription>令牌代表你本人访问派活的 MCP 接口，权限与你的账号相同。</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="pat-name">名称</Label>
              <Input id="pat-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：公司笔记本 Claude Code" maxLength={64} autoFocus />
            </div>
            <div className="grid gap-2">
              <Label>有效期</Label>
              <Select items={DAY_OPTIONS} value={days} onValueChange={(v) => v && setDays(String(v))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAY_OPTIONS.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">最长 90 天，到期后需要重新创建。</p>
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending && <LoaderCircle className="animate-spin" />}
                创建
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

export default function AccountTokensPage() {
  const tokens = useTokens()
  const revoke = useRevokeToken()
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<PersonalToken | null>(null)
  const items = [...(tokens.data?.items ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))

  return (
    <PageContainer
      title="个人令牌"
      description="手动配置 Claude Code / Codex 的 MCP 连接时使用。用 acp-link 接入的 Agent 会自动领取令牌，不需要在这里创建。"
      actions={
        <Button onClick={() => setCreating(true)}>
          <Plus />
          新建令牌
        </Button>
      }
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>我的令牌</CardTitle>
            <CardDescription>撤销后立即失效；过期或撤销的令牌保留记录便于追溯。</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {tokens.isPending ? (
              <div className="grid gap-2 px-4">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            ) : tokens.error ? (
              <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} />
            ) : items.length === 0 ? (
              <EmptyState
                icon={KeyRound}
                title="还没有个人令牌"
                description="需要在 Claude Code 或 Codex 里手动接入派活时，新建一个令牌。"
                action={
                  <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                    <Plus />
                    新建令牌
                  </Button>
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="pl-4">名称</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>创建</TableHead>
                      <TableHead>过期</TableHead>
                      <TableHead className="pr-4 text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((t) => {
                      const st = tokenStatus(t)
                      const active = st.label === '有效'
                      return (
                        <TableRow key={String(t.id)} className={active ? undefined : 'text-muted-foreground'}>
                          <TableCell className="max-w-[220px] pl-4">
                            <span className="flex items-center gap-2">
                              <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                              <span className="truncate font-medium">{t.name}</span>
                            </span>
                          </TableCell>
                          <TableCell>
                            <ToneBadge tone={st.tone}>{st.label}</ToneBadge>
                          </TableCell>
                          <TableCell className="text-sm whitespace-nowrap" title={formatDateTime(t.created_at)}>
                            {formatRelative(t.created_at)}
                          </TableCell>
                          <TableCell className="text-sm whitespace-nowrap" title={formatDateTime(t.expires_at)}>
                            {expiresLabel(t)}
                          </TableCell>
                          <TableCell className="pr-4 text-right">
                            {active ? (
                              <Button variant="ghost" size="sm" className="text-danger hover:text-danger" onClick={() => setRevoking(t)}>
                                <Trash2 />
                                撤销
                              </Button>
                            ) : (
                              <span className="text-xs">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="self-start">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TerminalSquare className="size-4 text-primary" />
              怎么用
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm text-muted-foreground">
            <p>1. 点「新建令牌」，起一个能认出设备的名字，选择有效期。</p>
            <p>2. 创建成功后复制给出的命令或配置片段：Claude Code 直接执行一条 <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">claude mcp add</code>；Codex 写入 <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">~/.codex/config.toml</code> 并设置环境变量 <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">ACP_TOKEN</code>。</p>
            <p>3. 在 Agent 里就能调用 list_tasks、claim_task、post_message 等平台工具。</p>
            <p>令牌只显示一次；换电脑或怀疑泄露时撤销旧的、重新创建。</p>
          </CardContent>
        </Card>
      </div>

      <CreateDialog key={creating ? 'open' : 'closed'} open={creating} onOpenChange={setCreating} />

      <AlertDialog open={!!revoking} onOpenChange={(v) => !v && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>撤销令牌「{revoking?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>撤销后使用这个令牌的 Claude Code / Codex 会立即无法访问派活，此操作不能恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() => revoking && revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) })}
            >
              {revoke.isPending && <LoaderCircle className="animate-spin" />}
              撤销
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  )
}
