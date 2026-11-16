import { Bot } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { initials } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { MemberRef } from '@/types/api'

/** 按名字生成稳定的柔和底色 */
function hueOf(text: string) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360
  return h
}

export function MemberAvatar({
  member,
  size = 'default',
  className,
  tooltip = false,
}: {
  member: Pick<MemberRef, 'name' | 'avatar_url'> | null | undefined
  size?: 'sm' | 'default' | 'lg'
  className?: string
  tooltip?: boolean
}) {
  const name = member?.name ?? '未分配'
  const hue = hueOf(name)
  const avatar = (
    <Avatar size={size} className={className}>
      {member?.avatar_url ? <AvatarImage src={member.avatar_url} alt={name} /> : null}
      <AvatarFallback
        className={cn('font-medium', !member && 'border border-dashed border-muted-foreground/40 bg-transparent')}
        style={
          member
            ? {
                backgroundColor: `oklch(0.9 0.05 ${hue})`,
                color: `oklch(0.38 0.09 ${hue})`,
              }
            : undefined
        }
      >
        <span className={cn(size === 'sm' ? 'text-[10px]' : 'text-xs')}>{member ? initials(name) : '?'}</span>
      </AvatarFallback>
    </Avatar>
  )
  if (!tooltip) return avatar
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{avatar}</TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  )
}

/** 头像 + 名字 */
export function MemberChip({
  member,
  fallback = '未分配',
  className,
}: {
  member: MemberRef | null | undefined
  fallback?: string
  className?: string
}) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      <MemberAvatar member={member} size="sm" />
      <span className={cn('truncate text-sm', !member && 'text-muted-foreground')}>{member?.name ?? fallback}</span>
    </span>
  )
}

export function AgentChip({
  agent,
  className,
}: {
  agent: { name: string; kind?: string } | null | undefined
  className?: string
}) {
  if (!agent) return null
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground', className)}>
      <Bot className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate font-mono">{agent.name}</span>
    </span>
  )
}
