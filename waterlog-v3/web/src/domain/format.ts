import type { Depth, Delta, Meters, RainRate, RainSum, Rate } from './units'
import type { Duration, SimTime } from './time'

/**
 * 数值与时间的呈现。
 *
 * 放在领域层而不是 `utils/`，因为这些函数**必须知道量纲**：
 * `fmtMeters()` 只接受 `Meters`，把 `Depth` 传进来编译就不过。
 * 以前所有量共用一个 `m(v, 3)`，看不出谁是谁，正是量纲 bug 的温床。
 */

const pad = (n: number) => String(Math.floor(n)).padStart(2, '0')

function toDate(t: number): Date {
  // 后端给的是 unix 秒（仿真轴），但显示格式一律按同一套规则
  return new Date(t * 1000)
}

/** `2026-10-21 07:09` / `10-21 07:09` / `07:09` */
export function fmtTime(t: SimTime | number | null | undefined, pattern = 'MM-DD HH:mm'): string {
  if (!t) return '—'
  const d = toDate(t)
  if (Number.isNaN(d.getTime())) return '—'
  const Y = d.getFullYear()
  const M = pad(d.getMonth() + 1)
  const D = pad(d.getDate())
  const h = pad(d.getHours())
  const m = pad(d.getMinutes())
  const s = pad(d.getSeconds())
  switch (pattern) {
    case 'HH:mm':
      return `${h}:${m}`
    case 'HH:mm:ss':
      return `${h}:${m}:${s}`
    case 'MM-DD':
      return `${M}-${D}`
    case 'MM-DD HH:mm:ss':
      return `${M}-${D} ${h}:${m}:${s}`
    case 'YYYY-MM-DD HH:mm':
      return `${Y}-${M}-${D} ${h}:${m}`
    case 'MM-DD HH:mm':
    default:
      return `${M}-${D} ${h}:${m}`
  }
}

/** 只要时分，图表轴用。 */
export function fmtClock(t: SimTime | number): string {
  return fmtTime(t, 'HH:mm')
}

/** 绝对水位：**永远带 3 位小数**——这是厘米级量，2 位会把 0.42 和 0.46 显示成一样。 */
export function fmtMeters(v: Meters | number, digits = 3): string {
  if (!Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

/** 积水深：2 位够用（值班员读的是 0.42m 而不是 0.4213m）。 */
export function fmtDepth(v: Depth | number, digits = 2): string {
  if (!Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

/** 带符号的增量。 */
export function fmtDelta(v: Delta | number, digits = 3): string {
  if (!Number.isFinite(v)) return '—'
  const s = v.toFixed(digits)
  return v > 0 ? `+${s}` : s
}

export function fmtRate(v: Rate | number, digits = 2): string {
  if (!Number.isFinite(v)) return '—'
  const s = v.toFixed(digits)
  return v > 0 ? `+${s}` : s
}

export function fmtRain(v: RainRate | number, digits = 1): string {
  if (!Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

export function fmtRainSum(v: RainSum | number, digits = 1): string {
  if (!Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

/** 比例 → 百分比字符串。 */
export function fmtPct(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(digits)}%`
}

/** 分钟数 → `2h10m` / `45m`。研判的「超阈持续」用它。 */
export function fmtMinutes(min: number): string {
  const n = Math.round(min)
  if (!Number.isFinite(n) || n <= 0) return '0m'
  const h = Math.floor(n / 60)
  const m = n % 60
  if (h > 0) return m > 0 ? `${h}h${pad(m)}m` : `${h}h`
  return `${m}m`
}

/** 秒级时长 → `3m12s`。用于「多久以前」。 */
export function fmtDuration(sec: Duration | number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return r > 0 ? `${m}m${pad(r)}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${pad(m % 60)}m`
}
