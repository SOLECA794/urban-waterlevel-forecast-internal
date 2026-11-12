// P5: 模型校准中心 - 评估→定位→调整→验证→生效闭环（真实接口版）
// 参数校准走 POST /calibrate-params（linear_response），模型激活走 POST /models/{id}/activate，
// 重训任务走 POST /calibrations（type=retrain），历史记录来自 GET /calibrations
import React, { useMemo, useState } from 'react'
import {
  App, Card, Tabs, Table, Tag, Space, Button, Modal, Steps, Row, Col, Statistic, Alert as AntAlert,
  Drawer, Spin, Empty, Select, InputNumber, Form, Popconfirm,
} from 'antd'
import {
  ExperimentOutlined, PlayCircleOutlined, CheckCircleOutlined, EyeOutlined, SyncOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { AgentCard } from '@/components/agent/AgentCard'
import { useActivateModel, useCalibrateParams, useCalibrations, useCreateRetrain, useModels, useStations, useSystemStatus } from '@/api/queries'
import { buildCalibrationCard } from '@/utils/agentCards'
import type { CalibrateResult, Calibration, ModelItem } from '@/types'

const TYPE_LABEL: Record<string, string> = {
  param: '参数校准',
  parameter: '参数校准',
  rule: '规则调整',
  retrain: '模型重训',
  rollback: '回滚',
}
const TYPE_COLOR: Record<string, string> = {
  param: 'blue',
  parameter: 'blue',
  rule: 'purple',
  retrain: 'cyan',
  rollback: 'orange',
}
const STATUS_LABEL: Record<string, string> = {
  preview: '预览中',
  applied: '已生效',
  pending: '执行中',
  rolled_back: '已回滚',
}
const STATUS_COLOR: Record<string, string> = {
  preview: 'orange',
  applied: 'green',
  pending: 'blue',
  rolled_back: 'default',
}

export const CalibrationPage: React.FC = () => {
  const { message } = App.useApp()
  const [tab, setTab] = useState<string>('all')
  const [selected, setSelected] = useState<Calibration | null>(null)
  const [calibrateOpen, setCalibrateOpen] = useState(false)
  const [result, setResult] = useState<CalibrateResult | null>(null)

  const { data: models, isLoading: loadingModels, isError: modelsError, error: modelsErr } = useModels()
  const { data: status } = useSystemStatus()
  const { data: stations } = useStations()
  const { data: calibPage, isLoading: loadingCalib, refetch: refetchCalib } = useCalibrations(1, 50)

  const activateM = useActivateModel()
  const calibrateM = useCalibrateParams()
  const retrainM = useCreateRetrain()

  const records = calibPage?.items ?? []
  const filterRecords = tab === 'all' ? records : records.filter((r) => r.status === tab)
  const modelList = models ?? []
  const activeModel = modelList.find((m) => m.active)
  // 参数校准仅支持 linear_response 模型（后端约束）
  const calibratableModels = modelList.filter((m) => m.modelType === 'linear_response')

  const agentCard = useMemo(
    () => buildCalibrationCard(modelList, status, calibPage?.total ?? records.length),
    [modelList, status, calibPage, records.length],
  )

  const handleActivate = async (m: ModelItem) => {
    try {
      await activateM.mutateAsync(m.modelId)
      message.success(`模型已切换：${m.modelName}（v${m.version}）`)
    } catch (e: any) { message.error(`激活失败：${e?.message ?? '未知错误'}`) }
  }

  const handleRetrain = async () => {
    try {
      await retrainM.mutateAsync({})
      message.success('重训任务已创建（异步执行，完成后出现在校准记录中）')
    } catch (e: any) { message.error(`创建失败：${e?.message ?? '未知错误'}`) }
  }

  const handleCalibrate = async (values: { modelId: number; stationId: number; hours: number }) => {
    try {
      const res = await calibrateM.mutateAsync(values)
      setResult(res)
      message.success(
        `校准完成：RMSE ${res.rmseBefore.toFixed(3)} → ${res.rmseAfter.toFixed(3)}（改善 ${res.improvedPct.toFixed(1)}%）`,
      )
    } catch (e: any) {
      message.error(`校准失败：${e?.message ?? '未知错误'}`)
    }
  }

  return (
    <div className="p-6 space-y-4 bg-slate-50 min-h-screen">
      <h2 className="text-xl font-semibold text-slate-800">模型校准中心</h2>

      <Card size="small" className="border-slate-200">
        <Steps
          current={-1}
          items={[
            { title: '评估', description: '指标监控' },
            { title: '定位', description: '问题溯源' },
            { title: '调整', description: '参数校准' },
            { title: '验证', description: '前后对比' },
            { title: '生效', description: '激活模型' },
          ]}
        />
      </Card>

      <Row gutter={12}>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="当前模型版本" value={activeModel ? `${activeModel.modelName} v${activeModel.version}` : '—'}
              prefix={<ExperimentOutlined />} valueStyle={{ fontSize: 16 }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="生效模型 MAE" value={activeModel?.mae ?? '—'} precision={activeModel?.mae !== null && activeModel?.mae !== undefined ? 3 : undefined}
              suffix={activeModel?.mae != null ? 'm' : ''} valueStyle={{ color: '#2563EB' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="生效模型 RMSE" value={activeModel?.rmse ?? '—'} precision={activeModel?.rmse !== null && activeModel?.rmse !== undefined ? 3 : undefined}
              suffix={activeModel?.rmse != null ? 'm' : ''} valueStyle={{ color: '#52C41A' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="校准记录" value={calibPage?.total ?? '—'} valueStyle={{ color: '#7c3aed' }} />
          </Card>
        </Col>
      </Row>

      <AgentCard card={agentCard} />

      {/* 模型列表 */}
      <Card size="small" title="模型仓库（激活后对未来预测生效）" className="border-slate-200">
        {modelsError ? (
          <AntAlert type="error" showIcon message="模型列表加载失败" description={(modelsErr as Error)?.message ?? '后端不可达'} />
        ) : loadingModels ? (
          <div className="flex justify-center py-8"><Spin /></div>
        ) : (
          <Table<ModelItem>
            rowKey="modelId"
            dataSource={modelList}
            size="small"
            pagination={false}
            columns={[
              {
                title: '模型', dataIndex: 'modelName',
                render: (_, r) => (
                  <Space>
                    <span className="font-medium">{r.modelName}</span>
                    <Tag>{r.modelType}</Tag>
                    {r.active && <Tag color="green">生效中</Tag>}
                  </Space>
                ),
              },
              { title: '版本', dataIndex: 'version', width: 100, render: (v: string) => <code className="text-xs">v{v}</code> },
              {
                title: 'MAE', dataIndex: 'mae', width: 100,
                render: (v: number | null) => (v !== null && v !== undefined ? `${v.toFixed(3)}m` : '—'),
              },
              {
                title: 'RMSE', dataIndex: 'rmse', width: 100,
                render: (v: number | null) => (v !== null && v !== undefined ? `${v.toFixed(3)}m` : '—'),
              },
              {
                title: '支持参数校准', dataIndex: 'modelType', width: 120,
                render: (t: string) => (t === 'linear_response' ? <Tag color="blue">支持</Tag> : <Tag color="default">不支持</Tag>),
              },
              {
                title: '操作', width: 130,
                render: (_, r) => (
                  <Popconfirm
                    title={`确认激活 ${r.modelName}？激活后立即对未来预测生效。`}
                    disabled={!r.activatable}
                    onConfirm={() => handleActivate(r)}
                  >
                    <Button size="small" type="primary" ghost disabled={!r.activatable} icon={<CheckCircleOutlined />}>
                      {r.active ? '生效中' : '激活'}
                    </Button>
                  </Popconfirm>
                ),
              },
            ]}
          />
        )}
      </Card>

      {/* 校准记录 */}
      <Card size="small" className="border-slate-200">
        <div className="flex items-center justify-between mb-3">
          <Tabs
            activeKey={tab}
            onChange={setTab}
            items={[
              { key: 'all', label: `全部 (${records.length})` },
              { key: 'applied', label: `已生效 (${records.filter((r) => r.status === 'applied').length})` },
              { key: 'pending', label: `执行中 (${records.filter((r) => r.status === 'pending').length})` },
            ]}
          />
          <Space>
            <Button icon={<SyncOutlined />} onClick={() => refetchCalib()}>刷新记录</Button>
            <Popconfirm title="创建模型重训任务？（异步执行）" onConfirm={handleRetrain}>
              <Button icon={<PlayCircleOutlined />} loading={retrainM.isPending}>发起重训</Button>
            </Popconfirm>
            <Button
              type="primary" icon={<PlayCircleOutlined />}
              onClick={() => { setResult(null); setCalibrateOpen(true) }}
              disabled={calibratableModels.length === 0 || (stations ?? []).length === 0}
            >
              参数校准
            </Button>
          </Space>
        </div>

        {loadingCalib ? (
          <div className="flex justify-center py-8"><Spin /></div>
        ) : filterRecords.length === 0 ? (
          <Empty description="暂无校准记录（可通过参数校准或重训生成）" />
        ) : (
          <Table<Calibration>
            rowKey="id"
            dataSource={filterRecords}
            size="small"
            pagination={{ pageSize: 10, showSizeChanger: false }}
            onRow={(r) => ({ onClick: () => setSelected(r) })}
            rowClassName="cursor-pointer hover:bg-slate-50"
            columns={[
              {
                title: '类型', dataIndex: 'type', width: 110,
                render: (t: string) => <Tag color={TYPE_COLOR[t] ?? 'default'}>{TYPE_LABEL[t] ?? t}</Tag>,
              },
              {
                title: '对象', dataIndex: 'target', width: 220,
                render: (v: string | null) => <code className="text-xs">{v ?? '—'}</code>,
              },
              {
                title: '变更概要', width: 280,
                render: (_, r) => (
                  <div className="text-xs">
                    <div className="text-slate-500">before: {JSON.stringify(r.before)}</div>
                    <div className="text-blue-700">after: {JSON.stringify(r.after)}</div>
                  </div>
                ),
              },
              {
                title: '状态', dataIndex: 'status', width: 90,
                render: (s: string) => <Tag color={STATUS_COLOR[s] ?? 'default'}>{STATUS_LABEL[s] ?? s}</Tag>,
              },
              {
                title: '执行时间', dataIndex: 'createdAt', width: 150,
                render: (v: string) => <span className="text-xs font-mono">{dayjs(v).format('MM-DD HH:mm:ss')}</span>,
              },
              {
                title: '执行人', dataIndex: 'executedBy', width: 90,
                render: (v: string | null) => v ?? '—',
              },
              {
                title: '操作', width: 90,
                render: (_, r) => (
                  <Button size="small" icon={<EyeOutlined />} onClick={(e) => { e.stopPropagation(); setSelected(r) }}>详情</Button>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Drawer
        title={selected ? `校准详情 · ${selected.target ?? selected.type}` : '校准详情'}
        placement="right"
        width={560}
        open={!!selected}
        onClose={() => setSelected(null)}
      >
        {selected && <CalibrationDetail record={selected} />}
      </Drawer>

      <CalibrateModal
        open={calibrateOpen}
        onCancel={() => setCalibrateOpen(false)}
        onSubmit={handleCalibrate}
        loading={calibrateM.isPending}
        models={calibratableModels}
        stations={stations ?? []}
        result={result}
      />
    </div>
  )
}

const CalibrateModal: React.FC<{
  open: boolean
  onCancel: () => void
  onSubmit: (v: { modelId: number; stationId: number; hours: number }) => void
  loading: boolean
  models: ModelItem[]
  stations: { stationId: number; stationName: string; stationCode: string }[]
  result: CalibrateResult | null
}> = ({ open, onCancel, onSubmit, loading, models, stations, result }) => {
  const [form] = Form.useForm()
  return (
    <Modal
      title="参数校准（linear_response 模型）"
      open={open}
      onCancel={onCancel}
      footer={null}
      width={680}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ modelId: models[0]?.modelId, stationId: stations[0]?.stationId, hours: 48 }}
        onFinish={onSubmit}
      >
        <div className="grid grid-cols-3 gap-3">
          <Form.Item name="modelId" label="模型" rules={[{ required: true }]}>
            <Select
              options={models.map((m) => ({ value: m.modelId, label: `${m.modelName} (${m.modelType})` }))}
              disabled={loading}
            />
          </Form.Item>
          <Form.Item name="stationId" label="监测点" rules={[{ required: true }]}>
            <Select
              showSearch optionFilterProp="label"
              options={stations.map((s) => ({ value: s.stationId, label: `${s.stationName} (${s.stationCode})` }))}
              disabled={loading}
            />
          </Form.Item>
          <Form.Item name="hours" label="回溯时长（小时，1-720）" rules={[{ required: true }]}>
            <InputNumber min={1} max={720} style={{ width: '100%' }} disabled={loading} />
          </Form.Item>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>关闭</Button>
          <Button type="primary" htmlType="submit" loading={loading}>执行校准</Button>
        </div>
      </Form>

      {result && (
        <div className="pt-4 mt-4 border-t border-slate-200">
          <div className="text-sm font-medium text-slate-700 mb-2">校准结果（前后对比）</div>
          <Row gutter={12}>
            <Col span={8}>
              <Statistic
                title="RMSE" value={result.rmseAfter} precision={4} valueStyle={{ fontSize: 16 }}
                suffix="m"
              />
              <div className="text-xs text-slate-400">前值 {result.rmseBefore.toFixed(4)}</div>
            </Col>
            <Col span={8}>
              <Statistic
                title="MAE" value={result.maeAfter} precision={4} valueStyle={{ fontSize: 16 }}
                suffix="m"
              />
              <div className="text-xs text-slate-400">前值 {result.maeBefore.toFixed(4)}</div>
            </Col>
            <Col span={8}>
              <Statistic
                title="改善幅度" value={result.improvedPct} precision={1} suffix="%"
                valueStyle={{ fontSize: 16, color: result.improvedPct > 0 ? '#52C41A' : '#EA580C' }}
              />
              <div className="text-xs text-slate-400">方法：{result.method}</div>
            </Col>
          </Row>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <div className="bg-red-50 border border-red-200 p-3 rounded">
              <div className="text-xs text-red-600 mb-1 font-medium">参数（校准前）</div>
              <pre className="text-xs overflow-x-auto">{JSON.stringify(result.paramsBefore, null, 2)}</pre>
            </div>
            <div className="bg-green-50 border border-green-200 p-3 rounded">
              <div className="text-xs text-green-600 mb-1 font-medium">参数（校准后，已写入模型）</div>
              <pre className="text-xs overflow-x-auto">{JSON.stringify(result.paramsAfter, null, 2)}</pre>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

const CalibrationDetail: React.FC<{ record: Calibration }> = ({ record }) => {
  return (
    <div className="space-y-4">
      <Space wrap>
        <Tag color={TYPE_COLOR[record.type] ?? 'default'}>{TYPE_LABEL[record.type] ?? record.type}</Tag>
        <Tag color={STATUS_COLOR[record.status] ?? 'default'}>{STATUS_LABEL[record.status] ?? record.status}</Tag>
        <span className="text-xs text-slate-500">执行人：{record.executedBy ?? '—'}</span>
        <span className="text-xs text-slate-500">{dayjs(record.createdAt).format('YYYY-MM-DD HH:mm:ss')}</span>
      </Space>

      {record.note && <AntAlert message={record.note} type="info" showIcon />}

      <div>
        <div className="text-sm font-medium text-slate-700 mb-2">变更对比</div>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-red-50 border border-red-200 p-3 rounded">
            <div className="text-xs text-red-600 mb-1 font-medium">变更前 (Before)</div>
            <pre className="text-xs overflow-x-auto">{JSON.stringify(record.before, null, 2)}</pre>
          </div>
          <div className="bg-green-50 border border-green-200 p-3 rounded">
            <div className="text-xs text-green-600 mb-1 font-medium">变更后 (After)</div>
            <pre className="text-xs overflow-x-auto">{JSON.stringify(record.after, null, 2)}</pre>
          </div>
        </div>
      </div>

      {record.preview !== null && record.preview !== undefined && (
        <div>
          <div className="text-sm font-medium text-slate-700 mb-2">预览信息</div>
          <pre className="bg-slate-100 p-3 rounded text-xs overflow-x-auto">{JSON.stringify(record.preview, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}
