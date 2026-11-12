// API 类型定义 - 与后端契约 v1（internal/httpapi/dto.go）逐字段对齐
// 注意：stationId / alertId / forecastId / modelId / datasourceId 均为 int64 数字主键

// ==================== 预警等级 ====================
export interface AlertLevel {
  rank: number | null
  name: string
  levelKey: string
  color: string
  waterLevelThreshold: number
  durationThreshold: number
  description: string | null
  enabled: boolean
}

// ==================== 预见期 ====================
export interface ForecastLead {
  lead: number
  enabled: boolean
  defaultWeight: number
  isReserved: boolean
}

// ==================== 发布渠道 ====================
export interface PublishChannel {
  id: number
  type: string
  name: string
  enabled: boolean
  endpoint: string | null
  template: string | null
}

// ==================== 监测点 ====================
export interface StationAlertStats {
  total: number
  byLevel: Record<string, number>
  reference: number
  active: number
}

export interface Station {
  stationId: number
  stationCode: string
  stationName: string
  location: string | null
  kind: string | null
  enabled: boolean
  longitude: number | null
  latitude: number | null
  currentLevel: number | null
  currentTs: string | null
  trend: string
  dataAgeMin: number | null
  alertLevel: number | null       // 当前预警等级 rank（null = 无预警）
  alertLevelName: string | null
  alertLevelColor: string | null
  alertId: number | null
  alertReason: string | null
  isReference: boolean
  leadMinutesAdvantage: number | null
  thresholds: Record<string, number>  // levelKey -> 水位阈值
  baseLevel: number | null
  responseK: number | null
  alertStats?: StationAlertStats
}

// ==================== 时序 ====================
export interface SeriesPoint {
  ts: string
  level: number | null
  rainObserved: number
}

export interface SeriesData {
  stationId: number
  stationCode: string
  stepMinutes: number
  thresholds: Record<string, number>
  points: SeriesPoint[]
}

// ==================== 预测 ====================
export interface ForecastPoint {
  time: string
  waterLevel: number
  confidenceLow: number
  confidenceHigh: number
  levelRaw: number
  revision: number
}

export interface FusionWeights {
  level: number
  rain: number
  fcst: number
}

export interface ForecastDecision {
  selectedModel: string
  fusionWeights: FusionWeights
  revisionAlpha: number
  ciScale: number
  degraded: boolean
  reason: string
}

export interface AlertBrief {
  alertId: number
  level: number
  levelKey: string
  reason: string | null
  isReference: boolean
  leadMinutesAdvantage: number | null
  status: string
}

export interface ForecastRevision {
  id: string                 // 展示用版本号 R-YYYYMMDD-NNNNNN
  stationId: number
  stationCode: string
  lead: number               // 预见期（小时）
  generatedAt: string
  modelVersion: string
  points: ForecastPoint[]
  triggeredAlertLevel: number | null
  remarks: string | null
  forecastId: number         // 数字主键（版本对比/决策接口用）
  predictTime: string
  peakLevel: number
  peakTime: string
  confidenceInterval: { lower: number; upper: number }
  degraded: boolean
  rmse: number | null
  mae: number | null
  decision?: ForecastDecision
  alert?: AlertBrief
}

export interface ActualPoint {
  time: string
  level: number | null
}

export interface ComparisonMetrics {
  mae: number
  rmse: number
  hitRate: number
  sampleCount: number
}

export interface ForecastComparison {
  forecast: ForecastRevision
  actual: ActualPoint[]
  metrics: ComparisonMetrics
}

// ==================== 预警事件 ====================
export type AlertStatus = 'active' | 'confirmed' | 'published' | 'resolved' | 'false_report'

export interface PublishHistoryItem {
  recordId: string
  channel: string
  channelCode: string
  status: string
  detail: string
  publishTime: string
}

export interface AlertEvent {
  alertId: number
  stationId: number
  stationCode: string
  stationName: string
  forecastId: number | null
  level: number              // rank
  levelKey: string
  levelName: string
  levelColor: string
  reason: string | null
  reasoning: string[]
  publishHistory: PublishHistoryItem[]
  lead: number | null        // 提前量（分钟）
  isReference: boolean
  peakLevel: number | null
  peakTime: string | null
  leadHours: number | null
  alertTime: string
  resolveTime: string | null
  status: AlertStatus
  durationMin: number | null
  trend: number | null       // 斜率（m/min）
  falseReportReason: string | null
}

export interface AlertStats {
  todayTotal: number
  effectiveTotal: number
  referenceTotal: number
  activeTotal: number
  byLevel: Record<string, number>
  maxEffectiveLevel: string | null
}

// ==================== 分页 ====================
export interface PageDTO<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

// ==================== 数据源 ====================
export interface DatasourceQuality {
  successRate: number | null
  missingRate: number | null
  avgLatency: number | null
}

export interface Datasource {
  id: number
  type: string
  name: string
  status: string
  endpoint: string | null
  refreshIntervalSec: number
  quality: DatasourceQuality
  schema: unknown[]
  enabled: boolean
  lastError: string | null
}

// ==================== 校准 ====================
export interface Calibration {
  id: number
  type: string
  target: string | null
  before: unknown
  after: unknown
  preview: unknown
  status: string
  executedBy: string | null
  note: string | null
  createdAt: string
}

export interface CalibrateResult {
  modelId: number
  stationId: number
  method: string
  paramsBefore: Record<string, number>
  paramsAfter: Record<string, number>
  rmseBefore: number
  rmseAfter: number
  maeBefore: number
  maeAfter: number
  improvedPct: number
}

// ==================== 模型 ====================
export interface ModelItem {
  modelId: number
  modelName: string
  version: string
  modelType: string
  active: boolean
  rmse: number | null
  mae: number | null
  modelFile: string
  algorithmConfig: unknown
  activatable: boolean
}

// ==================== 系统状态 ====================
export interface SystemStatus {
  modelName: string
  modelType: string
  version: string
  activeModelId: number | null
  forecastIntervalMinutes: number
  leadHours: number
  stepMinutes: number
  serverTime: string
  demoMode: boolean
  openMeteoEnabled: boolean
  stationCount: number
}

// ==================== 健康 ====================
export interface HealthDetail {
  status: string
  time: string
  datasource: Record<string, unknown>
  model: Record<string, unknown>
  database: Record<string, unknown>
  scheduler: Record<string, unknown>
}

// ==================== 模拟事件（演示注入暴雨） ====================
export interface SimEvent {
  eventId: string
  stationId: number
  intensity: string
  intensityLabel: string | null
  peakMmPerStep: number | null
  durationMinutes: number | null
  startTs: string
  endTs: string
  injectedAt: string
}

// ==================== SSE 事件包 ====================
export interface SsePayload {
  event: string
  data: AlertEvent
}
