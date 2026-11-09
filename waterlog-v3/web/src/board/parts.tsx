import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { Level } from '../domain'
import { LEVEL_LABEL } from '../domain'
import { usePalette } from './theme'
import { PANEL_BORDER, PANEL_RULE, techGridUri } from './panel'


/** 24px 工程网格的 data URI。先生成一次，所有面板共用同一个字符串。 */
const GRID = techGridUri('rgba(21,101,192,0.16)', 24)

/**
 * 大屏基元。
 *
 * 与主应用的 `components/primitives` 分开写，不是因为不信任复用，
 * 而是大屏的约束完全不同：**没有 hover、没有 cursor、字号大 2~4 倍、
 * 必须在 3 米外可读、每秒都在动**。共用一套只会让两边都别扭。
 */

/** 面板：左上角一段强调线 + 标题，是科技风大屏最省事也最有效的框架感。 */
export function Panel({
  title,
  sub,
  right,
  children,
  style,
  bodyStyle,
  className,
  accent,
  elev = 2,
}: {
  title?: string
  sub?: string
  right?: ReactNode
  children: ReactNode
  style?: CSSProperties
  bodyStyle?: CSSProperties
  className?: string
  /** 面板强调色：只用在 3px 竖条与角标上，不改变卡片本身的明度 */
  accent?: string
  elev?: 1 | 2 | 3 | 4
}) {
  const p = usePalette()
  const a = accent ?? p.accent
  return (
    <section
      className={className}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        // 卡面三层：
        //   ① 冷白面板底（p.panel）
        //   ② 该面板强调色的极淡底（一眼分得出「这块讲预警」「那块讲雨情」）
        //   ③ 24px 工程网格（让平面不像屏幕上的纯色块）
        // 顺序：先写的在下面。网格必须最后写，否则会被同色底盖掉。
        // 卡面底色由该卡自己的强调色混出来（9%），而不是统一的 p.panel：
        // 22 张卡同一个底子读起来是一片蓝白，各自带一点本色才有色彩身份。
        // 浓度统一 9%，所以还是一套语言，不是每张卡各自动手调色。
        backgroundColor: `color-mix(in srgb, ${a} 9%, ${p.panel})`,
        // 颗粒用 JS 生成（内联 SVG 的 feTurbulence），不走 CSS 变量：
        // 变量一旦没声明就静默失效，颗粒会「看起来改过了其实没有」。
        // 四层（先写的在上层）：
        //   ① 顶亮底沉 —— 卡片要有厚度感，纯色面板看久了是一块平白
        //   ② 强调色淡底 —— 一眼分得出这块讲预警、那块讲雨情
        //   ③ 工程网格 —— 让平面不像屏幕上的纯色块
        // 顺序不能把网格写到最前，否则网格会盖住强调色与厚度。
        backgroundImage:
          `linear-gradient(180deg, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.28) 34%, rgba(206,226,244,0.55) 100%), ` +
          `linear-gradient(180deg, ${a}1A 0%, ${a}08 40%, transparent 72%), ${GRID}`,
        backgroundRepeat: 'no-repeat, no-repeat, repeat',
        borderRadius: 10,
        // 实色卡 + 四级阴影里的一档（elev 决定用哪一档）。
        // 不用半透明、也不做 backdrop-filter：地图瓦片上的地名有深色笔画，
        // 半透明会让这些笔画透到正文下面，读数时与地图抢注意力。
        border: `1px solid ${PANEL_BORDER}`,
        boxShadow: `${p.elev[elev - 1]}, inset 0 1px 0 rgba(255,255,255,0.92), inset 0 -1px 0 rgba(150,186,216,0.35)`,
        overflow: 'hidden',
        animation: 'bpRise 520ms cubic-bezier(.22,.68,.28,1) both',
        ...style,
      }}
    >
      {/* 顶部一道极淡的暖光。老图纸受光面在上沿，所以只留顶部一条，
          并且是暖白不是纯白 —— 纯白高光会把纸感又拉回"屏幕玻璃"。 */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: 'linear-gradient(180deg, rgba(232,244,255,0.55) 0%, rgba(232,244,255,0) 34%)',
        }}
      />
      {/* 右上角框角：科技感来自「框」而不是「线条多」，一个角标就够 */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: 26,
          height: 26,
          pointerEvents: 'none',
          borderTop: `1.5px solid ${a}55`,
          borderRight: `1.5px solid ${a}55`,
          borderTopRightRadius: 14,
        }}
      />
      {(title || right) && (
        <header
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 12px 6px',
            flexShrink: 0,
            borderBottom: `1px solid ${PANEL_RULE}`,
          }}
        >
          {title && <span aria-hidden style={{ width: 3, height: 12, borderRadius: 2, background: a, boxShadow: `0 0 0 1px ${a}33` }} />}
          {title && (
            <h2
              style={{
                margin: 0,
                fontSize: 13.5,
                fontWeight: 600,
                letterSpacing: 0.9,
                color: p.text,
                whiteSpace: 'nowrap',
              }}
            >
              {title}
            </h2>
          )}
          {sub && <span style={{ fontSize: 10.5, color: p.textFaint, letterSpacing: 0.3, marginTop: 1 }}>{sub}</span>}
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>{right}</span>
        </header>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: '7px 12px 9px', ...bodyStyle }}>{children}</div>
    </section>
  )
}

/**
 * 数字滚动。
 *
 * 只在**值变化时**跑 600ms 缓动，不是为了炫技：大屏 3 米外看不清个位，
 * 靠数字变化那一刻的运动把「这里刚更新了」传出去，比任何角标都有效。
 */
export function CountUp({
  value,
  digits = 0,
  duration = 600,
  className,
  style,
}: {
  value: number
  digits?: number
  duration?: number
  className?: string
  style?: CSSProperties
}) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)

  useEffect(() => {
    const a = from.current
    const b = value
    if (a === b) return
    let raf = 0
    const t0 = performance.now()
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / duration)
      const e = 1 - Math.pow(1 - k, 3)
      setShown(a + (b - a) * e)
      if (k < 1) raf = requestAnimationFrame(step)
      else from.current = b
    }
    raf = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(raf)
      from.current = b
    }
  }, [value, duration])

  return (
    <span className={className} style={style}>
      {shown.toFixed(digits)}
    </span>
  )
}

/** 大数字块：眉标 / 巨号数值 / 单位 / 脚注。数字用 tabular-nums 防抖动。 */
export function BigStat({
  label,
  value,
  digits = 0,
  unit,
  foot,
  color,
  size = 54,
  align = 'left',
}: {
  label: string
  value: number
  digits?: number
  unit?: string
  foot?: ReactNode
  color?: string
  size?: number
  align?: 'left' | 'center'
}) {
  const p = usePalette()
  const c = color ?? p.text
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: align === 'center' ? 'center' : 'flex-start',
        gap: 1,
        minWidth: 0,
      }}
    >
      {/* 标签是「眉标」不是「正文」：小一号、拉开字距、降低对比，让数字独占视觉重量 */}
      <span
        style={{
          fontSize: 11,
          letterSpacing: 1.6,
          color: p.textDim,
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
        <CountUp
          value={value}
          digits={digits}
          style={{
            fontSize: size,
            lineHeight: 1.02,
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: -0.5,
            color: c,
            textShadow: `0 2px 12px ${c}22`,
          }}
        />
        {unit && <span style={{ fontSize: 13, fontWeight: 500, color: p.textDim }}>{unit}</span>}
      </div>
      {foot && (
        <span style={{ fontSize: 11, color: p.textFaint, lineHeight: 1.35, whiteSpace: 'nowrap' }}>{foot}</span>
      )}
    </div>
  )
}

/** 环形分布图。 */
export function Donut({
  data,
  size = 168,
  thickness = 16,
  center,
  centerSub,
}: {
  data: { level: Level; value: number }[]
  size?: number
  thickness?: number
  center?: ReactNode
  centerSub?: ReactNode
}) {
  const p = usePalette()
  const total = data.reduce((s, d) => s + d.value, 0)
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  let acc = 0

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={p.levelSoft.none} strokeWidth={thickness} />
        {total > 0 &&
          data.map((d) => {
            if (d.value === 0) return null
            const len = (d.value / total) * c
            const el = (
              <circle
                key={d.level}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={p.level[d.level]}
                strokeWidth={thickness}
                strokeDasharray={`${Math.max(0, len - 2)} ${c - Math.max(0, len - 2)}`}
                strokeDashoffset={-acc}
                strokeLinecap="butt"
                style={{ transition: 'stroke-dasharray 700ms ease, stroke-dashoffset 700ms ease' }}
              />
            )
            acc += len
            return el
          })}
      </svg>
      {/* 外圈 60 道刻度：环形图最容易被误读成「进度」，刻度把它拉回「量表」 */}
      <svg width={size} height={size} style={{ position: 'absolute', inset: 0 }}>
        {Array.from({ length: 60 }, (_, i) => {
          const ang = (i / 60) * Math.PI * 2 - Math.PI / 2
          const major = i % 5 === 0
          const r1 = size / 2 - 1
          const r2 = r1 - (major ? 5 : 2.5)
          return (
            <line
              key={i}
              x1={size / 2 + Math.cos(ang) * r1}
              y1={size / 2 + Math.sin(ang) * r1}
              x2={size / 2 + Math.cos(ang) * r2}
              y2={size / 2 + Math.sin(ang) * r2}
              stroke={p.textFaint}
              strokeWidth={major ? 1.1 : 0.7}
              opacity={major ? 0.5 : 0.28}
            />
          )
        })}
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
        }}
      >
        <span style={{ fontSize: 34, fontWeight: 700, color: p.text, fontVariantNumeric: 'tabular-nums' }}>
          {center}
        </span>
        <span style={{ fontSize: 11, color: p.textDim, letterSpacing: 1 }}>{centerSub}</span>
      </div>
    </div>
  )
}

/** 横向对比条。用于「多类别对比统计」——同一量纲下谁多谁少。 */
export function BarRow({
  label,
  value,
  max,
  color,
  right,
  sub,
  height = 18,
}: {
  label: string
  value: number
  max: number
  color: string
  right: ReactNode
  sub?: string
  height?: number
}) {
  const p = usePalette()
  const w = max > 0 ? Math.max(0.6, Math.min(100, (value / max) * 100)) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span
        style={{
          width: 96,
          flexShrink: 0,
          fontSize: 13,
          color: p.textDim,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={label}
      >
        {label}
      </span>
      <span
        style={{
          position: 'relative',
          flex: 1,
          height,
          // 轨道用极淡的中性色 + 1px 内描边，而不是拿告警色当底：
          // 底色一旦带颜色，读者会把它当成「已经发生的量」。
          background: 'rgba(12,50,70,0.055)',
          borderRadius: 3,
          overflow: 'hidden',
          boxShadow: 'inset 0 0 0 1px rgba(12,50,70,0.05)',
        }}
      >
        <span
          style={{
            position: 'absolute',
            inset: '0 auto 0 0',
            width: `${w}%`,
            // 由浅入深：左端留一点透明度，让条形「从零长出来」的方向可读
            background: `linear-gradient(90deg, ${color}55 0%, ${color} 62%, ${color} 100%)`,
            borderRadius: 3,
            transition: 'width 800ms cubic-bezier(0.22,1,0.36,1)',
            boxShadow: `inset 0 1px 0 rgba(255,255,255,0.45), 0 1px 2px ${color}33`,
          }}
        />
      </span>
      <span
        style={{
          width: 74,
          flexShrink: 0,
          textAlign: 'right',
          fontSize: 15,
          fontWeight: 700,
          letterSpacing: -0.3,
          color,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {right}
      </span>
      {sub && <span style={{ width: 96, fontSize: 11, color: p.textFaint }}>{sub}</span>}
    </div>
  )
}

/** 等级胶囊（大屏尺寸：主应用的 22px 高在 3 米外就是一个色块）。 */
export function LevelTag({ level, score }: { level: Level; score?: number }) {
  const p = usePalette()
  if (level === 'none') {
    return <span style={{ fontSize: 13, color: p.textFaint }}>无预警</span>
  }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px',
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: 0.4,
        color: p.theme === 'dark' ? '#08111C' : '#FFFFFF',
        background: p.level[level],
        // 外圈 2px 同色微光 + 一道白描边：解决「红胶囊贴在红数字旁边糊成一团」
        boxShadow: `0 0 0 1.5px ${p.level[level]}22, inset 0 1px 0 rgba(255,255,255,0.35), 0 2px 6px ${p.level[level]}44`,
      }}
    >
      <span
        className="board-pulse"
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: p.theme === 'dark' ? '#08111C' : '#FFFFFF',
          opacity: 0.8,
        }}
      />
      {LEVEL_LABEL[level]}
      {score !== undefined && <span style={{ opacity: 0.75 }}>{score.toFixed(2)}</span>}
    </span>
  )
}

/** 实时心跳点：数据在流动这件事必须**一直在动**，否则屏幕像死机。 */
export function LiveDot({ ok = true, label }: { ok?: boolean; label: string }) {
  const p = usePalette()
  const color = ok ? p.accent : p.level.red
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: p.textDim }}>
      <span style={{ position: 'relative', width: 10, height: 10 }}>
        <span
          className={ok ? 'board-ping' : undefined}
          style={{ position: 'absolute', inset: 0, borderRadius: 999, background: color }}
        />
      </span>
      {label}
    </span>
  )
}
