import type { Level } from '../domain'
import type { Palette } from './theme'

/**
 * 「全域研判」屏的四个统领性面板。
 *
 * 这一屏的共同前提：**单个站的数据在这里一律不出现**。前面两屏已经
 * 把「哪个站多少米」讲到吐了，这一屏要回答的是把全城当一个整体才问得出来的问题。
 *
 *   Heatmap      这波是怎么蔓延开的 —— 时间 × 站点的等级矩阵
 *   RiskQuadrant 现在该先救谁 —— 深度 × 涨速，四个象限各有处置含义
 *   TrendOutlook 是收尾还是要来第二波 —— 预警站数走势 + 6~12h 外推
 *   Confidence   哪几个站的预测敢信 —— 区间宽度横向对比
 *   DistrictCompare 五个区横向比谁更吃力
 */

const RANK: Record<string, number> = { none: 0, blue: 1, yellow: 2, orange: 3, red: 4 }
const LEVEL_NAME: Record<string, string> = { none: '正常', blue: '蓝', yellow: '黄', orange: '橙', red: '红' }

// ---------------------------------------------------------------- 热力图

/**
 * 热力图的一格：要么是一个等级，要么是 `'blank'`（那一刻没有数据）。
 *
 * `'blank'` 不属于 `Level` —— 「有没有测到」不是水位等级，塞进领域类型会让
 * 别处也得处理这个分支。它是这一张图专有的视图状态，所以只在这里定义。
 */
export type HeatCell = Level | 'blank'

export interface HeatRow {
  readonly siteId: string
  readonly name: string
  readonly district: string
  /** 与 columns 对齐的等级序列 */
  readonly levels: readonly HeatCell[]
}

/**
 * 全域水位演进热力图：横轴时间、纵轴站点，格色＝那一小时的等级。
 *
 * 为什么它最能「统领」：**同步上涨**这件事只有矩阵看得出来。
 * 曲线图里十条线各走各的，要人不自觉地去比斜率；矩阵里同一行连续变色
 * 就是「这个站一直在涨」，同一列一起变色就是「这一刻全城在涨」——
 * 而「同一条河的上下游差半小时先后变红」正是排涝调度最需要的信息。
 *
 * 等级用色相区分（蓝黄橙红），不用深浅。深浅在投影仪上分不出三档，
 * 而且「深一点的红」和「红」在业务上是同一个等级。
 */
export function Heatmap({ rows, columns, p }: {
  rows: readonly HeatRow[]
  /** 每列代表的时间偏移（分钟），用于顶部刻度 */
  columns: readonly number[]
  p: Palette
}) {
  if (!rows.length) return <div style={{ fontSize: 11, color: p.textFaint }}>等待历史数据</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 表头：小时刻度。列宽用 fr 均分，列数与刻度数自动对齐 */}
      <div style={{ flex: '0 0 auto', display: 'grid', gridTemplateColumns: `86px 1fr`, gap: 8, paddingBottom: 4 }}>
        <span style={{ fontSize: 9, color: p.textFaint }}>站点 / 时间</span>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns.length}, 1fr)`, gap: 1 }}>
          {columns.map((m, i) => (
            <span
              key={i}
              style={{
                fontSize: 8,
                // 「现在」那一格加粗，它是过去与未来的分界，得能一眼找到
                color: m === 0 ? p.text : p.textFaint,
                fontWeight: m === 0 ? 700 : 400,
                textAlign: 'center',
              }}
            >
              {/*
                刻度按 offset 判定，不按索引。早先写 `i === length - 1 ? '现在'`，
                于是标签永远钉在最右一格 —— 而 offset=0 的那一格其实在中间，
                整条时间轴与数据错开好几格。
              */}
              {m === 0 ? '现在' : `${Math.round(m / 60)}h`}
            </span>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {rows.map((r) => (
          <div key={r.siteId} style={{ flex: '1 1 0', minHeight: 0, display: 'grid', gridTemplateColumns: `86px 1fr`, gap: 8, alignItems: 'stretch' }}>
            <span style={{ fontSize: 9.5, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              <span
                style={{
                  flex: '0 0 2px',
                  alignSelf: 'stretch',
                  margin: '1px 0',
                  // 行首竖条取该站「现在」那一格的颜色。'blank' 没有颜色可给，
                  // 退回正常灰 —— 缺数据不该在行首伪装成一个等级。
                  background: (() => {
                    const last = r.levels[r.levels.length - 1]
                    return p.level[last === undefined || last === 'blank' ? 'none' : last]
                  })(),
                  borderRadius: 1,
                }}
              />
              {r.name}
            </span>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns.length}, 1fr)`, gap: 1 }}>
              {r.levels.map((lv, i) => (
                <span
                  key={i}
                  title={`${r.name} · ${lv === 'blank' ? '无数据' : LEVEL_NAME[lv]}`}
                  style={{
                    // 「没测到」和「测了但没超阈」必须看得出区别：
                    // 前者留一条空心细线，后者是实心的正常灰。都用同一个灰的话，
                    // 读者会把「缺数据」读成「情况良好」——这是最危险的一种误读。
                    background: lv === 'blank' ? 'transparent' : lv === 'none' ? p.panelLine : p.level[lv],
                    border: lv === 'blank' ? `1px dashed ${p.panelLine}` : undefined,
                    opacity: lv === 'none' ? 0.5 : 0.9,
                    borderRadius: 1,
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10, fontSize: 9, color: p.textFaint, paddingTop: 5 }}>
        <span>等级</span>
        {(['none', 'blue', 'yellow', 'orange', 'red'] as const).map((k) => (
          <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: k === 'none' ? p.panelLine : p.level[k], opacity: k === 'none' ? 0.5 : 0.9, display: 'inline-block' }} />
            {LEVEL_NAME[k]}
          </span>
        ))}
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, border: `1px dashed ${p.panelLine}`, display: 'inline-block' }} />
          无数据
        </span>
        <span style={{ marginLeft: 'auto' }}>同一行连续变色＝该站持续上涨 · 同一列一起变色＝全城同时上涨</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 风险格局

export interface RiskPoint {
  readonly siteId: string
  readonly name: string
  readonly level: Level
  readonly depth: number
  /** 1h 水位变化量（m，正涨负退） */
  readonly slope: number
}

/**
 * 风险格局：横轴涨速、纵轴当前积水深，四个象限各有明确的处置含义。
 *
 * 这不是「把两个指标画在一起」，是把**处置优先级**画出来：
 *
 *   右上 又深又涨 → 现在就派人，而且不能等
 *   左上 深但已转退 → 水在退，但要盯着别二次降雨
 *   右下 浅但在涨 → 提前布防，是下一批会穿阈的
 *   左下 平稳 → 不用管
 *
 * 象限线画在**阈值蓝**与涨速 0 上，不是画在中位数上——虚线必须是
 * 「业务上算不算有事」的那条线，否则读者要自己换算。
 */
export function RiskQuadrant({ points, blue, p }: { points: readonly RiskPoint[]; blue: number; p: Palette }) {
  if (!points.length) return <div style={{ fontSize: 11, color: p.textFaint }}>等待监测数据</div>

  const maxDepth = Math.max(blue * 2, ...points.map((x) => x.depth), 0.2)
  const maxAbsSlope = Math.max(0.05, ...points.map((x) => Math.abs(x.slope)))

  const quads = [
    { key: 'hot', label: '又深又涨', action: '现在派人', color: p.levelInk.red, soft: p.levelSoft.red, x0: 0.5, y0: 0 },
    { key: 'deep', label: '深但转退', action: '盯二次降雨', color: p.levelInk.orange, soft: p.levelSoft.orange, x0: 0, y0: 0 },
    { key: 'rising', label: '浅但在涨', action: '提前布防', color: p.levelInk.yellow, soft: p.levelSoft.yellow, x0: 0.5, y0: 0.5 },
    { key: 'calm', label: '平稳', action: '无需处理', color: p.levelInk.blue, soft: p.levelSoft.blue, x0: 0, y0: 0.5 },
  ]

  const inQuad = (pt: RiskPoint, key: string) => {
    const right = pt.slope > 0
    const up = pt.depth >= blue
    if (key === 'hot') return right && up
    if (key === 'deep') return !right && up
    if (key === 'rising') return right && !up
    return !right && !up
  }
  const counts = quads.map((q) => points.filter((pt) => inQuad(pt, q.key)).length)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 10 }}>
        {/* 象限图 */}
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          {quads.map((q) => (
            <div
              key={q.key}
              style={{
                position: 'absolute',
                left: `${q.x0 * 100}%`,
                top: `${q.y0 * 100}%`,
                width: '50%',
                height: '50%',
                background: q.soft,
                borderLeft: q.x0 ? `1px dashed ${p.panelLine}` : 'none',
                borderTop: q.y0 ? `1px dashed ${p.panelLine}` : 'none',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'flex-start',
                padding: 4,
                boxSizing: 'border-box',
                overflow: 'hidden',
              }}
            >
              <span style={{ fontSize: 9, color: q.color, opacity: 0.65, whiteSpace: 'nowrap' }}>{q.label}</span>
            </div>
          ))}

          {/* 气泡：外圈用等级色，内部实心，深色带白描边保证在任何底色上都可见 */}
          {points.map((pt) => {
            const cx = 0.5 + (pt.slope / maxAbsSlope) * 0.5
            const cy = 1 - Math.min(pt.depth / maxDepth, 1)
            return (
              <span
                key={pt.siteId}
                title={`${pt.name} ${pt.depth.toFixed(2)}m ${pt.slope >= 0 ? '+' : ''}${pt.slope.toFixed(2)}m/h`}
                style={{
                  position: 'absolute',
                  left: `${cx * 100}%`,
                  top: `${cy * 100}%`,
                  width: 11,
                  height: 11,
                  marginLeft: -5.5,
                  marginTop: -5.5,
                  borderRadius: '50%',
                  background: p.level[pt.level],
                  border: `1.5px solid ${p.panel}`,
                  boxShadow: `0 0 0 1px ${p.level[pt.level]}`,
                }}
              />
            )
          })}
        </div>

        {/* 右侧：四个象限的计数与动作。图例在这里，用文字给出「然后干什么」 */}
        <div style={{ flex: '0 0 128px', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {quads.map((q, i) => (
            <div key={q.key} style={{ display: 'flex', alignItems: 'baseline', gap: 5, fontSize: 9.5, borderLeft: `2px solid ${q.color}`, paddingLeft: 5 }}>
              <b style={{ fontSize: 12.5, color: q.color, fontVariantNumeric: 'tabular-nums' }}>{counts[i]}</b>
              <span style={{ color: p.textDim }}>{q.label}</span>
              <span style={{ marginLeft: 'auto', fontSize: 8.5, color: p.textFaint, textAlign: 'right' }}>{q.action}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: '0 0 auto', display: 'flex', justifyContent: 'space-between', fontSize: 8.5, color: p.textFaint, paddingTop: 3 }}>
        <span>← 退水</span>
        <span>横轴 1h 变幅（±{maxAbsSlope.toFixed(2)}m）</span>
        <span>涨水 →</span>
      </div>
      <div style={{ flex: '0 0 auto', fontSize: 8.5, color: p.textFaint }}>
        纵轴积水深，虚线在蓝色阈值 {blue.toFixed(2)}m —— 之上才算「有事」
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 趋势研判

export interface TrendPoint {
  readonly offsetMin: number
  /**
   * 该时刻处于预警（蓝及以上）的站数。主图。
   *
   * 不用「全域合计积水深」：水深是强度量，各站高程基准不同，相加没有物理
   * 含义。站数有绝对含义，且正是这一格要回答的问题。
   */
  readonly alarmCount: number
  /**
   * 该时刻十站中最深的那一站的积水深（m）。
   *
   * 取 max 而不是 sum：max 在所有站之间都有含义（「最深的那个深到什么程度」），
   * sum 只在这一级强度量上才有含义。
   */
  readonly maxDepth: number
}

/**
 * 趋势研判：预警站数与最深积水的时间走势，外加 6~12h 外推。
 *
 * 回答「这波是收尾了还是要来第二波」。主图是**预警站数**（0~10 站，
 * 有绝对含义），叠一条最深积水曲线（取十站最大值，不是相加）。
 *
 * 判断口径写死在图上：外推段用虚线，并明确标注「按当前斜率外延」——
 * 混淆外推与模型预测是分析类面板最容易造成的事故。
 */
export function TrendOutlook({ history, outlook, p }: {
  history: readonly TrendPoint[]
  /** 外推点：由调用方用当前趋势线性外延算得，不是模型输出 */
  outlook: readonly TrendPoint[]
  p: Palette
}) {
  if (history.length < 2) return <div style={{ fontSize: 11, color: p.textFaint }}>等待历史数据</div>

  const all = [...history, ...outlook]
  // 站数轴固定 0~10：这是绝对量，不该跟着数据缩放——缩放了就没有「几站」的手感。
  const maxN = Math.max(10, ...all.map((x) => x.alarmCount))
  const maxD = Math.max(0.1, ...all.map((x) => x.maxDepth))
  const maxMin = Math.max(...all.map((x) => x.offsetMin), 60)

  const W = 100
  const H = 40
  const padL = 1
  const padR = 1
  const iw = W - padL - padR
  const sx = (m: number) => padL + (m / maxMin) * iw
  const syD = (v: number) => H - (v / maxD) * H
  const syN = (v: number) => H - (v / maxN) * H

  const line = (pts: readonly TrendPoint[], f: (x: TrendPoint) => number) =>
    pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${sx(pt.offsetMin).toFixed(2)},${f(pt).toFixed(2)}`).join(' ')

  const lastHist = history[history.length - 1]
  const lastOut = outlook[outlook.length - 1]

  // 结论按「站数变化」判，不按水深之和判：站数才是「几个站在危险里」的直接答案。
  const dN = lastOut ? lastOut.alarmCount - lastHist.alarmCount : 0
  const dD = lastOut ? lastOut.maxDepth - lastHist.maxDepth : 0
  // 结论按「站数优先、水深补充」判：站数变多就一定在扩大，站数变少就是在收尾；
  // 站数不变时再看最深水位——它比站数敏感，因为水退到阈值以下之前站数不会动。
  const verdict =
    dN > 0
      ? '预警范围扩大'
      : dN < 0
        ? '预警正在收尾'
        : dD > 0.02
          ? '站数不变 · 深度仍在涨'
          : dD < -0.02
            ? '站数不变 · 深度在退'
            : '已趋稳'
  const verdictColor = dN > 0 ? p.levelInk.orange : dN < 0 ? p.levelInk.blue : dD > 0.02 ? p.levelInk.orange : p.levelInk.blue

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flex: '1', minHeight: 0, position: 'relative' }}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          {/* 分界线：现在之后是外推区 */}
          <rect x={sx(lastHist.offsetMin)} y={0} width={Math.max(W - sx(lastHist.offsetMin) - padR, 0)} height={H} fill={p.forecast} opacity={0.06} />
          <line x1={sx(lastHist.offsetMin)} x2={sx(lastHist.offsetMin)} y1={0} y2={H} stroke={p.forecast} strokeWidth={1} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" opacity={0.7} />

          {/* 主图：预警站数——用面积铺底 + 阶梯柱，阶梯才能表达「站数是跳变的」 */}
          {all.map((pt, i) => {
            const isOutlook = i >= history.length
            const next = all[i + 1]?.offsetMin ?? pt.offsetMin + maxMin / all.length
            const x = sx(pt.offsetMin)
            const w = Math.max(sx(next) - x, 0.4)
            const y = syN(pt.alarmCount)
            return (
              <rect
                key={i}
                x={x}
                y={y}
                width={w}
                height={H - y}
                fill={p.level.orange}
                opacity={isOutlook ? 0.10 : 0.20}
              />
            )
          })}

          {/* 最深积水：取十站最大值，历史实线 + 外推虚线。
              这是「危险到什么程度」，与站数（「几个站危险」）互补。 */}
          <path d={line(history, (x) => syD(x.maxDepth))} fill="none" stroke={p.accent} strokeWidth={1.6} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {outlook.length > 1 && (
            <path
              d={line([lastHist, ...outlook], (x) => syD(x.maxDepth))}
              fill="none"
              stroke={p.forecast}
              strokeWidth={1.4}
              strokeDasharray="3 2"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        <span style={{ position: 'absolute', left: 0, top: 0, fontSize: 8, color: p.textFaint }}>{maxN} 站</span>
        <span style={{ position: 'absolute', right: 0, top: 0, fontSize: 8, color: p.forecast }}>← 外推</span>
        <span style={{ position: 'absolute', left: 0, bottom: 0, fontSize: 8, color: p.accent }}>{maxD.toFixed(2)} m</span>
      </div>

      <div style={{ flex: '0 0 auto', display: 'flex', gap: 10, fontSize: 9, color: p.textFaint, paddingTop: 4, alignItems: 'baseline' }}>
        <span>预警 <b style={{ fontSize: 12.5, color: p.levelInk.orange, fontVariantNumeric: 'tabular-nums' }}>{lastHist.alarmCount}</b> 站</span>
        <span>最深 <b style={{ fontSize: 12.5, color: p.accent, fontVariantNumeric: 'tabular-nums' }}>{lastHist.maxDepth.toFixed(2)}</b> m</span>
        <span style={{ marginLeft: 'auto', fontWeight: 600, color: verdictColor }}>
          {verdict}{' '}
          <span style={{ fontWeight: 'normal', color: p.textFaint }}>
            （6h 后 {lastOut ? lastOut.alarmCount : lastHist.alarmCount} 站 ·{' '}
            {(lastOut ? lastOut.maxDepth : lastHist.maxDepth).toFixed(2)} m）
          </span>
        </span>
      </div>
      <div style={{ flex: '0 0 auto', fontSize: 8.5, color: p.textFaint }}>
        实线为已发生 · 虚线是按当前斜率外延 6h，不是模型预测
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 预测可信度

export interface ConfidenceRow {
  readonly siteId: string
  readonly name: string
  readonly district: string
  readonly level: Level
  /** 各预见期的 90% 区间半宽（m），取 12h 那条 */
  readonly halfWidth: number
  /** 12h 预测水位 */
  readonly fcLevel: number
}

/**
 * 预测可信度：每个站的预测区间宽度横向对比。
 *
 * 读法：条越短越可信。**条太长不是「这个站更难预测」，而是「这个站的
 * 输入数据不够」**——所以排在最前面的那些站要去查数据质量，而不是去信它。
 * 这句话必须写在图里，否则读者会把长条读成「情况复杂」。
 */
export function Confidence({ rows, p }: { rows: readonly ConfidenceRow[]; p: Palette }) {
  if (!rows.length) return <div style={{ fontSize: 11, color: p.textFaint }}>等待预测数据</div>

  const sorted = [...rows].sort((a, b) => b.halfWidth - a.halfWidth)
  const maxW = Math.max(0.02, ...sorted.map((r) => r.halfWidth))
  const needCare = sorted.filter((r) => r.halfWidth > maxW * 0.7).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {sorted.map((r, i) => (
          <div key={r.siteId} style={{ flex: '1 1 0', minHeight: 0, display: 'grid', gridTemplateColumns: '64px 1fr 44px', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 9, display: 'flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: p.level[r.level], flexShrink: 0 }} />
              {r.name}
            </span>
            <span style={{ height: 6, background: p.panelLine, borderRadius: 3, overflow: 'hidden', display: 'block' }}>
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${Math.max((r.halfWidth / maxW) * 100, 2)}%`,
                  background: i < needCare ? p.levelInk.red : p.accent,
                  opacity: i < needCare ? 0.75 : 0.55,
                  borderRadius: 3,
                }}
              />
            </span>
            <span style={{ fontSize: 9, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: i < needCare ? p.levelInk.red : p.textDim }}>
              ±{r.halfWidth.toFixed(3)}
            </span>
          </div>
        ))}
      </div>

      <div style={{ flex: '0 0 auto', fontSize: 8.5, color: p.textFaint, paddingTop: 4, borderTop: `1px solid ${p.panelLine}` }}>
        条＝12h 预测的 90% 区间半宽，越短越可信。<b style={{ color: p.levelInk.red }}>长条意味着输入数据不足</b>，不是情况更复杂。
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 多区对比

export interface DistrictCompareRow {
  readonly district: string
  readonly topLevel: Level
  readonly maxDepth: number
  readonly alarmCount: number
  readonly siteCount: number
  readonly peak: number | null
  readonly rain: number
}

/**
 * 多区对比：五个区的关键指标横向条形，一屏内排成名次。
 *
 * 每个区给三条：此刻最深、12h 峰值、超阈站数占比。三条**各自独立归一**
 * （都用全城最大值），所以「长」的意思是「在五个区里排第一」，
 * 而不是「比另一条长」——跨指标比较条长是这类图的经典误读，故三条同色系不同深浅。
 */
export function DistrictCompare({ rows, p }: { rows: readonly DistrictCompareRow[]; p: Palette }) {
  if (!rows.length) return <div style={{ fontSize: 11, color: p.textFaint }}>等待数据</div>

  const maxDepth = Math.max(0.1, ...rows.map((r) => r.maxDepth))
  const maxPeak = Math.max(0.1, ...rows.map((r) => r.peak ?? 0))

  const cols = [
    { key: 'depth', label: '此刻最深', color: p.level.orange },
    { key: 'peak', label: '12h 峰值', color: p.forecast },
    { key: 'alarm', label: '超阈占比', color: p.level.red },
  ] as const

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flex: '0 0 auto', display: 'grid', gridTemplateColumns: '78px 1fr', gap: 8, paddingBottom: 4 }}>
        <span style={{ fontSize: 9, color: p.textFaint }}>辖区</span>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          {cols.map((c) => (
            <span key={c.key} style={{ fontSize: 9, color: p.textFaint }}>{c.label}</span>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {rows.map((r, i) => (
          <div key={r.district} style={{ flex: '1 1 0', minHeight: 0, display: 'grid', gridTemplateColumns: '78px 1fr', gap: 8, alignItems: 'center', borderTop: i === 0 ? 'none' : `1px solid ${p.panelLine}` }}>
            <span style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              <span style={{ width: 3, alignSelf: 'stretch', margin: '3px 0', background: p.level[r.topLevel], borderRadius: 2, flexShrink: 0 }} />
              {r.district}
            </span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, alignItems: 'center' }}>
              {[
                { v: r.maxDepth / maxDepth, t: `${r.maxDepth.toFixed(2)}m`, c: cols[0].color },
                { v: (r.peak ?? 0) / maxPeak, t: r.peak != null ? `${r.peak.toFixed(2)}m` : '—', c: cols[1].color },
                { v: r.siteCount ? r.alarmCount / r.siteCount : 0, t: `${r.alarmCount}/${r.siteCount}`, c: cols[2].color },
              ].map((x, k) => (
                <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                  <span style={{ flex: 1, height: 5, background: p.panelLine, borderRadius: 3, overflow: 'hidden', display: 'block' }}>
                    <span style={{ display: 'block', height: '100%', width: `${Math.min(Math.max(x.v, 0), 1) * 100}%`, background: x.c, opacity: 0.8, borderRadius: 3 }} />
                  </span>
                  <span style={{ fontSize: 9, color: p.textDim, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>{x.t}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div style={{ flex: '0 0 auto', fontSize: 8.5, color: p.textFaint, paddingTop: 4, borderTop: `1px solid ${p.panelLine}` }}>
        三条各自按全城最大值归一 —— 条长的意思是「五个区里排第一」，不是比另一条长
      </div>
    </div>
  )
}

/** 供 BoardPage 计算外推用：按最近几小时的平均斜率线性外延。 */
export function projectTrend(history: readonly TrendPoint[], hoursAhead = 6): TrendPoint[] {
  if (history.length < 3) return []
  const n = Math.min(3, history.length - 1)
  const last = history[history.length - 1]
  const prev = history[history.length - 1 - n]
  const steps = last.offsetMin - prev.offsetMin
  if (steps <= 0) return []
  // 按最近几小时的平均斜率分别外延两个量：站数取整（不能出现 3.4 站），
  // 最深积水保留下限 0（水深不会为负）。
  const dN = (last.alarmCount - prev.alarmCount) / steps
  const dD = (last.maxDepth - prev.maxDepth) / steps
  const out: TrendPoint[] = []
  for (let m = 60; m <= hoursAhead * 60; m += 60) {
    out.push({
      offsetMin: last.offsetMin + m,
      alarmCount: Math.max(0, Math.min(10, Math.round(last.alarmCount + dN * m))),
      maxDepth: Math.max(0, last.maxDepth + dD * m),
    })
  }
  return out
}

export { RANK as _RANK }
