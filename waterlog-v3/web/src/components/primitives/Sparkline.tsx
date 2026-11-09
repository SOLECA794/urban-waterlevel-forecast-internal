import { useId, useMemo } from 'react'

/** Catmull-Rom 转三次贝塞尔：把折线画成平滑曲线。
 *  为什么不用单纯折线：24 个点的迷你图里折角太硬，看起来像噪点；
 *  为什么不用三次样条：会 overshoot 出假峰（和预测曲线用 PCHIP 是同一个理由）。 */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return ''
  if (pts.length === 2) return `M${pts[0].x},${pts[0].y}L${pts[1].x},${pts[1].y}`
  let d = `M${pts[0].x},${pts[0].y}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    // 张力 1/6 是 Catmull-Rom 转 Bezier 的标准系数，越小越"绷直"
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += `C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`
  }
  return d
}

export function Sparkline({
  data,
  color = '#2563eb',
  height = 34,
  area = true,
  showLast = true,
  marker,
  className,
}: {
  data: number[]
  color?: string
  height?: number
  area?: boolean
  showLast?: boolean
  /** 参考线（比如蓝阈），画一条虚线提示"现在离警戒还有多远" */
  marker?: number
  className?: string
}) {
  const gid = useId().replace(/:/g, '')
  const W = 100
  const H = 30
  const pad = 2

  const model = useMemo(() => {
    if (!data || data.length < 2) return null
    const lo = Math.min(...data, marker ?? Infinity)
    const hi = Math.max(...data, marker ?? -Infinity)
    const span = hi - lo || 1e-6
    const pts = data.map((v, i) => ({
      x: (i / (data.length - 1)) * W,
      y: H - pad - ((v - lo) / span) * (H - pad * 2),
    }))
    return { pts, lo, hi, span }
  }, [data, marker])

  if (!model) return <div style={{ height }} className={className} />

  const line = smoothPath(model.pts)
  const last = model.pts[model.pts.length - 1]
  const areaPath = `${line}L${W},${H}L0,${H}Z`
  const markerY =
    marker !== undefined ? H - pad - ((marker - model.lo) / model.span) * (H - pad * 2) : null

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ height, width: '100%', display: 'block' }}
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`sg-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.26" />
          <stop offset="100%" stopColor={color} stopOpacity="0.01" />
        </linearGradient>
      </defs>
      {markerY !== null && markerY > 0 && markerY < H && (
        <line
          x1="0"
          x2={W}
          y1={markerY}
          y2={markerY}
          stroke={color}
          strokeOpacity="0.28"
          strokeWidth="0.8"
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {area && <path d={areaPath} fill={`url(#sg-${gid})`} />}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {showLast && last && (
        <>
          <circle cx={last.x} cy={last.y} r="2.6" fill="#fff" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  )
}
