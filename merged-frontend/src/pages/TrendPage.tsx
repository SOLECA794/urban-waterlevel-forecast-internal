// P2: 趋势分析页 - 多预见期叠加 + 历史观测 + 版本对比（真实数据版）
// 修复 bug ②：任一站点无数据时给空态兜底，不再渲染空白图表
// P1: 新增「归因解释」Tab —— 预测归因因子分解 + 模型信息（对接 /forecasts/{id}/attribution）
import React, { useEffect, useMemo, useState } from 'react'
import { Card, Tabs, Select, Switch, Space, Tag, Table, Empty, Spin, Alert, Progress } from 'antd'
import { EnvironmentOutlined, HistoryOutlined, CloudOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { GisMap } from '@/components/gis/GisMap'
import { TrendChart } from '@/components/charts/TrendChart'
import { ForecastComparisonChart } from '@/components/charts/ForecastComparisonChart'
import { AgentCard } from '@/components/agent/AgentCard'
import { AlertBadge } from '@/components/common/AlertBadge'
import { PageHeader } from '@/components/common/PageHeader'
import {
  useEnabledLeads, useForecastAttribution, useForecastComparison, useLeads,
  useStationForecasts, useStationSeries, useStations,
} from '@/api/queries'
import { buildTrendCard } from '@/utils/agentCards'
import { useAppStore } from '@/stores/useAppStore'
import type { AttributionFactor } from '@/api/types'

const LEAD_STYLE: Record<number, { color: string; lineStyle: 'solid' | 'dashed' | 'dotted'; width: number }> = {
  1: { color: '#2563EB', lineStyle: 'solid', width: 2.5 },
  3: { color: '#F59E0B', lineStyle: 'solid', width: 2.2 },
  6: { color: '#7c3aed', lineStyle: 'dashed', width: 1.8 },
  12: { color: '#94a3b8', lineStyle: 'dotted', width: 1.6 },
}

// P1 归因：模型中文名映射
const MODEL_LABEL: Record<string, string> = {
  naive: '持久性模型（数据不足或降级时启用）',
  linear_response: '线性响应模型（降雨响应 + 汇流滞后）',
  nonlinear: '非线性模型（多窗口特征 + 自学习参数）',
}

// P1 归因：因子 → 主题色
const FACTOR_COLOR: Record<string, string> = {
  当前基线水位: '#64748b',
  降雨驱动: '#2563EB',
  退水回归: '#16A34A',
  协同修正: '#7c3aed',
  模型不确定度: '#94a3b8',
}

export const TrendPage: React.FC = () => {
  const selectedStationId = useAppStore((s) => s.selectedStationId)
  const setSelectedStation = useAppStore((s) => s.setSelectedStation)
  const [showHistory, setShowHistory] = useState(true)
  const [showRainfall, setShowRainfall] = useState(true)
  const [activeLeads, setActiveLeads] = useState<number[]>([])
  const [tabKey, setTabKey] = useState('current')
  const [compareId, setCompareId] = useState<number | null>(null)
  const [attrId, setAttrId] = useState<number | null>(null)

  const { data: stations, isLoading: loadingStations, isError: stationsError, error: stationsErr } = useStations()
  const { data: leadsAll } = useLeads()
  const enabledLeads = useEnabledLeads()

  const stationList = stations ?? []
  // 默认选中：全局选中站点 → 第一个站点
  const effectiveStationId = selectedStationId ?? stationList[0]?.stationId ?? null
  const station = stationList.find((s) => s.stationId === effectiveStationId)

  const { data: series, isLoading: loadingSeries } = useStationSeries(effectiveStationId, 24)
  const { data: revisions, isLoading: loadingRevisions } = useStationForecasts(effectiveStationId)

  const revList = revisions ?? []
  // 默认勾选：已启用且该站点有预测记录的预见期
  useEffect(() => {
    if (revList.length === 0) return
    const available = new Set(revList.map((r) => r.lead))
    const defaults = enabledLeads.map((l) => l.lead).filter((l) => available.has(l))
    setActiveLeads((prev) => (prev.length > 0 ? prev : defaults.length > 0 ? defaults : [revList[0].lead]))
  }, [revList, enabledLeads])
  useEffect(() => {
    setSelectedStation(effectiveStationId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveStationId])

  // 多预见期曲线数据（真实预测记录）
  const trendSeries = useMemo(() => {
    const out: Parameters<typeof TrendChart>[0]['series'] = []
    activeLeads.forEach((lead) => {
      const rev = revList.find((r) => r.lead === lead)
      if (!rev || rev.points.length === 0) return
      const st = LEAD_STYLE[lead] ?? { color: '#64748b', lineStyle: 'solid' as const, width: 2 }
      out.push({
        name: `${lead}h 预见期`,
        type: 'line',
        data: rev.points.map((p) => [p.time, Number(p.waterLevel.toFixed(3))] as [string, number]),
        color: st.color,
        lineStyle: st.lineStyle,
        width: st.width,
        showConfidence: true,
      })
    })
    return out
  }, [activeLeads, revList])

  // 历史同期：真实观测序列（24h）
  const historyData = useMemo(() => {
    if (!series) return []
    return series.points
      .filter((p) => p.level !== null && p.level !== undefined)
      .map((p) => [p.ts, Number(p.level!.toFixed(3))] as [string, number])
  }, [series])

  // 降雨：真实观测雨量（series rainObserved）
  const rainfallData = useMemo(() => {
    if (!series) return []
    return series.points
      .filter((p) => p.rainObserved > 0)
      .map((p) => [p.ts, p.rainObserved] as [string, number])
  }, [series])

  // 版本对比：默认选最新一条，可切换
  const comparisonOptions = useMemo(
    () => revList.map((r) => ({
      value: r.forecastId,
      label: `${r.id} · ${r.lead}h · ${dayjs(r.generatedAt).format('MM-DD HH:mm')}`,
    })),
    [revList],
  )
  useEffect(() => {
    if (compareId === null && revList.length > 0) setCompareId(revList[0].forecastId)
  }, [revList, compareId])
  // P1 归因：默认选最新一条预测版本
  useEffect(() => {
    if (attrId === null && revList.length > 0) setAttrId(revList[0].forecastId)
  }, [revList, attrId])
  const {
    data: attribution, isLoading: loadingAttr, isError: attrError, error: attrErr,
  } = useForecastAttribution(tabKey === 'attribution' ? attrId : null)
  const { data: comparison, isLoading: loadingComparison } = useForecastComparison(compareId)
  const comparisonActual: [string, number][] = useMemo(
    () => (comparison?.actual ?? [])
      .filter((p) => p.level !== null && p.level !== undefined)
      .map((p) => [p.time, p.level!] as [string, number]),
    [comparison],
  )

  // 底部指标卡数据
  const latestRev = useMemo(() => {
    const lead3 = revList.find((r) => r.lead === 3) ?? revList[0]
    return lead3
  }, [revList])
  const maxRain = useMemo(
    () => (rainfallData.length > 0 ? Math.max(...rainfallData.map(([, v]) => v)) : null),
    [rainfallData],
  )

  if (loadingStations) {
    return <div className="flex justify-center" style={{ height: 300 }}><Spin tip="加载监测点…" /></div>
  }
  if (stationsError) {
    return (
      <div className="p-4">
        <Alert type="error" message="监测点数据加载失败" description={(stationsErr as Error)?.message ?? '后端不可达，请检查后端服务与 API 地址配置'} showIcon />
      </div>
    )
  }

  const agentCard = buildTrendCard(station, revList, 3)

  return (
    <div className="p-4 page-pad page-anim space-y-3" style={{ background: 'var(--bg-canvas)', minHeight: 'calc(100vh - 40px)' }}>
      <PageHeader
        title="趋势分析"
        description="多预见期叠加 · 版本对比 · 归因解释"
        extra={station && station.alertLevel !== null ? <AlertBadge rank={station.alertLevel} /> : undefined}
      />
      {/* 顶部控制区 */}
      <Card size="small">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600">监测点：</span>
            <Select
              value={effectiveStationId ?? undefined}
              onChange={(v) => setSelectedStation(v)}
              style={{ width: 200 }}
              placeholder="选择监测点"
              options={stationList.map((s) => ({ value: s.stationId, label: `${s.stationName} (${s.stationCode})` }))}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600">预见期：</span>
            <Space>
              {(leadsAll ?? []).map((l) => {
                const hasData = revList.some((r) => r.lead === l.lead)
                return (
                  <Tag.CheckableTag
                    key={l.lead}
                    checked={activeLeads.includes(l.lead)}
                    onChange={(c) => {
                      if (!l.enabled || !hasData) return
                      setActiveLeads(c ? [...activeLeads, l.lead] : activeLeads.filter((x) => x !== l.lead))
                    }}
                    style={!l.enabled || !hasData ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
                  >
                    {l.lead}h
                    {!l.enabled && <Tag color="default" style={{ marginLeft: 4, fontSize: 9 }}>预留</Tag>}
                    {l.enabled && !hasData && <Tag color="default" style={{ marginLeft: 4, fontSize: 9 }}>暂无</Tag>}
                  </Tag.CheckableTag>
                )
              })}
            </Space>
          </div>
          <div className="flex items-center gap-3 ml-auto">
            <span className="text-sm text-slate-600 flex items-center gap-1">
              <HistoryOutlined /> 历史观测
              <Switch size="small" checked={showHistory} onChange={setShowHistory} />
            </span>
            <span className="text-sm text-slate-600 flex items-center gap-1">
              <CloudOutlined /> 降雨
              <Switch size="small" checked={showRainfall} onChange={setShowRainfall} />
            </span>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-12 gap-3">
        {/* 左侧：站点小地图 + Agent（<1024px 折叠到主图下方） */}
        <div className="col-span-12 lg:col-span-3 space-y-3">
          <Card size="small" title={<><EnvironmentOutlined /> 站点位置</>}>
            <div style={{ height: 220 }}>
              <GisMap stations={stationList} height={220} />
            </div>
          </Card>
          <AgentCard card={agentCard} />
        </div>

        {/* 右侧：主趋势图 + Tab 切换 */}
        <div className="col-span-12 lg:col-span-9 space-y-3">
          <Card
            size="small"
            title={station ? `主趋势图 - ${station.stationName} (${station.stationCode})` : '主趋势图'}
            extra={station && station.alertLevel !== null ? <AlertBadge rank={station.alertLevel} /> : undefined}
          >
            <Tabs
              activeKey={tabKey}
              onChange={setTabKey}
              items={[
                { key: 'current', label: '当前预测' },
                { key: 'comparison', label: '预测版本对比' },
                { key: 'events', label: '预测记录' },
                { key: 'attribution', label: '归因解释' },
              ]}
            />
            {tabKey === 'current' && (
              loadingRevisions || loadingSeries ? (
                <div className="flex justify-center py-16"><Spin /></div>
              ) : trendSeries.length === 0 && historyData.length === 0 ? (
                <Empty description="该站点暂无预测与观测数据" style={{ padding: 40 }} />
              ) : (
                <TrendChart
                  series={[
                    ...trendSeries,
                    ...(showHistory && historyData.length > 0
                      ? [{
                          name: '历史观测 (24h)',
                          type: 'line' as const,
                          data: historyData,
                          color: '#94a3b8', lineStyle: 'dashed' as const, width: 1.5,
                        }]
                      : []),
                  ]}
                  height={400}
                  showThreshold
                  showRainfall={showRainfall && rainfallData.length > 0}
                  rainfallData={rainfallData}
                />
              )
            )}
            {tabKey === 'comparison' && (
              loadingComparison ? (
                <div className="flex justify-center py-16"><Spin /></div>
              ) : !comparison ? (
                <Empty description="暂无预测记录可对比" style={{ padding: 40 }} />
              ) : comparisonActual.length === 0 ? (
                <Empty
                  description="该预测版本尚无实际观测样本（预测目标时刻未到或未回填），请选择更早的版本"
                  style={{ padding: 40 }}
                />
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-slate-500">对比版本：</span>
                    <Select
                      size="small"
                      value={compareId ?? undefined}
                      onChange={setCompareId}
                      options={comparisonOptions}
                      style={{ width: 320 }}
                    />
                    <Space size="small">
                      <Tag color="blue">MAE {comparison.metrics.mae.toFixed(3)}m</Tag>
                      <Tag color="blue">RMSE {comparison.metrics.rmse.toFixed(3)}m</Tag>
                      <Tag color="green">区间命中率 {(comparison.metrics.hitRate * 100).toFixed(0)}%</Tag>
                      <Tag>样本 {comparison.metrics.sampleCount}</Tag>
                    </Space>
                  </div>
                  <ForecastComparisonChart
                    forecastData={comparison.forecast.points.map((p) => [p.time, Number(p.waterLevel.toFixed(3))] as [string, number])}
                    actualData={comparisonActual}
                    height={400}
                    stationName={station?.stationName ?? ''}
                  />
                </div>
              )
            )}
            {tabKey === 'events' && (
              <Table
                size="small"
                dataSource={revList.map((r) => ({ ...r, key: r.id }))}
                columns={[
                  { title: '版本', dataIndex: 'id', key: 'id' },
                  { title: '预见期', dataIndex: 'lead', key: 'lead', render: (l) => `${l}h` },
                  { title: '生成时间', dataIndex: 'generatedAt', key: 'generatedAt', render: (t) => dayjs(t).format('MM-DD HH:mm') },
                  { title: '模型', dataIndex: 'modelVersion', key: 'modelVersion' },
                  { title: '预测峰值', dataIndex: 'peakLevel', key: 'peakLevel', render: (v) => <span className="font-mono">{v?.toFixed(2)}m</span> },
                  {
                    title: '触发等级',
                    dataIndex: 'triggeredAlertLevel',
                    key: 'level',
                    render: (l) => l !== null && l !== undefined ? <AlertBadge rank={l} size="small" /> : <span className="text-slate-400">未触发</span>,
                  },
                  {
                    title: '降级',
                    dataIndex: 'degraded',
                    key: 'degraded',
                    render: (d: boolean) => (d ? <Tag color="orange">降级</Tag> : <Tag color="green">正常</Tag>),
                  },
                ]}
                pagination={false}
              />
            )}
            {tabKey === 'attribution' && (
              <div className="space-y-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-xs text-slate-500">预测版本：</span>
                  <Select
                    size="small"
                    value={attrId ?? undefined}
                    onChange={setAttrId}
                    options={comparisonOptions}
                    style={{ width: 320 }}
                  />
                  {attribution && (
                    <Space size="small">
                      <Tag color="blue">{attribution.leadHours}h 预见期</Tag>
                      <Tag>{attribution.cached ? '缓存结果' : '实时计算'}</Tag>
                    </Space>
                  )}
                </div>
                {loadingAttr ? (
                  <div className="flex justify-center py-16"><Spin tip="归因计算中…" /></div>
                ) : attrError ? (
                  <Alert
                    type="warning" showIcon
                    message="归因数据暂不可用"
                    description={`${(attrErr as Error)?.message ?? '未知错误'} —— 该预测可能缺少逐点数据或决策记录，请选择其他版本`}
                  />
                ) : !attribution ? (
                  <Empty description="暂无预测版本可归因" style={{ padding: 40 }} />
                ) : (
                  <>
                    <Alert type="info" showIcon message={attribution.summary} />
                    <div className="grid grid-cols-3 gap-3">
                      <Card size="small">
                        <div className="text-xs text-slate-500">基线水位</div>
                        <div className="text-xl font-semibold text-slate-700 mt-1">{attribution.baseLevel.toFixed(2)}m</div>
                        <div className="text-xs text-slate-400 mt-1">预测起点实测水位</div>
                      </Card>
                      <Card size="small">
                        <div className="text-xs text-slate-500">预测峰值</div>
                        <div className="text-xl font-semibold text-orange-600 mt-1">{attribution.predictedLevel.toFixed(2)}m</div>
                        <div className="text-xs text-slate-400 mt-1">{dayjs(attribution.peakTime).format('MM-DD HH:mm')} 到达</div>
                      </Card>
                      <Card size="small">
                        <div className="text-xs text-slate-500">净变化</div>
                        <div className="text-xl font-semibold text-blue-600 mt-1">
                          {(attribution.predictedLevel - attribution.baseLevel >= 0 ? '+' : '') + (attribution.predictedLevel - attribution.baseLevel).toFixed(2)}m
                        </div>
                        <div className="text-xs text-slate-400 mt-1">峰值 − 基线</div>
                      </Card>
                    </div>
                    <Table<AttributionFactor>
                      size="small"
                      rowKey="name"
                      dataSource={attribution.factors}
                      pagination={false}
                      columns={[
                        {
                          title: '归因因子', dataIndex: 'name', width: 130,
                          render: (name: string) => (
                            <Space size="small">
                              <span style={{ width: 8, height: 8, borderRadius: '50%', background: FACTOR_COLOR[name] ?? '#64748b', display: 'inline-block' }} />
                              <span className="font-medium">{name}</span>
                            </Space>
                          ),
                        },
                        {
                          title: '贡献值', dataIndex: 'value', width: 110,
                          render: (v: number, r: AttributionFactor) => (
                            <span className="font-mono" style={{ color: v > 0.001 ? '#EA580C' : v < -0.001 ? '#52C41A' : '#64748b' }}>
                              {v > 0.001 ? '+' : ''}{v.toFixed(3)} {r.unit}
                            </span>
                          ),
                        },
                        {
                          title: '占比', dataIndex: 'percentage', width: 90,
                          render: (p: number, r: AttributionFactor) => r.name === '当前基线水位'
                            ? <span className="text-slate-400 text-xs">基准</span>
                            : <span className="font-mono">{p.toFixed(1)}%</span>,
                        },
                        { title: '说明', dataIndex: 'description' },
                      ]}
                    />
                    <Card size="small" title="模型信息">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <div className="text-xs text-slate-500 mb-1">选用模型</div>
                          <div className="text-sm font-medium">{MODEL_LABEL[attribution.modelInfo.selectedModel] ?? attribution.modelInfo.selectedModel}</div>
                          <div className="text-xs text-slate-400 mt-1">版本 {attribution.modelInfo.modelVersion}</div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-500 mb-1">运行状态</div>
                          <Space>
                            {attribution.modelInfo.degraded ? <Tag color="orange">降级模式</Tag> : <Tag color="green">正常</Tag>}
                            <Tag>置信系数 ×{attribution.modelInfo.ciScale}</Tag>
                          </Space>
                        </div>
                      </div>
                      <div className="mt-3">
                        <div className="text-xs text-slate-500 mb-2">多源融合权重</div>
                        <div className="grid grid-cols-3 gap-3">
                          {([
                            ['水位实况', attribution.modelInfo.fusionWeights.level, '#2563EB'],
                            ['降雨实况', attribution.modelInfo.fusionWeights.rain, '#F59E0B'],
                            ['降雨预报', attribution.modelInfo.fusionWeights.fcst, '#7c3aed'],
                          ] as [string, number, string][]).map(([label, w, color]) => (
                            <div key={label}>
                              <div className="flex justify-between text-xs mb-1">
                                <span className="text-slate-600">{label}</span>
                                <span className="font-mono">{(w * 100).toFixed(0)}%</span>
                              </div>
                              <Progress percent={Math.round(w * 100)} showInfo={false} strokeColor={color} size="small" />
                            </div>
                          ))}
                        </div>
                      </div>
                    </Card>
                  </>
                )}
              </div>
            )}
          </Card>

          {/* 底部指标卡（真实数据） */}
          {tabKey === 'current' && (
            <div className="grid grid-cols-4 gap-3">
              <Card size="small">
                <div className="text-xs text-slate-500">{latestRev?.lead ?? 3}h 预测峰值</div>
                <div className="text-2xl font-semibold text-orange-600 mt-1">
                  {latestRev ? `${latestRev.peakLevel.toFixed(2)}m` : '—'}
                </div>
                <div className="text-xs text-slate-400">{latestRev ? `${dayjs(latestRev.peakTime).format('HH:mm')} 到达` : '暂无预测'}</div>
              </Card>
              <Card size="small">
                <div className="text-xs" style={{ color: 'var(--text-2)' }}>整体置信区间</div>
                <div className="text-2xl font-semibold num mt-1" style={{ color: latestRev ? 'var(--text-1)' : 'var(--text-3)' }}>
                  {latestRev ? `${latestRev.confidenceInterval.lower.toFixed(2)} - ${latestRev.confidenceInterval.upper.toFixed(2)}m` : '—'}
                </div>
                <div className="text-xs" style={{ color: 'var(--text-3)' }}>{latestRev?.modelVersion ?? '暂无预测'}</div>
              </Card>
              <Card size="small">
                <div className="text-xs" style={{ color: 'var(--text-2)' }}>版本对比偏差</div>
                <div className="text-2xl font-semibold num mt-1" style={{ color: comparison && comparisonActual.length > 0 ? 'var(--text-1)' : 'var(--text-3)' }}>
                  {comparison && comparisonActual.length > 0 ? `MAE ${comparison.metrics.mae.toFixed(3)}m` : '—'}
                </div>
                <div className="text-xs" style={{ color: 'var(--text-3)' }}>
                  {comparison && comparisonActual.length > 0 ? `命中率 ${(comparison.metrics.hitRate * 100).toFixed(0)}%` : '暂无实际样本'}
                </div>
              </Card>
              <Card size="small">
                <div className="text-xs" style={{ color: 'var(--text-2)' }}>最大观测雨强</div>
                <div className="text-2xl font-semibold num mt-1" style={{ color: maxRain !== null ? '#0284C7' : 'var(--text-3)' }}>
                  {maxRain !== null ? `${maxRain.toFixed(1)}mm` : '—'}
                </div>
                <div className="text-xs" style={{ color: 'var(--text-3)' }}>近 24h · 步长 {series?.stepMinutes ?? '—'}min</div>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
