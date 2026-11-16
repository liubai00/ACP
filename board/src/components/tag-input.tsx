import { X } from 'lucide-react'
import { useId, useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'

/** 简单的标签输入：回车或逗号添加，退格删除最后一个；suggestions 作为浏览器原生候选 */
export function TagInput({
  value,
  onChange,
  placeholder,
  suggestions = [],
  id,
  className,
  mono = false,
  'aria-label': ariaLabel,
}: {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  suggestions?: string[]
  id?: string
  className?: string
  mono?: boolean
  'aria-label'?: string
}) {
  const [draft, setDraft] = useState('')
  const listId = useId()

  const add = (raw: string) => {
    const parts = raw
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length === 0) return
    const next = [...value]
    for (const p of parts) if (!next.includes(p)) next.push(p)
    onChange(next)
    setDraft('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      if (draft.trim()) {
        e.preventDefault()
        add(draft)
      }
    } else if (e.key === 'Backspace' && !draft && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  const remaining = suggestions.filter((s) => !value.includes(s))

  return (
    <div
      className={cn(
        'flex min-h-8 w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-1.5 py-1 text-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30',
        className,
      )}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className={cn('inline-flex h-6 items-center gap-1 rounded-md bg-secondary px-1.5 text-xs text-secondary-foreground', mono && 'font-mono')}
        >
          {tag}
          <button
            type="button"
            className="rounded-sm opacity-60 hover:opacity-100"
            aria-label={`移除 ${tag}`}
            onClick={() => onChange(value.filter((v) => v !== tag))}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        aria-label={ariaLabel}
        list={remaining.length ? listId : undefined}
        value={draft}
        onChange={(e) => {
          const v = e.target.value
          // 从候选列表里选中时直接添加
          if (remaining.includes(v)) add(v)
          else setDraft(v)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => draft.trim() && add(draft)}
        placeholder={value.length === 0 ? placeholder : undefined}
        className="h-6 min-w-24 flex-1 bg-transparent px-1 outline-none placeholder:text-muted-foreground"
      />
      {remaining.length > 0 && (
        <datalist id={listId}>
          {remaining.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  )
}
