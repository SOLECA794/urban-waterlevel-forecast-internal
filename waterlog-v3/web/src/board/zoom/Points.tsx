import { useEffect, useRef, useState } from 'react'
import { fmtClock, fmtDelta, fmtDepth } from '../../domain'
import type { CurvePoint } from '../../domain'
import { useForecast } from '../../data/queries'
import { useWatchlist } from '../../view/useWatchlist'
import type { ZoomProps } from './types'

/**
 * Points —— 四个预见期落点（1h / 3h / 6h / 12h）。
 *
 * 一块「报数」的图：四个大数字 + 四根短柱，回答「一小时后多少、三小时后多少」。
 * 柱子长度是「预见期水深 / 红阈」，越过红阈就满格并在末端加一个小三角 ——
 * 满格本身就是信息（这根柱子已经被顶到头了），不用再读数字。
 *
 * 放大页下面补了一条 12 小时预测带：四个数字是这条曲线的四个采样点，
 * 不给曲线的话，读者无法判断「这几个数是模型自己在变，还是站点在上冲」。
 */

const EASE = 'cubic-bezier(.22,.61,.36,1)'

export function Points({ p, w, h, detail }: ZoomProps) {
  const full = detail === 'full'
  const list = useWatchlist('level')
  const forecast = useForecast()
  const reduce = useReducedMotion()

  const g = list[0] ?? null
  const sf = g ? forecast.data?.sites[g.site.id] : undefined
  const base = g ? g.site.baseLevel : 0
  const red = g && g.redThreshold > 0 ? g.redThreshold : 0.5
  const nowD = g ? Math.max(0, g.reading.depth) : 0

  const issued = forecast.data?.issuedAt ?? 0
  const horizons = sf ? sf.horizons : []
  const depths = horizons.map((o) => Math.max(0, o.level - base))
  const eased = useEasedAll([...depths, nowD], 420, reduce)
  const peak = depths.length > 0 ? Math.max(...depths) : nowD
  const spread = depths.length > 0 ? Math.max(...depths) - Math.min(...depths) : 0

  const padX = full ? 56 : 14
  const padT = full ? 28 : 12
  const footerH = full ? 22 : 18
  const rowH = full ? 232 : Math.max(110, h - padT - footerH - 26)
  // 放大页里四根短柱只占上方 232px，剩下的一大半交给这张 12h 落点图。
  // 早先写死 420 的上限，结果整页下面空出 300 多像素——空白是排版里最贵的错误。
  const stripH = full ? Math.max(180, h - padT - rowH - 24 - 30 - footerH) : 0

  // 小尺寸那张卡只有 280px 宽、还要塞四列：26px 的「0.05」正好比列宽多两像素，
  // 四列会挤成一串数字。21px + 负字距之后四列各留得下 5 个字符。
  const numFs = full ? 64 : 21
  const unitFs = full ? 24 : 13
  const fs = full ? 14 : 11
  const labelFs = full ? 15 : 11
  const barH = full ? 18 : 8

  if (!g || !sf) {
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

  const thresholds = g.site.thresholds
  const ticks = (['blue', 'yellow', 'orange'] as const).map((k) => ({
    k,
    at: red > 0 ? (thresholds[k] as number) / red : 0,
  }))

  // 12h 预测带（放大页用）
  const band = makeBand(sf.horizons, sf.curve)
  const pts = sf.curve.map((c) => {
    const b = band(c)
    return { o: c.offsetMin, d: c.level - base, up: b.up - base, lo: b.lo - base }
  })
  const stripTop = padT + rowH + 24

  return (
    <div style={{ position: 'relative', width: w, height: h, color: p.text, overflow: 'hidden' }}>
      {/* 四格 KPI：数字、较现在的差、短柱 */}
      <div
        style={{
          position: 'absolute',
          left: padX,
          right: padX,
          top: padT,
          height: rowH,
          display: 'flex',
          alignItems: 'stretch',
        }}
      >
        {horizons.map((o, i) => {
          const d = depths[i]
          const ratio = red > 0 ? d / red : 0
          const lv: 'none' | 'blue' | 'yellow' | 'orange' | 'red' =
            d >= thresholds.red
              ? 'red'
              : d >= thresholds.orange
                ? 'orange'
                : d >= thresholds.yellow
                  ? 'yellow'
                  : d >= thresholds.blue
                    ? 'blue'
                    : 'none'
          const fill = p.level[lv]
          const half = o.upper - o.lower > 1e-6 ? (o.upper - o.lower) / 2 : 1.65 * o.sigma
          return (
            <div key={o.horizonMin} style={{ display: 'flex', flex: 1, minWidth: 0 }}>
              {i > 0 && (
                <div
                  style={{
                    width: 1,
                    background: p.panelLine,
                    margin: `${full ? 28 : 12}px 0`,
                    alignSelf: 'stretch',
                    opacity: 0.9,
                  }}
                />
              )}
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  gap: full ? 10 : 6,
                  paddingLeft: i > 0 ? (full ? 28 : 10) : 0,
                  paddingRight: full ? 16 : 11,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span style={{ fontSize: labelFs, color: p.textDim }}>
                    {full ? `${o.horizonMin / 60}h 后` : `${o.horizonMin / 60}h`}
                  </span>
                  {full && (
                    <span style={{ fontSize: fs, color: p.textFaint }}>
                      {fmtClock(issued + o.horizonMin * 60)}
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'baseline', gap: full ? 10 : 4, lineHeight: 1 }}>
                  <span style={{ fontSize: numFs, fontWeight: 600, letterSpacing: full ? '-0.02em' : '-0.04em', whiteSpace: 'nowrap' }}>
                    {fmtDepth(eased[i])}
                  </span>
                  <span style={{ fontSize: unitFs, color: p.textDim }}>m</span>
                </div>

                <div style={{ fontSize: fs, color: p.textDim }}>
                  较现在 {fmtDelta(eased[i] - eased[eased.length - 1], 2)}
                </div>

                <div
                  style={{
                    position: 'relative',
                    height: barH,
                    borderRadius: barH / 2,
                    background: p.panelLine,
                    marginTop: full ? 6 : 2,
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: `${Math.min(100, Math.max(0, ratio * 100))}%`,
                      borderRadius: barH / 2,
                      background: fill,
                      transition: reduce ? 'none' : `width 400ms ${EASE}`,
                    }}
                  />
                  {full &&
                    ticks.map((t) => (
                      <div
                        key={t.k}
                        style={{
                          position: 'absolute',
                          top: -3,
                          bottom: -3,
                          left: `${Math.min(100, Math.max(0, t.at * 100))}%`,
                          width: 1,
                          background: p.level[t.k],
                          opacity: 0.85,
                        }}
                      />
                    ))}
                  {ratio > 1 && (
                    <div
                      style={{
                        position: 'absolute',
                        left: '100%',
                        top: '50%',
                        width: 0,
                        height: 0,
                        transform: 'translateY(-50%)',
                        marginLeft: 3,
                        borderTop: `${barH / 2}px solid transparent`,
                        borderBottom: `${barH / 2}px solid transparent`,
                        borderLeft: `${full ? 9 : 7}px solid ${fill}`,
                      }}
                    />
                  )}
                </div>

                {full && (
                  <div style={{ display: 'flex', gap: 16, fontSize: fs, color: p.textFaint }}>
                    <span>模型 {o.model}</span>
                    <span>±{fmtDepth(half)}</span>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* 放大页：12 小时预测带，四个落点就是这条线上的四个采样 */}
      {full && (
        <div
          style={{
            position: 'absolute',
            left: padX,
            right: padX,
            top: stripTop,
            height: stripH,
          }}
        >
          <Strip p={p} pts={pts} red={red} reduce={reduce} w={w - padX * 2} h={stripH} fs={fs} />
        </div>
      )}

      <div
        style={{
          position: 'absolute',
          left: padX,
          right: padX,
          bottom: full ? 20 : 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: fs,
          color: p.textFaint,
        }}
      >
        <span>
          现在 {fmtDepth(nowD)} m · 红阈 {fmtDepth(red)} m
          {full ? ` · 签发 ${fmtClock(issued)}` : ''}
        </span>
        <span>
          {spread < 1e-3 ? '四个预见期同值 · 预测曲线持平' : `最高 ${fmtDepth(peak)} m`}
        </span>
      </div>
    </div>
  )
}

/** 12 小时预测带：一条虚线 + 上下界 + 四个落点。 */
function Strip({
  p,
  pts,
  red,
  reduce,
  w,
  h,
  fs,
}: {
  p: ZoomProps['p']
  pts: readonly { o: number; d: number; up: number; lo: number }[]
  red: number
  reduce: boolean
  w: number
  h: number
  fs: number
}) {
  const padL = 56
  const padR = 48
  const padT = 24
  const padB = 26
  const iw = Math.max(40, w - padL - padR)
  const ih = Math.max(40, h - padT - padB)

  const yMax = niceTop(Math.max(red * 1.3, ...pts.map((q) => Math.max(q.d, q.up, 0.001))))
  const xOf = (o: number) => padL + (o / 720) * iw
  const yOf = (d: number) => padT + ih - (Math.min(yMax, Math.max(0, d)) / yMax) * ih

  const line = pts.length === 0 ? '' : 'M' + pts.map((q) => `${xOf(q.o).toFixed(1)},${yOf(q.d).toFixed(1)}`).join('L')
  const area =
    pts.length < 2
      ? ''
      : `M${pts.map((q) => `${xOf(q.o).toFixed(1)},${yOf(q.up).toFixed(1)}`).join('L')}L${[...pts]
          .reverse()
          .map((q) => `${xOf(q.o).toFixed(1)},${yOf(q.lo).toFixed(1)}`)
          .join('L')}Z`

  const last = pts.length > 0 ? pts[pts.length - 1] : null
  const yLabelGap = Math.abs(yOf(red) - yOf(0))

  return (
    <svg width={w} height={h}>
      <text x={padL} y={padT - 8} fontSize={fs} fill={p.textDim}>
        未来 12 小时预测
      </text>
      <line x1={padL} x2={padL + iw} y1={yOf(0)} y2={yOf(0)} stroke={p.panelLine} />
      <line x1={padL} x2={padL + iw} y1={padT} y2={padT} stroke={p.panelLine} />
      <text x={padL - 8} y={yOf(0)} fontSize={fs} fill={p.textFaint} textAnchor="end" dominantBaseline="middle">
        0
      </text>
      <text x={padL - 8} y={padT} fontSize={fs} fill={p.textFaint} textAnchor="end" dominantBaseline="middle">
        {yMax.toFixed(1)}
      </text>

      {area && <path d={area} fill={p.forecast} opacity={0.12} />}

      <line
        x1={padL}
        x2={padL + iw}
        y1={yOf(red)}
        y2={yOf(red)}
        stroke={p.level.red}
        strokeWidth={1}
        strokeDasharray="7 5"
        opacity={0.6}
      />
      {yLabelGap > 15 && (
        <text x={padL + iw - 4} y={yOf(red) - 7} fontSize={fs} fill={p.textFaint} textAnchor="end">
          红阈 {fmtDepth(red)} m
        </text>
      )}

      {pts.length > 1 && (
        <path d={line} fill="none" stroke={p.forecast} strokeWidth={2.4} strokeDasharray="7 5" />
      )}

      {[60, 180, 360, 720].map((o) => {
        const q = pts.find((e) => e.o === o)
        const x = xOf(o)
        return (
          <g key={`h${o}`}>
            <line x1={x} x2={x} y1={padT} y2={padT + ih} stroke={p.panelLine} strokeDasharray="2 4" />
            {q && <circle cx={x} cy={yOf(q.d)} r={4} fill={q.d >= red ? p.level.red : p.forecast} />}
            <text x={x} y={padT + ih + 17} fontSize={fs} fill={p.textFaint} textAnchor="middle">
              {o / 60}h
            </text>
          </g>
        )
      })}

      {last && (
        <g
          style={{
            transform: `translate(${xOf(last.o)}px, ${yOf(last.d)}px)`,
            transition: reduce ? 'none' : `transform 420ms ${EASE}`,
          }}
        >
          <circle r={4.5} fill={p.forecast} />
        </g>
      )}
    </svg>
  )
}

/**
 * 上下界。
 *
 * 接口眼下给的 lower/upper 与 level 重合（区间还没回填），照抄会画出一条零宽的
 * 锥子，等于没有信息。`sigma`（残差标准差）是真值，这里退化成 ±1.65σ
 * （约 90% 区间）并在四个预见期之间线性插值；哪天接口把区间回填了，
 * 检测到 upper−lower 有宽度就自动切回去，这段退化逻辑不会挡路。
 */
function makeBand(
  horizons: readonly { horizonMin: number; sigma: number; lower: number; upper: number }[],
  curve: readonly CurvePoint[],
): (c: CurvePoint) => { up: number; lo: number } {
  let flat = curve.length > 0
  for (const c of curve) {
    if (c.upper - c.lower > 1e-6) {
      flat = false
      break
    }
  }
  const anchors: { o: number; s: number }[] = [{ o: 0, s: 0 }]
  for (const o of horizons) anchors.push({ o: o.horizonMin, s: o.sigma })

  const sigmaAt = (o: number): number => {
    if (anchors.length < 2) return 0
    if (o <= anchors[0].o) return anchors[0].s
    for (let i = 1; i < anchors.length; i++) {
      if (o <= anchors[i].o) {
        const a = anchors[i - 1]
        const b = anchors[i]
        const k = b.o === a.o ? 1 : (o - a.o) / (b.o - a.o)
        return a.s + (b.s - a.s) * k
      }
    }
    return anchors[anchors.length - 1].s
  }

  return (c: CurvePoint) => {
    if (!flat) return { up: c.upper, lo: c.lower }
    const half = 1.65 * sigmaAt(c.offsetMin)
    return { up: c.level + half, lo: c.level - half }
  }
}

function niceTop(v: number): number {
  const step = v >= 2.4 ? 1 : v >= 1.2 ? 0.5 : 0.2
  return Math.max(step, Math.ceil(v / step - 1e-9) * step)
}

/**
 * 一组数字的平滑过渡：数据一刷，四个数一起往新值推（420ms）。
 *
 * 为什么不用 CSS：大数字是文本，text-content 不能过渡。一条 rAF 循环推四个值
 * 只有一次 setState/帧，比给每个数字挂一条动画便宜。长度变化（首帧预测到达）
 * 时直接落位，不从半路插值 —— 否则第一次渲染会看到四个数从 0 往上爬。
 */
function useEasedAll(targets: readonly number[], ms: number, off: boolean): number[] {
  const [vals, setVals] = useState<number[]>(() => [...targets])
  const valsRef = useRef<number[]>(vals)
  valsRef.current = vals
  const key = targets.join(',')

  useEffect(() => {
    const to = key.split(',').map(Number)
    const from = valsRef.current
    if (off || from.length !== to.length) {
      setVals(to)
      return
    }
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / ms)
      const e = 1 - Math.pow(1 - k, 3)
      setVals(to.map((v, i) => from[i] + (v - from[i]) * e))
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [key, ms, off])

  return vals.length === targets.length ? vals : [...targets]
}

/** 只在系统开了「减少动态效果」时返回 true。 */
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
