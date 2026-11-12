// React Query hooks + SSE 实时流
import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as ep from './endpoints'

export const qk = {
  status: ['status'] as const,
  profiles: ['profiles'] as const,
  devices: ['devices'] as const,
  device: (id: number) => ['device', id] as const,
  series: (id: number, metric: string, hours: number) => ['series', id, metric, hours] as const,
  latest: (id: number) => ['latest', id] as const,
  forecast: (id: number, metric: string) => ['forecast', id, metric] as const,
  chains: ['chains'] as const,
  alarms: (p: Record<string, unknown>) => ['alarms', p] as const,
  alarmStats: ['alarmStats'] as const,
  dashboard: ['dashboard'] as const,
  levels: ['levels'] as const,
}

// ---------- 查询 ----------

export const useSystemStatus = () =>
  useQuery({ queryKey: qk.status, queryFn: ep.getSystemStatus, refetchInterval: 15_000 })

export const useProfiles = () =>
  useQuery({ queryKey: qk.profiles, queryFn: ep.listProfiles })

export const useDevices = () =>
  useQuery({ queryKey: qk.devices, queryFn: ep.listDevices, refetchInterval: 10_000 })

export const useDevice = (id: number) =>
  useQuery({ queryKey: qk.device(id), queryFn: () => ep.getDevice(id), enabled: id > 0 })

export const useSeries = (id: number, metric: string, hours = 3) =>
  useQuery({
    queryKey: qk.series(id, metric, hours),
    queryFn: () => ep.getSeries(id, metric, hours),
    enabled: id > 0,
  })

export const useLatest = (id: number) =>
  useQuery({ queryKey: qk.latest(id), queryFn: () => ep.getLatest(id), enabled: id > 0, refetchInterval: 5_000 })

export const useLatestAll = () =>
  useQuery({ queryKey: ['latestAll'], queryFn: ep.getLatestAll, refetchInterval: 5_000 })

export const useForecast = (id: number, metric = 'water_level') =>
  useQuery({
    queryKey: qk.forecast(id, metric),
    queryFn: () => ep.getForecast(id, metric),
    enabled: id > 0,
    refetchInterval: 60_000,
  })

export const useChains = () => useQuery({ queryKey: qk.chains, queryFn: ep.listChains })

export const useAlarms = (params: { status?: string; level?: string; deviceId?: number; page?: number; pageSize?: number }) =>
  useQuery({
    queryKey: qk.alarms(params),
    queryFn: () => ep.listAlarms(params),
    refetchInterval: 10_000,
  })

export const useAlarmStats = () =>
  useQuery({ queryKey: qk.alarmStats, queryFn: ep.getAlarmStats, refetchInterval: 10_000 })

export const useDashboard = () => useQuery({ queryKey: qk.dashboard, queryFn: ep.getDashboard })

export const useAlertLevelsQuery = () => useQuery({ queryKey: qk.levels, queryFn: ep.getAlertLevels })

// ---------- 变更 ----------

function useInvalidate(keys: string[][]) {
  const qc = useQueryClient()
  return () => keys.forEach((k) => qc.invalidateQueries({ queryKey: k }))
}

export const useAckAlarm = () => {
  const inv = useInvalidate([['alarms'], ['alarmStats']])
  return useMutation({ mutationFn: (id: number) => ep.ackAlarm(id), onSuccess: inv })
}
export const useClearAlarm = () => {
  const inv = useInvalidate([['alarms'], ['alarmStats']])
  return useMutation({ mutationFn: (id: number) => ep.clearAlarm(id), onSuccess: inv })
}
export const useFalseReport = () => {
  const inv = useInvalidate([['alarms'], ['alarmStats']])
  return useMutation({ mutationFn: (id: number) => ep.falseReportAlarm(id), onSuccess: inv })
}

export const useCreateDevice = () => {
  const inv = useInvalidate([['devices']])
  return useMutation({ mutationFn: (d: Parameters<typeof ep.createDevice>[0]) => ep.createDevice(d), onSuccess: inv })
}
export const useUpdateDevice = () => {
  const inv = useInvalidate([['devices']])
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof ep.updateDevice>[1] }) => ep.updateDevice(id, data),
    onSuccess: inv,
  })
}
export const useDeleteDevice = () => {
  const inv = useInvalidate([['devices']])
  return useMutation({ mutationFn: (id: number) => ep.deleteDevice(id), onSuccess: inv })
}

export const useCreateChain = () => {
  const inv = useInvalidate([['chains']])
  return useMutation({ mutationFn: (c: Parameters<typeof ep.createChain>[0]) => ep.createChain(c), onSuccess: inv })
}
export const useUpdateChain = () => {
  const inv = useInvalidate([['chains'], ['levels']])
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof ep.updateChain>[1] }) => ep.updateChain(id, data),
    onSuccess: inv,
  })
}
export const useDeleteChain = () => {
  const inv = useInvalidate([['chains'], ['levels']])
  return useMutation({ mutationFn: (id: number) => ep.deleteChain(id), onSuccess: inv })
}
export const useCreateNode = () => {
  const inv = useInvalidate([['chains'], ['levels']])
  return useMutation({
    mutationFn: ({ chainId, data }: { chainId: number; data: Parameters<typeof ep.createNode>[1] }) =>
      ep.createNode(chainId, data),
    onSuccess: inv,
  })
}
export const useUpdateNode = () => {
  const inv = useInvalidate([['chains'], ['levels']])
  return useMutation({
    mutationFn: ({ nodeId, data }: { nodeId: number; data: Parameters<typeof ep.updateNode>[1] }) =>
      ep.updateNode(nodeId, data),
    onSuccess: inv,
  })
}
export const useDeleteNode = () => {
  const inv = useInvalidate([['chains'], ['levels']])
  return useMutation({ mutationFn: (nodeId: number) => ep.deleteNode(nodeId), onSuccess: inv })
}

export const useInjectRain = () => {
  const inv = useInvalidate([['status']])
  return useMutation({ mutationFn: (power: number) => ep.injectRain(power), onSuccess: inv })
}

// ---------- SSE 实时流 ----------

interface StreamEvent {
  type: string
  payload?: unknown
  ts?: number
}

/**
 * 订阅 /stream：遥测与告警事件到达时使相关查询失效。
 * 断线自动重连（指数退避，上限 15s），页面卸载时清理。
 */
export function useEventStream() {
  const qc = useQueryClient()
  useEffect(() => {
    let es: EventSource | null = null
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let closed = false

    // 按 queryKey 独立节流。
    // 问题：告警密集产生时，每条 SSE 事件都会 invalidateQueries，而 invalidate
    // 默认会取消进行中的请求并重新发起，导致请求反复被取消重发，页面长期停在
    // 加载态（实测规则页间歇性卡在骨架屏）。按 key 做最小间隔节流可消除该抖动。
    const lastHit = new Map<string, number>()
    const invalidateThrottled = (key: string, minGapMs = 800) => {
      const now = Date.now()
      const last = lastHit.get(key) ?? 0
      if (now - last < minGapMs) return
      lastHit.set(key, now)
      qc.invalidateQueries({ queryKey: [key] })
    }

    const connect = () => {
      if (closed) return
      es = new EventSource(`${import.meta.env.VITE_API_BASE_URL || '/api/v1'}/stream`)
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as StreamEvent
          if (data.type?.startsWith('alarm')) {
            invalidateThrottled('alarms')
            invalidateThrottled('alarmStats')
          }
          if (data.type === 'telemetry') {
            invalidateThrottled('devices')
            invalidateThrottled('series')
            invalidateThrottled('latest')
            invalidateThrottled('latestAll')
          }
        } catch { /* 忽略畸形事件 */ }
      }
      es.onerror = () => {
        es?.close()
        if (closed) return
        retry = Math.min(retry + 1, 5)
        timer = setTimeout(connect, Math.min(1000 * 2 ** retry, 15_000))
      }
      es.onopen = () => { retry = 0 }
    }
    connect()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      es?.close()
    }
  }, [qc])
}
