// GisMap - MapLibre GL JS + 三级降级（真实数据版）
// L1 天地图栅格（token 走环境变量 VITE_TIANDITU_TOKEN，未配置时直接跳过）
//    → L2 OSM 栅格 → L3 SVG 平面示意
// 修复清单：
//  ③ 降级链僵尸实例：mapRef 唯一持有当前实例，降级前 remove 并置空，cleanup 只清 mapRef.current
//  ④ 瓦片错误计数跨降级不重置：每次降级清零，按连续错误判定
//  ⑤ initMap catch 无限递归：降级深度硬限制（styleChain 数组顺序推进，最多 2 次降级）
//  ⑦ 天地图 token 硬编码：改读 import.meta.env.VITE_TIANDITU_TOKEN
//  坐标适配：地图中心/缩放与 SVG 降级映射均按实际站点经纬度动态计算（不再假设北京坐标）
import { MAP, HEX } from '@/utils/tokens'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useAlertLevels } from '@/hooks/useAlertLevels'

// 地图站点视图（由设备 + 最新遥测 + 当前最高告警等级组装）
export interface MapStation {
  stationId: number
  stationName: string
  lat: number
  lng: number
  currentLevel?: number | null
  alertLevel?: number | null   // 0..3，null 表示无生效告警
}

type MapLevel = 'vector' | 'raster' | 'svg'

interface GisMapProps {
  stations: MapStation[]
  height?: number | string
  darkMode?: boolean
  onStationClick?: (station: MapStation) => void
}

const TDT_TOKEN = (import.meta.env.VITE_TIANDITU_TOKEN as string | undefined) || ''

const tdtTiles = (tk: string) =>
  `https://t0.tianditu.gov.cn/vec_w/wmts?layer=vec&style=default&tilematrixset=w&Service=WMTS&Request=GetTile&Version=1.0.0&Format=tiles&TileMatrix={z}&TileCol={x}&TileRow={y}&tk=${tk}`

// L1 天地图（仅在配置了 token 时可用）
const buildTdtStyle = (): any => ({
  version: 8,
  sources: {
    'tdt-vec': { type: 'raster', tiles: [tdtTiles(TDT_TOKEN)], tileSize: 256, attribution: '© 天地图' },
  },
  layers: [{ id: 'tdt-vec-layer', type: 'raster', source: 'tdt-vec', minzoom: 0, maxzoom: 18 }],
})

// L2 OSM 栅格
const OSM_STYLE: any = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
}

const buildDarkStyle = (inner: any, sourceId: string): any => ({
  ...inner,
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': MAP.darkBg } },
    {
      id: 'dark-overlay',
      type: 'raster',
      source: sourceId,
      paint: { 'raster-opacity': 0.35, 'raster-saturation': -0.7 },
    },
  ],
})

// 站点经纬度有效集合
const validCoords = (stations: MapStation[]): { lng: number; lat: number; s: MapStation }[] =>
  stations
    .filter((s) => Number.isFinite(s.lng) && Number.isFinite(s.lat))
    .map((s) => ({ lng: s.lng, lat: s.lat, s }))

// 动态中心点与缩放（按站点跨度）
function computeViewport(coords: { lng: number; lat: number }[]) {
  if (coords.length === 0) return { center: [120.19, 30.26] as [number, number], zoom: 12 }
  const lons = coords.map((c) => c.lng)
  const lats = coords.map((c) => c.lat)
  const center: [number, number] = [
    (Math.min(...lons) + Math.max(...lons)) / 2,
    (Math.min(...lats) + Math.max(...lats)) / 2,
  ]
  const span = Math.max(Math.max(...lons) - Math.min(...lons), Math.max(...lats) - Math.min(...lats))
  // 经验映射：跨度越小缩放越大（0.02° → ~13，0.5° → ~10）
  const zoom = span <= 0 ? 13 : Math.min(14, Math.max(9, Math.round(14 - Math.log2(span / 0.02))))
  return { center, zoom }
}

export const GisMap: React.FC<GisMapProps> = ({ stations, height = '100%', darkMode = false, onStationClick }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  const [mapLevel, setMapLevel] = useState<MapLevel>('svg')
  const [mapReady, setMapReady] = useState(false)
  const [fallbackInfo, setFallbackInfo] = useState<string>('')
  // 在线底图按需加载：默认走离线平面示意，避免政务内网/无外网时首屏长时间空转。
  // EXT-POINT(INTEGRATION): 接入内网瓦片服务后可将初始值改为 true 并用内网 style。
  const [wantMap, setWantMap] = useState(false)
  // 每次点击"加载在线底图"递增，用于重新触发初始化（降级到 SVG 后可再次尝试）
  const [mapAttempt, setMapAttempt] = useState(0)
  const { getLevelByRank } = useAlertLevels()

  const coords = useMemo(() => validCoords(stations), [stations])
  const viewport = useMemo(() => computeViewport(coords), [coords])

  // ---- 初始化与降级链（修复 ③④⑤⑦）----
  useEffect(() => {
    // 未请求在线底图：保持平面示意，不发起任何外部瓦片请求
    if (!wantMap) return
    if (!containerRef.current) return
    let cancelled = false

    // 降级链：按序推进，无递归
    const chain: { style: any; level: MapLevel; label: string }[] = []
    if (TDT_TOKEN) chain.push({ style: darkMode ? buildDarkStyle(buildTdtStyle(), 'tdt-vec') : buildTdtStyle(), level: 'vector', label: '天地图' })
    chain.push({ style: darkMode ? buildDarkStyle(OSM_STYLE, 'osm') : OSM_STYLE, level: 'raster', label: 'OpenStreetMap' })

    let chainIndex = 0
    let errorCount = 0
    let loaded = false
    // 看门狗句柄：每级降级链单独计时（只在入口设一次会导致降级到第二级后永久卡住）
    let watchdog: number | undefined
    // 跟踪当前实例（含尚未触发 load 的）——StrictMode 双挂载/快速卸载时也能正确销毁，杜绝僵尸实例
    let currentMap: maplibregl.Map | null = null

    const destroyCurrentMap = () => {
      // 修复 ③：只销毁当前实例（闭包 currentMap + mapRef 各清一次，可能为同一实例）
      for (const m of [currentMap, mapRef.current]) {
        if (m) { try { m.remove() } catch { /* 已销毁则忽略 */ } }
      }
      currentMap = null
      mapRef.current = null
      markersRef.current.forEach((m) => { try { m.remove() } catch { /* ignore */ } })
      markersRef.current = []
      setMapReady(false)
    }

    const stepDown = (reason: string) => {
      if (cancelled) return
      window.clearTimeout(watchdog)
      destroyCurrentMap()
      errorCount = 0 // 修复 ④：每次降级清零错误计数
      loaded = false // 下一级重新计时，否则看门狗会被上一级的 loaded 挡住
      chainIndex += 1
      if (chainIndex >= chain.length) {
        setFallbackInfo(reason)
        setMapLevel('svg')
        return
      }
      setFallbackInfo(reason)
      initMap()
    }

    const initMap = () => {
      if (cancelled || !containerRef.current || chainIndex >= chain.length) return
      window.clearTimeout(watchdog)
      const { style, level } = chain[chainIndex]
      let map: maplibregl.Map
      try {
        map = new maplibregl.Map({
          container: containerRef.current,
          style,
          center: viewport.center,
          zoom: viewport.zoom,
          attributionControl: { compact: true },
        })
      } catch (err) {
        console.error('[GisMap] init failed', err)
        stepDown('地图初始化失败')
        return // 修复 ⑤：不再递归调用，统一走 stepDown 顺序降级
      }
      currentMap = map
      // 每一级各自挂 6s 看门狗：无外网瓦片时逐级降级直到 SVG，不会中途停住
      watchdog = window.setTimeout(() => {
        if (!cancelled && !loaded) stepDown('地图加载超时')
      }, 6000)
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
      map.on('load', () => {
        if (cancelled) { try { map.remove() } catch { /* ignore */ } return }
        loaded = true
        errorCount = 0
        mapRef.current = map
        setMapLevel(level)
        setMapReady(true)
      })
      map.on('error', (e: any) => {
        if (cancelled || loaded) return
        errorCount += 1
        // 连续 3 次瓦片错误判定该级不可用（避免单瓦片抖动误降级）
        if (errorCount >= 3) {
          const name = chain[chainIndex]?.label ?? '地图服务'
          stepDown(`${name}瓦片连续加载失败，已降级`)
        } else {
          console.warn(`[GisMap] tile error (${errorCount}/3)`, e?.error?.message ?? e)
        }
      })
    }

    initMap()

    return () => {
      cancelled = true
      window.clearTimeout(watchdog)
      destroyCurrentMap() // 修复 ③：cleanup 只清 mapRef.current，不碰已被降级抛弃的实例
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [darkMode, viewport.center[0], viewport.center[1], viewport.zoom, wantMap, mapAttempt])

  /** 加载在线底图：先切回容器态再触发初始化（效果器需容器已挂载） */
  const enableMap = () => {
    setFallbackInfo('')
    setMapLevel('vector')
    setWantMap(true)
    setMapAttempt((n) => n + 1)
  }

  // ---- 标记渲染 ----
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    renderMarkers(map)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, mapReady, mapLevel])

  const markerStyle = (alertLevel: number | null, dark: boolean): { color: string; size: number; pulse: boolean } => {
    const levelCfg = getLevelByRank(alertLevel)
    const hasAlert = alertLevel !== null && alertLevel !== undefined
    return {
      color: hasAlert ? (levelCfg?.color || MAP.darkText) : MAP.muted,
      size: hasAlert && (alertLevel ?? 0) >= 1 ? 16 : 12,
      pulse: hasAlert && (alertLevel ?? 0) >= 2,
    }
  }

  const renderMarkers = (map: maplibregl.Map) => {
    const currentIds = new Set(coords.map((c) => String(c.s.stationId)))
    // 清除已下线的 marker
    markersRef.current = markersRef.current.filter((m) => {
      const sid = m.getElement().dataset.stationId
      if (sid && !currentIds.has(sid)) {
        try { m.remove() } catch { /* ignore */ }
        return false
      }
      return true
    })

    const existingById = new Map<string, maplibregl.Marker>()
    markersRef.current.forEach((m) => {
      const sid = m.getElement().dataset.stationId
      if (sid) existingById.set(sid, m)
    })

    coords.forEach(({ lng, lat, s }) => {
      const { color, size, pulse } = markerStyle(s.alertLevel, darkMode)
      const css = `
        width: ${size}px; height: ${size}px;
        background: ${color};
        border: ${darkMode ? '1px' : '2px'} solid ${darkMode ? MAP.darkBg : '#fff'};
        border-radius: 50%;
        box-shadow: 0 0 ${pulse ? '12px' : '4px'} ${color}80;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        color: white; font-size: 10px; font-weight: 600;
        ${pulse ? 'animation: pulseWarn 1.6s ease-in-out infinite;' : ''}
        transition: transform 0.2s;
      `
      const title = `${s.stationName} - 当前水位 ${s.currentLevel?.toFixed(2) ?? '—'}m`
      const label = s.alertLevel !== null && s.alertLevel !== undefined ? String(s.alertLevel) : '·'

      let marker = existingById.get(String(s.stationId))
      if (marker) {
        const el = marker.getElement()
        el.style.cssText = css
        el.textContent = label
        el.title = title
        marker.setLngLat([lng, lat])
      } else {
        const el = document.createElement('div')
        el.className = 'station-marker'
        el.dataset.stationId = String(s.stationId)
        el.style.cssText = css
        el.textContent = label
        el.title = title
        el.onmouseenter = () => { el.style.transform = 'scale(1.3)' }
        el.onmouseleave = () => { el.style.transform = 'scale(1)' }
        el.onclick = () => onStationClick?.(s)
        marker = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([lng, lat])
          .addTo(map)
        markersRef.current.push(marker)
      }
    })
  }

  // ---- L3 降级：SVG 平面示意（动态坐标映射） ----
  if (mapLevel === 'svg') {
    // 站点经纬度包围盒（含 20% 边距），映射到 800x500 画布
    const lons = coords.map((c) => c.lng)
    const lats = coords.map((c) => c.lat)
    const minLng = Math.min(...lons, viewport.center[0] - 0.02)
    const maxLng = Math.max(...lons, viewport.center[0] + 0.02)
    const minLat = Math.min(...lats, viewport.center[1] - 0.02)
    const maxLat = Math.max(...lats, viewport.center[1] + 0.02)
    const padX = (maxLng - minLng) * 0.2 || 0.01
    const padY = (maxLat - minLat) * 0.2 || 0.01
    const x0 = minLng - padX, x1 = maxLng + padX
    const y0 = minLat - padY, y1 = maxLat + padY
    const toX = (lng: number) => ((lng - x0) / (x1 - x0)) * 760 + 20
    const toY = (lat: number) => ((y1 - lat) / (y1 - y0)) * 460 + 20

    return (
      <div style={{ width: '100%', height, position: 'relative', background: darkMode ? MAP.darkBg : MAP.lightBg }} className="flex items-center justify-center">
        <div className="absolute top-2 left-2 z-10 flex items-center gap-2">
          <span
            className="text-xs px-2 py-1 rounded border"
            style={fallbackInfo
              ? { background: MAP.warnBg, color: MAP.warnInk, borderColor: MAP.warnBorder }
              : { background: darkMode ? MAP.darkSurface : MAP.lightBg, color: darkMode ? MAP.darkText : MAP.lightText, borderColor: darkMode ? MAP.darkBorder : MAP.lightBorder }}
          >
            {fallbackInfo ? `⚠ 离线降级：${fallbackInfo}` : '平面示意图（离线渲染，未请求外部瓦片）'}
          </span>
          <button
            type="button"
            onClick={enableMap}
            className="text-xs px-2 py-1 rounded border cursor-pointer"
            style={{ background: darkMode ? MAP.darkBg : '#fff', color: darkMode ? MAP.accentSoft : HEX.primary, borderColor: darkMode ? MAP.darkBorder : MAP.primaryWeakBorder }}
          >
            {fallbackInfo ? '重试在线底图' : '加载在线底图'}
          </button>
        </div>
        <svg viewBox="0 0 800 500" style={{ width: '100%', height: '100%' }} className="opacity-90">
          <rect width="800" height="500" fill={darkMode ? MAP.darkBg : MAP.lightBorderSoft} />
          {/* 研究区域边界 */}
          <path
            d={`M ${toX(x0)} ${toY(y1)} L ${toX(x1)} ${toY(y1)} L ${toX(x1)} ${toY(y0)} L ${toX(x0)} ${toY(y0)} Z`}
            fill="none" stroke={darkMode ? MAP.darkBorder : MAP.darkText} strokeWidth="2" strokeDasharray="4 4"
          />
          {/* 内圈示意网格 */}
          <ellipse
            cx={(toX(x0) + toX(x1)) / 2} cy={(toY(y0) + toY(y1)) / 2}
            rx={(toX(x1) - toX(x0)) * 0.32} ry={(toY(y0) - toY(y1)) * 0.32}
            fill="none" stroke={darkMode ? MAP.lightText : MAP.lightBorder} strokeWidth="1"
          />
          <ellipse
            cx={(toX(x0) + toX(x1)) / 2} cy={(toY(y0) + toY(y1)) / 2}
            rx={(toX(x1) - toX(x0)) * 0.46} ry={(toY(y0) - toY(y1)) * 0.46}
            fill="none" stroke={darkMode ? MAP.lightText : MAP.lightBorder} strokeWidth="1"
          />
          {coords.map(({ lng, lat, s }) => {
            const x = toX(lng)
            const y = toY(lat)
            const levelCfg = getLevelByRank(s.alertLevel)
            const color = s.alertLevel !== null && s.alertLevel !== undefined
              ? (levelCfg?.color || MAP.darkText) : MAP.muted
            const hot = s.alertLevel !== null && s.alertLevel !== undefined && s.alertLevel >= 3
            return (
              <g key={s.stationId} style={{ cursor: 'pointer' }} onClick={() => onStationClick?.(s)}>
                <circle cx={x} cy={y} r={hot ? 10 : 7} fill={color} stroke={darkMode ? MAP.darkBg : '#fff'} strokeWidth="2" />
                {hot && <circle cx={x} cy={y} r="14" fill="none" stroke={color} strokeWidth="1" opacity="0.5" />}
                <text x={x} y={y + 3} textAnchor="middle" fontSize="9" fill="white" fontWeight="600">
                  {s.alertLevel !== null && s.alertLevel !== undefined ? s.alertLevel : '·'}
                </text>
                <text x={x} y={y - 12} textAnchor="middle" fontSize="8" fill={darkMode ? MAP.darkText : MAP.lightText}>
                  {s.stationName}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    )
  }

  return (
    <div style={{ width: '100%', height, position: 'relative', background: darkMode ? MAP.darkBg : MAP.lightBg }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {/* 加载占位：瓦片就绪前不允许白板（契约 §8） */}
      {!mapReady && (
        <div className="map-loading-placeholder" style={darkMode ? { background: MAP.darkBg, color: MAP.darkText } : undefined}>
          地图加载中，若长时间无瓦片将自动降级为平面示意…
        </div>
      )}
      {!TDT_TOKEN && mapLevel === 'raster' && (
        <div className="absolute top-2 left-2 z-10 bg-blue-50 text-blue-800 text-xs px-2 py-1 rounded border border-blue-200 max-w-xs">
          未配置天地图 token（VITE_TIANDITU_TOKEN），使用 OpenStreetMap 栅格瓦片
        </div>
      )}
      {fallbackInfo && mapReady && (
        <div className="absolute top-2 left-2 z-10 bg-orange-50 text-orange-800 text-xs px-2 py-1 rounded border border-orange-200 max-w-xs">
          ⚠ {fallbackInfo}
        </div>
      )}
    </div>
  )
}
