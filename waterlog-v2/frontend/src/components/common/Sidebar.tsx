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
  { key: '/', label: '监控总览', icon: <DashboardOutlined />, desc: '设备地图 + 实时告警', group: '监测' },
  { key: '/telemetry', label: '遥测数据', icon: <LineChartOutlined />, desc: '时序曲线 + 预测叠加', group: '监测' },
  { key: '/devices', label: '设备管理', icon: <DatabaseOutlined />, desc: '设备 / 画像 / 状态', group: '资产' },
  { key: '/alarms', label: '告警中心', icon: <AlertOutlined />, desc: '四态生命周期 + 处置', group: '预警' },
  { key: '/rules', label: '规则引擎', icon: <ExperimentOutlined />, desc: '阈值 + 持续时长 → 告警', group: '预警' },
  { key: '/settings', label: '系统设置', icon: <SettingOutlined />, desc: '运行状态 + 演示控制', group: '管理' },
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
      className="flex flex-col shrink-0 press"
      style={{ width: compact ? 64 : 224, minHeight: '100vh', background: 'var(--sidebar-bg)', color: 'var(--sidebar-text)', transition: 'width var(--dur-base) var(--ease-out)' }}
    >
      {/* 品牌区：渐变标识 + 双行标题 */}
      <div
        className="flex items-center gap-2.5 overflow-hidden"
        style={{ padding: compact ? '14px 0' : '16px 16px', justifyContent: compact ? 'center' : 'flex-start', borderBottom: '1px solid var(--sidebar-border)' }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, borderRadius: 'var(--radius-control)', flexShrink: 0,
            background: 'linear-gradient(135deg, var(--sidebar-accent) 0%, var(--sidebar-accent-deep) 100%)',
            boxShadow: '0 2px 8px rgba(37, 99, 235, 0.45)',
          }}
        >
          <span style={{ width: 12, height: 12, borderRadius: '50%', border: '2.5px solid rgba(255,255,255,0.95)', display: 'block' }} />
        </span>
        {!compact && (
          <div className="min-w-0">
            <div className="text-sm font-bold leading-tight">内涝监测 <span className="num">v2</span></div>
            <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--sidebar-muted)' }}>Go · 规则引擎 · 四态告警</div>
          </div>
        )}
      </div>

      <nav className="flex-1 py-2 overflow-y-auto" aria-label="主导航">
        {NAV_GROUPS.map(({ group, items }) => (
          <div key={group}>
            {!compact && (
              <div className="px-4 pt-3 pb-1 text-xs font-medium select-none" style={{ color: 'var(--sidebar-muted)', letterSpacing: '0.05em' }}>
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
                  className={`relative w-full flex items-center gap-3 cursor-pointer border-0 text-left press ${
                    compact ? 'justify-center' : 'px-3'
                  }`}
                  style={{
                    height: 40,
                    borderRadius: 'var(--radius-control)',
                    background: active ? 'var(--sidebar-accent-soft)' : 'transparent',
                    color: active ? 'var(--sidebar-text-active)' : 'var(--sidebar-text)',
                    fontSize: 'var(--fs-base)',
                  }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--sidebar-hover)' }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
                >
                  {active && <span aria-hidden className="absolute rounded-r" style={{ left: 0, top: 11, width: 3, height: 18, background: 'var(--sidebar-accent)' }} />}
                  <span className="flex-shrink-0" style={{ fontSize: 16, color: active ? 'var(--sidebar-accent-soft)' : undefined }}>{item.icon}</span>
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

      <div className="text-xs" style={{ padding: compact ? '12px 0' : '12px 16px', borderTop: '1px solid var(--sidebar-border)' }}>
        {compact ? (
          <div className="text-center" style={{ color: 'var(--sidebar-muted)' }}>v2</div>
        ) : (
          <div className="space-y-0.5">
            <div className="num" style={{ color: 'var(--sidebar-muted)' }}>v2.0.0 · Go + React</div>
            <div style={{ color: 'var(--sidebar-muted)' }}>规则引擎 · 四态告警</div>
          </div>
        )}
      </div>
    </aside>
  )
}
