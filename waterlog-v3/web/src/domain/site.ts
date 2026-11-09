import type { AlarmLevel, Level } from './level'
import { ALARM_LEVELS } from './level'
import type { Depth, Meters } from './units'

/**
 * 阈值是一组**具名量**，不是数组。
 *
 * 之前四处代码按位置访问它：`thresholds[3] || 0.46`。
 * 那个兜底值 0.46 是 S01 的红阈值，套到别的站点就是错的——只是恰好没人踩到。
 * 这和引擎里 `Xva[:, 4]`（以为是 d_level_12，其实是 level_lag6）是同一个病：
 * **用位置访问有语义的东西**。
 */
export interface Thresholds {
  readonly blue: Meters
  readonly yellow: Meters
  readonly orange: Meters
  readonly red: Meters
}

export function thresholdsOf(blue: number, yellow: number, orange: number, red: number): Thresholds {
  return { blue: blue as Meters, yellow: yellow as Meters, orange: orange as Meters, red: red as Meters }
}

export function thresholdOf(t: Thresholds, level: AlarmLevel): Meters {
  return t[level]
}

/** 按等级顺序展开，用于画刻度尺和四级色块。 */
export function thresholdRows(t: Thresholds): { level: AlarmLevel; value: Meters }[] {
  return ALARM_LEVELS.map((level) => ({ level, value: t[level] }))
}

/** 红阈值，最常被当作"满量程"。 */
export function redThreshold(t: Thresholds): Meters {
  return t.red
}

/**
 * 积水深落在哪一级。
 *
 * 和 `assessment.level` 的区别要说清楚：那个是**研判结论**（含持续时间、趋势、
 * 两道只降不升的硬约束），这个是**纯粹按深度查表**。两者可以不同——
 * 比如水深 0.50m（过红阈）但只持续了 5 分钟，研判会封顶降到黄色。
 * 所以这个函数只用于「把历史序列切成段」这类几何问题，不用于出结论。
 */
export function levelForDepth(d: Depth, t: Thresholds): Level {
  if (d >= t.red) return 'red'
  if (d >= t.orange) return 'orange'
  if (d >= t.yellow) return 'yellow'
  if (d >= t.blue) return 'blue'
  return 'none'
}

// ---------------------------------------------------------------- 站点

export type SiteKind =
  | 'tunnel'
  | 'underpass'
  | 'lowland'
  | 'pump'
  | 'gate'
  | 'alley'
  | 'square'
  | 'culvert'
  | 'stadium'
  | 'channel'

export const SITE_KIND_LABEL: Record<SiteKind, string> = {
  tunnel: '下穿隧道',
  underpass: '桥下',
  lowland: '低洼路段',
  pump: '泵站',
  gate: '闸口',
  alley: '老城巷口',
  square: '广场',
  culvert: '涵洞',
  stadium: '场馆',
  channel: '排水渠',
}

export function siteKindOf(raw: string): SiteKind {
  return (Object.prototype.hasOwnProperty.call(SITE_KIND_LABEL, raw) ? raw : 'lowland') as SiteKind
}

/** 汇水与排水参数。只在详情页展示，用来解释"为什么这个站涨得快"。 */
export interface DrainageParams {
  readonly catchmentHa: number
  readonly pondHa: number
  readonly impervious: number
  readonly drainageMmH: number
}

export interface Site {
  readonly id: string
  readonly name: string
  readonly district: string
  readonly lon: number
  readonly lat: number
  /** 站点基准高程（河底/渠底），绝对水位 = baseLevel + 积水深 */
  readonly baseLevel: Meters
  readonly thresholds: Thresholds
  readonly kind: SiteKind
  readonly drainage?: DrainageParams
}

/** 「下穿隧道」「桥下」这类地形本身就知道会先淹，界面可以据此提示。 */
export function isConfinedKind(kind: SiteKind): boolean {
  return kind === 'tunnel' || kind === 'underpass' || kind === 'culvert'
}
