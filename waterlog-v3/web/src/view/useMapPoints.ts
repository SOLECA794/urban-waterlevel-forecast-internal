import { useMemo } from 'react'
import { useOverview } from '../data/queries'
import { isAlarm, nonNegative, type Depth, type Level, type Site } from '../domain'

/**
 * L2 空间视图：**每个站点一个坐标点**，回答「哪里」。
 *
 * 刻意只带地图需要的东西：坐标、等级、水深、气泡半径。
 * 不带研判依据、不带序列、不带阈值数组——地图上画不下这些，
 * 带上它们只会让「改地图」和「改站点卡」互相牵连。
 */

export const MAP_W = 1000
export const MAP_H = 520
const PAD_X = 74
const PAD_Y = 58

export interface MapPoint {
  readonly siteId: string
  readonly name: string
  readonly district: string
  readonly x: number
  readonly y: number
  readonly level: Level
  /** 展示用非负水深。 */
  readonly depth: Depth
  readonly radius: number
  readonly isAlarm: boolean
  readonly raining: boolean
}

/**
 * 经纬度 → 画布坐标。
 *
 * 用等距圆柱投影而不是墨卡托：城市尺度（0.1° 量级）两者差异小于一个像素，
 * 而等距圆柱是线性的，气泡之间的相对位置关系和真实距离严格一致。
 * 底图是抽象的，所以这里只需要「相对位置对」，不需要「投影公式正确」。
 */
function projector(sites: readonly Site[]) {
  const lons = sites.map((s) => s.lon)
  const lats = sites.map((s) => s.lat)
  const minLon = Math.min(...lons)
  const maxLon = Math.max(...lons)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const spanLon = maxLon - minLon || 1
  const spanLat = maxLat - minLat || 1
  const innerW = MAP_W - PAD_X * 2
  const innerH = MAP_H - PAD_Y * 2
  return (s: Site): { x: number; y: number } => ({
    x: PAD_X + ((s.lon - minLon) / spanLon) * innerW,
    y: PAD_Y + ((maxLat - s.lat) / spanLat) * innerH,
  })
}

/** 气泡半径：水深越深越大，但封顶——否则红警站点会盖住相邻两个站。 */
function bubbleRadius(depth: Depth, red: number): number {
  const r = red > 0 ? Math.max(0, depth) / red : 0
  return 9 + Math.min(1.15, r) * 13
}

export function useMapPoints(): readonly MapPoint[] {
  const ov = useOverview()

  return useMemo(() => {
    const rows = ov.data?.rows
    if (!rows || rows.length === 0) return []
    const project = projector(rows.map((r) => r.site))
    return rows.map((r) => {
      const { x, y } = project(r.site)
      const d = nonNegative(r.reading.depth)
      return {
        siteId: r.site.id,
        name: r.site.name,
        district: r.site.district,
        x,
        y,
        level: r.assessment.level,
        depth: d,
        radius: bubbleRadius(d, r.site.thresholds.red),
        isAlarm: isAlarm(r.assessment.level),
        raining: r.reading.rain >= 1,
      }
    })
  }, [ov.data])
}

/**
 * 给真地图用的站点数组（不再做等距投影）。
 *
 * `useMapPoints` 那套是给抽象示意图算 x/y 的，真地图只要经纬度——
 * 两个 shape 同时存在是对的：抽象图还在大屏里用，真地图只认坐标。
 */
export function useMapStations(): import('../map/RealMap').MapStation[] {
  const ov = useOverview()
  return useMemo(
    () =>
      (ov.data?.rows ?? []).map((r) => ({
        id: r.site.id,
        name: r.site.name,
        district: r.site.district,
        lon: Number(r.site.lon),
        lat: Number(r.site.lat),
        depth: Number(r.reading.depth),
        level: r.assessment.level,
        rain: Number(r.reading.rain),
      })),
    [ov.data],
  )
}
