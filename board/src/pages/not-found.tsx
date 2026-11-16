import { ArrowLeft, Compass } from 'lucide-react'
import { Link, useLocation } from 'react-router'
import { Button } from '@/components/ui/button'

export default function NotFoundPage() {
  const { pathname } = useLocation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center">
      <div className="relative">
        <span className="text-8xl font-black tracking-tighter text-muted-foreground/20 select-none">404</span>
        <Compass className="absolute inset-0 m-auto size-12 text-primary" />
      </div>
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">页面不存在</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          没有找到 <code className="rounded bg-muted px-1 font-mono text-xs">{pathname}</code>，可能链接已失效或输入有误。
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => window.history.back()}>
          <ArrowLeft />
          返回上一页
        </Button>
        <Button nativeButton={false} render={<Link to="/" />}>回到项目全貌</Button>
      </div>
    </div>
  )
}
