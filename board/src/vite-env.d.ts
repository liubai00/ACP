/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" 时启用前端内置模拟数据（npm run dev:mock） */
  readonly VITE_MOCK?: string
  /** 开发代理目标，默认 http://localhost:8000 */
  readonly VITE_BACKEND_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
