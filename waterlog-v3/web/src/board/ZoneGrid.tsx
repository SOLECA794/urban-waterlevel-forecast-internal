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
  /**
   * 排行数据。存在时这一格渲染成横向排行，而不是时间曲线。
   *
   * 为什么需要：十站水深相加得到的不是「全域合计水位」（水深是强度量，
   * 各站高程基准不同，加起来是个没有单位的数）。改成「各站超阈倍数」
   * 才有业务含义——倍数无量纲、跨站可比，直接回答「谁真正危险」。
   */
  readonly ranking?: readonly ZoneRankRow[]
  /** 排行里已达或超红阈的站数 */
  readonly overCount?: number
}

/** 排行里的一行：一站在此刻的危险程度。 */
export interface ZoneRankRow {
  readonly siteId: string
  readonly name: string
  readonly district: string
  /** 当前积水深 / 该站红阈。1.0 = 刚好到红阈 */
  readonly ratio: number
  readonly depth: number
  readonly red: number
  readonly level: Level
}

const LEVEL_NAME: Record<string, string> = { none: '正常', blue: '蓝色', yellow: '黄色', orange: '橙色', red: '红色' }

function whenLabel(atMin: number): string {
  if (atMin <= 0) return '此刻'
  if (atMin < 60) return `${Math.round(atMin)}min`
  const h = atMin / 60
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`
}

/**
 * 排行格：十站按「超阈倍数」横排，回答「此刻谁最危险、危险到什么程度」。
 *
 * ## 为什么用倍数而不是绝对深度
 *
 * 各站红阈不同（0.38~0.58m 不等）。0.60m 深但红阈 0.40 的站（倍数 1.5）
 * 比 0.70m 深但红阈 0.90 的站（倍数 0.78）危险得多——按绝对深度排会排反。
 * 倍数是无量纲的，跨站可比。
 *
 * ## 为什么红阈线画在 1.0
 *
 * 倍数 1.0 就是「刚好漫到红阈」，这是唯一有绝对含义的位置。条长越过这条线
 * 才算真危险，所以读「有没有越过线」比读「条有多长」更快。
 */
function ZoneRankView({ cell, p, activeSiteId, onPickSite }: {
  cell: ZoneCell
  p: Palette
  activeSiteId?: string | null
  onPickSite?: (siteId: string) => void
}) {
  const rows = cell.ranking ?? []
  // 条形标尺：最大倍数与 1.2 取大，保证红阈线不会挤在最右端贴边
  const maxRatio = Math.max(1.2, ...rows.map((r) => r.ratio))
  const overCount = cell.overCount ?? rows.filter((r) => r.ratio >= 1).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 标题行：与曲线格保持同一套排版语言（竖色条 + 区名 + 关键数） */}
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'baseline', gap: 7, padding: '0 1px 5px' }}>
        <span style={{ flex: '0 0 3px', alignSelf: 'stretch', background: p.level[cell.topLevel], borderRadius: 2 }} />
        <b style={{ fontSize: 13.5, letterSpacing: 0.3, whiteSpace: 'nowrap' }}>{cell.district}</b>
        <span style={{ fontSize: 9.5, color: p.textFaint }}>
          前 {rows.length} 站 · 倍数＝当前深/该站红阈
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'baseline', gap: 9, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 9.5, color: p.textFaint }}>
            最大倍数{' '}
            <b style={{ fontSize: 12, color: p.levelInk[cell.topLevel], fontVariantNumeric: 'tabular-nums' }}>
              {(rows[0]?.ratio ?? 0).toFixed(2)}
            </b>
            ×
          </span>
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 600,
              padding: '1px 5px',
              borderRadius: 3,
              color: overCount > 0 ? p.levelInk.red : p.levelInk.blue,
              background: overCount > 0 ? p.levelSoft.red : p.levelSoft.blue,
            }}
          >
            {overCount > 0 ? `${overCount} 站越过红阈` : '无站越过红阈'}
          </span>
        </span>
      </div>

      {/* 排行主体：每行名 + 条 + 数值 */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-around', padding: '2px 0' }}>
        {rows.map((r) => {
          const isActive = activeSiteId === r.siteId
          const pct = (r.ratio / maxRatio) * 100
          const crossPct = (1 / maxRatio) * 100
          return (
            <div
              key={r.siteId}
              onClick={onPickSite ? () => onPickSite(r.siteId) : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: onPickSite ? 'pointer' : 'default',
                borderRadius: 3,
                padding: '1px 2px',
                background: isActive ? p.levelSoft[r.level] : 'transparent',
              }}
              title={`${r.name} · 积水 ${r.depth.toFixed(2)} m / 红阈 ${r.red.toFixed(2)} m = ${r.ratio.toFixed(2)} 倍`}
            >
              <span
                style={{
                  flex: '0 0 78px',
                  fontSize: 9.5,
                  color: isActive ? p.text : p.textDim,
                  fontWeight: isActive ? 700 : 400,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {r.name}
              </span>
              {/* 条槽：红阈线固定画在倍数 1.0 处 */}
              <span style={{ position: 'relative', flex: 1, height: 9, background: p.panelLine, borderRadius: 2, overflow: 'hidden' }}>
                <span
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${pct}%`,
                    background: p.level[r.level],
                    opacity: isActive ? 1 : 0.82,
                    borderRadius: 2,
                  }}
                />
                <span
                  style={{
                    position: 'absolute',
                    left: `${crossPct}%`,
                    top: 0,
                    bottom: 0,
                    width: 1,
                    background: p.levelInk.red,
                    opacity: 0.9,
                  }}
                />
              </span>
              <span
                style={{
                  flex: '0 0 34px',
                  textAlign: 'right',
                  fontSize: 10,
                  fontWeight: 700,
                  color: p.levelInk[r.level],
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {r.ratio.toFixed(2)}×
              </span>
              <span
                style={{
                  flex: '0 0 62px',
                  textAlign: 'right',
                  fontSize: 8.5,
                  color: p.textFaint,
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.depth.toFixed(2)}/{r.red.toFixed(2)}m
              </span>
            </div>
          )
        })}
      </div>

      {/* 底注：这一格最该记住的那句话 */}
      <div style={{ flex: '0 0 auto', fontSize: 9, color: p.textFaint, padding: '3px 1px 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {rows.length > 0 ? (
          <>
            最深在 <b style={{ color: p.textDim }}>{rows[0].name}</b>
            <span style={{ color: p.levelInk[rows[0].level] }}>
              {' '}· 超红阈 {((rows[0].ratio - 1) * 100).toFixed(0)}%
            </span>
            <span> · 竖线为红阈</span>
          </>
        ) : (
          '无排行数据'
        )}
      </div>
    </div>
  )
}

/**
 * 一个辖区的预测格。
 *
 * SVG 用 `viewBox` + `preserveAspectRatio="none"` 拉伸填满盒子——这是大屏的惯例，
 * 但**文字必须画在 DOM 层**（绝对定位），否则字会跟着横向拉伸。
 * 这个坑以前在阈值标签上踩过：被拉宽的图把贴边标签直接切掉了。
 */
export function ZoneCellView({ cell, domain, p, activeSiteId, onPickSite }: {
  cell: ZoneCell
  /** 六格共用的纵轴范围，保证跨站可比 */
  domain: readonly [number, number]
  p: Palette
  /** 当前在别处被选中的站点（地图/列表点选），高亮对应曲线 */
  activeSiteId?: string | null
  /** 点曲线上的站点时回调，供上层做地图定位或侧栏联动 */
  onPickSite?: (siteId: string) => void
}) {
  // 排行格走独立视图：它讲「此刻谁最危险」，不涉及时间轴。
  // 走原来的曲线路径会让 ownDomain / 阈值线 / 时间轴全部失去意义。
  if (cell.ranking) return <ZoneRankView cell={cell} p={p} activeSiteId={activeSiteId} onPickSite={onPickSite} />

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
  /**
   * 阈值不再用大面积色带表达。
   *
   * 旧做法把四级阈值之间填成四块色带、铺满整个绘图区，结果是：
   * 域被阈值撑到 0.05~0.46，而十站水位都在 0.01 附近，曲线可用高度不足 2%，
   * 六格全成压底直线，读者看到的是六张几乎一样的色块图。
   *
   * 现在只画**落在域内**的阈值细线（0.5px），阈值数值改由右侧贴边的小色块
   * 与刻度表达。曲线因此能占满主体，而「离红线还有多远」仍然一眼可见。
   */
  const thLines = (['blue', 'yellow', 'orange', 'red'] as const)
    .map((k) => ({ key: k, value: th[k] }))
    .filter((t) => t.value >= lo && t.value <= hi)

  /**
   * 三种状态要分清，不然徽标会自相矛盾：
   * - `alreadyRed`：此刻就已经在红阈以上。曲线第一个点就命中，`crossRedAtMin` 是 0，
   *   说「0min 后穿红」等于没说，还会让人以为马上要恶化。
   * - `willRed`：此刻没红，窗口内某一刻会红 —— 这才是需要盯的预告。
   * - 其余：`rising` 决定「仍在涨」还是「已过峰」。
   */
  const alreadyRed = cell.maxDepth >= cell.thresholds.red
  const willRed = !alreadyRed && cell.crossRedAtMin != null && cell.crossRedAtMin > 0
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
              {/*
                峰落在窗口起点（atMin=0）要换一种说法。预测曲线只有未来、
                没有历史，退水时窗口内最高点必然就是起点 —— 数学上没错，
                但写成「12h 峰值 0.53 m」会让人以为「之后还能涨到 0.53」。
                实际含义是反的：此刻已是这一段最高，后面只会退。
              */}
              {cell.peak.atMin <= 0 ? (
                <>
                  此后最高 <b style={{ fontSize: 12, color: p.levelInk[cell.topLevel], fontVariantNumeric: 'tabular-nums' }}>{cell.peak.level.toFixed(2)}</b> m
                  <span style={{ marginLeft: 3 }}>· 就是此刻</span>
                </>
              ) : (
                <>
                  12h 峰值 <b style={{ fontSize: 12, color: p.forecast, fontVariantNumeric: 'tabular-nums' }}>{cell.peak.level.toFixed(2)}</b> m
                  <span style={{ marginLeft: 3 }}>· {whenLabel(cell.peak.atMin)}后</span>
                </>
              )}
            </span>
          )}
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 600,
              padding: '1px 5px',
              borderRadius: 3,
              color: willRed ? p.levelInk.red : alreadyRed ? p.levelInk.red : rising ? p.levelInk.orange : p.levelInk.blue,
              background: willRed ? p.levelSoft.red : alreadyRed ? p.levelSoft.red : rising ? p.levelSoft.orange : p.levelSoft.blue,
            }}
          >
            {willRed ? `${whenLabel(cell.crossRedAtMin as number)}后穿红` : alreadyRed ? '已在红阈上' : rising ? '仍在涨' : '已过峰'}
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
          {/* 阈值：只有落在可视域内的才画，虚线以示「参考线」而非「数据」 */}
          {thLines.map((t) => (
            <line
              key={t.key}
              x1={padL}
              x2={W - padR}
              y1={sy(t.value)}
              y2={sy(t.value)}
              stroke={p.level[t.key]}
              strokeWidth={0.6}
              strokeDasharray="3 2"
              opacity={0.62}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* 时间网格：每 3 小时一条竖线 */}
          {[180, 360, 540, 720].map((m) => (
            <line key={m} x1={sx(m)} x2={sx(m)} y1={padT} y2={padT + ih} stroke={p.panelLine} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}

          {/* 曲线渐变的 defs：每站一个，色取该站等级色。
              用渐变而不是纯色描边，是为了让曲线下方有「水体」的实感——
              纯线图在大屏上会显得单薄，填一层淡渐变立刻有分量。 */}
          <defs>
            {cell.series.map((sr) => (
              <linearGradient key={sr.siteId} id={`zg-${cell.district}-${sr.siteId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={p.level[sr.level]} stopOpacity={0.34} />
                <stop offset="100%" stopColor={p.level[sr.level]} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>

          {/* 各站曲线：非最高等级的线要淡，否则六条一样粗读不出主次 */}
          {cell.series.map((sr) => {
            if (sr.points.length < 2) return null
            const d = sr.points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${sx(pt.offsetMin).toFixed(2)},${sy(pt.level).toFixed(2)}`).join(' ')
            const isTop = sr.level === cell.topLevel
            const isActive = activeSiteId === sr.siteId
            // 填充路径要把曲线首尾连到底边，闭合成一块面积
            const fillD = `${d} L${sx(sr.points[sr.points.length - 1].offsetMin).toFixed(2)},${(padT + ih).toFixed(2)} L${sx(sr.points[0].offsetMin).toFixed(2)},${(padT + ih).toFixed(2)} Z`
            return (
              <g key={sr.siteId}>
                <path d={fillD} fill={`url(#zg-${cell.district}-${sr.siteId})`} stroke="none" />
                <path
                  d={d}
                  fill="none"
                  stroke={p.level[sr.level]}
                  strokeWidth={isActive ? 2.4 : isTop ? 1.8 : 1.05}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  opacity={isActive ? 1 : isTop ? 1 : sr.level === 'none' ? 0.35 : 0.72}
                  vectorEffect="non-scaling-stroke"
                  style={{ cursor: onPickSite ? 'pointer' : 'default' }}
                  onClick={onPickSite ? () => onPickSite(sr.siteId) : undefined}
                >
                  {isActive && <title>{sr.name}</title>}
                </path>
              </g>
            )
          })}

          {/* 达峰点 + 「现在」点 */}
          {cell.peak && (
            <circle cx={sx(cell.peak.atMin)} cy={sy(cell.peak.level)} r={1.5} fill={p.forecast} stroke={p.panel} strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
          )}
          <line x1={padL} x2={padL} y1={padT} y2={padT + ih} stroke={p.textFaint} strokeWidth={1} opacity={0.55} vectorEffect="non-scaling-stroke" />
        </svg>

        {/* 纵轴刻度走 DOM：SVG 被横向拉伸时字会变形 */}
        <span style={{ position: 'absolute', left: 0, top: 0, fontSize: 8, color: p.textFaint, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
          {hi.toFixed(2)}
        </span>
        <span style={{ position: 'absolute', left: 0, bottom: 9, fontSize: 8, color: p.textFaint, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
          {lo.toFixed(2)}
        </span>

        {/* 右侧阈值色标：四级阈值挨个竖着排，位置按 sy() 对齐到虚线，
            但只在「落在可视域内」时显示。这样即使纵轴被数据压缩，
            读者仍能从右侧读到每一档的具体数值，不会因为没画色带就丢了阈值信息。 */}
        {thLines.map((t) => (
          <span
            key={t.key}
            style={{
              position: 'absolute',
              right: 0,
              top: `calc(${((sy(t.value) - padT) / ih) * 100}% - 4px)`,
              fontSize: 7.5,
              lineHeight: 1,
              padding: '1px 2px',
              borderRadius: 2,
              color: p.levelInk[t.key],
              background: p.panel,
              fontVariantNumeric: 'tabular-nums',
              transform: 'translateX(50%)',
            }}
          >
            {t.value.toFixed(2)}
          </span>
        ))}
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
            {cell.peak.atMin <= 0 ? '最深在' : '峰值在'} <b style={{ color: p.textDim }}>{cell.peak.name}</b>
            {willRed ? (
              <span style={{ color: p.levelInk.red }}> · {whenLabel(cell.crossRedAtMin as number)}后穿过红阈</span>
            ) : alreadyRed ? (
              <span style={{ color: p.levelInk.red }}> · 此刻已在红阈上</span>
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
/** 单格自己的值域。合计格用它，不跟着辖区的尺子走。 */
export function ownDomain(cell: ZoneCell): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const s of cell.series) {
    for (const pt of s.points) {
      lo = Math.min(lo, pt.level)
      hi = Math.max(hi, pt.level)
    }
  }
  hi = Math.max(hi, cell.thresholds.red)
  lo = Math.min(lo, cell.thresholds.blue)
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]
  const pad = Math.max((hi - lo) * 0.1, 0.05)
  return [Math.max(0, lo - pad), hi + pad]
}

export function sharedDomain(cells: readonly ZoneCell[]): [number, number] {
  // 「全域合计」那一格画的是十个站相加（约 7~8m），和单个辖区的积水深
  // （0.5~1.5m）**不是同一个量**，必须排除，否则另外五格全被压成直线。
  const normal = cells.filter((c) => c.district !== '全域合计')
  const base = normal.length ? normal : cells

  // ── 域由**数据**决定，不再由阈值决定 ──────────────────────────────
  // 旧实现无条件把 red/blue 阈值并进域，纵轴因此永远覆盖 0.05~0.46。
  // 十站水位都贴近 0 时，曲线可用高度不足 2%，六格全成压底直线。
  // 现在的规则：先算纯数据域，只有当阈值「离数据不远」时才纳入。
  let dLo = Infinity
  let dHi = -Infinity
  for (const c of base) {
    for (const s of c.series) {
      for (const pt of s.points) {
        dLo = Math.min(dLo, pt.level)
        dHi = Math.max(dHi, pt.level)
      }
    }
  }
  if (!Number.isFinite(dLo) || !Number.isFinite(dHi)) return [0, 1]

  // 数据本身太平（比如全在 0~0.03）时给一个最小可视高度，否则曲线贴边不可读。
  const span0 = Math.max(dHi - dLo, 0.06)

  let lo = dLo
  let hi = dHi
  for (const c of base) {
    const t = c.thresholds
    // 阈值纳入的判据：它不能把域撑大超过数据的 1.6 倍。
    // 撑得太多说明阈值离数据太远，画进来只会压扁曲线——那就交给右侧刻度表达。
    if (t.red <= dLo + span0 * 1.6) hi = Math.max(hi, t.red)
    if (t.blue >= dHi - span0 * 1.6) lo = Math.min(lo, t.blue)
  }

  const pad = Math.max((hi - lo) * 0.12, 0.012)
  return [Math.max(0, lo - pad), hi + pad]
}

/** 域外辅助：把一个 Meters 品牌值转成图上的数。 */
export const asNum = (v: Meters): number => Number(v)
