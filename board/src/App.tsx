import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router'
import { AppLayout, FullPageSpinner, RequireAuth } from '@/components/layout/app-layout'
import { ThemeProvider } from '@/components/theme/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ApiError } from '@/lib/api'
import { AuthProvider } from '@/lib/auth'
import { PageSkeleton } from '@/components/page-skeleton'

const OverviewPage = lazy(() => import('@/pages/overview'))
const TasksPage = lazy(() => import('@/pages/tasks'))
const BoardPage = lazy(() => import('@/pages/board'))
const TaskDetailPage = lazy(() => import('@/pages/task-detail'))
const SourcesPage = lazy(() => import('@/pages/sources'))
const PeoplePage = lazy(() => import('@/pages/people'))
const WorkflowsPage = lazy(() => import('@/pages/workflows'))
const SettingsPage = lazy(() => import('@/pages/settings'))
const LoginPage = lazy(() => import('@/pages/login'))
const LoginCallbackPage = lazy(() => import('@/pages/login-callback'))
const DevicePage = lazy(() => import('@/pages/device'))
const NotFoundPage = lazy(() => import('@/pages/not-found'))
const AccountTokensPage = lazy(() => import('@/pages/account-tokens'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
        return count < 2
      },
    },
    mutations: { retry: false },
  },
})

function Page({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageSkeleton />}>{children}</Suspense>
}

export default function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <TooltipProvider delay={300}>
              <Routes>
                <Route
                  path="/login"
                  element={
                    <Suspense fallback={<FullPageSpinner />}>
                      <LoginPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/login/callback"
                  element={
                    <Suspense fallback={<FullPageSpinner />}>
                      <LoginCallbackPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/device"
                  element={
                    <RequireAuth>
                      <Suspense fallback={<FullPageSpinner />}>
                        <DevicePage />
                      </Suspense>
                    </RequireAuth>
                  }
                />
                <Route element={<AppLayout />}>
                  <Route index element={<Page><OverviewPage /></Page>} />
                  <Route path="tasks" element={<Page><TasksPage /></Page>} />
                  <Route path="tasks/:id" element={<Page><TaskDetailPage /></Page>} />
                  <Route path="board" element={<Page><BoardPage /></Page>} />
                  <Route path="sources" element={<Page><SourcesPage /></Page>} />
                  <Route path="people" element={<Page><PeoplePage /></Page>} />
                  <Route path="workflows" element={<Page><WorkflowsPage /></Page>} />
                  <Route path="settings" element={<Page><SettingsPage /></Page>} />
                  <Route path="account/tokens" element={<Page><AccountTokensPage /></Page>} />
                  <Route path="*" element={<Page><NotFoundPage /></Page>} />
                </Route>
              </Routes>
            </TooltipProvider>
            <Toaster position="top-center" richColors closeButton />
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  )
}
