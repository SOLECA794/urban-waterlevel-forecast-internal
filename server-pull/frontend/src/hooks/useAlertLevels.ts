// Hook: 统一的预警等级消费入口（数据源：GET /alert-levels，随配置持久化）
// 所有依赖预警等级的组件通过此 hook 消费，确保动态 3-5 级联动生效
import { useMemo } from 'react'
import { useSortedLevels } from '@/api/queries'
import type { AlertLevel } from '@/types'

export function useAlertLevels() {
  const levels = useSortedLevels()
  const loading = levels.length === 0

  const getLevelByRank = (rank: number | null | undefined): AlertLevel | undefined => {
    if (rank === null || rank === undefined || levels.length === 0) return undefined
    const found = levels.find((l) => l.rank === rank)
    if (found) return found
    // 越界时 clamp 到最高级（最大 rank）
    const maxLevel = levels.reduce((a, b) => ((a.rank ?? 0) >= (b.rank ?? 0) ? a : b))
    return maxLevel
  }

  const getLevelByThreshold = (waterLevel: number): AlertLevel | undefined => {
    // 从高到低匹配，找到第一个阈值 <= waterLevel 的等级
    const sorted = [...levels].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
    return sorted.find((l) => waterLevel >= l.waterLevelThreshold)
  }

  const getThresholdLines = useMemo(
    () => () =>
      levels.map((l) => ({
        rank: l.rank ?? 0,
        color: l.color,
        value: l.waterLevelThreshold,
        name: l.name,
      })),
    [levels],
  )

  return { levels, loading, getLevelByRank, getLevelByThreshold, getThresholdLines }
}
