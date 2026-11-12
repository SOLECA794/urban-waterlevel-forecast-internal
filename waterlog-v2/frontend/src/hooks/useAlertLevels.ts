// 预警等级统一入口：阈值由后端规则表推导（GET /alert-levels）
import { useAlertLevelsQuery } from '@/api/queries'
import type { AlertLevel } from '@/api/types'

export function useAlertLevels() {
  const { data: levels = [], isLoading } = useAlertLevelsQuery()

  const getThresholdLines = () =>
    levels.map((l) => ({
      rank: l.rank,
      color: l.color,
      value: l.waterLevelThreshold,
      name: l.name,
    }))

  /** 按等级 rank（1..4）取配置，越界时钳制到最高/最低级 */
  const getLevelByRank = (rank: number | null | undefined): AlertLevel | undefined => {
    if (rank === null || rank === undefined || levels.length === 0) return undefined
    const hit = levels.find((l) => l.rank === rank)
    if (hit) return hit
    if (rank > levels[levels.length - 1].rank) return levels[levels.length - 1]
    return levels[0]
  }

  const getLevelByKey = (key: string | null | undefined): AlertLevel | undefined =>
    key ? levels.find((l) => l.levelKey === key) : undefined

  return { levels, loading: isLoading, getThresholdLines, getLevelByRank, getLevelByKey }
}
