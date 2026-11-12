// 告警中心：四态生命周期（ACTIVE_UNACK/ACTIVE_ACK/CLEARED_UNACK/CLEARED_ACK）+ 处置动作
import React, { useState } from 'react'
import {
  App, Button, Card, Col, Empty, Popconfirm, Row, Segmented, Select, Space, Table, Tag, Tooltip,
} from 'antd'
import { AlertOutlined, CheckOutlined, CloseOutlined, StopOutlined, WarningOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { PageHeader } from '@/components/common/PageHeader'
import { KpiBand } from '@/components/common/KpiBand'
import { ErrorState } from '@/components/common/ErrorState'
import { useAckAlarm, useAlarmStats, useAlarms, useClearAlarm, useDevices, useFalseReport } from '@/api/queries'
import { LEVEL_META, alarmStateMeta } from '@/utils/levels'
import type { Alarm, AlarmStatus, LevelKey } from '@/api/types'

const FILTERS = [
  { label: '全部', value: '' },
  { label: '未确认', value: 'ACTIVE_UNACK' },
  { label: '已确认', value: 'ACTIVE_ACK' },
  { label: '已恢复', value: 'CLEARED' },
]

export const AlarmsPage: React.FC = () => {
  const { message } = App.useApp()
  const [statusFilter, setStatusFilter] = useState('')
  const [level, setLevel] = useState<LevelKey | undefined>()
  const [deviceId, setDeviceId] = useState<number | undefined>()
  const [page, setPage] = useState(1)

  // 「已恢复」= cleared（后端合并 CLEARED_UNACK + CLEARED_ACK 两态）
  const queryStatus = statusFilter === 'CLEARED' ? 'cleared' : statusFilter
  const { data: pageData, isLoading, isError, refetch } = useAlarms({
    status: queryStatus, level, deviceId, page, pageSize: 20,
  })
  const { data: stats } = useAlarmStats()
  const { data: devices = [] } = useDevices()

  const ack = useAckAlarm()
  const clear = useClearAlarm()
  const falseReport = useFalseReport()

  const items: Alarm[] = pageData?.items ?? []
  const total = pageData?.total ?? 0

  const doAction = async (fn: () => Promise<Alarm>, ok: string) => {
    try {
      await fn()
      message.success(ok)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const columns = [
    {
      title: '设备', key: 'device', width: 180,
      render: (_: unknown, a: Alarm) => (
        <div>
          <div style={{ color: 'var(--text-1)', fontWeight: 500 }}>{a.deviceName}</div>
          <div className="text-xs num" style={{ color: 'var(--text-3)' }}>{a.deviceCode}</div>
        </div>
      ),
    },
    {
      title: '等级', dataIndex: 'levelKey', key: 'level', width: 110,
      render: (k: LevelKey) => (
        <Tag
          style={{
            color: LEVEL_META[k].ink,
            background: 'var(--bg-surface)',
            borderColor: LEVEL_META[k].color,
          }}
        >
          {LEVEL_META[k].label}
        </Tag>
      ),
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 140,
      render: (s: AlarmStatus) => {
        const meta = alarmStateMeta(s)
        const isActive = s === 'ACTIVE_UNACK' || s === 'ACTIVE_ACK'
        return (
          <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-2)' }}>
            <span
              className={isActive ? 'live-dot' : undefined}
              style={{ width: 7, height: 7, borderRadius: 'var(--radius-pill)', background: meta.color, display: 'inline-block' }}
            />
            {meta.label}
          </span>
        )
      },
    },
    {
      title: '触发 / 当前', key: 'value', width: 150,
      render: (_: unknown, a: Alarm) => (
        <span className="num text-xs" style={{ color: 'var(--text-2)' }}>
          {a.triggerValue?.toFixed(2) ?? '—'} → <b style={{ color: 'var(--text-1)' }}>{a.currentValue?.toFixed(2) ?? '—'}</b>
        </span>
      ),
    },
    {
      title: '时间', key: 'ts', width: 170,
      render: (_: unknown, a: Alarm) => (
        <div className="text-xs" style={{ color: 'var(--text-2)' }}>
          <div>触发 {dayjs.unix(a.startTs).format('MM-DD HH:mm:ss')}</div>
          <div style={{ color: 'var(--text-3)' }}>
            {a.clearTs ? `解除 ${dayjs.unix(a.clearTs).format('MM-DD HH:mm')}（${a.clearReason === 'auto' ? '自动' : a.clearReason === 'false_report' ? '误报' : '人工'}）` : a.ackTs ? `确认 ${dayjs.unix(a.ackTs).format('MM-DD HH:mm')}` : '—'}
          </div>
        </div>
      ),
    },
    {
      title: '说明', dataIndex: 'message', key: 'message', ellipsis: true,
      render: (m: string) => <Tooltip title={m}><span className="text-xs" style={{ color: 'var(--text-2)' }}>{m}</span></Tooltip>,
    },
    {
      title: '操作', key: 'op', width: 190,
      render: (_: unknown, a: Alarm) => {
        const active = a.status === 'ACTIVE_UNACK' || a.status === 'ACTIVE_ACK'
        return (
          <Space size={2}>
            <Button
              type="link" size="small" icon={<CheckOutlined />} disabled={a.status !== 'ACTIVE_UNACK'}
              onClick={() => doAction(() => ack.mutateAsync(a.id), '已确认')}
            >
              确认
            </Button>
            <Button
              type="link" size="small" icon={<CloseOutlined />} disabled={!active}
              onClick={() => doAction(() => clear.mutateAsync(a.id), '已解除')}
            >
              解除
            </Button>
            <Popconfirm title="标记为误报？" description="将直接解除并记录误报原因" okText="标记" cancelText="取消"
              onConfirm={() => doAction(() => falseReport.mutateAsync(a.id), '已标记误报')}>
              <Button type="link" size="small" danger icon={<StopOutlined />} disabled={!active}>误报</Button>
            </Popconfirm>
          </Space>
        )
      },
    },
  ]

  return (
    <div className="p-6 page-pad page-anim space-y-4" style={{ background: 'var(--bg-canvas)', minHeight: '100vh' }}>
      <PageHeader
        title="告警中心"
        description="四态生命周期：触发 → 确认 → 恢复（自动/人工），支持误报标记"
      />

      <KpiBand
        items={[
          {
            label: '生效告警',
            value: stats?.activeTotal ?? 0,
            unit: '条',
            tone: (stats?.activeTotal ?? 0) > 0 ? 'danger' : 'default',
            icon: <AlertOutlined />,
          },
          {
            label: '待确认',
            value: stats?.unackTotal ?? 0,
            unit: '条',
            tone: (stats?.unackTotal ?? 0) > 0 ? 'warning' : 'default',
          },
          { label: '今日新增', value: stats?.todayTotal ?? 0, unit: '条' },
          {
            label: '最高等级',
            value: stats?.maxActiveLevel ? LEVEL_META[stats.maxActiveLevel].label : '无',
            color: stats?.maxActiveLevel ? LEVEL_META[stats.maxActiveLevel].ink : undefined,
          },
        ]}
      />

      <Card size="small">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <Segmented
            value={statusFilter}
            onChange={(v) => { setStatusFilter(v as string); setPage(1) }}
            options={FILTERS}
          />
          <Select
            allowClear placeholder="等级筛选" style={{ width: 140 }}
            value={level}
            onChange={(v) => { setLevel(v); setPage(1) }}
            options={Object.entries(LEVEL_META).map(([v, m]) => ({ value: v, label: m.label }))}
          />
          <Select
            allowClear showSearch optionFilterProp="label" placeholder="设备筛选" style={{ width: 180 }}
            value={deviceId}
            onChange={(v) => { setDeviceId(v); setPage(1) }}
            options={devices.map((d) => ({ value: d.id, label: d.name }))}
          />
          <div className="flex-1" />
          <span className="text-xs" style={{ color: 'var(--text-3)' }}>
            <WarningOutlined /> 条件恢复时自动解除（clearReason=auto）
          </span>
        </div>

        <Table
          rowKey="id"
          size="small"
          loading={isLoading && !isError}
          columns={columns as never}
          dataSource={items}
          locale={{
            ...(isError ? { emptyText: <ErrorState onRetry={() => refetch()} /> } : {}),
            emptyText: (
              <div className="empty-state">
                <div className="empty-title">没有符合条件的告警</div>
                <div>调整上方筛选条件，或等待规则引擎触发新的告警。</div>
              </div>
            ),
          }}
          pagination={{
            current: page, pageSize: 20, total,
            onChange: setPage, showTotal: (t) => `共 ${t} 条`,
          }}
        />
      </Card>
    </div>
  )
}
