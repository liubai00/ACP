/* eslint-disable react-refresh/only-export-components */
import { useQuery } from '@tanstack/react-query'
import { KeyRound, LoaderCircle, Moon, Palette, Plus, Search, Sun } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { StateBadge } from '@/components/status-badge'
import { useNewTaskDialog } from '@/components/tasks/new-task-dialog'
import { THEMES } from '@/components/theme/theme-config'
import { useTheme } from '@/components/theme/theme-provider'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { ALL_NAV_ITEMS } from '@/config/nav'
import { useDebouncedValue } from '@/hooks/use-debounce'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'

const CommandPaletteContext = createContext<{ open: () => void } | null>(null)

export function useCommandPalette() {
  const ctx = useContext(CommandPaletteContext)
  if (!ctx) throw new Error('useCommandPalette 必须在 CommandPaletteProvider 内使用')
  return ctx
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const debounced = useDebouncedValue(query.trim(), 250)
  const navigate = useNavigate()
  const { hasRole } = useAuth()
  const { setTheme, toggleMode, resolvedMode } = useTheme()
  const newTask = useNewTaskDialog()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const tasksQuery = useQuery({
    queryKey: ['palette-tasks', debounced],
    queryFn: ({ signal }) => api.tasks.list({ q: debounced, page_size: 8, sort: '-updated_at' }, signal),
    enabled: open && debounced.length > 0,
    staleTime: 10_000,
  })

  const run = useCallback((fn: () => void) => {
    setOpen(false)
    setQuery('')
    fn()
  }, [])

  const navItems = useMemo(() => ALL_NAV_ITEMS.filter((n) => !n.role || hasRole(n.role)), [hasRole])
  const ctx = useMemo(() => ({ open: () => setOpen(true) }), [])
  const taskHits = debounced ? (tasksQuery.data?.items ?? []) : []

  return (
    <CommandPaletteContext.Provider value={ctx}>
      {children}
      <CommandDialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v)
          if (!v) setQuery('')
        }}
        className="sm:max-w-xl"
      >
        <Command>
          <CommandInput placeholder="搜索任务编号、标题，或跳转页面…" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-[min(60vh,420px)]">
            {taskHits.length === 0 && <CommandEmpty>{tasksQuery.isFetching ? '搜索中…' : '没有找到匹配的内容'}</CommandEmpty>}
            {debounced && (tasksQuery.isFetching || taskHits.length > 0) && (
              <CommandGroup forceMount heading={tasksQuery.isFetching ? '任务（搜索中…）' : '任务'}>
                {tasksQuery.isFetching && taskHits.length === 0 && (
                  <CommandItem disabled forceMount value="__loading">
                    <LoaderCircle className="animate-spin" />
                    正在搜索…
                  </CommandItem>
                )}
                {taskHits.map((t) => (
                  <CommandItem
                    key={t.id}
                    value={`task-${t.id} ${t.key} ${t.title}`}
                    forceMount
                    onSelect={() => run(() => navigate(`/tasks/${t.id}`))}
                  >
                    <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">{t.key}</span>
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    <StateBadge state={t.state} className="shrink-0" />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup heading="页面">
              {navItems.map((item) => (
                <CommandItem
                  key={item.url}
                  value={`nav ${item.title}`}
                  keywords={item.keywords}
                  onSelect={() => run(() => navigate(item.url))}
                >
                  <item.icon />
                  {item.title}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="操作">
              <CommandItem value="action 个人令牌" keywords={['token', 'mcp', 'claude', 'codex', '令牌']} onSelect={() => run(() => navigate('/account/tokens'))}>
              <KeyRound />
              个人令牌
            </CommandItem>
            <CommandItem value="action 新建任务" keywords={['new', 'create', '发布']} onSelect={() => run(() => newTask.open())}>
                <Plus />
                新建任务
              </CommandItem>
              <CommandItem value="action 切换明暗" keywords={['dark', 'light', '暗色', '亮色', '主题']} onSelect={() => run(() => toggleMode())}>
                {resolvedMode === 'dark' ? <Sun /> : <Moon />}
                切换为{resolvedMode === 'dark' ? '亮色' : '暗色'}
                <CommandShortcut>Ctrl ⇧ D</CommandShortcut>
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="配色主题">
              {THEMES.map((t) => (
                <CommandItem key={t.value} value={`theme ${t.name}`} keywords={['theme', '主题', '配色']} onSelect={() => run(() => setTheme(t.value))}>
                  <Palette />
                  {t.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </CommandPaletteContext.Provider>
  )
}

/** 头部的搜索框样式按钮 */
export function SearchTrigger({ className }: { className?: string }) {
  const { open } = useCommandPalette()
  return (
    <button
      type="button"
      onClick={open}
      className={cn(
        'relative inline-flex h-8 w-full items-center gap-2 rounded-lg border border-input bg-background px-2.5 text-sm text-muted-foreground shadow-xs transition-colors hover:bg-muted dark:bg-input/30 dark:hover:bg-input/50 sm:w-56 lg:w-64',
        className,
      )}
    >
      <Search className="size-4" />
      <span className="flex-1 truncate text-left">搜索任务或页面…</span>
      <Kbd className="hidden sm:inline-flex">Ctrl K</Kbd>
    </button>
  )
}
