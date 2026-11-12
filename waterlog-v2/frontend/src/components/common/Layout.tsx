// 全局布局：Sidebar + 内容区（挂载 SSE 预警实时流）
import React from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { GlobalStatusBar } from './GlobalStatusBar'
import { useEventStream } from '@/api/queries'

export const Layout: React.FC = () => {
  // SSE /stream：遥测与告警事件到达时自动失效相关查询
  useEventStream()
  return (
    <div className="flex" style={{ minHeight: '100vh', background: 'var(--bg-canvas)' }}>
      <Sidebar />
      <main className="flex-1 flex flex-col" style={{ minWidth: 0 }}>
        <GlobalStatusBar />
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
