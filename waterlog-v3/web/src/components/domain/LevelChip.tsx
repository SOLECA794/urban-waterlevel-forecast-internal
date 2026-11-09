import type { ReactNode } from 'react'
import { LEVEL_LABEL, type Level } from '../../domain'
import { T } from '../../utils/tokens'

/**
 * 等级徽标族（领域层组件）。
 *
 * 和 primitives 的区别：这些组件**知道「预警等级」是什么**——它们接受 `Level`
 * 而不是 `color: string`，颜色由等级自己决定。把颜色作为 prop 传到页面里，
 * 就等于让每个页面自己解释「红是什么意思」。
 *
 * 配色双轨制（踩过的坑）：色点用饱和色，文字必须用 ink 色。
 * 白底上 #D97706 对比度只有 3.19:1，达不到 WCAG AA 的 4.5:1。
 * 「看得见的颜色」和「读得清的文字」是两件事，不能共用一个色值。
 */

export function LevelChip({ level, score }: { level: Level; score?: number }) {
  const bg = T.levelWeak[level] ?? T.levelWeak.none
  const fg = T.levelInk[level] ?? T.levelInk.none
  const dot = T.level[level] ?? T.level.none
  return (
    <span className="chip" style={{ background: bg, color: fg, boxShadow: `inset 0 0 0 1px ${dot}22` }}>
      {level !== 'none' && <span className="chip-dot" style={{ background: dot }} />}
      {LEVEL_LABEL[level]}
      {score !== undefined && score > 0 && <span className="num opacity-60">{score.toFixed(2)}</span>}
    </span>
  )
}

/** 大号等级标识：详情页头部用，信息层级比 chip 高一档。 */
export function LevelBadge({ level, score }: { level: Level; score?: number }) {
  const fg = T.levelInk[level] ?? T.levelInk.none
  const dot = T.level[level] ?? T.level.none
  return (
    <span
      className="inline-flex items-center gap-2 h-8 pl-2.5 pr-3 rounded-pill text-[13px] font-semibold"
      style={{
        background: T.levelGrad[level] ?? T.levelGrad.none,
        color: fg,
        boxShadow: `inset 0 0 0 1px ${dot}33`,
      }}
    >
      <span className="relative inline-block rounded-full" style={{ width: 9, height: 9, background: dot, color: dot }}>
        {level !== 'none' && <span className="pulse-dot" />}
      </span>
      {LEVEL_LABEL[level]}
      {score !== undefined && score > 0 && (
        <span className="num text-[12px] font-medium opacity-70">{score.toFixed(2)}</span>
      )}
    </span>
  )
}

export function StatusDot({ level, size = 8 }: { level: Level; size?: number }) {
  const color = T.level[level] ?? T.level.none
  return (
    <span
      className="relative inline-block shrink-0"
      style={{ width: size, height: size, borderRadius: 999, background: color, color }}
    >
      {level !== 'none' && <span className="pulse-dot" />}
    </span>
  )
}

export type TagTone = 'neutral' | 'ai' | 'ok' | 'warn' | 'danger'

/** 中性标签。**不接等级**——要显示等级请用 LevelChip，别在这里传一个颜色进来。 */
export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: TagTone }) {
  const map = {
    neutral: { bg: T.levelWeak.none, fg: T.text2, ring: '#e2e8f0' },
    ai: { bg: T.aiWeak, fg: T.aiInk, ring: '#a5f3fc' },
    ok: { bg: '#dcfce7', fg: '#15803d', ring: '#bbf7d0' },
    warn: { bg: T.levelWeak.yellow, fg: T.levelInk.yellow, ring: '#fde68a' },
    danger: { bg: T.levelWeak.red, fg: T.levelInk.red, ring: '#fecaca' },
  }[tone]
  return (
    <span className="chip" style={{ background: map.bg, color: map.fg, boxShadow: `inset 0 0 0 1px ${map.ring}` }}>
      {children}
    </span>
  )
}
