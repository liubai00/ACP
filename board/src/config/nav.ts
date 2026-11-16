import type { LucideIcon } from 'lucide-react'
import { Cable, LayoutDashboard, ListTodo, Settings, SquareKanban, Users, Workflow } from 'lucide-react'

export interface NavItem {
  title: string
  url: string
  icon: LucideIcon
  /** 只对拥有该角色的用户显示 */
  role?: string
  /** 命令面板搜索用的别名 */
  keywords?: string[]
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: '概览',
    items: [{ title: '项目全貌', url: '/', icon: LayoutDashboard, keywords: ['首页', '总览', 'overview', 'dashboard'] }],
  },
  {
    label: '任务',
    items: [
      { title: '查找任务', url: '/tasks', icon: ListTodo, keywords: ['任务列表', 'tasks', 'search'] },
      { title: '任务进展', url: '/board', icon: SquareKanban, keywords: ['看板', 'kanban', 'board'] },
    ],
  },
  {
    label: '协作',
    items: [
      { title: '数据来源', url: '/sources', icon: Cable, keywords: ['飞书', 'gitlab', 'sources', '事件'] },
      { title: '负责人', url: '/people', icon: Users, keywords: ['成员', 'agent', 'people', '在线'] },
      { title: '自动化流程', url: '/workflows', icon: Workflow, keywords: ['n8n', 'workflows', '执行'] },
    ],
  },
  {
    label: '系统',
    items: [{ title: '设置', url: '/settings', icon: Settings, role: 'admin', keywords: ['settings', '自主等级', '配置'] }],
  },
]

export const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items)

export function isNavActive(pathname: string, url: string) {
  if (url === '/') return pathname === '/'
  return pathname === url || pathname.startsWith(`${url}/`)
}
