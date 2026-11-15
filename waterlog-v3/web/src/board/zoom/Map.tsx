import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Level } from '../../domain'
import { LEVEL_LABEL, LEVEL_RANK, fmtDepth } from '../../domain'
import { useWatchlist } from '../../view/useWatchlist'
import { RealMap, type RealMapPoint } from '../RealMap'
import type { ZoomProps } from './types'

/**
 * Map —— 全城积水分布。
 *
 * 底图是只读的静态瓦片（`RealMap`，不接受拖动/缩放），这里只做三件事：
 *   1. 把十站的 `reading.depth`（水深，**不是**绝对水位 `reading.level`）
 *      换成气泡直径，按真实经纬度投到瓦片上；
 *   2. 给每个气泡配一行（compact）/ 两行（full）标注，**带避让**——十个站
 *      全挤在 0.078°×0.074° 的城区里，不避让的话名字会互压；
 *   3. full 档补一块街道汇总牌和一句「最深」结论。
 *
 * 动效只听数据的：直径随 30s 轮询的 depth 走 `transition`；红/橙外面那一圈
 * 扩散表达的是「这个点在报警」，是允许的例外。直径动 `transform: scale` 而
 * 不是 SVG 的 `r`——两者在 Chromium 上都该生效，但直径是这块图唯一的量纲，
 * 不值得赌一个只在部分合成层上生效的属性。
 */

/** 气泡直径封顶对应的水深（米）。再深的站点直径也停在这里，免得一个气泡压住两条街。 */
const DEPTH_CAP = 0.8

const EASE = 'cubic-bezier(.22,.61,.36,1)'

/** RealMap 自己会画站点（固定 r=7 + 自带两行标签），这里不让它画，免得出现双份。 */
const NO_POINTS: readonly RealMapPoint[] = []

const STYLE = `
@keyframes zmap-ripple {
  0%   { transform: scale(1);    opacity: .58; }
  72%  { transform: scale(1.72); opacity: .10; }
  100% { transform: scale(1.9);  opacity: 0; }
}
.zmap-ripple {
  transform-box: fill-box;
  transform-origin: center;
  animation: zmap-ripple 2.6s ${EASE} infinite;
}
@media (prefers-reduced-motion: reduce) {
  .zmap-ripple { animation: none; }
}
`

/* ---------------------------------------------------------------- 投影 */

/**
 * 与 RealMap 内部同一套 Web-Mercator（瓦片世界宽 256·2^z）。
 * 必须逐像素一致，否则气泡会和它下面的路网错位——错位比画错更伤可信度。
 */
function project(lon: number, lat: number, zoom: number): { x: number; y: number } {
  const world = 256 * 2 ** zoom
  const s = Math.sin((lat * Math.PI) / 180)
  return {
    x: ((lon + 180) / 360) * world,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world,
  }
}

/**
 * 选一个「整片站点正好装得下」的整数级别。
 *
 * 不用 CSS scale 做连续缩放：瓦片是 <img>，非整数缩放会在拼接处留下发丝缝，
 * 大屏上比留白难看。所以宁可退一档让城区小一点，也不让气泡被画布切掉
 * （被切掉的气泡等于丢了一个站）。
 */
function fitZoom(
  west: number,
  east: number,
  south: number,
  north: number,
  w: number,
  h: number,
  marginX: number,
  marginY: number,
): number {
  for (let z = 17; z > 3; z -= 1) {
    const a = project(west, north, z)
    const b = project(east, south, z)
    if (b.x - a.x <= w - marginX && b.y - a.y <= h - marginY) return z
  }
  return 3
}

/* ---------------------------------------------------------------- 标签排布 */

interface Bubble {
  readonly id: string
  readonly name: string
  readonly district: string
  readonly level: Level
  readonly depth: number
  readonly x: number
  readonly y: number
  readonly r: number
}

interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

interface Tag {
  readonly id: string
  readonly name: string
  readonly depth: number
  readonly anchor: 'start' | 'middle' | 'end'
  readonly x: number
  readonly top: number
}

/** 汉字按 1em、其余按 0.56em 估宽——只用来判断会不会压字，不需要精确。 */
function textWidth(text: string, fs: number): number {
  let w = 0
  for (const ch of text) w += ch.charCodeAt(0) > 0x2e7f ? fs : fs * 0.56
  return w
}

function hit(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * 给气泡排标注：按水深从深到浅放，每个先试右、左、上、下，取第一个既不
 * 出画布也不压住别的东西的位置；四个都不行就退回右边（宁可压字，也不让
 * 最深的那一站没有名字）。
 */
function placeLabels(items: readonly Bubble[], fs: number, lines: 1 | 2, w: number, h: number): Tag[] {
  const lineH = fs * 1.25
  const boxH = lineH * lines
  // 先把气泡本身占掉：标注可以挤，但不能压在另一个站的气泡上。
  const taken: Box[] = items.map((b) => ({
    x: b.x - b.r - 2,
    y: b.y - b.r - 2,
    w: (b.r + 2) * 2,
    h: (b.r + 2) * 2,
  }))
  const out: Tag[] = []
  for (const b of [...items].sort((m, n) => n.depth - m.depth)) {
    const textW = Math.max(textWidth(b.name, fs), lines === 2 ? textWidth(`${fmtDepth(b.depth)} m`, fs) : 0) + 2
    const gap = b.r + 7
    const cands: { anchor: Tag['anchor']; x: number; box: Box }[] = [
      { anchor: 'start', x: b.x + gap, box: { x: b.x + gap, y: b.y - boxH / 2, w: textW, h: boxH } },
      { anchor: 'end', x: b.x - gap, box: { x: b.x - gap - textW, y: b.y - boxH / 2, w: textW, h: boxH } },
      { anchor: 'middle', x: b.x, box: { x: b.x - textW / 2, y: b.y - gap - boxH, w: textW, h: boxH } },
      { anchor: 'middle', x: b.x, box: { x: b.x - textW / 2, y: b.y + gap, w: textW, h: boxH } },
    ]
    const fits = (r: Box) =>
      r.x >= 3 && r.y >= 3 && r.x + r.w <= w - 3 && r.y + r.h <= h - 3 && !taken.some((t) => hit(t, r))
    const pick = cands.find((c) => fits(c.box)) ?? cands[0]
    taken.push(pick.box)
    out.push({ id: b.id, name: b.name, depth: b.depth, anchor: pick.anchor, x: pick.x, top: pick.box.y })
  }
  return out
}

/** 气泡是 r=1 的圆再 scale 到目标半径：白圈和色块各自缩放，描边就不会被一起放大。 */
function disc(radius: number, reduce: boolean): CSSProperties {
  return {
    transform: `scale(${Math.max(0.001, radius)})`,
    transformBox: 'fill-box',
    transformOrigin: 'center',
    transition: reduce ? 'none' : `transform 380ms ${EASE}`,
  }
}

/* ---------------------------------------------------------------- 组件 */

export function ZoomMap({ p, w, h, detail }: ZoomProps) {
  const compact = detail === 'compact'
  const list = useWatchlist('level')
  const reduce = useReducedMotion()
  const [entered, setEntered] = useState(false)

  // 入场让直径从 0 长到目标值：轮播每 24s 切一页，切回来能看见「在长」。
  useEffect(() => {
    if (reduce) {
      setEntered(true)
      return
    }
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [reduce])

  const view = useMemo(() => {
    if (list.length === 0) return null
    const lons = list.map((g) => g.site.lon)
    const lats = list.map((g) => g.site.lat)
    const west = Math.min(...lons)
    const east = Math.max(...lons)
    const south = Math.min(...lats)
    const north = Math.max(...lats)
    const centerLon = (west + east) / 2
    const centerLat = (south + north) / 2
    // 留出的边距 = 最大气泡直径 + 两行字要占的地方。
    const maxR = compact ? 13 : 22
    const zoom = fitZoom(west, east, south, north, w, h, maxR * 2 + 30, maxR * 2 + 44)
    const origin = project(centerLon, centerLat, zoom)
    const items: Bubble[] = list.map((g) => {
      const q = project(g.site.lon, g.site.lat, zoom)
      const depth = Math.max(0, g.reading.depth)
      const k = Math.min(1, depth / DEPTH_CAP)
      return {
        id: g.site.id,
        name: g.site.name,
        district: g.site.district,
        level: g.assessment.level,
        depth,
        x: w / 2 + (q.x - origin.x),
        y: h / 2 + (q.y - origin.y),
        r: (compact ? 4 + 22 * k : 6 + 38 * k) / 2,
      }
    })
    return { center: [centerLon, centerLat] as [number, number], zoom, items }
  }, [list, compact, w, h])

  const labelFs = compact ? 11 : 15
  const lines: 1 | 2 = compact ? 1 : 2
  const tags = useMemo(
    () => (view ? placeLabels(view.items, labelFs, lines, w, h) : []),
    [view, labelFs, lines, w, h],
  )

  // 街道汇总：按最高等级降序（同级比站数）。街道数是 5 不是 4，写死四个会漏。
  const districts = useMemo(() => {
    const acc = new Map<string, { count: number; level: Level }>()
    for (const g of list) {
      const cur = acc.get(g.site.district)
      if (!cur) acc.set(g.site.district, { count: 1, level: g.assessment.level })
      else {
        cur.count += 1
        if (LEVEL_RANK[g.assessment.level] > LEVEL_RANK[cur.level]) cur.level = g.assessment.level
      }
    }
    return [...acc.entries()]
      .map(([name, v]) => ({ name, count: v.count, level: v.level }))
      .sort(
        (a, b) =>
          LEVEL_RANK[b.level] - LEVEL_RANK[a.level] ||
          b.count - a.count ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      )
  }, [list])

  const deepest = useMemo(() => {
    let best: { depth: number; name: string } | null = null
    for (const g of list) {
      const d = Math.max(0, g.reading.depth)
      if (!best || d > best.depth) best = { depth: d, name: g.site.name }
    }
    return best ?? { depth: 0, name: '—' }
  }, [list])

  if (!view) {
    return (
      <div
        style={{
          position: 'relative',
          width: w,
          height: h,
          overflow: 'hidden',
          background: p.panel,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: compact ? 12 : 18,
          color: p.textDim,
        }}
      >
        暂无数据
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', width: w, height: h, overflow: 'hidden', background: p.bg1 }}>
      <style>{STYLE}</style>

      <div style={{ position: 'absolute', inset: 0 }}>
        <RealMap points={NO_POINTS} center={view.center} zoom={view.zoom} width={w} height={h} />
      </div>

      {/* 压住瓦片里密密麻麻的路名，否则气泡和标注会跟地名叠在一起。 */}
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(255,255,255,0.35)' }} />

      <svg
        width={w}
        height={h}
        style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}
      >
        {view.items.map((b) => {
          const alarm = b.level === 'orange' || b.level === 'red'
          const r = entered ? b.r : 0
          return (
            <g key={b.id} style={{ transform: `translate(${b.x}px, ${b.y}px)`, transition: `transform 420ms ${EASE}` }}>
              {alarm && entered ? (
                <circle
                  r={Math.max(2, r + (compact ? 4 : 6))}
                  fill="none"
                  stroke={p.level[b.level]}
                  strokeWidth={1.6}
                  vectorEffect="non-scaling-stroke"
                  className="zmap-ripple"
                  style={{ opacity: reduce ? 0.34 : undefined }}
                />
              ) : null}
              <circle r={1} fill="#FFFFFF" opacity={0.9} style={disc(r + (compact ? 1.5 : 2.5), reduce)} />
              <circle r={1} fill={p.level[b.level]} style={disc(r, reduce)} />
            </g>
          )
        })}

        {tags.map((t) => {
          const lineH = labelFs * 1.25
          const base = t.top + (lineH - labelFs) / 2 + labelFs * 0.8
          return (
            <g key={t.id}>
              <text
                x={t.x}
                y={base}
                textAnchor={t.anchor}
                fontSize={labelFs}
                fontWeight={600}
                fill={p.text}
                stroke="rgba(255,255,255,0.94)"
                strokeWidth={1}
                strokeLinejoin="round"
                paintOrder="stroke"
              >
                {t.name}
              </text>
              {lines === 2 ? (
                <text
                  x={t.x}
                  y={base + lineH}
                  textAnchor={t.anchor}
                  fontSize={labelFs - 1}
                  fontWeight={500}
                  fill={p.text}
                  stroke="rgba(255,255,255,0.94)"
                  strokeWidth={1}
                  strokeLinejoin="round"
                  paintOrder="stroke"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {`${fmtDepth(t.depth)} m`}
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>

      {compact ? null : (
        <>
          <div
            style={{
              position: 'absolute',
              left: 26,
              top: 24,
              minWidth: 232,
              padding: '12px 18px 10px',
              background: '#FFFFFF',
              border: `1px solid ${p.panelBorder}`,
              borderRadius: 10,
              boxShadow: p.elev[2],
            }}
          >
            <div style={{ fontSize: 14, color: p.textFaint, letterSpacing: 0.4, marginBottom: 4 }}>
              {`${list.length} 站 · ${districts.length} 个街道`}
            </div>
            {districts.map((d) => (
              <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32 }}>
                <span
                  style={{
                    width: 9,
                    height: 9,
                    flex: '0 0 auto',
                    borderRadius: 2,
                    background: p.level[d.level],
                  }}
                />
                <span style={{ flex: 1, fontSize: 16, color: p.text }}>{d.name}</span>
                <span style={{ fontSize: 15, color: p.textDim, fontVariantNumeric: 'tabular-nums' }}>
                  {`${d.count} 站`}
                </span>
                <span style={{ width: 48, textAlign: 'right', fontSize: 14, color: p.textDim }}>
                  {LEVEL_LABEL[d.level]}
                </span>
              </div>
            ))}
          </div>

          <div
            style={{
              position: 'absolute',
              right: 26,
              bottom: 22,
              padding: '8px 16px',
              background: '#FFFFFF',
              border: `1px solid ${p.panelBorder}`,
              borderRadius: 8,
              boxShadow: p.elev[1],
              fontSize: 17,
              color: p.text,
            }}
          >
            <span style={{ color: p.textDim }}>最深 </span>
            <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {`${fmtDepth(deepest.depth)} m`}
            </span>
            <span style={{ color: p.textDim }}>{` · ${deepest.name}`}</span>
          </div>
        </>
      )}
    </div>
  )
}

/** 减动效偏好：系统里关掉动效时，这一屏不该还在扩散、生长。 */
function useReducedMotion(): boolean {
  const [on, setOn] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setOn(mq.matches)
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return on
}
