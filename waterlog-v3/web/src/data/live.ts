import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'

/**
 * SSE 实时推送。
 *
 * 为什么是「一个模块级单例」而不是一个普通 hook：
 * 这个 hook 被顶栏、一张图、预警中心同时用到。如果每个调用点各开一个 EventSource，
 * 浏览器对同源 HTTP/1.1 只给 6 条长连接，三个页面就把池子占掉一半，
 * 剩下三个请求永远排队——表现是「偶尔有接口卡住」，极难排查。
 *
 * 所以：连接只建一次，状态放在外部 store 里，谁要谁订阅。
 */

export interface LiveState {
  /** 连接是否通。注意它和「有没有在推数据」不是一回事，见 lastEventAt。 */
  readonly connected: boolean
  /** 最近一次收到任何事件的本机墙钟毫秒。0 表示还没收到过。 */
  readonly lastEventAt: number
  /** 累计收到的事件数，用来确认「确实在动」而不只是 TCP 还连着。 */
  readonly events: number
}

/** 同一类事件 800ms 内只失效一次。遥测 5s 一条，多个组件同时订阅时很容易雪崩。 */
const THROTTLE_MS = 800

type Key = readonly unknown[]

const EVENT_KEYS: Record<string, readonly Key[]> = {
  // 遥测只影响「一张图」与健康度；预测派生物（曲线、研判）要等 forecast 事件
  telemetry: [['overview'], ['health']],
  forecast: [['overview'], ['forecast']],
  warning: [['alerts'], ['overview']],
  rules: [['rules'], ['overview'], ['alerts']],
}

let snapshot: LiveState = { connected: false, lastEventAt: 0, events: 0 }
const listeners = new Set<() => void>()
let started = false
let qc: QueryClient | null = null
const stamps: Record<string, number> = {}

function emit(next: Partial<LiveState>) {
  snapshot = { ...snapshot, ...next }
  for (const l of listeners) l()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function getSnapshot(): LiveState {
  return snapshot
}

function bump(event: string) {
  const now = Date.now()
  const prev = stamps[event] ?? 0
  if (now - prev < THROTTLE_MS) return
  stamps[event] = now
  emit({ lastEventAt: now, events: snapshot.events + 1 })
  const keys = EVENT_KEYS[event]
  if (keys && qc) {
    for (const k of keys) void qc.invalidateQueries({ queryKey: k })
  }
}

function start() {
  if (started) return
  started = true
  const es = new EventSource('/api/events')
  es.onopen = () => emit({ connected: true })
  es.onerror = () => {
    // EventSource 自己会重连，这里只反映「此刻不通」，不做重试计数
    emit({ connected: false })
  }
  const names = ['hello', 'telemetry', 'forecast', 'warning', 'rules']
  for (const n of names) {
    es.addEventListener(n, () => bump(n))
  }
}

export function useLive(): LiveState {
  const client = useQueryClient()
  if (client !== qc) {
    qc = client
    start()
  }
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** 只读快照，给非组件代码用（比如探针脚本或调试）。 */
export function liveSnapshot(): LiveState {
  return snapshot
}
