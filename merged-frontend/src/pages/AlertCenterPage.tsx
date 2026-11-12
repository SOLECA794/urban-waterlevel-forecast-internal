// P3: 预警管理中心 - 状态机 active→confirmed→published→resolved（真实接口版）
// 全部操作走后端接口（confirm/resolve/false-report/publish），发布历史来自后端 publish_record
// P1: 预警详情新增「智能研判助手」面板（对接 /analysis/report 系列接口）
import React, { useMemo, useState } from 'react'
import {
  App, Card, Tabs, Table, Tag, Space, Button, Modal, Steps, Timeline, Empty, Statistic,
  Row, Col, Form, Checkbox, Input, Alert as AntAlert, Spin, Popconfirm,
} from 'antd'
import {
  CheckCircleOutlined, SendOutlined, RollbackOutlined, ClockCircleOutlined, AlertOutlined, StopOutlined,
  RobotOutlined, FileTextOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
// 报告时间兼容两种格式：POST 返回 ISO 字符串，列表/详情返回 unix 秒
const fmtReportTime = (t: string | number, pattern = 'MM-DD HH:mm') =>
  typeof t === 'number' ? dayjs.unix(t).format(pattern) : dayjs(t).format(pattern)
import { AgentCard } from '@/components/agent/AgentCard'
import { PageHeader } from '@/components/common/PageHeader'
import { useAlertLevels } from '@/hooks/useAlertLevels'
import {
  useAlertStats, useAlerts, useAnalysisReports, useChannels, useConfirmAlert,
  useFalseReportAlert, useGenerateAnalysisReport, usePublishAlert, useResolveAlert,
} from '@/api/queries'
import { buildAlertCard } from '@/utils/agentCards'
import { levelKeyName } from '@/utils/alertLevels'
import type { AlertEvent, AlertStatus, AnalysisReport, RiskLevel } from '@/types'

const STATUS_LABEL: Record<string, string> = {
  active: '已触发',
  confirmed: '已确认',
  published: '已发布',
  resolved: '已解除',
  false_report: '误报',
}
// 视觉契约：resolved/false_report 为中性终态（≠成功绿）；active/confirmed/published 保持预警语义
const STATUS_COLOR: Record<string, string> = {
  active: '#EA580C',
  confirmed: '#D97706',
  published: '#2563EB',
  resolved: '#64748B',
  false_report: '#94A3B8',
}
// antd Tag color 预设名映射（中性终态用 default，不用绿色）
const STATUS_TAG_PRESET: Record<string, string> = {
  active: 'volcano',
  confirmed: 'gold',
  published: 'blue',
  resolved: 'default',
  false_report: 'default',
}

export const AlertCenterPage: React.FC = () => {
  const { message } = App.useApp()
  const [selected, setSelected] = useState<AlertEvent | null>(null)
  const [tab, setTab] = useState<string>('all')
  const { getLevelByRank, levels: alertLevels } = useAlertLevels()

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
    <div className="p-6 page-pad page-anim space-y-4" style={{ background: 'var(--bg-canvas)', minHeight: '100vh' }}>
      <PageHeader title="预警管理中心" description="预警状态流转 · 多渠道发布 · 智能研判归档" />

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
        <Col span={6} className="stat-grid-4">
          <Card size="small">
            <Statistic
              title={<span><ClockCircleOutlined /> 今日预警</span>}
              value={stats?.todayTotal ?? '—'}
              // 语义契约：0 = 无预警是中性/正常态，不用危险红；>0 才用警示色
              valueStyle={{ color: (stats?.todayTotal ?? 0) > 0 ? '#EA580C' : 'var(--text-3)', fontSize: 24 }}
            />
          </Card>
        </Col>
        <Col span={6} className="stat-grid-4">
          <Card size="small">
            <Statistic
              title={<span><AlertOutlined /> 活跃预警</span>}
              value={stats?.activeTotal ?? '—'}
              valueStyle={{ color: (stats?.activeTotal ?? 0) > 0 ? '#D97706' : 'var(--text-3)', fontSize: 24 }}
            />
          </Card>
        </Col>
        <Col span={6} className="stat-grid-4">
          <Card size="small">
            <Statistic
              title={<span><CheckCircleOutlined /> 生效预警（含历史）</span>}
              value={stats?.effectiveTotal ?? '—'}
              valueStyle={{ color: 'var(--text-1)', fontSize: 24 }}
            />
          </Card>
        </Col>
        <Col span={6} className="stat-grid-4">
          <Card size="small">
            <Statistic
              title={<span><StopOutlined /> 参考性预警</span>}
              value={stats?.referenceTotal ?? '—'}
              valueStyle={{ color: 'var(--text-3)', fontSize: 24 }}
            />
            {stats?.maxEffectiveLevel && (
              <div className="text-xs" style={{ color: 'var(--text-3)' }}>最高生效等级：{levelKeyName(stats.maxEffectiveLevel, alertLevels)}</div>
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
                render: (s: string) => <Tag color={STATUS_TAG_PRESET[s] ?? 'default'}>{STATUS_LABEL[s] ?? s}</Tag>,
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

const RISK_COLOR: Record<RiskLevel, string> = {
  低: '#16A34A',
  中: '#D97706',
  高: '#EA580C',
  极高: '#DC2626',
}

// P1 智能研判助手面板：生成 / 展示研判报告 + 历史记录
const AnalysisAssistantPanel: React.FC<{
  stationId: number
  alertId: number
  forecastId: number | null
}> = ({ stationId, alertId, forecastId }) => {
  const [report, setReport] = useState<AnalysisReport | null>(null)
  const generateM = useGenerateAnalysisReport()
  const { data: history } = useAnalysisReports(stationId, 5)

  const handleGenerate = async () => {
    try {
      const res = await generateM.mutateAsync({
        stationId,
        alertId,
        ...(forecastId !== null ? { forecastId } : {}),
      })
      setReport(res)
    } catch {
      /* 错误由下方 Alert 展示 */
    }
  }

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-slate-700">
          <RobotOutlined /> 智能研判助手
        </div>
        <Button
          size="small" type="primary" ghost
          icon={<FileTextOutlined />}
          loading={generateM.isPending}
          onClick={handleGenerate}
        >
          {report ? '重新生成' : '生成研判报告'}
        </Button>
      </div>

      {generateM.isError && (
        <AntAlert
          type="error" showIcon closable
          message="研判报告生成失败"
          description={(generateM.error as Error)?.message ?? '后端不可达或参数缺失'}
          style={{ marginBottom: 8 }}
        />
      )}

      {report ? (
        <Card size="small" className="border-blue-100 bg-blue-50/30">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <Tag color={RISK_COLOR[report.riskLevel]} style={{ borderColor: RISK_COLOR[report.riskLevel], fontSize: 13, padding: '2px 10px' }}>
              风险等级：{report.riskLevel}
            </Tag>
            <Tag color="blue">置信度 {(report.confidence * 100).toFixed(0)}%</Tag>
            <Tag>{report.provider === 'template' ? '规则模板引擎' : report.provider}</Tag>
            <span className="text-xs text-slate-400 ml-auto">
              {fmtReportTime(report.generatedAt)} 生成
            </span>
          </div>

          <div className="mb-3">
            <div className="text-xs font-medium text-slate-500 mb-1">形势研判</div>
            <div className="text-sm text-slate-700 leading-relaxed">{report.situation}</div>
          </div>

          <Row gutter={12}>
            <Col span={12}>
              <div className="text-xs font-medium text-slate-500 mb-1">处置建议</div>
              <ul className="text-sm text-slate-600 space-y-1 pl-4 list-disc">
                {report.suggestions.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </Col>
            <Col span={12}>
              <div className="text-xs font-medium text-slate-500 mb-1">关注要点</div>
              <ul className="text-sm text-slate-600 space-y-1 pl-4 list-disc">
                {report.watchPoints.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </Col>
          </Row>
        </Card>
      ) : (
        <div className="text-xs text-slate-400 bg-slate-50 rounded p-3">
          基于当前预警关联的监测数据（水位、预测、降雨、模型决策），自动生成形势研判、风险等级、处置建议与关注要点。
          报告同时归档，可供复盘追溯。
        </div>
      )}

      {history && history.list.length > 0 && (
        <div className="mt-2">
          <div className="text-xs text-slate-400 mb-1">历史研判记录（{history.total}）</div>
          <div className="space-y-1">
            {history.list.slice(0, 3).map((r) => (
              <div
                key={r.reportId}
                className="flex items-center gap-2 text-xs text-slate-500 bg-white rounded px-2 py-1 border border-slate-100 cursor-pointer hover:bg-slate-50"
                onClick={() => setReport(r)}
              >
                <Tag color={RISK_COLOR[r.riskLevel]} style={{ margin: 0, fontSize: 10 }}>{r.riskLevel}</Tag>
                <span className="font-mono">{fmtReportTime(r.generatedAt)}</span>
                <span className="truncate flex-1">{r.situation}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
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
        <Tag color={STATUS_TAG_PRESET[alert.status] ?? 'default'}>{STATUS_LABEL[alert.status] ?? alert.status}</Tag>
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

      <AnalysisAssistantPanel
        stationId={alert.stationId}
        alertId={alert.alertId}
        forecastId={alert.forecastId}
      />

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
