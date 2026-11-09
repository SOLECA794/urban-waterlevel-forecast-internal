import type { CSSProperties } from 'react'

const START = -125
const SWEEP = 250

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = ((deg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number) {
  const a = polar(cx, cy, r, from)
  const b = polar(cx, cy, r, to)
  const large = Math.abs(to - from) > 180 ? 1 : 0
  return `M${a.x.toFixed(2)},${a.y.toFixed(2)} A${r},${r} 0 ${large} 1 ${b.x.toFixed(2)},${b.y.toFixed(2)}`
}

/** 弧形仪表盘。比水平进度条多花不了多少代码，但"当前风险有多高"是一眼能读的，
 *  不需要在大脑里把 0.79 换算成"离红还有多远"。 */
export function Gauge({
  value,
  color = '#2563eb',
  size = 132,
  thickness = 9,
  label,
  caption,
  track = '#eef2f6',
}: {
  /** 0~1，超出会被钳制（调用方不该传 >1 的分数） */
  value: number
  color?: string
  size?: number
  thickness?: number
  label?: string
  caption?: string
  track?: string
}) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
  const cx = size / 2
  const cy = size / 2
  const r = (size - thickness) / 2 - 2
  const len = (r * SWEEP * Math.PI) / 180

  return (
    <div style={{ width: size, height: size }} className="relative shrink-0">
      <svg width={size} height={size} aria-hidden="true">
        <path d={arcPath(cx, cy, r, START, START + SWEEP)} fill="none" stroke={track} strokeWidth={thickness} strokeLinecap="round" />
        {v > 0.002 && (
          <path
            d={arcPath(cx, cy, r, START, START + SWEEP * v)}
            fill="none"
            stroke={color}
            strokeWidth={thickness}
            strokeLinecap="round"
            className="draw-arc"
            style={{ '--arc-len': `${len}` } as CSSProperties}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ paddingBottom: size * 0.06 }}>
        <div className="num font-semibold leading-none" style={{ fontSize: size * 0.235, color }}>
          {label ?? v.toFixed(2)}
        </div>
        {caption && (
          <div className="text-ink-3 mt-1" style={{ fontSize: Math.max(10, size * 0.082) }}>
            {caption}
          </div>
        )}
      </div>
    </div>
  )
}

/** 细环形进度：用在站点卡片右侧表达"离红阈还有多远"，占位比进度条小。 */
export function MiniRing({
  value,
  color,
  size = 38,
  thickness = 4,
}: {
  value: number
  color: string
  size?: number
  thickness?: number
}) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90" aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#eef2f6" strokeWidth={thickness} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={thickness}
        strokeLinecap="round"
        strokeDasharray={`${c}`}
        strokeDashoffset={`${c * (1 - v)}`}
        style={{ transition: 'stroke-dashoffset 600ms var(--ease-out)' }}
      />
    </svg>
  )
}
