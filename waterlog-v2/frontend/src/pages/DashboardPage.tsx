// 监控总览：KPI 指标带 + 设备地图 + 实时告警 + 趋势
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Card, Col, Row, Empty, Tag, Button, Space, App, Segmented, Skeleton } from 'antd'
import {
  AlertOutlined, CloudOutlined, ClusterOutlined, RiseOutlined, ThunderboltOutlined, ReloadOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import { PageHeader } from '@/components/common/PageHeader'
import { KpiBand } from '@/components/common/KpiBand'
import { ErrorState } from '@/components/common/ErrorState'
import { GisMap } from '@/components/gis/GisMap'
import type { MapStation } from '@/components/gis/GisMap'
import { TrendChart } from '@/components/charts/TrendChart'
import {
  useAlarmStats, useAlarms, useDevices, useLatestAll, useSeries, useInjectRain, useSystemStatus,
} from '@/api/queries'
import { useAlertLevels } from '@/hooks/useAlertLevels'
import { levelLabel, levelInk, levelColor } from '@/utils/levels'
import { HEX } from '@/utils/tokens'
import type { Alarm } from '@/api/types'

export const DashboardPage: React.FC = () => {
  const { message, modal } = App.useApp()
  const navigate = useNavigate()
  const { getLevelByKey } = useAlertLevels()
  const { data: devices = [] } = useDevices()
  const { data: stats } = useAlarmStats()
  const { data: latestAll = [] } = useLatestAll()
  const { data: status } = useSystemStatus()
  const { data: activePage, isLoading: alarmsLoading, isError: alarmsError, refetch: refetchAlarms } =
    useAlarms({ status: 'active', pageSize: 30 })
  const { getThresholdLines } = useAlertLevels()
  const inject = useInjectRain()

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [hours, setHours] = useState(3)

  // 当前选中设备：默认最高告警设备，否则第一台在线设备
  const activeAlarms = activePage?.items ?? []

  // 新告警到达检测（规范 §5.2 状态转换动机）：
  // 首次渲染不算新，之后出现的 id 才标记为「新」，播放一次性脉冲。
  const seenAlarmIds = useRef<Set<number>>(new Set())
  const firstRun = useRef(true)
  const [freshAlarmIds, setFreshAlarmIds] = useState<Set<number>>(new Set())
  useEffect(() => {
    if (firstRun.current) {
      activeAlarms.forEach((a) => seenAlarmIds.current.add(a.id))
      firstRun.current = false
      return
    }
    const fresh = new Set<number>()
    activeAlarms.forEach((a) => {
      if (!seenAlarmIds.current.has(a.id)) {
        seenAlarmIds.current.add(a.id)
        fresh.add(a.id)
      }
    })
    if (fresh.size === 0) return
    setFreshAlarmIds(fresh)
    const timer = window.setTimeout(() => setFreshAlarmIds(new Set()), 3200)
    return () => window.clearTimeout(timer)
  }, [activeAlarms])
  const effectiveSelectedId = useMemo(() => {
    if (selectedId) return selectedId
    const hot = activeAlarms[0]?.deviceId
    if (hot) return hot
    return devices.find((d) => d.status === 'online')?.id ?? devices[0]?.id ?? 0
  }, [selectedId, activeAlarms, devices])

  // 每设备水位与最高告警等级
  const metricsByDevice = useMemo(() => {
    const map = new Map<number, Record<string, number>>()
    latestAll.forEach((p) => {
      const cur = map.get(p.deviceId) ?? {}
      cur[p.metric] = p.value
      map.set(p.deviceId, cur)
    })
    return map
  }, [latestAll])

  const alarmLevelByDevice = useMemo(() => {
    const map = new Map<number, number>()
    activeAlarms.forEach((a) => {
      const prev = map.get(a.deviceId) ?? 0
      map.set(a.deviceId, Math.max(prev, a.levelRank))
    })
    return map
  }, [activeAlarms])

  const mapStations: MapStation[] = useMemo(
    () => devices.map((d) => ({
      stationId: d.id,
      stationName: d.name,
      lat: d.lat,
      lng: d.lon,
      currentLevel: metricsByDevice.get(d.id)?.water_level ?? null,
      alertLevel: alarmLevelByDevice.get(d.id) ?? null,
    })),
    [devices, metricsByDevice, alarmLevelByDevice],
  )

  const { data: series } = useSeries(effectiveSelectedId, 'water_level', hours)
  const selectedDevice = devices.find((d) => d.id === effectiveSelectedId)

  const maxLevel = useMemo(() => {
    let best: { name: string; value: number } | null = null
    devices.forEach((d) => {
      const v = metricsByDevice.get(d.id)?.water_level
      if (v !== undefined && (!best || v > best.value)) best = { name: d.name, value: v }
    })
    return best as { name: string; value: number } | null
  }, [devices, metricsByDevice])

  const thresholds = getThresholdLines()
  const chartSeries = [
    {
      name: `${selectedDevice?.name ?? '设备'} 水位`,
      type: 'line' as const,
      color: HEX.primary,
      data: (series?.points ?? []).map((p) => [p.ts * 1000, p.value] as [number, number]),
    },
  ]
  const rainfallData = useRainSeries(effectiveSelectedId, hours)

  const handleInject = (power: number) => {
    modal.confirm({
      title: power === 0 ? '结束模拟降雨？' : `注入模拟降雨（强度 ${power}）？`,
      content: power === 0
        ? '水位将逐步回落，生效告警会在条件恢复后自动解除（CLEARED_*）。'
        : '水位将在数十秒内抬升，用于演示规则引擎与告警状态机。',
      okText: '确认',
      cancelText: '取消',
      onOk: async () => {
        await inject.mutateAsync(power)
        message.success(power === 0 ? '已结束降雨' : '已注入降雨')
      },
    })
  }

  return (
    <div className="p-6 page-pad page-anim space-y-4" style={{ background: 'var(--bg-canvas)', minHeight: '100vh' }}>
      <PageHeader
        title="监控总览"
        description="设备地图 · 实时遥测 · 告警即时推送（SSE）"
        extra={
          <Space wrap>
            <Button size="small" icon={<ThunderboltOutlined />} onClick={() => handleInject(2.6)} loading={inject.isPending}>
              注入暴雨（演示）
            </Button>
            <Button size="small" icon={<CloudOutlined />} onClick={() => handleInject(0)} disabled={!status?.raining}>
              结束降雨
            </Button>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => navigate('/telemetry')}>
              遥测详情
            </Button>
          </Space>
        }
      />

      <KpiBand
        items={[
          {
            label: '最高水位',
            value: maxLevel ? maxLevel.value : '—',
            decimals: 2,
            unit: 'm',
            hint: maxLevel ? maxLevel.name : '暂无遥测',
            tone: 'primary',
            icon: <RiseOutlined />,
          },
          {
            label: '生效告警',
            value: stats?.activeTotal ?? '—',
            unit: '条',
            hint: stats?.maxActiveLevel ? `最高 ${levelLabel(stats.maxActiveLevel)}` : '当前无告警',
            tone: (stats?.activeTotal ?? 0) > 0 ? 'danger' : 'default',
            icon: <AlertOutlined />,
          },
          {
            label: '待确认',
            value: stats?.unackTotal ?? '—',
            unit: '条',
            hint: '未确认的生效告警',
            tone: (stats?.unackTotal ?? 0) > 0 ? 'warning' : 'default',
            icon: <AlertOutlined />,
          },
          {
            label: '在线设备',
            value: `${devices.filter((d) => d.status === 'online').length}/${devices.length}`,
            hint: '60 秒无上报判为滞后',
            tone: 'success',
            icon: <ClusterOutlined />,
          },
        ]}
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Card
            size="small"
            title="设备分布"
            extra={<span className="text-xs" style={{ color: 'var(--text-3)' }}>点击标记查看趋势</span>}
            styles={{ body: { padding: 0 } }}
          >
            <GisMap
              stations={mapStations}
              height={430}
              onStationClick={(s) => setSelectedId(s.stationId)}
            />
          </Card>
        </Col>

        <Col xs={24} xl={8}>
          <Card
            size="small"
            title="实时告警"
            extra={<a onClick={() => navigate('/alarms')} className="text-xs">全部 →</a>}
            styles={{ body: { padding: 12, maxHeight: 430, overflow: 'auto' } }}
          >
            {alarmsError ? (
              <ErrorState compact onRetry={() => refetchAlarms()} />
            ) : alarmsLoading ? (
              <div className="space-y-2" aria-hidden>
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-subtle)' }}>
                    <Skeleton active title={false} paragraph={{ rows: 1, width: '62%' }} />
                  </div>
                ))}
              </div>
            ) : activeAlarms.length === 0 ? (
              <div className="empty-state">
                <div className="empty-title">当前无生效告警</div>
                <div>所有监测点水位处于安全区间，规则引擎未触发任何等级。</div>
                <Button size="small" icon={<ThunderboltOutlined />} onClick={() => handleInject(2.6)}>
                  注入模拟降雨
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {activeAlarms.slice(0, 8).map((a: Alarm, idx: number) => (
                  <div
                    key={a.id}
                    className={`relative rounded-lg px-3 py-2 cursor-pointer press stagger-item${freshAlarmIds.has(a.id) ? ' alarm-pulse' : ''}`}
                    style={{
                      background: 'var(--bg-subtle)',
                      borderLeft: `3px solid ${levelColor(a.levelKey)}`,
                      '--i': idx,
                      '--pulse-color': levelColor(a.levelKey),
                    } as React.CSSProperties}
                    onClick={() => navigate('/alarms')}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate" style={{ color: 'var(--text-1)' }}>
                        {a.deviceName}
                      </span>
                      <Tag
                        style={{
                          marginInlineEnd: 0,
                          color: levelInk(a.levelKey),
                          background: 'var(--bg-surface)',
                          borderColor: levelColor(a.levelKey),
                        }}
                      >
                        {levelLabel(a.levelKey)}
                      </Tag>
                    </div>
                    <div className="text-xs mt-1 flex items-center justify-between" style={{ color: 'var(--text-3)' }}>
                      <span>{a.currentValue != null ? `${a.currentValue.toFixed(2)} m` : '—'}</span>
                      <span>{a.status === 'ACTIVE_ACK' ? '已确认' : '未确认'} · {dayjs.unix(a.startTs).format('HH:mm')}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title={`水位趋势 · ${selectedDevice?.name ?? '未选择设备'}`}
        extra={
          <Space wrap>
            <Segmented
              size="small"
              value={hours}
              onChange={(v) => setHours(v as number)}
              options={[{ label: '1h', value: 1 }, { label: '3h', value: 3 }, { label: '6h', value: 6 }]}
            />
          </Space>
        }
      >
        {chartSeries[0].data.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无遥测数据（等待模拟器上报）" />
        ) : (
          <TrendChart
            series={chartSeries}
            height={320}
            showThreshold
            showRainfall={rainfallData.length > 0}
            rainfallData={rainfallData}
          />
        )}
        <div className="text-xs mt-2" style={{ color: 'var(--text-3)' }}>
          阈值线由规则表实时推导：{thresholds.map((t) => `${t.name} ${t.value.toFixed(2)}m`).join(' · ') || '未配置'}
        </div>
      </Card>
    </div>
  )
}

// 雨量序列（水位同设备的 rainfall 指标）
function useRainSeries(deviceId: number, hours: number): [number, number][] {
  // 复用 useSeries 需要在 hook 层调用，这里通过独立查询钩子获取
  const { data } = useSeries(deviceId, 'rainfall', hours)
  return (data?.points ?? []).map((p) => [p.ts * 1000, p.value] as [number, number])
}
