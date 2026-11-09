import {
  fmtMinutes,
  fmtPct,
  type Assessment,
  type Factors,
  type Level,
} from '../../domain'
import { T } from '../../utils/tokens'
import { Icon } from '../primitives/Icons'
import { Meter } from '../primitives/Bits'
import { LevelChip } from './LevelChip'

/**
 * 三因子研判的展示（领域层）。
 *
 * 关键设计：**综合分不是结论，三个因子才是。**
 * 一个 0.79 分只告诉你「该不该报」，但值班员真正要决策的是「要不要封路」——
 * 那取决于峰值有多高、泡了多久、还在涨还是已经退了。
 * 所以因子条必须和总分同时在场，而且各自的颜色要说明它单独看有多严重。
 */

/** 四个因子的中文名。`FACTOR_LABEL` 只覆盖三个权重因子，
 *  综合分不是权重因子，所以这里单列一张表，而不是给 domain 的类型加一个假成员。 */
const FACTOR_ORDER: (keyof Factors)[] = ['peak', 'duration', 'trend', 'score']

const FACTOR_TEXT: Record<keyof Factors, string> = {
  peak: '预测峰值',
  duration: '超阈时长',
  trend: '变化趋势',
  score: '综合分',
}

function factorColor(key: keyof Factors, f: Factors, a: Assessment): string {
  if (key === 'trend') {
    // 趋势因子：正的（在涨）是坏，负的（在退）是好。这里 f.trend 已归一化到 0~1。
    return f.trend >= 0.66 ? T.level.red : f.trend >= 0.33 ? T.level.yellow : T.success
  }
  if (key === 'peak') return T.level[a.peakLevel] ?? T.level.none
  if (key === 'score') return T.level[a.level] ?? T.level.none
  return T.level.yellow
}

export function FactorBars({ assessment, compact = false }: { assessment: Assessment; compact?: boolean }) {
  return (
    <div className={compact ? 'space-y-2' : 'space-y-2.5'}>
      {FACTOR_ORDER.map((k) => {
        const v = assessment.factors[k]
        const color = factorColor(k, assessment.factors, assessment)
        return (
          <div key={k} className="grid grid-cols-[62px_1fr_44px] items-center gap-2">
            <span className="text-[11px] text-ink-3">{FACTOR_TEXT[k]}</span>
            <Meter value={v} color={color} height={6} ticks={[0.25, 0.5, 0.75]} />
            <span className="num text-[11px] text-right" style={{ color: k === 'score' ? T.text1 : T.text2 }}>
              {v.toFixed(2)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** 研判依据：一句话原文 + 三个可核对的量。这段文字是引擎算出来的，前端不加工。 */
export function AssessmentReason({ assessment }: { assessment: Assessment }) {
  return (
    <div className="flex items-start gap-2 rounded-control p-2.5" style={{ background: T.bgCanvas ?? '#f5f7fa' }}>
      <span className="mt-[1px] shrink-0" style={{ color: T.aiInk }}>
        <Icon name="sparkles" size={13} />
      </span>
      <div className="min-w-0 space-y-1">
        <div className="text-[12px] leading-relaxed text-ink-2">{assessment.reason}</div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3 num">
          <span>峰值 {assessment.peakValue.toFixed(2)}m</span>
          <span>超阈 {fmtMinutes(assessment.durationMin)}</span>
          <span>
            趋势 {assessment.slope > 0 ? '+' : ''}
            {assessment.slope.toFixed(2)} m/h
          </span>
          <span>研判窗口 {fmtMinutes(assessment.horizonMin || 180)}</span>
        </div>
      </div>
    </div>
  )
}

/** 两道硬约束被触发时的说明。为什么只能降不能升，见 docs/01。 */
export function BlockedNote({ blockedBy }: { blockedBy: string | null }) {
  if (!blockedBy) return null
  return (
    <div
      className="flex items-center gap-1.5 rounded-control px-2 py-1.5 text-[11px]"
      style={{ background: T.levelWeak.yellow, color: T.levelInk.yellow }}
    >
      <Icon name="shield" size={12} />
      已按硬约束下调：{blockedBy}
    </div>
  )
}

/** 三因子一行摘要：表格里用，不占三行。 */
export function FactorSummary({ assessment }: { assessment: Assessment }) {
  const f = assessment.factors
  const cells: { k: keyof Factors; text: string }[] = [
    { k: 'peak', text: `峰 ${fmtPct(f.peak, 0)}` },
    { k: 'duration', text: `久 ${fmtPct(f.duration, 0)}` },
    { k: 'trend', text: `势 ${fmtPct(f.trend, 0)}` },
  ]
  return (
    <div className="flex items-center gap-2 text-[11px] num text-ink-3">
      {cells.map((c) => (
        <span key={c.k}>{c.text}</span>
      ))}
    </div>
  )
}

/** 等级 + 因子 + 分值，详情页头部那一行。 */
export function AssessmentHeadline({ assessment }: { assessment: Assessment }) {
  const levelColor = T.level[assessment.level] ?? T.level.none
  return (
    <div className="flex items-center gap-2">
      <LevelChip level={assessment.level} score={assessment.score} />
      <span className="text-[11px] text-ink-3">
        峰值等级 <span style={{ color: T.levelInk[assessment.peakLevel] }}>{levelText(assessment.peakLevel)}</span>
      </span>
      <span className="chip-dot" style={{ background: levelColor }} />
    </div>
  )
}

function levelText(l: Level): string {
  return { none: '无', blue: '蓝', yellow: '黄', orange: '橙', red: '红' }[l]
}

