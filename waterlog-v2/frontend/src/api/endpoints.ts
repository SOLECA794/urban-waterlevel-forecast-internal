// API 端点（v2 契约）
import { api } from './client'
import type {
  Alarm, AlarmPage, AlarmStats, AlertLevel, Dashboard, Device, DeviceProfile,
  ForecastResult, RuleChain, RuleNode, SeriesResp, SystemStatus,
} from './types'

// ---------- 系统 ----------
export const getSystemStatus = () => api.get<SystemStatus>('/system/status')
export const injectRain = (power: number, durationSec = 180) =>
  api.post<{ raining: boolean; power: number }>('/sim/rain', { power, durationSec })

// ---------- 设备画像 ----------
export const listProfiles = () => api.get<DeviceProfile[]>('/device-profiles')
export const createProfile = (p: Partial<DeviceProfile>) => api.post<DeviceProfile>('/device-profiles', p)
export const updateProfile = (id: number, p: Partial<DeviceProfile>) =>
  api.put<DeviceProfile>(`/device-profiles/${id}`, p)
export const deleteProfile = (id: number) => api.del<{ deleted: number }>(`/device-profiles/${id}`)

// ---------- 设备 ----------
export const listDevices = () => api.get<Device[]>('/devices')
export const getDevice = (id: number) => api.get<Device>(`/devices/${id}`)
export const createDevice = (d: Partial<Device>) => api.post<Device>('/devices', d)
export const updateDevice = (id: number, d: Partial<Device>) => api.put<Device>(`/devices/${id}`, d)
export const deleteDevice = (id: number) => api.del<{ deleted: number }>(`/devices/${id}`)

// ---------- 遥测 ----------
export const getSeries = (id: number, metric: string, hours = 3, limit = 300) => {
  const to = Math.floor(Date.now() / 1000)
  const from = to - hours * 3600
  return api.get<SeriesResp>(`/devices/${id}/telemetry?metric=${metric}&from=${from}&to=${to}&limit=${limit}`)
}
export const getLatestAll = () => api.get<import('./types').TelemetryPoint[]>('/telemetry/latest')
export const getLatest = (id: number) =>
  api.get<Record<string, { metric: string; ts: number; value: number }>>(`/devices/${id}/latest`)
export const getForecast = (id: number, metric = 'water_level', horizon = 60) =>
  api.get<ForecastResult>(`/devices/${id}/forecast?metric=${metric}&horizon=${horizon}`)
export const postTelemetry = (samples: unknown[]) => api.post<unknown>('/telemetry', { samples })

// ---------- 规则 ----------
export const listChains = () => api.get<RuleChain[]>('/rule-chains')
export const createChain = (c: Partial<RuleChain>) => api.post<RuleChain>('/rule-chains', c)
export const updateChain = (id: number, c: Partial<RuleChain>) => api.put<RuleChain>(`/rule-chains/${id}`, c)
export const deleteChain = (id: number) => api.del<{ deleted: number }>(`/rule-chains/${id}`)
export const createNode = (chainId: number, n: Partial<RuleNode>) =>
  api.post<RuleNode>(`/rule-chains/${chainId}/nodes`, n)
export const updateNode = (nodeId: number, n: Partial<RuleNode>) =>
  api.put<RuleNode>(`/rule-nodes/${nodeId}`, n)
export const deleteNode = (nodeId: number) => api.del<{ deleted: number }>(`/rule-nodes/${nodeId}`)

// ---------- 告警 ----------
export const listAlarms = (params: {
  status?: string; level?: string; deviceId?: number; page?: number; pageSize?: number
} = {}) => {
  const q = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== '' && v !== null) q.set(k, String(v))
  })
  return api.get<AlarmPage>(`/alarms?${q.toString()}`)
}
export const getAlarmStats = () => api.get<AlarmStats>('/alarms/stats')
export const getAlarm = (id: number) => api.get<Alarm>(`/alarms/${id}`)
export const ackAlarm = (id: number) => api.post<Alarm>(`/alarms/${id}/ack`)
export const clearAlarm = (id: number) => api.post<Alarm>(`/alarms/${id}/clear`)
export const falseReportAlarm = (id: number) => api.post<Alarm>(`/alarms/${id}/false-report`)

// ---------- 大屏 ----------
export const getDashboard = () => api.get<Dashboard>('/dashboard')
export const updateDashboard = (id: number, d: Partial<Dashboard>) =>
  api.put<Dashboard>(`/dashboard/${id}`, d)

// ---------- 预警等级 ----------
export const getAlertLevels = () => api.get<AlertLevel[]>('/alert-levels')
