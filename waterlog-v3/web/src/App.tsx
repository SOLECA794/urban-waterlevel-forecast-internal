import { Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { RequireAuth } from './components/RequireAuth'
import { LoginPage } from './pages/LoginPage'
import { AdminPage } from './pages/AdminPage'
import { OverviewPage } from './pages/OverviewPage'
import { SitesPage } from './pages/SitesPage'
import { SiteDetailPage } from './pages/SiteDetailPage'
import { TourHost } from './components/TourHost'
import { AlertsPage } from './pages/AlertsPage'
import { ShiftPage } from './pages/ShiftPage'
import { ModelPage } from './pages/ModelPage'
import { RulesPage } from './pages/RulesPage'
import { SystemPage } from './pages/SystemPage'
import BoardPage from './board/BoardPage'
import { LivePage } from './pages/LivePage'

/**
 * 路由表。
 *
 * /login 在闸门外面，其余全部包在 RequireAuth 里。
 * 这样加新页面时不会漏鉴权——漏掉的是一个 Route 行，而不是一个守卫。
 */
export default function App() {
  return (
    <>
      {/* 演示流程挂在 <Routes> 外面：它要在任何业务页上都能浮出来，包括没有 Layout 的大屏页。
          **不能放进 <Routes>** —— 那里只接受 <Route> 子节点，混进别的组件会让整棵路由树渲染失败
          （表现为整页白屏，控制台只有一句 Uncaught Error，看不出是这个原因）。 */}
      <TourHost />
      <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        {/* 大厅大屏：在 Layout 之外，所以没有侧栏；仍在闸门之内，避免裸奔 */}
        <Route path="/board" element={<BoardPage />} />
        <Route element={<Layout />}>
          <Route index element={<OverviewPage />} />
          {/* 应用版一张图：在侧栏布局里（要左栏列表），不是独立大屏 */}
          <Route path="live" element={<LivePage />} />
          <Route path="sites" element={<SitesPage />} />
          <Route path="sites/:id" element={<SiteDetailPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="shift" element={<ShiftPage />} />
          <Route path="model" element={<ModelPage />} />
          <Route path="rules" element={<RulesPage />} />
          <Route path="system" element={<SystemPage />} />
          <Route path="admin" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
      </Routes>
    </>
  )
}
