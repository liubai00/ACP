/**
 * 主题列表与默认主题。配色来自 Kiranism/next-shadcn-dashboard-starter（MIT），
 * 每个主题对应 src/styles/themes/<value>.css。
 */
export const DEFAULT_THEME = 'discord'

export const THEMES = [
  { name: 'Discord', value: 'discord' },
  { name: 'Claude', value: 'claude' },
  { name: 'Supabase', value: 'supabase' },
  { name: 'Vercel', value: 'vercel' },
  { name: 'Mono', value: 'mono' },
  { name: 'Notebook', value: 'notebook' },
  { name: 'Light Green', value: 'light-green' },
  { name: 'Zen', value: 'zen' },
  { name: 'Astro Vista', value: 'astro-vista' },
  { name: 'WhatsApp', value: 'whatsapp' },
] as const

export type ThemeName = (typeof THEMES)[number]['value']
export type ThemeMode = 'light' | 'dark' | 'system'

/** 与 index.html 首屏脚本保持一致 */
export const THEME_STORAGE_KEY = 'acp_theme'
export const MODE_STORAGE_KEY = 'acp_mode'

export function isThemeName(value: string | null): value is ThemeName {
  return THEMES.some((t) => t.value === value)
}
