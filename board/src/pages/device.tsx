import { useMutation } from '@tanstack/react-query'
import { CircleCheck, Laptop, LoaderCircle, ShieldAlert } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { AppLogo } from '@/components/layout/app-sidebar'
import { MemberAvatar } from '@/components/member-avatar'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'

/** 设备码统一成大写、去掉空白，保留 ABCD-1234 里的连字符 */
function normalize(code: string) {
  return code.toUpperCase().replace(/\s+/g, '')
}

export default function DevicePage() {
  const [params] = useSearchParams()
  const { member, claims, signOut } = useAuth()
  const [code, setCode] = useState(() => normalize(params.get('code') ?? params.get('user_code') ?? ''))
  const approve = useMutation({ mutationFn: (userCode: string) => api.device.approve(userCode) })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const c = normalize(code)
    if (!c) return
    approve.mutate(c)
  }

  const name = member?.name ?? claims?.name ?? ''

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 px-4 py-10">
      <Link to="/" className="flex items-center gap-2 font-semibold">
        <AppLogo className="size-8" />
        派活 任务榜
      </Link>
      <Card className="w-full max-w-md">
        {approve.isSuccess ? (
          <>
            <CardHeader className="items-center text-center">
              <span className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-success/15 text-success">
                <CircleCheck className="size-6" />
              </span>
              <CardTitle className="text-xl">设备已授权</CardTitle>
              <CardDescription>
                {approve.data.client} @ <span className="font-mono">{approve.data.hostname}</span> 已以 {name} 的身份登录。可以关闭此页面，回到终端继续。
              </CardDescription>
            </CardHeader>
            <CardFooter className="justify-center">
              <Button variant="outline" nativeButton={false} render={<Link to="/people?tab=agents" />}>
                查看我的 Agent
              </Button>
            </CardFooter>
          </>
        ) : (
          <form onSubmit={submit}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl">
                <Laptop className="size-5 text-primary" />
                确认设备登录
              </CardTitle>
              <CardDescription>acp-link（开发者电脑上的接入程序）请求以你的身份登录。请核对终端里显示的设备码。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              <div className="flex items-center gap-3 rounded-lg border p-3">
                <MemberAvatar member={{ name, avatar_url: member?.avatar_url ?? null }} />
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium">{name}</p>
                  <p className="text-xs text-muted-foreground">将以这个账号授权</p>
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={signOut}>
                  切换账号
                </Button>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="user-code">设备码</Label>
                <Input
                  id="user-code"
                  value={code}
                  onChange={(e) => setCode(normalize(e.target.value))}
                  placeholder="ABCD-1234"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-12 text-center font-mono text-2xl tracking-[0.3em] uppercase md:text-2xl"
                  autoFocus={!code}
                />
              </div>
              <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-[color-mix(in_oklch,var(--warning),black_30%)] dark:text-warning">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                只在你本人刚刚运行 acp-link 登录、且设备码一致时才确认。授权后该设备上的 Agent 可以领取派给你的任务。
              </p>
              {approve.isError && (
                <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                  {errorMessage(approve.error)}
                </p>
              )}
            </CardContent>
            <CardFooter className="mt-6 flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" className="w-full sm:w-auto" nativeButton={false} render={<Link to="/" />}>
                取消
              </Button>
              <Button type="submit" className="w-full sm:w-auto" disabled={!code || approve.isPending}>
                {approve.isPending && <LoaderCircle className="animate-spin" />}
                确认登录
              </Button>
            </CardFooter>
          </form>
        )}
      </Card>
    </div>
  )
}
