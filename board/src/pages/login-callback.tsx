import { LoaderCircle, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'
import { decodeJwt, isTokenExpired, sanitizeRedirect } from '@/lib/token'

/** 解析 /login/callback#token=<JWT>&redirect=<路径>（令牌放在 fragment 里，不会发到服务器日志） */
function parseFragment(hash: string) {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  return {
    token: params.get('token'),
    redirect: sanitizeRedirect(params.get('redirect')),
    error: params.get('error_description') ?? params.get('message') ?? params.get('error'),
  }
}

export default function LoginCallbackPage() {
  const navigate = useNavigate()
  const { signIn } = useAuth()
  const [failure, setFailure] = useState<string | null>(null)
  const handled = useRef(false)

  useEffect(() => {
    if (handled.current) return
    handled.current = true
    const { token, redirect, error } = parseFragment(window.location.hash)
    // 立即清掉地址栏里的令牌
    window.history.replaceState(null, '', window.location.pathname)
    if (!token) {
      queueMicrotask(() => setFailure(error ?? '登录回调里没有令牌'))
      return
    }
    const claims = decodeJwt(token)
    if (!claims || isTokenExpired(claims)) {
      queueMicrotask(() => setFailure('令牌无效或已过期，请重新登录'))
      return
    }
    signIn(token)
    navigate(redirect, { replace: true })
  }, [navigate, signIn])

  if (failure) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-4 px-4 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-danger/10 text-danger">
          <TriangleAlert className="size-6" />
        </span>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">登录没有完成</h1>
          <p className="text-sm text-muted-foreground">{failure}</p>
        </div>
        <Button nativeButton={false} render={<Link to="/login" replace />}>返回登录页</Button>
      </div>
    )
  }

  return (
    <div className="flex min-h-svh items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
      <LoaderCircle className="size-4 animate-spin" />
      正在完成登录…
    </div>
  )
}
