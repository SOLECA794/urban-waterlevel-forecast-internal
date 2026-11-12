// P3: 预警管理中心 - 状态机 active→confirmed→published→resolved（真实接口版）
// 全部操作走后端接口（confirm/resolve/false-report/publish），发布历史来自后端 publish_record
import React, { useMemo, useState } from 'react'
import {
  App, Card, Tabs, Table, Tag, Space, Button, Modal, Steps, Timeline, Empty, Statistic,
  Row, Col, Form, Checkbox, Input, Alert as AntAlert, Spin, Popconfirm,
} from 'antd'
import {
  CheckCircleOutlined, SendOutlined, RollbackOutlined, ClockCircleOutlined, AlertOutlined, StopOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { AgentCard } from '@/components/agent/AgentCard'
import { useAlertLevels } from '@/hooks/useAlertLevels'
import {
  useAlertStats, useAlerts, useChannels, useConfirmAlert, useFalseReportAlert,
  usePublishAlert, useResolveAlert,
} from '@/api/queries'
import { buildAlertCard } from '@/utils/agentCards'
import type { AlertEvent, AlertStatus } from '@/types'

const STATUS_LABEL: Record<string, string> = {
  active: '已触发',
  confirmed: '已确认',
  published: '已发布',
  resolved: '已解除',
  false_report: '误报',
}
const STATUS_COLOR: Record<string, string> = {
  active: '#EA580C',
  confirmed: '#F59E0B',
  published: '#2563EB',
  resolved: '#52C41A',
  false_report: '#8C8C8C',
}

export const AlertCenterPage: React.FC = () => {
  const { message } = App.useApp()
  const [selected, setSelected] = useState<AlertEvent | null>(null)
  const [tab, setTab] = useState<string>('all')
  const { getLevelByRank } = useAlertLevels()

  // 服务端过滤：tab 切换按 status 重新查询
  const isAll = tab === 'all'
  const { data: page, isLoading, isError, error, refetch } = useAlerts(
    isAll ? { pageSize: 100 } : { status: tab, pageSize: 100 },
  )
  const { data: stats } = useAlertStats()
  const { data: channels } = useChannels()

  const confirmM = useConfirmAlert()
  const resolveM = useResolveAlert()
  const falseM = useFalseReportAlert()
  const publishM = usePublishAlert()

  const alerts = page?.items ?? []
  const busy = confirmM.isPending || resolveM.isPending || falseM.isPending || publishM.isPending
  const countByStatus = (s: AlertStatus) => alerts.filter((a) => a.status === s).length

  const handleConfirm = async (a: AlertEvent) => {
    try {
      await confirmM.mutateAsync(a.alertId)
      message.success(`已确认预警：${a.stationName}`)
    } catch (e: any) { message.error(`确认失败：${e?.message ?? '未知错误'}`) }
  }
  const handleResolve = async (a: AlertEvent) => {
    try {
      await resolveM.mutateAsync(a.alertId)
      message.success(`预警已解除：${a.stationName}`)
      if (selected?.alertId === a.alertId) setSelected(null)
    } catch (e: any) { message.error(`解除失败：${e?.message ?? '未知错误'}`) }
  }
  const handleFalseReport = async (a: AlertEvent, reason: string) => {
    try {
      await falseM.mutateAsync({ id: a.alertId, reason })
      message.warning(`已标记误报：${a.stationName}`)
      if (selected?.alertId === a.alertId) setSelected(null)
    } catch (e: any) { message.error(`标记失败：${e?.message ?? '未知错误'}`) }
  }
  const handlePublish = async (a: AlertEvent, channelTypes: string[]) => {
    try {
      await publishM.mutateAsync({ id: a.alertId, channels: channelTypes })
      const names = (channels ?? []).filter((c) => channelTypes.includes(c.type)).map((c) => c.name)
      message.success(`已通过【${names.join('、')}】发布`)
      if (selected?.alertId === a.alertId) {
        // 发布后刷新详情：取列表中最新数据
        setSelected(null)
      }
    } catch (e: any) { message.error(`发布失败：${e?.message ?? '未知错误'}`) }
  }

  return (
    <div className="p-6 space-y-4 bg-slate-50 min-h-screen">
      <h2 className="text-xl font-semibold text-slate-800">预警管理中心</h2>

      <Card size="small" className="border-slate-200">
        <Steps
          current={-1}
          items={[
            { title: '已触发', icon: <AlertOutlined />, description: '系统检测到超阈' },
            { title: '已确认', icon: <CheckCircleOutlined />, description: '值班员复核' },
            { title: '已发布', icon: <SendOutlined />, description: '通知渠道触达' },
            { title: '已解除', icon: <RollbackOutlined />, description: '水位回落 / 误报关闭' },
          ]}
        />
      </Card>

      <Row gutter={12}>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title={<span><ClockCircleOutlined /> 今日预警</span>}
              value={stats?.todayTotal ?? '—'}
              valueStyle={{ color: '#EA580C', fontSize: 24 }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title={<span><AlertOutlined /> 活跃预警</span>}
              value={stats?.activeTotal ?? '—'}
              valueStyle={{ color: '#F59E0B', fontSize: 24 }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title={<span><CheckCircleOutlined /> 生效预警（含历史）</span>}
              value={stats?.effectiveTotal ?? '—'}
              valueStyle={{ color: '#2563EB', fontSize: 24 }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title={<span><StopOutlined /> 参考性预警</span>}
              value={stats?.referenceTotal ?? '—'}
              valueStyle={{ color: '#8C8C8C', fontSize: 24 }}
            />
            {stats?.maxEffectiveLevel && (
              <div className="text-xs text-slate-400">最高生效等级：{stats.maxEffectiveLevel}</div>
            )}
          </Card>
        </Col>
      </Row>

      <Card size="small" className="border-slate-200">
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            { key: 'all', label: `全部 (${page?.total ?? '—'})` },
            { key: 'active', label: isAll ? `已触发 (${countByStatus('active')})` : '已触发' },
            { key: 'confirmed', label: isAll ? `已确认 (${countByStatus('confirmed')})` : '已确认' },
            { key: 'published', label: isAll ? `已发布 (${countByStatus('published')})` : '已发布' },
            { key: 'resolved', label: isAll ? `已解除 (${countByStatus('resolved')})` : '已解除' },
            { key: 'false_report', label: isAll ? `误报 (${countByStatus('false_report')})` : '误报' },
          ]}
        />

        {isError ? (
          <AntAlert
            type="error" showIcon
            message="预警数据加载失败"
            description={`${(error as Error)?.message ?? '后端不可达'} —— 请确认后端服务已启动`}
            action={<Button size="small" onClick={() => refetch()}>重试</Button>}
          />
        ) : isLoading ? (
          <div className="flex justify-center py-12"><Spin /></div>
        ) : (
          <Table<AlertEvent>
            rowKey="alertId"
            dataSource={alerts}
            size="small"
            pagination={{ pageSize: 10, showSizeChanger: false }}
            onRow={(r) => ({ onClick: () => setSelected(r) })}
            rowClassName={(r) => (r.alertId === selected?.alertId ? 'bg-blue-50 cursor-pointer' : 'cursor-pointer hover:bg-slate-50')}
            columns={[
              {
                title: '等级',
                dataIndex: 'level',
                width: 100,
                render: (_, r) => {
                  const levelCfg = getLevelByRank(r.level)
                  const color = levelCfg?.color || r.levelColor
                  const name = levelCfg?.name || r.levelName
                  return <Tag color={color} style={{ borderColor: color }}>{name}·{r.level + 1}</Tag>
                },
              },
              { title: '监测点', dataIndex: 'stationName', width: 130 },
              {
                title: '状态',
                dataIndex: 'status',
                width: 90,
                render: (s: string) => <Tag color={STATUS_COLOR[s]}>{STATUS_LABEL[s] ?? s}</Tag>,
              },
              {
                title: '触发时间',
                dataIndex: 'alertTime',
                width: 150,
                render: (t: string) => <span className="text-xs font-mono">{dayjs(t).format('MM-DD HH:mm:ss')}</span>,
              },
              {
                title: '预测峰值',
                dataIndex: 'peakLevel',
                width: 95,
                render: (v: number | null) => <span className="font-mono font-semibold">{v !== null ? `${v.toFixed(2)}m` : '—'}</span>,
              },
              {
                title: '提前量',
                dataIndex: 'lead',
                width: 85,
                render: (v: number | null) => (v !== null ? `${Math.round(v)}min` : '—'),
              },
              {
                title: '发布',
                dataIndex: 'publishHistory',
                width: 70,
                render: (h: AlertEvent['publishHistory']) => h.length,
              },
              {
                title: '操作',
                width: 260,
                render: (_, r) => (
                  <Space size="small" onClick={(e) => e.stopPropagation()}>
                    {r.status === 'active' && (
                      <Button size="small" type="primary" loading={busy} onClick={() => handleConfirm(r)}>确认</Button>
                    )}
                    {(r.status === 'active' || r.status === 'confirmed') && (
                      <PublishButton alert={r} disabled={busy} onPublish={(ch) => handlePublish(r, ch)} />
                    )}
                    {(r.status === 'active' || r.status === 'confirmed' || r.status === 'published') && (
                      <Popconfirm title={`确认解除 ${r.stationName} 的预警？`} onConfirm={() => handleResolve(r)}>
                        <Button size="small">解除</Button>
                      </Popconfirm>
                    )}
                    {r.status !== 'resolved' && r.status !== 'false_report' && (
                      <FalseReportButton alert={r} disabled={busy} onSubmit={(reason) => handleFalseReport(r, reason)} />
                    )}
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Modal
        title={selected ? `${selected.stationName} · 预警详情` : '预警详情'}
        open={!!selected}
        onCancel={() => setSelected(null)}
        footer={null}
        width={720}
      >
        {selected && <AlertDetail alert={selected} />}
      </Modal>
    </div>
  )
}

const PublishButton: React.FC<{ alert: AlertEvent; disabled?: boolean; onPublish: (channelTypes: string[]) => void }> = ({ alert, disabled, onPublish }) => {
  const { data: channels } = useChannels()
  const [open, setOpen] = useState(false)
  const enabledChannels = (channels ?? []).filter((c) => c.enabled)
  const [selectedTypes, setSelectedTypes] = useState<string[]>([])

  const openModal = () => {
    setSelectedTypes(enabledChannels.map((c) => c.type))
    setOpen(true)
  }

  return (
    <>
      <Button size="small" type="primary" ghost icon={<SendOutlined />} disabled={disabled} onClick={openModal}>发布</Button>
      <Modal
        title={`发布 ${alert.stationName} 预警`}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => { onPublish(selectedTypes); setOpen(false) }}
        okText="发布"
        okButtonProps={{ disabled: selectedTypes.length === 0 }}
        width={520}
      >
        <Form layout="vertical">
          <Form.Item label="发布渠道（按渠道类型推送，可多选）">
            {(channels ?? []).length === 0 ? (
              <span className="text-xs text-slate-400">渠道配置加载中或后端不可达</span>
            ) : (
              <Checkbox.Group value={selectedTypes} onChange={(vals) => setSelectedTypes(vals as string[])}>
                {(channels ?? []).map((c) => (
                  <Checkbox key={c.id} value={c.type} disabled={!c.enabled}>
                    <Space>
                      {c.name}
                      {!c.enabled && <Tag color="default">未启用</Tag>}
                    </Space>
                  </Checkbox>
                ))}
              </Checkbox.Group>
            )}
          </Form.Item>
          <Form.Item label="已启用渠道">
            <div className="bg-slate-50 p-3 rounded text-xs text-slate-600">
              {enabledChannels.length} 个渠道可用：{enabledChannels.map((c) => c.name).join('、') || '无（请在系统配置中启用）'}
            </div>
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

const FalseReportButton: React.FC<{ alert: AlertEvent; disabled?: boolean; onSubmit: (reason: string) => void }> = ({ alert, disabled, onSubmit }) => {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('实测值显著低于预测值')
  return (
    <>
      <Button size="small" danger disabled={disabled} onClick={() => setOpen(true)}>误报</Button>
      <Modal
        title={`标记 ${alert.stationName} 预警为误报`}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => { onSubmit(reason); setOpen(false) }}
        okText="确认误报"
        okButtonProps={{ danger: true }}
      >
        <div className="text-xs text-slate-500 mb-2">请填写误报原因（写入预警记录，供模型校准参考）：</div>
        <Input.TextArea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Modal>
    </>
  )
}

const AlertDetail: React.FC<{ alert: AlertEvent }> = ({ alert }) => {
  const { getLevelByRank } = useAlertLevels()
  const levelCfg = getLevelByRank(alert.level)
  const levelColor = levelCfg?.color || alert.levelColor
  const levelName = levelCfg?.name || alert.levelName
  const agentCard = useMemo(() => buildAlertCard(alert), [alert])

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <Tag color={levelColor} style={{ borderColor: levelColor, fontSize: 14, padding: '4px 12px' }}>
          {levelName}·等级 {alert.level + 1}
        </Tag>
        <Tag color={STATUS_COLOR[alert.status]}>{STATUS_LABEL[alert.status] ?? alert.status}</Tag>
        {alert.leadHours !== null && alert.leadHours !== undefined && (
          <span className="text-xs text-slate-500">预见期 {alert.leadHours}h</span>
        )}
        {alert.isReference && <Tag color="default">参考性</Tag>}
      </div>

      <div className="mb-4">
        <AgentCard card={agentCard} />
      </div>

      <Row gutter={12} className="mb-4">
        <Col span={8}><Statistic title="预测峰值" value={alert.peakLevel ?? '—'} suffix={alert.peakLevel !== null ? 'm' : ''} valueStyle={{ fontSize: 20 }} /></Col>
        <Col span={8}>
          <Statistic title="提前量" value={alert.lead !== null ? Math.round(alert.lead) : '—'} suffix={alert.lead !== null ? 'min' : ''} valueStyle={{ fontSize: 20 }} />
        </Col>
        <Col span={8}>
          <Statistic title="持续时长" value={alert.durationMin ?? '—'} suffix={alert.durationMin !== null ? 'min' : ''} valueStyle={{ fontSize: 20 }} />
        </Col>
      </Row>

      <div className="mb-4">
        <div className="text-sm font-medium text-slate-700 mb-2">触发原因</div>
        {alert.reasoning.length > 0 ? (
          <ul className="text-sm text-slate-600 space-y-1 pl-5 list-disc">
            {alert.reasoning.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        ) : (
          <div className="text-sm text-slate-500">{alert.reason ?? '水位超过对应等级阈值'}</div>
        )}
      </div>

      {alert.falseReportReason && (
        <AntAlert type="warning" showIcon message={`误报原因：${alert.falseReportReason}`} className="mb-4" />
      )}

      <div className="mb-4">
        <div className="text-sm font-medium text-slate-700 mb-2">发布记录时间线 ({alert.publishHistory.length})</div>
        {alert.publishHistory.length === 0 ? (
          <Empty description="尚未通过任何渠道发布" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Timeline
            items={alert.publishHistory.map((p) => ({
              color: p.status === 'delivered' ? 'green' : p.status === 'failed' ? 'red' : 'blue',
              children: (
                <div>
                  <div className="text-sm font-medium">
                    {p.channel} · {p.status === 'delivered' ? '已送达' : p.status}
                  </div>
                  <div className="text-xs text-slate-500">{dayjs(p.publishTime).format('YYYY-MM-DD HH:mm:ss')}</div>
                  <div className="text-xs text-slate-600 mt-1">{p.detail}</div>
                </div>
              ),
            }))}
          />
        )}
      </div>
    </div>
  )
}
