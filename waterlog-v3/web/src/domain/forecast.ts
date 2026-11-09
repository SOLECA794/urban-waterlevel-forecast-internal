import type { Assessment } from './assessment'
import type { SimTime } from './time'
import type { Delta, Depth, Meters } from './units'
import { advance, deltaOf } from './units'

/** 四个预见期（分钟）。1h/3h 是老师要求的重点，6h/12h 是扩展。 */
export const HORIZONS = [60, 180, 360, 720] as const
export type HorizonMin = (typeof HORIZONS)[number]

export function horizonLabel(h: number): string {
  if (h < 60) return `${h}min`
  const hours = h / 60
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`
}

/** 某个预见期上的点预测 + 区间 + 修正明细。 */
export interface Horizon {
  readonly horizonMin: number
  readonly level: Meters
  readonly lower: Meters
  readonly upper: Meters
  /** 相对"现在"的变化量，已含修正 */
  readonly delta: Delta
  /** 模型原始输出（未修正） */
  readonly rawDelta: Delta
  /** 滚动修正加上去的量 */
  readonly corrected: Delta
  /** 修正强度 0~0.6，0 表示这个站点这个预见期还没积累到足够误差 */
  readonly gain: number
  /** 残差标准差，决定区间宽度 */
  readonly sigma: Meters
  readonly model: string
  readonly reason: string
}

/** 曲线上的一个点。offsetMin = 0 是"现在"。 */
export interface CurvePoint {
  readonly offsetMin: number
  readonly level: Meters
  readonly lower: Meters
  readonly upper: Meters
}

export interface Decision {
  readonly shouldForecast: boolean
  readonly model: string
  readonly gain: number
  readonly reason: string
  readonly signals: Readonly<Record<string, number>>
}

export interface SiteForecast {
  readonly siteId: string
  /** 发布预测时刻的实测水位 */
  readonly nowLevel: Meters
  readonly horizons: readonly Horizon[]
  readonly curve: readonly CurvePoint[]
  readonly assessment: Assessment
  readonly decision: Decision
}

export interface Forecast {
  readonly issuedAt: SimTime
  readonly modelVersion: string
  readonly stepMin: number
  readonly sites: Readonly<Record<string, SiteForecast>>
}

/** 取指定预见期，没有就返回 null（不要返回第一个凑数）。 */
export function horizonOf(f: SiteForecast | undefined, h: number): Horizon | null {
  if (!f) return null
  return f.horizons.find((x) => x.horizonMin === h) ?? null
}

/** 曲线换算成积水深序列（相对站点基准），给图表用。 */
export function curveDepth(points: readonly CurvePoint[], baseLevel: Meters): Depth[] {
  return points.map((p) => (p.level - baseLevel) as Depth)
}

/**
 * 曲线最高点。用于"预见期内峰值出现在什么时候"。
 * 注意区间上下界也一起返回——判断是否可信要看带子有多宽。
 */
export function curvePeak(points: readonly CurvePoint[]): CurvePoint | null {
  let best: CurvePoint | null = null
  for (const p of points) if (!best || p.level > best.level) best = p
  return best
}

/** 曲线在某个预见期上的值（按 offset 精确取，没有就取最近点）。 */
export function curveAt(points: readonly CurvePoint[], offsetMin: number): CurvePoint | null {
  if (!points.length) return null
  let best = points[0]
  for (const p of points) {
    if (Math.abs(p.offsetMin - offsetMin) < Math.abs(best.offsetMin - offsetMin)) best = p
  }
  return best
}

/**
 * 用曲线上 offset 处的值推算"相对现在的增量"。
 * 这里必须走 advance/deltaOf 而不是直接减，就是为了让量纲在类型层成立。
 */
export function curveDelta(points: readonly CurvePoint[], offsetMin: number, now: Meters): Delta | null {
  const p = curveAt(points, offsetMin)
  if (!p) return null
  return deltaOf(advance(now, 0 as Delta), p.level)
}
