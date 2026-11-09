import type { SimTime } from './time'
import type { Depth, Delta, Meters, Quality, RainRate } from './units'

/**
 * 一个站点「此刻」的实测状态。这是 L3 明细层的数据契约——
 * 注意它**不含**任何预警研判字段：实测是事实，研判是推论，两者生命周期不同
 * （实测每 5 秒变，研判每 60 分钟变），混在一个对象里就必然出现
 * 「数字已经更新但结论还是上一轮的，界面看不出谁新谁旧」。
 */
export interface Reading {
  readonly level: Meters
  readonly depth: Depth
  readonly rain: RainRate
  readonly quality: Quality
  /** 近 1h 水位变化量（m）。正涨负退。 */
  readonly trend1h: Delta
  readonly updatedAt: SimTime
  /** 近 3h 水位采样（绝对水位，画图时再用 baseLevel 换成水深） */
  readonly spark: readonly Meters[]
}

export const EMPTY_READING: Reading = {
  level: 0 as Meters,
  depth: 0 as Depth,
  rain: 0 as RainRate,
  quality: { raw: 0, state: 'lost', label: '无数据' },
  trend1h: 0 as Delta,
  updatedAt: 0 as SimTime,
  spark: [],
}

/** 有没有在下雨（mm/h）。1.0 以下算零星，不当作"降雨中"。 */
export function isRaining(rain: RainRate): boolean {
  return rain >= 1
}

/** 涨得算不算快。0.05 m/h 以上视为"快速上涨"，值班时优先看。 */
export function isRisingFast(trend: Delta): boolean {
  return trend >= 0.05
}
