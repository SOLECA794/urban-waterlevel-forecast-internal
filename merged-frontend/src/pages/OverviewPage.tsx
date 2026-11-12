// P1: 监控总览页 - 5 层收敛信息架构（真实数据版）
// L1 状态条（GlobalStatusBar）| L2 地图 | L3 关键站点 | L4 预测记录 | 边角 Agent
import React, { useEffect, useMemo, useState } from 'react'
import { Card, Tabs, Tag, Button, Empty, Space, Drawer, Spin, App } from 'antd'
import {
  ReloadOutlined, AimOutlined, EnvironmentOutlined, ThunderboltOutlined,
  ClockCircleOutlined, ArrowUpOutlined, ArrowDownOutlined, MinusOutlined, WarningOutlined,
} from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import dayjs from 'dayjs'
import { GisMap } from '@/components/gis/GisMap'
import { AgentCard } from '@/components/agent/AgentCard'
import { AlertBadge } from '@/components/common/AlertBadge'
import { KpiBand } from '@/components/common/KpiBand'
import {
  useAlertStats, useAlerts, useDatasources, useEnabledLeads, useLeads, usePredictStation, useStations,
  qk,
} from '@/api/queries'
import { getStationForecasts } from '@/api/endpoints'
import { useQuery } from '@tanstack/react-query'
import { buildOverviewCard } from '@/utils/agentCards'
import { levelKeyName } from '@/utils/alertLevels'
import { useAppStore, TimeSlice } from '@/stores/useAppStore'
import type { Station } from '@/types'

const TREND_TAG: Record<string, React.ReactNode> = {
  rising: <Tag color="red" icon={<ArrowUpOutlined />}>上涨</Tag>,
  falling: <Tag color="green" icon={<ArrowDownOutlined />}>下降</Tag>,
  stable: <Tag icon={<MinusOutlined />}>持平</Tag>,
}

export const OverviewPage: React.FC = () => {
  const navigate = useNavigate()
  const { message, modal } = App.useApp()
  const [searchParams, setSearchParams] = useSearchParams()
  const isScreenMode = searchParams.get('screen') === '1'
  const { timeSlice, setTimeSlice } = useAppStore()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedStation, setSelectedStation] = useState<Station | null>(null)
  const [tabKey, setTabKey] = useState('critical')
  const [predicting, setPredicting] = useState(false)

  const { data: stations, isLoading: loadingStations, isError: stationsError, error: stationsErrorObj, refetch: refetchStations } = useStations()
  const { data: stats } = useAlertStats()
  const { data: leadsAll } = useLeads()
  const enabledLeads = useEnabledLeads()
  const { data: alertPage } = useAlerts({ pageSize: 100 })
  const predict = usePredictStation()

  // 大屏模式 ESC 退出
  useEffect(() => {
    if (!isScreenMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSearchParams({})
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isScreenMode, setSearchParams])

  const stationList = stations ?? []
  const alerts = alertPage?.items ?? []
  const activeAlerts = alerts.filter((a) => a.status === 'active' || a.status === 'confirmed')
  const criticalStations = stationList
    .filter((s) => s.alertLevel !== null && s.alertLevel !== undefined)
    .sort((a, b) => (b.alertLevel ?? 0) - (a.alertLevel ?? 0))

  // 最近预测：取前几个站点的最新预测记录合并
  const forecastSourceIds = useMemo(
    () => stationList.slice(0, 6).map((s) => s.stationId),
    [stationList],
  )
  const { data: recentForecastLists } = useQuery({
    queryKey: ['overview-forecasts', forecastSourceIds],
    queryFn: async () => {
      const results = await Promise.all(
        forecastSourceIds.map(async (id) => {
          try { return await getStationForecasts(id, undefined, 3) } catch { return [] }
        }),
      )
      return results.flat()
    },
    enabled: forecastSourceIds.length > 0,
    staleTime: 60_000,
  })
  const recentForecasts = useMemo(
    () => (recentForecastLists ?? [])
      .sort((a, b) => dayjs(b.generatedAt).valueOf() - dayjs(a.generatedAt).valueOf())
      .slice(0, 6),
    [recentForecastLists],
  )

  // 手动触发预测：对水位最高的站点执行
  const handlePredict = async () => {
    const target = [...stationList].sort((a, b) => (b.currentLevel ?? 0) - (a.currentLevel ?? 0))[0]
    if (!target) return
    const lead = enabledLeads[0]?.lead ?? leadsAll?.find((l) => l.enabled)?.lead ?? 3
    setPredicting(true)
    try {
      const rev = await predict.mutateAsync({ stationId: target.stationId, leadHours: lead })
      message.success(
        `${target.stationName} ${lead}h 预测完成：峰值 ${rev.peakLevel.toFixed(2)}m（${dayjs(rev.peakTime).format('HH:mm')}）`,
      )
    } catch (e: any) {
      message.error(`预测失败：${e?.message ?? '未知错误'}`)
    } finally {
      setPredicting(false)
    }
  }

  const handleInjectRain = () => {
    const target = stationList[0]
    if (!target) return
    modal.confirm({
      title: `向 ${target.stationName} 注入模拟暴雨？`,
      content: '演示功能：注入 heavy 强度降雨事件，观察水位上涨与预警产生（SSE 实时推送）。',
      okText: '注入',
      cancelText: '取消',
      onOk: async () => {
        try {
          const { injectSimEvent } = await import('@/api/endpoints')
          await injectSimEvent(target.stationId, 'heavy')
          message.success('已注入暴雨事件，水位将在后续采样中上升')
        } catch (e: any) {
          message.error(`注入失败：${e?.message ?? '未知错误'}`)
        }
      },
    })
  }

  const agentCard = useMemo(() => buildOverviewCard(stationList, stats), [stationList, stats])

  // KPI 指标带（观感升级 ①）：全部真实数据
  const { data: sourcesForKpi } = useDatasources()
  const sourcesSummary = {
    enabled: (sourcesForKpi ?? []).filter((d) => d.enabled).length,
    total: sourcesForKpi?.length ?? 0,
  }
  const maxLevelStation = useMemo(
    () => [...stationList].sort((a, b) => (b.currentLevel ?? -999) - (a.currentLevel ?? -999))[0],
    [stationList],
  )
  const latestForecastAt = useMemo(() => {
    const t = recentForecasts[0]?.generatedAt
    return t ? dayjs(t).format('HH:mm') : null
  }, [recentForecasts])
  const kpiItems = [
    {
      label: '最高水位站点',
      value: maxLevelStation?.currentLevel != null ? maxLevelStation.currentLevel.toFixed(2) : '—',
      unit: 'm',
      hint: maxLevelStation ? `${maxLevelStation.stationName}` : '暂无数据',
      tone: (maxLevelStation?.alertLevel ?? 0) >= 1 ? 'danger' : 'default',
      icon: <EnvironmentOutlined />,
    },
    {
      label: '活跃预警',
      value: stats?.activeTotal ?? '—',
      unit: '条',
      hint: `${criticalStations.length} 个预警站点`,
      tone: (stats?.activeTotal ?? 0) > 0 ? 'warning' : 'default',
      icon: <WarningOutlined />,
    },
    {
      label: '今日预警',
      value: stats?.todayTotal ?? '—',
      unit: '条',
      hint: stats?.maxEffectiveLevel ? `最高生效 ${levelKeyName(stats.maxEffectiveLevel)}` : '水位平稳',
      tone: 'default',
      icon: <ClockCircleOutlined />,
    },
    {
      label: '启用数据源',
      value: sourcesSummary.enabled,
      unit: `/ ${sourcesSummary.total}`,
      hint: '实时接入',
      tone: sourcesSummary.total > 0 && sourcesSummary.enabled === sourcesSummary.total ? 'success' : 'default',
      icon: <ThunderboltOutlined />,
    },
    {
      label: '监测站点',
      value: stationList.length || '—',
      unit: '个',
      hint: '在线采集',
      tone: 'default',
      icon: <AimOutlined />,
    },
    {
      label: '最近预测',
      value: latestForecastAt ?? '—',
      hint: latestForecastAt ? '滚动预测自动执行' : '等待预测周期',
      tone: latestForecastAt ? 'primary' : 'default',
      icon: <ReloadOutlined />,
    },
  ] as const

  const bgColor = isScreenMode ? '#0B1120' : '#f8fafc'
  const textColor = isScreenMode ? '#f1f5f9' : '#0f172a'

  const timeSliceOptions: { value: TimeSlice; label: string }[] = [
    { value: 'realtime', label: '实时' },
    ...enabledLeads.map((l) => ({ value: l.lead as TimeSlice, label: `${l.lead}h 预见` })),
  ]

  return (
    <div className="flex flex-col page-anim" style={{ background: bgColor, color: textColor, minHeight: 'calc(100vh - 40px)' }}>
      {/* L2 顶部工具栏：时间切片 + 操作（<768px 允许换行） */}
      <div className="flex items-center justify-between gap-2 flex-wrap px-4 py-2" style={{ background: isScreenMode ? '#131C2E' : '#fff', borderBottom: isScreenMode ? '1px solid #1E2A40' : '1px solid var(--border-1)' }}>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">时间切片</span>
          <Tabs
            size="small"
            activeKey={String(timeSlice)}
            onChange={(k) => setTimeSlice(k === 'realtime' ? 'realtime' : (Number(k) as TimeSlice))}
            items={timeSliceOptions.map((o) => ({ key: String(o.value), label: o.label }))}
          />
        </div>
        {/* 契约 §8：<768px 按钮组需换行，Space 不换行故改 flex-wrap */}
        <div className="flex items-center gap-2 flex-wrap">
          {isScreenMode && (
            <Button size="small" onClick={() => setSearchParams({})} icon={<AimOutlined />}>
              退出大屏 (ESC)
            </Button>
          )}
          {!isScreenMode && (
            <Button size="small" type="primary" ghost onClick={() => setSearchParams({ screen: '1' })} icon={<EnvironmentOutlined />}>
              进入大屏模式
            </Button>
          )}
          <Button size="small" icon={<WarningOutlined />} onClick={handleInjectRain} disabled={stationList.length === 0}>
            注入暴雨(演示)
          </Button>
          <Button size="small" icon={<ReloadOutlined />} loading={predicting} onClick={handlePredict} disabled={stationList.length === 0}>
            手动触发预测
          </Button>
        </div>
      </div>

      {/* 加载 / 错误态 */}
      {loadingStations && (
        <div className="flex items-center justify-center" style={{ height: 400 }}>
          <Spin tip="正在加载监测点数据…" />
        </div>
      )}
      {stationsError && !loadingStations && (
        <div className="p-4">
          <Card size="small">
            <div className="text-sm text-red-600 mb-2">监测点数据加载失败：{(stationsErrorObj as Error)?.message ?? '后端不可达'}</div>
            <Space>
              <Button size="small" type="primary" onClick={() => refetchStations()}>重试</Button>
              <Button size="small" onClick={handleInjectRain} disabled>注入暴雨(演示)</Button>
            </Space>
          </Card>
        </div>
      )}

      {/* KPI 指标带 */}
      {!loadingStations && !stationsError && <KpiBand items={[...kpiItems]} />}

      {/* L3 主体：左地图 + 右侧边栏 */}
      {!loadingStations && !stationsError && (
        <div className="flex-1 flex flex-col xl:flex-row" style={{ minHeight: 0 }}>
          <div className="flex-1 relative" style={{ minHeight: 500 }}>
            <GisMap
              stations={stationList}
              darkMode={isScreenMode}
              onStationClick={(s) => { setSelectedStation(s); setDrawerOpen(true) }}
            />
            {/* 边角 Agent 摘要 */}
            <div className="absolute top-3 left-3 w-80 z-10">
              <AgentCard card={agentCard} compact />
            </div>
            {/* 右下：当前时间切片说明 */}
            <div className="absolute bottom-3 right-3 bg-white/90 backdrop-blur px-3 py-2 rounded text-xs shadow-md z-10">
              <div className="text-slate-500">当前视图</div>
              <div className="font-medium text-slate-800">
                {timeSlice === 'realtime' ? '实时监测' : `${timeSlice}小时预见期预测`}
              </div>
              <div className="text-slate-400 mt-0.5">
                {activeAlerts.length} 个活跃预警 · {criticalStations.length} 个预警站点 · 共 {stationList.length} 站
              </div>
            </div>
          </div>

          {/* 右侧栏（<1280px 折叠到地图下方） */}
          <div className="w-full xl:w-96 flex flex-col gap-3 p-3 overflow-auto" style={{
            background: isScreenMode ? '#131C2E' : '#fff',
            borderLeft: isScreenMode ? '1px solid #1E2A40' : '1px solid var(--border-1)',
          }}>
            <Tabs
              activeKey={tabKey}
              onChange={setTabKey}
              size="small"
              items={[
                { key: 'critical', label: `预警站点 (${criticalStations.length})` },
                { key: 'forecasts', label: '最近预测' },
                { key: 'alerts', label: `活跃预警 (${activeAlerts.length})` },
              ]}
            />
            {tabKey === 'critical' && (
              <div className="space-y-2">
                {criticalStations.length === 0 ? (
                  <Empty description={stationList.length === 0 ? '暂无监测点数据' : '当前无预警站点，水位平稳'} />
                ) : criticalStations.map((s) => (
                  <Card
                    key={s.stationId} size="small" hoverable
                    onClick={() => { setSelectedStation(s); setDrawerOpen(true) }}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium text-sm flex items-center gap-2">
                          {s.stationName}
                          <AlertBadge rank={s.alertLevel} size="small" />
                        </div>
                        <div className="text-xs text-slate-500 mt-1">
                          {s.location ?? s.stationCode} · 当前水位{' '}
                          <span className="font-mono font-semibold text-slate-800">
                            {s.currentLevel?.toFixed(2) ?? '—'}m
                          </span>
                        </div>
                      </div>
                      <div className="text-right">{TREND_TAG[s.trend] ?? <Tag>{s.trend}</Tag>}</div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
            {tabKey === 'forecasts' && (
              <div className="space-y-1.5">
                {recentForecasts.length === 0 ? (
                  <Empty description="暂无预测记录（等待预测周期执行或手动触发）" />
                ) : recentForecasts.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between p-2 rounded border border-slate-100 hover:bg-slate-50 text-xs cursor-pointer"
                    onClick={() => {
                      useAppStore.getState().setSelectedStation(r.stationId)
                      navigate('/trend')
                    }}
                  >
                    <div>
                      <div className="font-medium flex items-center gap-2">
                        {r.stationCode}
                        {r.triggeredAlertLevel !== null && r.triggeredAlertLevel !== undefined && (
                          <AlertBadge rank={r.triggeredAlertLevel} size="small" />
                        )}
                        {r.degraded && <Tag color="orange">降级</Tag>}
                      </div>
                      <div className="text-slate-500 mt-0.5">
                        <ClockCircleOutlined /> {dayjs(r.generatedAt).format('MM-DD HH:mm')} · 预见期 {r.lead}h · 峰值 {r.peakLevel.toFixed(2)}m
                      </div>
                    </div>
                    <Tag color="blue">{r.modelVersion}</Tag>
                  </div>
                ))}
              </div>
            )}
            {tabKey === 'alerts' && (
              <div className="space-y-2">
                {activeAlerts.length === 0 ? <Empty description="无活跃预警" /> :
                  activeAlerts.slice(0, 20).map((a) => (
                    <Card
                      key={a.alertId} size="small" hoverable
                      onClick={() => navigate('/alerts')}
                      style={{ borderLeft: `3px solid ${a.levelColor}` }}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="font-medium text-sm">{a.stationName}</div>
                        <AlertBadge rank={a.level} size="small" />
                      </div>
                      <div className="text-xs text-slate-500">
                        峰值 <span className="font-semibold text-slate-800">{a.peakLevel?.toFixed(2) ?? '—'}m</span>
                        {a.lead !== null && a.lead !== undefined && <> · 提前 {Math.round(a.lead)}min</>}
                      </div>
                      <div className="text-xs text-slate-400 mt-1">
                        {dayjs(a.alertTime).format('HH:mm')} 触发 · {a.levelName}预警
                      </div>
                    </Card>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 站点详情抽屉 */}
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={480}
        title={selectedStation ? `${selectedStation.stationName} (${selectedStation.stationCode})` : '站点详情'}
        extra={selectedStation && selectedStation.alertLevel !== null ? <AlertBadge rank={selectedStation.alertLevel} /> : undefined}
      >
        {selectedStation && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs text-slate-500">所属区域</div>
                <div className="font-medium">{selectedStation.location ?? '—'}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">当前水位</div>
                <div className="font-mono font-semibold text-lg">
                  {selectedStation.currentLevel?.toFixed(2) ?? '—'}m
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">变化趋势</div>
                <div>{selectedStation.trend === 'rising' ? '↗ 上涨' : selectedStation.trend === 'falling' ? '↘ 下降' : '→ 持平'}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">最后更新</div>
                <div className="text-xs">{selectedStation.currentTs ? dayjs(selectedStation.currentTs).format('HH:mm:ss') : '—'}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">数据时延</div>
                <div>{selectedStation.dataAgeMin !== null && selectedStation.dataAgeMin !== undefined ? `${selectedStation.dataAgeMin.toFixed(0)} 分钟前` : '—'}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">站点类型</div>
                <div>{selectedStation.kind ?? '—'}</div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                type="primary"
                onClick={() => {
                  useAppStore.getState().setSelectedStation(selectedStation.stationId)
                  navigate('/trend')
                }}
              >
                查看趋势
              </Button>
              <Button onClick={() => navigate('/alerts')}>查看预警</Button>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  )
}
