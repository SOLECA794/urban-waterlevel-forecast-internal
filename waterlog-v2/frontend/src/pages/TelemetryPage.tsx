// 遥测数据：设备时序 + 预测叠加 + 原始数据表
import React, { useMemo, useState } from 'react'
import { Card, Col, Empty, Row, Segmented, Select, Skeleton, Space, Table, Tag, Tooltip } from 'antd'
import { LineChartOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { PageHeader } from '@/components/common/PageHeader'
import { TrendChart } from '@/components/charts/TrendChart'
import { useDevices, useForecast, useLatest, useSeries } from '@/api/queries'
import { HEX } from '@/utils/tokens'
import { ErrorState } from '@/components/common/ErrorState'
import type { TelemetryPoint } from '@/api/types'

const METRIC_LABEL: Record<string, { label: string; unit: string }> = {
  water_level: { label: '水位', unit: 'm' },
  rainfall: { label: '降雨量', unit: 'mm' },
  flow: { label: '流量', unit: 'm³/s' },
}

export const TelemetryPage: React.FC = () => {
  const { data: devices = [] } = useDevices()
  const [deviceId, setDeviceId] = useState<number>(0)
  const [metric, setMetric] = useState('water_level')
  const [hours, setHours] = useState(3)

  const effectiveId = deviceId || devices[0]?.id || 0
  const device = devices.find((d) => d.id === effectiveId)
  const profile = device?.profileName ?? ''
  const availableMetrics = useMemo(() => {
    // 画像名 → 遥测键（来自设备画像约定；无画像信息时给默认三项）
    if (profile.includes('雨量')) return ['rainfall']
    if (profile.includes('水位')) return ['water_level']
    return ['water_level', 'rainfall', 'flow']
  }, [profile])

  const activeMetric = availableMetrics.includes(metric) ? metric : availableMetrics[0]
  const { data: series, isLoading, isError, refetch } = useSeries(effectiveId, activeMetric, hours)
  const { data: latest } = useLatest(effectiveId)
  const { data: forecast } = useForecast(effectiveId, activeMetric)

  const unit = METRIC_LABEL[activeMetric]?.unit ?? ''
  const points = series?.points ?? []

  // 图表规范 §7：实际值实线主色，预测值虚线告警色（不再使用紫色，避免 AI 模板味与第二强调色）
  const chartSeries = [
    {
      name: `历史 ${METRIC_LABEL[activeMetric]?.label ?? activeMetric}`,
      type: 'line' as const,
      color: HEX.primary,
      data: points.map((p) => [p.ts * 1000, p.value] as [number, number]),
    },
    ...(forecast?.points?.length
      ? [{
        name: `预测（${forecast.modelName} ${forecast.modelVersion}）`,
        type: 'line' as const,
        color: HEX.warning,
        lineStyle: 'dashed' as const,
        showConfidence: true,
        confidenceData: forecast.points.map((p) => [p.ts * 1000, p.lower, p.upper] as [number, number, number]),
        data: forecast.points.map((p) => [p.ts * 1000, p.value] as [number, number]),
      }]
      : []),
  ]

  const columns = [
    { title: '时间', dataIndex: 'ts', key: 'ts', width: 180, render: (ts: number) => dayjs.unix(ts).format('YYYY-MM-DD HH:mm:ss') },
    {
      title: `${METRIC_LABEL[activeMetric]?.label ?? activeMetric}（${unit}）`,
      dataIndex: 'value', key: 'value', width: 160,
      render: (v: number) => <span className="num">{v.toFixed(2)}</span>,
    },
    { title: '质量', dataIndex: 'quality', key: 'quality', width: 100, render: (q: string) => <Tag color={q === 'good' ? 'green' : 'orange'}>{q}</Tag> },
  ]

  return (
    <div className="p-6 page-pad page-anim space-y-4" style={{ background: 'var(--bg-canvas)', minHeight: '100vh' }}>
      <PageHeader
        title="遥测数据"
        description="键值时序 · 历史曲线 · 预测叠加（占位模型）"
        extra={
          <Space wrap>
            <Select
              style={{ width: 200 }}
              value={effectiveId}
              onChange={setDeviceId}
              options={devices.map((d) => ({ value: d.id, label: `${d.name}（${d.code}）` }))}
              placeholder="选择设备"
            />
            <Segmented
              value={activeMetric}
              onChange={(v) => setMetric(v as string)}
              options={availableMetrics.map((m) => ({ label: METRIC_LABEL[m]?.label ?? m, value: m }))}
            />
            <Segmented
              value={hours}
              onChange={(v) => setHours(v as number)}
              options={[{ label: '1h', value: 1 }, { label: '3h', value: 3 }, { label: '6h', value: 6 }]}
            />
          </Space>
        }
      />

      <Row gutter={12}>
        {Object.entries(latest ?? {}).map(([k, v]) => (
          <Col xs={12} md={6} key={k}>
            <Card size="small">
              <div className="text-xs" style={{ color: 'var(--text-3)' }}>
                {METRIC_LABEL[k]?.label ?? k}
              </div>
              <div className="num font-bold mt-1" style={{ fontSize: 22, color: 'var(--text-1)' }}>
                {v.value.toFixed(2)}
                <span className="text-xs ml-1" style={{ color: 'var(--text-3)' }}>{METRIC_LABEL[k]?.unit}</span>
              </div>
              <div className="text-xs" style={{ color: 'var(--text-3)' }}>
                {dayjs.unix(v.ts).format('HH:mm:ss')}
              </div>
            </Card>
          </Col>
        ))}
        {!latest && <Col span={24}><Card size="small"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该设备暂无遥测" /></Card></Col>}
      </Row>

      <Card
        size="small"
        title={`${device?.name ?? '设备'} · ${METRIC_LABEL[activeMetric]?.label ?? activeMetric} 曲线`}
        extra={<Tooltip title="预测为线性外推占位实现，真实模型见后端 EXT-POINT(MODEL)"><span className="text-xs" style={{ color: 'var(--text-3)' }}>预测：{forecast?.modelName ?? '—'} {forecast?.modelVersion ?? ''}</span></Tooltip>}
      >
        {isError ? (
          <ErrorState onRetry={() => refetch()} />
        ) : isLoading ? (
          <div className="py-4" aria-hidden>
            <Skeleton active title={false} paragraph={{ rows: 5 }} />
          </div>
        ) : points.length === 0 ? (
          <div className="empty-state">
            <div className="empty-title">暂无遥测数据</div>
            <div>设备尚未上报该指标。等待下一个采集周期，或到设备管理页确认设备在线状态。</div>
          </div>
        ) : (
          <TrendChart series={chartSeries} height={380} yLabel={`${METRIC_LABEL[activeMetric]?.label}（${unit}）`} showThreshold={activeMetric === 'water_level'} />
        )}
        {forecast?.note && (
          <div className="text-xs mt-2" style={{ color: 'var(--text-3)' }}>
            <LineChartOutlined /> {forecast.note}
          </div>
        )}
      </Card>

      <Card size="small" title={`原始数据（最近 ${Math.min(points.length, 200)} 条）`}>
        <Table
          rowKey="id"
          size="small"
          columns={columns as never}
          dataSource={[...points].reverse().slice(0, 200) as TelemetryPoint[]}
          pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
        />
      </Card>
    </div>
  )
}
