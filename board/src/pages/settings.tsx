import { Bot, Info, LoaderCircle, Lock, RotateCcw, Save } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ErrorState } from '@/components/empty-state'
import { PageContainer } from '@/components/layout/page-container'
import { PageSkeleton } from '@/components/page-skeleton'
import { ToneBadge } from '@/components/status-badge'
import { TagInput } from '@/components/tag-input'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/lib/auth'
import {
  AUTONOMY_DESCRIPTION,
  AUTONOMY_LABEL,
  AUTONOMY_OPTIONS,
  INTAKE_MODES,
  INTAKE_MODE_DESCRIPTION,
  INTAKE_MODE_LABEL,
  NOTIFY_MODE_LABEL,
  SCENARIOS,
  SCENARIO_DESCRIPTION,
  SCENARIO_LABEL,
} from '@/lib/labels'
import { useSettings, useUpdateSettings } from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { AutonomySetting, Scenario, Settings, UpdateSettingsBody } from '@/types/api'

const LEVEL_TONE: Record<AutonomySetting, 'muted' | 'neutral' | 'primary' | 'warning'> = {
  off: 'muted',
  L0: 'neutral',
  L1: 'primary',
  L2: 'warning',
}

const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')

function SettingsForm({ settings, readOnly }: { settings: Settings; readOnly: boolean }) {
  const [autonomy, setAutonomy] = useState(settings.autonomy)
  const [modes, setModes] = useState<string[]>(settings.intake_modes)
  const [chats, setChats] = useState<string[]>(settings.feishu_chat_ids)
  const mutation = useUpdateSettings()

  const patch = useMemo<UpdateSettingsBody>(() => {
    const body: UpdateSettingsBody = {}
    const changed = SCENARIOS.filter((s) => autonomy[s] !== settings.autonomy[s])
    if (changed.length) body.autonomy = Object.fromEntries(changed.map((s) => [s, autonomy[s]])) as Partial<Record<Scenario, AutonomySetting>>
    if (!sameList(modes, settings.intake_modes)) body.intake_modes = modes
    if (!sameList(chats, settings.feishu_chat_ids)) body.feishu_chat_ids = chats
    return body
  }, [autonomy, modes, chats, settings])
  const dirty = Object.keys(patch).length > 0

  const reset = () => {
    setAutonomy(settings.autonomy)
    setModes(settings.intake_modes)
    setChats(settings.feishu_chat_ids)
  }

  const levelItems = AUTONOMY_OPTIONS.map((l) => ({ value: l, label: AUTONOMY_LABEL[l] }))

  return (
    <div className="flex flex-col gap-4 pb-20">
      {readOnly && (
        <div className="flex items-center gap-2 rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
          <Lock className="size-4" />
          只有管理员可以修改设置，当前为只读。
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="size-4 text-primary" />
            协调 Agent 自主等级
          </CardTitle>
          <CardDescription>
            每个场景单独设等级，改动立即生效、不需要发版，并记入事件表。建议先按 L0 运行两周，看建议采纳率和撤销率再逐项调高。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-0 divide-y">
          {SCENARIOS.map((s) => {
            const value = autonomy[s]
            const changed = value !== settings.autonomy[s]
            return (
              <div key={s} className="grid gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-[1fr_300px] md:items-center">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor={`level-${s}`} className="text-sm font-medium">
                      {SCENARIO_LABEL[s]}
                    </Label>
                    <code className="font-mono text-xs text-muted-foreground">{s}</code>
                    {changed && <ToneBadge tone="warning">未保存</ToneBadge>}
                  </div>
                  <p className="text-sm text-muted-foreground">{SCENARIO_DESCRIPTION[s]}</p>
                </div>
                <div className="space-y-1.5">
                  <Select
                    items={levelItems}
                    value={value}
                    onValueChange={(v) => v && setAutonomy((prev) => ({ ...prev, [s]: v as AutonomySetting }))}
                    disabled={readOnly}
                  >
                    <SelectTrigger id={`level-${s}`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AUTONOMY_OPTIONS.map((l) => (
                        <SelectItem key={l} value={l}>
                          <span className="flex flex-col">
                            <span>{AUTONOMY_LABEL[l]}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ToneBadge tone={LEVEL_TONE[value]} className="h-4 px-1.5 text-[10px]">
                      {value === 'off' ? '关' : value}
                    </ToneBadge>
                    {AUTONOMY_DESCRIPTION[value]}
                  </p>
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>飞书建单方式</CardTitle>
            <CardDescription>群里的哪些消息会进入任务库。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {INTAKE_MODES.map((m) => (
              <div key={m} className="flex items-start gap-3">
                <Checkbox
                  id={`mode-${m}`}
                  checked={modes.includes(m)}
                  disabled={readOnly}
                  onCheckedChange={(v) => setModes((prev) => (v === true ? [...new Set([...prev, m])] : prev.filter((x) => x !== m)))}
                  className="mt-0.5"
                />
                <div className="grid gap-1">
                  <Label htmlFor={`mode-${m}`}>{INTAKE_MODE_LABEL[m]}</Label>
                  <p className="text-sm text-muted-foreground">{INTAKE_MODE_DESCRIPTION[m]}</p>
                </div>
              </div>
            ))}
            {modes.includes('all') && (
              <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-[color-mix(in_oklch,var(--warning),black_30%)] dark:text-warning">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                全群消息读取需要飞书应用开通「获取群组中所有消息」权限，并依赖大模型判断，建议只在需求群开启。
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>监听的飞书群</CardTitle>
            <CardDescription>群的 chat_id（oc_ 开头），机器人需要先被拉进群。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <TagInput value={chats} onChange={setChats} placeholder={readOnly ? '' : '粘贴 chat_id 后回车'} mono aria-label="飞书群 chat_id" className={cn(readOnly && 'pointer-events-none opacity-70')} />
            <p className="text-xs text-muted-foreground">共 {chats.length} 个群。@机器人 和快捷操作在任何群都可用，这里主要影响全群消息读取和通知默认发往的群。</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>系统信息</CardTitle>
          <CardDescription>来自 coordinator 的运行配置，只读；修改需要改服务器环境变量。</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <div className="flex items-center justify-between gap-4 border-b pb-3 sm:border-0 sm:pb-0">
              <dt className="text-muted-foreground">版本</dt>
              <dd className="font-mono">{settings.version}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 border-b pb-3 sm:border-0 sm:pb-0">
              <dt className="text-muted-foreground">通知投递</dt>
              <dd className="text-right">
                <code className="mr-1.5 font-mono text-xs">{settings.notify_mode}</code>
                <span className="text-muted-foreground">{NOTIFY_MODE_LABEL[settings.notify_mode] ?? ''}</span>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 border-b pb-3 sm:border-0 sm:pb-0">
              <dt className="text-muted-foreground">大模型</dt>
              <dd>
                <ToneBadge tone={settings.llm_enabled ? 'success' : 'muted'}>{settings.llm_enabled ? '已启用' : '未启用'}</ToneBadge>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 border-b pb-3 sm:border-0 sm:pb-0">
              <dt className="text-muted-foreground">对外地址</dt>
              <dd className="truncate font-mono text-xs">{settings.public_url}</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">n8n 地址</dt>
              <dd className="truncate font-mono text-xs">
                {settings.n8n_url ? (
                  <a href={settings.n8n_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    {settings.n8n_url}
                  </a>
                ) : (
                  '未配置'
                )}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {!readOnly && (
        <div
          className={cn(
            'sticky bottom-4 z-10 mx-auto flex w-full max-w-xl items-center gap-3 rounded-xl border bg-popover/95 px-4 py-3 shadow-lg backdrop-blur transition-all',
            dirty ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-4 opacity-0',
          )}
          aria-hidden={!dirty}
        >
          <span className="flex-1 text-sm">有未保存的修改</span>
          <Button variant="ghost" size="sm" onClick={reset} disabled={mutation.isPending}>
            <RotateCcw />
            还原
          </Button>
          <Button size="sm" onClick={() => mutation.mutate(patch)} disabled={mutation.isPending || !dirty}>
            {mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}
            保存
          </Button>
        </div>
      )}
    </div>
  )
}

export default function SettingsPage() {
  const { isAdmin } = useAuth()
  const { data, error, isPending, refetch } = useSettings()
  if (isPending) return <PageSkeleton />
  return (
    <PageContainer title="设置" description="协调 Agent 的自主等级、飞书建单方式和监听的群。">
      {error || !data ? (
        <Card>
          <ErrorState error={error} onRetry={() => void refetch()} />
        </Card>
      ) : (
        // 服务端值变化（如保存成功）时重置表单；值没变的后台刷新不会冲掉未保存的修改
        <SettingsForm key={JSON.stringify(data)} settings={data} readOnly={!isAdmin} />
      )}
    </PageContainer>
  )
}
