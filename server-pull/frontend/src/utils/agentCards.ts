// Agent 嵌入式卡片生成器 - 由真实 API 数据派生（替代 mockAgentCards）
// 保留原 6 个点位结构：overview_global / trend_confidence / alert_action / datasource_health / calibration_suggest / config_recommend
import dayjs from 'dayjs'
import type {
  AgentCard, AlertEvent, AlertStats, Datasource, ForecastRevision, ModelItem, Station, SystemStatus,
} from '@/types'

const now = () => dayjs().format('YYYY-MM-DD HH:mm')

function trendOfSlope(slope?: number | null): 'up' | 'down' | 'stable' {
  if (slope === undefined || slope === null) return 'stable'
  if (slope > 0.0005) return 'up'
  if (slope < -0.0005) return 'down'
  return 'stable'
}

// P1 总览页：全局态势摘要
export function buildOverviewCard(stations: Station[], stats: AlertStats | undefined): AgentCard {
  const alerting = stations.filter((s) => s.alertLevel !== null && s.alertLevel !== undefined)
  const top = [...alerting].sort((a, b) => (b.alertLevel ?? 0) - (a.alertLevel ?? 0))[0]
  const maxLevelName = top?.alertLevelName ?? '无'
  const activeTotal = stats?.activeTotal ?? alerting.length
  const todayTotal = stats?.todayTotal ?? 0
  const rising = stations.filter((s) => s.trend === 'rising').length
  return {
    id: 'overview_global',
    position: 'overview_global',
    title: '全局态势研判',
    generatedAt: now(),
    conclusion:
      alerting.length === 0
        ? `当前 ${stations.length} 个监测点水位平稳，无超阈预警，建议保持常规监测。`
        : `当前 ${alerting.length} 个监测点处于预警状态，最高 ${maxLevelName}（${top?.stationName ?? '-'}），今日累计产生 ${todayTotal} 条预警。`,
    metrics: [
      { label: '活跃预警', value: String(activeTotal), trend: activeTotal > 0 ? 'up' : 'stable' },
      { label: '今日累计', value: String(todayTotal) },
      { label: '水位上涨站点', value: `${rising}/${stations.length}`, trend: rising > 0 ? 'up' : 'stable' },
    ],
    factors: alerting.slice(0, 3).map(
      (s) => `${s.stationName} 当前 ${s.currentLevel?.toFixed(2) ?? '-'}m（${s.alertLevelName ?? '无预警'}）`,
    ).concat(alerting.length === 0 ? ['全部站点水位处于警戒线以下'] : []),
    suggestion:
      alerting.length === 0
        ? '保持 15 分钟周期自动预测，关注气象预报变化。'
        : `优先关注 ${top?.stationName ?? '高风险站点'}，建议值班员确认预警并按渠道发布。`,
  }
}

// P2 趋势页：预测置信度研判
export function buildTrendCard(station: Station | undefined, revisions: ForecastRevision[], lead: number): AgentCard {
  const rev = revisions.find((r) => r.lead === lead) ?? revisions[0]
  if (!rev || !station) {
    return {
      id: 'trend_confidence', position: 'trend_confidence', title: '预测置信度研判', generatedAt: now(),
      conclusion: '暂无预测记录，等待下一轮预测周期执行。', metrics: [], factors: [],
      suggestion: '可在总览页手动触发预测，或等待系统 15 分钟周期自动执行。',
    }
  }
  const ciWidth = rev.confidenceInterval.upper - rev.confidenceInterval.lower
  const ciPct = rev.peakLevel > 0 ? (ciWidth / rev.peakLevel) * 100 : 0
  const model = rev.decision?.selectedModel ?? rev.modelVersion
  return {
    id: 'trend_confidence', position: 'trend_confidence', title: '预测置信度研判', generatedAt: now(),
    conclusion: rev.degraded
      ? `${station.stationName} ${rev.lead}h 预测处于降级模式（${model}），结论仅供参考。`
      : `${station.stationName} ${rev.lead}h 预测峰值 ${rev.peakLevel.toFixed(2)}m（${dayjs(rev.peakTime).format('HH:mm')} 到达），模型 ${model}。`,
    metrics: [
      { label: '预测峰值', value: `${rev.peakLevel.toFixed(2)}m`, trend: 'up' },
      { label: '置信区间宽度', value: `±${(ciPct / 2).toFixed(1)}%` },
      { label: 'MAE', value: rev.mae !== null && rev.mae !== undefined ? `${rev.mae.toFixed(3)}m` : '—' },
    ],
    factors: [
      `选用模型：${model}${rev.decision ? `（融合权重 水位:${rev.decision.fusionWeights.level} 降雨:${rev.decision.fusionWeights.rain} 预报:${rev.decision.fusionWeights.fcst}）` : ''}`,
      `修正系数 α=${rev.decision?.revisionAlpha ?? '—'}，置信带缩放 ${rev.decision?.ciScale ?? '—'}`,
      rev.decision?.reason ? `决策依据：${rev.decision.reason}` : '',
    ].filter(Boolean),
    suggestion: rev.triggeredAlertLevel !== null && rev.triggeredAlertLevel !== undefined
      ? `本版本触发 ${rev.triggeredAlertLevel + 1} 级预警，建议结合实际观测在版本对比页核对偏差。`
      : '预测值未触发预警，建议持续跟踪实际观测偏差。',
  }
}

// P3 预警中心：处置建议
export function buildAlertCard(alert: AlertEvent): AgentCard {
  const leadMin = alert.lead ?? 0
  const peak = alert.peakLevel?.toFixed(2) ?? '—'
  return {
    id: `alert_action_${alert.alertId}`, position: 'alert_action', title: '预警处置建议', generatedAt: now(),
    conclusion: `${alert.stationName} ${alert.levelName}预警：预测峰值 ${peak}m，较阈值提前 ${Math.round(leadMin)} 分钟识别。`,
    metrics: [
      { label: '预测峰值', value: `${peak}m`, trend: trendOfSlope(alert.trend) },
      { label: '提前量', value: `${Math.round(leadMin)}min` },
      { label: '预见期', value: `${alert.leadHours ?? '—'}h` },
    ],
    factors: alert.reasoning.length > 0 ? alert.reasoning : [alert.reason ?? '水位超过对应等级阈值'],
    suggestion:
      alert.status === 'active'
        ? '建议值班员先【确认】预警，再选择启用渠道【发布】。'
        : alert.status === 'confirmed'
          ? '预警已确认，建议立即通过渠道发布并通知现场巡防。'
          : alert.status === 'published'
            ? '预警已发布，持续跟踪水位变化，回落至阈值下可解除。'
            : '该预警已关闭，无需处置。',
  }
}

// P4 数据源页：数据健康研判
export function buildDatasourceCard(sources: Datasource[]): AgentCard {
  const enabled = sources.filter((s) => s.enabled)
  const abnormal = sources.filter((s) => s.enabled && s.status !== 'connected' && s.status !== 'ok')
  const withQ = enabled.filter((s) => s.quality.successRate !== null && s.quality.successRate !== undefined)
  const avg = withQ.length > 0 ? withQ.reduce((a, s) => a + (s.quality.successRate ?? 0), 0) / withQ.length : null
  return {
    id: 'datasource_health', position: 'datasource_health', title: '数据源健康研判', generatedAt: now(),
    conclusion:
      abnormal.length === 0
        ? `${enabled.length}/${sources.length} 个数据源已接入，数据链路正常。`
        : `检测到 ${abnormal.length} 个已接入数据源异常（${abnormal.map((s) => s.name).join('、')}），可能影响预见期准确率。`,
    metrics: [
      { label: '已接入', value: `${enabled.length}/${sources.length}` },
      { label: '平均成功率', value: avg !== null ? `${(avg * 100).toFixed(1)}%` : '—' },
      { label: '异常源', value: String(abnormal.length), trend: abnormal.length > 0 ? 'up' : 'stable' },
    ],
    factors: enabled.slice(0, 3).map(
      (s) => `${s.name}：刷新 ${s.refreshIntervalSec}s，成功率 ${s.quality.successRate !== null && s.quality.successRate !== undefined ? `${(s.quality.successRate * 100).toFixed(1)}%` : '—'}`,
    ),
    suggestion: abnormal.length === 0
      ? '数据链路健康，维持当前刷新频率。'
      : '建议优先排查异常数据源的接入地址与网络连通性。',
  }
}

// P5 校准页：校准建议
export function buildCalibrationCard(models: ModelItem[], status: SystemStatus | undefined, calibTotal: number): AgentCard {
  const active = models.find((m) => m.active)
  const activeRmse = active?.rmse
  return {
    id: 'calibration_suggest', position: 'calibration_suggest', title: '模型校准建议', generatedAt: now(),
    conclusion: active
      ? `当前生效模型 ${active.modelName}（${active.modelType} v${active.version}），${activeRmse !== null && activeRmse !== undefined ? `RMSE ${activeRmse.toFixed(3)}m` : '暂无评估指标'}。`
      : '未发现生效模型。',
    metrics: [
      { label: '生效模型', value: active?.modelName ?? '—' },
      { label: 'RMSE', value: activeRmse !== null && activeRmse !== undefined ? `${activeRmse.toFixed(3)}m` : '—' },
      { label: '校准记录', value: String(calibTotal) },
      { label: '预测周期', value: `${status?.forecastIntervalMinutes ?? '—'}min` },
    ],
    factors: models.slice(0, 4).map(
      (m) => `${m.modelName}（${m.modelType}）：${m.active ? '生效中' : m.activatable ? '可激活' : '不可激活'}`,
    ),
    suggestion: activeRmse !== null && activeRmse !== undefined && activeRmse > 0.15
      ? 'RMSE 偏高，建议对 linear_response 模型执行参数校准并比对前后指标。'
      : '模型指标处于可接受范围，保持周期性评估即可。',
  }
}

// P6 设置页：配置建议
export function buildConfigCard(levels: { length: number }, leads: { lead: number; enabled: boolean }[], channels: { enabled: boolean }[]): AgentCard {
  const enabledLeads = leads.filter((l) => l.enabled).map((l) => `${l.lead}h`)
  const enabledCh = channels.filter((c) => c.enabled).length
  return {
    id: 'config_recommend', position: 'config_recommend', title: '配置合理性建议', generatedAt: now(),
    conclusion: `当前 ${levels.length} 级预警体系，启用预见期 ${enabledLeads.join(' / ') || '无'}，发布渠道 ${enabledCh}/${channels.length} 个。`,
    metrics: [
      { label: '等级数', value: `${levels.length} 级` },
      { label: '启用预见期', value: enabledLeads.join('、') || '—' },
      { label: '启用渠道', value: `${enabledCh}/${channels.length}` },
    ],
    factors: [
      '等级阈值修改立即对未来预测生效',
      '1h 为最低预见期，始终保持启用',
      '禁用渠道不会出现在预警发布选项中',
    ],
    suggestion:
      enabledCh === 0
        ? '当前无可用发布渠道，预警将无法触达，请至少启用一个渠道。'
        : '配置合理；阈值调整后建议在趋势页观察预测偏差变化。',
  }
}
