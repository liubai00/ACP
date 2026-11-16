import { useQuery } from '@tanstack/react-query'
import { Bot, ChevronDown, GitMerge, KeyRound, LoaderCircle, MessageSquare, ShieldCheck, TriangleAlert, Wrench } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { AppLogo } from '@/components/layout/app-sidebar'
import { ModeToggle, ThemeSelector } from '@/components/theme/theme-switcher'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { authApi, errorMessage, IS_MOCK } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { sanitizeRedirect } from '@/lib/token'
import type { LoginResponse } from '@/types/api'

function FeishuIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path fill="currentColor" d="M4.2 6.3c2.9.4 6.4 2.6 9.1 5.3l-2.9 2.9c-2-2.7-4.4-5.6-6.2-8.2Zm9.9 3.9c1.6-1.6 3.6-2.6 5.7-2.9-.7 1.5-1.6 3-2.8 4.2l-3.6 3.6c-1.7 1.7-4.3 2.3-6.6 1.5l1-1 2.6-2.6 3.7-2.8Zm-11 2.6c2.4 3.2 5.3 5.8 8.6 6.9-2.6.8-5.7.5-8.6-1.2v-5.7Z" />
    </svg>
  )
}

const FEATURES = [
  { icon: MessageSquare, text: '在飞书群里 @机器人，用自己的话交办工作或查进度' },
  { icon: Bot, text: '认领后个人 Agent 自动开工，过程实时可见' },
  { icon: GitMerge, text: 'MR、CI 结果自动回到任务，审批后合并' },
  { icon: ShieldCheck, text: '审批卡点和自主等级可控，每一步都留痕' },
]

export default function LoginPage() {
  const [params] = useSearchParams()
  const redirect = sanitizeRedirect(params.get('redirect'))
  const navigate = useNavigate()
  const { isAuthenticated, signIn } = useAuth()
  const providers = useQuery({ queryKey: ['auth-providers'], queryFn: authApi.providers, retry: 1, staleTime: 60_000 })

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [adminOpen, setAdminOpen] = useState(false)
  const [devName, setDevName] = useState('')
  const [devAdmin, setDevAdmin] = useState(false)
  const [pending, setPending] = useState<'local' | 'dev' | 'feishu' | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (isAuthenticated && pending === null) return <Navigate to={redirect} replace />

  const finish = (res: LoginResponse) => {
    signIn(res.token, res.member)
    navigate(redirect, { replace: true })
  }

  const run = async (kind: 'local' | 'dev', fn: () => Promise<LoginResponse>) => {
    setPending(kind)
    setError(null)
    try {
      finish(await fn())
    } catch (err) {
      setError(errorMessage(err))
      setPending(null)
    }
  }

  const onLocal = (e: FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password) {
      setError('请输入用户名和密码')
      return
    }
    void run('local', () => authApi.local(username.trim(), password))
  }

  const onDev = (e: FormEvent) => {
    e.preventDefault()
    if (!devName.trim()) {
      setError('请输入名字')
      return
    }
    void run('dev', () => authApi.dev(devName.trim(), devAdmin))
  }

  const onFeishu = async () => {
    setPending('feishu')
    setError(null)
    if (IS_MOCK) {
      // 示例模式没有真实飞书：模拟一次授权回调，走完整的 /login/callback 流程
      try {
        const res = await authApi.dev('张伟')
        window.location.assign(`/login/callback#token=${encodeURIComponent(res.token)}&redirect=${encodeURIComponent(redirect)}`)
      } catch (err) {
        setError(errorMessage(err))
        setPending(null)
      }
      return
    }
    window.location.assign(authApi.feishuLoginUrl(redirect))
  }

  const p = providers.data
  const nothing = p && !p.feishu && !p.local && !p.dev

  return (
    <div className="relative grid min-h-svh lg:grid-cols-2">
      <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
        <ModeToggle />
        <div className="hidden sm:block">
          <ThemeSelector />
        </div>
      </div>

      {/* 左侧品牌区 */}
      <div className="relative hidden flex-col overflow-hidden bg-primary p-10 text-primary-foreground lg:flex">
        <div
          aria-hidden
          className="absolute inset-0 opacity-25"
          style={{
            backgroundImage: 'radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)',
            backgroundSize: '22px 22px',
            maskImage: 'linear-gradient(to bottom, black, transparent 85%)',
          }}
        />
        <div className="relative flex items-center gap-2 text-lg font-semibold">
          <AppLogo className="size-10 shrink-0" />
          派活 任务榜
        </div>
        {/* 介绍文字在面板里垂直居中，与右侧登录卡片对齐；pb-9 抵消顶部 logo 的高度 */}
        <div className="relative my-auto max-w-lg space-y-8 pb-9">
          <div className="space-y-3">
            <h2 className="text-3xl leading-tight font-bold">把飞书、GitLab 和每个人的 Agent 接成一张可观察的任务网</h2>
            <p className="text-primary-foreground/80">谁在做什么、Agent 说了什么、卡在哪一步等人，都在这一页。</p>
          </div>
          <ul className="space-y-3">
            {FEATURES.map((f) => (
              <li key={f.text} className="flex items-center gap-3 text-sm text-primary-foreground/90">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-foreground/15">
                  <f.icon className="size-4" />
                </span>
                {f.text}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* 右侧登录区 */}
      <div className="flex items-center justify-center px-4 py-16 sm:px-8">
        <div className="w-full max-w-sm space-y-6">
          <div className="flex flex-col items-center gap-2 text-center lg:hidden">
            <AppLogo className="size-10" />
            <span className="text-lg font-semibold">派活 任务榜</span>
          </div>
          <Card>
            <CardHeader className="text-center">
              <CardTitle className="text-xl">登录</CardTitle>
              <CardDescription>使用飞书账号登录任务榜</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              {providers.isPending ? (
                <div className="grid gap-3">
                  <Skeleton className="h-9" />
                  <Skeleton className="h-24" />
                </div>
              ) : providers.error ? (
                <div className="grid gap-3 text-center">
                  <p className="flex items-center justify-center gap-2 text-sm text-danger">
                    <TriangleAlert className="size-4" />
                    无法连接认证服务：{errorMessage(providers.error)}
                  </p>
                  <Button variant="outline" onClick={() => void providers.refetch()}>
                    重试
                  </Button>
                </div>
              ) : (
                <>
                  {p?.feishu && (
                    <Button size="lg" className="h-11 w-full bg-[#3370ff] text-white hover:bg-[#3370ff]/90" onClick={() => void onFeishu()} disabled={pending !== null}>
                      {pending === 'feishu' ? <LoaderCircle className="animate-spin" /> : <FeishuIcon className="size-5" />}
                      飞书登录
                    </Button>
                  )}

                  {p?.local && (
                    <Collapsible
                      open={adminOpen || !p.feishu}
                      onOpenChange={(open) => {
                        setAdminOpen(open)
                        setError(null)
                      }}
                    >
                      {p.feishu && (
                        <CollapsibleTrigger
                          render={<Button variant="ghost" className="w-full text-muted-foreground" />}
                          disabled={pending !== null}
                        >
                          <KeyRound className="size-4" />
                          管理员登录
                          <ChevronDown className={`size-4 transition-transform motion-reduce:transition-none ${adminOpen ? 'rotate-180' : ''}`} />
                        </CollapsibleTrigger>
                      )}
                      <CollapsibleContent>
                        <form onSubmit={onLocal} className={`grid gap-3 ${p.feishu ? 'pt-4' : ''}`}>
                          <div className="grid gap-1.5">
                            <Label htmlFor="username">用户名</Label>
                            <Input id="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" />
                          </div>
                          <div className="grid gap-1.5">
                            <Label htmlFor="password">密码</Label>
                            <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                          </div>
                          <Button type="submit" variant={p.feishu ? 'outline' : 'default'} disabled={pending !== null}>
                            {pending === 'local' ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
                            登录管理账号
                          </Button>
                          <p className="text-xs text-muted-foreground">本地管理员仅用于首次部署引导，日常请用飞书登录。</p>
                        </form>
                      </CollapsibleContent>
                    </Collapsible>
                  )}

                  {p?.dev && (
                    <>
                      <OrDivider text="开发模式" />
                      <form onSubmit={onDev} className="grid gap-3">
                        <div className="grid gap-1.5">
                          <Label htmlFor="dev-name">名字</Label>
                          <Input id="dev-name" value={devName} onChange={(e) => setDevName(e.target.value)} placeholder="如：张伟（不存在会自动创建）" />
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox id="dev-admin" checked={devAdmin} onCheckedChange={(v) => setDevAdmin(v === true)} />
                          <Label htmlFor="dev-admin" className="text-sm font-normal text-muted-foreground">
                            以管理员身份登录
                          </Label>
                        </div>
                        <Button type="submit" variant="secondary" disabled={pending !== null}>
                          {pending === 'dev' ? <LoaderCircle className="animate-spin" /> : <Wrench />}
                          开发登录
                        </Button>
                      </form>
                    </>
                  )}

                  {nothing && <p className="text-center text-sm text-muted-foreground">服务端没有启用任何登录方式，请联系管理员检查 coordinator 配置。</p>}
                </>
              )}
              {error && (
                <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                  {error}
                </p>
              )}
            </CardContent>
          </Card>
          {IS_MOCK && (
            <p className="text-center text-xs text-muted-foreground">
              示例模式：数据来自前端内置模拟层。飞书登录将以「张伟（管理员）」身份进入；管理员账号 admin / admin。
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function OrDivider({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3">
      <Separator className="flex-1" />
      <span className="text-xs text-muted-foreground">{text}</span>
      <Separator className="flex-1" />
    </div>
  )
}
