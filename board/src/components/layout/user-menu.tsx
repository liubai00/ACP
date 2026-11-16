import { ChevronsUpDown, KeyRound, LogOut, Moon, Palette, Sun, UserRound } from 'lucide-react'
import { useNavigate } from 'react-router'
import { MemberAvatar } from '@/components/member-avatar'
import { THEMES, isThemeName } from '@/components/theme/theme-config'
import { useTheme } from '@/components/theme/theme-provider'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenuButton } from '@/components/ui/sidebar'
import { useAuth } from '@/lib/auth'
import { ROLE_LABEL } from '@/lib/labels'

function Identity() {
  const { member, claims } = useAuth()
  const name = member?.name ?? claims?.name ?? '未登录'
  const roles = (member?.roles ?? claims?.roles ?? []).filter((r) => r !== 'member')
  return (
    <>
      <MemberAvatar member={{ name, avatar_url: member?.avatar_url ?? null }} className="size-8 rounded-lg after:rounded-lg *:rounded-lg" />
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {member?.team ? `${member.team} · ` : ''}
          {roles.length ? roles.map((r) => ROLE_LABEL[r] ?? r).join('、') : '成员'}
        </span>
      </div>
    </>
  )
}

function MenuBody({ side = 'bottom' }: { side?: 'bottom' | 'right' }) {
  const { signOut } = useAuth()
  const { theme, setTheme, resolvedMode, toggleMode } = useTheme()
  const navigate = useNavigate()
  return (
    <DropdownMenuContent className="w-(--anchor-width) min-w-56 rounded-lg" side={side} align="end" sideOffset={4}>
      <DropdownMenuGroup>
        <DropdownMenuLabel className="p-0 font-normal">
          <div className="flex items-center gap-2 px-1 py-1.5 text-foreground">
            <Identity />
          </div>
        </DropdownMenuLabel>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem
          onClick={() => navigate('/tasks?assignee=me')}
        >
          <UserRound />
          我负责的任务
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate('/account/tokens')}>
          <KeyRound />
          个人令牌
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => toggleMode()}>
          {resolvedMode === 'dark' ? <Sun /> : <Moon />}
          {resolvedMode === 'dark' ? '切换为亮色' : '切换为暗色'}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette />
            配色主题
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-40">
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(v) => {
                if (typeof v === 'string' && isThemeName(v)) setTheme(v)
              }}
            >
              {THEMES.map((t) => (
                <DropdownMenuRadioItem key={t.value} value={t.value}>
                  {t.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={signOut}>
        <LogOut />
        退出登录
      </DropdownMenuItem>
    </DropdownMenuContent>
  )
}

/** 侧边栏底部的用户菜单 */
export function SidebarUserMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton
            size="lg"
            className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
          />
        }
      >
        <Identity />
        <ChevronsUpDown className="ml-auto size-4" />
      </DropdownMenuTrigger>
      <MenuBody />
    </DropdownMenu>
  )
}

/** 头部右上角的头像菜单 */
export function HeaderUserMenu() {
  const { member, claims } = useAuth()
  const name = member?.name ?? claims?.name ?? ''
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<button type="button" className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50" aria-label="用户菜单" />}
      >
        <MemberAvatar member={{ name, avatar_url: member?.avatar_url ?? null }} />
      </DropdownMenuTrigger>
      <MenuBody />
    </DropdownMenu>
  )
}
