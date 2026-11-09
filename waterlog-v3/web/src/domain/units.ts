/**
 * 量纲层：六种物理量在 JSON 里长得一模一样，全靠类型区分。
 *
 * 为什么值得付这个代价——这两类错误已经真实发生过，不是假想风险：
 *
 * 1. 引擎里 `_predict()` 返回的是**增量 Δy**，被当成**绝对水位**和实测值比较，
 *    误差均值算出 +7.85m（正好等于站点基准高程 7.85m）。修正器于是每轮加 3.2m，
 *    S01 的预测被顶到物理上限、直接判红。定位花了两个小时。
 * 2. 前端「合计积水」把 10 个站点的水深相加显示 3.21m。各站是独立汇水单元，
 *    这个数没有任何物理含义（后来改成「最深受水」）。
 *
 * 品牌类型让 `level - base` 的结果无法直接当 `Depth` 用，必须走 `depthOf()`。
 * 代价是 adapter 层要写一批 `as`——集中在一个文件里，正好是它该待的地方。
 */

declare const unitBrand: unique symbol

/** 类型层面贴标签，运行时完全不存在。 */
type Brand<T, B extends string> = T & { readonly [unitBrand]: B }

/** 绝对水位（含站点基准高程），单位 m。跨站点不可比较、不可相加。 */
export type Meters = Brand<number, 'Meters'>
/** 积水深（相对站点基准），单位 m。跨站点仍不可相加——各站汇水面积不同。 */
export type Depth = Brand<number, 'Depth'>
/** 水位增量（有正负），单位 m。可相加。 */
export type Delta = Brand<number, 'Delta'>
/** 变化率，单位 m/h。 */
export type Rate = Brand<number, 'Rate'>
/** 雨强，单位 mm/h。 */
export type RainRate = Brand<number, 'RainRate'>
/** 累计雨量，单位 mm。 */
export type RainSum = Brand<number, 'RainSum'>

export const meters = (v: number): Meters => v as Meters
export const depth = (v: number): Depth => v as Depth
export const delta = (v: number): Delta => v as Delta
export const rate = (v: number): Rate => v as Rate
export const rainRate = (v: number): RainRate => v as RainRate
export const rainSum = (v: number): RainSum => v as RainSum

/**
 * 唯一允许把「绝对水位」变成「积水深」的地方。
 *
 * 故意不钳到 0：传感器噪声会让实测积水深出现 -0.004 这样的负数，
 * 抹成 0 是美化数据。要展示用的非负值请显式调 `nonNegative()`。
 */
export function depthOf(level: Meters, base: Meters): Depth {
  return (level - base) as Depth
}

/** 由基准 + 水深还原绝对水位。 */
export function levelOf(base: Meters, d: Depth): Meters {
  return (base + d) as Meters
}

/** 沿增量前进。`level + delta` 在类型层不成立，是为了逼你想清楚加的是不是增量。 */
export function advance(level: Meters, d: Delta): Meters {
  return (level + d) as Meters
}

export function deltaOf(next: Meters, prev: Meters): Delta {
  return (next - prev) as Delta
}

/** 增量换算成变化率。minutes 为 0 时返回 0，避免除零。 */
export function ratePerHour(d: Delta, minutes: number): Rate {
  if (!minutes) return 0 as Rate
  return ((d / minutes) * 60) as Rate
}

/**
 * 取最大水深。这是跨站点唯一合法的聚合方式。
 * 注意：**没有 sum 版本**，因为跨站求和没有物理含义（见文件头第 2 条）。
 */
export function maxDepth(list: readonly Depth[]): Depth {
  let out = 0
  for (const d of list) if (d > out) out = d
  return out as Depth
}

/** 展示用的非负水深。原始值仍然保留在 `Depth` 里，不要用它做统计。 */
export function nonNegative(d: Depth): Depth {
  return (d > 0 ? d : 0) as Depth
}

/**
 * 水深相对某个阈值的比值（用来画进度条 / 判断占阈多少）。
 * 归一化到 0 起点，负数截到 0。
 */
export function ratioTo(d: Depth, threshold: Meters): number {
  if (!threshold) return 0
  const r = d / threshold
  return r > 0 ? r : 0
}

// ---------------------------------------------------------------- 数据质量

export type QualityState = 'good' | 'degraded' | 'lost'

export interface Quality {
  /** 后端原始值，1 = 正常 */
  readonly raw: number
  readonly state: QualityState
  readonly label: string
}

/**
 * 后端 quality 目前是 0/1 的整数，这里留出中间态：
 * 真实系统里传感器劣化是连续量，界面不该只支持"好/坏"两种画法。
 */
export function qualityOf(raw: number): Quality {
  if (!Number.isFinite(raw)) return { raw: 0, state: 'lost', label: '无数据' }
  if (raw >= 0.999) return { raw, state: 'good', label: '数据正常' }
  if (raw > 0) return { raw, state: 'degraded', label: '传感器劣化' }
  return { raw, state: 'lost', label: '数据中断' }
}
