import { useMemo } from 'react'
import { useOverview } from '../data/queries'
import {
  isAlarm,
  isRaining,
  LEVEL_RANK,
  redThreshold,
  type Assessment,
  type Meters,
  type Reading,
  type Site,
} from '../domain'

/**
 * L3 明细视图：**每个站点一条**，回答「这个站具体多深、多急」。
 *
 * 和 L1 的区别：L1 是全城一条结论，L3 是十行可排序的明细。
 * 和 L4 的区别：L3 不带研判依据原文、不带曲线——那些只在详情页（L4）出现。
 *
 * 排序放在这里而不是页面里，是因为「按什么排」是数据视图的属性，
 * 不是布局的属性；以前一张图的关注清单和站点表各写了一遍排序，两处规则已经不一致了。
 */

export type WatchSort = 'level' | 'depth' | 'trend' | 'rain'

export const SORT_LABEL: Record<WatchSort, string> = {
  level: '按预警等级',
  depth: '按积水深',
  trend: '按 1h 涨速',
  rain: '按雨强',
}

export interface SiteGlance {
  readonly site: Site
  readonly reading: Reading
  readonly assessment: Assessment
  /** 该站的红阈值（具名取，不是 `thresholds[3]`）。 */
  readonly redThreshold: Meters
  /** 占红阈的比例，0~1+。**只用于画进度条**，判定等级请用 assessment.level。 */
  readonly depthRatio: number
  readonly isAlarm: boolean
  readonly raining: boolean
}

function glance(row: {
  site: Site
  reading: Reading
  assessment: Assessment
}): SiteGlance {
  const red = redThreshold(row.site.thresholds)
  return {
    site: row.site,
    reading: row.reading,
    assessment: row.assessment,
    redThreshold: red,
    depthRatio: red > 0 ? Math.max(0, row.reading.depth / red) : 0,
    isAlarm: isAlarm(row.assessment.level),
    raining: isRaining(row.reading.rain),
  }
}

function compare(sort: WatchSort) {
  return (a: SiteGlance, b: SiteGlance): number => {
    switch (sort) {
      case 'depth':
        return b.reading.depth - a.reading.depth
      case 'trend':
        return b.reading.trend1h - a.reading.trend1h
      case 'rain':
        return b.reading.rain - a.reading.rain
      case 'level':
      default:
        // 同档里比**绝对水深**，再比综合分。
        // 综合分里含时长与趋势（退水的站会被压低），可三个红色站摆在一起时，
        // 值班员要先去的是水最深那一个，不是分数最高的那一个。实测撞到过
        // 3.18m 排在 0.88m 后面。用绝对水深而不是"超红阈倍数"，是因为跨站
        // 比较时人读的是米：台州 3.14m 与西城 2.80m 摆一起，说前者更严重
        // 没人会反对；按倍数排则可能选出 2.80m 那个，与左栏第一行打架。
        return (
          LEVEL_RANK[b.assessment.level] - LEVEL_RANK[a.assessment.level] ||
          b.reading.depth - a.reading.depth ||
          b.assessment.score - a.assessment.score
        )
    }
  }
}

export function useWatchlist(sort: WatchSort = 'level'): readonly SiteGlance[] {
  const ov = useOverview()
  return useMemo(() => {
    const rows = ov.data?.rows
    if (!rows) return []
    return rows.map(glance).sort(compare(sort))
  }, [ov.data, sort])
}

/**
 * 值班关注清单：只取最该看的 N 个。
 *
 * 排序口径固定为「等级优先、同等级比综合分」，不跟随用户的表格排序——
 * 这块面板的语义是「不管你在看什么，这五个最该管」。
 */
export function useTopWatch(n = 5): readonly SiteGlance[] {
  const list = useWatchlist('level')
  return useMemo(() => list.filter((g) => g.isAlarm).slice(0, n), [list, n])
}
