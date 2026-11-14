/**
 * 线上 JSON 契约（DTO）。**只有 adapters.ts 可以读这个文件。**
 *
 * 这一层刻意保持"丑"：字段名跟后端一致（snake_case）、
 * 所有数值都是裸 number、阈值是数组、quality 是 0/1。
 * 因为在网络边界上装干净是没有意义的——真正的规范化发生在 adapters。
 *
 * 区分 DTO 与领域模型的价值就在这个文件里：后端改字段名，
 * 只有 adapters 跟着改，页面和组件不受影响。
 */

export type LevelDTO = 'none' | 'blue' | 'yellow' | 'orange' | 'red'

export interface FactorsDTO {
  peak: number
  duration: number
  trend: number
  score: number
}

export interface HorizonDTO {
  horizon_min: number
  level: number
  lower: number
  upper: number
  delta: number
  delta_raw: number
  corrected: number
  gain: number
  sigma: number
  model: string
  reason: string
}

export interface WarningDTO {
  site_id: string
  level: LevelDTO
  score: number
  peak_value: number
  peak_level: LevelDTO
  peak_at_min: number | null
  duration_min: number
  slope_mh: number
  reason: string
  blocked_by: string | null
  factors: FactorsDTO
  thresholds: number[]
  horizon_min: number
}

export interface DecisionDTO {
  should_forecast: boolean
  model: string
  gain: number
  reason: string
  signals: Record<string, number>
}

export type CurvePointDTO = [number, number, number, number]

export interface SiteForecastDTO {
  site_id: string
  now_level: number
  horizons: HorizonDTO[]
  curve: CurvePointDTO[]
  warning: WarningDTO
  decision: DecisionDTO
}

export interface ForecastPayloadDTO {
  issued_at: number
  model_version: string
  step_min: number
  sites: Record<string, SiteForecastDTO>
}

/** 一张图的一行。注意 `level` 是米、`warn_level` 是档位、`thresholds` 是数组。 */
export interface OverviewSiteDTO {
  site_id: string
  name: string
  district: string
  lon: number
  lat: number
  base_level: number
  thresholds: number[]
  kind: string
  level: number
  depth: number
  rain: number
  quality: number
  trend_1h: number
  warn_level: LevelDTO
  warn_score: number
  /** 三因子分解。只给一个综合分，值班员看不出"是峰值高还是持续久"。 */
  factors: FactorsDTO
  peak_level: LevelDTO
  horizon_min: number
  peak_value: number
  peak_at_min: number | null
  duration_min: number
  slope_mh: number
  reason: string
  spark: number[]
  updated_at: number
  /** 条款 8-4 实测越限判定。后端没给时为 undefined（界面据此隐藏整块）。 */
  observed?: ObservedDTO
  /** observed | forecast | both | none —— 本次告警由哪一侧触发。 */
  alarm_source?: string
}

/** 实测越限判定：回答"现在是不是已经淹了"，与预测研判语义正交。 */
export interface ObservedDTO {
  level: LevelDTO
  score: number
  reason: string
  over_min: number
  thr_name: LevelDTO
  window_min: number
  peak_value: number
}

export interface OverviewRespDTO {
  sites: OverviewSiteDTO[]
  issued_at: number
}

export interface SeriesPointDTO {
  ts: number
  level: number
  rain: number
}

export interface SiteMetaDTO {
  site_id: string
  name: string
  district: string
  lon: number
  lat: number
  base_level: number
  thresholds: number[]
  kind: string
  catchment_ha?: number
  pond_ha?: number
  impervious?: number
  drainage_mm_h?: number
}

export interface TelemetryDTO {
  ts: number
  site_id: string
  level: number
  rain: number
  quality: number
  rain_fc_1h: number
  rain_fc_3h: number
}

export interface SiteDetailRespDTO {
  site: SiteMetaDTO
  history: SeriesPointDTO[]
  latest?: TelemetryDTO
  forecast?: SiteForecastDTO
  issued_at?: number
  model_version?: string
}

// ---------------------------------------------------------------- 预警事件

export type WarnStateDTO =
  | 'ACTIVE_UNACK'
  | 'ACTIVE_ACK'
  | 'CLEARED_UNACK'
  | 'CLEARED_ACK'

export type DispositionDTO = 'open' | 'dispatched' | 'onsite' | 'resolved' | 'false_alarm'

export interface WarningEventDTO {
  id: number
  site_id: string
  site_name: string
  level: LevelDTO
  score: number
  peak_value: number
  peak_at_min: number | null
  duration_min: number
  slope_mh: number
  reason: string
  state: WarnStateDTO
  /** 处置轴（新增）。阅读轴 state 与处置轴 disposition 是两件独立的事。 */
  disposition: DispositionDTO
  assignee: string | null
  note_count: number
  raised_at: number
  acked_at: number | null
  cleared_at: number | null
  updated_at: number
}

export interface AlertNoteDTO {
  id: number
  event_id: number
  author: string
  kind: string
  text: string
  created_at: number
}

export interface AlertDetailRespDTO {
  event: WarningEventDTO
  notes: AlertNoteDTO[]
}

// ---------------------------------------------------------------- 模型评估

export interface RollingStatDTO {
  n: number
  rmse: number
  mae: number
  bias: number
  p95_abs: number
  baseline_rmse: number
  skill: number
}

export interface MetricRowDTO {
  horizon_min: number
  rmse: number
  mae: number
  mape: number
  nse: number
  skill_vs_persistence: number
  crps: number
  picp90: number
  pinaw: number
  n: number
  event_n: number
  event_rmse: number
  event_skill: number
}

export interface MetricsBundleDTO {
  version: string
  trained_at: number
  train_seconds: number
  n_train: number
  n_valid: number
  folds: number
  n_features: number
  weights: Record<string, Record<string, number>>
  metrics: Record<string, MetricRowDTO[]>
  feature_importance: { name: string; importance: number }[]
}

export interface MetricsHistoryItemDTO {
  version: string
  trained_at: number
  rmse_3h: number
  skill_3h: number
}

export interface MetricsRespDTO {
  latest: MetricsBundleDTO
  history: MetricsHistoryItemDTO[]
  rolling: Record<string, RollingStatDTO>
  rolling_window_h: number
}

export interface DecisionRowDTO {
  ts: number
  site_id: string
  should_forecast: boolean
  model: string | null
  correction_gain: number | null
  reason: string
  signals: Record<string, number>
}

export interface EvalPairDTO {
  target_at: number
  site_id: string
  horizon_min: number
  model: string
  yhat: number
  lower: number
  upper: number
  actual: number | null
  origin_level: number | null
  base_level: number
}

export interface EvalRespDTO {
  pairs: EvalPairDTO[]
}

/** 模型版本治理：列出版本、采纳、回滚。 */
export interface ModelVersionDTO {
  version: string
  trained_at: number | null
  active: boolean
  rmse_3h: number | null
  skill_3h: number | null
  train_seconds: number | null
}

export interface ModelVersionsRespDTO {
  versions: ModelVersionDTO[]
  active: string
}

// ---------------------------------------------------------------- 规则

export interface RulesDocDTO {
  weights: { peak: number; duration: number; trend: number }
  min_duration_min: Record<string, number>
  duration_saturation_min: number
  score_cutoffs: Record<string, number>
  trend_upgrade_slope: number
  trend_downgrade_slope: number
  trend_score_span: number
  horizon_min: number
  min_level_for_alarm: number
  [k: string]: unknown
}

/** 规则影响预演：候选规则落到当前这一轮预测上会改变什么。 */
export interface RuleImpactDTO {
  site_id: string
  name: string
  before_level: LevelDTO
  before_score: number
  after_level: LevelDTO
  after_score: number
  before_reason: string
  after_reason: string
  direction: 'up' | 'down' | 'same'
}

export interface RulePreviewRespDTO {
  changes: RuleImpactDTO[]
  summary: { upgraded: number; downgraded: number; unchanged: number; total: number }
}

export interface RetrainStatusDTO {
  status: 'idle' | 'running' | 'done' | 'failed'
  started_at?: number
  version?: string
  seconds?: number
  error?: string
}

export interface HealthRespDTO {
  ok: boolean
  service: string
  ts: number
  clients: number
  engine: string
  engine_ok?: boolean
  engine_health?: {
    ok: boolean
    model_version: string
    cycles: number
    pending: number
    uptime_s: number
    last_ts: number
  }
}

// ---------------------------------------------------------------- 账号 / 审计 / 推送

/** 线上账号形状。pwd_hash 永远不出现在响应里，所以这里也没有。 */
export interface UserDTO {
  username: string
  display_name: string
  role: string
  role_label: string
  disabled: boolean
  created_at: number
  last_login_at: number | null
}

export interface UsersRespDTO {
  users: UserDTO[]
  roles: { value: string; label: string }[]
}

export interface LoginRespDTO {
  ok: boolean
  user: UserDTO
  expires_in: number
}

export interface MeRespDTO {
  user: {
    username: string
    display_name: string
    role: string
    role_label: string
  }
}

export interface AuditEntryDTO {
  id: number
  at: number
  username: string
  role: string
  method: string
  path: string
  status: number
  duration_ms: number
  ip: string
  summary: string
  request_id: string
}

export interface AuditRespDTO {
  entries: AuditEntryDTO[]
  hours: number
}

export interface NotifyChannelDTO {
  name: string
  enabled: boolean
  endpoint: string
  /** 后端已打码（ab****yz）。回传打码串表示「不改」。 */
  secret: string
  min_level: string
  debounce_min: number
  updated_at: number
}

export interface ChannelsRespDTO {
  channels: NotifyChannelDTO[]
  levels: string[]
}

export interface DeliveryDTO {
  id: number
  at: number
  channel: string
  site_id: string
  level: string
  ok: boolean
  detail: string
}

export interface DeliveriesRespDTO {
  deliveries: DeliveryDTO[]
}
