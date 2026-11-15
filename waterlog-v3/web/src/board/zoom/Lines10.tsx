import { useEffect, useMemo, useState } from 'react'
import { LEVEL_RANK, curveAt, fmtClock, fmtDepth } from '../../domain'
import type { Forecast, Level, SiteSeries } from '../../domain'
import { useAllHistory, useForecast } from '../../data/queries'
import { useWatchlist, type SiteGlance } from '../../view/useWatchlist'
import type { ZoomProps } from './types'

/**
 * Lines10 —— 十站水位预测叠在一张图里。
 *
 * 回答的问题是「这波雨是面上的还是点上的」：十条线一起抬起来就是面雨，
 * 只有两三条翘起来就是点位内涝。所以十根线必须在**同一个坐标系**里，
 * 而且纵轴只能是水深（米）——绝对水位跨站差十几米，叠在一起是几簇断线。
 *
 * 三个刻意的取舍：
 *  - 只画红阈一条。四条阈值线乘十根曲线会把图糊成格子布，而值班员第一眼
 *    只关心「谁越了红线」，其余三档在左侧清单里已经写着。
 *  - 只在最深的前 6 根线末端标站名。十条标签在 600px 宽里必然互相压住，
 *    干脆让最该看的那几根自己报名，其余靠颜色和「哪根最高」自己说话。
 *  - 实测实线、预测虚线，在「现在」处用一条竖虚线断开：这两段的口径不同
 *    （测量 vs 模型），用线型区分比用颜色区分更不抢水位等级色。
 */

const HIST_H = 6
const AHEAD_H = 12
const EASE = 'cubic-bezier(.22,.61,.36,1)'

interface Pt {
  readonly t: number
  readonly d: number
}

interface Row {
  readonly id: string
  readonly name: string
  readonly level: Level
  /** 当前实测水深，用来排「最深的前 6 根」和底部表 */
  readonly depth: number
  readonly obs: readonly Pt[]
  readonly fc: readonly Pt[]
  readonly last: Pt | null
  readonly peakD: number
  readonly peakT: number
}

interface Model {
  readonly nowT: number
  readonly t0: number
  readonly t1: number
  readonly yMax: number
  readonly redDeep: number
  readonly rows: readonly Row[]
}

function buildModel(
  list: readonly SiteGlance[],
  fc: Forecast | undefined,
  hist: Record<string, SiteSeries> | undefined,
): Model | null {
  // 首帧：清单先到、预测还没到，也走空状态——没有曲线的空坐标系更让人以为坏了。
  if (list.length === 0 || !fc || !hist) return null

  // 「现在」取「最后一条实测」与「预测发布时刻」里靠后的那个。
  // 这两个时刻在仿真轴上差几分钟（历史 30s 一刷、预测 60s 一刷），
  // 取靠后的那个，两条线才会在竖线上接住，而不是留一条缝。
  let lastObs = 0
  for (const s of Object.values(hist)) {
    const p = s.points[s.points.length - 1]
    if (p && p.at > lastObs) lastObs = p.at
  }
  const issued = fc.issuedAt
  const nowT = Math.max(lastObs, issued)
  const t0 = nowT - HIST_H * 3600
  const t1 = nowT + AHEAD_H * 3600

  const rows: Row[] = []
  for (const g of list) {
    const base = g.site.baseLevel
    const series = hist[g.site.id]
    const sf = fc.sites[g.site.id]

    const obs: Pt[] = []
    if (series) {
      for (const q of series.points) {
        if (q.at >= t0 && q.at <= nowT) obs.push({ t: q.at, d: q.level - base })
      }
    }

    // 预测曲线按「发布时刻 + 偏移」还原到真实时间轴，再裁掉「现在」之前那段：
    // 发布时刻常比最后一条实测早 5~10 分钟，不裁的话虚线会插进实测段下面。
    const fcp: Pt[] = []
    if (sf) {
      for (const c of sf.curve) {
        const t = issued + c.offsetMin * 60
        if (t >= nowT && t <= t1) fcp.push({ t, d: c.level - base })
      }
      // 预测发布时刻常比最后一帧实测早 5~30 分钟，裁掉过去那段之后虚线会从
      // 竖线右侧才起笔。按 nowT 插一个点补上，十根线才都在同一处接住。
      if (fcp.length === 0 || fcp[0].t > nowT + 1) {
        const c = curveAt(sf.curve, Math.max(0, (nowT - issued) / 60))
        if (c) fcp.unshift({ t: nowT, d: c.level - base })
      }
    }

    let peakD = Number.NEGATIVE_INFINITY
    let peakT = nowT
    for (const p of obs) {
      if (p.d > peakD) {
        peakD = p.d
        peakT = p.t
      }
    }
    for (const p of fcp) {
      if (p.d > peakD) {
        peakD = p.d
        peakT = p.t
      }
    }

    const lastObsPt = obs.length > 0 ? obs[obs.length - 1] : null
    const lastFcPt = fcp.length > 0 ? fcp[fcp.length - 1] : null

    rows.push({
      id: g.site.id,
      name: g.site.name,
      level: g.assessment.level,
      depth: g.reading.depth,
      obs,
      fc: fcp,
      last: lastFcPt ?? lastObsPt,
      peakD: Number.isFinite(peakD) ? peakD : 0,
      peakT,
    })
  }

  // 纵轴上限 = max(所有站出现过的水深, 最深站红阈 × 1.3)，再向上取整到
  // 0.2/0.5/1.0 的整数倍，好让刻度落在人能读的数上（2.80 会把顶线顶到
  // 边框上，取 3.0 之后顶线下面还能留一点气）。
  let maxD = 0
  for (const r of rows) if (r.peakD > maxD) maxD = r.peakD
  const redDeep = list[0].redThreshold
  const yMax = niceTop(Math.max(maxD, redDeep * 1.3))

  return { nowT, t0, t1, yMax, redDeep, rows }
}

/** 取到「好看的」上界：0.2 / 0.5 / 1.0 的整数倍。 */
function niceTop(v: number): number {
  const step = v >= 2.4 ? 1 : v >= 1.2 ? 0.5 : 0.2
  return Math.max(step, Math.ceil(v / step - 1e-9) * step)
}

/** 站名太长会顶到画布外，按两种尺寸各自截断。 */
function shortName(n: string, max: number): string {
  return n.length > max ? `${n.slice(0, max - 1)}…` : n
}

export function Lines10({ p, w, h, detail }: ZoomProps) {
  const full = detail === 'full'
  const list = useWatchlist('level')
  const forecast = useForecast()
  const history = useAllHistory(HIST_H)
  const reduce = useReducedMotion()

  const model = useMemo(
    () => buildModel(list, forecast.data, history.data),
    [list, forecast.data, history.data],
  )

  // ---- 尺码：compact 与 full 各自给，不做等比缩放 ----
  const padL = full ? 100 : 46
  const padR = full ? 132 : 78
  const padT = full ? 48 : 22
  const padB = full ? 34 : 20
  const tableH = full ? 116 : 0
  const fs = full ? 14 : 11
  const gapLabel = full ? 18 : 15

  const svgH = h - tableH
  const plotW = Math.max(40, w - padL - padR)
  const plotH = Math.max(30, svgH - padT - padB)
  const x0 = padL
  const xRight = padL + plotW
  const yBottom = padT + plotH

  if (!model) {
    return (
      <div
        style={{
          width: w,
          height: h,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: p.textFaint,
          fontSize: full ? 16 : 11,
        }}
      >
        等待首帧预测
      </div>
    )
  }

  const span = model.t1 - model.t0
  const xOf = (t: number) => x0 + ((t - model.t0) / span) * plotW
  const yOf = (d: number) =>
    yBottom - (Math.min(model.yMax, Math.max(0, d)) / model.yMax) * plotH

  // 纵轴刻度：3m 的图给 1m 一格，1.5m 给 0.5m，小水位的站给 0.2m。
  const tickStep = model.yMax >= 2.4 ? 1 : model.yMax >= 1.2 ? 0.5 : 0.2
  const yTicks: number[] = []
  for (let v = 0; v <= model.yMax + 1e-9; v += tickStep) {
    yTicks.push(Math.round(v * 100) / 100)
  }

  const nowT = model.nowT
  const tTicks = full
    ? [-6, -3, 0, 3, 6, 9, 12].map((hh) => nowT + hh * 3600)
    : [model.t0, nowT, model.t1]

  const pathOf = (pts: readonly Pt[]) =>
    pts.length === 0
      ? ''
      : 'M' + pts.map((q) => `${xOf(q.t).toFixed(1)},${yOf(q.d).toFixed(1)}`).join('L')

  // 非告警的线先画，红/橙压在上面：一旦两条线重叠，先被盖住的必须是
  // 「不用管」的那条。
  const order = [...model.rows].sort(
    (a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.depth - a.depth,
  )

  // 只标最深的前 6 根（不是等级最高的 6 根：值班员问的是「哪摊水最深」）。
  // 第 1 页那张卡只有 460px 宽，标 6 个站名会挤成一团——小尺寸只留最深 3 个，
  // 完整的十个站名交给第 3 页。
  const labelled = new Set(
    [...model.rows]
      .sort((a, b) => b.depth - a.depth)
      .slice(0, full ? 6 : 3)
      .map((r) => r.id),
  )

  // 标签纵向去重叠：按 y 排好后逐个往下推，再从底部往回压，
  // 保证不越出画布、也不两两压字。
  const labels: { row: Row; y: number }[] = []
  for (const r of order) {
    if (!labelled.has(r.id) || !r.last) continue
    labels.push({ row: r, y: yOf(r.last.d) })
  }
  labels.sort((a, b) => a.y - b.y)
  for (let i = 1; i < labels.length; i++) {
    labels[i].y = Math.max(labels[i].y, labels[i - 1].y + gapLabel)
  }
  for (let i = labels.length - 1; i >= 0; i--) {
    const cap = yBottom - (labels.length - 1 - i) * gapLabel
    if (labels[i].y > cap) labels[i].y = cap
  }

  // 图例（实测/预测）右上角，与「水深 m」标题同一行，互不打扰。
  const sw = full ? 22 : 16
  const gapT = full ? 6 : 4
  const textW = full ? 30 : 24
  const itemW = sw + gapT + textW
  const legendY = padT - 12
  const lx = xRight - itemW * 2 - 12

  const yRed = yOf(model.redDeep)
  const xNow = xOf(nowT)

  // 底板表：前 5 站峰值与见顶时刻。
  const top5 = [...model.rows].sort((a, b) => b.depth - a.depth).slice(0, 5)
  // 五站的峰值时刻常常全是「此刻」——那是本轮雨还没退，不是写错了。
  // 重复五遍同一个时间看着像 bug，所以合成一句写在表头。
  const peekSame = top5.length > 1 && top5.every((r) => r.peakT === top5[0].peakT)

  return (
    <div
      style={{
        width: w,
        height: h,
        display: 'flex',
        flexDirection: 'column',
        color: p.text,
        overflow: 'hidden',
      }}
    >
      <svg width={w} height={svgH} style={{ display: 'block', flex: '0 0 auto' }}>
        {/* 横向网格 + 纵轴刻度 */}
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line
              x1={x0}
              x2={xRight}
              y1={yOf(v)}
              y2={yOf(v)}
              stroke={p.panelLine}
              strokeWidth={1}
            />
            <text
              x={x0 - 8}
              y={yOf(v)}
              fontSize={fs}
              fill={p.textFaint}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {v.toFixed(1)}
            </text>
          </g>
        ))}
        <text
          transform={`translate(${full ? 18 : 12}, ${padT + plotH / 2}) rotate(-90)`}
          textAnchor="middle"
          fontSize={fs}
          fill={p.textFaint}
        >
          水深 m
        </text>

        {/* 图例 */}
        <line x1={lx} x2={lx + sw} y1={legendY} y2={legendY} stroke={p.observed} strokeWidth={2} />
        <text x={lx + sw + gapT} y={legendY} fontSize={fs} fill={p.textDim} dominantBaseline="middle">
          实测
        </text>
        <line
          x1={lx + itemW + 8}
          x2={lx + itemW + 8 + sw}
          y1={legendY}
          y2={legendY}
          stroke={p.forecast}
          strokeWidth={2}
          strokeDasharray={full ? '6 4' : '4 3'}
        />
        <text
          x={lx + itemW + 8 + sw + gapT}
          y={legendY}
          fontSize={fs}
          fill={p.textDim}
          dominantBaseline="middle"
        >
          预测
        </text>

        {/* 红阈：十根线只配这一条参考线 */}
        <line
          x1={x0}
          x2={xRight}
          y1={yRed}
          y2={yRed}
          stroke={p.level.red}
          strokeWidth={1}
          strokeDasharray={full ? '7 5' : '5 4'}
          opacity={0.55}
        />
        <text x={xRight - 4} y={yRed - 6} fontSize={fs} fill={p.textFaint} textAnchor="end">
          红阈 {fmtDepth(model.redDeep)} m
        </text>

        {/* 现在：实测与预测的分界，也是这条线上唯一会随数据推进的竖线 */}
        <line
          x1={xNow}
          x2={xNow}
          y1={padT}
          y2={yBottom}
          stroke={p.textFaint}
          strokeWidth={1}
          strokeDasharray={full ? '4 5' : '3 4'}
          opacity={0.5}
        />
        <text x={xNow + 5} y={padT - 6} fontSize={fs} fill={p.textDim}>
          现在
        </text>

        {order.map((r) => {
          const color = p.level[r.level]
          const wide = r.level === 'red' || r.level === 'orange'
          const sw2 = wide ? 2.6 : 1.4
          return (
            <g key={r.id}>
              {r.obs.length > 1 && (
                <path
                  d={pathOf(r.obs)}
                  fill="none"
                  stroke={color}
                  strokeWidth={sw2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
              {r.fc.length > 1 && (
                <path
                  d={pathOf(r.fc)}
                  fill="none"
                  stroke={color}
                  strokeWidth={sw2}
                  strokeDasharray={full ? '6 4' : '4 3'}
                  strokeLinecap="round"
                />
              )}
              {/* 末端圆点：整块图里唯一「会动」的东西。数据一刷，它沿 x 往右
                  glide 一格——这就是「曲线在推进」在静态 SVG 里的可见形式
                  （path 的 d 不能过渡，圆点可以）。 */}
              {r.last && (
                <g
                  style={{
                    transform: `translate(${xOf(r.last.t)}px, ${yOf(r.last.d)}px)`,
                    transition: reduce ? 'none' : `transform 420ms ${EASE}`,
                  }}
                >
                  <circle r={3.5} fill={color} />
                </g>
              )}
            </g>
          )
        })}

        {/* 站名：只给最深的前 6 根 */}
        {labels.map(({ row, y }) => (
          <g key={`lb${row.id}`}>
            {row.last && Math.abs(y - yOf(row.last.d)) > 1.5 && (
              <line
                x1={xRight + 2}
                y1={yOf(row.last.d)}
                x2={xRight + 7}
                y2={y}
                stroke={p.level[row.level]}
                strokeWidth={1}
                opacity={0.55}
              />
            )}
            <text
              x={xRight + 9}
              y={y}
              fontSize={fs}
              fill={p.textDim}
              dominantBaseline="middle"
            >
              {shortName(row.name, full ? 8 : 4)}
            </text>
          </g>
        ))}

        {/* 横轴 */}
        <line x1={x0} x2={xRight} y1={yBottom} y2={yBottom} stroke={p.panelLine} />
        {tTicks.map((t, i) => {
          const x = xOf(t)
          const anchor = i === 0 ? 'start' : i === tTicks.length - 1 ? 'end' : 'middle'
          const label = full
            ? fmtClock(t)
            : i === 0
              ? `${HIST_H}h 前`
              : i === tTicks.length - 1
                ? `${AHEAD_H}h 后`
                : '现在'
          return (
            <g key={`tt${t}`}>
              <line x1={x} x2={x} y1={yBottom} y2={yBottom + 4} stroke={p.panelLine} />
              <text
                x={x}
                y={yBottom + (full ? 22 : 16)}
                fontSize={fs}
                fill={p.textFaint}
                textAnchor={anchor}
              >
                {label}
              </text>
            </g>
          )
        })}
      </svg>

      {full && (
        <div
          style={{
            height: tableH,
            borderTop: `1px solid ${p.panelLine}`,
            display: 'flex',
            flexDirection: 'column',
            flex: '0 0 auto',
          }}
        >
          <div style={{ fontSize: 14, color: p.textFaint, padding: '5px 14px 1px' }}>
            最深前 5 站 · 峰值与见顶时刻
          </div>
          <div style={{ display: 'flex', flex: '1 1 auto' }}>
            {top5.map((r, i) => (
              <div
                key={r.id}
                style={{
                  flex: '1 1 0',
                  padding: '0 14px 6px',
                  borderLeft: i > 0 ? `1px solid ${p.panelLine}` : 'none',
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    fontSize: 14,
                    color: p.textDim,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {r.name}
                </div>
                <div style={{ fontSize: 22, lineHeight: 1.15, color: p.text }}>
                  {fmtDepth(Math.max(0, r.peakD))}
                  <span style={{ fontSize: 14, color: p.textFaint }}> m</span>
                </div>
                <div style={{ fontSize: 14, color: p.textFaint }}>
                  {peekSame ? '此刻见顶' : `见顶 ${fmtClock(r.peakT)}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 只在系统开了「减少动态效果」时返回 true。
 *
 * 大屏常年无人操作，这个开关不会中途被点，所以用的是状态而不是 CSS
 * 媒体查询：过渡写在 style 里，关掉时直接给 `none`，一次重排都不留。
 */
function useReducedMotion(): boolean {
  const [on, setOn] = useState(
    () =>
      typeof window !== 'undefined' &&
      !!window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
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
