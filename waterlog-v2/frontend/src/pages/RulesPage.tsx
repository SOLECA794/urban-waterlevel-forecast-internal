// 规则引擎：规则链 + 节点（阈值 + 持续时长 → 告警等级）
import React, { useEffect, useState } from 'react'
import {
  App, Button, Card, Col, Empty, Form, Input, InputNumber, Modal, Popconfirm,
  Row, Select, Space, Switch, Table, Tag, Tooltip,
} from 'antd'
import { PlusOutlined, ApartmentOutlined, DeleteOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { PageHeader } from '@/components/common/PageHeader'
import { ErrorState } from '@/components/common/ErrorState'
import {
  useChains, useCreateChain, useCreateNode, useDeleteChain, useDeleteNode,
  useUpdateChain, useUpdateNode, useProfiles,
} from '@/api/queries'
import { LEVEL_META } from '@/utils/levels'
import type { LevelKey, RuleChain, RuleNode } from '@/api/types'

const OP_LABEL: Record<string, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤' }

export const RulesPage: React.FC = () => {
  const { message } = App.useApp()
  const { data: chains = [], isLoading, isError, refetch } = useChains()
  const { data: profiles = [] } = useProfiles()
  const [selectedChainId, setSelectedChainId] = useState<number | null>(null)
  const chain = chains.find((c) => c.id === (selectedChainId ?? chains[0]?.id)) ?? chains[0]

  const updateChain = useUpdateChain()
  const deleteChain = useDeleteChain()
  const createChain = useCreateChain()
  const createNode = useCreateNode()
  const updateNode = useUpdateNode()
  const deleteNode = useDeleteNode()

  const [chainModal, setChainModal] = useState(false)
  const [nodeModal, setNodeModal] = useState(false)
  const [editingNode, setEditingNode] = useState<RuleNode | null>(null)
  const [chainForm] = Form.useForm()
  const [nodeForm] = Form.useForm()

  useEffect(() => {
    if (!selectedChainId && chains.length) setSelectedChainId(chains[0].id)
  }, [chains, selectedChainId])

  const openNode = (n?: RuleNode) => {
    setEditingNode(n ?? null)
    nodeForm.resetFields()
    if (n) {
      nodeForm.setFieldsValue({ ...n, actions: (n.actions ?? []).join(',') })
    } else {
      nodeForm.setFieldsValue({ metric: 'water_level', op: 'gte', durationSec: 0, levelKey: 'blue', priority: 100, enabled: true })
    }
    setNodeModal(true)
  }

  const submitNode = async () => {
    const v = await nodeForm.validateFields()
    const meta = LEVEL_META[v.levelKey as LevelKey]
    const payload = {
      ...v,
      levelRank: meta.rank,
      severity: meta.rank >= 4 ? 'critical' : meta.rank === 3 ? 'major' : meta.rank === 2 ? 'warning' : 'info',
      actions: String(v.actions ?? '').split(',').map((s: string) => s.trim()).filter(Boolean),
    }
    try {
      if (editingNode) {
        await updateNode.mutateAsync({ nodeId: editingNode.id, data: payload })
        message.success('规则已更新（立即生效）')
      } else if (chain) {
        await createNode.mutateAsync({ chainId: chain.id, data: payload })
        message.success('规则已创建（立即生效）')
      }
      setNodeModal(false)
    } catch (e) { message.error((e as Error).message) }
  }

  const nodeColumns = [
    {
      title: '规则', dataIndex: 'name', key: 'name', width: 260,
      render: (name: string, n: RuleNode) => (
        <div>
          <div style={{ color: 'var(--text-1)', fontWeight: 500 }}>{name}</div>
          <div className="text-xs" style={{ color: 'var(--text-3)' }}>
            优先级 {n.priority} · 创建 {dayjs.unix(n.createdAt).format('MM-DD')}
          </div>
        </div>
      ),
    },
    {
      title: '条件', key: 'cond', width: 240,
      render: (_: unknown, n: RuleNode) => (
        <span className="num text-xs" style={{ color: 'var(--text-2)' }}>
          {n.metric} {OP_LABEL[n.op]} {n.threshold}
          {n.durationSec > 0 ? ` 持续 ≥ ${n.durationSec}s` : ''}
          {n.deviceProfileId ? '（限定画像）' : '（全画像）'}
        </span>
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
      title: '动作', dataIndex: 'actions', key: 'actions', width: 150,
      render: (a: string[]) => (a ?? []).map((x) => <Tag key={x}>{x}</Tag>),
    },
    {
      title: '启用', dataIndex: 'enabled', key: 'enabled', width: 80,
      render: (v: boolean, n: RuleNode) => (
        <Switch
          size="small"
          checked={v}
          onChange={async (checked) => {
            await updateNode.mutateAsync({ nodeId: n.id, data: { ...n, enabled: checked } })
            message.success(checked ? '规则已启用' : '规则已停用')
          }}
        />
      ),
    },
    {
      title: '操作', key: 'op', width: 130,
      render: (_: unknown, n: RuleNode) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => openNode(n)}>编辑</Button>
          <Popconfirm title="删除该规则？" okText="删除" cancelText="取消" okButtonProps={{ danger: true }}
            onConfirm={async () => {
              try {
                await deleteNode.mutateAsync(n.id)
                message.success('已删除')
              } catch (e) { message.error((e as Error).message) }
            }}>
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div className="p-6 page-pad page-anim space-y-4" style={{ background: 'var(--bg-canvas)', minHeight: '100vh' }}>
      <PageHeader
        title="规则引擎"
        description="条件 → 持续时长 → 告警等级（简化 Rule Chain，可视化编排见 EXT-POINT）"
        extra={
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => {
            chainForm.resetFields()
            chainForm.setFieldsValue({ enabled: true })
            setChainModal(true)
          }}>
            新建规则链
          </Button>
        }
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={7}>
          <Card size="small" title="规则链" styles={{ body: { padding: 10 } }} loading={isLoading && !isError}>
            {isError ? <ErrorState onRetry={() => refetch()} /> : chains.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无规则链" /> : (
              <div className="space-y-2">
                {chains.map((c: RuleChain) => {
                  const active = c.id === chain?.id
                  return (
                    <div
                      key={c.id}
                      onClick={() => setSelectedChainId(c.id)}
                      className="rounded-lg px-3 py-2 cursor-pointer"
                      style={{
                        background: active ? 'var(--primary-weak)' : 'var(--bg-subtle)',
                        border: `1px solid ${active ? 'var(--primary)' : 'transparent'}`,
                        borderRadius: 'var(--radius-card)',
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium flex items-center gap-1.5 min-w-0 truncate" style={{ color: 'var(--text-1)' }}>
                          <ApartmentOutlined style={{ color: active ? 'var(--primary)' : 'var(--text-3)' }} />
                          {c.name}
                        </span>
                        <span className="flex items-center gap-1 shrink-0">
                          <Switch
                            size="small"
                            checked={c.enabled}
                            onClick={(_, e) => e.stopPropagation()}
                            onChange={async (checked) => {
                              await updateChain.mutateAsync({ id: c.id, data: { ...c, enabled: checked } })
                              message.success(checked ? '规则链已启用' : '规则链已停用')
                            }}
                          />
                          <Popconfirm title="删除规则链？" description="链内规则将一并删除" okText="删除" cancelText="取消"
                            okButtonProps={{ danger: true }}
                            onConfirm={async () => {
                              try {
                                await deleteChain.mutateAsync(c.id)
                                setSelectedChainId(null)
                                message.success('已删除')
                              } catch (e) { message.error((e as Error).message) }
                            }}>
                            <Button
                              type="text"
                              size="small"
                              danger
                              icon={<DeleteOutlined />}
                              aria-label="删除规则链"
                              onClick={(e) => e.stopPropagation()}
                            />
                          </Popconfirm>
                        </span>
                      </div>
                      <div className="text-xs mt-1 truncate" style={{ color: 'var(--text-3)' }}>
                        {(c.nodes ?? []).length} 条规则 · {c.description || '无描述'}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={17}>
          <Card
            size="small"
            title={chain ? `${chain.name} · 规则节点` : '规则节点'}
            extra={<Button size="small" icon={<PlusOutlined />} disabled={!chain} onClick={() => openNode()}>新增规则</Button>}
          >
            <Table
              rowKey="id"
              size="small"
              loading={isLoading}
              columns={nodeColumns as never}
              dataSource={chain?.nodes ?? []}
              pagination={false}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该链下暂无规则" /> }}
            />
            <div className="text-xs mt-3" style={{ color: 'var(--text-3)' }}>
              规则求值顺序按优先级升序；条件持续满足达到 durationSec 后触发告警，条件恢复时自动解除（CLEARED_*）。
            </div>
          </Card>
        </Col>
      </Row>

      {/* 新建规则链 */}
      <Modal title="新建规则链" open={chainModal} onCancel={() => setChainModal(false)} okText="创建" cancelText="取消"
        confirmLoading={createChain.isPending}
        onOk={async () => {
          const v = await chainForm.validateFields()
          try {
            const c = await createChain.mutateAsync(v)
            setSelectedChainId(c.id)
            setChainModal(false)
            message.success('规则链已创建')
          } catch (e) { message.error((e as Error).message) }
        }}>
        <Form form={chainForm} layout="vertical" className="pt-2">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：内涝分级预警" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} placeholder="说明该链的用途" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      {/* 新建/编辑规则节点 */}
      <Modal title={editingNode ? '编辑规则' : '新增规则'} open={nodeModal} onCancel={() => setNodeModal(false)}
        okText="保存" cancelText="取消" confirmLoading={createNode.isPending || updateNode.isPending}
        onOk={submitNode} destroyOnClose>
        <Form form={nodeForm} layout="vertical" className="pt-2">
          <Form.Item name="name" label="规则名称" rules={[{ required: true, message: '请输入规则名称' }]}>
            <Input placeholder="如：橙色预警（影响通行）" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="metric" label="指标" rules={[{ required: true }]}>
                <Select options={[
                  { value: 'water_level', label: '水位 (m)' },
                  { value: 'rainfall', label: '降雨 (mm)' },
                  { value: 'flow', label: '流量 (m³/s)' },
                ]} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="op" label="比较符" rules={[{ required: true }]}>
                <Select options={Object.entries(OP_LABEL).map(([v, l]) => ({ value: v, label: l }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="threshold" label="阈值" rules={[{ required: true, message: '请输入阈值' }]}>
                <InputNumber style={{ width: '100%' }} step={0.1} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="durationSec" label="持续时长（秒）" tooltip="条件持续满足该时长才触发；0 表示立即触发">
                <InputNumber min={0} max={3600} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="levelKey" label="告警等级" rules={[{ required: true }]}>
                <Select options={Object.entries(LEVEL_META).map(([v, m]) => ({ value: v, label: m.label }))} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="priority" label="优先级" tooltip="数值越小越先求值">
                <InputNumber min={1} max={999} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="deviceProfileId" label="限定画像" tooltip="留空表示对所有画像生效">
                <Select
                  allowClear placeholder="全部画像"
                  options={profiles.map((p) => ({ value: p.id, label: p.name }))}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="actions" label="动作（逗号分隔）" tooltip="本期支持 sse / log；webhook 见 EXT-POINT(INTEGRATION)">
            <Input placeholder="sse,log" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
