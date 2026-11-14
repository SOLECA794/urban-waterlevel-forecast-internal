import { useEffect, useMemo, useRef, useState } from 'react'
import { useAlerts, useAllHistory, useForecast } from '../../data/queries'
import { useSituation } from '../../view/useSituation'
import { useWatchlist } from '../../view/useWatchlist'
import { useMapStations } from '../../view/useMapPoints'
import { RealMap } from '../../map/RealMap'
import {
  LEVEL_LABEL,
  STATE_LABEL,
  depthOf,
  fmtClock,
  fmtDepth,
  fmtPct,
  fmtRain,
  fmtTime,
  type Level,
  type Meters,
  type SiteSeries,
} from '../../domain'
import { Block, Figure, Nothing, Pill, Ruler, Shimmer } from '../kit'
import { W, ease } from '../visual'
import type { StageCtx } from '../ctx'

/**
 * 舞台九：大厅大屏。
 *
 * 这是同一个工作台的**无人值守形态**：挂在走廊上、或者会议室那台常亮的显示器上，
 * 路过的人抬头看一眼就得知道「现在要紧不要紧、哪儿最要紧」。
 *
 * 因此它和另外八个舞台有一条根本不同的规则：**不交互**。
 * 没有人会站在屏幕前点选，鼠标悬停也不存在；任何「点开看详情」的入口在大厅里
 * 都是无效负担——它只会让画面留一块提示文字，而没人去满足它。
 * 唯一的例外是右上角那个「回到工作台」：有人从 /w 打开大屏后必须能走回来，
 * 否则这一屏就是个陷阱（没有导航，退不出去）。
 *
 * 视觉上的焦点轮换（地图 / 走势 / 排行，每 15 秒）替代了交互：
 * 三块内容始终都在，轮换只是**加深当前这一块的对比度**，不是切换页面。
 * 这样即使有人刚抬头时错过了某一块，它 30 秒后还会再亮一次——
 * 而如果我把它做成翻页，错过就是彻底错过。
 *
 * 大屏原本有一份 2400 行的实现（board/BoardPage），它自带 scenes/layout/presets
 * 一套编排系统。这里刻意不复用它：那一套是为「导演一部片子」写的，
 * 而这一屏要的只是「把四个已有的数字块摆稳」。复制它会把 2400 行里
 * 与轮播时机无关的耦合一起搬进来，改一个像素都要读懂整台机器。
 */

/** 三块内容轮着加深，而不是轮着出现。 */
type Focus = 'map' | 'trend' | 'rank'

const FOCUS_ORDER: readonly Focus[] = ['map', 'trend', 'rank']
const FOCUS_LABEL: Record<Focus, string> = {
  map: '地图',
  trend: '走势',
  rank: '排行',
}
const FOCUS_MS = 15_000

export function WallStage({ ctx }: { ctx: StageCtx }) {
  const sit = useSituation()
  const list = useWatchlist('level')
  const fc = useForecast()
  const stations = useMapStations()
  const hist = useAllHistory(6)
  const alerts = useAlerts(true)
  const reduce = useReducedMotion()
  const [focus, setFocus] = useState<Focus>('map')

  // 轮换本身是「换焦点」，不是「换内容」：三块都留在屏幕上，
  // 只有对比度变。所以这里只动一个 state，不需要任何动画库。
  //
  // 减动效偏好下**整个轮换都不启动**，不是只把 transition 关掉：焦点一直在变
  // 但对比度不变，会让某两块永远停在 0.46 透明度上——那是把「减少动画」
  // 做成了「永久变灰」。这一屏的正确降级是「三块一样亮、不再自己动」。
  useEffect(() => {
    if (reduce) return
    const id = window.setInterval(() => {
      setFocus((f) => FOCUS_ORDER[(FOCUS_ORDER.indexOf(f) + 1) % FOCUS_ORDER.length])
    }, FOCUS_MS)
    // 卸载必须清掉：大屏这一屏常年开着，漏一个 interval 就是几十个定时器堆在后台。
    return () => window.clearInterval(id)
  }, [reduce])

  const alertsNow = alerts.data ?? []
  const histMap = hist.data ?? {}

  if (!sit.hasData) {
    return (
      <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex' }}>
        <Block title="大厅大屏" grow>
          {list.length === 0 ? (
            <Nothing
              why="还没有任何实测数据"
              hint="大屏不会显示占位图表——空的坐标轴比没有图更让人误判。等数据源恢复后这一屏会自己亮起来，不需要人去刷新。"
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Shimmer h={220} />
              <Shimmer h={14} w="55%" />
            </div>
          )}
        </Block>
      </div>
    )
  }

  return (
    <div
      style={{
        flex: '1 1 0',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* 出口单独占一行，而不是浮在右上角：浮起来会盖住「等级分布」那一格的
          标题与焦点标，而那一格恰好是轮换时会亮起来的三块之一。
          它也不进 grid，所以永远不会参与轮换（一个会淡出的出口等于没有出口）。 */}
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10.5, color: W.ink4, letterSpacing: 0.4 }}>
          无人值守形态 · 不点选、不弹层
        </span>
        <span style={{ fontSize: 10.5, color: W.ink3 }}>
          {reduce ? '已按系统偏好停用自动轮换' : `每 15 秒换一次焦点（当前 ${FOCUS_LABEL[focus]}，三块始终可见）`}
        </span>
        <button
          type="button"
          onClick={() => ctx.goStage({ kind: 'situation' })}
          title="这一屏没有导航与标签栏，这是回到可操作界面的唯一出口"
          style={{
            marginLeft: 'auto',
            flex: '0 0 auto',
            padding: '4px 11px',
            borderRadius: 6,
            border: `1px solid ${W.lineStrong}`,
            background: W.stage,
            color: W.ink2,
            fontSize: 11,
            fontWeight: 600,
            font: 'inherit',
            cursor: 'pointer',
          }}
        >
          ← 回到工作台
        </button>
      </div>
      <div
        style={{
          flex: '1 1 0',
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(400px, 1.55fr) minmax(300px, 1fr)',
          gridTemplateRows: 'minmax(0, 1.5fr) minmax(0, 1fr) auto',
          gap: 12,
        }}
      >
        {/* 左上：地图占两行。它是这一屏唯一的「哪里」，所以面积最大。 */}
        <div
          style={{
            gridColumn: '1',
            gridRow: '1 / 3',
            minHeight: 0,
            display: 'flex',
            ...dim(focus === 'map', reduce),
          }}
        >
          <Block
            title="一张图"
            sub={`${sit.total} 个站点 · 气泡大小 = 积水深 · 本轮焦点`}
            aside={
              <Pill tone={focus === 'map' ? W.accent : W.ink4} fill={focus === 'map'}>
                地图
              </Pill>
            }
            grow
            pad={0}
          >
            <div style={{ flex: '1 1 0', minHeight: 0, position: 'relative' }}>
              {/* interactive={false}：滚轮、拖拽、双击缩放全部锁住。
                  大厅里没有人在操作它，一次误触却会把地图拖到看不见城市的角落，
                  然后一直停在那里——直到有人专门去修。 */}
              <RealMap stations={stations} interactive={false} height="100%" fitKey={`wall-${stations.length}`} />
            </div>
            <div
              style={{
                flex: '0 0 auto',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '7px 10px',
                borderTop: `1px solid ${W.lineSoft}`,
                fontSize: 10.5,
                color: W.ink3,
                flexWrap: 'wrap',
              }}
            >
              {(['blue', 'yellow', 'orange', 'red'] as const).map((lv) => (
                <span key={lv} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      background: W.level[lv],
                      display: 'inline-block',
                    }}
                  />
                  {LEVEL_LABEL[lv]}
                </span>
              ))}
              {/* 最深处点名：走过的人不会去读分布，但会记住「XX 桥 0.62m」。 */}
              <span style={{ marginLeft: 'auto', color: W.ink2 }}>
                最深 {sit.deepest.siteName} {fmtDepth(sit.deepest.value)}m
              </span>
            </div>
          </Block>
        </div>

        {/* 右上：等级分布。回答「几个站在报警」。 */}
        <div style={{ gridColumn: '2', gridRow: '1', minHeight: 0, display: 'flex', ...dim(focus === 'rank', reduce) }}>
          <Block
            title="等级分布"
            sub="五档各几个站"
            aside={
              <Pill tone={focus === 'rank' ? W.accent : W.ink4} fill={focus === 'rank'}>
                排行
              </Pill>
            }
            grow
            pad={10}
          >
            <div
              style={{
                flex: '1 1 0',
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                gap: 7,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
                <Figure
                  value={sit.alarmCount}
                  unit="站"
                  label="处于任一预警档"
                  size={28}
                  tone={sit.alarmCount > 0 ? W.levelInk[sit.topLevel] : W.ok}
                  hint={`全域最高：${LEVEL_LABEL[sit.topLevel]}`}
                />
                <Figure
                  value={sit.rainingSites}
                  unit="站"
                  label="正在降雨"
                  size={20}
                  tone={W.ink2}
                  hint={`共 ${sit.total} 站`}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {sit.counts
                  .slice()
                  .reverse()
                  .map((c) => {
                    const pct = sit.total > 0 ? c.count / sit.total : 0
                    return (
                      <div key={c.level} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span
                          style={{
                            width: 34,
                            fontSize: 10.5,
                            color: c.count > 0 ? W.levelInk[c.level] : W.ink4,
                            flex: '0 0 auto',
                          }}
                        >
                          {LEVEL_LABEL[c.level]}
                        </span>
                        <span style={{ flex: '1 1 0', minWidth: 30 }}>
                          <Ruler ratio={pct} color={W.level[c.level]} height={8} />
                        </span>
                        <span
                          style={{
                            width: 18,
                            textAlign: 'right',
                            fontSize: 13,
                            fontWeight: 600,
                            fontFamily: W.mono,
                            fontVariantNumeric: 'tabular-nums',
                            color: c.count > 0 ? W.ink : W.ink4,
                          }}
                        >
                          {c.count}
                        </span>
                      </div>
                    )
                  })}
              </div>
            </div>
          </Block>
        </div>

        {/* 右下：十站六小时走势。回答「谁在涨」。 */}
        <div style={{ gridColumn: '2', gridRow: '2', minHeight: 0, display: 'flex', ...dim(focus === 'trend', reduce) }}>
          <Block
            title="十站六小时走势"
            sub="每站一条自己的刻度"
            aside={
              <Pill tone={focus === 'trend' ? W.accent : W.ink4} fill={focus === 'trend'}>
                走势
              </Pill>
            }
            grow
            pad={0}
          >
            <div style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', padding: '6px 10px' }}>
              {list.map((g) => (
                <TrendRow
                  key={g.site.id}
                  name={g.site.name}
                  level={g.assessment.level}
                  now={g.reading.depth}
                  red={g.redThreshold}
                  series={histMap[g.site.id] ?? null}
                  base={g.site.baseLevel}
                  peak6h={peak6h(fc.data?.sites[g.site.id]?.curve, g.site.baseLevel)}
                  raining={g.raining}
                  rain={g.reading.rain}
                />
              ))}
            </div>
          </Block>
        </div>

        {/* 底部：最近预警，一条横向滚动带。
            不做成列表是因为它只回答一个时间顺序问题：「刚刚发生了什么」。
            也没有任何点击——大厅里没有人会回来确认他点到了哪一条。 */}
        <div
          style={{
            gridColumn: '1 / 3',
            gridRow: '3',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '0 2px' }}>
            <span style={{ fontSize: 10.5, color: W.ink4, letterSpacing: 0.4 }}>最近预警</span>
            <span style={{ fontSize: 10, color: W.ink4 }}>
              {alertsNow.length > 0 ? `${alertsNow.length} 条仍在激活` : '当前没有激活的预警'}
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: W.ink4 }}>
              {sit.issuedAt ? `数据截至 ${fmtClock(sit.issuedAt)}` : '—'}
            </span>
          </div>
          <AlertTicker alerts={alertsNow} reduce={reduce} />
        </div>

      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 走势行

/**
 * 一行 = 一个站六小时的形状。
 *
 * 每站用**自己的**纵轴（min→max 之间），并在旁边标出占红阈的比例。
 * 统一纵轴会让浅站被压成一条直线、深站占满整格——那是量程的错觉。
 * 所以这里只给「形状 + 当前值 + 占红阈」三件事，不给「谁比谁高」。
 */
function TrendRow({
  name,
  level,
  now,
  red,
  series,
  base,
  peak6h,
  raining,
  rain,
}: {
  name: string
  level: Level
  now: number
  red: Meters
  series: SiteSeries | null
  base: Meters
  peak6h: number | null
  raining: boolean
  rain: number
}) {
  const vals = useMemo(() => {
    if (!series) return []
    return series.points.map((p) => Math.max(0, depthOf(p.level, base)))
  }, [series, base])

  const ratio = red > 0 ? now / red : 0
  const tone = level === 'none' ? W.ink3 : W.levelInk[level]

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '3px 0',
        borderBottom: `1px solid ${W.lineSoft}`,
      }}
    >
      <span
        style={{
          width: 78,
          flex: '0 0 auto',
          fontSize: 11,
          color: W.ink,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </span>
      <span style={{ width: 26, flex: '0 0 auto', fontSize: 9.5, color: tone }}>
        {LEVEL_LABEL[level]}
      </span>
      <span style={{ flex: '1 1 0', minWidth: 54 }}>
        <Spark vals={vals} color={W.level[level]} red={red} height={20} />
      </span>
      <span
        style={{
          width: 34,
          textAlign: 'right',
          flex: '0 0 auto',
          fontSize: 11,
          fontFamily: W.mono,
          fontVariantNumeric: 'tabular-nums',
          color: tone,
        }}
      >
        {fmtDepth(now)}
      </span>
      <span
        style={{
          width: 40,
          textAlign: 'right',
          flex: '0 0 auto',
          fontSize: 9.5,
          fontFamily: W.mono,
          color: ratio >= 1 ? W.bad : W.ink4,
        }}
        title="当前积水深占本站红阈的比例"
      >
        {fmtPct(ratio, 0)}
      </span>
      <span
        style={{
          width: 46,
          textAlign: 'right',
          flex: '0 0 auto',
          fontSize: 9.5,
          fontFamily: W.mono,
          color: raining ? W.levelInk.blue : W.ink4,
        }}
        title={peak6h === null ? '这一轮的预测里还没有这个站的曲线' : '预见期内峰值水深'}
      >
        {raining ? `${fmtRain(rain)}mm` : peak6h === null ? '—' : `↑${fmtDepth(peak6h)}`}
      </span>
    </div>
  )
}

/**
 * 自绘 sparkline。
 *
 * 没用 `components/primitives/Sparkline`：那个组件的纵轴只按数据 min/max 归一，
 * 画不出「离红阈还有多远」这件事，而大屏上这一行最要紧的正是这个距离。
 * 这里把红阈也纳入量程，于是「曲线贴近虚线」本身就是一条结论。
 */
function Spark({
  vals,
  color,
  red,
  height,
}: {
  vals: readonly number[]
  color: string
  red: number
  height: number
}) {
  const W0 = 100
  const H0 = 24
  const model = useMemo(() => {
    if (vals.length < 2) return null
    const hi = Math.max(...vals, red * 0.98, 0.02)
    const lo = Math.min(...vals, 0)
    const span = hi - lo || 1e-6
    const pts = vals.map((v, i) => {
      const x = (i / (vals.length - 1)) * W0
      const y = H0 - 2 - ((v - lo) / span) * (H0 - 4)
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    const redY = H0 - 2 - ((red - lo) / span) * (H0 - 4)
    return { pts: pts.join(' '), redY }
  }, [vals, red])

  if (!model) return <div style={{ height }} />
  return (
    <svg
      viewBox={`0 0 ${W0} ${H0}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height, display: 'block' }}
      aria-hidden="true"
    >
      {model.redY > 0 && model.redY < H0 && (
        <line
          x1="0"
          x2={W0}
          y1={model.redY}
          y2={model.redY}
          stroke={W.level.red}
          strokeOpacity="0.5"
          strokeWidth="0.8"
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <polyline
        points={model.pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

// ---------------------------------------------------------------- 预警滚动带

function AlertTicker({
  alerts,
  reduce,
}: {
  alerts: readonly { id: number; siteName: string; level: Level; state: keyof typeof STATE_LABEL; raisedAt: number }[]
  reduce: boolean
}) {
  const ref = useRef<HTMLDivElement | null>(null)

  // 滚动是「让站着的人不必等」。减动效偏好下直接停住——横带本身仍可手拖，
  // 但不再自己动；对前庭神经敏感的人，一条自己爬行的横带是持续干扰。
  useEffect(() => {
    if (reduce) return
    const el = ref.current
    if (!el) return
    const id = window.setInterval(() => {
      const max = el.scrollWidth - el.clientWidth
      if (max <= 4) return
      el.scrollLeft = el.scrollLeft >= max - 4 ? 0 : el.scrollLeft + 200
    }, 5000)
    return () => window.clearInterval(id)
  }, [reduce, alerts.length])

  if (alerts.length === 0) {
    return (
      <div
        style={{
          border: `1px solid ${W.line}`,
          borderRadius: 8,
          padding: '9px 11px',
          fontSize: 11,
          color: W.ink3,
          background: W.rail,
        }}
      >
        这一刻没有激活的预警。大屏保持常亮是因为「没有消息」本身就是要给人看的消息。
      </div>
    )
  }

  const sorted = alerts.slice().sort((a, b) => b.raisedAt - a.raisedAt).slice(0, 12)

  return (
    <div
      ref={ref}
      style={{
        display: 'flex',
        gap: 8,
        overflowX: 'auto',
        overflowY: 'hidden',
        paddingBottom: 2,
        scrollbarWidth: 'thin',
      }}
    >
      {sorted.map((a) => (
        <div
          key={a.id}
          style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 9px',
            border: `1px solid ${W.line}`,
            borderRadius: 7,
            background: W.levelWash[a.level],
            whiteSpace: 'nowrap',
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              background: W.level[a.level],
              display: 'inline-block',
            }}
          />
          <span style={{ fontSize: 11.5, fontWeight: 600, color: W.ink }}>{a.siteName}</span>
          <span style={{ fontSize: 10.5, color: W.levelInk[a.level] }}>{LEVEL_LABEL[a.level]}</span>
          <span style={{ fontSize: 10, color: W.ink3 }}>{STATE_LABEL[a.state]}</span>
          <span style={{ fontSize: 10, color: W.ink4, fontFamily: W.mono }}>
            {fmtTime(a.raisedAt, 'MM-DD HH:mm')}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- 工具

/**
 * 焦点态只是对比度差，不是位移。位移会让大屏看起来在「翻页」。
 *
 * `reduce` 时不压暗也不过渡：见上面轮换那段——半透明的常驻内容对
 * 前庭敏感的人是干扰，而这三位信息本来就都该看得见。
 */
function dim(on: boolean, reduce: boolean) {
  if (reduce) return { opacity: 1 } as const
  return {
    opacity: on ? 1 : 0.46,
    transition: `opacity 320ms ${ease}`,
  } as const
}

/** 减动效偏好。global.css 里也有全局覆盖，但那管不到 JS 里的定时滚动，
 *  所以这里读一次媒体查询，自己决定要不要动。 */
function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduce(mq.matches)
    const on = () => setReduce(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduce
}

/** 预见期内的峰值水深。曲线缺失时返回 null——「没有预测」和「预测是 0」不是一回事。 */
function peak6h(
  curve: readonly { level: number }[] | undefined,
  base: Meters,
): number | null {
  if (!curve || curve.length === 0) return null
  let peak = 0
  for (const p of curve) {
    const d = p.level - base
    if (d > peak) peak = d
  }
  return peak
}
