// 全局状态摘要条 - 全部真实数据（视觉契约：色点+文字替代 Tag 堆叠；<768px 隐藏次要项）
import React, { useEffect, useState } from 'react'
import { Tooltip } from 'antd'
import {
  CheckCircleOutlined, ExclamationCircleOutlined, DatabaseOutlined,
  ThunderboltOutlined, AlertOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { useAlertStats, useDatasources, useSystemStatus } from '@/api/queries'

// 色点状态（契约 §4：状态表达优先 色点+文字 > Tag）
const Dot: React.FC<{ color: string }> = ({ color }) => (
  <span aria-hidden style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
)

export const GlobalStatusBar: React.FC = () => {
  const { data: status, isError: statusError } = useSystemStatus()
  const { data: stats, isError: statsError } = useAlertStats()
  const { data: sources, isError: dsError } = useDatasources()
  const [nowStr, setNowStr] = useState(dayjs().format('YYYY-MM-DD HH:mm'))

  useEffect(() => {
    const t = setInterval(() => setNowStr(dayjs().format('YYYY-MM-DD HH:mm')), 30_000)
    return () => clearInterval(t)
  }, [])

  const enabledSources = (sources ?? []).filter((d) => d.enabled).length
  const totalSources = sources?.length ?? 0
  const sourcesOk = enabledSources === totalSources && totalSources > 0
  const backendOk = !statusError && !statsError && !dsError
  const modelLabel = status ? `${status.modelName} ${status.version}` : '…'
  const alertLabel = stats
    ? `${stats.activeTotal} 活跃 · 今日 ${stats.todayTotal}`
    : statusError || statsError
      ? '不可用'
      : '…'

  const itemClass = 'flex items-center gap-1.5 text-xs whitespace-nowrap'

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-white border-b text-xs" style={{ borderColor: 'var(--border-1)', minHeight: 40 }}>
      <Tooltip title="已启用数据源 / 全部">
        <div className={itemClass}>
          <DatabaseOutlined style={{ color: sourcesOk ? 'var(--success)' : 'var(--warning)' }} />
          <span style={{ color: 'var(--text-2)' }}>数据源</span>
          <span className="num" style={{ color: 'var(--text-1)', fontWeight: 600 }}>
            {sources?.length ? `${enabledSources}/${totalSources}` : '—'}
          </span>
        </div>
      </Tooltip>
      <div className="statusbar-secondary" style={{ width: 1, height: 14, background: 'var(--border-1)' }} />
      <Tooltip title={`预测周期 ${status?.forecastIntervalMinutes ?? '—'} 分钟 · 步长 ${status?.stepMinutes ?? '—'} 分钟`}>
        <div className={`${itemClass} statusbar-secondary`}>
          <ThunderboltOutlined style={{ color: 'var(--primary)' }} />
          <span style={{ color: 'var(--text-2)' }}>模型</span>
          <span className="num" style={{ color: 'var(--text-1)', fontWeight: 600 }}>{modelLabel}</span>
        </div>
      </Tooltip>
      <div className="statusbar-secondary" style={{ width: 1, height: 14, background: 'var(--border-1)' }} />
      <Tooltip title="实时预警统计（SSE 推送自动刷新）">
        <div className={itemClass}>
          <AlertOutlined style={{ color: 'var(--warning)' }} />
          <span style={{ color: 'var(--text-2)' }}>预警</span>
          <span className="num" style={{ color: 'var(--text-1)', fontWeight: 600 }}>{alertLabel}</span>
        </div>
      </Tooltip>
      <div className="statusbar-secondary" style={{ width: 1, height: 14, background: 'var(--border-1)' }} />
      <div className={`${itemClass} statusbar-secondary`}>
        {backendOk
          ? <CheckCircleOutlined style={{ color: 'var(--success)' }} />
          : <ExclamationCircleOutlined style={{ color: 'var(--danger)' }} />}
        <span style={{ color: 'var(--text-2)' }}>后端</span>
        <Dot color={backendOk ? 'var(--success)' : 'var(--danger)'} />
        <span style={{ color: backendOk ? 'var(--success)' : 'var(--danger)', fontWeight: 500 }}>
          {backendOk ? '正常' : '异常'}
        </span>
      </div>
      <div className="ml-auto num" style={{ color: 'var(--text-3)' }}>
        {nowStr}
        {status?.demoMode ? <span className="statusbar-secondary"> · 演示模式</span> : ''}
      </div>
    </div>
  )
}
