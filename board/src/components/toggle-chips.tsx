import { cn } from '@/lib/utils'

/** 小号分段切换（全部 / 消息 / 事件 这类） */
export function ToggleChips<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string }[]
  className?: string
}) {
  return (
    <div role="radiogroup" className={cn('inline-flex items-center rounded-lg bg-muted p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-6 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground',
            value === o.value && 'bg-background text-foreground shadow-xs dark:bg-input/40',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
