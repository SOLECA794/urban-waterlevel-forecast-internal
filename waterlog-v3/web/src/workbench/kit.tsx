import type { ReactNode } from 'react'
import { W, ease } from './visual'

/**
 * 工作台共用的排版件。
 *
 * 这一屏上会出现 20~30 块内容，如果每块都自己写 `<div style={{padding:12,...}}>`，
 * 十个区块就会有十种内边距——**这不是小事**：用户读的是边距带来的节奏，
 * 边距不齐时，屏幕看起来像拼出来的，即使每块内容都对。
 *
 * 所以这里只放「排版」：块、标题、数字、行、标尺。不放任何业务含义
 * （不知道什么是水位、什么是预警），业务含义一律留在各 stage 里。
 */

/** 一块内容区。默认无底色、靠细线分隔——卡片底色一多，就分不清哪块是主内容。 */
export function Block({
  title,
  sub,
  aside,
  children,
  pad = 12,
  grow,
  dense,
  tint,
}: {
  title?: ReactNode
  sub?: ReactNode
  aside?: ReactNode
  children: ReactNode
  pad?: number
  /** 撑满剩余高度。用于「这一块应该占据舞台的主位」时。 */
  grow?: boolean
  dense?: boolean
  /** 需要被强调的那一块才给底色，且只给极浅的一档。 */
  tint?: string
}) {
  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        minWidth: 0,
        flex: grow ? '1 1 0' : '0 0 auto',
        background: tint ?? 'transparent',
        borderRadius: tint ? 8 : 0,
      }}
    >
      {(title || aside) && (
        <header
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            padding: `0 0 ${dense ? 6 : 8}px 0`,
            flex: '0 0 auto',
          }}
        >
          <h4
            style={{
              margin: 0,
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: 0.4,
              color: W.ink2,
            }}
          >
            {title}
          </h4>
          {sub && (
            <span style={{ fontSize: 11, color: W.ink4, lineHeight: 1.5 }}>{sub}</span>
          )}
          <span style={{ marginLeft: 'auto', flex: '0 0 auto' }}>{aside}</span>
        </header>
      )}
      <div
        style={{
          flex: grow ? '1 1 0' : '0 0 auto',
          minHeight: 0,
          minWidth: 0,
          padding: pad,
          background: tint ? undefined : W.stage,
          border: `1px solid ${W.line}`,
          borderRadius: 8,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </div>
    </section>
  )
}

/** 一行「标签 → 值」。值是数字时右对齐，方便上下扫读做对比。 */
export function Row({
  k,
  v,
  hint,
  tone,
  mono = true,
  onClick,
}: {
  k: ReactNode
  v: ReactNode
  hint?: ReactNode
  tone?: string
  mono?: boolean
  onClick?: () => void
}) {
  const body = (
    <>
      <span style={{ color: W.ink3, fontSize: 12, flex: '0 0 auto' }}>{k}</span>
      {hint && <span style={{ color: W.ink4, fontSize: 11, flex: '0 0 auto' }}>{hint}</span>}
      <span
        style={{
          marginLeft: 'auto',
          fontSize: 12,
          fontWeight: 500,
          color: tone ?? W.ink,
          fontFamily: mono ? W.mono : W.sans,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {v}
      </span>
    </>
  )
  const style = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    padding: '5px 0',
    borderBottom: `1px solid ${W.lineSoft}`,
    width: '100%',
    textAlign: 'left' as const,
  }
  if (!onClick) return <div style={style}>{body}</div>
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ ...style, border: 0, borderBottom: `1px solid ${W.lineSoft}`, background: 'none', cursor: 'pointer', font: 'inherit' }}
    >
      {body}
    </button>
  )
}

/** 数字 + 单位 + 说明。工作台上所有「一眼要读到的数」都用它，保证字号一致。 */
export function Figure({
  value,
  unit,
  label,
  tone,
  size = 30,
  hint,
}: {
  value: ReactNode
  unit?: string
  label?: ReactNode
  tone?: string
  size?: number
  hint?: ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      {label && (
        <span style={{ fontSize: 11, color: W.ink3, whiteSpace: 'nowrap' }}>{label}</span>
      )}
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
        <span
          style={{
            fontSize: size,
            fontWeight: 600,
            lineHeight: 1.05,
            color: tone ?? W.ink,
            fontFamily: W.mono,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: -0.6,
          }}
        >
          {value}
        </span>
        {unit && (
          <span style={{ fontSize: 11, color: W.ink3, fontFamily: W.mono }}>{unit}</span>
        )}
      </span>
      {hint && <span style={{ fontSize: 10.5, color: W.ink4 }}>{hint}</span>}
    </div>
  )
}

/** 小标。不加圆角背景，只用描边——背景块一多屏幕会碎。 */
export function Pill({
  children,
  tone = W.ink3,
  fill,
  onClick,
  title,
}: {
  children: ReactNode
  tone?: string
  fill?: boolean
  onClick?: () => void
  title?: string
}) {
  const style = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 18,
    padding: '0 7px',
    borderRadius: 9,
    fontSize: 10.5,
    lineHeight: 1,
    color: fill ? '#fff' : tone,
    background: fill ? tone : 'transparent',
    border: `1px solid ${fill ? tone : tone + '55'}`,
    whiteSpace: 'nowrap' as const,
    fontFamily: W.sans,
  }
  if (!onClick) return <span style={style}>{children}</span>
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{ ...style, cursor: 'pointer', font: 'inherit', ...style }}
    >
      {children}
    </button>
  )
}

/** 进度标尺：把「现在离某个阈值多远」画出来。比只给一个数字好读。 */
export function Ruler({
  ratio,
  color,
  height = 5,
  marks,
}: {
  ratio: number
  color: string
  height?: number
  /** 额外的刻度位置（0~1），例如各档阈值。 */
  marks?: { at: number; color: string }[]
}) {
  const r = Math.max(0, Math.min(1, ratio))
  return (
    <div
      style={{
        position: 'relative',
        height,
        width: '100%',
        background: W.lineSoft,
        borderRadius: height / 2,
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          position: 'absolute',
          inset: `0 auto 0 0`,
          width: `${r * 100}%`,
          background: color,
          borderRadius: height / 2,
          transition: `width 320ms ${ease}`,
        }}
      />
      {marks?.map((m, i) => (
        <span
          key={i}
          style={{
            position: 'absolute',
            left: `${Math.max(0, Math.min(1, m.at)) * 100}%`,
            top: 0,
            bottom: 0,
            width: 1,
            background: m.color,
            opacity: 0.75,
          }}
        />
      ))}
    </div>
  )
}

/** 空态：**必须说明为什么空**。只写「暂无数据」等于没说。 */
export function Nothing({ why, hint }: { why: string; hint?: string }) {
  return (
    <div
      style={{
        flex: '1 1 0',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: 20,
        textAlign: 'center',
      }}
    >
      <span style={{ fontSize: 12.5, color: W.ink3 }}>{why}</span>
      {hint && <span style={{ fontSize: 11, color: W.ink4, lineHeight: 1.6, maxWidth: 360 }}>{hint}</span>}
    </div>
  )
}

/** 骨架：形状要和真实内容一致，否则加载完成后会跳一下。 */
export function Shimmer({ h = 12, w = '100%', r = 4 }: { h?: number; w?: number | string; r?: number }) {
  return (
    <span
      style={{
        display: 'block',
        height: h,
        width: w,
        borderRadius: r,
        background: `linear-gradient(90deg, ${W.lineSoft} 25%, #F4F7FA 37%, ${W.lineSoft} 63%)`,
        backgroundSize: '400% 100%',
        animation: 'wb-shimmer 1.3s ease infinite',
      }}
    />
  )
}
