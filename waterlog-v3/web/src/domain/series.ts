import type { AlarmLevel, Level } from './level'
import { worseOf } from './level'
import type { Thresholds } from './site'
import { levelForDepth } from './site'
import type { SimTime } from './time'
import type { Meters, RainRate, RainSum, Depth } from './units'
import { depthOf, maxDepth, rainSum } from './units'

/**
 * 时间序列：一个站点在一段时间里的实测水位与雨量。
 *
 * 和 Reading（一个时刻的快照）分开，因为它们的用途完全不同：
 * 快照回答「现在多深」，序列回答「刚才涨了多快、峰值出现在什么时候」。
 * 混成一个类型就会出现「用快照里的 trend 字段去画曲线」这种隐性耦合。
 */
export interface SeriesPoint {
  readonly at: SimTime
  readonly level: Meters
  readonly rain: RainRate
}

export interface SiteSeries {
  readonly siteId: string
  readonly hours: number
  readonly points: readonly SeriesPoint[]
}

export const EMPTY_SERIES: SiteSeries = { siteId: '', hours: 0, points: [] }

/** 把绝对水位序列换成积水深序列，用来画图（各站基准高程差十几米，画绝对值是几簇孤立的点云）。 */
export function depthSeries(
  series: SiteSeries,
  baseLevel: Meters,
): { at: SimTime; depth: Depth }[] {
  return series.points.map((p) => ({ at: p.at, depth: depthOf(p.level, baseLevel) }))
}

/** 序列峰值水深。空序列返回 0，而不是 undefined——调用点都是画图/比阈值。 */
export function seriesPeak(series: SiteSeries, baseLevel: Meters): Depth {
  return maxDepth(series.points.map((p) => depthOf(p.level, baseLevel)))
}

/** 这段窗口内的累计雨量（mm）。 */
export function seriesRainTotal(series: SiteSeries): RainSum {
  return rainSum(series.points.reduce((acc, p) => acc + p.rain, 0))
}

/** 截到某个时刻之后，用于「只看最近 N 分钟」。 */
export function sinceSim(series: SiteSeries, from: SimTime): SiteSeries {
  return { ...series, points: series.points.filter((p) => p.at >= from) }
}

/** 最近的 N 个点，画 sparkline 用。 */
export function tail(series: SiteSeries, n: number): readonly SeriesPoint[] {
  return series.points.slice(Math.max(0, series.points.length - n))
}

/**
 * 一段连续超过某等级的时段。
 *
 * 「这次涨水什么时候开始的、最高到哪一级、超橙持续多久」——
 * 值班复盘问的是这三件事，而一条曲线回答不了：看曲线只能估，
 * 而且 12 小时窗口里常常有两三段分开的积水过程。
 */
export interface ThresholdSegment {
  readonly level: AlarmLevel
  readonly start: SimTime
  readonly end: SimTime
  readonly minutes: number
  /** 段内最深积水。 */
  readonly peak: Depth
  /** 段内是否仍在持续（最后一个点仍在该等级）。 */
  readonly ongoing: boolean
}

/**
 * 把历史序列按阈值切段，**只返回超过蓝色阈值的连续区间**。
 *
 * 相邻点之间只有 `stepMin` 分钟，所以「连续」的判定不需要插值：
 * 只要某个采样点还在蓝阈以上，就算这段还没结束。这会低估极短的瞬时超阈
 * （两次采样之间涨上去又落回来），但那类过程本来也不构成一次积水事件。
 */
export function thresholdSegments(
  series: SiteSeries,
  baseLevel: Meters,
  thresholds: Thresholds,
): readonly ThresholdSegment[] {
  const out: ThresholdSegment[] = []
  let cur: { start: SimTime; end: SimTime; peak: Depth; level: Level } | null = null

  for (const p of series.points) {
    const d = depthOf(p.level, baseLevel)
    const lv = levelForDepth(d, thresholds)
    if (lv === 'none') {
      if (cur) {
        out.push(finish(cur, false))
        cur = null
      }
      continue
    }
    if (!cur) {
      cur = { start: p.at, end: p.at, peak: d, level: lv }
      continue
    }
    cur.end = p.at
    if (d > cur.peak) cur.peak = d
    cur.level = worseOf(cur.level, lv) as Level
  }
  if (cur) out.push(finish(cur, true))
  return out

  function finish(
    c: { start: SimTime; end: SimTime; peak: Depth; level: Level },
    ongoing: boolean,
  ): ThresholdSegment {
    return {
      level: c.level as AlarmLevel,
      start: c.start,
      end: c.end,
      minutes: Math.max(0, Math.round((c.end - c.start) / 60)),
      peak: c.peak,
      ongoing,
    }
  }
}
