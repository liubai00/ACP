/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  DEFAULT_THEME,
  isThemeName,
  MODE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type ThemeMode,
  type ThemeName,
} from './theme-config'

interface ThemeContextValue {
  theme: ThemeName
  setTheme: (theme: ThemeName) => void
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  resolvedMode: 'light' | 'dark'
  /** 切换明暗，带圆形展开动画（从点击位置展开） */
  toggleMode: (origin?: { x: number; y: number }) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

const media = () => window.matchMedia('(prefers-color-scheme: dark)')

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>(() => {
    const stored = read(THEME_STORAGE_KEY)
    return isThemeName(stored) ? stored : DEFAULT_THEME
  })
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const stored = read(MODE_STORAGE_KEY)
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
  })
  const [systemDark, setSystemDark] = useState(() => media().matches)

  useEffect(() => {
    const mq = media()
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const resolvedMode: 'light' | 'dark' = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode

  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', resolvedMode === 'dark')
    root.style.colorScheme = resolvedMode
  }, [resolvedMode])

  const setTheme = useCallback((value: ThemeName) => {
    write(THEME_STORAGE_KEY, value)
    setThemeState(value)
  }, [])

  const setMode = useCallback((value: ThemeMode) => {
    write(MODE_STORAGE_KEY, value)
    setModeState(value)
  }, [])

  const toggleMode = useCallback(
    (origin?: { x: number; y: number }) => {
      const next = resolvedMode === 'dark' ? 'light' : 'dark'
      const apply = () => {
        // 同步改 DOM，保证 View Transition 截到新画面
        document.documentElement.classList.toggle('dark', next === 'dark')
        document.documentElement.style.colorScheme = next
        setMode(next)
      }
      const root = document.documentElement
      root.style.setProperty('--x', origin ? `${origin.x}px` : '50%')
      root.style.setProperty('--y', origin ? `${origin.y}px` : '50%')
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (!reduced && typeof document.startViewTransition === 'function') {
        document.startViewTransition(apply)
      } else {
        apply()
      }
    },
    [resolvedMode, setMode],
  )

  const value = useMemo(
    () => ({ theme, setTheme, mode, setMode, resolvedMode, toggleMode }),
    [theme, setTheme, mode, setMode, resolvedMode, toggleMode],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用')
  return ctx
}
