// App 根组件 - v2 六页路由（懒加载 + ErrorBoundary）
import React, { Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from '@/components/common/Layout'
import { ErrorBoundary, PageLoading } from '@/components/common/ErrorBoundary'

const DashboardPage = lazy(() => import('@/pages/DashboardPage').then((m) => ({ default: m.DashboardPage })))
const TelemetryPage = lazy(() => import('@/pages/TelemetryPage').then((m) => ({ default: m.TelemetryPage })))
const DevicesPage = lazy(() => import('@/pages/DevicesPage').then((m) => ({ default: m.DevicesPage })))
const AlarmsPage = lazy(() => import('@/pages/AlarmsPage').then((m) => ({ default: m.AlarmsPage })))
const RulesPage = lazy(() => import('@/pages/RulesPage').then((m) => ({ default: m.RulesPage })))
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })))

const LazyPage: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <ErrorBoundary label={label}>
    <Suspense fallback={<PageLoading />}>{children}</Suspense>
  </ErrorBoundary>
)

const App: React.FC = () => (
  <ErrorBoundary label="应用">
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<LazyPage label="监控总览"><DashboardPage /></LazyPage>} />
        <Route path="telemetry" element={<LazyPage label="遥测数据"><TelemetryPage /></LazyPage>} />
        <Route path="devices" element={<LazyPage label="设备管理"><DevicesPage /></LazyPage>} />
        <Route path="alarms" element={<LazyPage label="告警中心"><AlarmsPage /></LazyPage>} />
        <Route path="rules" element={<LazyPage label="规则引擎"><RulesPage /></LazyPage>} />
        <Route path="settings" element={<LazyPage label="系统设置"><SettingsPage /></LazyPage>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  </ErrorBoundary>
)

export default App
