import { useEffect, useMemo, useRef, useState } from 'react'
import { curveAt, fmtClock, fmtDepth } from '../../domain'
import type { CurvePoint } from '../../domain'
import { useAllHistory, useForecast } from '../../data/queries'
import { useWatchlist } from '../../view/useWatchlist'
import type { ZoomProps } from './types'

/**
 * LineOne —— 最深那一站的水位过程。
 *
 * 左半是实测（过去 6 小时），右半是预测（未来 12 小时），预测段外面围一圈
 * 半透明的上/下界，读起来就是「接下来会涨到哪、最坏到哪」。
 *
 * 为什么只画红阈一条：放大页有 1900px 宽，四条阈值线横穿整屏会变成斑马线，
 * 而这块图要回答的是「这摊水是怎么涨上来的、接下来到多少」——只有红线是
 * 那个「要不要现在派人」的分界。
 *
 * 大数字与曲线必须是**同一个口径**：都用积水深（level − baseLevel）。
 * 接口给的 `horizons[].level` / `curve[].level` 是绝对水位，高程十几米，
 * 直接摆出来跟 2.67m 的红阈没有可比性。
 */

const HIST_H = 6
const EASE = 'cubic-bezier(.22,.61,.36,1)'

interface FPt {
  readonly t: number
  readonly d: number
  /** 上界水深 */
  readonly up: number
  /** 下界水深 */
  readonly lo: number
}

export function LineOne({ p, w, h, detail }: ZoomProps) {
  const full = detail === 'full'
  const list = useWatchlist('level')
  const forecast = useForecast()
  const history = useAllHistory(HIST_H)
  const reduce = useReducedMotion()

  const g = list[0] ?? null
  const base = g ? g.site.baseLevel : 0
  const red = g ? g.redThreshold : 0

  const series = g ? history.data?.[g.site.id] : undefined
  const sf = g ? forecast.data?.sites[g.site.id] : undefined

  const build = useMemo(() => {
    if (!g || !series) return null
    const obs: { t: number; d: number }[] = []
    for (const q of series.points) obs.push({ t: q.at, d: q.level - base })

    const issued = forecast.data?.issuedAt ?? (obs.length > 0 ? obs[obs.length - 1].t : 0)
    const nowT = obs.length > 0 ? obs[obs.length - 1].t : issued
    const t1 = nowT + 12 * 3600

    // 锥形：接口的 lower/upper 目前与 level 重合（区间没回填），直接用会画成
    // 一条零宽的线。`sigma`（残差标准差）是实打实的，这里退化成 ±1.65σ
    // （约 90% 区间）并按预见期线性插值还原出一个真实的锥形。
    // 只要接口哪天把区间回填了，就会走上面那条分支，这里的退化自动失效。
    const curve = sf?.curve ?? []
    let flat = curve.length > 0
    for (const c of curve) {
      if (c.upper - c.lower > 1e-6) {
        flat = false
        break
      }
    }
    const anchors: { o: number; s: number }[] = [{ o: 0, s: 0 }]
    if (sf) for (const o of sf.horizons) anchors.push({ o: o.horizonMin, s: o.sigma })

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

    const pointAt = (t: number, c: CurvePoint): FPt => {
      let up: number
      let lo: number
      if (flat) {
        const half = 1.65 * sigmaAt(c.offsetMin)
        up = c.level - base + half
        lo = c.level - base - half
      } else {
        up = c.upper - base
        lo = c.lower - base
      }
      return { t, d: c.level - base, up, lo }
    }

    const fc: FPt[] = []
    for (const c of curve) {
      const t = issued + c.offsetMin * 60
      if (t < nowT || t > t1) continue
      fc.push(pointAt(t, c))
    }
    // 预测每 60s 才换一版，发布时刻常比最后一帧实测早 5~30 分钟。把「现在」之前
    // 的点裁掉之后，虚线会从竖线右侧几十像素才起笔，接缝上空出一小段。按 nowT
    // 在曲线上插一个点补上，实测段和预测段才真正接住。
    if (curve.length > 0 && (fc.length === 0 || fc[0].t > nowT + 1)) {
      const c = curveAt(curve, Math.max(0, (nowT - issued) / 60))
      if (c) fc.unshift(pointAt(nowT, c))
    }

    return { obs, fc, nowT, t0: nowT - HIST_H * 3600, t1 }
  }, [g, series, sf, base, forecast.data?.issuedAt])

  // 大数字：数据一刷就向新值过渡，而不是直接跳字（420ms 够看清，又不拖沓）。
  const depthNow = g ? Math.max(0, g.reading.depth) : 0
  const shown = useEased(depthNow, 420, reduce)

  const padX = full ? 56 : 12
  const padL = full ? 100 : 46
  const padR = full ? 40 : 16
  const padB = full ? 56 : 26
  const headH = full ? 168 : 76
  const fs = full ? 14 : 11
  const fsMeta = full ? 16 : 11
  const heroFs = full ? 76 : Math.round(clamp(30, 44, h * 0.115))

  const x0 = padL
  const xRight = w - padR
  const yTop = headH
  const yBottom = h - padB
  const plotW = Math.max(40, xRight - x0)
  const plotH = Math.max(30, yBottom - yTop)

  if (!g) {
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

  const yMax = niceTop(Math.max(red * 1.3, depthNow, ...(build ? build.obs.map((q) => q.d) : []), ...(build ? build.fc.map((q) => Math.max(q.d, q.up)) : [])))
  const span = build ? build.t1 - build.t0 : 1
  const xOf = (t: number) => x0 + ((t - (build ? build.t0 : 0)) / span) * plotW
  const yOf = (d: number) => yBottom - (Math.min(yMax, Math.max(0, d)) / yMax) * plotH

  const tickStep = yMax >= 2.4 ? 1 : yMax >= 1.2 ? 0.5 : 0.2
  const yTicks: number[] = []
  for (let v = 0; v <= yMax + 1e-9; v += tickStep) yTicks.push(Math.round(v * 100) / 100)

  const nowT = build ? build.nowT : Date.now() / 1000
  const tTicks = full
    ? [-6, -3, 0, 3, 6, 9, 12].map((hh) => nowT + hh * 3600)
    : [nowT - HIST_H * 3600, nowT, nowT + 12 * 3600]

  const pathOf = (pts: readonly { t: number; d: number }[]) =>
    pts.length === 0
      ? ''
      : 'M' + pts.map((q) => `${xOf(q.t).toFixed(1)},${yOf(q.d).toFixed(1)}`).join('L')

  const conePath = (() => {
    if (!build || build.fc.length < 2) return ''
    const up = build.fc.map((q) => `${xOf(q.t).toFixed(1)},${yOf(q.up).toFixed(1)}`)
    const lo = [...build.fc].reverse().map((q) => `${xOf(q.t).toFixed(1)},${yOf(q.lo).toFixed(1)}`)
    return `M${up.join('L')}L${lo.join('L')}Z`
  })()

  // 第一个 ≥ 红阈的点。整段都在红阈之上时（本轮 10 个站里有 4 个这样），
  // 落点就在窗口左端，标签写「≤ 时刻」——它确实是在那一刻之前越的线，
  // 写成「此刻越线」会让人以为是刚发生的事。
  let cross: { t: number; d: number; first: boolean } | null = null
  if (build) {
    const all = [...build.obs, ...build.fc]
    for (let i = 0; i < all.length; i++) {
      if (all[i].d >= red) {
        cross = { t: all[i].t, d: all[i].d, first: i === 0 }
        break
      }
    }
  }

  const obsEnd = build && build.obs.length > 0 ? build.obs[build.obs.length - 1] : null
  const fcEnd = build && build.fc.length > 0 ? build.fc[build.fc.length - 1] : null

  const sixAgo = build && build.obs.length > 0 ? Math.max(0, build.obs[0].d) : null
  const in2h = sf ? depthAt(sf.curve, 120, base) : null

  return (
    <div style={{ position: 'relative', width: w, height: h, color: p.text, overflow: 'hidden' }}>
      {/* 大数字：只读，不挂任何 hover/点击（这块屏没人操作） */}
      <div
        style={{
          position: 'absolute',
          left: padX,
          top: full ? 24 : 8,
          display: 'flex',
          alignItems: 'baseline',
          gap: full ? 12 : 5,
          lineHeight: 1,
        }}
      >
        <span style={{ fontSize: heroFs, fontWeight: 600, letterSpacing: '-0.02em' }}>
          {fmtDepth(shown)}
        </span>
        <span style={{ fontSize: full ? 28 : 13, color: p.textDim }}>m</span>
      </div>
      <div
        style={{
          position: 'absolute',
          left: padX,
          top: (full ? 24 : 8) + heroFs + (full ? 12 : 4),
          fontSize: fsMeta,
          color: p.textFaint,
        }}
      >
        {depthNow >= red
          ? `超红色预警线 ${fmtDepth(depthNow - red)} m`
          : `距红色预警线 ${fmtDepth(red - depthNow)} m`}
      </div>

      {/* 放大页右上角补三个数：六小时前 / 现在 / 2 小时后 */}
      {full && (
        <div
          style={{
            position: 'absolute',
            right: padX,
            top: 30,
            display: 'flex',
            gap: 48,
          }}
        >
          <Stat label="六小时前" value={sixAgo} p={p} />
          <Stat label="现在" value={depthNow} p={p} />
          <Stat label="2 小时后" value={in2h} p={p} />
        </div>
      )}

      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0 }}>
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line x1={x0} x2={xRight} y1={yOf(v)} y2={yOf(v)} stroke={p.panelLine} strokeWidth={1} />
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
          transform={`translate(${full ? 18 : 12}, ${yTop + plotH / 2}) rotate(-90)`}
          textAnchor="middle"
          fontSize={fs}
          fill={p.textFaint}
        >
          水深 m
        </text>

        {/* 预测锥形：上界往下、下界往上围出来的一块，随预测一起刷 */}
        {conePath && <path d={conePath} fill={p.forecast} opacity={0.12} />}

        {/* 红阈 */}
        <line
          x1={x0}
          x2={xRight}
          y1={yOf(red)}
          y2={yOf(red)}
          stroke={p.level.red}
          strokeWidth={1}
          strokeDasharray={full ? '7 5' : '5 4'}
          opacity={0.6}
        />
        <text x={xRight - 4} y={yOf(red) - 6} fontSize={fs} fill={p.textFaint} textAnchor="end">
          红阈 {fmtDepth(red)} m
        </text>

        {/* 现在：两段曲线的接缝 */}
        <line
          x1={xOf(nowT)}
          x2={xOf(nowT)}
          y1={yTop}
          y2={yBottom}
          stroke={p.textFaint}
          strokeWidth={1}
          strokeDasharray={full ? '4 5' : '3 4'}
          opacity={0.5}
        />
        <text x={xOf(nowT) + 5} y={yTop - 6} fontSize={fs} fill={p.textDim}>
          现在
        </text>

        {build && build.obs.length > 1 && (
          <path
            d={pathOf(build.obs)}
            fill="none"
            stroke={p.observed}
            strokeWidth={full ? 3 : 2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {build && build.fc.length > 1 && (
          <path
            d={pathOf(build.fc)}
            fill="none"
            stroke={p.forecast}
            strokeWidth={full ? 3 : 2.2}
            strokeDasharray={full ? '7 5' : '5 4'}
            strokeLinecap="round"
          />
        )}

        {/* 越红线那一刻：空心圈 + 时刻 */}
        {cross && (
          <g>
            <circle
              cx={xOf(cross.t)}
              cy={yOf(cross.d)}
              r={full ? 9 : 6}
              fill="none"
              stroke={p.level.red}
              strokeWidth={2}
            />
            <text
              x={xOf(cross.t) + (full ? 18 : 13)}
              y={yOf(cross.d) - (full ? 16 : 12)}
              fontSize={fs}
              fill={p.text}
            >
              {cross.first ? '≤' : ''}
              {fmtClock(cross.t)} 越红线
            </text>
          </g>
        )}

        {/* 两个末端点：实测末端钉在接缝上，预测末端随数据往右推进 */}
        {obsEnd && <circle cx={xOf(obsEnd.t)} cy={yOf(obsEnd.d)} r={full ? 4.5 : 3.5} fill={p.observed} />}
        {fcEnd && (
          <g
            style={{
              transform: `translate(${xOf(fcEnd.t)}px, ${yOf(fcEnd.d)}px)`,
              transition: reduce ? 'none' : `transform 420ms ${EASE}`,
            }}
          >
            <circle r={full ? 4.5 : 3.5} fill={p.forecast} />
          </g>
        )}

        <line x1={x0} x2={xRight} y1={yBottom} y2={yBottom} stroke={p.panelLine} />
        {tTicks.map((t, i) => {
          const x = xOf(t)
          const anchor = i === 0 ? 'start' : i === tTicks.length - 1 ? 'end' : 'middle'
          const label = full
            ? fmtClock(t)
            : i === 0
              ? `${HIST_H}h 前`
              : i === tTicks.length - 1
                ? '12h 后'
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

        {!sf && (
          <text x={x0 + plotW * 0.75} y={yTop + 18} fontSize={fs} fill={p.textFaint} textAnchor="middle">
            预测未到
          </text>
        )}
      </svg>
    </div>
  )
}

/** 某一帧右上角的小数：标题 14、数值 24。 */
function Stat({ label, value, p }: { label: string; value: number | null; p: ZoomProps['p'] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 14, color: p.textFaint }}>{label}</span>
      <span style={{ fontSize: 24, color: p.text }}>
        {value == null ? '—' : fmtDepth(value)}
        <span style={{ fontSize: 14, color: p.textDim }}> m</span>
      </span>
    </div>
  )
}

function depthAt(curve: readonly CurvePoint[], offsetMin: number, base: number): number | null {
  const c = curveAt(curve, offsetMin)
  return c ? Math.max(0, c.level - base) : null
}

function clamp(lo: number, hi: number, v: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function niceTop(v: number): number {
  const step = v >= 2.4 ? 1 : v >= 1.2 ? 0.5 : 0.2
  return Math.max(step, Math.ceil(v / step - 1e-9) * step)
}

/**
 * 把数字平滑推过去（easeOutCubic）。
 *
 * 大屏上「数字自己跳一下」比曲线更先被看见，所以这条动画必须跟数据走：
 * 值没变就不启动 rAF，reduced-motion 打开时直接返回目标值。
 */
function useEased(target: number, ms: number, off: boolean): number {
  const [shown, setShown] = useState(target)
  const shownRef = useRef(target)
  shownRef.current = shown
  useEffect(() => {
    if (off) {
      setShown(target)
      return
    }
    const from = shownRef.current
    if (Math.abs(from - target) < 1e-9) return
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / ms)
      const e = 1 - Math.pow(1 - k, 3)
      setShown(from + (target - from) * e)
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms, off])
  return shown
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
