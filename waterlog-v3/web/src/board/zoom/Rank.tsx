import { useEffect, useState } from 'react'
import type { Level } from '../../domain'
import { fmtDepth } from '../../domain'
import { useWatchlist } from '../../view/useWatchlist'
import type { ZoomProps } from './types'

/**
 * Rank —— 积水程度排行。
 *
 * 只回答一个问题：**先派谁去**。所以维度只有一个（水深），排序固定按
 * `reading.depth` 降序，不给切换——值班班长在 3 秒里要的是顺序，不是筛选器。
 *
 * 两个尺寸共用一套「序号 / 站名 / 条 / 条端数值」骨架，只有尺码不同：
 *   - compact（约 600×250）：单行 15~23px，条 6px，数值 12px，条占行右侧；
 *   - full（约 1896×1000）：两行 56~84px，第一行站名 19px + 右侧两个刻度
 *     （涨速、超红），第二行 12px 的条 + 17px 的条端数值。
 *
 * 数值跟着**条端**走而不是固定右对齐：十条里有五条是 0，固定列会把五个
 * `0.00 m` 竖成一摞、和条完全脱钩；跟在条端至少能看出「这根条到这为止」。
 */

const EASE = 'cubic-bezier(.22,.61,.36,1)'

/** 涨速：2 位小数、带符号。`-0.00` 一律写 `0.00`——轮询下 0 附近会反复出现。 */
function deltaText(v: number): string {
  const r = Number(v.toFixed(2))
  if (r === 0) return '0.00'
  return `${r > 0 ? '+' : '-'}${Math.abs(r).toFixed(2)}`
}

interface Row {
  readonly id: string
  readonly name: string
  readonly level: Level
  readonly barPx: number
  readonly label: string
  readonly labelLeft: number
  readonly trend: string
  readonly excess: string
}

export function Rank({ p, w, h, detail }: ZoomProps) {
  const compact = detail === 'compact'
  // 排序即口径：`useWatchlist('depth')` 已经按绝对水深降序排好，这里不再重排。
  const list = useWatchlist('depth')
  const reduce = useReducedMotion()
  const [entered, setEntered] = useState(false)

  // 入场把条从 0 拉到目标长度：切回这一页时能看见「在长」。
  useEffect(() => {
    if (reduce) {
      setEntered(true)
      return
    }
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [reduce])

  const fsName = compact ? 11.5 : 19
  const fsIdx = compact ? 11 : 15
  const fsValue = compact ? 12 : 17
  const fsExtra = 15
  const barHBase = compact ? 6 : 12
  const markW = compact ? 9 : 14
  const idxW = compact ? 17 : 30
  const nameW = compact ? 104 : 236
  const valueW = compact ? 58 : 96
  const padX = compact ? 12 : 26
  const rowW = Math.max(120, w - padX * 2)
  const trackLeft = markW + idxW + nameW
  const trackW = Math.max(24, rowW - trackLeft - valueW)

  // 行高：compact 摊到 15~23px（榜首 ×1.15 ≈ 26）；full 固定 56px（榜首 ≈ 64）。
  const n = Math.max(1, list.length)
  const avail = h - (compact ? 8 : 20)
  // 行高按可用高度摊开：full 写死 56px 时 10 行只占 600px，
  // 整页上下各留 200px 空白——「排行走」要能一眼比高低，先得让它铺满。
  const hPer = compact
    ? Math.round(Math.max(15, Math.min(23, avail / (n + 0.15))))
    : Math.round(Math.max(56, Math.min(96, avail / (n + 0.15))))
  const leadH = hPer * 1.15
  const total = leadH + hPer * (n - 1)
  const top0 = (compact ? 4 : 10) + Math.max(0, (avail - total) / 2)

  // 一行两段：上半站名与涨速，下半条与数值，比例跟着行高走。
  const contentH = compact ? 0 : hPer
  const lineH = compact ? 0 : Math.round(hPer * 0.46)
  const barH = compact ? barHBase : Math.round(Math.max(12, Math.min(22, hPer * 0.22)))

  let maxDepth = 0
  for (const g of list) maxDepth = Math.max(maxDepth, Math.max(0, g.reading.depth))

  const rows: Row[] = list.map((g) => {
    const depth = Math.max(0, g.reading.depth)
    const ratio = maxDepth > 0 ? Math.min(1, depth / maxDepth) : 0
    // 0 值不留条，正数至少 2px——否则「有积水」和「没积水」看不出区别。
    const barPx = !entered ? 0 : depth > 0 ? Math.max(2, ratio * trackW) : 0
    const label = `${fmtDepth(depth)} m`
    const labelW = label.length * fsValue * 0.58
    const labelLeft = Math.max(2, Math.min(barPx + 7, trackW + valueW - labelW - 2))
    const excess = depth - g.redThreshold
    return {
      id: g.site.id,
      name: g.site.name,
      level: g.assessment.level,
      barPx,
      label,
      labelLeft,
      trend: deltaText(g.reading.trend1h),
      excess: excess >= 0 ? `超红 ${fmtDepth(excess)} m` : `距红 ${fmtDepth(-excess)} m`,
    }
  })

  if (list.length === 0) {
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

  return (
    <div style={{ position: 'relative', width: w, height: h, overflow: 'hidden' }}>
      {rows.map((m, i) => {
        const y = i === 0 ? top0 : top0 + leadH + hPer * (i - 1)
        const rowH = i === 0 ? leadH : hPer
        const top = compact ? 0 : Math.max(0, (rowH - contentH) / 2)
        const barTop = compact ? (rowH - barH) / 2 : top + lineH + 8 + (22 - barH) / 2
        return (
          <div key={m.id} style={{ position: 'absolute', left: padX, top: y, width: rowW, height: rowH }}>
            {i < rows.length - 1 ? (
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 1,
                  background: p.panelLine,
                }}
              />
            ) : null}

            {/* 第一行：序号 / 站名 / （full）涨速与超红 */}
            <div
              style={{
                position: 'absolute',
                left: 0,
                top,
                width: rowW,
                height: compact ? rowH : lineH,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <span
                style={{
                  width: markW,
                  flex: '0 0 auto',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                {i === 0 ? (
                  <span
                    style={{
                      display: 'block',
                      width: 0,
                      height: 0,
                      borderTop: `${compact ? 5 : 8}px solid transparent`,
                      borderBottom: `${compact ? 5 : 8}px solid transparent`,
                      borderLeft: `${compact ? 7 : 11}px solid ${p.level[m.level]}`,
                    }}
                  />
                ) : null}
              </span>

              <span
                style={{
                  width: idxW,
                  flex: '0 0 auto',
                  paddingRight: 5,
                  textAlign: 'right',
                  fontSize: fsIdx,
                  color: p.textFaint,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {i + 1}
              </span>

              <span
                style={{
                  width: nameW,
                  flex: '0 0 auto',
                  paddingLeft: 8,
                  fontSize: i === 0 ? fsName : fsName - (compact ? 0 : 1),
                  fontWeight: i === 0 ? 700 : 500,
                  color: p.text,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                }}
              >
                {m.name}
              </span>

              {compact ? null : (
                <span
                  style={{
                    flex: 1,
                    textAlign: 'right',
                    paddingRight: valueW,
                    fontSize: fsExtra,
                    color: p.textDim,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {`涨速 ${m.trend} m/h`}
                  <span style={{ color: p.textFaint }}>{' · '}</span>
                  {m.excess}
                </span>
              )}
            </div>

            {/* 第二行：轨道 + 条 + 条端数值 */}
            <div
              style={{
                position: 'absolute',
                left: trackLeft,
                top: barTop,
                width: trackW,
                height: barH,
              }}
            >
              <div style={{ position: 'absolute', inset: 0, borderRadius: barH / 2, background: p.panelLine }} />
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  height: '100%',
                  width: m.barPx,
                  borderRadius: barH / 2,
                  background: p.level[m.level],
                  transition: reduce ? 'none' : `width 400ms ${EASE}`,
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  left: m.labelLeft,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  fontSize: fsValue,
                  fontWeight: 700,
                  color: p.text,
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                }}
              >
                {m.label}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 减动效偏好：系统里关掉动效时，条不该还在长。 */
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
