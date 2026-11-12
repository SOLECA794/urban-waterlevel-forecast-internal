// 全局状态摘要条（v2）：服务 / 设备在线 / 生效告警 / 降雨 / 订阅 / 时间
// 规范：docs/02-design/DESIGN-v2-设计系统规范.md §5.2（状态动机）/ §6（交互态）
import React, { useEffect, useState } from 'react'
import { Tooltip } from 'antd'
import { CloudOutlined, AlertOutlined, ApiOutlined, ClusterOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useAlarmStats, useDevices, useSystemStatus } from '@/api/queries'
import { AnimatedNumber } from './AnimatedNumber'

const Dot: React.FC<{ color: string; live?: boolean }> = ({ color, live }) => (
  <span
    aria-hidden
    className={live ? 'live-dot' : undefined}
    style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 'var(--radius-pill)', background: color, flexShrink: 0 }}
  />
)

export const GlobalStatusBar: React.FC = () => {
  const { data: status, isError: statusError } = useSystemStatus()
  const { data: stats, isError: statsError } = useAlarmStats()
  const { data: devices, isError: devError } = useDevices()
  const [nowStr, setNowStr] = useState(dayjs().format('YYYY-MM-DD HH:mm'))

  useEffect(() => {
    const t = setInterval(() => setNowStr(dayjs().format('YYYY-MM-DD HH:mm')), 30_000)
    return () => clearInterval(t)
  }, [])

  const backendOk = !statusError && !statsError && !devError
  const online = (devices ?? []).filter((d) => d.status === 'online').length
  const total = devices?.length ?? 0
  const activeTotal = stats?.activeTotal ?? 0
  const itemClass = 'flex items-center gap-1.5 text-xs whitespace-nowrap'

  return (
    <div
      className="flex items-center gap-4 px-4 py-2 border-b text-xs"
      style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-1)', minHeight: 40 }}
    >
      <Tooltip title={backendOk ? '后端服务正常' : '后端服务不可用'}>
        <div className={itemClass}>
          <Dot color={backendOk ? 'var(--success)' : 'var(--danger)'} live={backendOk} />
          <span style={{ color: 'var(--text-2)' }}>服务</span>
          <span style={{ color: 'var(--text-1)', fontWeight: 600 }}>{backendOk ? '正常' : '异常'}</span>
          {status && <span style={{ color: 'var(--text-3)' }}>{status.version}</span>}
        </div>
      </Tooltip>

      <Tooltip title="在线设备 / 设备总数">
        <div className={itemClass}>
          <ClusterOutlined style={{ color: 'var(--text-3)' }} />
          <span style={{ color: 'var(--text-2)' }}>设备</span>
          <span className="num" style={{ color: 'var(--text-1)', fontWeight: 600 }}>
            {total ? `${online}/${total}` : '—'}
          </span>
        </div>
      </Tooltip>

      <Tooltip title={`生效告警（未确认 ${stats?.unackTotal ?? 0}）`}>
        <div className={itemClass}>
          <AlertOutlined style={{ color: activeTotal > 0 ? 'var(--danger)' : 'var(--text-3)' }} />
          <span style={{ color: 'var(--text-2)' }}>告警</span>
          <AnimatedNumber
            value={activeTotal}
            className="num"
            style={{ color: activeTotal > 0 ? 'var(--danger)' : 'var(--text-1)', fontWeight: 600 }}
          />
        </div>
      </Tooltip>

      <div className={`${itemClass} statusbar-secondary`}>
        <CloudOutlined style={{ color: status?.raining ? 'var(--primary)' : 'var(--text-3)' }} />
        <span style={{ color: 'var(--text-2)' }}>降雨</span>
        <span style={{ color: 'var(--text-1)', fontWeight: 600 }}>{status?.raining ? '模拟中' : '无'}</span>
      </div>

      <div className="flex-1" />

      <div className={itemClass} style={{ color: 'var(--text-3)' }}>
        <ApiOutlined />
        <span className="num">{status ? `${status.subscribers} 订阅` : '—'}</span>
      </div>
      <span className="num" style={{ color: 'var(--text-3)' }}>{nowStr}</span>
    </div>
  )
}
