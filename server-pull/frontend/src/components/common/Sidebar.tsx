// 侧边导航 - 6 页 + 视图模式
import React from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Tooltip } from 'antd'
import {
  DashboardOutlined, LineChartOutlined, AlertOutlined, DatabaseOutlined,
  ExperimentOutlined, SettingOutlined, DesktopOutlined,
} from '@ant-design/icons'

const menuItems = [
  { key: '/overview', label: '监控总览', icon: <DashboardOutlined />, desc: 'GIS 一张图 + 5 层收敛' },
  { key: '/trend', label: '趋势分析', icon: <LineChartOutlined />, desc: '多预见期叠加 + 版本对比' },
  { key: '/alerts', label: '预警中心', icon: <AlertOutlined />, desc: '状态流转 + 发布管理' },
  { key: '/datasources', label: '数据源与融合', icon: <DatabaseOutlined />, desc: '四源接入 + 质量监控' },
  { key: '/calibration', label: '模型校准', icon: <ExperimentOutlined />, desc: '评估 → 调整 → 验证' },
  { key: '/settings', label: '系统配置', icon: <SettingOutlined />, desc: '等级规则 + 渠道配置' },
]

export const Sidebar: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()

  return (
    <aside className="w-56 bg-slate-900 text-slate-100 flex flex-col" style={{ minHeight: '100vh' }}>
      <div className="px-4 py-4 border-b border-slate-700">
        <div className="text-base font-semibold flex items-center gap-2">
          <span style={{
            display: 'inline-block', width: 10, height: 10, borderRadius: 2,
            background: 'linear-gradient(135deg, #3b82f6 0%, #1e40af 100%)',
          }} />
          内涝预测 v2
        </div>
        <div className="text-xs text-slate-400 mt-1">城市积水智能预测系统</div>
      </div>
      <nav className="flex-1 py-2">
        {menuItems.map((item) => {
          const active = location.pathname === item.key
          return (
            <Tooltip key={item.key} title={item.desc} placement="right">
              <div
                onClick={() => navigate(item.key)}
                className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${
                  active ? 'bg-blue-600 text-white' : 'hover:bg-slate-800 text-slate-300'
                }`}
              >
                <span className="text-base">{item.icon}</span>
                <span className="text-sm">{item.label}</span>
                {active && <span className="ml-auto w-1 h-5 bg-white rounded" />}
              </div>
            </Tooltip>
          )
        })}
      </nav>
      <div className="px-4 py-3 border-t border-slate-700 text-xs text-slate-400">
        <div className="flex items-center gap-1.5 mb-1">
          <DesktopOutlined />
          <span>大屏模式</span>
        </div>
        <div
          onClick={() => navigate('/overview?screen=1')}
          className="text-blue-300 hover:text-blue-200 cursor-pointer"
        >
          → 监控总览深色全屏
        </div>
      </div>
    </aside>
  )
}
