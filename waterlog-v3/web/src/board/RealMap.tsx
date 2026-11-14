import { useEffect, useMemo, useRef, useState } from 'react'
import type { Level } from '../domain'
import { usePalette } from './theme'

/**
 * 真实地图底图（高德栅格瓦片），带「跟随观测点平移」。
 *
 * 四个约束决定了实现方式：
 * 1. 地图要平移到当前观测点、并让它落在视觉中心 —— 所以 center 每 9 秒变一次。
 * 2. 平移过程不能出现空白 —— 瓦片是异步加载的。做法是双层交叉：
 *    新中心的瓦片整层加载完成后淡入；旧层在它下面继续显示，等新层完全盖住再撤。
 * 3. 站点标记要跟着滑过去 —— 用 CSS transform transition 让 <g> 平移，
 *    而不是每帧 setState 重算坐标（1920×1080 整树 60fps 重渲染太贵）。
 * 4. 整页不许有暗色块 —— 瓦片走 style=8（浅色路网），再叠 saturate/brightness 压一档，
 *    让「颜色只留给站点与预警等级」这条规则成立。
 *
 * 坐标系：站点是 WGS84，高德瓦片是 GCJ-02，国内偏 100~600m。
 * 站点本身是抽象点位；接入真实数据前必须纠偏或换 WGS84 瓦片源。
 */

const TILE = 256
/** 预加载比视口多一圈，平移过程中边缘不会先露出空白。 */
const PAD = 1

function project(lon: number, lat: number, zoom: number) {
  const world = TILE * Math.pow(2, zoom)
  const x = ((lon + 180) / 360) * world
  const s = Math.sin((lat * Math.PI) / 180)
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world
  return { x, y }
}

export interface RealMapPoint {
  id: string
  name: string
  lon: number
  lat: number
  level: Level
  depth: number
  isAlarm: boolean
}

function tilesFor(center: [number, number], zoom: number, width: number, height: number) {
  const c = project(center[0], center[1], zoom)
  const ox = c.x - width / 2
  const oy = c.y - height / 2
  const x0 = Math.floor(ox / TILE) - PAD
  const y0 = Math.floor(oy / TILE) - PAD
  const x1 = Math.floor((ox + width) / TILE) + PAD
  const y1 = Math.floor((oy + height) / TILE) + PAD
  const list: { key: string; url: string; left: number; top: number }[] = []
  for (let tx = x0; tx <= x1; tx += 1) {
    for (let ty = y0; ty <= y1; ty += 1) {
      const sub = 1 + ((tx + ty) % 4)
      list.push({
        key: `${tx}-${ty}`,
        // style=8 是高德浅色路网图（7 深色、6 卫星）。整页不许有暗区，只能选 8。
        url: `https://webrd0${sub}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${tx}&y=${ty}&z=${zoom}`,
        left: tx * TILE - ox,
        top: ty * TILE - oy,
      })
    }
  }
  return list
}

function TileLayer({
  center,
  zoom,
  width,
  height,
  opacity,
  onReady,
}: {
  center: [number, number]
  zoom: number
  width: number
  height: number
  opacity: number
  onReady?: () => void
}) {
  const list = useMemo(() => tilesFor(center, zoom, width, height), [center, zoom, width, height])
  const [loaded, setLoaded] = useState(0)
  const fired = useRef(false)

  useEffect(() => {
    fired.current = false
    setLoaded(0)
  }, [list])

  useEffect(() => {
    if (!fired.current && list.length > 0 && loaded >= list.length) {
      fired.current = true
      onReady?.()
    }
  }, [loaded, list.length, onReady])

  return (
    <div style={{ position: 'absolute', inset: 0, opacity, transition: 'opacity 420ms ease' }}>
      {list.map((t) => (
        <img
          key={t.key}
          src={t.url}
          alt=""
          draggable={false}
          onLoad={() => setLoaded((n) => n + 1)}
          onError={() => setLoaded((n) => n + 1)}
          style={{
            position: 'absolute',
            left: t.left,
            top: t.top,
            width: TILE,
            height: TILE,
            userSelect: 'none',
            filter: 'saturate(0.32) contrast(1.02)',
          }}
        />
      ))}
    </div>
  )
}

export function RealMap({
  points,
  activeId,
  center,
  zoom = 16,
  width,
  height,
}: {
  points: readonly RealMapPoint[]
  activeId?: string
  center: [number, number]
  zoom?: number
  width: number
  height: number
}) {
  const p = usePalette()

  /* 已提交的中心 + 正在加载的中心。两层同时在场：
     下层是 cur（当前看到的），上层是 pending（新中心，加载中或已淡入）。
     关键：pending 加载完后，让 cur 也切到新中心（此时图片已在浏览器缓存里，
     不会二次下载），等 900ms 再把 pending 撤掉——这样任何一帧都有完整底图。 */
  const [cur, setCur] = useState<[number, number]>(center)
  const [pending, setPending] = useState<{ center: [number, number]; in: boolean } | null>(null)
  const pendingRef = useRef<{ center: [number, number]; in: boolean } | null>(null)
  pendingRef.current = pending

  useEffect(() => {
    if (cur[0] === center[0] && cur[1] === center[1]) return
    setPending({ center, in: false })
  }, [center, cur])

  const onPendingReady = () => {
    const done = pendingRef.current
    if (!done || done.in) return
    setPending({ center: done.center, in: true })
    window.setTimeout(() => setCur(done.center), 460)
    window.setTimeout(() => setPending(null), 980)
  }

  const origin = useMemo(() => project(cur[0], cur[1], zoom), [cur, zoom])

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#EAF2FA' }}>
      <TileLayer center={cur} zoom={zoom} width={width} height={height} opacity={1} />
      {pending && (
        <TileLayer
          center={pending.center}
          zoom={zoom}
          width={width}
          height={height}
          opacity={pending.in ? 1 : 0}
          onReady={onPendingReady}
        />
      )}

      <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
        {/* 视准心：告诉你「现在讲的是这一块」 */}
        <g opacity={0.55}>
          <circle cx={width / 2} cy={height / 2} r={48} fill="none" stroke={p.accent} strokeWidth={1} strokeDasharray="4 7" />
          <circle cx={width / 2} cy={height / 2} r={3} fill={p.accent} />
        </g>

        {points.map((pt) => {
          const q = project(pt.lon, pt.lat, zoom)
          const x = q.x - origin.x
          const y = q.y - origin.y
          const color = p.level[pt.level]
          const active = pt.id === activeId
          const r = 7
          return (
            <g
              key={pt.id}
              style={{
                transform: `translate(${width / 2 + x}px, ${height / 2 + y}px)`,
                transition: 'transform 900ms cubic-bezier(.4,0,.2,1)',
              }}
            >
              {pt.isAlarm && (
                <circle cx={0} cy={0} r={r + 8} fill="none" stroke={color} strokeWidth={1.6} opacity={0.55}>
                  <animate attributeName="r" values={`${r + 5};${r + 15};${r + 5}`} dur="2.8s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.6;0.1;0.6" dur="2.8s" repeatCount="indefinite" />
                </circle>
              )}
              {active && (
                <circle cx={0} cy={0} r={r + 5} fill="none" stroke={p.accent} strokeWidth={2} opacity={0.9}>
                  <animate attributeName="r" values={`${r + 4};${r + 13};${r + 4}`} dur="2.2s" repeatCount="indefinite" />
                </circle>
              )}
              <circle cx={0} cy={0} r={r + 2.5} fill="#FFFFFF" opacity={0.9} />
              <circle cx={0} cy={0} r={r} fill={color} />
              <text
                y={-r - 7}
                textAnchor="middle"
                fontSize={11}
                fontWeight={600}
                fill={p.levelInk[pt.level]}
                stroke="#FFFFFF"
                strokeWidth={3}
                paintOrder="stroke"
              >
                {pt.name}
              </text>
              <text
                y={r + 13}
                textAnchor="middle"
                fontSize={10.5}
                fontWeight={600}
                fill={p.text}
                stroke="#FFFFFF"
                strokeWidth={3}
                paintOrder="stroke"
              >
                {pt.depth.toFixed(2)}m
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
