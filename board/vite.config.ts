import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// 真实模式下，以下路径属于 coordinator，开发时代理到本地 8000 端口。
const BACKEND_PREFIXES = ['/api', '/auth', '/a2a', '/mcp', '/.well-known', '/healthz']

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_BACKEND_URL || 'http://localhost:8000'
  const mock = env.VITE_MOCK === '1'

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
    },
    server: {
      port: 5173,
      proxy: mock
        ? undefined
        : Object.fromEntries(
            BACKEND_PREFIXES.map((prefix) => [
              prefix,
              { target, changeOrigin: true, ws: false },
            ]),
          ),
    },
    preview: {
      port: 4173,
    },
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router'],
            charts: ['recharts'],
            table: ['@tanstack/react-table', '@tanstack/react-query'],
          },
        },
      },
    },
  }
})
