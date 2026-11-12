// 侧边导航 - 6 页 + 视图模式（观感升级：品牌标识 + 分组导航）
// 视觉契约：克制选中态（半透明蓝底+左侧蓝条）；<768px 收窄 icon-only；button 语义 + aria-current
import React, { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Tooltip } from 'antd'
import {
  DashboardOutlined, LineChartOutlined, AlertOutlined, DatabaseOutlined,
  ExperimentOutlined, SettingOutlined, DesktopOutlined,
} from '@ant-design/icons'

type MenuItem = { key: string; label: string; icon: JSX.Element; desc: string; group: string }
const menuItems: MenuItem[] = [
  { key: '/overview', label: '监控总览', icon: <DashboardOutlined />, desc: 'GIS 一张图 + 5 层收敛', group: '监测' },
  { key: '/trend', label: '趋势分析', icon: <LineChartOutlined />, desc: '多预见期叠加 + 版本对比', group: '监测' },
  { key: '/alerts', label: '预警中心', icon: <AlertOutlined />, desc: '状态流转 + 发布管理', group: '预警' },
  { key: '/datasources', label: '数据源与融合', icon: <DatabaseOutlined />, desc: '四源接入 + 质量监控', group: '管理' },
  { key: '/calibration', label: '模型校准', icon: <ExperimentOutlined />, desc: '评估 → 调整 → 验证', group: '管理' },
  { key: '/settings', label: '系统配置', icon: <SettingOutlined />, desc: '等级规则 + 渠道配置', group: '管理' },
]
// 分组导航（契约 §5：按任务域分组）
const NAV_GROUPS: { group: string; items: MenuItem[] }[] = []
for (const item of menuItems) {
  let g = NAV_GROUPS.find((x) => x.group === item.group)
  if (!g) { g = { group: item.group, items: [] }; NAV_GROUPS.push(g) }
  g.items.push(item)
}

// 契约 §8：<768px 收窄为 64px icon-only（触屏点按目标仍达标）
function useCompact(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const onChange = (e: MediaQueryListEvent) => setCompact(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return compact
}

export const Sidebar: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const compact = useCompact()

  return (
    <aside
      className="bg-slate-900 text-slate-100 flex flex-col shrink-0 transition-[width] duration-200"
      style={{ width: compact ? 64 : 224, minHeight: '100vh' }}
    >
      {/* 品牌区：渐变标识 + 双行标题 */}
      <div
        className="border-b border-slate-700/70 flex items-center gap-2.5 overflow-hidden"
        style={{ padding: compact ? '14px 0' : '16px 16px', justifyContent: compact ? 'center' : 'flex-start' }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, borderRadius: 8, flexShrink: 0,
            background: 'linear-gradient(135deg, #3B82F6 0%, #1E40AF 100%)',
            boxShadow: '0 2px 8px rgba(37, 99, 235, 0.45)',
          }}
        >
          <span style={{ width: 12, height: 12, borderRadius: '50%', border: '2.5px solid rgba(255,255,255,0.95)', display: 'block' }} />
        </span>
        {!compact && (
          <div className="min-w-0">
            <div className="text-sm font-bold leading-tight">内涝预测 <span className="num">v2</span></div>
            <div className="text-[11px] text-slate-400 mt-0.5 truncate">城市积水智能预测系统</div>
          </div>
        )}
      </div>

      <nav className="flex-1 py-2 overflow-y-auto" aria-label="主导航">
        {NAV_GROUPS.map(({ group, items }) => (
          <div key={group}>
            {!compact && (
              <div className="px-4 pt-3 pb-1 text-[11px] font-medium select-none" style={{ color: '#64748B', letterSpacing: '0.05em' }}>
                {group}
              </div>
            )}
            {items.map((item) => {
              const active = location.pathname === item.key
              const btn = (
                <button
                  type="button"
                  onClick={() => navigate(item.key)}
                  aria-current={active ? 'page' : undefined}
                  className={`relative w-full flex items-center gap-3 cursor-pointer transition-colors border-0 text-left ${
                    compact ? 'justify-center' : 'px-3'
                  }`}
                  style={{
                    height: 40,
                    borderRadius: 6,
                    background: active ? 'rgba(37, 99, 235, 0.20)' : 'transparent',
                    color: active ? '#fff' : '#CBD5E1',
                    fontSize: 14,
                  }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(148, 163, 184, 0.10)' }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = active ? 'rgba(37, 99, 235, 0.20)' : 'transparent' }}
                >
                  {active && <span aria-hidden className="absolute rounded-r" style={{ left: 0, top: 11, width: 3, height: 18, background: '#3B82F6' }} />}
                  <span className="flex-shrink-0" style={{ fontSize: 16, color: active ? '#93C5FD' : undefined }}>{item.icon}</span>
                  {!compact && <span className="truncate">{item.label}</span>}
                </button>
              )
              return (
                <div key={item.key} style={{ padding: compact ? '4px 8px' : '2px 8px' }}>
                  {compact ? <Tooltip title={item.desc} placement="right">{btn}</Tooltip> : btn}
                </div>
              )
            })}
          </div>
        ))}
      </nav>

      <div className="border-t border-slate-700/70 text-xs text-slate-400" style={{ padding: compact ? '12px 0' : '12px 16px' }}>
        {compact ? (
          <Tooltip title="监控总览深色全屏" placement="right">
            <button
              type="button" aria-label="进入大屏模式"
              onClick={() => navigate('/overview?screen=1')}
              className="rounded text-blue-300 hover:text-blue-200 hover:bg-slate-800 border-0 bg-transparent cursor-pointer"
              style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto' }}
            >
              <DesktopOutlined />
            </button>
          </Tooltip>
        ) : (
          <>
            <div className="flex items-center gap-1.5 mb-1">
              <DesktopOutlined />
              <span>大屏模式</span>
            </div>
            <button
              type="button"
              onClick={() => navigate('/overview?screen=1')}
              className="text-blue-300 hover:text-blue-200 cursor-pointer border-0 bg-transparent p-0 text-xs"
            >
              → 监控总览深色全屏
            </button>
          </>
        )}
      </div>
    </aside>
  )
}
