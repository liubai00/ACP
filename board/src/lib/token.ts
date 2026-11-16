import type { JwtClaims } from '@/types/api'

/** 契约约定的 localStorage 键 */
export const TOKEN_KEY = 'acp_token'

type Listener = (token: string | null) => void
const listeners = new Set<Listener>()

function safeGet(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export const tokenStore = {
  get(): string | null {
    return safeGet()
  },
  set(token: string) {
    try {
      localStorage.setItem(TOKEN_KEY, token)
    } catch {
      /* 隐私模式等情况下忽略 */
    }
    listeners.forEach((l) => l(token))
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY)
    } catch {
      /* ignore */
    }
    listeners.forEach((l) => l(null))
  },
  subscribe(listener: Listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** 只解码不验签（验签在后端），用于读取角色和过期时间 */
export function decodeJwt(token: string | null): JwtClaims | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const claims = JSON.parse(base64UrlDecode(parts[1])) as Partial<JwtClaims>
    if (typeof claims.sub !== 'string') return null
    return {
      sub: claims.sub,
      name: claims.name ?? '',
      roles: Array.isArray(claims.roles) ? claims.roles : [],
      act: claims.act ?? 'member',
      exp: typeof claims.exp === 'number' ? claims.exp : 0,
      iat: typeof claims.iat === 'number' ? claims.iat : 0,
      jti: claims.jti ?? '',
      task_id: claims.task_id,
      agent_id: claims.agent_id,
      iss: claims.iss,
      aud: claims.aud,
    }
  } catch {
    return null
  }
}

/** 令牌是否已过期（留 30 秒余量）；无 exp 视为未过期，由后端判定 */
export function isTokenExpired(claims: JwtClaims | null, skewSeconds = 30): boolean {
  if (!claims) return true
  if (!claims.exp) return false
  return claims.exp * 1000 <= Date.now() + skewSeconds * 1000
}

/** 只允许站内相对路径，防止登录回调被用作开放重定向 */
export function sanitizeRedirect(raw: string | null | undefined, fallback = '/'): string {
  if (!raw) return fallback
  const value = raw.trim()
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback
  if (value.startsWith('/login')) return fallback
  return value
}
