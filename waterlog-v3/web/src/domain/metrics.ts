import type { SimTime } from './time'
import type { Meters } from './units'

/**
 * 模型质量。这里把「离线指标」「在线滚动」「预测-实际配对」三种口径分开建模，
 * 因为它们回答三个不同的问题：
 *
 * - 离线：这个模型在历史数据上有多准？（可以刷，不能证明现在准）
 * - 在线滚动：最近几小时的实盘误差是多少？（唯一能证伪离线指标的）
 * - 配对：某一条预测具体错多少？（用于看散点、找系统性偏差）
 */

/** 四个模型族。展示顺序即可信度顺序。 */
export const MODEL_FAMILIES = ['persistence', 'linear', 'gbr', 'blend'] as const
export type ModelFamily = (typeof MODEL_FAMILIES)[number]

export const MODEL_LABEL: Record<ModelFamily, string> = {
  persistence: '持久化',
  linear: '线性外推',
  gbr: '梯度提升',
  blend: '融合（采纳）',
}

export const MODEL_HINT: Record<ModelFamily, string> = {
  persistence: '假设水位不变，是所有预测的最低及格线',
  linear: '按当前斜率外推，涨水期尚可，退水期会一路外推到负值',
  gbr: '44 维特征的梯度提升树，按预见期各训一个',
  blend: 'gradient 与持久化按站点×预见期加权，权重越高越信任模型',
}

/** 一行离线指标（某个模型族在某个预见期上）。 */
export interface MetricRow {
  readonly horizonMin: number
  readonly rmse: Meters
  readonly mae: Meters
  readonly mape: number
  readonly nse: number
  /** 相对持久化基线的技巧分：>0 才比"水位不变"更准 */
  readonly skill: number
  readonly crps: Meters
  /** 90% 区间的实际覆盖率，**比例**（0.9236 表示 92.36%），理想 0.9 */
  readonly picp90: number
  /** 区间宽度，越窄越好（在覆盖率达标前提下） */
  readonly pinaw: number
  readonly n: number
  readonly eventN: number
  readonly eventRmse: Meters
  readonly eventSkill: number
}

/**
 * 事件样本指标。为什么单报：把 12 天全样本混在一起时，
 * 大量平静时段会让所有模型看起来都很好；只看"预见期末确实超了蓝阈"的样本，
 * 才是真正决定报警对不对的那批。线性外推在这批样本上 skill 是负的。
 */
export interface MetricsBundle {
  readonly version: string
  readonly trainedAt: SimTime
  readonly trainSeconds: number
  readonly nTrain: number
  readonly nValid: number
  readonly folds: number
  readonly nFeatures: number
  /** 预见期 → 站点 → 融合权重 w（w 越高越信任模型，1 表示完全用模型） */
  readonly weights: Readonly<Record<string, Readonly<Record<string, number>>>>
  readonly metrics: Readonly<Record<string, readonly MetricRow[]>>
  readonly featureImportance: readonly { name: string; importance: number }[]
}

export interface MetricsHistoryItem {
  readonly version: string
  readonly trainedAt: SimTime
  readonly rmse3h: Meters
  readonly skill3h: number
}

/** 在线滚动评估：最近窗口内已结算预测的误差。 */
export interface RollingStat {
  readonly n: number
  readonly rmse: Meters
  readonly mae: Meters
  readonly bias: Meters
  /** 持久化基线在同一批样本上的 RMSE */
  readonly baselineRmse: Meters
  /** 1 - rmse/baselineRmse */
  readonly skill: number
  readonly p95Abs: Meters
}

export interface Metrics {
  readonly latest: MetricsBundle
  readonly history: readonly MetricsHistoryItem[]
  readonly rolling: Readonly<Record<string, RollingStat>>
  readonly rollingWindowH: number
}

/** 预测-实际配对（散点图与残差分析的原料）。 */
export interface EvalPair {
  readonly targetAt: SimTime
  readonly siteId: string
  readonly horizonMin: number
  readonly model: string
  readonly yhat: Meters
  readonly lower: Meters
  readonly upper: Meters
  readonly actual: Meters | null
  /** 发布预测那一刻的实测水位，即持久化基线的参照值 */
  readonly originLevel: Meters | null
  readonly baseLevel: Meters
}

export interface DecisionRow {
  readonly ts: SimTime
  readonly siteId: string
  readonly shouldForecast: boolean
  readonly model: string | null
  readonly correctionGain: number | null
  readonly reason: string
  readonly signals: Readonly<Record<string, number>>
}

// ---------------------------------------------------------------- 版本治理

/** 一个可采纳的模型版本。 */
export interface ModelVersion {
  readonly version: string
  readonly trainedAt: SimTime | null
  readonly active: boolean
  /** 3h 的 RMSE 与 skill，用来比较版本优劣；缺失表示该版本没有指标记录 */
  readonly rmse3h: Meters | null
  readonly skill3h: number | null
  readonly trainSeconds: number | null
}

export type RetrainStatus = 'idle' | 'running' | 'done' | 'failed'

export interface RetrainState {
  readonly status: RetrainStatus
  readonly startedAt: SimTime | null
  readonly version: string | null
  readonly seconds: number | null
  readonly error: string | null
}

/** 按预见期排序后的指标行（后端给的是数组，但不保证顺序）。 */
export function sortedRows(rows: readonly MetricRow[] | undefined): MetricRow[] {
  if (!rows) return []
  return [...rows].sort((a, b) => a.horizonMin - b.horizonMin)
}

/** 某个预见期上四个模型族的对比，按 MODEL_FAMILIES 顺序。 */
export function compareAt(
  metrics: Readonly<Record<string, readonly MetricRow[]>>,
  horizonMin: number,
): { family: ModelFamily; row: MetricRow }[] {
  const out: { family: ModelFamily; row: MetricRow }[] = []
  for (const family of MODEL_FAMILIES) {
    const row = metrics[family]?.find((r) => r.horizonMin === horizonMin)
    if (row) out.push({ family, row })
  }
  return out
}

/** 采纳模型（blend）在各个预见期上是否都比持久化更准。低于 0 的会被单独标出来。 */
export function regressions(bundle: MetricsBundle): { horizonMin: number; family: ModelFamily; skill: number }[] {
  const out: { horizonMin: number; family: ModelFamily; skill: number }[] = []
  for (const family of MODEL_FAMILIES) {
    for (const row of bundle.metrics[family] ?? []) {
      if (row.skill < 0) out.push({ horizonMin: row.horizonMin, family, skill: row.skill })
    }
  }
  return out.sort((a, b) => a.skill - b.skill)
}
