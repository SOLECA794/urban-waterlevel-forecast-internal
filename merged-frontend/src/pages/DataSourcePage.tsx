// P4: 数据源与融合管理（真实接口版）
// 启停 / 刷新间隔走 PUT /datasources/{id}，实时质量指标来自后端
import React, { useState } from 'react'
import {
  App, Card, Tabs, Table, Tag, Space, Button, Statistic, Row, Col, Drawer, Descriptions,
  Alert as AntAlert, Switch, InputNumber, Spin, Empty,
} from 'antd'
import {
  ApiOutlined, DatabaseOutlined, ReloadOutlined, EyeOutlined, CheckCircleOutlined, ClockCircleOutlined,
} from '@ant-design/icons'
import { AgentCard } from '@/components/agent/AgentCard'
import { useDatasources, useUpdateDatasource } from '@/api/queries'
import { buildDatasourceCard } from '@/utils/agentCards'
import type { Datasource } from '@/types'
import { PageHeader } from '@/components/common/PageHeader'

// 后端状态值 → 展示（connected/STREAMING/READY 为正常；STALE 滞后；ERROR/DISCONNECTED 异常）
// 视觉契约：用 antd 状态预设（跟随主题令牌），不用裸色值
function statusView(s: string): { label: string; color: string } {
  const u = s.toUpperCase()
  if (s === 'connected' || u === 'STREAMING' || u === 'READY' || u === 'OK') return { label: '已接入', color: 'success' }
  if (u === 'STALE') return { label: '数据滞后', color: 'warning' }
  if (u === 'ERROR' || u === 'DISCONNECTED') return { label: '异常', color: 'error' }
  return { label: s, color: 'default' }
}

const TYPE_LABEL: Record<string, string> = {
  history_rain: '历史降雨',
  historical_rain: '历史降雨',
  realtime_monitor: '实时监测',
  history_waterlog: '历史积水',
  historical_waterlog: '历史积水',
  weather_forecast: '气象预报',
  simulated_water_level: '模拟水位',
  simulated: '模拟源',
}

export const DataSourcePage: React.FC = () => {
  const { message } = App.useApp()
  const { data: sources, isLoading, isError, error, refetch } = useDatasources()
  const updateM = useUpdateDatasource()
  const [selected, setSelected] = useState<Datasource | null>(null)
  const [syncing, setSyncing] = useState<number | null>(null)
  const [tabKey, setTabKey] = useState<string>('all')
  const [editingInterval, setEditingInterval] = useState<number | null>(null)

  const list = sources ?? []
  const filteredSources = tabKey === 'all' ? list : list.filter((s) => (tabKey === 'connected' ? s.enabled : !s.enabled))

  const handleSync = async (id: number) => {
    setSyncing(id)
    try {
      await refetch()
      message.success('数据源状态已刷新')
    } finally {
      setSyncing(null)
    }
  }

  const handleToggle = async (s: Datasource, enabled: boolean) => {
    try {
      await updateM.mutateAsync({ id: s.id, body: { enabled } })
      message.success(`${s.name} 已${enabled ? '启用' : '停用'}`)
    } catch (e: any) {
      message.error(`操作失败：${e?.message ?? '未知错误'}`)
    }
  }

  const handleSaveInterval = async (s: Datasource, sec: number) => {
    try {
      await updateM.mutateAsync({ id: s.id, body: { refreshIntervalSec: sec } })
      message.success(`${s.name} 刷新间隔已更新为 ${sec}s`)
      setEditingInterval(null)
    } catch (e: any) {
      message.error(`保存失败：${e?.message ?? '未知错误'}`)
    }
  }

  const enabledSources = list.filter((s) => s.enabled)
  const withQ = enabledSources.filter((s) => s.quality.successRate !== null && s.quality.successRate !== undefined)
  const stats = {
    total: list.length,
    connected: enabledSources.length,
    disabled: list.length - enabledSources.length,
    avgSuccess: withQ.length > 0 ? withQ.reduce((acc, s) => acc + (s.quality.successRate ?? 0), 0) / withQ.length : null,
  }

  const agentCard = buildDatasourceCard(list)

  return (
    <div className="p-6 page-pad page-anim space-y-4" style={{ background: 'var(--bg-canvas)', minHeight: '100vh' }}>
      <PageHeader title="数据源与融合管理" description="四源接入状态 · 实时质量监控 · 刷新策略" />

      <Row gutter={12}>
        <Col span={6} className="stat-grid-4">
          <Card size="small"><Statistic title="数据源总数" value={stats.total} prefix={<DatabaseOutlined />} valueStyle={{ color: 'var(--text-1)' }} /></Card>
        </Col>
        <Col span={6} className="stat-grid-4">
          <Card size="small">
            <Statistic
              title="已启用" value={stats.connected} valueStyle={{ color: 'var(--text-1)' }}
              prefix={<CheckCircleOutlined />} suffix={`/ ${stats.total}`}
            />
          </Card>
        </Col>
        <Col span={6} className="stat-grid-4">
          <Card size="small">
            <Statistic title="已停用" value={stats.disabled} valueStyle={{ color: stats.disabled > 0 ? '#D97706' : 'var(--text-3)' }} prefix={<ClockCircleOutlined />} />
          </Card>
        </Col>
        <Col span={6} className="stat-grid-4">
          <Card size="small">
            <Statistic
              title="平均成功率" value={stats.avgSuccess !== null ? (stats.avgSuccess * 100).toFixed(1) : '—'}
              suffix={stats.avgSuccess !== null ? '%' : ''} precision={stats.avgSuccess !== null ? 1 : undefined}
              prefix={<ApiOutlined />} valueStyle={{ color: stats.avgSuccess !== null ? 'var(--text-1)' : 'var(--text-3)' }}
            />
          </Card>
        </Col>
      </Row>

      <AntAlert
        message="多源融合架构"
        description="预测执行时，输入特征向量由多源数据拼接而成（历史降雨、实时监测、历史积水、气象预报）；任一源缺失或滞后会降低预见期准确率。启停与刷新间隔修改即时生效。"
        type="info" showIcon
      />

      <AgentCard card={agentCard} />

      <Card size="small" className="border-slate-200">
        <Tabs
          activeKey={tabKey}
          onChange={setTabKey}
          items={[
            { key: 'all', label: `全部 (${list.length})` },
            { key: 'connected', label: `已启用 (${stats.connected})` },
            { key: 'disabled', label: `已停用 (${stats.disabled})` },
          ]}
        />

        {isError ? (
          <AntAlert
            type="error" showIcon message="数据源列表加载失败"
            description={(error as Error)?.message ?? '后端不可达'}
            action={<Button size="small" onClick={() => refetch()}>重试</Button>}
          />
        ) : isLoading ? (
          <div className="flex justify-center py-12"><Spin /></div>
        ) : (
          <Table<Datasource>
            rowKey="id"
            dataSource={filteredSources}
            size="small"
            pagination={false}
            onRow={(r) => ({ onClick: () => { setSelected(r); setEditingInterval(r.refreshIntervalSec) } })}
            rowClassName="cursor-pointer hover:bg-slate-50"
            columns={[
              {
                title: '名称',
                dataIndex: 'name',
                render: (_, r) => (
                  <div>
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-slate-500">{TYPE_LABEL[r.type] ?? r.type} · #{r.id}</div>
                  </div>
                ),
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 110,
                render: (s: string) => {
                  const v = statusView(s)
                  return <Tag color={v.color}>{v.label}</Tag>
                },
              },
              {
                title: '接入地址',
                dataIndex: 'endpoint',
                width: 220,
                render: (v: string | null) => v ? <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">{v}</code> : <span className="text-xs text-slate-400">—</span>,
              },
              {
                title: '刷新频率',
                dataIndex: 'refreshIntervalSec',
                width: 110,
                render: (v: number) => (v < 60 ? `${v}s` : `${Math.round(v / 60)}min`),
              },
              {
                title: '质量',
                dataIndex: 'quality',
                width: 200,
                render: (q: Datasource['quality']) => {
                  const sr = q.successRate
                  if (sr === null || sr === undefined) return <span className="text-xs text-slate-400">—</span>
                  return (
                    <div className="space-y-1">
                      <div className="text-xs">
                        <span className="font-mono">{(sr * 100).toFixed(1)}%</span>
                        {q.avgLatency !== null && q.avgLatency !== undefined && (
                          <span className="text-slate-500 ml-2">延迟 {q.avgLatency.toFixed(0)}ms</span>
                        )}
                      </div>
                      <div className="h-1.5 bg-slate-100 rounded overflow-hidden">
                        <div
                          className="h-full rounded"
                          style={{
                            width: `${sr * 100}%`,
                            background: sr > 0.95 ? '#16A34A' : sr > 0.9 ? '#D97706' : '#DC2626',
                          }}
                        />
                      </div>
                    </div>
                  )
                },
              },
              {
                title: '启用',
                dataIndex: 'enabled',
                width: 80,
                render: (e: boolean, r) => (
                  <span onClick={(ev) => ev.stopPropagation()}>
                    <Switch size="small" checked={e} loading={updateM.isPending} onChange={(v) => handleToggle(r, v)} />
                  </span>
                ),
              },
              {
                title: '操作',
                width: 130,
                render: (_, r) => (
                  <Space size="small" onClick={(e) => e.stopPropagation()}>
                    <Button size="small" icon={<EyeOutlined />} onClick={() => { setSelected(r); setEditingInterval(r.refreshIntervalSec) }}>详情</Button>
                    <Button
                      size="small" icon={<ReloadOutlined spin={syncing === r.id} />}
                      loading={syncing === r.id} onClick={() => handleSync(r.id)}
                    >
                      刷新
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Drawer
        title={selected?.name}
        placement="right"
        width={520}
        open={!!selected}
        onClose={() => setSelected(null)}
      >
        {selected && <SourceDetail source={selected} editingInterval={editingInterval} setEditingInterval={setEditingInterval} onSaveInterval={handleSaveInterval} saving={updateM.isPending} />}
      </Drawer>
    </div>
  )
}

const SourceDetail: React.FC<{
  source: Datasource
  editingInterval: number | null
  setEditingInterval: (v: number | null) => void
  onSaveInterval: (s: Datasource, sec: number) => void
  saving: boolean
}> = ({ source, editingInterval, setEditingInterval, onSaveInterval, saving }) => {
  const sv = statusView(source.status)
  const schemaRows = Array.isArray(source.schema)
    ? (source.schema as Record<string, string>[])
    : []

  return (
    <div className="space-y-4">
      <Tag color={sv.color}>{sv.label}</Tag>
      {source.lastError && <AntAlert type={sv.color === 'green' ? 'info' : 'warning'} message={source.lastError} showIcon />}

      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="数据源ID">#{source.id}</Descriptions.Item>
        <Descriptions.Item label="类型">{TYPE_LABEL[source.type] ?? source.type}</Descriptions.Item>
        <Descriptions.Item label="接入地址">
          <code className="text-xs">{source.endpoint ?? '—'}</code>
        </Descriptions.Item>
        <Descriptions.Item label="刷新频率（秒）">
          <Space>
            <InputNumber
              min={5} max={86400} value={editingInterval ?? source.refreshIntervalSec}
              onChange={(v) => setEditingInterval(v ?? source.refreshIntervalSec)}
            />
            <Button
              size="small" type="primary" loading={saving}
              disabled={editingInterval === null || editingInterval === source.refreshIntervalSec}
              onClick={() => editingInterval !== null && onSaveInterval(source, editingInterval)}
            >
              保存
            </Button>
          </Space>
          <div className="text-xs text-slate-400 mt-1">后端要求不低于 5 秒</div>
        </Descriptions.Item>
        {source.quality.successRate !== null && source.quality.successRate !== undefined && (
          <>
            <Descriptions.Item label="成功率">{(source.quality.successRate * 100).toFixed(2)}%</Descriptions.Item>
            <Descriptions.Item label="缺失率">
              {source.quality.missingRate !== null && source.quality.missingRate !== undefined
                ? `${(source.quality.missingRate * 100).toFixed(2)}%` : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="平均延迟">
              {source.quality.avgLatency !== null && source.quality.avgLatency !== undefined
                ? `${source.quality.avgLatency.toFixed(0)}ms` : '—'}
            </Descriptions.Item>
          </>
        )}
      </Descriptions>

      <div>
        <div className="text-sm font-medium text-slate-700 mb-2">数据 Schema</div>
        {schemaRows.length === 0 ? (
          <Empty description="无 Schema 信息" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Table
            size="small" pagination={false}
            rowKey={(r) => String(r.field ?? r.name ?? Math.random())}
            dataSource={schemaRows}
            columns={[
              { title: '字段', dataIndex: 'field', render: (v, r) => String(v ?? r.name ?? '—') },
              { title: '类型', dataIndex: 'type', width: 100, render: (v: string) => <Tag>{v ?? '—'}</Tag> },
              { title: '说明', dataIndex: 'description', render: (v: string) => v ?? '—' },
            ]}
          />
        )}
      </div>
    </div>
  )
}
