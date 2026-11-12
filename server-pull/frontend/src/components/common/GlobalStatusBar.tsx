// 全局状态摘要条 - 全部真实数据（修复 ⑧：原版硬编码 'lstm-v2.3.1' / '5 活跃' / 假时间）
import React, { useEffect, useState } from 'react'
import { Tooltip, Tag } from 'antd'
import {
  CheckCircleOutlined, ExclamationCircleOutlined, DatabaseOutlined,
  ThunderboltOutlined, AlertOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { useAlertStats, useDatasources, useSystemStatus } from '@/api/queries'

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
  const backendOk = !statusError && !statsError && !dsError
  const modelLabel = status ? `${status.modelName}-v${status.version}` : '加载中…'
  const alertLabel = stats
    ? `${stats.activeTotal} 活跃 · 今日 ${stats.todayTotal} 条`
    : statusError || statsError
      ? '不可用'
      : '加载中'

  return (
    <div className="flex items-center gap-4 px-4 py-2 bg-white border-b border-slate-200 text-xs">
      <Tooltip title="已启用数据源 / 全部">
        <div className="flex items-center gap-1.5">
          <DatabaseOutlined style={{ color: enabledSources === totalSources && totalSources > 0 ? '#10b981' : '#F59E0B' }} />
          <span className="text-slate-600">数据源</span>
          <Tag color={enabledSources === totalSources && totalSources > 0 ? 'green' : 'orange'} style={{ margin: 0 }}>
            {enabledSources}/{totalSources}
          </Tag>
        </div>
      </Tooltip>
      <div className="w-px h-3 bg-slate-200" />
      <Tooltip title={`预测周期 ${status?.forecastIntervalMinutes ?? '—'} 分钟 · 步长 ${status?.stepMinutes ?? '—'} 分钟`}>
        <div className="flex items-center gap-1.5">
          <ThunderboltOutlined style={{ color: '#2563EB' }} />
          <span className="text-slate-600">模型</span>
          <Tag color="blue" style={{ margin: 0 }}>{modelLabel}</Tag>
        </div>
      </Tooltip>
      <div className="w-px h-3 bg-slate-200" />
      <Tooltip title="实时预警统计（SSE 推送自动刷新）">
        <div className="flex items-center gap-1.5">
          <AlertOutlined style={{ color: '#EA580C' }} />
          <span className="text-slate-600">预警</span>
          <Tag color="orange" style={{ margin: 0 }}>{alertLabel}</Tag>
        </div>
      </Tooltip>
      <div className="w-px h-3 bg-slate-200" />
      <div className="flex items-center gap-1.5">
        {backendOk ? <CheckCircleOutlined style={{ color: '#10b981' }} /> : <ExclamationCircleOutlined style={{ color: '#DC2626' }} />}
        <span className="text-slate-600">后端</span>
        <span className={backendOk ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
          {backendOk ? '连接正常' : '连接异常'}
        </span>
      </div>
      <div className="ml-auto text-slate-500">
        {nowStr} · 预测周期 {status?.forecastIntervalMinutes ?? '—'}min
        {status?.demoMode ? ' · 演示模式' : ''}
      </div>
    </div>
  )
}
