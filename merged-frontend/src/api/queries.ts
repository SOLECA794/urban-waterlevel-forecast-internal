// React Query hooks - 全部数据获取/变更入口（替代 mock 数据层）
import { useEffect, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as ep from './endpoints'
import { API_BASE } from './client'
import type {
  AlertEvent, AlertLevel, AnalysisReportPage, CalibrateResult, Calibration, Datasource,
  ForecastAttribution, ForecastComparison,
  ForecastLead, ForecastRevision, GenerateReportReq, ModelItem, PublishChannel, SeriesData,
  Station, SystemStatus,
} from './types'

// ---------- Query Keys ----------
export const qk = {
  systemStatus: ['systemStatus'] as const,
  health: ['health'] as const,
  healthDetail: ['healthDetail'] as const,
  levels: ['levels'] as const,
  leads: ['leads'] as const,
  channels: ['channels'] as const,
  stations: ['stations'] as const,
  station: (id: number) => ['station', id] as const,
  series: (id: number, hours: number) => ['series', id, hours] as const,
  forecasts: (id: number) => ['forecasts', id] as const,
  comparison: (forecastId: number) => ['comparison', forecastId] as const,
  attribution: (forecastId: number) => ['attribution', forecastId] as const,
  analysisReports: (stationId: number) => ['analysisReports', stationId] as const,
  alerts: (params: ep.AlertListParams) => ['alerts', params] as const,
  alertStats: ['alertStats'] as const,
  datasources: ['datasources'] as const,
  calibrations: (page: number) => ['calibrations', page] as const,
  models: ['models'] as const,
}

// ---------- 查询 Hooks ----------
export const useSystemStatus = () =>
  useQuery<SystemStatus>({ queryKey: qk.systemStatus, queryFn: ep.getSystemStatus, refetchInterval: 60_000 })

export const useHealth = () =>
  useQuery({ queryKey: qk.health, queryFn: ep.getHealth, refetchInterval: 60_000 })

export const useLevels = () =>
  useQuery<AlertLevel[]>({ queryKey: qk.levels, queryFn: ep.getAlertLevels })

export const useLeads = () =>
  useQuery<ForecastLead[]>({ queryKey: qk.leads, queryFn: ep.getLeads })

export const useChannels = () =>
  useQuery<PublishChannel[]>({ queryKey: qk.channels, queryFn: ep.getChannels })

export const useStations = () =>
  useQuery<Station[]>({ queryKey: qk.stations, queryFn: ep.listStations, refetchInterval: 60_000 })

export const useStationSeries = (stationId: number | null, hours = 24) =>
  useQuery<SeriesData>({
    queryKey: qk.series(stationId ?? 0, hours),
    queryFn: () => ep.getStationSeries(stationId!, hours),
    enabled: stationId !== null,
  })

export const useStationForecasts = (stationId: number | null) =>
  useQuery<ForecastRevision[]>({
    queryKey: qk.forecasts(stationId ?? 0),
    queryFn: () => ep.getStationForecasts(stationId!),
    enabled: stationId !== null,
  })

export const useForecastComparison = (forecastId: number | null) =>
  useQuery<ForecastComparison>({
    queryKey: qk.comparison(forecastId ?? 0),
    queryFn: () => ep.getForecastComparison(forecastId!),
    enabled: forecastId !== null,
  })

// ---------- P1 AI 能力 ----------
// 归因查询：默认关闭，由页面在选中具体预测版本后启用
export const useForecastAttribution = (forecastId: number | null) =>
  useQuery<ForecastAttribution>({
    queryKey: qk.attribution(forecastId ?? 0),
    queryFn: () => ep.getForecastAttribution(forecastId!),
    enabled: forecastId !== null,
    retry: false,
  })

// 研判报告列表（按站点）
export const useAnalysisReports = (stationId: number | null, pageSize = 5) =>
  useQuery<AnalysisReportPage>({
    queryKey: qk.analysisReports(stationId ?? 0),
    queryFn: () => ep.listAnalysisReports(stationId ?? undefined, 1, pageSize),
    enabled: stationId !== null,
    retry: false,
  })

// 生成研判报告（变更）
export const useGenerateAnalysisReport = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (req: GenerateReportReq) => ep.generateAnalysisReport(req),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: qk.analysisReports(res.stationId) })
    },
  })
}

export const useAlerts = (params: ep.AlertListParams = {}) =>
  useQuery({ queryKey: qk.alerts(params), queryFn: () => ep.listAlerts(params) })

export const useAlertStats = () =>
  useQuery({ queryKey: qk.alertStats, queryFn: ep.getAlertStats, refetchInterval: 60_000 })

export const useDatasources = () =>
  useQuery<Datasource[]>({ queryKey: qk.datasources, queryFn: ep.listDatasources, refetchInterval: 60_000 })

export const useCalibrations = (page = 1, pageSize = 20) =>
  useQuery({ queryKey: qk.calibrations(page), queryFn: () => ep.listCalibrations(page, pageSize) })

export const useModels = () =>
  useQuery<ModelItem[]>({ queryKey: qk.models, queryFn: ep.listModels })

// ---------- 变更 Hooks ----------
const useInvalidate = () => {
  const qc = useQueryClient()
  return (keys: readonly (readonly unknown[])[]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: k }))
}

export const useConfirmAlert = () => {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: number) => ep.confirmAlert(id),
    onSuccess: () => invalidate([qk.alerts({}), qk.alertStats, qk.stations, qk.systemStatus]),
  })
}
// 注意：alerts 查询带参数时 queryKey 含参数，用前缀失效更稳
const useInvalidateAlerts = () => {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ['alerts'] })
    qc.invalidateQueries({ queryKey: qk.alertStats })
    qc.invalidateQueries({ queryKey: qk.stations })
    qc.invalidateQueries({ queryKey: qk.systemStatus })
  }
}

export const useResolveAlert = () => {
  const inv = useInvalidateAlerts()
  return useMutation({ mutationFn: (id: number) => ep.resolveAlert(id), onSuccess: inv })
}

export const useFalseReportAlert = () => {
  const inv = useInvalidateAlerts()
  return useMutation({
    mutationFn: (p: { id: number; reason: string }) => ep.falseReportAlert(p.id, p.reason),
    onSuccess: inv,
  })
}

export const usePublishAlert = () => {
  const inv = useInvalidateAlerts()
  return useMutation({
    mutationFn: (p: { id: number; channels: string[]; operator?: string }) =>
      ep.publishAlert(p.id, p.channels, p.operator || 'operator'),
    onSuccess: inv,
  })
}

export const usePredictStation = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { stationId: number; leadHours: number }) => ep.predictStation(p.stationId, p.leadHours),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['forecasts', v.stationId] })
      qc.invalidateQueries({ queryKey: ['alerts'] })
      qc.invalidateQueries({ queryKey: qk.stations })
      qc.invalidateQueries({ queryKey: qk.alertStats })
    },
  })
}

export const useUpdateDatasource = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { id: number; body: { enabled?: boolean; endpoint?: string; refreshIntervalSec?: number } }) =>
      ep.updateDatasource(p.id, p.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.datasources }),
  })
}

export const usePutLevels = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (levels: AlertLevel[]) => ep.putAlertLevels(levels),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.levels })
      qc.invalidateQueries({ queryKey: qk.stations })
    },
  })
}

export const usePutLeads = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (leads: ForecastLead[]) => ep.putLeads(leads),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.leads }),
  })
}

export const usePutChannels = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (channels: PublishChannel[]) => ep.putChannels(channels),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.channels }),
  })
}

export const useActivateModel = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => ep.activateModel(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.models })
      qc.invalidateQueries({ queryKey: qk.systemStatus })
    },
  })
}

export const useCalibrateParams = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { modelId: number; stationId: number; hours: number }) => ep.calibrateParams(p),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calibrations'] })
      qc.invalidateQueries({ queryKey: qk.models })
    },
  })
}

export const useCreateRetrain = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { stationId?: number; baseModelId?: number }) =>
      ep.createCalibration({ type: 'retrain', ...p }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['calibrations'] }),
  })
}

export const useInjectSimEvent = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { stationId: number; intensity: 'light' | 'moderate' | 'heavy' | 'extreme' }) =>
      ep.injectSimEvent(p.stationId, p.intensity),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.stations })
      qc.invalidateQueries({ queryKey: ['alerts'] })
    },
  })
}

// ---------- SSE 实时预警流 ----------
// 后端事件 → 失效相关查询，页面自动刷新
export function useAlertStream() {
  const qc = useQueryClient()
  useEffect(() => {
    const base = API_BASE.startsWith('http')
      ? API_BASE
      : `${window.location.origin}${API_BASE}`
    const es = new EventSource(`${base}/stream/alerts`)
    const onAlert = () => {
      qc.invalidateQueries({ queryKey: ['alerts'] })
      qc.invalidateQueries({ queryKey: qk.alertStats })
      qc.invalidateQueries({ queryKey: qk.stations })
      qc.invalidateQueries({ queryKey: qk.systemStatus })
    }
    es.addEventListener('alert', onAlert)
    es.onerror = () => { /* 断线由 EventSource 自动重连 */ }
    return () => es.close()
  }, [qc])
}

// ---------- 派生数据 ----------
// 等级表（按 rank 升序）
export function useSortedLevels(): AlertLevel[] {
  const { data } = useLevels()
  return useMemo(
    () => (data ? [...data].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)) : []),
    [data],
  )
}

// 已启用的预见期列表（升序）
export function useEnabledLeads(): ForecastLead[] {
  const { data } = useLeads()
  return useMemo(
    () => (data ? data.filter((l) => l.enabled).sort((a, b) => a.lead - b.lead) : []),
    [data],
  )
}
