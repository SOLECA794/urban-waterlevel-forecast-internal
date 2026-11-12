// P6: 系统配置中心 - 真实接口版
// 等级阈值（3-5 级）/ 预见期 / 发布渠道全部走 GET+PUT 持久化到后端
import React, { useEffect, useMemo, useState } from 'react'
import {
  Alert, App, Button, Card, Col, Divider, Empty, Form, Input, InputNumber, Modal,
  Popconfirm, Radio, Row, Space, Spin, Switch, Table, Tabs, Tag,
} from 'antd'
import { SettingOutlined, EditOutlined, SaveOutlined, ReloadOutlined } from '@ant-design/icons'
import { useChannels, useLeads, useLevels, usePutChannels, usePutLeads, usePutLevels, useSystemStatus } from '@/api/queries'
import type { AlertLevel, ForecastLead, PublishChannel } from '@/api/types'
import { buildConfigCard } from '@/utils/agentCards'
import { AgentCard } from '@/components/agent/AgentCard'
import { PageHeader } from '@/components/common/PageHeader'

// 3-5 级切换时补充等级用的候选（levelKey 全局唯一）
const EXTRA_LEVEL_PRESETS: Array<Pick<AlertLevel, 'levelKey' | 'name' | 'color'>> = [
  { levelKey: 'blue', name: '蓝色预警', color: '#1890ff' },
  { levelKey: 'green', name: '绿色预警', color: '#52c41a' },
  { levelKey: 'purple', name: '紫色预警', color: '#722ed1' },
]

export const SettingsPage: React.FC = () => {
  const { message } = App.useApp()
  const [tab, setTab] = useState<string>('alert-level')

  const levelsQ = useLevels()
  const leadsQ = useLeads()
  const channelsQ = useChannels()
  const statusQ = useSystemStatus()

  const putLevels = usePutLevels()
  const putLeads = usePutLeads()
  const putChannels = usePutChannels()

  const serverLevels = useMemo(
    () => (levelsQ.data ? [...levelsQ.data].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)) : []),
    [levelsQ.data],
  )

  // ---------- 等级草稿（服务端数据同步，保存时整体 PUT） ----------
  const [draftLevels, setDraftLevels] = useState<AlertLevel[] | null>(null)
  const [editingLevel, setEditingLevel] = useState<AlertLevel | null>(null)
  const [editForm, setEditForm] = useState<Partial<AlertLevel>>({})

  useEffect(() => {
    if (serverLevels.length > 0 && draftLevels === null) {
      setDraftLevels(serverLevels.map((l) => ({ ...l })))
    }
  }, [serverLevels, draftLevels])

  const levelsDirty = useMemo(() => {
    if (!draftLevels || serverLevels.length !== draftLevels.length) return true
    return JSON.stringify(serverLevels) !== JSON.stringify(draftLevels)
  }, [draftLevels, serverLevels])

  const handleLevelCount = (count: 3 | 4 | 5) => {
    if (!draftLevels) return
    const cur = [...draftLevels]
    if (count === cur.length) return
    let next: AlertLevel[]
    if (count < cur.length) {
      // 级数减少：保留最高的 N 级（去掉最低等级）
      next = cur.slice(cur.length - count)
      next = next.map((l, i) => ({ ...l, rank: i }))
    } else {
      // 级数增加：补一个预设等级（优先补最低级蓝色，再补最高级紫色）
      const usedKeys = new Set(cur.map((l) => l.levelKey))
      const preset = EXTRA_LEVEL_PRESETS.find((p) => !usedKeys.has(p.levelKey))
      if (!preset) return
      const lowest = cur[0]
      const highest = cur[cur.length - 1]
      const isLowest = preset.levelKey === 'blue' || preset.levelKey === 'green'
      const newLevel: AlertLevel = {
        rank: 0,
        name: preset.name,
        levelKey: preset.levelKey,
        color: preset.color,
        waterLevelThreshold: isLowest
          ? Math.max(0.5, Number((lowest.waterLevelThreshold - 0.4).toFixed(2)))
          : Number((highest.waterLevelThreshold + 0.4).toFixed(2)),
        durationThreshold: highest.durationThreshold,
        description: isLowest ? '水量接近警戒，关注变化' : '超出历史极值，全域应急响应',
        enabled: true,
      }
      next = isLowest ? [newLevel, ...cur] : [...cur, newLevel]
      next = next.map((l, i) => ({ ...l, rank: i }))
    }
    setDraftLevels(next)
    message.info(`已切换为 ${count} 级草稿，点击「保存配置」后生效`)
  }

  const handleSaveLevels = async () => {
    if (!draftLevels) return
    // 前端预校验：levelKey 唯一且非空，阈值随等级递增
    const keys = draftLevels.map((l) => l.levelKey)
    if (keys.some((k) => !k)) { message.error('存在 levelKey 为空的等级'); return }
    if (new Set(keys).size !== keys.length) { message.error('levelKey 重复，请检查'); return }
    for (let i = 1; i < draftLevels.length; i++) {
      if (draftLevels[i].waterLevelThreshold <= draftLevels[i - 1].waterLevelThreshold) {
        message.error('水位阈值须随等级递增')
        return
      }
    }
    try {
      await putLevels.mutateAsync(draftLevels)
      message.success('预警等级配置已保存')
    } catch (e) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleEdit = (l: AlertLevel) => {
    setEditingLevel(l)
    setEditForm({ ...l })
  }

  const handleSaveLevel = () => {
    if (!editingLevel || !draftLevels || !editForm) return
    setDraftLevels((ls) =>
      (ls || []).map((l) => (l.levelKey === editingLevel.levelKey ? { ...l, ...editForm } as AlertLevel : l)),
    )
    setEditingLevel(null)
    message.success('等级已更新到草稿，保存配置后生效')
  }

  // ---------- 预见期开关（1h 由后端强制启用，前端禁用其开关） ----------
  const handleToggleLead = async (lead: number, enabled: boolean) => {
    if (!leadsQ.data) return
    if (lead <= 1) { message.warning('1h 为最低预见期，始终启用'); return }
    const next = leadsQ.data.map((l) => (l.lead === lead ? { ...l, enabled } : l))
    try {
      await putLeads.mutateAsync(next)
      message.success(`预见期 ${lead}h 已${enabled ? '启用' : '禁用'}`)
    } catch (e) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ---------- 渠道开关（即时 PUT 持久化） ----------
  const handleToggleChannel = async (id: number, enabled: boolean) => {
    if (!channelsQ.data) return
    const next = channelsQ.data.map((c) => (c.id === id ? { ...c, enabled } : c))
    try {
      await putChannels.mutateAsync(next)
      message.success(`渠道已${enabled ? '启用' : '禁用'}`)
    } catch (e) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const anyLoading = levelsQ.isLoading || leadsQ.isLoading || channelsQ.isLoading
  const anyError = levelsQ.isError || leadsQ.isError || channelsQ.isError

  if (anyError) {
    return (
      <div className="p-6 page-pad page-anim space-y-4" style={{ background: 'var(--bg-canvas)', minHeight: '100vh' }}>
        <PageHeader title="系统配置中心" description="预警等级规则 · 阈值颜色 · 发布渠道管理" />
        <Card>
          <Alert
            type="error"
            showIcon
            message="配置加载失败"
            description="无法从后端获取配置，请确认服务已启动后重试。"
            action={<Button icon={<ReloadOutlined />} onClick={() => { levelsQ.refetch(); leadsQ.refetch(); channelsQ.refetch() }}>重试</Button>}
          />
        </Card>
      </div>
    )
  }

  return (
    <div className="p-6 page-pad page-anim space-y-4" style={{ background: 'var(--bg-canvas)', minHeight: '100vh' }}>
      <PageHeader title="系统配置中心" description="预警等级规则 · 阈值颜色 · 发布渠道管理" />

      {anyLoading ? (
        <div className="flex justify-center py-24"><Spin size="large" tip="加载配置中…" /></div>
      ) : (
        <>
          <AgentCard card={buildConfigCard(serverLevels, leadsQ.data || [], channelsQ.data || [])} />

          <Card size="small" className="border-slate-200">
            <Tabs
              activeKey={tab}
              onChange={setTab}
              items={[
                { key: 'alert-level', label: '预警等级' },
                { key: 'forecast', label: '预见期配置' },
                { key: 'channels', label: '发布渠道' },
                { key: 'general', label: '系统' },
              ]}
            />

            {tab === 'alert-level' && draftLevels && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-slate-700">预警等级数量（3-5 级可配置）</div>
                    <div className="text-xs text-slate-500 mt-1">
                      当前生效 {serverLevels.length} 级 · 草稿 {draftLevels.length} 级
                      {levelsDirty && <Tag color="orange" className="ml-2">有未保存修改</Tag>}
                    </div>
                  </div>
                  <Space>
                    <Radio.Group
                      value={draftLevels.length as 3 | 4 | 5}
                      onChange={(e) => handleLevelCount(e.target.value as 3 | 4 | 5)}
                      optionType="button"
                      buttonStyle="solid"
                    >
                      <Radio.Button value={3}>3 级</Radio.Button>
                      <Radio.Button value={4}>4 级</Radio.Button>
                      <Radio.Button value={5}>5 级</Radio.Button>
                    </Radio.Group>
                    <Button
                      type="primary"
                      icon={<SaveOutlined />}
                      loading={putLevels.isPending}
                      disabled={!levelsDirty}
                      onClick={handleSaveLevels}
                    >
                      保存配置
                    </Button>
                    <Popconfirm
                      title="放弃未保存的修改？"
                      onConfirm={() => setDraftLevels(serverLevels.map((l) => ({ ...l })))}
                    >
                      <Button icon={<ReloadOutlined />} disabled={!levelsDirty}>重置</Button>
                    </Popconfirm>
                  </Space>
                </div>

                <Table<AlertLevel>
                  rowKey="levelKey"
                  dataSource={draftLevels}
                  size="small"
                  pagination={false}
                  columns={[
                    {
                      title: '等级',
                      width: 130,
                      render: (_: unknown, r: AlertLevel, i: number) => (
                        <Tag color={r.color} style={{ borderColor: r.color }}>{r.name} · {i + 1}</Tag>
                      ),
                    },
                    { title: 'levelKey', dataIndex: 'levelKey', width: 100, render: (k: string) => <code className="text-xs">{k}</code> },
                    {
                      title: '颜色', dataIndex: 'color', width: 130,
                      render: (c: string) => (
                        <Space>
                          <div style={{ width: 20, height: 20, background: c, borderRadius: 4, border: '1px solid #ccc' }} />
                          <code className="text-xs">{c}</code>
                        </Space>
                      ),
                    },
                    {
                      title: '水位阈值', dataIndex: 'waterLevelThreshold', width: 110,
                      render: (v: number) => <span className="font-mono">≥ {v}m</span>,
                    },
                    {
                      title: '持续时间', dataIndex: 'durationThreshold', width: 110,
                      render: (v: number) => <span className="font-mono">≥ {v}min</span>,
                    },
                    { title: '说明', dataIndex: 'description', ellipsis: true },
                    {
                      title: '操作', width: 90,
                      render: (_, r: AlertLevel) => (
                        <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)}>编辑</Button>
                      ),
                    },
                  ]}
                />

                <Divider />

                <div>
                  <div className="text-sm font-medium text-slate-700 mb-3">阈值预览（颜色标识随配置变化）</div>
                  <Row gutter={12}>
                    {draftLevels.map((l) => (
                      <Col span={Math.floor(24 / Math.max(draftLevels.length, 1))} key={l.levelKey}>
                        <Card size="small" style={{ borderTop: `3px solid ${l.color}` }}>
                          <div className="text-center">
                            <Tag color={l.color} style={{ borderColor: l.color, fontSize: 14 }}>{l.name}</Tag>
                            <div className="text-2xl font-bold mt-2" style={{ color: l.color }}>≥ {l.waterLevelThreshold}m</div>
                            <div className="text-xs text-slate-500 mt-1">持续 ≥ {l.durationThreshold}min</div>
                            <div className="text-xs text-slate-600 mt-2">{l.description}</div>
                          </div>
                        </Card>
                      </Col>
                    ))}
                  </Row>
                </div>
              </div>
            )}

            {tab === 'forecast' && <ForecastSection leads={leadsQ.data || []} onToggle={handleToggleLead} saving={putLeads.isPending} />}
            {tab === 'channels' && <ChannelsSection channels={channelsQ.data || []} onToggle={handleToggleChannel} saving={putChannels.isPending} />}
            {tab === 'general' && <GeneralSection status={statusQ.data} statusLoading={statusQ.isLoading} />}
          </Card>
        </>
      )}

      <Modal
        title={`编辑等级 · ${editingLevel?.name || ''}`}
        open={!!editingLevel}
        onCancel={() => setEditingLevel(null)}
        onOk={handleSaveLevel}
        okText="保存"
        cancelText="取消"
      >
        {editingLevel && (
          <Form layout="vertical">
            <Form.Item label="等级名称">
              <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
            </Form.Item>
            <Form.Item label="levelKey（后端必填，站点阈值按此键存储）">
              <Input value={editForm.levelKey} onChange={(e) => setEditForm({ ...editForm, levelKey: e.target.value })} />
            </Form.Item>
            <Form.Item label="颜色（HEX）">
              <Space>
                <Input
                  type="color"
                  style={{ width: 60, padding: 4 }}
                  value={editForm.color}
                  onChange={(e) => setEditForm({ ...editForm, color: e.target.value })}
                />
                <Input
                  value={editForm.color}
                  onChange={(e) => setEditForm({ ...editForm, color: e.target.value })}
                  style={{ width: 140 }}
                />
              </Space>
            </Form.Item>
            <Form.Item label="水位阈值 (m)">
              <InputNumber
                min={0} max={5} step={0.1}
                value={editForm.waterLevelThreshold}
                onChange={(v) => setEditForm({ ...editForm, waterLevelThreshold: v ?? 0 })}
              />
            </Form.Item>
            <Form.Item label="持续时间阈值 (min)">
              <InputNumber
                min={1} max={300} step={5}
                value={editForm.durationThreshold}
                onChange={(v) => setEditForm({ ...editForm, durationThreshold: v ?? 0 })}
              />
            </Form.Item>
            <Form.Item label="等级描述">
              <Input.TextArea
                rows={2}
                value={editForm.description ?? ''}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </div>
  )
}

const ForecastSection: React.FC<{
  leads: ForecastLead[]
  onToggle: (lead: number, enabled: boolean) => void
  saving: boolean
}> = ({ leads, onToggle, saving }) => {
  return (
    <div className="space-y-4">
      <div>
        <div className="text-sm font-medium text-slate-700 mb-2">预见期配置（可启用 1h / 3h / 6h / 12h）</div>
        <div className="text-xs text-slate-500 mb-3">
          1h 为最低预见期、始终启用（后端强制）；6h / 12h 为预留扩展项。切换即时保存。
        </div>
        {leads.length === 0 ? (
          <Empty description="暂无预见期配置" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Table
            rowKey="lead"
            dataSource={[...leads].sort((a, b) => a.lead - b.lead)}
            size="small"
            pagination={false}
            columns={[
              {
                title: '预见期', dataIndex: 'lead', width: 120,
                render: (l: number) => <Tag color={l === 1 || l === 3 ? 'blue' : 'default'}>{l}h</Tag>,
              },
              {
                title: '状态', dataIndex: 'enabled', width: 110,
                render: (e: boolean, r: ForecastLead) => (
                  <Switch
                    checked={e}
                    disabled={saving || r.lead <= 1}
                    onChange={(v) => onToggle(r.lead, v)}
                    checkedChildren="启用"
                    unCheckedChildren="禁用"
                  />
                ),
              },
              {
                title: '默认权重', dataIndex: 'defaultWeight', width: 110,
                render: (w: number) => <span className="font-mono">{(w * 100).toFixed(0)}%</span>,
              },
              {
                title: '备注', dataIndex: 'lead',
                render: (l: number, r: ForecastLead) => (
                  r.isReserved ? <Tag color="orange">预留接口</Tag> : l <= 1 ? <Tag color="green">必出 · 不可禁用</Tag> : <Tag color="green">必出</Tag>
                ),
              },
            ]}
          />
        )}
      </div>

      <Alert type="info" showIcon message="预见期启用状态由后端持久化，重启后保持。" />
    </div>
  )
}

const ChannelsSection: React.FC<{
  channels: PublishChannel[]
  onToggle: (id: number, enabled: boolean) => void
  saving: boolean
}> = ({ channels, onToggle, saving }) => {
  const enabledCount = channels.filter((c) => c.enabled).length

  return (
    <div className="space-y-3">
      <Alert
        message={`当前 ${enabledCount} / ${channels.length} 个渠道已启用。禁用渠道不会出现在预警发布选项中，切换即时保存。`}
        type="info"
        showIcon
      />

      <Table<PublishChannel>
        rowKey="id"
        dataSource={channels}
        size="small"
        pagination={false}
        columns={[
          {
            title: '名称', dataIndex: 'name',
            render: (n: string, r: PublishChannel) => (
              <Space><span className="font-medium">{n}</span><Tag>{r.type}</Tag></Space>
            ),
          },
          {
            title: '接入地址', dataIndex: 'endpoint',
            render: (e: string | null) => <code className="text-xs">{e || '—'}</code>,
          },
          {
            title: '状态', dataIndex: 'enabled', width: 110,
            render: (e: boolean, r: PublishChannel) => (
              <Switch
                checked={e}
                disabled={saving}
                onChange={(v) => onToggle(r.id, v)}
                checkedChildren="启用"
                unCheckedChildren="禁用"
              />
            ),
          },
        ]}
      />

      {channels[0]?.template && (
        <div>
          <div className="text-sm font-medium text-slate-700 mb-2">消息模板（站内信）</div>
          <Input.TextArea rows={2} defaultValue={channels[0].template} readOnly />
        </div>
      )}
    </div>
  )
}

const GeneralSection: React.FC<{
  status: import('@/api/types').SystemStatus | undefined
  statusLoading: boolean
}> = ({ status, statusLoading }) => {
  if (statusLoading || !status) {
    return <div className="flex justify-center py-12"><Spin /></div>
  }
  return (
    <div className="space-y-3">
      <Row gutter={12}>
        <Col span={12}>
          <Card size="small" title="运行模型">
            <div className="space-y-1 text-sm">
              <div>模型：<span className="font-mono">{status.modelName}-v{status.version}</span></div>
              <div>类型：<span className="font-mono">{status.modelType}</span></div>
              <div>激活模型 ID：<span className="font-mono">{status.activeModelId ?? '—'}</span></div>
              <div>监测点数量：<span className="font-mono">{status.stationCount}</span></div>
            </div>
          </Card>
        </Col>
        <Col span={12}>
          <Card size="small" title="预测调度">
            <div className="space-y-1 text-sm">
              <div>预测周期：<span className="font-mono">{status.forecastIntervalMinutes} min/次</span></div>
              <div>步长：<span className="font-mono">{status.stepMinutes} min</span></div>
              <div>默认预见期：<span className="font-mono">{status.leadHours}h</span></div>
              <div>服务器时间：<span className="font-mono">{status.serverTime}</span></div>
            </div>
          </Card>
        </Col>
      </Row>

      <Row gutter={12}>
        <Col span={12}>
          <Card size="small" title="运行模式">
            <Space>
              <Tag color={status.demoMode ? 'orange' : 'green'}>{status.demoMode ? '演示模式（暴雨注入生效）' : '实况模式'}</Tag>
              <Tag color={status.openMeteoEnabled ? 'blue' : 'default'}>
                {status.openMeteoEnabled ? 'Open-Meteo 气象接入：已启用' : 'Open-Meteo 气象接入：未启用'}
              </Tag>
            </Space>
          </Card>
        </Col>
        <Col span={12}>
          <Card size="small" title="时区与语言">
            <div className="space-y-1 text-sm">
              <div>时区：<span className="font-mono">Asia/Shanghai (UTC+8)</span></div>
              <div>界面语言：<span className="font-mono">zh-CN</span></div>
            </div>
          </Card>
        </Col>
      </Row>

      <Card size="small" title="审计日志">
        <Empty description="审计日志由后端服务日志承载（配置变更均有 [httpapi] 日志输出）" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </Card>
    </div>
  )
}
