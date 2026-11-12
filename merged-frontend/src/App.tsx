// App 根组件 - 6 页路由（懒加载 + Suspense + 页面级 ErrorBoundary）
// 修复：原版全部页面静态导入且无错误边界，任一页面模块异常即全应用白屏
import React, { Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from '@/components/common/Layout'
import { ErrorBoundary, PageLoading } from '@/components/common/ErrorBoundary'

const OverviewPage = lazy(() => import('@/pages/OverviewPage').then((m) => ({ default: m.OverviewPage })))
const TrendPage = lazy(() => import('@/pages/TrendPage').then((m) => ({ default: m.TrendPage })))
const AlertCenterPage = lazy(() => import('@/pages/AlertCenterPage').then((m) => ({ default: m.AlertCenterPage })))
const DataSourcePage = lazy(() => import('@/pages/DataSourcePage').then((m) => ({ default: m.DataSourcePage })))
const CalibrationPage = lazy(() => import('@/pages/CalibrationPage').then((m) => ({ default: m.CalibrationPage })))
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })))

const LazyPage: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <ErrorBoundary label={label}>
    <Suspense fallback={<PageLoading />}>{children}</Suspense>
  </ErrorBoundary>
)

const App: React.FC = () => {
  return (
    <ErrorBoundary label="应用">
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/overview" replace />} />
          <Route path="overview" element={<LazyPage label="监控总览"><OverviewPage /></LazyPage>} />
          <Route path="trend" element={<LazyPage label="趋势分析"><TrendPage /></LazyPage>} />
          <Route path="alerts" element={<LazyPage label="预警中心"><AlertCenterPage /></LazyPage>} />
          <Route path="datasources" element={<LazyPage label="数据源管理"><DataSourcePage /></LazyPage>} />
          <Route path="calibration" element={<LazyPage label="模型校准"><CalibrationPage /></LazyPage>} />
          <Route path="settings" element={<LazyPage label="系统配置"><SettingsPage /></LazyPage>} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  )
}

export default App
