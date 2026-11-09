import { Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { RequireAuth } from './components/RequireAuth'
import { LoginPage } from './pages/LoginPage'
import { AdminPage } from './pages/AdminPage'
import { OverviewPage } from './pages/OverviewPage'
import { SitesPage } from './pages/SitesPage'
import { SiteDetailPage } from './pages/SiteDetailPage'
import { AlertsPage } from './pages/AlertsPage'
import { ShiftPage } from './pages/ShiftPage'
import { ModelPage } from './pages/ModelPage'
import { RulesPage } from './pages/RulesPage'
import { SystemPage } from './pages/SystemPage'
import BoardPage from './board/BoardPage'

/**
 * 路由表。
 *
 * /login 在闸门外面，其余全部包在 RequireAuth 里。
 * 这样加新页面时不会漏鉴权——漏掉的是一个 Route 行，而不是一个守卫。
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        {/* 大厅大屏：在 Layout 之外，所以没有侧栏；仍在闸门之内，避免裸奔 */}
        <Route path="/board" element={<BoardPage />} />
        <Route element={<Layout />}>
          <Route index element={<OverviewPage />} />
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
  )
}
