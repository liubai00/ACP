/** 时间、数字格式化（统一按浏览器本地时区显示） */

const pad = (n: number) => String(n).padStart(2, '0')

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 2026-11-09 14:20 */
export function formatDateTime(value: string | null | undefined, withSeconds = false): string {
  const d = toDate(value)
  if (!d) return '—'
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return withSeconds ? `${base}:${pad(d.getSeconds())}` : base
}

/** 11-09 或 2025-11-09（跨年时带年份） */
export function formatDate(value: string | null | undefined): string {
  const d = toDate(value)
  if (!d) return '—'
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return sameYear
    ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 14:20 */
export function formatTime(value: string | null | undefined): string {
  const d = toDate(value)
  if (!d) return '—'
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 刚刚 / 5 分钟前 / 3 小时前 / 昨天 14:20 / 3 天前 / 11-02 */
export function formatRelative(value: string | null | undefined, now = Date.now()): string {
  const d = toDate(value)
  if (!d) return '—'
  const diff = now - d.getTime()
  const abs = Math.abs(diff)
  const future = diff < 0
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  if (abs < 45_000) return '刚刚'
  if (abs < HOUR) return `${Math.max(1, Math.round(abs / MIN))} 分钟${future ? '后' : '前'}`
  if (abs < DAY) return `${Math.round(abs / HOUR)} 小时${future ? '后' : '前'}`
  if (!future) {
    const yesterday = new Date(now - DAY)
    if (d.toDateString() === yesterday.toDateString()) return `昨天 ${formatTime(value)}`
  }
  if (abs < 7 * DAY) return `${Math.round(abs / DAY)} 天${future ? '后' : '前'}`
  return formatDate(value)
}

/** 持续时长：17 毫秒 / 45 分钟 / 3.5 小时 / 2 天 4 小时 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} 毫秒`
  if (ms < MIN) return `${Math.round(ms / 1000)} 秒`
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))} 分钟`
  if (ms < DAY) {
    const h = ms / HOUR
    return `${h < 10 ? Math.round(h * 10) / 10 : Math.round(h)} 小时`
  }
  const days = Math.floor(ms / DAY)
  const hours = Math.round((ms - days * DAY) / HOUR)
  return hours > 0 && days < 10 ? `${days} 天 ${hours} 小时` : `${days} 天`
}

export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return '—'
  return formatDurationMs(hours * 3_600_000)
}

/** 从某个时间点到现在的时长（看板“停留时长”） */
export function formatAge(value: string | null | undefined, now = Date.now()): string {
  const d = toDate(value)
  if (!d) return '—'
  return formatDurationMs(now - d.getTime())
}

export function ageHours(value: string | null | undefined, now = Date.now()): number {
  const d = toDate(value)
  if (!d) return 0
  return (now - d.getTime()) / 3_600_000
}

export function formatPercent(ratio: number | null | undefined, digits = 0): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—'
  return `${(ratio * 100).toFixed(digits)}%`
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return new Intl.NumberFormat('zh-CN').format(n)
}

/** 头像缩写：中文取最后两个字，英文取首字母 */
export function initials(name: string | null | undefined): string {
  if (!name) return '?'
  const trimmed = name.trim()
  if (/[一-鿿]/.test(trimmed)) {
    return trimmed.length <= 2 ? trimmed : trimmed.slice(-2)
  }
  const parts = trimmed.split(/[\s._-]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return trimmed.slice(0, 2).toUpperCase()
}
