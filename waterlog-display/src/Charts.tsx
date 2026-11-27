import React, { useId } from 'react'
import type { ReactNode } from 'react'
import type { EvalPoint, Station } from './types'
import { LEVEL_COLORS } from './types'

const HOUR = 3_600_000
const INK = '#18354b', MUTED = '#6c8394', GRID = '#e3ecf1', BLUE = '#287fa3', RED = '#d65a58'
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
  const x = (n: number) => left + (n - start) / Math.max(1, end-start) * (endX-left)
  const y = (n: number) => bottom - Math.max(0, n) / max * (bottom-top)
  const times = ticks ?? Array.from({ length: 5 }, (_, i) => start + (end-start)*i/4)
  return <svg role="img" aria-label={title} viewBox={`0 0 ${width} ${height}`} width="100%" height="100%" preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible', fontFamily: 'inherit' }}>
    <title>{title}</title>
    <defs><clipPath id={id}><rect x={left} y={top} width={endX-left} height={bottom-top} /></clipPath></defs>
    <text x={left} y={15} fill={MUTED} fontSize={10}>{unit}</text>
    {[0,1,2,3,4].map(i => <g key={i}><line x1={left} x2={endX} y1={y(max*i/4)} y2={y(max*i/4)} stroke={GRID} strokeDasharray={i ? '3 4' : undefined} /><text x={left-9} y={y(max*i/4)+3} textAnchor="end" fill={MUTED} fontSize={10}>{fmt(max*i/4)}</text></g>)}
    {times.map((at, i) => <g key={i}><line x1={x(at)} x2={x(at)} y1={bottom} y2={bottom+4} stroke="#b8cad5" /><text x={x(at)} y={height-9} fill={MUTED} fontSize={10} textAnchor={i === 0 ? 'start' : i === times.length-1 ? 'end' : 'middle'}>{time(at)}</text></g>)}
    <svg x={left} y={top} width={endX-left} height={bottom-top} viewBox={`${left} ${top} ${endX-left} ${bottom-top}`} preserveAspectRatio="none" overflow="hidden"><g clipPath={`url(#${id})`}>{!empty && children(x,y)}</g></svg>
    {empty && <text x={(left+endX)/2} y={(top+bottom)/2} textAnchor="middle" fill={MUTED} fontSize={13}>暂无数据</text>}
    {extra}
  </svg>
}

export function TrendChart({ station, now, compact = false }: { station: Station; now: number; compact?: boolean }) {
  const start = now - 6*HOUR, end = now + 12*HOUR
  const observed = station.history.filter(p => finite(p.at) && finite(p.depth) && p.at >= start && p.at <= now).sort((a,b) => a.at-b.at)
  const forecast = station.forecast.filter(p => finite(p.at) && finite(p.depth) && p.at >= now && p.at <= end).sort((a,b) => a.at-b.at)
  const band = forecast.filter(p => finite(p.lower) && finite(p.upper))
  const max = extent([...observed.map(p => p.depth), ...forecast.map(p => p.depth), ...band.map(p => p.upper), station.thresholds.red])
  const bottom = compact ? 152 : 232
  return <Frame title={`${station.name}积水深度 · 6小时观测与12小时预报`} unit="积水深度 / m" start={start} end={end} max={max} compact={compact} empty={!observed.length && !forecast.length} ticks={[start,now,now+6*HOUR,end]} extra={<g fontSize={10}><text x={455} y={15} fill={INK}>— 观测</text><text x={525} y={15} fill={BLUE}>┄ 预报</text><text x={595} y={15} fill={MUTED}>置信区间</text></g>}>
    {(x,y) => <>
      <rect x={x(now)} y={29} width={x(end)-x(now)} height={bottom-29} fill="#f5f9fc" />
      {band.length > 1 && <path d={`${path(band,p=>x(p.at),p=>y(p.upper))} ${path([...band].reverse(),p=>x(p.at),p=>y(p.lower)).replace(/^M/,'L')} Z`} fill="#d4e8f3" opacity={0.8} />}
      {finite(station.thresholds.red) && <><line x1={x(start)} x2={x(end)} y1={y(station.thresholds.red)} y2={y(station.thresholds.red)} stroke={RED} strokeWidth={1.25} strokeDasharray="5 4" /><text x={x(end)-5} y={y(station.thresholds.red)-6} fill={RED} fontSize={10} textAnchor="end">红色阈值 {station.thresholds.red.toFixed(2)} m</text></>}
      <line x1={x(now)} x2={x(now)} y1={29} y2={bottom} stroke="#9cb1c0" strokeDasharray="3 4" /><text x={x(now)+5} y={bottom-8} fill={MUTED} fontSize={10}>当前</text>
      {observed.length > 0 && <path d={path(observed,p=>x(p.at),p=>y(p.depth))} fill="none" stroke={INK} strokeWidth={2.3} vectorEffect="non-scaling-stroke" />}
      {forecast.length > 0 && <path d={path(forecast,p=>x(p.at),p=>y(p.depth))} fill="none" stroke={BLUE} strokeWidth={2} strokeDasharray="5 3" vectorEffect="non-scaling-stroke" />}
    </>}
  </Frame>
}

function riskColor(station: Station, depths: number[]) {
  const peak = Math.max(station.actual, ...depths)
  for (const level of ['red','orange','yellow','blue'] as const) if (peak >= station.thresholds[level]) return LEVEL_COLORS[level]
  return LEVEL_COLORS.none
}

export function FleetChart({ stations, now }: { stations: Station[]; now: number }) {
  const series = stations.map(station => ({ station, points: station.forecast.filter(p => finite(p.at) && finite(p.depth) && p.at >= now && p.at <= now+12*HOUR).sort((a,b) => a.at-b.at) })).filter(s => s.points.length)
  const max = extent(series.flatMap(s => s.points.map(p => p.depth)))
  const getY = (depth: number) => 232-depth/max*203
  const sorted = [...series].sort((a,b) => getY(a.points.at(-1)!.depth)-getY(b.points.at(-1)!.depth))
  const overlaps = sorted.some((s,i) => i > 0 && Math.abs(getY(s.points.at(-1)!.depth)-getY(sorted[i-1].points.at(-1)!.depth)) < 17)
  const labeled = overlaps ? sorted.filter((_,i) => i === 0 || i === sorted.length-1 || i % Math.ceil(sorted.length/4) === 0).slice(0,5) : sorted
  let lastLabel = 22
  const labels = labeled.map(s => { const y = Math.max(lastLabel+19, Math.min(222,getY(s.points.at(-1)!.depth))); lastLabel = y; return { ...s, y } })
  return <Frame title="全网站点未来12小时积水深度预报" unit="积水深度 / m" start={now} end={now+12*HOUR} max={max} right={143} empty={!series.length} extra={<g>{labels.map(({station,points,y}) => <g key={station.id}><line x1={619} y1={getY(points.at(-1)!.depth)} x2={634} y2={y-3} stroke={riskColor(station,points.map(p=>p.depth))} opacity={0.7} /><text x={639} y={y} fill={riskColor(station,points.map(p=>p.depth))} fontSize={10}>{station.name}</text></g>)}</g>}>
    {(x,y) => <>{series.map(({station,points}) => <path key={station.id} d={path(points,p=>x(p.at),p=>y(p.depth))} fill="none" stroke={riskColor(station,points.map(p=>p.depth))} strokeWidth={1.7} strokeOpacity={0.8} vectorEffect="non-scaling-stroke"><title>{station.name}</title></path>)}</>}
  </Frame>
}

export function RainChart({ stations, now }: { stations: Station[]; now: number }) {
  const start = now - 6*HOUR
  const bars = Array.from({length:6},(_,i) => {
    const from = start+i*HOUR, to = from+HOUR
    // Average each station first so denser telemetry does not overweight one site.
    const averages = stations.map(s => s.history.filter(p => finite(p.at) && finite(p.rain) && p.at >= from && (i === 5 ? p.at <= to : p.at < to))).filter(p => p.length).map(p => p.reduce((sum,v)=>sum+v.rain,0)/p.length)
    return { at: (from+to)/2, rain: averages.length ? averages.reduce((a,b)=>a+b,0)/averages.length : null }
  })
  const max = extent(bars.flatMap(b => b.rain === null ? [] : [b.rain]))
  return <Frame title="近6小时站点平均降雨强度" unit="平均降雨 / mm/h" start={start} end={now} max={max} compact empty={bars.every(b => b.rain === null)} ticks={[start,start+2*HOUR,start+4*HOUR,now]}>
    {(x,y) => <>{bars.map((b,i) => b.rain !== null && <rect key={i} x={x(b.at-HOUR*0.3)} y={y(b.rain)} width={x(b.at+HOUR*0.3)-x(b.at-HOUR*0.3)} height={Math.max(0,y(0)-y(b.rain))} rx={2} fill="#73b3cb"><title>{time(b.at)} {b.rain.toFixed(2)} mm/h</title></rect>)}</>}
  </Frame>
}

export function AccuracyChart({ points }: { points: EvalPoint[] }) {
  const data = points.filter(p=>finite(p.at) && finite(p.actual) && finite(p.predicted)).sort((a,b)=>a.at-b.at)
  const start = data[0]?.at ?? 0, end = data.at(-1)?.at ?? HOUR
  const max = extent(data.flatMap(p=>[p.actual,p.predicted]))
  return <Frame title="历史实测与提前1小时预报对照" unit="积水深度 / m" start={start} end={end === start ? start+HOUR : end} max={max} compact empty={!data.length} extra={<g fontSize={10}><text x={493} y={15} fill={INK}>— 实测</text><text x={580} y={15} fill={BLUE}>┄ 提前1小时预报</text></g>}>
    {(x,y) => <><path d={path(data,p=>x(p.at),p=>y(p.actual))} fill="none" stroke={INK} strokeWidth={2} vectorEffect="non-scaling-stroke" /><path d={path(data,p=>x(p.at),p=>y(p.predicted))} fill="none" stroke={BLUE} strokeWidth={1.8} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />{data.length === 1 && <><circle cx={x(data[0].at)} cy={y(data[0].actual)} r={3} fill={INK}/><circle cx={x(data[0].at)} cy={y(data[0].predicted)} r={3} fill={BLUE}/></>}</>}
  </Frame>
}

export function Sparkline({ values, color = BLUE }: { values: number[]; color?: string }) {
  const data = values.filter(finite), max = Math.max(0.01,...data), min = Math.min(0,...data)
  return <svg role="img" aria-label="积水深度微趋势" viewBox="0 0 100 30" width="100%" height="100%" preserveAspectRatio="none" style={{ display: 'block' }}><title>{data.length ? '积水深度微趋势' : '暂无数据'}</title>{data.length ? <><path d={data.map((v,i)=>`${i?'L':'M'}${(3+i/Math.max(1,data.length-1)*94).toFixed(2)},${(26-(v-min)/(max-min)*22).toFixed(2)}`).join(' ')} stroke={color} fill="none" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />{data.length === 1 && <circle cx={3} cy={26-(data[0]-min)/(max-min)*22} r={2} fill={color}/>}</> : <text x={50} y={19} textAnchor="middle" fill={MUTED} fontSize={10}>暂无数据</text>}</svg>
}
