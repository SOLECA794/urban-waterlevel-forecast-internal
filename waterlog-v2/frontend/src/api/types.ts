// 领域类型：与后端 v2 契约一一对应。

// ---------- 设备画像 ----------
export interface DeviceProfile {
  id: number
  name: string
  category: string
  telemetryKeys: string[]
  description: string
  createdAt: number
  updatedAt: number
}

// ---------- 设备 ----------
export type DeviceStatus = 'online' | 'stale' | 'offline'

export interface Device {
  id: number
  profileId: number
  name: string
  code: string
  lat: number
  lon: number
  address: string
  status: DeviceStatus
  enabled: boolean
  lastSeenAt: number | null
  createdAt: number
  updatedAt: number
  profileName: string
}

// ---------- 遥测 ----------
export interface TelemetryPoint {
  id: number
  deviceId: number
  metric: string
  ts: number
  value: number
  quality: string
}

export interface SeriesResp {
  deviceId: number
  metric: string
  from: number
  to: number
  points: TelemetryPoint[]
}

export interface ForecastPoint {
  ts: number
  value: number
  lower: number
  upper: number
}

export interface ForecastResult {
  deviceId: number
  metric: string
  modelName: string
  modelVersion: string
  generatedAt: number
  horizonMin: number
  points: ForecastPoint[]
  note: string
}

// ---------- 规则 ----------
export type RuleOp = 'gt' | 'gte' | 'lt' | 'lte'
export type LevelKey = 'blue' | 'yellow' | 'orange' | 'red'

export interface RuleNode {
  id: number
  chainId: number
  name: string
  deviceProfileId: number | null
  metric: string
  op: RuleOp
  threshold: number
  durationSec: number
  levelKey: LevelKey
  levelRank: number
  severity: string
  actions: string[]
  priority: number
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface RuleChain {
  id: number
  name: string
  description: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  nodes: RuleNode[]
}

// ---------- 告警四态 ----------
export type AlarmStatus = 'ACTIVE_UNACK' | 'ACTIVE_ACK' | 'CLEARED_UNACK' | 'CLEARED_ACK'
export type ClearReason = 'auto' | 'manual' | 'false_report'

export interface Alarm {
  id: number
  deviceId: number
  ruleNodeId: number | null
  levelKey: LevelKey
  levelRank: number
  severity: string
  status: AlarmStatus
  startTs: number
  ackTs: number | null
  ackBy: string | null
  clearTs: number | null
  clearedBy: string | null
  clearReason: ClearReason | null
  triggerValue: number | null
  currentValue: number | null
  message: string
  updatedAt: number
  deviceName: string
  deviceCode: string
}

export interface AlarmPage {
  items: Alarm[]
  total: number
  page: number
  pageSize: number
}

export interface AlarmStats {
  activeTotal: number
  unackTotal: number
  todayTotal: number
  byLevel: Record<string, number>
  byStatus: Record<string, number>
  maxActiveLevel: LevelKey | null
}

// ---------- 大屏 ----------
export interface WidgetLayout {
  key: string
  x: number
  y: number
  w: number
  h: number
}

export interface WidgetDef {
  key: string
  type: 'kpi' | 'line' | 'alarm-list' | 'gauge' | 'map'
  title: string
  deviceId?: number
  metric?: string
  deviceIds?: number[]
}

export interface Dashboard {
  id: number
  name: string
  isDefault: boolean
  layout: WidgetLayout[]
  widgets: WidgetDef[]
  updatedAt: number
}

// ---------- 系统 ----------
export interface SystemStatus {
  app: string
  version: string
  demoMode: boolean
  uptimeSec: number
  serverTs: number
  subscribers: number
  raining: boolean
  rainPower: number
}

// ---------- 预警等级视图（阈值由规则推导） ----------
export interface AlertLevel {
  rank: number
  levelKey: LevelKey
  name: string
  color: string
  waterLevelThreshold: number
}
