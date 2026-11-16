import { LoaderCircle } from 'lucide-react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { CommandPaletteProvider } from '@/components/command-palette'
import { NewTaskDialogProvider } from '@/components/tasks/new-task-dialog'
import { SIDEBAR_STORAGE_KEY, SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { loginPath, useAuth } from '@/lib/auth'
import { AppSidebar } from './app-sidebar'
import { Header } from './header'

function readSidebarOpen() {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

export function FullPageSpinner({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="flex min-h-svh items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
      <LoaderCircle className="size-4 animate-spin" />
      {label}
    </div>
  )
}

/** 需要登录的路由：没有令牌就去 /login，并记住当前路径 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth()
  const location = useLocation()
  if (!isAuthenticated) {
    return <Navigate to={loginPath(location.pathname + location.search)} replace />
  }
  if (loading) return <FullPageSpinner />
  return <>{children}</>
}

export function AppLayout() {
  return (
    <RequireAuth>
      <NewTaskDialogProvider>
        <CommandPaletteProvider>
          <SidebarProvider defaultOpen={readSidebarOpen()}>
            <a
              href="#main-content"
              className="sr-only rounded-md bg-background px-3 py-2 text-sm font-medium shadow ring-ring focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:ring-2"
            >
              跳到正文
            </a>
            <AppSidebar />
            <SidebarInset id="main-content" tabIndex={-1} className="min-w-0 scroll-mt-16">
              <Header />
              <Outlet />
            </SidebarInset>
          </SidebarProvider>
        </CommandPaletteProvider>
      </NewTaskDialogProvider>
    </RequireAuth>
  )
}
