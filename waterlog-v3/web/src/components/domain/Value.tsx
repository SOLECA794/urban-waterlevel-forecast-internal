import {
  fmtDelta,
  fmtDepth,
  fmtMeters,
  fmtRain,
  fmtRate,
  LEVEL_RANK,
  nonNegative,
  ratioTo,
  type Delta,
  type Depth,
  type Level,
  type Meters,
  type RainRate,
  type Rate,
} from '../../domain'
import { T } from '../../utils/tokens'

/**
 * 数值展示组件（领域层）。
 *
 * 存在的理由很具体：**同一屏上「0.42」可能是水深、是增量、是雨强、是变化率。**
 * 以前全用一个 `m(v, 3)` 输出，单位靠旁边的表头文字解释——表头被截断的那一刻，
 * 数字就失去意义了。所以每个组件只接受一种品牌类型，单位写死在组件里。
 */

export function DepthValue({
  value,
  size = 'md',
  showUnit = true,
}: {
  value: Depth
  size?: 'sm' | 'md' | 'lg'
  showUnit?: boolean
}) {
  const cls = size === 'lg' ? 'stat-value' : size === 'sm' ? 'text-[13px] num font-medium' : 'stat-value-sm'
  const d = nonNegative(value)
  return (
    <span className={cls} style={{ color: d > 0 ? T.text1 : T.text3 }}>
      {fmtDepth(value)}
      {showUnit && <span className="text-[11px] font-normal text-ink-3 ml-0.5">m</span>}
    </span>
  )
}

/** 绝对水位。跨站点不可比较，所以永远和站点名一起出现。 */
export function LevelValue({ value, digits = 3 }: { value: Meters; digits?: number }) {
  return (
    <span className="num text-[13px] text-ink">
      {fmtMeters(value, digits)}
      <span className="text-[11px] text-ink-3 ml-0.5">m</span>
    </span>
  )
}

/** 变化率（m/h）。涨红降绿，零值灰。 */
export function RateValue({ value, digits = 2 }: { value: Rate; digits?: number }) {
  const flat = Math.abs(value) < 0.005
  const color = flat ? T.text3 : value > 0 ? T.level.red : T.success
  return (
    <span className="num text-[12px] font-medium" style={{ color }}>
      {fmtRate(value, digits)}
      <span className="text-[10px] font-normal opacity-70 ml-0.5">m/h</span>
    </span>
  )
}

/** 雨强（mm/h）。 */
export function RainValue({ value }: { value: RainRate }) {
  const on = value >= 0.1
  return (
    <span className="num text-[12px]" style={{ color: on ? T.aiInk : T.text3 }}>
      {fmtRain(value)}
      <span className="text-[10px] opacity-70 ml-0.5">mm/h</span>
    </span>
  )
}

/**
 * 阈值尺：把四级阈值按位置画出来，再把当前水深放上去。
 *
 * 为什么值得一个专门组件：`0.06 / 0.18 / 0.30 / 0.46` 这组数在表格里跟
 * `0.05 / 0.10 / 0.12 / 0.90` 长得一模一样，但在尺子上一个是均匀的、
 * 一个是挤在左边的。**值班员真正需要的不是四个数字，而是「我离下一级还有多远」。**
 */
export function ThresholdRuler({
  depth,
  thresholds,
  level,
  height = 8,
}: {
  depth: Depth
  thresholds: { blue: Meters; yellow: Meters; orange: Meters; red: Meters }
  level: Level
  height?: number
}) {
  const max = thresholds.red * 1.18
  const pos = (v: number) => Math.max(0, Math.min(1, v / max))
  const cur = nonNegative(depth)
  const stops: { at: number; color: string }[] = [
    { at: pos(thresholds.blue), color: T.level.blue },
    { at: pos(thresholds.yellow), color: T.level.yellow },
    { at: pos(thresholds.orange), color: T.level.orange },
    { at: pos(thresholds.red), color: T.level.red },
  ]
  const fill = T.level[level] ?? T.level.none
  return (
    <div className="w-full">
      <div className="relative rounded-pill overflow-hidden" style={{ height, background: '#eef2f6' }}>
        <div
          className="h-full rounded-pill grow-x"
          style={{ width: `${Math.min(100, ratioTo(cur, thresholds.red) * 100)}%`, background: fill, opacity: 0.85 }}
        />
        {stops.map((s, i) => (
          <span
            key={i}
            className="absolute top-0 bottom-0"
            style={{ left: `${s.at * 100}%`, width: 1.5, background: 'rgba(255,255,255,0.9)' }}
          />
        ))}
      </div>
    </div>
  )
}

/** 告警等级排序辅助：把最大等级算出来（地图图例、态势条共用）。 */
export function topLevelOf(levels: readonly Level[]): Level {
  return levels.reduce<Level>((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a), 'none')
}

/**
 * 水位增量（有正负）。和 `RateValue` 是两个类型：增量是「变了多少」，变化率是「多快」。
 * 混用的后果很具体——引擎里把增量当绝对水位比过一次，误差算出 +7.85m。
 */
export function DeltaValue({
  value,
  digits = 3,
  suffix,
}: {
  value: Delta
  digits?: number
  suffix?: string
}) {
  const v = value as number
  const tone = Math.abs(v) < 1e-9 ? T.text3 : v > 0 ? T.levelInk.red : T.levelInk.blue
  return (
    <span className="num text-[12px] font-medium" style={{ color: tone }}>
      {fmtDelta(value, digits)}
      {suffix && <span className="text-[10px] text-ink-3 ml-0.5">{suffix}</span>}
    </span>
  )
}
