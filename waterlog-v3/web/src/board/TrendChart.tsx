import { useMemo } from 'react'
import type { Meters, Level, SimTime, SiteForecast, SiteSeries, Thresholds } from '../domain'
import { ALARM_LEVELS, LEVEL_LABEL, depthOf, fmtTime, redThreshold, thresholdOf } from '../domain'
import { usePalette } from './theme'

/**
 * 水位与预测 —— 大屏用的一体化水文过程图。
 *
 * 与 scenes.tsx 里那版 TrendBoard 的区别只在「画多少」：这一版把时间轴上
 * 已有的信息全部画出来，而不是只留两条线。
 *
 * 具体多画了四层：
 * 1. **阈值色带**：蓝/黄/橙/红四级各占一条横向色带。原来只有四根虚线，
 *    读图的人要靠找线来判断「现在落在哪一档」；铺成色带之后，曲线穿到哪条
 *    带里一目了然，也让整块面板有了颜色（此前是一整片白）。
 * 2. **降雨柱**：贴着底边的极浅竖条，按该时刻的雨强成比例。水位上涨的原因
 *    写在曲线上方，不用再去别的面板找。
 * 3. **实测面积**：白线下方一层很淡的渐变填充，把「已经积了多少」做成体量感。
 * 4. **置信区间**：预测段画上 90% 上下界围成的锥形，而不是只画中位线。
 *
 * 另外补了网格、每 3 小时的刻度、当前值气泡、右侧色带标签。
 */
export function TrendChart({
  series,
  forecast,
  issuedAt,
  thresholds,
  baseLevel,
}: {
  series: SiteSeries | null
  forecast: SiteForecast | null
  issuedAt: SimTime | null
  thresholds: Thresholds
  baseLevel: Meters
}) {
  const p = usePalette()
  const W = 720
  const H = 330
  const padL = 32
  // 右侧要放四级阈值标签（红0.40 / 橙0.26 / 黄0.14 / 蓝0.05），
  // 原来 46px 里既画置信带又写字，两者会叠；加到 56 并在标签左留 10px 间隙。
  const padR = 56
  // padB / RAIN_H 是给「时间刻度 + 底部说明」与「降雨柱」预留的高度。
  // 卡在版面里是 631×353（比 viewBox 高），这两块会被同比拉长，
  // 原来 40+34=74/330 占掉 22%，曲线被挤在上半部；各收 14/10 个单位还给曲线。
  const padB = 26
  const padT = 12
  const RAIN_H = 24

  const geo = useMemo(() => {
    const hist = (series?.points ?? []).slice(-144)
    const obs = hist.map((pt) => ({
      at: pt.at,
      d: Math.max(0, depthOf(pt.level, baseLevel)),
      rain: Number(pt.rain),
    }))
    const t0 = obs.length > 0 ? obs[0].at : 0
    const nowOff = obs.length > 0 ? obs[obs.length - 1].at - t0 : 0
    const obsPts = obs.map((o) => ({ x: o.at - t0, y: o.d }))
    const rainBars = obs.map((o) => ({ x: o.at - t0, r: Math.max(0, o.rain) }))
    const curve = forecast?.curve ?? []
    const fcPts =
      issuedAt === null
        ? []
        : curve.map((c) => ({
            x: issuedAt + c.offsetMin * 60 - t0,
            y: Math.max(0, c.level - baseLevel),
          }))
    const bandPts =
      issuedAt === null
        ? []
        : curve.map((c) => ({
            x: issuedAt + c.offsetMin * 60 - t0,
            lo: Math.max(0, c.lower - baseLevel),
            hi: Math.max(0, c.upper - baseLevel),
          }))
    const span = Math.max(nowOff + 720 * 60, nowOff, 1)
    const maxRain = rainBars.reduce((a, b) => Math.max(a, b.r), 0)
    return { obsPts, fcPts, bandPts, rainBars, nowOff, span, t0, maxRain }
  }, [series, forecast, issuedAt, baseLevel])

  const red = redThreshold(thresholds)
  const maxD = Math.max(
    red * 1.35,
    ...geo.obsPts.map((o) => o.y),
    ...geo.fcPts.map((f) => f.y),
    ...geo.bandPts.map((b) => b.hi),
    0.08,
  )
  const px = (x: number) => padL + (x / geo.span) * (W - padL - padR)
  const py = (d: number) => H - padB - RAIN_H - (Math.min(d, maxD) / maxD) * (H - padB - RAIN_H - padT)

  const line = (pts: { x: number; y: number }[], gap = 0) => {
    let d = ''
    let prev: number | null = null
    pts.forEach((pt, i) => {
      const jump = prev !== null && gap > 0 && Math.abs(pt.y - prev) > gap
      d += `${i === 0 || jump ? 'M' : 'L'}${px(pt.x).toFixed(1)},${py(pt.y).toFixed(1)}`
      prev = pt.y
    })
    return d
  }
  const area = (pts: { x: number; y: number }[]) => {
    if (pts.length < 2) return ''
    const base = py(0)
    return `${line(pts, 0.55)}L${px(pts[pts.length - 1].x).toFixed(1)},${base}L${px(pts[0].x).toFixed(1)},${base}Z`
  }

  // 四级色带：从 0 到 red*1.35，按阈值切段，向上依次是红/橙/黄/蓝/无。
  const bands = useMemo(() => {
    const cuts: { lv: Level; from: number; to: number }[] = []
    const order: Level[] = ['none', 'blue', 'yellow', 'orange', 'red']
    const th = order.map((lv) => (lv === 'none' ? 0 : thresholdOf(thresholds, lv as never)))
    for (let i = order.length - 1; i >= 1; i -= 1) {
      const from = th[i]
      const to = i === order.length - 1 ? maxD : th[i + 1]
      if (to > from) cuts.push({ lv: order[i], from, to })
    }
    return cuts
  }, [thresholds, maxD])

  const now = geo.obsPts.length > 0 ? geo.obsPts[geo.obsPts.length - 1].y : 0
  const lvNow: Level =
    now >= red ? 'red' : now >= thresholdOf(thresholds, 'orange') ? 'orange'
      : now >= thresholdOf(thresholds, 'yellow') ? 'yellow'
        : now >= thresholdOf(thresholds, 'blue') ? 'blue' : 'none'

  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1]

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/*
        四级阈值标签用 DOM 画，不放进 SVG。
        SVG 里的文字会被 preserveAspectRatio="none" 随容器拉伸，
        卡片一改宽标签就贴边/被切；DOM 文字的位置与字号由 CSS 决定，与拉伸解耦。
      */}
      <div style={{ position: 'absolute', top: 0, right: 2, bottom: 0, width: 54, pointerEvents: 'none' }}>
        {bands.map((b) => {
          const d = thresholdOf(thresholds, b.lv as never)
          // py() 返回的是 viewBox 坐标，换算成百分比才能对上被拉伸后的实际位置
          const pct = (py(d) / H) * 100
          return (
            <span
              key={b.lv}
              style={{
                position: 'absolute',
                top: `${pct}%`,
                right: 0,
                transform: 'translateY(-50%)',
                fontSize: 10,
                lineHeight: 1,
                color: p.levelInk[b.lv as Level],
                whiteSpace: 'nowrap',
              }}
            >
              {LEVEL_LABEL[b.lv as Level].slice(0, 1)}
              {d.toFixed(2)}
            </span>
          )
        })}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height: '100%', display: 'block' }}
      >
      <defs>
        <linearGradient id="tc-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={p.observed} stopOpacity={0.22} />
          <stop offset="100%" stopColor={p.observed} stopOpacity={0.02} />
        </linearGradient>
        <linearGradient id="tc-rain" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={p.rain} stopOpacity={0.85} />
          <stop offset="100%" stopColor={p.rain} stopOpacity={0.35} />
        </linearGradient>
      </defs>

      {/* 1. 阈值色带 */}
      {bands.map((b) => (
        <rect
          key={b.lv}
          x={padL}
          y={py(b.to)}
          width={W - padL - padR}
          height={Math.max(0, py(b.from) - py(b.to))}
          fill={p.level[b.lv]}
          opacity={0.055}
        />
      ))}

      {/* 2. 网格 */}
      {ticks.map((k) => (
        <line
          key={`g${k}`}
          x1={padL + (W - padL - padR) * k}
          x2={padL + (W - padL - padR) * k}
          y1={padT}
          y2={H - padB - RAIN_H}
          stroke={p.panelLine}
          strokeWidth={1}
        />
      ))}

      {/* 3. 阈值虚线 + 右侧标签 */}
      {ALARM_LEVELS.map((lv) => {
        const d = thresholdOf(thresholds, lv)
        return (
          <g key={lv}>
            <line
              x1={padL}
              x2={W - padR}
              y1={py(d)}
              y2={py(d)}
              stroke={p.level[lv]}
              strokeWidth={1}
              strokeDasharray="4 4"
              opacity={0.55}
            />
          </g>
        )
      })}

      {/* 4. 未来区底色 */}
      <rect
        x={px(geo.nowOff)}
        y={padT}
        width={Math.max(0, W - padR - px(geo.nowOff))}
        height={H - padB - RAIN_H - padT}
        fill={p.forecast}
        opacity={0.05}
      />

      {/* 5. 实测面积 */}
      {geo.obsPts.length > 1 && <path d={area(geo.obsPts)} fill="url(#tc-area)" stroke="none" />}

      {/* 6. 预测置信锥 */}
      {geo.bandPts.length > 1 && (
        <path
          d={`M${geo.bandPts.map((b) => `${px(b.x).toFixed(1)},${py(b.hi).toFixed(1)}`).join('L')}L${[...geo.bandPts]
            .reverse()
            .map((b) => `${px(b.x).toFixed(1)},${py(b.lo).toFixed(1)}`)
            .join('L')}Z`}
          fill={p.forecast}
          opacity={0.14}
          stroke="none"
        />
      )}

      {/* 7. 曲线 */}
      {geo.obsPts.length > 1 && (
        <path
          d={line(geo.obsPts, 0.55)}
          fill="none"
          stroke={p.observed}
          strokeWidth={2.6}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {geo.fcPts.length > 1 && (
        <path
          d={line(geo.fcPts)}
          fill="none"
          stroke={p.forecast}
          strokeWidth={2.4}
          strokeDasharray="7 4"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}

      {/* 8. 降雨柱（贴底） */}
      {geo.rainBars.map((b, i) => {
        const h = geo.maxRain > 0 ? (b.r / geo.maxRain) * (RAIN_H - 6) : 0
        if (h <= 0.4) return null
        const w = Math.max(1.6, (W - padL - padR) / Math.max(geo.rainBars.length, 1) - 0.8)
        return (
          <rect
            key={`r${i}`}
            x={px(b.x) - w / 2}
            y={H - padB - h}
            width={w}
            height={h}
            fill="url(#tc-rain)"
            opacity={0.9}
          />
        )
      })}

      {/* 9. 现在线 + 当前值气泡 */}
      <line
        x1={px(geo.nowOff)}
        x2={px(geo.nowOff)}
        y1={padT}
        y2={H - padB}
        stroke={p.accent}
        strokeWidth={1.4}
        strokeDasharray="2 3"
      />
      <circle cx={px(geo.nowOff)} cy={py(now)} r={4} fill={p.levelInk[lvNow]} stroke="#fff" strokeWidth={1.6} />
      <g transform={`translate(${Math.min(px(geo.nowOff) + 9, W - padR - 70)}, ${Math.max(py(now) - 30, padT)})`}>
        <rect width={64} height={23} rx={6} fill={p.level[lvNow]} opacity={0.18} />
        <text x={7} y={16} fontSize={13} fill={p.levelInk[lvNow]} fontWeight={700}>
          {now.toFixed(2)}m
        </text>
      </g>

      {/* 10. 轴刻度 */}
      {ticks.map((k) => (
        <text
          key={`t${k}`}
          x={padL + (W - padL - padR) * k}
          y={H - padB + 12}
          fontSize={11}
          fill={p.textFaint}
          textAnchor={k === 0 ? 'start' : k === 1 ? 'end' : 'middle'}
        >
          {fmtTime((geo.t0 + geo.span * k) as SimTime, 'HH:mm')}
        </text>
      ))}
      {/* 这一行是"图例/口径说明"，单独占最底一行：
          原来它和第一个 x 轴刻度挤在同一高度上，横坐标完全重叠
          （高倍裁图才看出来，两个测量工具都量不到）。 */}
      <text x={padL} y={H - 1} fontSize={10} fill={p.textFaint}>
        雨强峰值 {geo.maxRain.toFixed(1)} mm/h
      </text>
      <text x={W - padR} y={H - 1} fontSize={10} fill={p.textFaint} textAnchor="end">
        未来 12 小时
      </text>
      </svg>
    </div>
  )
}
