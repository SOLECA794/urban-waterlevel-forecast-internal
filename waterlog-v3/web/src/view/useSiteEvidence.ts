import { useMemo } from 'react'
import { useOverview, useSiteDetail } from '../data/queries'
import {
  depthOf,
  EMPTY_ASSESSMENT,
  maxDepth,
  nonNegative,
  redThreshold,
  seriesPeak,
  type Assessment,
  type Depth,
  type Meters,
  type SimTime,
  type Quality,
  type Site,
  type SiteForecast,
  type SiteSeries,
} from '../domain'

/**
 * L4 溯源视图：**一个站点的一条完整证据链**，只在详情页出现。
 *
 * 它把「实测序列 + 当前预测 + 研判结论」合成一份东西，因为值班员在详情页
 * 只关心一个问题：**凭什么判我这一级？** 这三样缺一样就答不上来。
 *
 * 别的页面永远不该引用这个视图——一张图要 10 条，它只需要 L2/L3。
 */

export interface SiteEvidence {
  readonly site: Site
  readonly series: SiteSeries
  readonly forecast: SiteForecast | null
  readonly assessment: Assessment
  readonly nowLevel: Meters
  readonly nowDepth: Depth
  /** 历史窗口内的实测峰值水深。 */
  readonly observedPeak: Depth
  /** 当前预测窗口内的峰值水深。没有预测时为 0。 */
  readonly forecastPeak: Depth
  readonly red: Meters
  readonly issuedAt: SimTime | null
  readonly modelVersion: string | null
  /** 数据质量：取一张图那一行的实测质量，拿不到按 lost 处理。 */
  readonly quality: Quality
}

export interface SiteEvidenceState {
  readonly data: SiteEvidence | null
  readonly isLoading: boolean
  readonly error: string | null
}

export function useSiteEvidence(siteId: string): SiteEvidenceState {
  const detail = useSiteDetail(siteId)
  const ov = useOverview()

  const data = useMemo<SiteEvidence | null>(() => {
    const d = detail.data
    if (!d) return null

    // 研判结论优先取本轮预测算出来的（它是 4 个预见期里 3h 那一份的完整版），
    // 拿不到才退回一张图那一行——一图那行只有分数没有因子分解。
    const row = ov.data?.rows.find((r) => r.site.id === siteId)
    const assessment =
      d.forecast?.assessment ?? row?.assessment ?? EMPTY_ASSESSMENT

    const nowLevel = (d.forecast?.nowLevel ?? row?.reading.level ?? 0) as Meters
    const last = d.series.points[d.series.points.length - 1]
    const liveLevel = (last?.level ?? nowLevel) as Meters

    const forecastPeak = d.forecast
      ? maxDepth(d.forecast.curve.map((p) => depthOf(p.level as Meters, d.site.baseLevel)))
      : (0 as Depth)

    return {
      site: d.site,
      series: d.series,
      forecast: d.forecast,
      assessment,
      nowLevel: liveLevel,
      nowDepth: depthOf(liveLevel, d.site.baseLevel),
      observedPeak: seriesPeak(d.series, d.site.baseLevel),
      forecastPeak,
      red: redThreshold(d.site.thresholds),
      issuedAt: d.issuedAt,
      modelVersion: d.modelVersion,
      quality: row?.reading.quality ?? ({ raw: 0, state: 'lost', label: '无数据' } as Quality),
    }
  }, [detail.data, ov.data, siteId])

  return {
    data,
    isLoading: detail.isLoading,
    error: detail.error ? (detail.error as Error).message : null,
  }
}

/** 展示用：把水深钳到非负，但保留原值用于统计。 */
export function displayDepth(d: Depth): Depth {
  return nonNegative(d)
}
