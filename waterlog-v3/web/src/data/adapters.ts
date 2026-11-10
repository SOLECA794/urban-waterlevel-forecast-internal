import type {
  AlertDetailRespDTO,
  AlertNoteDTO,
  AuditEntryDTO,
  DecisionRowDTO,
  DeliveryDTO,
  EvalPairDTO,
  FactorsDTO,
  ForecastPayloadDTO,
  HealthRespDTO,
  HorizonDTO,
  MetricRowDTO,
  MetricsBundleDTO,
  MetricsRespDTO,
  ModelVersionDTO,
  NotifyChannelDTO,
  OverviewSiteDTO,
  RollingStatDTO,
  RuleImpactDTO,
  RulesDocDTO,
  SeriesPointDTO,
  SiteDetailRespDTO,
  SiteForecastDTO,
  SiteMetaDTO,
  UserDTO,
  WarningDTO,
  WarningEventDTO,
} from './dto'

import type {
  AlertDetail,
  AlertEvent,
  AlertNote,
  AuditEntry,
  Delivery,
  NotifyChannel,
  User,
  Assessment,
  CurvePoint,
  Decision,
  Delta,
  Depth,
  Disposition,
  EvalPair,
  Factors,
  Forecast,
  Horizon,
  Level,
  MetricRow,
  Metrics,
  MetricsBundle,
  Meters,
  ModelVersion,
  RainRate,
  Rate,
  Reading,
  RuleImpact,
  Rules,
  RulesImpact,
  RollingStat,
  SimTime,
  Site,
  SiteDetailView,
  SiteForecast,
  SiteSeries,
  SystemHealth,
  Thresholds,
  WarnState,
} from '../domain'
import { isRole, qualityOf, ROLE_LABEL, UNKNOWN_ENGINE } from '../domain'

/**
 * 适配层：**全前端唯一做单位换算和形状规范化的地方。**
 *
 * 规则很简单，但必须严格执行：
 * - 所有 snake_case → camelCase
 * - 所有裸 number → 带量纲的品牌类型（meters / depth / rate …）
 * - 所有数组按位置访问 → 具名对象
 *
 * 违反这条规则的地方（比如页面里写 `site.thresholds[3]`）就是 bug 的孵化器。
 */

export class ContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContractError'
  }
}

const VALID_LEVELS: readonly Level[] = ['none', 'blue', 'yellow', 'orange', 'red']
const VALID_STATES: readonly WarnState[] = [
  'ACTIVE_UNACK',
  'ACTIVE_ACK',
  'CLEARED_UNACK',
  'CLEARED_ACK',
]
const VALID_DISPOSITIONS: readonly Disposition[] = [
  'open',
  'dispatched',
  'onsite',
  'resolved',
  'false_alarm',
]

function asLevel(v: string | null | undefined): Level {
  return VALID_LEVELS.includes(v as Level) ? (v as Level) : 'none'
}

function asState(v: string): WarnState {
  return VALID_STATES.includes(v as WarnState) ? (v as WarnState) : 'ACTIVE_UNACK'
}

function asDisposition(v: string | null | undefined): Disposition {
  return VALID_DISPOSITIONS.includes(v as Disposition) ? (v as Disposition) : 'open'
}

const num = (v: number | null | undefined): number => (Number.isFinite(v as number) ? (v as number) : 0)
const stamp = (v: number | null | undefined): SimTime => num(v) as SimTime

/**
 * 阈值数组 → 具名对象。**必须有四个**，缺一个就抛错。
 *
 * 以前这里会 `thresholds[3] || 0.46` 兜底，而 0.46 是 S01 的红阈值，
 * 套到别的站点就是错的数字，而且它长得像真的，没人会发现。
 * 宁可让页面显示一条明确的错误，也不要显示一个猜出来的阈值。
 */
export function adaptThresholds(raw: readonly number[] | undefined, siteId: string): Thresholds {
  if (!raw || raw.length < 4) {
    throw new ContractError(`站点 ${siteId} 的阈值不足 4 级（收到 ${raw?.length ?? 0} 个）`)
  }
  const [blue, yellow, orange, red] = raw
  if (![blue, yellow, orange, red].every((v) => Number.isFinite(v) && v > 0)) {
    throw new ContractError(`站点 ${siteId} 的阈值含非法值 [${raw.slice(0, 4).join(', ')}]`)
  }
  return { blue: blue as Meters, yellow: yellow as Meters, orange: orange as Meters, red: red as Meters }
}

// ---------------------------------------------------------------- 站点与实测

export function adaptSite(d: SiteMetaDTO): Site {
  return {
    id: d.site_id,
    name: d.name,
    district: d.district,
    lon: num(d.lon),
    lat: num(d.lat),
    baseLevel: num(d.base_level) as Meters,
    thresholds: adaptThresholds(d.thresholds, d.site_id),
    kind: d.kind as Site['kind'],
    drainage:
      d.catchment_ha != null
        ? {
            catchmentHa: num(d.catchment_ha),
            pondHa: num(d.pond_ha),
            impervious: num(d.impervious),
            drainageMmH: num(d.drainage_mm_h),
          }
        : undefined,
  }
}

/** 一张图的一行 → 站点 + 实测 + 研判，三个契约各自独立。 */
export function adaptOverviewSite(d: OverviewSiteDTO): {
  site: Site
  reading: Reading
  assessment: Assessment
} {
  const base = num(d.base_level) as Meters
  return {
    site: {
      id: d.site_id,
      name: d.name,
      district: d.district,
      lon: num(d.lon),
      lat: num(d.lat),
      baseLevel: base,
      thresholds: adaptThresholds(d.thresholds, d.site_id),
      kind: d.kind as Site['kind'],
    },
    reading: {
      level: num(d.level) as Meters,
      // 后端已经算过 depth，但这里仍然用 adapters 统一口径：
      // 前端只认一个来源，别一边用后端算的、一边自己用 level-base 再算一遍。
      depth: num(d.depth) as Depth,
      rain: num(d.rain) as RainRate,
      quality: qualityOf(num(d.quality)),
      trend1h: num(d.trend_1h) as Delta,
      updatedAt: stamp(d.updated_at),
      spark: (d.spark ?? []).map((v) => num(v) as Meters),
    },
    assessment: {
      level: asLevel(d.warn_level),
      score: num(d.warn_score),
      peakValue: num(d.peak_value) as Depth,
      // peak_level 是「峰值那一刻的等级」，不等于最终研判等级——
      // 一个站点可以峰值判红、但持续不够被压成橙。以前这里填的是 warn_level。
      peakLevel: asLevel(d.peak_level || d.warn_level),
      peakAtMin: d.peak_at_min ?? null,
      durationMin: num(d.duration_min),
      slope: num(d.slope_mh) as Rate,
      reason: d.reason || '尚无研判结果',
      blockedBy: null,
      factors: adaptFactors(d.factors),
      horizonMin: num(d.horizon_min),
    },
  }
}

function adaptFactors(d: FactorsDTO | undefined): Factors {
  return {
    peak: num(d?.peak),
    duration: num(d?.duration),
    trend: num(d?.trend),
    score: num(d?.score),
  }
}

// ---------------------------------------------------------------- 预测

function adaptHorizon(d: HorizonDTO): Horizon {
  return {
    horizonMin: num(d.horizon_min),
    level: num(d.level) as Meters,
    lower: num(d.lower) as Meters,
    upper: num(d.upper) as Meters,
    delta: num(d.delta) as Delta,
    rawDelta: num(d.delta_raw) as Delta,
    corrected: num(d.corrected) as Delta,
    gain: num(d.gain),
    sigma: num(d.sigma) as Meters,
    model: d.model ?? 'blend',
    reason: d.reason ?? '',
  }
}

function adaptCurve(raw: readonly (readonly number[])[]): CurvePoint[] {
  return raw
    .filter((p) => p.length >= 4)
    .map((p) => ({
      offsetMin: num(p[0]),
      level: num(p[1]) as Meters,
      lower: num(p[2]) as Meters,
      upper: num(p[3]) as Meters,
    }))
}

export function adaptAssessment(d: WarningDTO): Assessment {
  return {
    level: asLevel(d.level),
    score: num(d.score),
    peakValue: num(d.peak_value) as Depth,
    peakLevel: asLevel(d.peak_level),
    peakAtMin: d.peak_at_min ?? null,
    durationMin: num(d.duration_min),
    slope: num(d.slope_mh) as Rate,
    reason: d.reason || '尚无研判结果',
    blockedBy: d.blocked_by ?? null,
    factors: adaptFactors(d.factors),
    horizonMin: num(d.horizon_min),
  }
}

export function adaptSiteForecast(d: SiteForecastDTO): SiteForecast {
  const decision: Decision = {
    shouldForecast: !!d.decision?.should_forecast,
    model: d.decision?.model ?? 'blend',
    gain: num(d.decision?.gain),
    reason: d.decision?.reason ?? '',
    signals: d.decision?.signals ?? {},
  }
  return {
    siteId: d.site_id,
    nowLevel: num(d.now_level) as Meters,
    horizons: (d.horizons ?? []).map(adaptHorizon),
    curve: adaptCurve(d.curve ?? []),
    assessment: adaptAssessment(d.warning),
    decision,
  }
}

export function adaptForecast(d: ForecastPayloadDTO): Forecast {
  const sites: Record<string, SiteForecast> = {}
  for (const [id, sf] of Object.entries(d.sites ?? {})) sites[id] = adaptSiteForecast(sf)
  return {
    issuedAt: stamp(d.issued_at),
    modelVersion: d.model_version ?? 'unknown',
    stepMin: num(d.step_min) || 5,
    sites,
  }
}

export function adaptSiteDetail(d: SiteDetailRespDTO): SiteDetailView {
  return {
    site: adaptSite(d.site),
    // 序列统一走 adaptSeries，别再在这里写一遍点映射——
    // 以前详情的序列是 {ts,level,rain}、别的页面是 {at,level,rain}，两套形状两套取值。
    series: adaptSeries(d.history ?? [], d.site.site_id, 0),
    forecast: d.forecast ? adaptSiteForecast(d.forecast) : null,
    issuedAt: d.issued_at != null ? stamp(d.issued_at) : null,
    modelVersion: d.model_version ?? null,
  }
}

// ---------------------------------------------------------------- 预警事件

export function adaptAlertEvent(d: WarningEventDTO): AlertEvent {
  return {
    id: num(d.id),
    siteId: d.site_id,
    siteName: d.site_name || d.site_id,
    level: asLevel(d.level),
    score: num(d.score),
    peakValue: num(d.peak_value) as Depth,
    peakAtMin: d.peak_at_min ?? null,
    durationMin: num(d.duration_min),
    slope: num(d.slope_mh) as Rate,
    reason: d.reason || '',
    state: asState(d.state),
    disposition: asDisposition(d.disposition),
    assignee: d.assignee ?? null,
    raisedAt: stamp(d.raised_at),
    ackedAt: d.acked_at != null ? stamp(d.acked_at) : null,
    clearedAt: d.cleared_at != null ? stamp(d.cleared_at) : null,
    updatedAt: stamp(d.updated_at),
    noteCount: num(d.note_count),
  }
}

export function adaptAlertNote(d: AlertNoteDTO): AlertNote {
  return {
    id: num(d.id),
    eventId: num(d.event_id),
    author: d.author || '值班员',
    kind: (d.kind || 'note') as AlertNote['kind'],
    text: d.text ?? '',
    createdAt: stamp(d.created_at),
  }
}

export function adaptAlertDetail(d: AlertDetailRespDTO): AlertDetail {
  return { event: adaptAlertEvent(d.event), notes: (d.notes ?? []).map(adaptAlertNote) }
}

// ---------------------------------------------------------------- 模型评估

export function adaptMetricRow(d: MetricRowDTO): MetricRow {
  return {
    horizonMin: num(d.horizon_min),
    rmse: num(d.rmse) as Meters,
    mae: num(d.mae) as Meters,
    mape: num(d.mape),
    nse: num(d.nse),
    skill: num(d.skill_vs_persistence),
    crps: num(d.crps) as Meters,
    // 引擎输出百分数（92.36），domain 约定比例（0.9236）。归一化放在这里，
    // 页面只负责乘 100 显示——曾经两边都当比例，界面上出现 "9236.0%"。
    picp90: num(d.picp90) > 1.5 ? num(d.picp90) / 100 : num(d.picp90),
    pinaw: num(d.pinaw),
    n: num(d.n),
    eventN: num(d.event_n),
    eventRmse: num(d.event_rmse) as Meters,
    eventSkill: num(d.event_skill),
  }
}

function adaptRolling(d: RollingStatDTO): RollingStat {
  return {
    n: num(d.n),
    rmse: num(d.rmse) as Meters,
    mae: num(d.mae) as Meters,
    bias: num(d.bias) as Meters,
    baselineRmse: num(d.baseline_rmse) as Meters,
    skill: num(d.skill),
    p95Abs: num(d.p95_abs) as Meters,
  }
}

function adaptMetricsBundle(d: MetricsBundleDTO): MetricsBundle {
  const metrics: Record<string, MetricRow[]> = {}
  for (const [family, rows] of Object.entries(d.metrics ?? {})) {
    metrics[family] = (rows ?? []).map(adaptMetricRow)
  }
  return {
    version: d.version ?? 'unknown',
    trainedAt: stamp(d.trained_at),
    trainSeconds: num(d.train_seconds),
    nTrain: num(d.n_train),
    nValid: num(d.n_valid),
    folds: num(d.folds) || 3,
    nFeatures: num(d.n_features),
    weights: d.weights ?? {},
    metrics,
    featureImportance: d.feature_importance ?? [],
  }
}

export function adaptMetrics(d: MetricsRespDTO): Metrics {
  const rolling: Record<string, RollingStat> = {}
  for (const [h, s] of Object.entries(d.rolling ?? {})) rolling[h] = adaptRolling(s)
  return {
    latest: adaptMetricsBundle(d.latest),
    history: (d.history ?? []).map((h) => ({
      version: h.version,
      trainedAt: stamp(h.trained_at),
      rmse3h: num(h.rmse_3h) as Meters,
      skill3h: num(h.skill_3h),
    })),
    rolling,
    rollingWindowH: num(d.rolling_window_h) || 6,
  }
}

export function adaptDecisionRow(d: DecisionRowDTO): {
  ts: SimTime
  siteId: string
  shouldForecast: boolean
  model: string | null
  correctionGain: number | null
  reason: string
  signals: Record<string, number>
} {
  return {
    ts: stamp(d.ts),
    siteId: d.site_id,
    shouldForecast: !!d.should_forecast,
    model: d.model,
    correctionGain: d.correction_gain,
    reason: d.reason ?? '',
    signals: d.signals ?? {},
  }
}

export function adaptEvalPair(d: EvalPairDTO): EvalPair {
  return {
    targetAt: stamp(d.target_at),
    siteId: d.site_id,
    horizonMin: num(d.horizon_min),
    model: d.model,
    yhat: num(d.yhat) as Meters,
    lower: num(d.lower) as Meters,
    upper: num(d.upper) as Meters,
    actual: d.actual != null ? (num(d.actual) as Meters) : null,
    originLevel: d.origin_level != null ? (num(d.origin_level) as Meters) : null,
    baseLevel: num(d.base_level) as Meters,
  }
}

export function adaptModelVersion(d: ModelVersionDTO): ModelVersion {
  return {
    version: d.version,
    trainedAt: d.trained_at != null ? stamp(d.trained_at) : null,
    active: !!d.active,
    rmse3h: d.rmse_3h != null ? (num(d.rmse_3h) as Meters) : null,
    skill3h: d.skill_3h,
    trainSeconds: d.train_seconds,
  }
}

// ---------------------------------------------------------------- 规则

export function adaptRules(d: RulesDocDTO): Rules {
  const dur = d.min_duration_min ?? {}
  const cut = d.score_cutoffs ?? {}
  return {
    weights: {
      peak: num(d.weights?.peak),
      duration: num(d.weights?.duration),
      trend: num(d.weights?.trend),
    },
    minDurationMin: {
      blue: num(dur.blue),
      yellow: num(dur.yellow),
      orange: num(dur.orange),
      red: num(dur.red),
    },
    durationSaturationMin: num(d.duration_saturation_min),
    scoreCutoffs: {
      blue: num(cut.blue),
      yellow: num(cut.yellow),
      orange: num(cut.orange),
      red: num(cut.red),
    },
    trendUpgradeSlope: num(d.trend_upgrade_slope) as Rate,
    trendDowngradeSlope: num(d.trend_downgrade_slope) as Rate,
    trendScoreSpan: num(d.trend_score_span),
    horizonMin: num(d.horizon_min),
    minLevelForAlarm: num(d.min_level_for_alarm),
  }
}

/** 领域规则 → 线上文档。只发后端认识的四个字段组，别把前端结构泄漏出去。 */
export function rulesToDto(r: Rules): Partial<RulesDocDTO> {
  return {
    weights: { ...r.weights },
    min_duration_min: { ...r.minDurationMin },
    duration_saturation_min: r.durationSaturationMin,
    score_cutoffs: { ...r.scoreCutoffs },
    trend_upgrade_slope: r.trendUpgradeSlope as number,
    trend_downgrade_slope: r.trendDowngradeSlope as number,
    trend_score_span: r.trendScoreSpan,
    horizon_min: r.horizonMin,
    min_level_for_alarm: r.minLevelForAlarm,
  }
}

export function adaptRuleImpact(d: RuleImpactDTO): RuleImpact {
  return {
    siteId: d.site_id,
    name: d.name,
    beforeLevel: asLevel(d.before_level),
    beforeScore: num(d.before_score),
    afterLevel: asLevel(d.after_level),
    afterScore: num(d.after_score),
    beforeReason: d.before_reason ?? '',
    afterReason: d.after_reason ?? '',
    direction: d.direction === 'up' || d.direction === 'down' ? d.direction : 'same',
  }
}

export function adaptRulesImpact(raw: {
  changes: RuleImpactDTO[]
  summary: { upgraded: number; downgraded: number; unchanged: number; total: number }
}): RulesImpact {
  return {
    changes: (raw.changes ?? []).map(adaptRuleImpact),
    summary: {
      upgraded: num(raw.summary?.upgraded),
      downgraded: num(raw.summary?.downgraded),
      unchanged: num(raw.summary?.unchanged),
      total: num(raw.summary?.total),
    },
  }
}

// ---------------------------------------------------------------- 序列与系统

export function adaptSeries(
  points: readonly SeriesPointDTO[],
  siteId: string,
  hours: number,
): SiteSeries {
  return {
    siteId,
    hours,
    points: points.map((p) => ({
      at: stamp(p.ts),
      level: num(p.level) as Meters,
      rain: num(p.rain) as RainRate,
    })),
  }
}

/**
 * 系统健康。缺 `engine_health` 时给 UNKNOWN_ENGINE 而不是抛错——
 * 引擎挂了恰恰是这个接口最该返回点东西的时候，此时抛错会让顶栏连"API 还活着"都显示不出来。
 */
export function adaptHealth(d: HealthRespDTO): SystemHealth {
  const e = d.engine_health
  return {
    apiOk: !!d.ok,
    service: d.service,
    engineOk: !!d.engine_ok,
    engine: e
      ? {
          modelVersion: e.model_version,
          cycles: e.cycles,
          pending: e.pending,
          uptimeS: e.uptime_s,
          lastTs: stamp(e.last_ts),
        }
      : UNKNOWN_ENGINE,
    clients: num(d.clients),
    now: stamp(d.ts),
  }
}

// ---------------------------------------------------------------- 账号 / 审计 / 推送

/**
 * 线上账号 → 领域 User。
 *
 * role 用一个显式的 isRole 收敛：后端理论上只发三种角色，但一旦哪天多发
 * 一种（或拼错），这里要变成 viewer 而不是让 ROLE_RANK[undefined] 变 NaN，
 * 更不是直接崩掉整个页面。
 */
export function adaptUser(d: UserDTO): User {
  const role = isRole(d.role) ? d.role : 'viewer'
  return {
    username: d.username,
    displayName: d.display_name || d.username,
    role,
    roleLabel: d.role_label || ROLE_LABEL[role],
    disabled: !!d.disabled,
    createdAt: d.created_at ? d.created_at : null,
    lastLoginAt: d.last_login_at ?? null,
  }
}

export function adaptAuditEntry(d: AuditEntryDTO): AuditEntry {
  return {
    id: d.id,
    at: d.at as SimTime,
    username: d.username || '—',
    role: d.role,
    method: d.method,
    path: d.path,
    status: d.status,
    durationMs: d.duration_ms,
    ip: d.ip || '—',
    summary: d.summary || `${d.method} ${d.path}`,
    requestId: d.request_id,
  }
}

export function adaptChannel(d: NotifyChannelDTO): NotifyChannel {
  return {
    name: d.name,
    enabled: !!d.enabled,
    endpoint: d.endpoint,
    secret: d.secret,
    minLevel: asLevel(d.min_level || 'orange'),
    debounceMin: d.debounce_min,
    updatedAt: d.updated_at ? (d.updated_at as SimTime) : null,
  }
}

export function adaptDelivery(d: DeliveryDTO): Delivery {
  return {
    id: d.id,
    at: d.at as SimTime,
    channel: d.channel,
    siteId: d.site_id,
    level: asLevel(d.level),
    ok: !!d.ok,
    detail: d.detail,
  }
}
