// UI 层类型 - 数据模型全部对齐后端契约（见 src/api/types.ts），此处仅保留 UI 派生类型
export type {
  AlertEvent, AlertLevel, AlertStats, AlertStatus, AlertBrief, CalibrateResult, Calibration,
  ComparisonMetrics, Datasource, DatasourceQuality, ForecastComparison, ForecastDecision,
  ForecastLead, ForecastPoint, ForecastRevision, FusionWeights, HealthDetail, ModelItem,
  PageDTO, PublishChannel, PublishHistoryItem, SeriesData, SeriesPoint, SimEvent, Station,
  StationAlertStats, SystemStatus, ActualPoint, SsePayload,
} from '@/api/types'

// ==================== Agent 嵌入式卡片（UI 派生类型，内容由真实数据生成） ====================
export interface AgentCardMetric {
  label: string
  value: string
  trend?: 'up' | 'down' | 'stable'
}

export interface AgentCard {
  id: string
  position: string          // 嵌入式点位标识
  title: string
  conclusion: string        // 结论
  metrics: AgentCardMetric[]
  factors: string[]
  suggestion: string
  generatedAt: string
}
