/* eslint-disable react-refresh/only-export-components */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { api, ApiError, authApi, onUnauthorized } from '@/lib/api'
import { qk } from '@/lib/queries'
import { decodeJwt, isTokenExpired, tokenStore } from '@/lib/token'
import type { JwtClaims, Member } from '@/types/api'

interface AuthContextValue {
  token: string | null
  claims: JwtClaims | null
  member: Member | null
  /** 有令牌、正在拉取 /api/me */
  loading: boolean
  isAuthenticated: boolean
  roles: string[]
  hasRole: (role: string) => boolean
  isAdmin: boolean
  /** 登录成功后调用：保存令牌 */
  signIn: (token: string, member?: Member) => void
  signOut: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

/** 距离过期少于这个时长时自动刷新令牌 */
const REFRESH_THRESHOLD_MS = 24 * 3600 * 1000
const REFRESH_CHECK_MS = 10 * 60 * 1000

export function loginPath(redirect?: string) {
  return redirect && redirect !== '/' ? `/login?redirect=${encodeURIComponent(redirect)}` : '/login'
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const [token, setToken] = useState<string | null>(() => {
    const t = tokenStore.get()
    if (t && isTokenExpired(decodeJwt(t))) {
      tokenStore.clear()
      return null
    }
    return t
  })

  useEffect(() => tokenStore.subscribe(setToken), [])

  // 其他标签页登录/退出时同步
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === 'acp_token') setToken(tokenStore.get())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // 401：清理缓存并去登录页，带上当前路径
  useEffect(
    () =>
      onUnauthorized(() => {
        client.clear()
        const here = window.location.pathname + window.location.search
        if (!window.location.pathname.startsWith('/login')) {
          navigate(loginPath(here), { replace: true })
        }
      }),
    [client, navigate],
  )

  const claims = useMemo(() => decodeJwt(token), [token])

  const meQuery = useQuery({
    queryKey: qk.me,
    queryFn: api.me,
    enabled: !!token,
    staleTime: 5 * 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
  })

  // 定时刷新令牌
  useEffect(() => {
    if (!token) return
    const check = async () => {
      const c = decodeJwt(tokenStore.get())
      if (!c?.exp) return
      if (c.exp * 1000 - Date.now() < REFRESH_THRESHOLD_MS) {
        try {
          const res = await authApi.refresh()
          tokenStore.set(res.token)
        } catch {
          /* 刷新失败不打断使用，真正过期时由 401 处理 */
        }
      }
    }
    void check()
    const timer = setInterval(() => void check(), REFRESH_CHECK_MS)
    return () => clearInterval(timer)
  }, [token])

  const signIn = useCallback(
    (newToken: string, member?: Member) => {
      client.clear()
      tokenStore.set(newToken)
      if (member) client.setQueryData(qk.me, { member })
    },
    [client],
  )

  const signOut = useCallback(() => {
    tokenStore.clear()
    client.clear()
    navigate('/login', { replace: true })
  }, [client, navigate])

  const member = token ? (meQuery.data?.member ?? null) : null
  const roles = useMemo(() => member?.roles ?? claims?.roles ?? [], [member, claims])

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      claims,
      member,
      loading: !!token && meQuery.isPending,
      isAuthenticated: !!token,
      roles,
      hasRole: (role: string) => roles.includes(role),
      isAdmin: roles.includes('admin'),
      signIn,
      signOut,
    }),
    [token, claims, member, meQuery.isPending, roles, signIn, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}
