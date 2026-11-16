import { Link, useLocation } from 'react-router'
import appLogo from '@/assets/acp-logo.png'
import { Badge } from '@/components/ui/badge'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { NAV_GROUPS, isNavActive } from '@/config/nav'
import { IS_MOCK } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useOverview } from '@/lib/queries'
import { SidebarUserMenu } from './user-menu'

export function AppLogo({ className }: { className?: string }) {
  return (
    <div className={className}>
      <img src={appLogo} alt="" aria-hidden className="size-full object-contain" width={256} height={256} />
    </div>
  )
}

export function AppSidebar() {
  const { pathname } = useLocation()
  const { hasRole } = useAuth()
  const { isMobile, setOpenMobile } = useSidebar()
  const overview = useOverview()
  const byState = overview.data?.counts.by_state

  // 侧边栏数字：待处理的事项
  const badges: Record<string, number | undefined> = {
    '/board': byState ? byState['input-required'] + byState['auth-required'] : undefined,
    '/tasks': byState ? byState.submitted : undefined,
  }

  const closeOnMobile = () => {
    if (isMobile) setOpenMobile(false)
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="group-data-[collapsible=icon]:pt-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/" onClick={closeOnMobile} />} tooltip="派活 任务榜">
              <AppLogo className="flex aspect-square size-8 shrink-0" />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">派活 任务榜</span>
                <span className="truncate text-xs text-muted-foreground">多 Agent 协作平台</span>
              </div>
              {IS_MOCK && (
                <Badge variant="outline" className="ml-auto text-[10px]">
                  示例数据
                </Badge>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="overflow-x-hidden">
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter((item) => !item.role || hasRole(item.role))
          if (items.length === 0) return null
          return (
            <SidebarGroup key={group.label} className="py-0">
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarMenu>
                {items.map((item) => {
                  const badge = badges[item.url]
                  return (
                    <SidebarMenuItem key={item.url}>
                      <SidebarMenuButton
                        render={<Link to={item.url} onClick={closeOnMobile} />}
                        tooltip={item.title}
                        isActive={isNavActive(pathname, item.url)}
                      >
                        <item.icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                      {badge ? <SidebarMenuBadge>{badge}</SidebarMenuBadge> : null}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroup>
          )
        })}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarUserMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
