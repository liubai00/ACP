import { Moon, Palette, Sun } from 'lucide-react'
import { useEffect, type MouseEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { THEMES, isThemeName } from './theme-config'
import { useTheme } from './theme-provider'

const THEME_ITEMS = THEMES.map((t) => ({ value: t.value, label: t.name }))

/** 头部的主题下拉（Discord / Claude / Supabase …） */
export function ThemeSelector() {
  const { theme, setTheme } = useTheme()
  return (
    <Select
      items={THEME_ITEMS}
      value={theme}
      onValueChange={(value) => {
        if (typeof value === 'string' && isThemeName(value)) setTheme(value)
      }}
    >
      <SelectTrigger aria-label="配色主题" className="justify-start *:data-[slot=select-value]:w-24">
        <Palette className="text-muted-foreground" />
        <SelectValue placeholder="选择主题" />
      </SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false}>
        <SelectGroup>
          <SelectLabel>配色主题</SelectLabel>
          {THEMES.map((t) => (
            <SelectItem key={t.value} value={t.value}>
              {t.name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

/** 明暗切换按钮，快捷键 Ctrl/⌘ + Shift + D */
export function ModeToggle() {
  const { resolvedMode, toggleMode } = useTheme()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'd' || !e.shiftKey || !(e.metaKey || e.ctrlKey)) return
      if (isTypingTarget(e.target)) return
      e.preventDefault()
      toggleMode()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleMode])

  const onClick = (e: MouseEvent<HTMLButtonElement>) => toggleMode({ x: e.clientX, y: e.clientY })

  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="secondary" size="icon" className="size-8" onClick={onClick} />}>
        {resolvedMode === 'dark' ? <Sun /> : <Moon />}
        <span className="sr-only">切换明暗</span>
      </TooltipTrigger>
      <TooltipContent>
        切换{resolvedMode === 'dark' ? '亮色' : '暗色'} <Kbd>Ctrl ⇧ D</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}
