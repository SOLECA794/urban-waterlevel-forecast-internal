import React, { useId } from 'react'
import type { ReactNode } from 'react'
import type { EvalPoint, Station } from './types'
import { LEVEL_COLORS } from './types'

const HOUR = 3_600_000
const INK = '#18354b', MUTED = '#6c8394', GRID = '#dfe9f0', BLUE = '#2f6f9e', RED = '#d8565b', TEAL = '#2f9c8e'
const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const time = (at: number) => Number.isFinite(at) ? clock.format(at) : '—'
const finite = (n: number) => Number.isFinite(n)
const fmt = (n: number) => n < 1 ? n.toFixed(2) : n.toFixed(1)
const extent = (values: number[]) => {
  const max = Math.max(0.05, ...values.filter(finite))
  return Math.ceil(max * 1.12 * 20) / 20
}
const path = <T,>(points: T[], x: (p: T) => number, y: (p: T) => number) => points.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(2)},${y(p).toFixed(2)}`).join(' ')

interface FrameProps { title: string; unit: string; start: number; end: number; max: number; children: (x: (n: number) => number, y: (n: number) => number) => ReactNode; compact?: boolean; right?: number; empty?: boolean; ticks?: number[]; extra?: ReactNode }
function Frame({ title, unit, start, end, max, children, compact = false, right = 24, empty = false, ticks, extra }: FrameProps) {
  const width = 760, height = compact ? 180 : 260, left = 47, top = 29, bottom = height - 28, endX = width - right
  const id = useId().replace(/:/g, '')
  const x = (n: number) => left + (n - start) / Math.max(1, end - start) * (endX - left)
  const y = (n: number) => bottom - Math.max(0, n) / max * (bottom - top)
  const times = ticks ?? Array.from({ length: 5 }, (_, i) => start + (end - start) * i / 4)
  return <svg role="img" aria-label={title} viewBox={`0 0 ${width} ${height}`} width="100%" height="100%" preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible', fontFamily: 'inherit' }}>
    <title>{title}</title>
    <defs>
      <clipPath id={id}><rect x={left} y={top} width={endX - left} height={bottom - top} /></clipPath>
      <pattern id={`${id}-grid`} width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.35" fill="#9fb4c3" opacity="0.35" /></pattern>
    </defs>
    <rect x={left} y={top} width={endX - left} height={bottom - top} fill={`url(#${id}-grid)`} />
    <text x={left} y={15} fill={MUTED} fontSize={10} letterSpacing="0.4">{unit}</text>
    {[0, 1, 2, 3, 4].map(i => <g key={i}>
      <line x1={left} x2={endX} y1={y(max * i / 4)} y2={y(max * i / 4)} stroke={GRID} strokeDasharray={i ? '3 4' : undefined} />
      <text x={left - 9} y={y(max * i / 4) + 3} textAnchor="end" fill={MUTED} fontSize={10}>{fmt(max * i / 4)}</text>
    </g>)}
    {times.map((at, i) => <g key={i}>
      <line x1={x(at)} x2={x(at)} y1={bottom} y2={bottom + 4} stroke="#b8cad5" />
      <text x={x(at)} y={height - 9} fill={MUTED} fontSize={10} textAnchor={i === 0 ? 'start' : i === times.length - 1 ? 'end' : 'middle'}>{time(at)}</text>
    </g>)}
    <svg x={left} y={top} width={endX - left} height={bottom - top} viewBox={`${left} ${top} ${endX - left} ${bottom - top}`} preserveAspectRatio="none" overflow="hidden"><g clipPath={`url(#${id})`}>{!empty && children(x, y)}</g></svg>
    {empty && <text x={(left + endX) / 2} y={(top + bottom) / 2} textAnchor="middle" fill={MUTED} fontSize={13}>暂无数据</text>}
    {extra}
  </svg>
}

function ThresholdLines({ x1, x2, thresholds, y }: { x1: number; x2: number; thresholds: Station['thresholds']; y: (n: number) => number }) {
  const rows: { key: keyof Station['thresholds']; label: string; color: string }[] = [
    { key: 'red', label: '红色阈值', color: RED },
    { key: 'orange', label: '橙色阈值', color: '#df7531' },
    { key: 'yellow', label: '黄色阈值', color: '#bd8a13' },
    { key: 'blue', label: '蓝色阈值', color: '#307bd0' },
  ]
  return <>{rows.map(row => finite(thresholds[row.key]) && <g key={row.key}>
    <line x1={x1} x2={x2} y1={y(thresholds[row.key])} y2={y(thresholds[row.key])} stroke={row.color} strokeWidth={row.key === 'red' ? 1.25 : 0.8} strokeDasharray={row.key === 'red' ? '5 4' : '2 5'} opacity={row.key === 'red' ? 0.95 : 0.6} />
    <text x={x2 - 4} y={y(thresholds[row.key]) - 4} fill={row.color} fontSize={9} textAnchor="end" opacity={row.key === 'red' ? 1 : 0.8}>{row.label} {thresholds[row.key].toFixed(2)}m</text>
  </g>)}</>
}

function atHour(station: Station, hours: number) {
  const target = station.forecast[0]?.at + hours * HOUR
  let best = station.forecast[0]
  let diff = Infinity
  for (const p of station.forecast) {
    const d = Math.abs(p.at - target)
    if (d < diff) { diff = d; best = p }
  }
  return best
}

/** 科研绘图风：实测散点+连线、预报虚线、90% 置信带、阈值线、3/6/12h 注释。 */
export function TrendChart({ station, now, compact = false }: { station: Station; now: number; compact?: boolean }) {
  const start = now - 6 * HOUR, end = now + 12 * HOUR
  const observed = station.history.filter(p => finite(p.at) && finite(p.depth) && p.at >= start && p.at <= now).sort((a, b) => a.at - b.at)
  const forecast = station.forecast.filter(p => finite(p.at) && finite(p.depth) && p.at >= now && p.at <= end).sort((a, b) => a.at - b.at)
  const band = forecast.filter(p => finite(p.lower) && finite(p.upper))
  const max = extent([...observed.map(p => p.depth), ...forecast.map(p => p.depth), ...band.map(p => p.upper), station.thresholds.red])
  const bottom = compact ? 152 : 232
  const marks = [3, 6, 12].filter(h => atHour(station, h))
  return <Frame title={`${station.name}积水深度 · 6小时观测与12小时预报`} unit="积水深度 / m" start={start} end={end} max={max} compact={compact} empty={!observed.length && !forecast.length} ticks={[start, now, now + 6 * HOUR, end]} extra={<g fontSize={10}>
    <rect x={440} y={5} width={298} height={15} fill="#ffffff" opacity="0.86" rx="3" />
    <text x={450} y={15} fill={INK}>— 观测</text><text x={515} y={15} fill={BLUE}>┄ 预报</text><text x={585} y={15} fill="#8ab4ce">▬ 90% 置信带</text><text x={680} y={15} fill={RED}>┈ 红阈</text>
  </g>}>
    {(x, y) => <>
      <rect x={x(now)} y={29} width={x(end) - x(now)} height={bottom - 29} fill="#f3f8fb" opacity="0.8" />
      <ThresholdLines x1={x(start)} x2={x(end)} thresholds={station.thresholds} y={y} />
      {band.length > 1 && <path d={`${path(band, p => x(p.at), p => y(p.upper))} ${path([...band].reverse(), p => x(p.at), p => y(p.lower)).replace(/^M/, 'L')} Z`} fill="#bcdcee" opacity={0.55} />}
      <line x1={x(now)} x2={x(now)} y1={29} y2={bottom} stroke="#8fa9ba" strokeDasharray="3 4" /><text x={x(now) + 5} y={bottom - 8} fill={MUTED} fontSize={10}>当前</text>
      {observed.length > 0 && <><path d={path(observed, p => x(p.at), p => y(p.depth))} fill="none" stroke={INK} strokeWidth={2.1} vectorEffect="non-scaling-stroke" />{observed.filter((_, i) => i % 6 === 0 || i === observed.length - 1).map(p => <circle key={p.at} cx={x(p.at)} cy={y(p.depth)} r={2} fill="#fff" stroke={INK} strokeWidth={1.2} />)}</>}
      {forecast.length > 0 && <path d={path(forecast, p => x(p.at), p => y(p.depth))} fill="none" stroke={BLUE} strokeWidth={2} strokeDasharray="6 3" vectorEffect="non-scaling-stroke" />}
      {marks.map(h => {
        const p = atHour(station, h)
        const px = x(p.at), py = y(p.depth)
        const label = `+${h}h ${p.depth.toFixed(2)}m`
        return <g key={h}>
          <line x1={px} x2={px} y1={topY(compact)} y2={bottom} stroke={h === 12 ? RED : h === 6 ? '#df7531' : TEAL} strokeWidth={0.9} strokeDasharray="2 3" opacity="0.85" />
          <circle cx={px} cy={py} r={3.6} fill={h === 12 ? RED : h === 6 ? '#df7531' : TEAL} stroke="#fff" strokeWidth={1.2} />
          <rect x={Math.min(683, Math.max(50, px - 33))} y={Math.max(32, py - 24)} width={66} height={14} rx={3} fill="#ffffff" opacity="0.92" />
          <text x={Math.min(716, Math.max(83, px))} y={Math.max(43, py - 14)} textAnchor="middle" fontSize={9.5} fill={h === 12 ? RED : h === 6 ? '#b45f1f' : '#1f7a70'}>{label}</text>
        </g>
      })}
    </>}
  </Frame>
}
const topY = (compact: boolean) => compact ? 31 : 31

/** 三预见期区间图：横轴 3/6/12h，纵轴水深，画点估计+置信竖线。 */
export function HorizonIntervalChart({ station }: { station: Station }) {
  const hours = [3, 6, 12]
  const values = hours.map(h => atHour(station, h)).filter(Boolean)
  const max = extent([...values.map(p => p.upper), station.thresholds.red])
  const width = 760, height = 180, left = 47, right = 24, top = 26, bottom = height - 30, endX = width - right
  const x = (i: number) => left + (i + 0.5) / hours.length * (endX - left)
  const y = (n: number) => bottom - Math.max(0, n) / max * (bottom - top)
  return <svg role="img" aria-label="3、6、12小时预见期区间图" viewBox={`0 0 ${width} ${height}`} width="100%" height="100%" preserveAspectRatio="none" style={{ display: 'block', fontFamily: 'inherit' }}>
    <title>3、6、12小时预见期区间图</title>
    <text x={left} y={14} fill={MUTED} fontSize={10}>积水深度 / m · 点估计与 90% 区间</text>
    {[0, 1, 2, 3, 4].map(i => <g key={i}><line x1={left} x2={endX} y1={y(max * i / 4)} y2={y(max * i / 4)} stroke={GRID} strokeDasharray={i ? '3 4' : undefined} /><text x={left - 9} y={y(max * i / 4) + 3} textAnchor="end" fill={MUTED} fontSize={10}>{fmt(max * i / 4)}</text></g>)}
    <ThresholdLines x1={left} x2={endX} thresholds={station.thresholds} y={y} />
    {values.map((p, i) => {
      const c = i === 0 ? TEAL : i === 1 ? '#df7531' : RED
      return <g key={i}>
        <line x1={x(i)} x2={x(i)} y1={y(p.lower)} y2={y(p.upper)} stroke={c} strokeWidth={1.6} />
        <line x1={x(i) - 9} x2={x(i) + 9} y1={y(p.upper)} y2={y(p.upper)} stroke={c} strokeWidth={1.2} />
        <line x1={x(i) - 9} x2={x(i) + 9} y1={y(p.lower)} y2={y(p.lower)} stroke={c} strokeWidth={1.2} />
        <rect x={x(i) - 8} y={y(p.depth) - 6} width={16} height={12} rx={2} fill={c} stroke="#fff" strokeWidth={1.4} />
        <text x={x(i)} y={height - 9} textAnchor="middle" fill={INK} fontSize={11} fontWeight="700">+{hours[i]}h</text>
        <text x={x(i)} y={y(p.upper) - 8} textAnchor="middle" fill={c} fontSize={10} fontWeight="600">{p.depth.toFixed(2)}</text>
      </g>
    })}
  </svg>
}

/** 十站小多图：每站一张面积微图，颜色按最高预警等级。 */
export function SiteMiniChart({ station }: { station: Station }) {
  const series = station.forecast
  const max = Math.max(0.05, ...series.map(p => p.upper), station.thresholds.red)
  const min = Math.min(0, ...series.map(p => p.lower))
  const w = 200, h = 58
  const x = (i: number) => 2 + i / Math.max(1, series.length - 1) * (w - 4)
  const y = (v: number) => h - 3 - (v - min) / (max - min) * (h - 8)
  const color = station.actual >= station.thresholds.red ? LEVEL_COLORS.red : station.actual >= station.thresholds.orange ? LEVEL_COLORS.orange : station.actual >= station.thresholds.yellow ? LEVEL_COLORS.yellow : station.actual >= station.thresholds.blue ? LEVEL_COLORS.blue : LEVEL_COLORS.none
  const area = series.length ? `${series.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.depth)}`).join(' ')} L${x(series.length - 1)},${h} L${x(0)},${h} Z` : ''
  return <svg role="img" aria-label={`${station.name} 12小时预测微图`} viewBox={`0 0 ${w} ${h}`} width="100%" height="100%" preserveAspectRatio="none" style={{ display: 'block' }}>
    <title>{station.name} 12小时预测微图</title>
    <line x1={0} x2={w} y1={y(station.thresholds.red)} y2={y(station.thresholds.red)} stroke={RED} strokeWidth={0.8} strokeDasharray="3 3" opacity="0.7" />
    {series.length > 1 && <path d={`${series.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.upper)}`).join(' ')} ${[...series].reverse().map((p, i) => `L${x(series.length - 1 - i)},${y(p.lower)}`).join(' ')} Z`} fill={color} opacity="0.16" />}
    {area && <path d={area} fill={color} opacity="0.1" />}
    {series.length > 0 && <path d={series.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.depth)}`).join(' ')} fill="none" stroke={color} strokeWidth={1.7} vectorEffect="non-scaling-stroke" />}
  </svg>
}

function levelAt(station: Station, hours: number) {
  const p = atHour(station, hours)
  const d = p?.depth ?? station.actual
  for (const key of ['red', 'orange', 'yellow', 'blue'] as const) if (d >= station.thresholds[key]) return key
  return 'none'
}

/** 十站 × 四个时刻的风险热力图（格子可点，替代纯数据表）。 */
export function RiskHeatmap({ stations, selectedId, onSelect }: { stations: Station[]; selectedId: string; onSelect: (id: string) => void }) {
  const cols = [0, 3, 6, 12]
  return <div className="risk-heat">
    <div className="risk-heat-head"><span>监测点</span><span>当前</span><span>+3h</span><span>+6h</span><span>+12h</span><span>12h 峰值</span></div>
    {stations.map(s => {
      let peak = -Infinity
      for (const p of s.forecast) if (p.depth > peak) peak = p.depth
      const peakLevel = peak >= s.thresholds.red ? 'red' : peak >= s.thresholds.orange ? 'orange' : peak >= s.thresholds.yellow ? 'yellow' : peak >= s.thresholds.blue ? 'blue' : 'none'
      return <button key={s.id} className={`risk-heat-row${s.id === selectedId ? ' active' : ''}`} onClick={() => onSelect(s.id)}>
        <span className="rh-name"><i style={{ background: LEVEL_COLORS[levelAt(s, 0)] }} />{s.name}</span>
        {cols.map(h => {
          const lv = levelAt(s, h)
          const val = atHour(s, h)?.depth ?? s.actual
          return <span key={h} className="rh-cell" style={{ background: LEVEL_COLORS[lv], color: '#fff' }} title={`${s.name} ${h === 0 ? '当前' : `+${h}h`} ${val.toFixed(2)} m`}>{val.toFixed(2)}</span>
        })}
        <span className="rh-peak" style={{ color: LEVEL_COLORS[peakLevel] }}>{peak.toFixed(2)}</span>
      </button>
    })}
  </div>
}

/** 十站 × 三个时段的涨幅矩阵（+3h、+6h、+12h 分段增量）。 */
export function HorizonMatrix({ stations, selectedId, onSelect }: { stations: Station[]; selectedId: string; onSelect: (id: string) => void }) {
  const now = stations[0]?.actual ?? 0
  const segs = [
    { label: '0→3h', get: (s: Station) => (atHour(s, 3)?.depth ?? s.actual) - s.actual },
    { label: '3→6h', get: (s: Station) => (atHour(s, 6)?.depth ?? s.actual) - (atHour(s, 3)?.depth ?? s.actual) },
    { label: '6→12h', get: (s: Station) => (atHour(s, 12)?.depth ?? s.actual) - (atHour(s, 6)?.depth ?? s.actual) },
  ]
  const cells = stations.flatMap(s => segs.map(seg => seg.get(s)))
  const span = Math.max(0.02, ...cells.map(Math.abs))
  return <div className="horizon-matrix">
    <div className="hm-head"><span>监测点</span>{segs.map(seg => <span key={seg.label}>{seg.label}</span>)}<span>+12h</span></div>
    {stations.map(s => <button key={s.id} className={`hm-row${s.id === selectedId ? ' active' : ''}`} onClick={() => onSelect(s.id)}>
      <span className="hm-name">{s.name.replace(/·.*/, '')}</span>
      {segs.map(seg => {
        const d = seg.get(s)
        const alpha = Math.min(1, 0.12 + Math.abs(d) / span * 0.8)
        return <span key={seg.label} className="hm-cell" style={{ background: d >= 0 ? `rgba(47,156,142,${alpha})` : `rgba(214,86,91,${alpha})` }} title={`${s.name} ${seg.label}: ${d >= 0 ? '+' : ''}${d.toFixed(3)} m`}>{d >= 0 ? '+' : ''}{d.toFixed(2)}</span>
      })}
      <span className="hm-end">{(atHour(s, 12)?.depth ?? s.actual).toFixed(2)}m</span>
    </button>)}
    <div className="hm-foot">基线水深示例 {now.toFixed(2)} m · 绿=上涨 / 红=退水 · 颜色深浅表示变化幅度</div>
  </div>
}

function riskColor(station: Station, depths: number[]) {
  const peak = Math.max(station.actual, ...depths)
  for (const level of ['red', 'orange', 'yellow', 'blue'] as const) if (peak >= station.thresholds[level]) return LEVEL_COLORS[level]
  return LEVEL_COLORS.none
}

export function FleetChart({ stations, now }: { stations: Station[]; now: number }) {
  const series = stations.map(station => ({ station, points: station.forecast.filter(p => finite(p.at) && finite(p.depth) && p.at >= now && p.at <= now + 12 * HOUR).sort((a, b) => a.at - b.at) })).filter(s => s.points.length)
  const max = extent(series.flatMap(s => s.points.map(p => p.depth)))
  const getY = (depth: number) => 232 - depth / max * 203
  const sorted = [...series].sort((a, b) => getY(a.points.at(-1)!.depth) - getY(b.points.at(-1)!.depth))
  const overlaps = sorted.some((s, i) => i > 0 && Math.abs(getY(s.points.at(-1)!.depth) - getY(sorted[i - 1].points.at(-1)!.depth)) < 17)
  const labeled = overlaps ? sorted.filter((_, i) => i === 0 || i === sorted.length - 1 || i % Math.ceil(sorted.length / 4) === 0).slice(0, 5) : sorted
  let lastLabel = 22
  const labels = labeled.map(s => { const y = Math.max(lastLabel + 19, Math.min(222, getY(s.points.at(-1)!.depth))); lastLabel = y; return { ...s, y } })
  return <Frame title="全网站点未来12小时积水深度预报" unit="积水深度 / m" start={now} end={now + 12 * HOUR} max={max} right={143} empty={!series.length} extra={<g>{labels.map(({ station, points, y }) => <g key={station.id}><line x1={619} y1={getY(points.at(-1)!.depth)} x2={634} y2={y - 3} stroke={riskColor(station, points.map(p => p.depth))} opacity={0.7} /><text x={639} y={y} fill={riskColor(station, points.map(p => p.depth))} fontSize={10}>{station.name}</text></g>)}</g>}>
    {(x, y) => <>{series.map(({ station, points }) => <path key={station.id} d={path(points, p => x(p.at), p => y(p.depth))} fill="none" stroke={riskColor(station, points.map(p => p.depth))} strokeWidth={1.7} strokeOpacity={0.8} vectorEffect="non-scaling-stroke"><title>{station.name}</title></path>)}</>}
  </Frame>
}

export function RainChart({ stations, now }: { stations: Station[]; now: number }) {
  const start = now - 6 * HOUR
  const bars = Array.from({ length: 6 }, (_, i) => {
    const from = start + i * HOUR, to = from + HOUR
    const averages = stations.map(s => s.history.filter(p => finite(p.at) && finite(p.rain) && p.at >= from && (i === 5 ? p.at <= to : p.at < to))).filter(p => p.length).map(p => p.reduce((sum, v) => sum + v.rain, 0) / p.length)
    return { at: (from + to) / 2, rain: averages.length ? averages.reduce((a, b) => a + b, 0) / averages.length : null }
  })
  const max = extent(bars.flatMap(b => b.rain === null ? [] : [b.rain]))
  return <Frame title="近6小时站点平均降雨强度" unit="平均降雨 / mm/h" start={start} end={now} max={max} compact empty={bars.every(b => b.rain === null)} ticks={[start, start + 2 * HOUR, start + 4 * HOUR, now]}>
    {(x, y) => <>{bars.map((b, i) => b.rain !== null && <rect key={i} x={x(b.at - HOUR * 0.3)} y={y(b.rain)} width={x(b.at + HOUR * 0.3) - x(b.at - HOUR * 0.3)} height={Math.max(0, y(0) - y(b.rain))} rx={2} fill="#73b3cb"><title>{time(b.at)} {b.rain.toFixed(2)} mm/h</title></rect>)}</>}
  </Frame>
}

export function AccuracyChart({ points }: { points: EvalPoint[] }) {
  const data = points.filter(p => finite(p.at) && finite(p.actual) && finite(p.predicted)).sort((a, b) => a.at - b.at)
  const start = data[0]?.at ?? 0, end = data.at(-1)?.at ?? HOUR
  const max = extent(data.flatMap(p => [p.actual, p.predicted]))
  const residuals = data.map(p => p.actual - p.predicted)
  const mae = residuals.length ? residuals.reduce((a, b) => a + Math.abs(b), 0) / residuals.length : 0
  return <Frame title="提前1小时预报检验" unit="积水深度 / m" start={start} end={end === start ? start + HOUR : end} max={max} compact empty={!data.length} extra={<g fontSize={10}><rect x={430} y={5} width={195} height={15} fill="#ffffff" opacity="0.86" rx="3" /><text x={438} y={15} fill={INK}>— 实测</text><text x={505} y={15} fill={BLUE}>┄ 预报</text><text x={566} y={15} fill={MUTED}>MAE {mae.toFixed(3)}m</text></g>}>
    {(x, y) => <><path d={path(data, p => x(p.at), p => y(p.actual))} fill="none" stroke={INK} strokeWidth={2} vectorEffect="non-scaling-stroke" /><path d={path(data, p => x(p.at), p => y(p.predicted))} fill="none" stroke={BLUE} strokeWidth={1.8} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />{data.length === 1 && <><circle cx={x(data[0].at)} cy={y(data[0].actual)} r={3} fill={INK} /><circle cx={x(data[0].at)} cy={y(data[0].predicted)} r={3} fill={BLUE} /></>}</>}
  </Frame>
}

export function Sparkline({ values, color = BLUE }: { values: number[]; color?: string }) {
  const data = values.filter(finite), max = Math.max(0.01, ...data), min = Math.min(0, ...data)
  return <svg role="img" aria-label="积水深度微趋势" viewBox="0 0 100 30" width="100%" height="100%" preserveAspectRatio="none" style={{ display: 'block' }}><title>{data.length ? '积水深度微趋势' : '暂无数据'}</title>{data.length ? <><path d={data.map((v, i) => `${i ? 'L' : 'M'}${(3 + i / Math.max(1, data.length - 1) * 94).toFixed(2)},${(26 - (v - min) / (max - min) * 22).toFixed(2)}`).join(' ')} stroke={color} fill="none" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />{data.length === 1 && <circle cx={3} cy={26 - (data[0] - min) / (max - min) * 22} r={2} fill={color} />}</> : <text x={50} y={19} textAnchor="middle" fill={MUTED} fontSize={10}>暂无数据</text>}</svg>
}
