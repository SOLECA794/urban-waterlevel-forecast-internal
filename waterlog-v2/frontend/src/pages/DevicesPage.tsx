// 设备管理：设备列表 + 画像管理（对标 ThingsBoard Devices / Device Profiles）
import React, { useMemo, useState } from 'react'
import {
  App, Badge, Button, Card, Col, Form, Input, InputNumber, Modal, Popconfirm,
  Row, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Empty,
} from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { PageHeader } from '@/components/common/PageHeader'
import {
  useCreateDevice, useDeleteDevice, useDevices, useProfiles, useUpdateDevice,
} from '@/api/queries'
import type { Device, DeviceProfile, DeviceStatus } from '@/api/types'

const STATUS_VIEW: Record<DeviceStatus, { text: string; color: string }> = {
  online: { text: '在线', color: 'var(--success)' },
  stale: { text: '滞后', color: 'var(--warning)' },
  offline: { text: '离线', color: 'var(--text-3)' },
}

export const DevicesPage: React.FC = () => {
  const { message } = App.useApp()
  const { data: devices = [], isLoading, refetch } = useDevices()
  const { data: profiles = [] } = useProfiles()
  const createDevice = useCreateDevice()
  const updateDevice = useUpdateDevice()
  const deleteDevice = useDeleteDevice()

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Device | null>(null)
  const [form] = Form.useForm()

  const online = devices.filter((d) => d.status === 'online').length
  const stale = devices.filter((d) => d.status === 'stale').length
  const disabled = devices.filter((d) => !d.enabled).length

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ profileId: profiles[0]?.id, enabled: true, lat: 30.27, lon: 120.15 })
    setModalOpen(true)
  }

  const openEdit = (d: Device) => {
    setEditing(d)
    form.setFieldsValue(d)
    setModalOpen(true)
  }

  const submit = async () => {
    const values = await form.validateFields()
    try {
      if (editing) {
        await updateDevice.mutateAsync({ id: editing.id, data: values })
        message.success('设备已更新')
      } else {
        await createDevice.mutateAsync(values)
        message.success('设备已创建')
      }
      setModalOpen(false)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const columns = [
    {
      title: '设备', dataIndex: 'name', key: 'name',
      render: (name: string, d: Device) => (
        <div>
          <div style={{ color: 'var(--text-1)', fontWeight: 500 }}>{name}</div>
          <div className="text-xs num" style={{ color: 'var(--text-3)' }}>{d.code}</div>
        </div>
      ),
    },
    { title: '画像', dataIndex: 'profileName', key: 'profileName', width: 160 },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 100,
      render: (s: DeviceStatus, d: Device) => (
        <Tooltip title={d.lastSeenAt ? `最后上报 ${dayjs.unix(d.lastSeenAt).format('MM-DD HH:mm:ss')}` : '尚未上报'}>
          <span className="flex items-center gap-1.5 text-xs">
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_VIEW[s].color, display: 'inline-block' }} />
            {STATUS_VIEW[s].text}
          </span>
        </Tooltip>
      ),
    },
    {
      title: '位置', key: 'loc', width: 220,
      render: (_: unknown, d: Device) => (
        <span className="text-xs" style={{ color: 'var(--text-2)' }}>
          {d.address} <span className="num" style={{ color: 'var(--text-3)' }}>({d.lat.toFixed(3)}, {d.lon.toFixed(3)})</span>
        </span>
      ),
    },
    {
      title: '启用', dataIndex: 'enabled', key: 'enabled', width: 80,
      render: (v: boolean, d: Device) => (
        <Switch
          size="small"
          checked={v}
          onChange={async (checked) => {
            await updateDevice.mutateAsync({ id: d.id, data: { ...d, enabled: checked } })
            message.success(checked ? '已启用' : '已停用')
          }}
        />
      ),
    },
    {
      title: '操作', key: 'op', width: 140,
      render: (_: unknown, d: Device) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => openEdit(d)}>编辑</Button>
          <Popconfirm
            title="删除设备？"
            description="其历史遥测与告警将一并删除，不可恢复"
            okText="删除" cancelText="取消" okButtonProps={{ danger: true }}
            onConfirm={async () => {
              try {
                await deleteDevice.mutateAsync(d.id)
                message.success('已删除')
              } catch (e) { message.error((e as Error).message) }
            }}
          >
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div className="p-6 page-pad page-anim space-y-4" style={{ background: 'var(--bg-canvas)', minHeight: '100vh' }}>
      <PageHeader
        title="设备管理"
        description="设备台账 · 设备画像 · 在线状态"
        extra={
          <Space wrap>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => refetch()}>刷新</Button>
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增设备</Button>
          </Space>
        }
      />

      <Row gutter={12}>
        {[
          { label: '设备总数', value: devices.length, tone: 'var(--text-1)' },
          { label: '在线', value: online, tone: 'var(--success)' },
          { label: '数据滞后', value: stale, tone: 'var(--warning)' },
          { label: '已停用', value: disabled, tone: 'var(--text-3)' },
        ].map((s) => (
          <Col xs={12} md={6} key={s.label}>
            <Card size="small">
              <div className="text-xs" style={{ color: 'var(--text-3)' }}>{s.label}</div>
              <div className="num font-bold mt-1" style={{ fontSize: 24, color: s.value ? s.tone : 'var(--text-3)' }}>
                {s.value}
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      <Tabs
        items={[
          {
            key: 'devices',
            label: `设备（${devices.length}）`,
            children: (
              <Card size="small">
                <Table
                  rowKey="id"
                  size="small"
                  loading={isLoading}
                  columns={columns as never}
                  dataSource={devices}
                  pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 台` }}
                />
              </Card>
            ),
          },
          {
            key: 'profiles',
            label: `设备画像（${profiles.length}）`,
            children: <ProfilePanel profiles={profiles} />,
          },
        ]}
      />

      <Modal
        title={editing ? '编辑设备' : '新增设备'}
        open={modalOpen}
        onOk={submit}
        onCancel={() => setModalOpen(false)}
        okText="保存" cancelText="取消"
        confirmLoading={createDevice.isPending || updateDevice.isPending}
        destroyOnClose
      >
        <Form form={form} layout="vertical" className="pt-2">
          <Form.Item name="name" label="设备名称" rules={[{ required: true, message: '请输入设备名称' }]}>
            <Input placeholder="如：文一路隧道" />
          </Form.Item>
          <Form.Item name="code" label="设备编码" rules={[{ required: true, message: '请输入设备编码' }]}
            extra="遥测上报通过编码识别设备，如 WL001">
            <Input placeholder="WL001" disabled={!!editing} />
          </Form.Item>
          <Form.Item name="profileId" label="设备画像" rules={[{ required: true, message: '请选择画像' }]}>
            <Select options={profiles.map((p) => ({
              value: p.id,
              label: `${p.name}（${p.telemetryKeys.join(' / ')}）`,
            }))} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="lat" label="纬度" rules={[{ required: true, message: '请输入纬度' }]}>
                <InputNumber min={-90} max={90} step={0.0001} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="lon" label="经度" rules={[{ required: true, message: '请输入经度' }]}>
                <InputNumber min={-180} max={180} step={0.0001} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="address" label="地址">
            <Input placeholder="如：西湖区文一路" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

// 画像只读视图（新增/编辑画像走接口，本期 UI 提供只读 + 遥测键说明）
const ProfilePanel: React.FC<{ profiles: DeviceProfile[] }> = ({ profiles }) => {
  if (profiles.length === 0) return <Empty description="暂无画像" />
  return (
    <Row gutter={[12, 12]}>
      {profiles.map((p) => (
        <Col xs={24} md={8} key={p.id}>
          <Card size="small" title={p.name} extra={<Tag>{p.category}</Tag>}>
            <div className="text-xs space-y-1.5" style={{ color: 'var(--text-2)' }}>
              <div>遥测键：{p.telemetryKeys.map((k) => <Tag key={k} color="blue">{k}</Tag>)}</div>
              <div>说明：{p.description || '—'}</div>
              <div style={{ color: 'var(--text-3)' }}>创建于 {dayjs.unix(p.createdAt).format('YYYY-MM-DD')}</div>
            </div>
          </Card>
        </Col>
      ))}
    </Row>
  )
}
