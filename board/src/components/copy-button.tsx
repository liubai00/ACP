import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'

export function CopyButton({
  text,
  label = '复制',
  className,
  size = 'sm',
  variant = 'outline',
}: {
  text: string
  label?: string
  className?: string
  size?: 'sm' | 'xs' | 'icon-sm'
  variant?: 'outline' | 'ghost' | 'secondary' | 'default'
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      className={cn('shrink-0', className)}
      aria-label={label}
      onClick={async () => {
        if (await copyText(text)) setCopied(true)
        else toast.error('复制失败，请手动选中文本复制')
      }}
    >
      {copied ? <Check className="text-success" /> : <Copy />}
      {size !== 'icon-sm' && (copied ? '已复制' : label)}
    </Button>
  )
}

/** 带复制按钮的代码块 */
export function CodeBlock({ code, label, className, wrap = false }: { code: string; label?: string; className?: string; wrap?: boolean }) {
  return (
    <div className={cn('overflow-hidden rounded-lg border bg-muted/40', className)}>
      {label && (
        <div className="flex items-center justify-between gap-2 border-b bg-muted/60 px-3 py-1.5">
          <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
          <CopyButton text={code} size="xs" variant="ghost" />
        </div>
      )}
      <pre className={cn('overflow-x-auto px-3 py-2.5 font-mono text-xs leading-relaxed', wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre')}>{code}</pre>
    </div>
  )
}
