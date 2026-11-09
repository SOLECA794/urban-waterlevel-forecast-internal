/**
 * 时间层：系统里同时跑着两套时钟，混用会差出 60 倍。
 *
 * - **仿真时钟 SimTime**：后端所有业务时间戳（`issued_at`、`updated_at`、`raised_at`…）
 *   都在这一条轴上。模拟器以 60x 加速推进，所以仿真时间已经跑到墙钟前面去了。
 * - **墙钟 WallTime**：`Date.now()`，只用来算「这个请求花了多久」这类事。
 * - **时长 Duration**：秒，同一条轴内相减的结果。
 *
 * 踩过的坑：
 * - Go 的 `NowTS()` 用 `MAX(telemetry.ts)`，重启后卡在旧的未来值，一张图直接定格；
 * - 引擎 `/metrics` 的窗口用 `time.time()` 算，1 小时被当成 1 天，在线 skill 全错。
 *
 * 所以：**跨类型不能相减**，换算必须显式调用本文件的函数。
 */

declare const clockBrand: unique symbol

type Stamp<B extends string> = number & { readonly [clockBrand]: B }

/** 仿真时间轴上的时刻（unix 秒形态，但不等于真实时间）。 */
export type SimTime = Stamp<'SimTime'>
/** 真实世界的时刻。 */
export type WallTime = Stamp<'WallTime'>
/** 一段时长，秒。可正可负。 */
export type Duration = Stamp<'Duration'>

export const simTime = (v: number): SimTime => v as SimTime
export const wallTime = (v: number): WallTime => v as WallTime
export const duration = (sec: number): Duration => sec as Duration

export function wallNow(): WallTime {
  return (Date.now() / 1000) as WallTime
}

/** 同一条仿真轴上两点之差。 */
export function elapsed(now: SimTime, then: SimTime): Duration {
  return (now - then) as Duration
}

export function addSim(t: SimTime, d: Duration): SimTime {
  return (t + d) as SimTime
}

/** 后端偶尔给 0 表示「还没有」。 */
export function isUnset(t: number | null | undefined): boolean {
  return !t
}

// ---------------------------------------------------------------- 新鲜度

/**
 * 数据新鲜度。这是内涝预警系统最危险的一类失效：
 * **数据坏了，但界面看起来正常。**
 *
 * 预测每 60 仿真分钟出一轮（12 个 tick × 5 仿真分钟），所以：
 * - 落后 2 轮 → stale（曲线该虚化）
 * - 落后 6 轮 → stalled（该整块标灰并提示"预测已停更"）
 */
export type Freshness = 'live' | 'stale' | 'stalled' | 'unknown'

export const FORECAST_CADENCE_MIN = 60
const STALE_AFTER_S = 2 * FORECAST_CADENCE_MIN * 60
const STALLED_AFTER_S = 6 * FORECAST_CADENCE_MIN * 60

export function freshnessOf(age: Duration | null): Freshness {
  if (age === null) return 'unknown'
  if (age < 0) return 'live' // 时钟偏差，当作最新
  if (age >= STALLED_AFTER_S) return 'stalled'
  if (age >= STALE_AFTER_S) return 'stale'
  return 'live'
}

export const FRESHNESS_LABEL: Record<Freshness, string> = {
  live: '实时',
  stale: '滞后',
  stalled: '已停更',
  unknown: '未知',
}

export const FRESHNESS_HINT: Record<Freshness, string> = {
  live: '数据在一个预测周期内',
  stale: '数据落后超过 2 个预测周期，界面上的数字已经不是当前状态',
  stalled: '数据落后超过 6 个预测周期，请检查引擎与推送链路',
  unknown: '没有收到时间戳',
}

/** 落后了几分钟（仿真分钟）。用于「落后 12 分钟」这类提示。 */
export function staleMinutes(age: Duration | null): number {
  if (age === null) return 0
  return Math.max(0, Math.round(age / 60))
}
