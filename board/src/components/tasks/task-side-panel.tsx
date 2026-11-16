import { Bot, ExternalLink, Quote } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { MemberChip } from '@/components/member-avatar'
import { SourceIcon } from '@/components/status-badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatAge, formatDateTime } from '@/lib/format'
import { AGENT_KIND_LABEL, INTAKE_MODE_LABEL, SOURCE_LABEL, TASK_TYPE_LABEL } from '@/lib/labels'
import type { TaskDetail } from '@/types/api'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_1fr] items-start gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null)

/** source_ref 的已知字段转成中文展示；未知字段按键值对列出 */
const SOURCE_REF_LABEL: Record<string, string> = {
  chat_name: '群聊',
  chat_id: '群 ID',
  sender_name: '发送人',
  message_id: '消息 ID',
  intake_mode: '接入方式',
  project: '项目',
  pipeline_id: '流水线',
  ref: '分支',
  agent_name: '发起 Agent',
  agent_id: 'Agent ID',
  client: '调用方',
  workflow: '工作流',
}
const HIDDEN_REF_KEYS = new Set(['text', 'url', 'raw'])

function SourceDetails({ task }: { task: TaskDetail }) {
  const ref = task.source_ref ?? {}
  const text = str(ref.text)
  const url = str(ref.url)
  const entries = Object.entries(ref).filter(([k, v]) => !HIDDEN_REF_KEYS.has(k) && str(v) !== null)
  return (
    <dl className="space-y-2.5">
      <Row label="来源">
        <span className="inline-flex items-center gap-1.5">
          <SourceIcon source={task.source} className="size-4 text-muted-foreground" />
          {SOURCE_LABEL[task.source]}
          {task.source === 'feishu' && ' 消息'}
          <span className="text-muted-foreground">· {TASK_TYPE_LABEL[task.type]}</span>
        </span>
      </Row>
      <Row label="发布人">
        <MemberChip member={task.creator} fallback="系统" />
      </Row>
      {entries.map(([k, v]) => {
        const value = str(v) ?? ''
        const shown = k === 'intake_mode' ? (INTAKE_MODE_LABEL[value as keyof typeof INTAKE_MODE_LABEL] ?? value) : value
        const isId = k.endsWith('_id')
        return (
          <Row key={k} label={SOURCE_REF_LABEL[k] ?? k}>
            <span className={isId ? 'font-mono text-xs break-all text-muted-foreground' : undefined}>{shown}</span>
          </Row>
        )
      })}
      {text && (
        <div className="rounded-md border-l-2 border-primary/50 bg-muted/50 px-3 py-2 text-sm">
          <Quote className="mb-1 size-3.5 text-muted-foreground" />
          <p className="whitespace-pre-wrap">{text}</p>
        </div>
      )}
      {url && (
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          打开原始链接 <ExternalLink className="size-3" />
        </a>
      )}
    </dl>
  )
}

function Chips({ items, mono = false, empty = '—' }: { items: string[]; mono?: boolean; empty?: string }) {
  if (items.length === 0) return <span className="text-muted-foreground">{empty}</span>
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((i) => (
        <span key={i} className={mono ? 'rounded bg-muted px-1.5 py-0.5 font-mono text-xs' : 'rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground'}>
          {i}
        </span>
      ))}
    </div>
  )
}

export function TaskSidePanel({ task }: { task: TaskDetail }) {
  return (
    <div className="flex flex-col gap-4">
      <Card size="sm">
        <CardHeader>
          <CardTitle>描述</CardTitle>
        </CardHeader>
        <CardContent>
          {task.description ? (
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{task.description}</p>
          ) : (
            <p className="text-sm text-muted-foreground">暂无描述</p>
          )}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>负责人与 Agent</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2.5">
            <Row label="负责人">
              <MemberChip member={task.assignee} />
            </Row>
            {task.suggested_assignee && !task.assignee && (
              <Row label="推荐">
                <MemberChip member={task.suggested_assignee} />
              </Row>
            )}
            <Row label="Agent">
              {task.assignee_agent ? (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <Bot className="size-4 text-primary" />
                  <span className="font-mono text-sm">{task.assignee_agent.name}</span>
                  <span className="text-xs text-muted-foreground">{AGENT_KIND_LABEL[task.assignee_agent.kind] ?? task.assignee_agent.kind}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">{task.assignee ? '负责人没有在线 Agent' : '—'}</span>
              )}
            </Row>
          </dl>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>来源</CardTitle>
        </CardHeader>
        <CardContent>
          <SourceDetails task={task} />
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>仓库与标签</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2.5">
            <Row label="仓库">
              <Chips items={task.repos} mono empty="无代码仓库" />
            </Row>
            <Row label="技能">
              <Chips items={task.skills} />
            </Row>
            <Row label="标签">
              <Chips items={task.labels} />
            </Row>
            {task.parent_id !== null && (
              <Row label="上级任务">
                <Link to={`/tasks/${task.parent_id}`} className="font-mono text-primary hover:underline">
                  ACP-{task.parent_id}
                </Link>
              </Row>
            )}
          </dl>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>时间</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2.5">
            <Row label="创建">{formatDateTime(task.created_at)}</Row>
            <Row label="更新">{formatDateTime(task.updated_at)}</Row>
            <Row label="状态变化">
              {formatDateTime(task.state_changed_at)}
              <span className="text-muted-foreground">（{formatAge(task.state_changed_at)}前）</span>
            </Row>
            {task.closed_at && <Row label="结束">{formatDateTime(task.closed_at)}</Row>}
            {task.closed_at && <Row label="总耗时">{formatAge(task.created_at, Date.parse(task.closed_at))}</Row>}
          </dl>
        </CardContent>
      </Card>
    </div>
  )
}
