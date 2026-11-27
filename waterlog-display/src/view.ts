import type { Level, Station } from './types'
import { LEVEL_COLORS } from './types'

export const HOUR = 3_600_000
export const LEVELS: Level[] = ['red', 'orange', 'yellow', 'blue', 'none']

const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const day = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', weekday: 'short' })

export function timeText(at: number): string {
  return Number.isFinite(at) ? clock.format(at) : '—'
}
export function dayText(at: number): string {
  return Number.isFinite(at) ? day.format(at) : '—'
}
export function levelOf(depth: number, th: Station['thresholds']): Level {
  for (const level of ['red', 'orange', 'yellow', 'blue'] as const) {
    if (depth >= th[level]) return level
  }
  return 'none'
}
export function levelColor(level: Level): string {
  return LEVEL_COLORS[level]
}
export function horizon(station: Station, hours: number): { depth: number; lower: number; upper: number; at: number } | null {
  if (!station.forecast?.length) return null
  const target = station.forecast[0].at + hours * HOUR
  let best = station.forecast[0]
  let diff = Math.abs(best.at - target)
  for (const p of station.forecast) {
    const d = Math.abs(p.at - target)
    if (d < diff) { diff = d; best = p }
  }
  return best
}
export function peak(station: Station): { depth: number; at: number } {
  let best = { depth: -Infinity, at: station.forecast[0]?.at ?? 0 }
  for (const p of station.forecast) if (p.depth > best.depth) best = { depth: p.depth, at: p.at }
  return best.depth === -Infinity ? { depth: station.actual, at: station.history.at(-1)?.at ?? 0 } : best
}
export function statusCounts(stations: Station[]): Record<Level, number> {
  const out: Record<Level, number> = { red: 0, orange: 0, yellow: 0, blue: 0, none: 0 }
  for (const s of stations) out[levelOf(s.actual, s.thresholds)]++
  return out
}
export function fmtDepth(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '—'
}
export function fmtRain(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : '—'
}
