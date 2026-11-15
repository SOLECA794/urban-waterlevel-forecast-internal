import { useEffect, useMemo, useState } from 'react'
import { fmtDepth, fmtTime } from '../../domain'
import { useEvalPairs } from '../../data/queries'
import { useWatchlist } from '../../view/useWatchlist'
import type { ZoomProps } from './types'

/**
 * Acc —— 预报和实际差多少。
 *
 * 同一个站的两条线叠在一起：发布时说的（虚线）与后来量到的（实线）。
 * 右上角一个平均误差——**它才是这块图的结论**，两条线只是证据。
 *
 * 两条线的口径必须同源：都换算成水深（绝对水位 − 站点基面），
 * 都用同一档预见期，横轴都用目标时刻。混档会让误差凭空翻倍，
 * 那样这个数字就没法拿去问责，也没法拿去校准。
 *
 * 仿真钟只有 useHealth().now 一个来源；这里不取「现在」，
 * 因为横轴上的每个点都是**已经到点的预报**，本身自带时刻。
 */

const EASE = 'cubic-bezier(.22,.61,.36,1)'

/** 误差超过这个数就标出来（米）。0.10 是值班口径里「明显偏低」的门槛。 */
const ERR_BAD = 0.1

/** 只需要这几个字段，用结构类型接住 EvalPair，避免多引一层类型依赖。 */
interface Pair {
  readonly siteId: string
  readonly targetAt: number
  readonly horizonMin: number
  readonly yhat: number
  readonly actual: number | null
  readonly baseLevel: number
}

interface Pick {
  readonly siteId: string
  readonly name: string
  /** 这一档预见期（分钟） */
  readonly horizon: number
  readonly pts: Pair[]
}

export function Acc({ p, w, h, detail }: ZoomProps) {
  const full = detail === 'full'
  const list = useWatchlist('level')
  const q = useEvalPairs(12)
  const reduce = useReducedMotion()

  const pairs = q.data ?? []
  const pick = useMemo(() => pickSite(pairs, list), [pairs, list])

  // ---- 尺码：小页是「一眼看结论」，放大页要能把 5 组数念出来 ----
  const padX = full ? 44 : 12
  const bandH = full ? 92 : 34
  const tableH = full ? 268 : 0
  const fsName = full ? 22 : 12
  const fsMeta = full ? 14 : 11
  const plotW = Math.max(80, w - padX * 2)
  const plotH = Math.max(56, h - bandH - tableH - (full ? 8 : 6))

  // 图内边距：左边留给水深刻度，下边留给时刻。
  const padL = full ? 96 : 40
  const padR = full ? 28 : 10
  const padT = full ? 16 : 6
  const padB = full ? 40 : 20
  const innerW = Math.max(20, plotW - padL - padR)
  const innerH = Math.max(20, plotH - padT - padB)

  // ---- 口径：深度（米），跳过 actual 为 null 的点 ----
  const depths: number[] = []
  let mae = 0
  let n = 0
  for (const e of pick.pts) {
    depths.push(e.yhat - e.baseLevel)
    if (e.actual != null) {
      depths.push(e.actual - e.baseLevel)
      mae += Math.abs(e.yhat - e.actual)
      n += 1
    }
  }
  const lo = depths.length ? Math.min(0, ...depths) : 0
  const hi = depths.length ? Math.max(0.08, ...depths) : 0.2
  const span = Math.max(0.05, hi - lo)
  const yLo = lo - span * 0.1
  const yHi = hi + span * 0.18

  const t0 = pick.pts.length ? pick.pts[0].targetAt : 0
  const t1 = pick.pts.length ? pick.pts[pick.pts.length - 1].targetAt : 0
  const tSpan = Math.max(60, t1 - t0)

  const x = (t: number) => padL + ((t - t0) / tSpan) * innerW
  const y = (v: number) => padT + (1 - (v - yLo) / (yHi - yLo)) * innerH

  const predPath = pick.pts.map((e, i) => `${i === 0 ? 'M' : 'L'}${x(e.targetAt).toFixed(1)},${y(e.yhat - e.baseLevel).toFixed(1)}`).join(' ')
  const areaPath = predPath
    ? `${predPath} L${x(t1).toFixed(1)},${(padT + innerH).toFixed(1)} L${x(t0).toFixed(1)},${(padT + innerH).toFixed(1)} Z`
    : ''

  // 实测可能中间断档（某个点还没回填），断档就断线，不要用直线连过去。
  const obsSegs: string[] = []
  let seg: string[] = []
  for (const e of pick.pts) {
    if (e.actual == null) {
      if (seg.length > 1) obsSegs.push(seg.join(' '))
      seg = []
      continue
    }
    seg.push(`${seg.length === 0 ? 'M' : 'L'}${x(e.targetAt).toFixed(1)},${y(e.actual - e.baseLevel).toFixed(1)}`)
  }
  if (seg.length > 1) obsSegs.push(seg.join(' '))

  const last = pick.pts.length ? pick.pts[pick.pts.length - 1] : null
  const gx = [0, 0.25, 0.5, 0.75, 1]
  const gy = [0, 0.5, 1]
  const rows = pick.pts.filter((e) => e.actual != null).slice(-5).reverse()

  const waiting = pick.pts.length > 0 && n === 0
  const empty = pick.pts.length === 0

  return (
    <div style={{ width: w, height: h, display: 'flex', flexDirection: 'column', color: p.text, overflow: 'hidden' }}>
      {/* 顶部：左边「哪一个站、哪一档预见期」，右边「差多少」。
          站名与预见期必须同屏出现，否则观众不知道这个误差属于谁。 */}
      <div
        style={{
          height: bandH,
          flex: '0 0 auto',
          display: 'flex',
          alignItems: full ? 'flex-end' : 'center',
          justifyContent: 'space-between',
          padding: `0 ${padX}px`,
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: full ? 8 : 0, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
            <span
              style={{
                fontSize: fsName,
                color: p.text,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {pick.name || '—'}
            </span>
            <span style={{ fontSize: fsMeta, color: p.textFaint, whiteSpace: 'nowrap' }}>
              {pick.horizon / 60} 小时预见期
            </span>
          </div>
          {/* 图例：虚线是谁、实线是谁，不能靠猜 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: full ? 18 : 10 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: full ? 26 : 16, borderTop: `2px dashed ${p.forecast}` }} />
              <span style={{ fontSize: fsMeta, color: p.textDim }}>预测</span>
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: full ? 26 : 16, borderTop: `2px solid ${p.observed}` }} />
              <span style={{ fontSize: fsMeta, color: p.textDim }}>实测</span>
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: full ? 14 : 6, flex: '0 0 auto' }}>
          <span style={{ fontSize: fsMeta, color: p.textFaint }}>平均误差</span>
          <span
            style={{
              fontSize: full ? 34 : 15,
              fontWeight: 600,
              color: p.text,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {n > 0 ? fmtDepth(mae / n) : '—'}
          </span>
          <span style={{ fontSize: fsMeta, color: p.textFaint }}>m</span>
          <span
            style={{
              fontSize: fsMeta,
              color: p.textFaint,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}
          >
            · 样本 {n} 组
          </span>
        </div>
      </div>

      {/* 主图 */}
      <div style={{ flex: '1 1 0', minHeight: 0, position: 'relative', padding: `0 ${padX}px` }}>
        <svg width={plotW} height={plotH} style={{ display: 'block', overflow: 'visible' }}>
          {/* 横向网格 = 水深刻度 */}
          {gy.map((g) => {
            const v = yHi - (yHi - yLo) * g
            const yy = padT + innerH * g
            return (
              <g key={`gy-${g}`}>
                <line x1={padL} x2={padL + innerW} y1={yy} y2={yy} stroke={p.panelLine} strokeWidth={1} />
                <text
                  x={padL - (full ? 12 : 6)}
                  y={yy + (full ? 5 : 4)}
                  textAnchor="end"
                  fontSize={fsMeta}
                  fill={p.textFaint}
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {fmtDepth(Math.max(0, v))}
                </text>
              </g>
            )
          })}
          {/* 纵向刻度 = 目标时刻：4~6 个整点，两页同口径 */}
          {gx.map((g) => {
            const t = t0 + tSpan * g
            const xx = padL + innerW * g
            return (
              <g key={`gx-${g}`}>
                <line
                  x1={xx}
                  x2={xx}
                  y1={padT}
                  y2={padT + innerH}
                  stroke={p.panelLine}
                  strokeWidth={1}
                  opacity={0.6}
                />
                <text
                  x={xx}
                  y={padT + innerH + (full ? 24 : 14)}
                  textAnchor={g === 0 ? 'start' : g === 1 ? 'end' : 'middle'}
                  fontSize={fsMeta}
                  fill={p.textFaint}
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {fmtTime(t, 'HH:mm')}
                </text>
              </g>
            )
          })}

          {/* 预测的面积与虚线：线回答「当时怎么说的」 */}
          {!empty && (
            <>
              <path d={areaPath} fill={p.forecast} fillOpacity={0.07} stroke="none" />
              <path
                d={predPath}
                fill="none"
                stroke={p.forecast}
                strokeWidth={full ? 2.5 : 2}
                strokeDasharray={full ? '7 5' : '5 4'}
                strokeLinejoin="round"
              />
            </>
          )}

          {/* 实测的实线：断档处断开，不用桥接 */}
          {obsSegs.map((d, i) => (
            <path
              key={`obs-${i}`}
              d={d}
              fill="none"
              stroke={p.observed}
              strokeWidth={full ? 3 : 2.4}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {/* 线末端：几何属性带过渡，新数据回填时能看到末端滑过去 */}
          {last && !empty && (
            <circle
              cx={x(last.targetAt)}
              cy={y(last.yhat - last.baseLevel)}
              r={full ? 6 : 4}
              fill={p.panel}
              stroke={p.forecast}
              strokeWidth={2}
              style={{ transition: reduce ? 'none' : `cx 400ms ${EASE}, cy 400ms ${EASE}` }}
            />
          )}
          {last && !empty && last.actual != null && (
            <circle
              cx={x(last.targetAt)}
              cy={y(last.actual - last.baseLevel)}
              r={full ? 6 : 4}
              fill={p.observed}
              style={{ transition: reduce ? 'none' : `cx 400ms ${EASE}, cy 400ms ${EASE}` }}
            />
          )}
        </svg>

        {/* 两种「空」不是一回事：没样本 vs 有预测没实测 */}
        {(waiting || empty) && (
          <div
            style={{
              position: 'absolute',
              left: padX,
              right: padX,
              top: 0,
              bottom: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: full ? 18 : 11,
              color: p.textFaint,
            }}
          >
            {empty ? '这个站还没有到点的预报样本' : '还在等实测结果'}
          </div>
        )}
      </div>

      {/* 放大页底部：最近 5 组数，误差超阈的行给橙色底 + 橙色数字，
          颜色只标「需要看一眼」的那几格，不做装饰。 */}
      {full && (
        <div style={{ height: tableH, flex: '0 0 auto', padding: `10px ${padX}px 0` }}>
          <div
            style={{
              display: 'flex',
              fontSize: 14,
              color: p.textFaint,
              padding: '0 10px 8px',
              borderBottom: `1px solid ${p.panelLine}`,
            }}
          >
            <span style={{ width: 240 }}>时刻</span>
            <span style={{ flex: '1 1 0', textAlign: 'right' }}>预测</span>
            <span style={{ flex: '1 1 0', textAlign: 'right' }}>实测</span>
            <span style={{ flex: '1 1 0', textAlign: 'right' }}>误差</span>
          </div>
          {rows.length === 0 ? (
            <div style={{ fontSize: 14, color: p.textFaint, padding: '12px 10px' }}>还没有回填的实测</div>
          ) : (
            rows.map((e) => {
              const obs = e.actual ?? 0
              const err = Math.abs(e.yhat - obs)
              const bad = err > ERR_BAD
              return (
                <div
                  key={e.targetAt}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    fontSize: 14,
                    color: p.text,
                    padding: '9px 10px',
                    background: bad ? p.levelSoft.orange : 'transparent',
                    borderBottom: `1px solid ${p.panelLine}`,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  <span style={{ width: 240, color: p.textDim }}>{fmtTime(e.targetAt, 'HH:mm')}</span>
                  <span style={{ flex: '1 1 0', textAlign: 'right' }}>{fmtDepth(e.yhat - e.baseLevel)} m</span>
                  <span style={{ flex: '1 1 0', textAlign: 'right' }}>{fmtDepth(obs - e.baseLevel)} m</span>
                  <span
                    style={{
                      flex: '1 1 0',
                      textAlign: 'right',
                      color: bad ? p.levelInk.orange : p.textDim,
                      fontWeight: bad ? 600 : 400,
                    }}
                  >
                    {fmtDepth(err)} m
                  </span>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- 选站 */

/**
 * 选哪个站、用哪一档预见期。
 *
 * 默认是列表第一（最深）那站；如果它一个样本都没有，退到样本最多的站——
 * 展示「有数据的站」比展示「最重要但空的站」对观众有用。
 * 预见期优先 1h（口径最硬），1h 样本不足两点时退到样本最多的那一档，
 * 并把档位写在标题旁，让观众知道自己在看几小时的预报。
 */
function pickSite(
  pairs: readonly Pair[],
  list: readonly { site: { id: string; name: string } }[],
): Pick {
  const bySite = new Map<string, number>()
  for (const e of pairs) {
    const id = e.siteId
    bySite.set(id, (bySite.get(id) ?? 0) + 1)
  }

  let siteId = list[0]?.site.id ?? ''
  if (!siteId || !bySite.get(siteId)) {
    let best = ''
    let most = 0
    for (const [id, c] of bySite) {
      if (c > most) {
        most = c
        best = id
      }
    }
    siteId = best || siteId
  }

  const mine = pairs.filter((e) => e.siteId === siteId)
  const byH = new Map<number, number>()
  for (const e of mine) {
    const hm = e.horizonMin
    byH.set(hm, (byH.get(hm) ?? 0) + 1)
  }
  let horizon = 60
  if ((byH.get(60) ?? 0) < 2) {
    let bestH = 60
    let most = -1
    for (const [hm, c] of byH) {
      if (c > most) {
        most = c
        bestH = hm
      }
    }
    if (most > 0) horizon = bestH
  }

  const pts = mine
    .filter((e) => e.horizonMin === horizon)
    .slice()
    .sort((a, b) => a.targetAt - b.targetAt)

  const name = list.find((g) => g.site.id === siteId)?.site.name ?? siteId
  return { siteId, name, horizon, pts }
}

/**
 * 只在「用户关了动效」时返回 true。大屏 24 小时开着，
 * 转速旋钮不会有第二个状态，所以用状态而不是纯 CSS 媒体查询，
 * 让 reduced-motion 在 JS 里可测。
 */
function useReducedMotion(): boolean {
  const [on, setOn] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handler = () => setOn(mq.matches)
    handler()
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return on
}
