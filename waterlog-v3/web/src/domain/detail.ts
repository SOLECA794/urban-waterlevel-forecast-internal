import type { SimTime } from './time'
import type { SiteSeries } from './series'
import type { Site } from './site'
import type { SiteForecast } from './forecast'

/**
 * 站点详情页需要的那一份数据：静态属性 + 实测序列 + 当前预测。
 *
 * 它和「一张图的一行」不是同一个东西——一张图要的是**十个站点的一行**（截面），
 * 详情页要的是**一个站点的一整段时间**（时序）。用一个类型同时服务两者，
 * 就会出现「截面视图里塞着一条 289 点的序列」这种浪费，以及「详情页缺字段」的补丁式扩张。
 */
export interface SiteDetailView {
  readonly site: Site
  readonly series: SiteSeries
  readonly forecast: SiteForecast | null
  readonly issuedAt: SimTime | null
  readonly modelVersion: string | null
}
