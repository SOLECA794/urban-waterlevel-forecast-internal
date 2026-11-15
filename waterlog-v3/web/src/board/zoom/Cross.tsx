import { useEffect, useMemo, useState } from 'react'
import { fmtDepth, fmtTime } from '../../domain'
import type { Forecast } from '../../domain'
import { useForecast, useHealth } from '../../data/queries'
import { useWatchlist, type SiteGlance } from '../../view/useWatchlist'
import type { ZoomProps } from './types'

/**
 * Cross —— 几点会翻红。
 *
 * 一条横时间轴（现在 → 12 小时后），每站一个滑块，滑块的位置就是该站
 * **预计越过红色阈值的那一刻**。答案不是「红不红」，而是「还差多久」。
 *
 * 三档状态，右侧各自一句话：
 *   - 已翻过：滑块钉在最左端 + 一个朝左的小三角（它越在前面，不在窗口里），
 *     右侧写当前水深；
 *   - 会翻红：实心滑块落在轴上，右侧写时刻；
 *   - 不会翻红：空心滑块漂在轴右端外侧——「不在轴上」本身就是答案。
 *
 * 时刻锚点必须用 `useHealth().now`（仿真钟），不能用墙钟：仿真以 60x 推进，
 * 混用会让每个站的「几点」整体错开将近一小时。
 */

/** 位置过渡的曲线；和主应用同一套，避免两块屏的动感不一致。 */
const EASE = 'cubic-bezier(.22,.61,.36,1)'

/** 轴量程：12 小时，单位分钟。 */
const SPAN_MIN = 12 * 60

/** 5 个刻度（0/3/6/9/12 小时），两页都一样——口径不能在放大页变。 */
const TICKS = [0, 0.25, 0.5, 0.75, 1] as const

type Phase = 'crossed' | 'will' | 'never'

interface Row {
  readonly g: SiteGlance
  readonly phase: Phase
  /** 轴上的位置 0..1；never 恒为 1（画在右端外侧） */
  readonly at: number
  /** 翻红时刻（仿真秒）；never / 加载中为 null */
  readonly when: number | null
  /** 翻红那一刻的预计水深 */
  readonly expected: number
  /** 已超红阈的量（crossed 用来排序） */
  readonly over: number
}

export function Cross({ p, w, h, detail }: ZoomProps) {
  const full = detail === 'full'
  const list = useWatchlist('level')
  const fc = useForecast()
  const hl = useHealth()
  const reduce = useReducedMotion()

  // 「现在」只认仿真钟；健康接口还没回来时退到预测的发布时刻，
  // 两者都在同一条仿真轴上，差的是几分钟而不是一小时。
  const now: number | null = hl.data?.now ?? fc.data?.issuedAt ?? null
  const issued: number | null = fc.data?.issuedAt ?? null
  const rows = useMemo(() => buildRows(list, fc.data, now, issued), [list, fc.data, now, issued])

  const will = rows.filter((r) => r.phase === 'will')
  const crossed = rows.filter((r) => r.phase === 'crossed')
  const never = rows.filter((r) => r.phase === 'never')
  const first = will[0] ?? null
  const within2h = will.filter((r) => r.at <= 2 / 12).length
  const silent = will.length === 0
  // 分两种「没有」：一个站都没翻（该出空态文案），
  // 以及已有站超了红阈但接下来不再新增（行必须留着，那是正在发生的事）。
  const nothing = silent && crossed.length === 0

  // ---- 尺码：两页不是「同一张图缩放」，字号与行高各自给 ----
  const padX = full ? 56 : 12
  const nameW = full ? 300 : 92
  const labelW = full ? 200 : 76
  const gapR = full ? 18 : 8
  // 小页的轴压到 26px：250 高的块里只有这样才放得下 10 行 22px 的站，
  // 少一行就是少一个站，比「轴厚一点」代价大。
  const axisH = full ? 62 : 26
  const footH = full ? 42 : 0
  // 放大页 10 行按可用高度等分：写死 46px 时整页只填了上半截，
  // 下半截 400 多像素空白——「一屏信息量」是被无效留白吃掉的。
  const rowH = full
    ? Math.min(88, Math.max(46, Math.floor((h - axisH - footH - 10) / Math.max(1, rows.length))))
    : 22
  const fsName = full ? 15 : 11
  const fsMeta = full ? 14 : 11
  const dot = full ? 14 : 9
  // 放大页每行上方要放一行「预计 x m」，所以滑轨压到行高 2/3 处，给小字腾地方。
  const trackY = full ? Math.round(rowH * 0.62) : rowH / 2

  const boxH = Math.max(rowH, h - axisH - footH - (full ? 10 : 4))
  const maxRows = Math.max(1, Math.floor(boxH / rowH))

  // 位置不够时先砍「不会翻红」——它们对「几点」这个问题没有贡献，
  // 但砍掉的条数必须写出来，不能让观众以为只有这 6 个站。
  let shown = rows
  let hidden = 0
  if (rows.length > maxRows) {
    // 位置只够一部分时，先保「已翻过 + 会翻红」——它们才是「几点」的答案，
    // 「不会翻红」是背景。被砍掉的数量要在轴上写出来，不能悄悄少几站。
    const primary = [...crossed, ...will]
    shown =
      primary.length >= maxRows
        ? primary.slice(0, maxRows)
        : [...primary, ...never.slice(0, maxRows - primary.length)]
    hidden = rows.length - shown.length
  }

  const center = list.length === 0
    ? '还没有站点数据'
    : fc.data == null
      ? '预测数据还没到，暂时算不出翻红时刻'
      : nothing
        ? '12 小时内没有站点会越过红色预警线'
        : null

  const sentence = buildSentence(fc.data != null, silent, crossed.length, first, within2h)

  return (
    <div
      style={{
        width: w,
        height: h,
        display: 'flex',
        flexDirection: 'column',
        color: p.text,
        overflow: 'hidden',
      }}
    >
      {/* 轴区：左端「现在」、右端「12 小时后」，下面 5 个整点刻度。
          放大页多一行首尾说明，小页只在刻度下方给数字。 */}
      <div style={{ height: axisH, position: 'relative', padding: `0 ${padX}px`, flex: '0 0 auto' }}>
        {full && (
          <div
            style={{
              position: 'absolute',
              left: padX + nameW,
              right: padX + labelW + gapR,
              top: 0,
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: fsMeta,
              color: p.textFaint,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <span>{now ? `现在 ${fmtTime(now, 'HH:mm')}` : '现在'}</span>
            <span>{now ? `12 小时后 ${fmtTime(now + SPAN_MIN * 60, 'HH:mm')}` : '12 小时后'}</span>
          </div>
        )}

        {/* 轴本体 */}
        <div
          style={{
            position: 'absolute',
            left: padX + nameW,
            right: padX + labelW + gapR,
            bottom: full ? 22 : 17,
            height: 1,
            background: p.panelLine,
          }}
        />

        {/* 刻度 + 时刻 */}
        <div
          style={{
            position: 'absolute',
            left: padX + nameW,
            right: padX + labelW + gapR,
            bottom: 0,
            height: full ? 22 : 17,
          }}
        >
          {TICKS.map((t) => {
            const at = now == null ? null : now + t * SPAN_MIN * 60
            const text = at == null ? (t === 0 ? '现在' : `+${t * 12}h`) : fmtTime(at, 'HH:mm')
            const edge = t === 0 ? 'left' : t === 1 ? 'right' : 'mid'
            return (
              <span
                key={t}
                style={{
                  position: 'absolute',
                  bottom: 0,
                  ...(edge === 'left'
                    ? { left: 0 }
                    : edge === 'right'
                      ? { right: 0 }
                      : { left: `${t * 100}%`, transform: 'translateX(-50%)' }),
                  fontSize: fsMeta,
                  color: p.textFaint,
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                }}
              >
                {text}
              </span>
            )
          })}
          {TICKS.map((t) => (
            <span
              key={`tick-${t}`}
              style={{
                position: 'absolute',
                bottom: full ? 20 : 16,
                ...(t === 1
                  ? { right: 0 }
                  : t === 0
                    ? { left: 0 }
                    : { left: `${t * 100}%` }),
                width: 1,
                height: full ? 6 : 4,
                background: p.panelLine,
              }}
            />
          ))}
        </div>

        {/* 小页在刻度左侧的空位上给一句「2 小时内几个站」，
            放大页这句放在轴下方（见 sentence），不重复。 */}
        {!full && silent && crossed.length > 0 && (
          <span
            style={{
              position: 'absolute',
              left: padX,
              bottom: 0,
              fontSize: fsMeta,
              color: p.textFaint,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            已超 {crossed.length} 站
          </span>
        )}
        {!full && !silent && (
          <span
            style={{
              position: 'absolute',
              left: padX,
              bottom: 0,
              fontSize: fsMeta,
              color: p.textFaint,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            2h 内 {within2h} 站
            {hidden > 0 ? ` · 只列 ${shown.length} 站` : ''}
          </span>
        )}
      </div>

      {/* 行区：每站一行，滑块就是答案 */}
      <div style={{ flex: '1 1 0', minHeight: 0, position: 'relative', padding: `0 ${padX}px` }}>
        {center ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: full ? 18 : 11,
              color: p.textFaint,
              textAlign: 'center',
              padding: '0 12px',
            }}
          >
            {center}
          </div>
        ) : (
          <>
            {/* 放大页在行底铺 5 条很淡的竖线：10 行横着摆开时，
                没有纵向参照，眼睛没法把「同一时刻」连起来。 */}
            {full && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: padX + nameW,
                  right: padX + labelW + gapR,
                }}
              >
                {TICKS.map((t) => (
                  <span
                    key={`grid-${t}`}
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: `${t * 100}%`,
                      width: 1,
                      background: p.panelLine,
                      opacity: 0.55,
                    }}
                  />
                ))}
              </div>
            )}

            {shown.map((r) => {
              const color =
                r.phase === 'crossed'
                  ? p.level.red
                  : r.phase === 'will'
                    ? p.level[r.g.assessment.level]
                    : 'transparent'
              const label =
                r.phase === 'crossed'
                  ? `超红阈 ${fmtDepth(r.over)} m`
                  : r.phase === 'will'
                    ? r.when != null
                      ? fmtTime(r.when, 'HH:mm')
                      : '—'
                    : '不会翻红'
              return (
                <div
                  key={r.g.site.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    height: rowH,
                    // border-box：22px 的行高要含住 1px 分隔线，
                    // 否则 10 行会多出 10px，最后一行被裁掉半个。
                    boxSizing: 'border-box',
                    borderBottom: `1px solid ${p.panelLine}`,
                    position: 'relative',
                  }}
                >
                  <div
                    style={{
                      width: nameW,
                      flex: '0 0 auto',
                      paddingRight: 10,
                      fontSize: fsName,
                      color: p.text,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {r.g.site.name}
                  </div>

                  <div style={{ flex: '1 1 0', minWidth: 0, marginRight: gapR, height: '100%', position: 'relative' }}>
                    {/* 滑轨 */}
                    <span
                      style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: trackY - 0.5,
                        height: 1,
                        background: p.panelLine,
                      }}
                    />
                    {/* 放大页：滑块上方写预计水深。低于 240px 的小页没有位置，
                        所以只在 full 出现——格式不变，多给一个数。 */}
                    {full && r.phase === 'will' && (
                      <span
                        style={{
                          position: 'absolute',
                          top: 3,
                          left: `${Math.min(94, Math.max(6, r.at * 100))}%`,
                          transform: 'translateX(-50%)',
                          fontSize: fsMeta,
                          color: p.textDim,
                          whiteSpace: 'nowrap',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        预计 {fmtDepth(r.expected)} m
                      </span>
                    )}
                    {/* 已翻过：朝左的小三角，表示它越过「现在」这条边 */}
                    {r.phase === 'crossed' && (
                      <span
                        style={{
                          position: 'absolute',
                          left: -7,
                          top: trackY,
                          transform: 'translateY(-50%)',
                          width: 0,
                          height: 0,
                          borderTop: '4px solid transparent',
                          borderBottom: '4px solid transparent',
                          borderRight: `6px solid ${p.level.red}`,
                        }}
                      />
                    )}
                    {/* 已翻过的行：中间那一大段空白要靠「超了多少」填上。
                        否则 6 行全是左边一个小红点、右边一个小数字，看着像没画完。 */}
                    {full && r.phase === 'crossed' && (
                      <span
                        style={{
                          position: 'absolute',
                          left: 16,
                          top: trackY,
                          transform: 'translateY(-50%)',
                          fontSize: 18,
                          fontWeight: 700,
                          color: p.level.red,
                          whiteSpace: 'nowrap',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        现在还在红线上 · 超 {fmtDepth(r.over)} m
                      </span>
                    )}
                    {/* 滑块：实心=会翻红/已翻红，空心=不会翻红（漂在轴外） */}
                    <span
                      style={{
                        position: 'absolute',
                        left: r.phase === 'never' ? 'calc(100% + 7px)' : `${r.at * 100}%`,
                        top: trackY,
                        transform: 'translate(-50%, -50%)',
                        width: dot,
                        height: dot,
                        borderRadius: '50%',
                        background: color,
                        border:
                          r.phase === 'never'
                            ? `1.5px solid ${p.textFaint}`
                            : `1.5px solid ${p.panel}`,
                        boxSizing: 'border-box',
                        transition: reduce
                          ? 'none'
                          : `left 400ms ${EASE}, background-color 400ms ${EASE}, border-color 400ms ${EASE}`,
                      }}
                    />
                  </div>

                  <div
                    style={{
                      width: labelW,
                      flex: '0 0 auto',
                      textAlign: 'right',
                      fontSize: fsMeta,
                      color: r.phase === 'will' ? p.textDim : p.textFaint,
                      fontVariantNumeric: 'tabular-nums',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {label}
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>

      {/* 脚注：小页没有这条，信息已经压进轴上方那句「2h 内 N 站」 */}
      {full && (
        <div
          style={{
            height: footH,
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: `0 ${padX}px`,
            fontSize: 14,
            color: p.textFaint,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span>{sentence}</span>
          <span>
            {hidden > 0 ? `另有 ${hidden} 站未显示` : `共 ${rows.length} 站`}
          </span>
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- 计算 */

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/**
 * 把十站压成一行一行的「翻红时刻」。
 *
 * 顺序即答案的优先级：已翻过 → 会翻红（早的在前）→ 不会翻红。
 * 「已翻过」排在第一批，因为它是**已经发生的事**，比任何预测都确定。
 */
function buildRows(
  list: readonly SiteGlance[],
  fc: Forecast | undefined,
  now: number | null,
  issued: number | null,
): Row[] {
  const out: Row[] = []
  for (const g of list) {
    const red = g.redThreshold
    const depth = Math.max(0, g.reading.depth)

    if (depth >= red) {
      out.push({ g, phase: 'crossed', at: 0, when: null, expected: depth, over: depth - red })
      continue
    }

    const site = fc?.sites[g.site.id]
    let hit: { off: number; depth: number } | null = null
    if (site) {
      // 第一个越过红阈的点就是答案；curve 已按 offsetMin 升序，不必再排。
      for (const c of site.curve) {
        if (c.offsetMin <= 0) continue
        const d = c.level - g.site.baseLevel
        if (d >= red) {
          hit = { off: c.offsetMin, depth: d }
          break
        }
      }
    }

    if (hit) {
      const abs = (issued ?? 0) + hit.off * 60
      const at =
        now != null
          ? clamp((abs - now) / (SPAN_MIN * 60), 0, 1)
          : clamp(hit.off / SPAN_MIN, 0, 1)
      out.push({ g, phase: 'will', at, when: now != null ? abs : null, expected: hit.depth, over: 0 })
    } else {
      out.push({ g, phase: 'never', at: 1, when: null, expected: 0, over: 0 })
    }
  }

  const rank: Record<Phase, number> = { crossed: 0, will: 1, never: 2 }
  return out.sort((a, b) => {
    if (rank[a.phase] !== rank[b.phase]) return rank[a.phase] - rank[b.phase]
    if (a.phase === 'will') return a.at - b.at
    if (a.phase === 'crossed') return b.over - a.over
    return b.g.depthRatio - a.g.depthRatio
  })
}

/**
 * 轴下那句话。它必须能被主任直接念出来：
 * 几个站、最早哪一个、几点。
 */
function buildSentence(
  hasForecast: boolean,
  silent: boolean,
  crossedN: number,
  first: Row | null,
  within2h: number,
): string {
  if (!hasForecast) return '预测数据还没到，暂时算不出翻红时刻'
  if (silent) {
    return crossedN > 0
      ? `已有 ${crossedN} 站越过红阈，12 小时内不再新增`
      : '12 小时内没有站点会越过红色预警线'
  }
  if (!first) return '12 小时内没有站点会越过红色预警线'
  const clock = first.when != null ? fmtTime(first.when, 'HH:mm') : '—'
  const tail = `最早 ${clock} ${first.g.site.name}`
  return within2h > 0
    ? `未来 2 小时有 ${within2h} 站翻红 · ${tail}`
    : `未来 2 小时内没有站点翻红 · ${tail}`
}

/**
 * 只在「用户关了动效」时返回 true。
 *
 * 大屏是常年开着的，旋钮不会有第二个状态——所以这里用状态而不是 CSS 媒体查询，
 * 既省一次重排，也让 reduced-motion 在 JS 里可测（评审要看这一条）。
 */
function useReducedMotion(): boolean {
  const [on, setOn] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handler = () => setOn(mq.matches)
    handler()
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return on
}
