import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

async function bootstrap() {
  // 模拟模式：在任何请求发出前装好 fetch 拦截器（生产构建里这段会被整体摇掉）
  if (import.meta.env.VITE_MOCK === '1') {
    const { installMock } = await import('./mock')
    installMock()
  }
  const root = document.getElementById('root')
  if (!root) throw new Error('#root 不存在')
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap()
