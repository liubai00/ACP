import { Fragment } from 'react'
import { Link, useLocation } from 'react-router'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { ALL_NAV_ITEMS } from '@/config/nav'

interface Crumb {
  title: string
  url?: string
}

function crumbsFor(pathname: string): Crumb[] {
  if (pathname === '/') return [{ title: '项目全貌' }]
  const taskMatch = pathname.match(/^\/tasks\/(\d+)/)
  if (taskMatch) return [{ title: '查找任务', url: '/tasks' }, { title: `ACP-${taskMatch[1]}` }]
  const nav = ALL_NAV_ITEMS.find((n) => n.url !== '/' && (pathname === n.url || pathname.startsWith(`${n.url}/`)))
  if (nav) return [{ title: nav.title }]
  if (pathname.startsWith('/account/tokens')) return [{ title: '个人令牌' }]
  return [{ title: '页面不存在' }]
}

export function Breadcrumbs() {
  const { pathname } = useLocation()
  const crumbs = crumbsFor(pathname)
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem className="hidden md:inline-flex">
          <BreadcrumbLink render={<Link to="/" />}>派活</BreadcrumbLink>
        </BreadcrumbItem>
        {crumbs.map((c, i) => (
          <Fragment key={`${c.title}-${i}`}>
            <BreadcrumbSeparator className="hidden md:block" />
            <BreadcrumbItem className={i < crumbs.length - 1 ? 'hidden md:inline-flex' : 'truncate'}>
              {c.url && i < crumbs.length - 1 ? (
                <BreadcrumbLink render={<Link to={c.url} />}>{c.title}</BreadcrumbLink>
              ) : (
                <BreadcrumbPage>{c.title}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
