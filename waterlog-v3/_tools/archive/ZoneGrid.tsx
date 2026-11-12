import type { Level, Meters } from '../domain'
import type { Palette } from './theme'

/**
 * 「辖区预测」屏的六个格 —— 每区一张 12 小时水位曲线。
 *
 * ## 为什么不做成「一个区一个组件」
 *
 * 六格的差别只有数据，形状完全一样。若拆成六个组件，layout 要维护六套坐标、
 * 布局模式里拖一个另外五个不动、改一处样式要改六遍。所以这里是一个组件，
 * 由 BoardPage 按 `scene.grid` 声明的格数各喂一份数据。
 *
 * ## 图里必须有的四样东西
 *
 * 只画一条线是没用的——读者不知道该在哪个高度紧张。所以每张图都带：
 *
 *   1. **四级阈值横带**（蓝/黄/橙/红，与地图、其余面板同一套色）；
 *   2. **达峰点**：一个实心点 + 「3h 峰值 0.88m」的字；
 *   3. **穿过红阈的时刻**标注——这才是值班真正等着看的那一下；
 *   4. 纵轴**跨站对齐**：同一屏六格的纵轴范围必须相同，否则「东城看着比西城高」
 *     只是因为坐标轴的刻度不同，那是彻底的误读。
 *
 * 第 4 条最容易错。这里不用各图自己的 min/max，而是由调用方算好一个
 * `domain`（[lo, hi]）传进来，六格共用。
 */

export interface ZonePoint {
  readonly offsetMin: number
  readonly level: number
}

export interface ZoneSeries {
  readonly siteId: string
  readonly name: string
  readonly district: string
  readonly level: Level
  /** 当前积水深（m），用来在曲线上画「现在」那个点 */
  readonly now: number
  readonly points: readonly ZonePoint[]
}

export interface ZoneCell {
  readonly district: string
  readonly series: readonly ZoneSeries[]
  /** 该区最高等级 */
  readonly topLevel: Level
  /** 该区最深积水（m） */
  readonly maxDepth: number
  /** 该区 12h 内最高预测水位与出现时刻 */
  readonly peak: { level: number; atMin: number; name: string } | null
  /** 首次穿过红阈的分钟数；不穿为 null */
  readonly crossRedAtMin: number | null
  readonly thresholds: { blue: number; yellow: number; orange: number; red: number }
}

const LEVEL_NAME: Record<string, string> = { none: '正常', blue: '蓝色', yellow: '黄色', orange: '橙色', red: '红色' }

function whenLabel(atMin: number): string {
  if (atMin <= 0) return '此刻'
  if (atMin < 60) return `${Math.round(atMin)}min`
  const h = atMin / 60
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`
}

/**
 * 一个辖区的预测格。
 *
 * SVG 用 `viewBox` + `preserveAspectRatio="none"` 拉伸填满盒子——这是大屏的惯例，
 * 但**文字必须画在 DOM 层**（绝对定位），否则字会跟着横向拉伸。
 * 这个坑以前在阈值标签上踩过：被拉宽的图把贴边标签直接切掉了。
 */
export function ZoneCellView({ cell, domain, p }: {
  cell: ZoneCell
  /** 六格共用的纵轴范围，保证跨站可比 */
  domain: readonly [number, number]
  p: Palette
}) {
  const W = 100
  const H = 56
  const padL = 13
  const padR = 2
  const padT = 3
  const padB = 9
  const iw = W - padL - padR
  const ih = H - padT - padB
  const [lo, hi] = domain
  const span = Math.max(hi - lo, 0.05)
  const maxMin = Math.max(720, ...cell.series.flatMap((s) => s.points.map((x) => x.offsetMin)))

  const sx = (min: number) => padL + (Math.min(min, maxMin) / maxMin) * iw
  const sy = (lv: number) => padT + ih - ((Math.min(Math.max(lv, lo), hi) - lo) / span) * ih

  const th = cell.thresholds
  const bands = [
    { from: lo, to: th.blue, color: p.level.none, alpha: 0.05 },
    { from: th.blue, to: th.yellow, color: p.level.blue, alpha: 0.09 },
    { from: th.yellow, to: th.orange, color: p.level.yellow, alpha: 0.1 },
    { from: th.orange, to: th.red, color: p.level.orange, alpha: 0.1 },
    { from: Math.max(th.red, lo), to: hi, color: p.level.red, alpha: 0.12 },
  ].filter((b) => b.to > b.from && b.to >= lo && b.from <= hi)

  const rising = cell.peak != null && cell.peak.level > cell.maxDepth + 0.03

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 标题行：区名 + 等级 + 三个关键数。数字放这里而不是塞进图里，
          因为图会随卡片高度伸缩，字不会。 */}
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'baseline', gap: 7, padding: '0 1px 5px' }}>
        <span style={{ flex: '0 0 3px', alignSelf: 'stretch', background: p.level[cell.topLevel], borderRadius: 2 }} />
        <b style={{ fontSize: 13.5, letterSpacing: 0.3, whiteSpace: 'nowrap' }}>{cell.district}</b>
        <span style={{ fontSize: 9.5, color: p.textFaint }}>{cell.series.length} 站 · {LEVEL_NAME[cell.topLevel]}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'baseline', gap: 9, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 9.5, color: p.textFaint }}>
            此刻 <b style={{ fontSize: 12, color: p.levelInk[cell.topLevel], fontVariantNumeric: 'tabular-nums' }}>{cell.maxDepth.toFixed(2)}</b> m
          </span>
          {cell.peak && (
            <span style={{ fontSize: 9.5, color: p.textFaint }}>
              12h 峰值 <b style={{ fontSize: 12, color: p.forecast, fontVariantNumeric: 'tabular-nums' }}>{cell.peak.level.toFixed(2)}</b> m
              <span style={{ marginLeft: 3 }}>· {whenLabel(cell.peak.atMin)}后</span>
            </span>
          )}
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 600,
              padding: '1px 5px',
              borderRadius: 3,
              color: cell.crossRedAtMin != null ? p.levelInk.red : rising ? p.levelInk.orange : p.levelInk.blue,
              background: cell.crossRedAtMin != null ? p.levelSoft.red : rising ? p.levelSoft.orange : p.levelSoft.blue,
            }}
          >
            {cell.crossRedAtMin != null ? `${whenLabel(cell.crossRedAtMin)}后穿红` : rising ? '仍在涨' : '已过峰'}
          </span>
        </span>
      </div>

      {/* 曲线区 */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
        >
          {/* 阈值横带：先画色带再画线，线压在上面才读得清 */}
          {bands.map((b, i) => (
            <rect
              key={i}
              x={padL}
              y={sy(b.to)}
              width={iw}
              height={Math.max(sy(b.from) - sy(b.to), 0.3)}
              fill={b.color}
              opacity={b.alpha}
            />
          ))}
          {Object.entries(th).map(([k, v]) => (
            <line
              key={k}
              x1={padL}
              x2={W - padR}
              y1={sy(v)}
              y2={sy(v)}
              stroke={p.level[k as Level]}
              strokeWidth={0.5}
              opacity={0.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* 时间网格：每 3 小时一条竖线 */}
          {[180, 360, 540, 720].map((m) => (
            <line key={m} x1={sx(m)} x2={sx(m)} y1={padT} y2={padT + ih} stroke={p.panelLine} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}

          {/* 各站曲线：非最高等级的线要淡，否则六条一样粗读不出主次 */}
          {cell.series.map((s) => {
            if (s.points.length < 2) return null
            const d = s.points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${sx(pt.offsetMin).toFixed(2)},${sy(pt.level).toFixed(2)}`).join(' ')
            const isTop = s.level === cell.topLevel
            return (
              <path
                key={s.siteId}
                d={d}
                fill="none"
                stroke={p.level[s.level]}
                strokeWidth={isTop ? 1.8 : 1.05}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={isTop ? 1 : s.level === 'none' ? 0.35 : 0.72}
                vectorEffect="non-scaling-stroke"
              />
            )
          })}

          {/* 达峰点 + 「现在」点 */}
          {cell.peak && (
            <circle cx={sx(cell.peak.atMin)} cy={sy(cell.peak.level)} r={1.5} fill={p.forecast} stroke={p.panel} strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
          )}
          <line x1={padL} x2={padL} y1={padT} y2={padT + ih} stroke={p.textFaint} strokeWidth={1} opacity={0.55} vectorEffect="non-scaling-stroke" />
        </svg>

        {/* 纵轴刻度与横轴标签走 DOM：SVG 被横向拉伸时字会变形 */}
        <span style={{ position: 'absolute', left: 0, top: 0, fontSize: 8, color: p.textFaint, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
          {hi.toFixed(1)}
        </span>
        <span style={{ position: 'absolute', left: 0, bottom: 9, fontSize: 8, color: p.textFaint, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
          {lo.toFixed(1)}
        </span>
      </div>

      {/* 时间轴：现在 / +3 / +6 / +9 / +12h */}
      <div style={{ flex: '0 0 auto', display: 'flex', justifyContent: 'space-between', padding: '3px 2px 0 13px', fontSize: 8.5, color: p.textFaint }}>
        <span>现在</span>
        <span>+3h</span>
        <span>+6h</span>
        <span>+9h</span>
        <span>+12h</span>
      </div>

      {/* 底注：这一格最该记住的那句话 */}
      <div style={{ flex: '0 0 auto', fontSize: 9, color: p.textFaint, padding: '3px 1px 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {cell.peak ? (
          <>
            峰值在 <b style={{ color: p.textDim }}>{cell.peak.name}</b>
            {cell.crossRedAtMin != null ? (
              <span style={{ color: p.levelInk.red }}> · {whenLabel(cell.crossRedAtMin)}后穿过红阈</span>
            ) : rising ? (
              <span style={{ color: p.levelInk.orange }}> · 仍高于此刻</span>
            ) : (
              <span> · 已过峰转退</span>
            )}
          </>
        ) : (
          '无预测数据'
        )}
      </div>
    </div>
  )
}

/** 六格共用的纵轴范围：取所有曲线与阈值的并集，再留 8% 余量。 */
export function sharedDomain(cells: readonly ZoneCell[]): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const c of cells) {
    for (const s of c.series) {
      for (const pt of s.points) {
        lo = Math.min(lo, pt.level)
        hi = Math.max(hi, pt.level)
      }
    }
    hi = Math.max(hi, c.thresholds.red)
    lo = Math.min(lo, c.thresholds.blue)
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]
  const pad = Math.max((hi - lo) * 0.08, 0.03)
  return [Math.max(0, lo - pad), hi + pad]
}

/** 域外辅助：把一个 Meters 品牌值转成图上的数。 */
export const asNum = (v: Meters): number => Number(v)
