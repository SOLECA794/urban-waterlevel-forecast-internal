// API 端点封装 - 按契约 v1 全量 31 端点
import { api } from './client'
import type {
  AlertEvent, AlertLevel, AlertStats, AnalysisReport, AnalysisReportPage,
  CalibrateResult, Calibration, ComparisonMetrics,
  Datasource, ForecastAttribution, ForecastComparison, ForecastLead, ForecastRevision,
  GenerateReportReq, HealthDetail,
  ModelItem, PageDTO, PublishChannel, SeriesData, SimEvent, Station, SystemStatus,
} from './types'

// ---------- 系统 ----------
export const getSystemStatus = () => api.get<SystemStatus>('/system/status')
export const getHealth = () => api.get<{ status: string; time: string }>('/health')
export const getHealthDetail = () => api.get<HealthDetail>('/health/detail')

// ---------- 预警等级 / 预见期 / 渠道 ----------
export const getAlertLevels = () => api.get<AlertLevel[]>('/alert-levels')
export const putAlertLevels = (levels: AlertLevel[]) =>
  api.put<AlertLevel[]>('/alert-levels', levels)

export const getLeads = () => api.get<ForecastLead[]>('/forecast/leads')
export const putLeads = (leads: ForecastLead[]) =>
  api.put<ForecastLead[]>('/forecast/leads', leads)

export const getChannels = () => api.get<PublishChannel[]>('/publish-channels')
export const putChannels = (channels: PublishChannel[]) =>
  api.put<PublishChannel[]>('/publish-channels', channels)

// ---------- 监测点 ----------
export const listStations = () => api.get<Station[]>('/stations')
export const getStation = (id: number) => api.get<Station>(`/stations/${id}`)
export const getStationSeries = (id: number, hours = 24) =>
  api.get<SeriesData>(`/stations/${id}/series?hours=${hours}`)
export const getStationForecasts = (id: number, lead?: number, limit = 20) => {
  const q = new URLSearchParams({ limit: String(limit) })
  if (lead !== undefined) q.set('lead', String(lead))
  return api.get<ForecastRevision[]>(`/stations/${id}/forecasts?${q.toString()}`)
}
export const predictStation = (id: number, leadHours: number) =>
  api.post<ForecastRevision>(`/stations/${id}/predict`, { leadHours })

// ---------- 预测对比 / 决策 ----------
export const getForecastComparison = (forecastId: number) =>
  api.get<ForecastComparison>(`/forecasts/${forecastId}/comparison`)
export const getForecastDecision = (forecastId: number) =>
  api.get<Record<string, unknown>>(`/forecasts/${forecastId}/decision`)

// ---------- P1 AI 能力：预测归因 ----------
export const getForecastAttribution = (forecastId: number, pointIndex?: number) => {
  const q = pointIndex !== undefined ? `?pointIndex=${pointIndex}` : ''
  return api.get<ForecastAttribution>(`/forecasts/${forecastId}/attribution${q}`)
}

// ---------- P1 AI 能力：智能研判助手 ----------
export const generateAnalysisReport = (body: GenerateReportReq) =>
  api.post<AnalysisReport>('/analysis/report', body)
export const listAnalysisReports = (stationId?: number, page = 1, pageSize = 10) => {
  const q = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
  if (stationId !== undefined) q.set('stationId', String(stationId))
  return api.get<AnalysisReportPage>(`/analysis/reports?${q.toString()}`)
}
export const getAnalysisReport = (reportId: number) =>
  api.get<AnalysisReport>(`/analysis/reports/${reportId}`)

// ---------- 预警 ----------
export interface AlertListParams {
  page?: number
  pageSize?: number
  status?: string
  level?: string      // levelKey
  stationId?: number
}
export const listAlerts = (params: AlertListParams = {}) => {
  const q = new URLSearchParams()
  if (params.page) q.set('page', String(params.page))
  if (params.pageSize) q.set('pageSize', String(params.pageSize))
  if (params.status) q.set('status', params.status)
  if (params.level) q.set('level', params.level)
  if (params.stationId) q.set('stationId', String(params.stationId))
  const qs = q.toString()
  return api.get<PageDTO<AlertEvent>>(`/alerts${qs ? `?${qs}` : ''}`)
}
export const getAlertStats = () => api.get<AlertStats>('/alerts/stats')
export const confirmAlert = (id: number) => api.post<AlertEvent>(`/alerts/${id}/confirm`)
export const resolveAlert = (id: number) => api.post<AlertEvent>(`/alerts/${id}/resolve`)
export const falseReportAlert = (id: number, falseReportReason: string) =>
  api.post<AlertEvent>(`/alerts/${id}/false-report`, { falseReportReason })
export const publishAlert = (id: number, channels: string[], operator = 'operator') =>
  api.post<AlertEvent>(`/alerts/${id}/publish`, { channels, operator })
export const listPublishRecords = (alertId?: number, page = 1, pageSize = 20) => {
  const q = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
  if (alertId !== undefined) q.set('alertId', String(alertId))
  return api.get<PageDTO<Record<string, unknown>>>(`/alerts/publish-records?${q.toString()}`)
}

// ---------- 数据源 ----------
export const listDatasources = () => api.get<Datasource[]>('/datasources')
export const updateDatasource = (id: number, body: { enabled?: boolean; endpoint?: string; refreshIntervalSec?: number }) =>
  api.put<Datasource>(`/datasources/${id}`, body)

// ---------- 校准 / 模型 ----------
export const listCalibrations = (page = 1, pageSize = 20) =>
  api.get<PageDTO<Calibration>>(`/calibrations?page=${page}&pageSize=${pageSize}`)
export const createCalibration = (body: { type: string; stationId?: number; baseModelId?: number }) =>
  api.post<unknown>('/calibrations', body)
export const listModels = () => api.get<ModelItem[]>('/models')
export const activateModel = (id: number) => api.post<ModelItem>(`/models/${id}/activate`)
export const calibrateParams = (body: { modelId: number; stationId: number; hours: number }) =>
  api.post<CalibrateResult>('/calibrate-params', body)

// ---------- 模拟事件（演示） ----------
export const injectSimEvent = (stationId: number, intensity: 'light' | 'moderate' | 'heavy' | 'extreme') =>
  api.post<SimEvent>('/sim/events', { stationId, intensity })
export const listSimEvents = () => api.get<SimEvent[]>('/sim/events')

// re-export 供页面使用
export type { ComparisonMetrics }
