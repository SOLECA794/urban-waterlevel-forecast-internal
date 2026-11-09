import { useMemo } from 'react'
import { useHealth, useOverview } from '../data/queries'
import { useLive } from '../data/live'
import {
  elapsed,
  freshnessOf,
  FRESHNESS_HINT,
  FRESHNESS_LABEL,
  type Duration,
  type Freshness,
  type SimTime,
} from '../domain'

/**
 * 数据可信度（视图层）。
 *
 * 解决的是这个界面最危险的失效模式：**数据坏了，但界面看起来完全正常。**
 * 一张图上的 10 条警报可能来自 2 小时前的缓存，颜色、数字、排版全都对，
 * 值班员没有任何线索能看出来。所以「新鲜度」必须是一个独立的、能被任何页面引用的视图模型，
 * 而不是某个页脚角落里的一行小字。
 */
export interface DataTrust {
  /** 实测数据的新鲜度。 */
  readonly reading: Freshness
  /** 预测（issued_at）的新鲜度。 */
  readonly forecast: Freshness
  /** SSE 推送是否在动。连上但没数据 ≠ 正常。 */
  readonly streamOk: boolean
  /** 三者里最差的那个，顶栏用它决定要不要挂一条横幅。 */
  readonly worst: Freshness
  readonly readingAge: Duration | null
  readonly forecastAge: Duration | null
  readonly label: string
  readonly hint: string
}

const SEVERITY: Record<Freshness, number> = { live: 0, unknown: 1, stale: 2, stalled: 3 }

function worstOf(...list: Freshness[]): Freshness {
  return list.reduce<Freshness>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'live')
}

export function useTrust(): DataTrust {
  const health = useHealth()
  const live = useLive()
  const ov = useOverview()

  return useMemo(() => {
    const now = health.data?.now ?? null
    const rows = ov.data?.rows ?? []

    // 一张图里最新的那条实测时间。用 max 而不是第一条：
    // 各站点推送有先后，取第一条会把整城标成"滞后"，只因为某一站慢了一拍。
    let readingAt = 0 as SimTime
    for (const r of rows) if (r.reading.updatedAt > readingAt) readingAt = r.reading.updatedAt

    const issuedAt = ov.data?.issuedAt ?? null
    const readingAge = now != null && readingAt ? elapsed(now, readingAt) : null
    const forecastAge = now != null && issuedAt ? elapsed(now, issuedAt) : null

    const reading = freshnessOf(readingAge)
    const forecast = freshnessOf(forecastAge)

    // 墙钟判断推送：EventSource 的 connected 只说明 TCP 还连着，
    // 引擎卡住时连接照样是通的，只有"多久没收到事件"能说明问题。
    const streamAgeS = live.lastEventAt ? (Date.now() - live.lastEventAt) / 1000 : Number.POSITIVE_INFINITY
    const streamOk = live.connected && streamAgeS < 30

    const worst = streamOk ? worstOf(reading, forecast) : worstOf(reading, forecast, 'stale')

    const label = streamOk
      ? FRESHNESS_LABEL[worst]
      : live.connected
        ? '推送停滞'
        : '推送断开'
    const hint = streamOk
      ? FRESHNESS_HINT[worst]
      : live.connected
        ? 'SSE 连接还在，但 30 秒内没有收到任何事件——引擎可能卡住了'
        : '浏览器与后端的事件流已断开，页面上的数字不会自己更新'

    return {
      reading,
      forecast,
      streamOk,
      worst,
      readingAge,
      forecastAge,
      label,
      hint,
    }
  }, [health.data, live.connected, live.lastEventAt, ov.data])
}

