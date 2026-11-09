import type { AlarmLevel, Level } from './level'
import { ALARM_LEVELS } from './level'
import type { Rate } from './units'

/**
 * 研判规则。老师的要求是「等级与阈值必须可配置」，
 * 所以这里不是一堆常量，而是**一份可编辑、可校验、可预演的文档**。
 */

export interface FactorWeights {
  readonly peak: number
  readonly duration: number
  readonly trend: number
}

export interface Rules {
  /** 三因子权重，三者之和必须为 1 */
  readonly weights: FactorWeights
  /** 各级要求的最短超阈持续时长（分钟），必须非递减 */
  readonly minDurationMin: Record<AlarmLevel, number>
  /** 持续因子归一化的饱和值：超过它持续因子记满分 */
  readonly durationSaturationMin: number
  /** 综合分 → 等级的分档阈值，必须严格递增 */
  readonly scoreCutoffs: Record<AlarmLevel, number>
  /** 趋势跨档：涨得比它快就升一级 */
  readonly trendUpgradeSlope: Rate
  /** 趋势跨档：退得比它快就降一级 */
  readonly trendDowngradeSlope: Rate
  /** 趋势因子归一化跨度（m/h） */
  readonly trendScoreSpan: number
  /** 研判窗口（分钟），默认 180 = 3h */
  readonly horizonMin: number
  /**
   * 最低报警等级（等级序，不是分值）：1=蓝 2=黄 3=橙 4=红。
   * 判完等级后低于它的一律压成 none，用来把某一级整个关掉。
   * 注意后端存的是整数 1，不是 0~1 的分数——曾经在这里按分值展示，读起来像「0.22 分才报警」。
   */
  readonly minLevelForAlarm: number
}

export interface RuleIssue {
  readonly field: string
  readonly message: string
  readonly severity: 'error' | 'warn'
}

export function weightsSum(w: FactorWeights): number {
  return w.peak + w.duration + w.trend
}

/** 由综合分判定等级。与后端 `rules.py` 的 `_level_from_ratio` 分档逻辑保持同构。 */
export function levelOfScore(score: number, cutoffs: Record<AlarmLevel, number>): Level {
  if (score >= cutoffs.red) return 'red'
  if (score >= cutoffs.orange) return 'orange'
  if (score >= cutoffs.yellow) return 'yellow'
  if (score >= cutoffs.blue) return 'blue'
  return 'none'
}

/** 权重占比，用于画三段条。 */
export function weightShares(w: FactorWeights): { key: keyof FactorWeights; share: number }[] {
  const total = weightsSum(w) || 1
  return (['peak', 'duration', 'trend'] as const).map((key) => ({ key, share: w[key] / total }))
}

export const FACTOR_LABEL: Record<keyof FactorWeights, string> = {
  peak: '预测峰值',
  duration: '超阈时长',
  trend: '变化趋势',
}

/**
 * 规则校验。返回的是**可读的、指向具体字段的**问题列表，
 * 而不是一个 boolean——保存按钮被禁用时必须能说清为什么。
 */
export function validateRules(r: Rules): RuleIssue[] {
  const out: RuleIssue[] = []
  const sum = weightsSum(r.weights)
  if (Math.abs(sum - 1) > 1e-6) {
    out.push({
      field: 'weights',
      message: `三因子权重之和为 ${sum.toFixed(3)}，必须等于 1`,
      severity: 'error',
    })
  }
  for (const k of ['peak', 'duration', 'trend'] as const) {
    if (r.weights[k] < 0) {
      out.push({ field: `weights.${k}`, message: `${FACTOR_LABEL[k]} 权重不能为负`, severity: 'error' })
    }
  }

  let prev = -Infinity
  for (const lv of ALARM_LEVELS) {
    const v = r.scoreCutoffs[lv]
    if (!(v > prev)) {
      out.push({
        field: `score_cutoffs.${lv}`,
        message: `分档阈值必须严格递增：${lv} 的 ${v} 不大于上一级`,
        severity: 'error',
      })
    }
    prev = v
  }
  if (r.scoreCutoffs.red > 1) {
    out.push({ field: 'score_cutoffs.red', message: '红色分档超过 1.0，永远不会触发', severity: 'warn' })
  }

  let prevDur = -Infinity
  for (const lv of ALARM_LEVELS) {
    const v = r.minDurationMin[lv]
    if (v < prevDur) {
      out.push({
        field: `min_duration_min.${lv}`,
        message: `最短持续时长必须非递减：${lv} 的 ${v}min 小于上一级`,
        severity: 'error',
      })
    }
    prevDur = v
  }
  if (r.durationSaturationMin <= 0) {
    out.push({ field: 'duration_saturation_min', message: '持续饱和值必须为正', severity: 'error' })
  }
  if (r.trendUpgradeSlope <= 0) {
    out.push({ field: 'trend_upgrade_slope', message: '升级斜率必须为正（涨才升级）', severity: 'error' })
  }
  if (r.trendDowngradeSlope >= 0) {
    out.push({ field: 'trend_downgrade_slope', message: '降级斜率必须为负（退才降级）', severity: 'error' })
  }
  if (r.horizonMin <= 0) {
    out.push({ field: 'horizon_min', message: '研判窗口必须为正', severity: 'error' })
  }
  return out
}

export function hasError(issues: readonly RuleIssue[]): boolean {
  return issues.some((i) => i.severity === 'error')
}


// ---------------------------------------------------------------- 规则影响预演

/**
 * 一条规则变更落到某个站点上的影响。
 *
 * 为什么要有预演：改分档阈值是一个**不可撤销的业务动作**——保存那一刻全城
 * 10 个站点的预警等级会立刻重算，值班员可能在不知情的情况下把 3 个红警降成黄警。
 * 保存前必须能看见「会变几条、往哪个方向变」。
 */
export interface RuleImpact {
  readonly siteId: string
  readonly name: string
  readonly beforeLevel: Level
  readonly beforeScore: number
  readonly afterLevel: Level
  readonly afterScore: number
  readonly beforeReason: string
  readonly afterReason: string
  readonly direction: 'up' | 'down' | 'same'
}

export interface RulesImpact {
  readonly changes: readonly RuleImpact[]
  readonly summary: {
    readonly upgraded: number
    readonly downgraded: number
    readonly unchanged: number
    readonly total: number
  }
}
