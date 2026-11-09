import { useMemo } from 'react'
import { useOverview } from '../data/queries'
import { isAlarm, isRaining, maxLevel, type Depth, type Level, type SimTime } from '../domain'

/**
 * L1 结论视图：**一条**，回答「现在这座城市什么状况」。
 *
 * 它刻意不持有任何一个站点的明细——L1 被顶栏、态势卡、地图图例同时引用，
 * 如果它带着 L3 的字段，改一次站点卡的排版就会牵动顶栏。
 */

export interface LevelCount {
  readonly level: Level
  readonly count: number
}

export interface SituationSummary {
  readonly hasData: boolean
  /** 全城最高预警等级。 */
  readonly topLevel: Level
  /** 五个等级各自的站点数，顺序固定（none→red），直接可以渲染成条。 */
  readonly counts: readonly LevelCount[]
  /** 处于任一预警等级的站点数（不含 none）。 */
  readonly alarmCount: number
  /** 最深受水。**不是合计**——各站是独立汇水单元，深度相加没有物理含义。 */
  readonly deepest: { readonly value: Depth; readonly siteId: string; readonly siteName: string }
  /** 正在降雨的站点数。 */
  readonly rainingSites: number
  /** 处于最高等级的站点，用来在标题里点名。 */
  readonly topSites: readonly { readonly siteId: string; readonly name: string }[]
  readonly issuedAt: SimTime
  readonly total: number
}

const EMPTY: SituationSummary = {
  hasData: false,
  topLevel: 'none',
  counts: [
    { level: 'none', count: 0 },
    { level: 'blue', count: 0 },
    { level: 'yellow', count: 0 },
    { level: 'orange', count: 0 },
    { level: 'red', count: 0 },
  ],
  alarmCount: 0,
  deepest: { value: 0 as Depth, siteId: '', siteName: '—' },
  rainingSites: 0,
  topSites: [],
  issuedAt: 0 as SimTime,
  total: 0,
}

export function useSituation(): SituationSummary {
  const ov = useOverview()

  return useMemo(() => {
    const rows = ov.data?.rows
    if (!rows || rows.length === 0) return EMPTY

    const tally: Record<Level, number> = { none: 0, blue: 0, yellow: 0, orange: 0, red: 0 }
    let deepest: { value: Depth; siteId: string; siteName: string } = EMPTY.deepest
    let raining = 0

    for (const r of rows) {
      tally[r.assessment.level] += 1
      if (isRaining(r.reading.rain)) raining += 1
      if (r.reading.depth > deepest.value) {
        deepest = { value: r.reading.depth, siteId: r.site.id, siteName: r.site.name }
      }
    }

    const topLevel = maxLevel(rows.map((r) => r.assessment.level))
    const topSites =
      topLevel === 'none'
        ? []
        : rows
            .filter((r) => r.assessment.level === topLevel)
            .sort((a, b) => b.assessment.score - a.assessment.score)
            .map((r) => ({ siteId: r.site.id, name: r.site.name }))

    return {
      hasData: true,
      topLevel,
      counts: [
        { level: 'none', count: tally.none },
        { level: 'blue', count: tally.blue },
        { level: 'yellow', count: tally.yellow },
        { level: 'orange', count: tally.orange },
        { level: 'red', count: tally.red },
      ],
      alarmCount: rows.filter((r) => isAlarm(r.assessment.level)).length,
      deepest,
      rainingSites: raining,
      topSites,
      issuedAt: ov.data?.issuedAt ?? (0 as SimTime),
      total: rows.length,
    }
  }, [ov.data])
}

/** 站点名列表 → 「A、B 等 3 处」。标题里点名用，别把 10 个名字都铺上去。 */
export function nameList(names: readonly string[], max = 2): string {
  if (names.length === 0) return ''
  if (names.length <= max) return names.join('、')
  return `${names.slice(0, max).join('、')} 等 ${names.length} 处`
}
