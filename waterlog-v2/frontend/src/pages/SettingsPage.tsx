// 系统设置：运行状态 + 演示控制 + 架构说明
import React from 'react'
import { Alert, Button, Card, Col, Descriptions, Row, Space, Statistic, Tag, App, Typography } from 'antd'
import { CloudOutlined, ThunderboltOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { PageHeader } from '@/components/common/PageHeader'
import { useAlarmStats, useDevices, useInjectRain, useSystemStatus } from '@/api/queries'

export const SettingsPage: React.FC = () => {
  const { message, modal } = App.useApp()
  const { data: status, refetch: refetchStatus } = useSystemStatus()
  const { data: stats } = useAlarmStats()
  const { data: devices = [] } = useDevices()
  const inject = useInjectRain()

  const doInject = (power: number) => {
    modal.confirm({
      title: power === 0 ? '结束模拟降雨？' : '注入模拟降雨？',
      content: power === 0 ? '水位回落，生效告警将自动解除' : '水位抬升，用于演示规则引擎与告警状态机',
      okText: '确认', cancelText: '取消',
      onOk: async () => {
        await inject.mutateAsync(power)
        message.success(power === 0 ? '已结束降雨' : '已注入降雨')
      },
    })
  }

  return (
    <div className="p-6 page-pad page-anim space-y-4" style={{ background: 'var(--bg-canvas)', minHeight: '100vh' }}>
      <PageHeader title="系统设置" description="运行状态 · 演示控制 · 架构说明" />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card size="small" title="运行状态" extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => refetchStatus()}>刷新</Button>}>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="服务">{status?.app ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="版本">{status?.version ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="模式">{status ? (status.demoMode ? '演示模式（模拟数据源）' : '生产模式') : '—'}</Descriptions.Item>
              <Descriptions.Item label="已运行">
                {status ? `${Math.floor(status.uptimeSec / 60)} 分钟` : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="服务器时间">
                {status ? dayjs.unix(status.serverTs).format('YYYY-MM-DD HH:mm:ss') : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="实时订阅">{status?.subscribers ?? 0} 个 SSE 连接</Descriptions.Item>
              <Descriptions.Item label="设备">
                在线 {devices.filter((d) => d.status === 'online').length} / 共 {devices.length}
              </Descriptions.Item>
              <Descriptions.Item label="告警">
                生效 {stats?.activeTotal ?? 0} · 未确认 {stats?.unackTotal ?? 0}
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <Card size="small" title="演示控制" className="mt-4">
            <Space wrap>
              <Button icon={<ThunderboltOutlined />} onClick={() => doInject(2.6)} loading={inject.isPending}>
                注入暴雨（水位快速抬升）
              </Button>
              <Button icon={<CloudOutlined />} onClick={() => doInject(0)} disabled={!status?.raining}>
                结束降雨
              </Button>
              <Tag color={status?.raining ? 'blue' : 'default'}>
                {status?.raining ? `模拟降雨中（强度 ${status.rainPower.toFixed(1)}）` : '当前无模拟降雨'}
              </Tag>
            </Space>
            <Alert
              className="mt-3"
              type="info"
              showIcon
              message="演示要点"
              description="注入暴雨后：遥测管道写入 → 规则引擎按「阈值 + 持续时长」求值 → 告警进入 ACTIVE_UNACK → 可在告警中心确认/解除/标记误报；结束降雨后条件恢复，告警自动转入 CLEARED_*。"
            />
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card size="small" title="架构说明">
            <Typography.Paragraph style={{ color: 'var(--text-2)', fontSize: 13 }}>
              <b>领域范式</b>：设备画像 / 设备 / 遥测 / 规则链 / 告警四态生命周期，参考 ThingsBoard CE（Apache 2.0）。
            </Typography.Paragraph>
            <Typography.Paragraph style={{ color: 'var(--text-2)', fontSize: 13 }}>
              <b>工程范式</b>：Router → Controller → Service → Repo 分层，前端构建产物 embed 进 Go 二进制，参考 new-api 的公开架构。
            </Typography.Paragraph>
            <Typography.Paragraph style={{ color: 'var(--text-2)', fontSize: 13 }}>
              <b>可插拔扩展</b>：数据源插件 / 预测模型插件 / 规则动作 / WebSocket 双向通道，均以 EXT-POINT 标注。
            </Typography.Paragraph>
            <div className="text-xs" style={{ color: 'var(--text-3)' }}>
              扩展点检索：<code>grep -rn "EXT-POINT" backend/internal</code>
            </div>
          </Card>

          <Card size="small" title="接口概览" className="mt-4">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="REST">/api/v1（统一 {'{code,message,data}'}）</Descriptions.Item>
              <Descriptions.Item label="实时推送">/api/v1/stream（SSE，遥测 + 告警事件）</Descriptions.Item>
              <Descriptions.Item label="遥测上报">POST /api/v1/telemetry（批量 samples）</Descriptions.Item>
              <Descriptions.Item label="规则管理">/api/v1/rule-chains 与 /rule-nodes</Descriptions.Item>
              <Descriptions.Item label="告警处置">/alarms/{'{id}'}/ack · clear · false-report</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>

      <Row gutter={12}>
        {[
          { title: '设备总数', value: String(devices.length), hint: `在线 ${devices.filter((d) => d.status === 'online').length}` },
          { title: '规则链', value: '2', hint: '内涝分级预警 / 强降雨监测' },
          { title: '数据保留', value: '72h', hint: 'RETENTION_HOURS 可配' },
        ].map((x) => (
          <Col xs={24} md={8} key={x.title}>
            <Card size="small">
              <Statistic title={x.title} value={x.value} />
              <div className="text-xs" style={{ color: 'var(--text-3)' }}>{x.hint}</div>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  )
}
