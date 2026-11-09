import type { ReactNode } from 'react'
import {
  FRESHNESS_HINT,
  FRESHNESS_LABEL,
  fmtDuration,
  staleMinutes,
  type Duration,
  type Freshness,
  type Quality,
  type QualityState,
} from '../../domain'
import { T } from '../../utils/tokens'
import { Icon } from '../primitives/Icons'

/**
 * 数据可信度组件（领域层）。
 *
 * 这一族组件回答的问题不是「数字是多少」，而是「**这个数字还能不能信**」。
 * 前者界面一直做得很好，后者一直缺失——而内涝预警里最危险的失效恰恰是
 * 「数据坏了，界面看起来完全正常」。
 */

const FRESH_COLOR: Record<Freshness, { bg: string; fg: string; ring: string }> = {
  live: { bg: '#dcfce7', fg: '#15803d', ring: '#bbf7d0' },
  stale: { bg: T.levelWeak.yellow, fg: T.levelInk.yellow, ring: '#fde68a' },
  stalled: { bg: T.levelWeak.red, fg: T.levelInk.red, ring: '#fecaca' },
  unknown: { bg: T.levelWeak.none, fg: T.text2, ring: '#e2e8f0' },
}

/** 新鲜度徽标。可选显示「落后 12 分钟」。 */
export function FreshnessBadge({
  freshness,
  age,
  showAge = false,
}: {
  freshness: Freshness
  age?: Duration | null
  showAge?: boolean
}) {
  const c = FRESH_COLOR[freshness]
  const mins = age != null ? staleMinutes(age) : 0
  return (
    <span
      className="chip"
      title={FRESHNESS_HINT[freshness]}
      style={{ background: c.bg, color: c.fg, boxShadow: `inset 0 0 0 1px ${c.ring}` }}
    >
      <span className="chip-dot" style={{ background: c.fg }} />
      {FRESHNESS_LABEL[freshness]}
      {showAge && mins > 0 && freshness !== 'live' && <span className="num opacity-70">· 落后 {mins}min</span>}
    </span>
  )
}

const QUALITY_COLOR: Record<QualityState, { bg: string; fg: string; ring: string }> = {
  good: { bg: '#dcfce7', fg: '#15803d', ring: '#bbf7d0' },
  degraded: { bg: T.levelWeak.yellow, fg: T.levelInk.yellow, ring: '#fde68a' },
  lost: { bg: T.levelWeak.red, fg: T.levelInk.red, ring: '#fecaca' },
}

/** 传感器质量。劣化时不仅变色，还带一个告警图标——颜色不能是唯一编码。 */
export function QualityBadge({ quality }: { quality: Quality }) {
  const c = QUALITY_COLOR[quality.state]
  const bad = quality.state !== 'good'
  return (
    <span
      className="chip"
      title={`原始质量值 ${quality.raw.toFixed(2)}`}
      style={{ background: c.bg, color: c.fg, boxShadow: `inset 0 0 0 1px ${c.ring}` }}
    >
      <Icon name={bad ? 'alertTriangle' : 'wifi'} size={11} />
      {quality.label}
    </span>
  )
}

/**
 * 全站横幅：只在「数据不可全信」时出现，说清是哪一段坏了。
 *
 * 刻意做成顶部一条而不是页脚小字：这条信息一旦被忽略，
 * 后面所有数字的解读都会错。
 */
export function TrustBanner({
  worst,
  streamOk,
  readingAge,
  forecastAge,
  hint,
  action,
}: {
  worst: Freshness
  streamOk: boolean
  readingAge: Duration | null
  forecastAge: Duration | null
  hint: string
  action?: ReactNode
}) {
  if (worst === 'live' && streamOk) return null
  const critical = worst === 'stalled' || !streamOk
  const bg = critical ? T.levelWeak.red : T.levelWeak.yellow
  const fg = critical ? T.levelInk.red : T.levelInk.yellow
  const ring = critical ? '#fecaca' : '#fde68a'

  const bits: string[] = []
  if (!streamOk) bits.push('事件推送中断')
  if (readingAge != null && worst !== 'live') bits.push(`实测落后 ${fmtDuration(readingAge)}`)
  if (forecastAge != null && worst !== 'live') bits.push(`预测落后 ${fmtDuration(forecastAge)}`)

  return (
    <div
      className="flex items-start gap-2 rounded-control px-3 py-2 text-[12px]"
      style={{ background: bg, color: fg, boxShadow: `inset 0 0 0 1px ${ring}` }}
    >
      <span className="mt-[1px] shrink-0">
        <Icon name="alertTriangle" size={14} />
      </span>
      <div className="min-w-0">
        <span className="font-semibold">{bits.join(' · ') || '数据不可全信'}</span>
        <span className="opacity-80"> — {hint}</span>
      </div>
      {action && <div className="ml-auto shrink-0">{action}</div>}
    </div>
  )
}
