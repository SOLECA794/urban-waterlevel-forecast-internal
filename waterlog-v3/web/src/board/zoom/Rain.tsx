import { useEffect, useMemo, useState } from 'react'
import { fmtRain, fmtRainSum, fmtTime } from '../../domain'
import { useAllHistory } from '../../data/queries'
import { useWatchlist } from '../../view/useWatchlist'
import type { ZoomProps } from './types'

/**
 * Rain —— 雨还在下吗。
 *
 * 把 `useAllHistory(12)` 里十个站的点全部按**钟点**分成小时桶、桶内取均值，
 * 得到一条「每小时的雨强」序列（柱高就是桶均值，mm/h）。答案的形状有两种：
 * 一根孤零零的高柱 = 一场短时强降雨；一排中等柱 = 下了一整天。
 *
 * 累计雨量不能按「均值 × 固定 5 分钟」算——步长是从数据里实测出来的中位数，
 * 采集频率换成 1 分钟或 15 分钟，累计值才不会跟着错一个数量级。
 */

const EASE = 'cubic-bezier(.22,.61,.36,1)'
/** 只有数据缺到量不出步长时才用它兜底。 */
const FALLBACK_STEP = 300
const STYLE = `
@keyframes zrain-pulse {
  0%, 100% { transform: translateY(0); opacity: .92 }
  50% { transform: translateY(-6px); opacity: .28 }
}
.zrain-cap { transform-box: fill-box; animation: zrain-pulse 1.8s ${EASE} infinite }
@media (prefers-reduced-motion: reduce) { .zrain-cap { animation: none } }
`

interface Bucket {
  /** 该小时的整点 unix 秒。 */
  readonly hour: number
  /** 桶内所有站所有采样的雨强均值，mm/h。 */
  readonly mean: number
  /** 桶内实际覆盖的秒数（不足一小时就按覆盖算）。 */
  readonly spanSec: number
  /** 桶内雨强最高的那一次采样，用来标「峰值时刻」。 */
  readonly peakAt: number
}

interface RainModel {
  readonly buckets: readonly Bucket[]
  readonly yMax: number
  readonly peakIndex: number
  readonly totalMm: number
  readonly hours: number
  readonly cur: number
}

/** 把最大值抬到「好看」的刻度上：真实桶均值能到 30 以上，写死 13 会直接把柱子切掉。 */
function niceMax(v: number): number {
  if (!(v > 0)) return 1
  const mag = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (v <= m * mag) return m * mag
  }
  return 10 * mag
}

/** 轴上的数字：过 10 就不带小数，免得 `40.0 / 20.0 / 0.0` 占宽度。 */
function axisText(v: number): string {
  return v >= 10 ? String(Math.round(v)) : fmtRain(v, 1)
}

export function Rain({ p, w, h, detail }: ZoomProps) {
  const compact = detail === 'compact'
  const hist = useAllHistory(12)
  const list = useWatchlist('level')
  const reduce = useReducedMotion()
  const [entered, setEntered] = useState(false)

  // 入场把柱从 0 拉起来：切回这一页时能看见「在长」。
  useEffect(() => {
    if (reduce) {
      setEntered(true)
      return
    }
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [reduce])

  const model = useMemo<RainModel | null>(() => {
    const series = Object.values(hist.data ?? {})
    if (series.length === 0) return null

    // 实测中位步长：跳过缺测（差值为 0 或负的相邻点）。
    const gaps: number[] = []
    for (const s of series) {
      for (let i = 1; i < s.points.length; i += 1) {
        const d = s.points[i].at - s.points[i - 1].at
        if (d > 0) gaps.push(d)
      }
    }
    gaps.sort((a, b) => a - b)
    const step = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : FALLBACK_STEP

    interface Acc {
      sum: number
      n: number
      first: number
      last: number
      peakAt: number
      peakRain: number
    }
    const acc = new Map<number, Acc>()
    for (const s of series) {
      for (const pt of s.points) {
        const hour = Math.floor(pt.at / 3600) * 3600
        const b = acc.get(hour)
        if (b) {
          b.sum += pt.rain
          b.n += 1
          if (pt.at < b.first) b.first = pt.at
          if (pt.at > b.last) b.last = pt.at
          if (pt.rain > b.peakRain) {
            b.peakRain = pt.rain
            b.peakAt = pt.at
          }
        } else {
          acc.set(hour, {
            sum: pt.rain,
            n: 1,
            first: pt.at,
            last: pt.at,
            peakAt: pt.at,
            peakRain: pt.rain,
          })
        }
      }
    }

    const buckets: Bucket[] = [...acc.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(-24)
      .map(([hour, v]) => ({
        hour,
        mean: v.sum / v.n,
        spanSec: Math.max(step, v.last - v.first + step),
        peakAt: v.peakAt,
      }))
    if (buckets.length === 0) return null

    let peakIndex = 0
    let totalMm = 0
    for (let i = 0; i < buckets.length; i += 1) {
      if (buckets[i].mean > buckets[peakIndex].mean) peakIndex = i
      totalMm += (buckets[i].mean * buckets[i].spanSec) / 3600
    }

    const first = buckets[0]
    const last = buckets[buckets.length - 1]
    const hours = Math.max(1, Math.round((last.hour + 3600 - first.hour) / 3600))

    // 当前雨强用实时读数（十站均值），比「末桶均值」更接近此刻。
    let cur = last.mean
    if (list.length > 0) {
      let sum = 0
      for (const g of list) sum += g.reading.rain
      cur = sum / list.length
    }

    return { buckets, yMax: niceMax(buckets[peakIndex].mean), peakIndex, totalMm, hours, cur }
  }, [hist.data, list])

  if (!model) {
    return (
      <div
        style={{
          position: 'relative',
          width: w,
          height: h,
          overflow: 'hidden',
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

  const n = model.buckets.length
  const padL = compact ? 30 : 58
  const padR = compact ? 8 : 28
  const padT = compact ? 22 : 46
  const padB = compact ? 22 : 56
  const panelGap = compact ? 0 : 18
  const panelW = compact ? 0 : 300
  const plotW = Math.max(40, w - padL - padR - panelW - panelGap)
  const plotH = Math.max(30, h - padT - padB)
  const slotW = plotW / n
  const barW = Math.max(2, slotW * 0.62)
  const fsTick = compact ? 11 : 14
  const peak = model.buckets[model.peakIndex]
  const peakH = (peak.mean / model.yMax) * plotH
  const peakX = model.peakIndex * slotW + slotW / 2
  const pillH = compact ? 16 : 26

  const tickCount = Math.min(compact ? 4 : 6, n)
  const stats = [
    { label: '当前雨强', value: fmtRain(model.cur), unit: 'mm/h' },
    { label: `${model.hours} 小时累计`, value: fmtRainSum(model.totalMm), unit: 'mm' },
    { label: '峰值时刻', value: fmtTime(peak.peakAt, 'HH:mm'), unit: '' },
  ]

  return (
    <div style={{ position: 'relative', width: w, height: h, overflow: 'hidden' }}>
      <style>{STYLE}</style>

      {/* 纵轴单位 */}
      <div
        style={{
          position: 'absolute',
          left: compact ? 8 : 12,
          top: compact ? 2 : 6,
          fontSize: fsTick,
          color: p.textFaint,
          letterSpacing: 0.5,
        }}
      >
        mm/h
      </div>

      {/* 绘图区：网格线 + 柱 + 刻度 + 峰值标签 */}
      <div
        style={{
          position: 'absolute',
          left: padL,
          top: padT,
          width: plotW,
          height: plotH,
        }}
      >
        {[1, 0.5, 0].map((f) => (
          <div
            key={`grid-${f}`}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: plotH * (1 - f),
              height: 1,
              background: f === 0 ? p.panelLine : p.grid,
            }}
          />
        ))}

        {model.buckets.map((b, i) => {
          const bh = entered ? Math.min(plotH, (b.mean / model.yMax) * plotH) : 0
          const now = i === n - 1
          return (
            <div
              key={b.hour}
              style={{
                position: 'absolute',
                left: i * slotW + (slotW - barW) / 2,
                bottom: 0,
                width: barW,
                height: Math.max(bh, b.mean > 0 ? 2 : 0),
                background: p.rain,
                opacity: now ? 1 : 0.55,
                borderRadius: `${compact ? 1 : 3}px ${compact ? 1 : 3}px 0 0`,
                transition: reduce ? 'none' : `height 400ms ${EASE}`,
              }}
            >
              {now && entered ? (
                <div
                  className="zrain-cap"
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: 0,
                    height: compact ? 2 : 3,
                    background: p.rain,
                    borderRadius: 2,
                  }}
                />
              ) : null}
            </div>
          )
        })}

        {/* 峰值那一根 */}
        <div
          style={{
            position: 'absolute',
            left: peakX,
            bottom: Math.min(plotH - pillH, peakH + 4),
            transform: 'translateX(-50%)',
            height: pillH,
            padding: compact ? '0 6px' : '0 10px',
            display: 'flex',
            alignItems: 'center',
            borderRadius: 999,
            background: '#FFFFFF',
            border: `1px solid ${p.panelBorder}`,
            boxShadow: '0 1px 2px rgba(8,40,60,0.10)',
            fontSize: compact ? 11 : 17,
            fontWeight: 700,
            color: p.text,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            opacity: entered ? 1 : 0,
            transition: reduce ? 'none' : `opacity 400ms ${EASE}`,
          }}
        >
          {`${fmtRain(peak.mean)} mm/h`}
        </div>
      </div>

      {/* 纵轴刻度 */}
      {[1, 0.5, 0].map((f) => (
        <div
          key={`y-${f}`}
          style={{
            position: 'absolute',
            left: 0,
            width: padL - 8,
            top: padT + plotH * (1 - f),
            transform: 'translateY(-50%)',
            textAlign: 'right',
            fontSize: fsTick,
            color: p.textFaint,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {axisText(model.yMax * f)}
        </div>
      ))}

      {/* 横轴：只写 4~6 个时刻 */}
      {Array.from({ length: tickCount }, (_, k) => {
        const idx = tickCount > 1 ? Math.round((k * (n - 1)) / (tickCount - 1)) : 0
        return (
          <div
            key={`x-${idx}`}
            style={{
              position: 'absolute',
              left: padL + idx * slotW + slotW / 2,
              top: padT + plotH + (compact ? 4 : 10),
              transform: 'translateX(-50%)',
              fontSize: fsTick,
              color: p.textFaint,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}
          >
            {fmtTime(model.buckets[idx].hour, 'HH:mm')}
          </div>
        )
      })}

      {/* full：右侧三个数 */}
      {compact ? null : (
        <>
          <div
            style={{
              position: 'absolute',
              left: padL + plotW + panelGap / 2,
              top: padT,
              width: 1,
              height: plotH,
              background: p.panelLine,
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: padL + plotW + panelGap,
              top: padT,
              width: panelW,
              height: plotH,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
            }}
          >
            {stats.map((s, i) => (
              <div
                key={s.label}
                style={{
                  height: Math.min(118, plotH / 3),
                  paddingTop: i === 0 ? 6 : 16,
                  borderTop: i === 0 ? 'none' : `1px solid ${p.panelLine}`,
                }}
              >
                <div style={{ fontSize: 15, color: p.textDim }}>{s.label}</div>
                <div
                  style={{
                    marginTop: 6,
                    display: 'flex',
                    alignItems: 'baseline',
                    fontSize: 32,
                    fontWeight: 700,
                    color: p.text,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {s.value}
                  {s.unit ? (
                    <span style={{ marginLeft: 6, fontSize: 16, fontWeight: 500, color: p.textFaint }}>
                      {s.unit}
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** 减动效偏好：系统里关掉动效时，柱不该还在长、峰值标签也不该抖。 */
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
