/**
 * 真实高德地图（Leaflet 版本）。
 *
 * ## 与旧 `board/RealMap.tsx` 的区别
 *
 * 旧的自己拼 `<img>` 瓦片：**只能看**。不能拖、不能滚轮缩放、点标记不会飞过去，
 * 而且它自己都写了注释「站点是 WGS84，高德瓦片是 GCJ-02，国内偏 100~600 米」——
 * 也就是说旧地图上气泡本来就落在隔壁街区。
 *
 * 这个版本：
 * | 能力 | 怎么做 |
 * |---|---|
 * | 拖 / 滚轮缩放 / 双击放大 | Leaflet 原生 |
 * | 点站 → 地图平移过去 | `flyTo`，带缓动，看得见「去哪了」 |
 * | 站点坐标纠偏 | `wgs84ToGcj02`，画之前过一道 |
 * | 气泡大小 = 积水深 | `CircleMarker` 半径按深度 |
 * | 悬停预览 | Leaflet `Tooltip`，不需要 React 状态 |
 * | 外部切换站点（列表点、URL 进入） | `FlyTo` 内部组件监听 `focusId` |
 *
 * 刻意**不用** `Marker` + 自定义 `DivIcon`：几十个 DOM 节点会让拖地图掉帧，
 * `CircleMarker` 走 Canvas/SVG，滚动缩放时稳。
 */
import { useEffect, useMemo, useRef } from 'react'
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMap, ZoomControl } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import type { LatLngExpression } from 'leaflet'
import { wgs84ToGcj02 } from './geo'
import { T } from '../utils/tokens'

export type MapLevel = 'none' | 'blue' | 'yellow' | 'orange' | 'red'

export interface MapStation {
  id: string
  name: string
  district: string
  lon: number
  lat: number
  depth: number
  level: MapLevel
  rain?: number
}

/** 高德矢量底图：`webrd0{1..4}` 是路网版，`style=8` 为路网+地名。 */
const AMAP_TILES = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}'
const AMAP_SUB = ['1', '2', '3', '4']
const AMAP_ATTR = '© 高德地图'

const LEVEL_COLOR: Record<MapLevel, string> = {
  none: '#8497A6',
  blue: '#0284C7',
  yellow: '#C08A00',
  orange: '#EA580C',
  red: '#DC2626',
}

const LEVEL_TEXT: Record<MapLevel, string> = {
  none: '无预警',
  blue: '蓝色预警',
  yellow: '黄色预警',
  orange: '橙色预警',
  red: '红色预警',
}

/** 出现某等级时，光晕比气泡大多少倍——等级越高越"发亮"，隔着屏幕也看得见 */
// 光晕只是「比周围重要」的提示，不是数据。原来 red 放到 2.6 倍，十个站点挤在一起
// 会糊成一片粉雾，把底图路名全盖住——光晕一多就成了噪点，反而看不出哪个最要紧。
const HALO_SCALE: Record<MapLevel, number> = { none: 0, blue: 1.45, yellow: 1.55, orange: 1.7, red: 1.9 }

/** 气泡半径：下限 6px（不给小深度的点消失），随深度增长但压住上限避免糊成一团 */
function bubbleRadius(depth: number): number {
  return Math.max(6, Math.min(24, 6 + depth * 26))
}

/** 内部组件：把「当前焦点站」翻译成地图动作。 */
function FocusController({
  stations,
  focusId,
  onSettled,
}: {
  stations: readonly MapStation[]
  focusId: string | null
  onSettled?: () => void
}) {
  const map = useMap()
  const lastRef = useRef<string | null>(null)

  useEffect(() => {
    if (!focusId || focusId === lastRef.current) return
    const st = stations.find((s) => s.id === focusId)
    if (!st) return
    lastRef.current = focusId
    const [lon, lat] = wgs84ToGcj02(st.lon, st.lat)
    // 17 级能看清路口，且不会因为放太大而只剩一栋楼
    map.flyTo([lat, lon] as LatLngExpression, Math.max(map.getZoom(), 16), { duration: 0.85 })
    // flyTo 是异步的，移完再通知外部（外部用它做「地图已定位」的提示）
    const t = window.setTimeout(() => onSettled?.(), 900)
    return () => window.clearTimeout(t)
  }, [focusId, stations, map, onSettled])

  return null
}

/** 内部组件：滚轮缩放的开关。默认 Leaflet 滚轮缩放会"劫持"页面滚动，
 *  在嵌入式面板里是灾难（用户想滚页面结果地图缩了）。 */
function ScrollZoom({ enabled }: { enabled: boolean }) {
  const map = useMap()
  useEffect(() => {
    if (enabled) map.scrollWheelZoom.enable()
    else map.scrollWheelZoom.disable()
  }, [enabled, map])
  return null
}

/** 内部组件：把所有站点框进视野。
 *  为什么需要：默认 center 取的是十站算术平均，zoom 写死 15。
 *  当站点分布跨度大于视口时，两端的站会跑到屏幕外——用户看到"站点不全"。
 *  fitBounds 让 Leaflet 自己算中心与缩放，配 maxZoom 防止只有一个站点时放到 19 级。 */
function FitBounds({ bounds, fitKey }: { bounds: LatLngExpression[] | null; fitKey: unknown }) {
  const map = useMap()
  const doneRef = useRef<unknown>(null)
  useEffect(() => {
    if (!bounds || bounds.length < 2) return
    if (doneRef.current === fitKey) return
    doneRef.current = fitKey
    const t = window.setTimeout(() => {
      map.fitBounds(bounds as never, { padding: [48, 48], maxZoom: 16, animate: false })
    }, 180)
    return () => window.clearTimeout(t)
  }, [bounds, fitKey, map])
  return null
}

/** 内部组件：容器尺寸变化时让 Leaflet 重算。
 *  抽屉滑出会挤压地图宽度，不重算会出现右侧一块灰色未渲染区。 */
function ResizeKeeper({ deps }: { deps: unknown }) {
  const map = useMap()
  useEffect(() => {
    const t = window.setTimeout(() => map.invalidateSize(), 260)
    return () => window.clearTimeout(t)
  }, [deps, map])
  return null
}

export function RealMap({
  stations,
  focusId = null,
  onPick,
  height = 560,
  interactive = true,
  onSettled,
  fitKey,
}: {
  stations: readonly MapStation[]
  focusId?: string | null
  onPick?: (id: string) => void
  height?: number | string
  /** false 时锁死所有手势（给缩略预览用） */
  interactive?: boolean
  onSettled?: () => void
  /** 变化时重新自动取景（比如切了筛选条件） */
  fitKey?: unknown
}) {
  // 站点是 WGS84，底图是 GCJ-02 —— 不纠偏就偏 100~600 米
  const pts = useMemo(
    () =>
      stations.map((s) => {
        const [lon, lat] = wgs84ToGcj02(s.lon, s.lat)
        return { ...s, glon: lon, glat: lat }
      }),
    [stations],
  )

  const center = useMemo<LatLngExpression>(() => {
    if (!pts.length) return [28.6455, 121.2445]
    const lon = pts.reduce((a, p) => a + p.glon, 0) / pts.length
    const lat = pts.reduce((a, p) => a + p.glat, 0) / pts.length
    return [lat, lon]
  }, [pts])

  const fitLonLat = useMemo(() => {
    if (pts.length < 2) return null
    const lons = pts.map((p) => p.glon)
    const lats = pts.map((p) => p.glat)
    return [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]] as LatLngExpression[]
  }, [pts])

  return (
    <div style={{ position: 'relative', width: '100%', height, borderRadius: 10, overflow: 'hidden', background: '#E6EEF5' }}>
      <MapContainer
        center={center}
        zoom={15}
        style={{ width: '100%', height: '100%' }}
        zoomControl={false}
        attributionControl={false}
        dragging={interactive}
        scrollWheelZoom={false}
        doubleClickZoom={interactive}
        boxZoom={interactive}
        keyboard={interactive}
        touchZoom={interactive}
      >
        <TileLayer url={AMAP_TILES} subdomains={AMAP_SUB} attribution={AMAP_ATTR} maxZoom={18} minZoom={3} />
        <ZoomControl position="bottomright" />
        <ScrollZoom enabled={interactive} />
        <FitBounds bounds={fitLonLat} fitKey={fitKey ?? 'all'} />
        <FocusController stations={pts} focusId={focusId} onSettled={onSettled} />
        <ResizeKeeper deps={`${focusId ?? ''}-${fitKey ?? ''}`} />
        {pts.map((p) => {
          const r = bubbleRadius(p.depth)
          const active = p.id === focusId
          const halo = HALO_SCALE[p.level]
          const color = LEVEL_COLOR[p.level]
          return (
            <CircleMarker
              key={`halo-${p.id}`}
              center={[p.glat, p.glon]}
              radius={halo ? r * halo : 0}
              pathOptions={{
                color,
                weight: 1,
                opacity: 0.3,
                fillColor: color,
                fillOpacity: active ? 0.22 : 0.13,
                // 只有红色站脉动：屏幕上动的必须是最该看的那几个，
                // 十站一起闪等于十站都不闪。
                className: p.level === 'red' ? 'wl-map-pulse' : undefined,
              }}
              interactive={false}
            />
          )
        })}
        {pts.map((p) => {
          const r = bubbleRadius(p.depth)
          const active = p.id === focusId
          const color = LEVEL_COLOR[p.level]
          return (
            <CircleMarker
              key={p.id}
              center={[p.glat, p.glon]}
              radius={active ? r + 3 : r}
              pathOptions={{
                color: active ? T.text1 : '#FFFFFF',
                weight: active ? 2.5 : 1.8,
                fillColor: color,
                fillOpacity: p.level === 'none' ? 0.55 : 0.92,
              }}
              eventHandlers={{ click: () => onPick?.(p.id) }}
            >
              <Tooltip direction="top" offset={[0, -6]} opacity={1} className="wl-map-tip">
                <div style={{ lineHeight: 1.5 }}>
                  <b>{p.name}</b>
                  <div style={{ color: LEVEL_COLOR[p.level], fontWeight: 700, fontSize: 11 }}>
                    {LEVEL_TEXT[p.level]} · 积水 {p.depth.toFixed(2)} m
                  </div>
                  {typeof p.rain === 'number' ? (
                    <div style={{ color: '#5C6F7F', fontSize: 11 }}>雨强 {p.rain.toFixed(1)} mm/h</div>
                  ) : null}
                  <div style={{ color: '#8497A6', fontSize: 10, marginTop: 2 }}>点击查看详情</div>
                </div>
              </Tooltip>
            </CircleMarker>
          )
        })}
        {/* 常显站名必须挂在**自己的图层**上。
            同一个 CircleMarker 上放两个 <Tooltip> 会被 Leaflet 收纳成同一个图层：
            permanent 属性来自第一个、内容却是最后一个的，结果每站都常显一整块浮窗。
            用一个 0 半径的隐形锚点承载标签，两个浮窗各归各的。 */}
        {pts.map((p) => {
          const active = p.id === focusId
          if (p.level !== 'red' && p.level !== 'orange' && !active) return null
          return (
            <CircleMarker
              key={`label-${p.id}`}
              center={[p.glat, p.glon]}
              radius={0}
              pathOptions={{ opacity: 0, fillOpacity: 0 }}
              interactive={false}
            >
              <Tooltip permanent direction="right" offset={[9, 0]} opacity={1} className="wl-map-label">
                <span>{p.name}</span>
                {p.level === 'red' ? <b style={{ marginLeft: 4 }}>{p.depth.toFixed(2)}m</b> : null}
              </Tooltip>
            </CircleMarker>
          )
        })}
      </MapContainer>

      {/* 右下角版权：高德要求署名，但不想用 Leaflet 默认那行大字 */}
      <div
        style={{
          position: 'absolute',
          right: 6,
          bottom: 4,
          zIndex: 400,
          fontSize: 10,
          color: 'rgba(11,37,69,0.45)',
          pointerEvents: 'none',
          background: 'rgba(255,255,255,0.66)',
          padding: '1px 5px',
          borderRadius: 4,
        }}
      >
        {AMAP_ATTR}
      </div>
    </div>
  )
}
