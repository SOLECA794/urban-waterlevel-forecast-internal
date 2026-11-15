import { useMemo } from 'react'
import { useAllHistory, useForecast, useOverview } from '../../data/queries'
import { useWatchlist, type SiteGlance } from '../../view/useWatchlist'
import { useSituation } from '../../view/useSituation'
import { RealMap } from '../../map/RealMap'
import { useMapStations } from '../../view/useMapPoints'
import {
  ALARM_LEVELS,
  HORIZONS,
  LEVEL_LABEL,
  LEVEL_RANK,
  LEVEL_SHORT,
  fmtTime,
  horizonLabel,
  type Level,
  type SiteForecast,
  type SiteSeries,
} from '../../domain'
import { Block, Figure, Nothing, Pill, Ruler, Shimmer } from '../kit'
import { W, ease } from '../visual'
import type { StageCtx } from '../ctx'

/**
 * 舞台一：全域态势。
 *
 * 这是这一屏的默认状态——没有人选中任何对象时看到的东西。
 * 它要回答一个问题：现在该看哪里。
 *
 * 版面是「两列三带」，每一块只回答一个问题，答案全部由数据算出来：
 *
 *   上带左：一张图        —— 哪里（气泡半径 = 水深，颜色 = 等级）
 *   上带右：此刻最严重    —— 哪个站、多深、离红阈还差多少
 *   上带右：等级构成      —— 全城分成几档，哪一档最多
 *   中带左：三小时走向    —— 峰值会落在哪一档预见期
 *   中带右：街道分化      —— 哪条街道最该先派人
 *   底带：  城市雨情      —— 雨还在下吗、下了多少、什么时候最大
 *
 * 地图仍是选中的入口：点任何气泡都会让整个舞台变成那个站的详情，
 * 左边的列表同步高亮——用户因此永远知道「我点的是哪一个」。
 */
export function SituationStage({ ctx }: { ctx: StageCtx }) {
  const sit = useSituation()
  const ov = useOverview()
  const fc = useForecast()
  const list = useWatchlist('level')
  const stations = useMapStations()
  const hist = useAllHistory(6)

  const worst = list[0] ?? null

  // 每一站的峰值落在哪一档预见期（60/180/360/720 分钟里最近的那个）。
  // 这块只用来给标题和行内标签提供一句话，不参与任何阈值判定。
  const peakLabels = useMemo(() => {
    const out = new Map<string, string>()
    for (const g of list) {
      const label = peakHorizonOf(fc.data?.sites[g.site.id])
      if (label) out.set(g.site.id, label)
    }
    return out
  }, [list, fc.data])

  // 「峰值多落在哪一档」：标题要说得出一句话，就必须先有一个多数。
  const peakTop = useMemo(() => {
    const tally = new Map<string, number>()
    for (const label of peakLabels.values()) tally.set(label, (tally.get(label) ?? 0) + 1)
    let top: { label: string; n: number } | null = null
    for (const [label, n] of tally) if (!top || n > top.n) top = { label, n }
    return { top, total: peakLabels.size }
  }, [peakLabels])

  const districts = useMemo(() => rollupDistricts(list), [list])
  // 一把尺子量到底：十站走向与街道分化共用同一个水深量程。
  // 各用各的量程会让每一根条都接近满格——条长只表达「和自己比」，读不出谁比谁深。
  const depthScale = useMemo(() => {
    let m = 0.06
    for (const g of list) {
      m = Math.max(
        m,
        (g.redThreshold || 0.5) * 1.15,
        Math.max(0, g.reading.depth) * 1.05,
        Math.max(0, g.assessment.peakValue) * 1.05,
      )
    }
    for (const d of districts) m = Math.max(m, d.red * 1.15, d.deepest * 1.05)
    return m
  }, [list, districts])
  const rain = useMemo(() => cityRain(hist.data), [hist.data])

  if (!sit.hasData) {
    return (
      <div style={{ flex: '1 1 0', display: 'flex', minHeight: 0 }}>
        <Block title="全域态势" grow>
          {ov.isLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Shimmer h={260} />
              <Shimmer h={14} w="60%" />
            </div>
          ) : (
            <Nothing
              why="还没有拿到实测数据"
              hint="顶栏的链路指示能告诉你是哪一层断了——数据源、引擎、还是这条浏览器连接。"
            />
          )}
        </Block>
      </div>
    )
  }

  const top = peakTop.top

  return (
    <div
      style={{
        flex: '1 1 0',
        minHeight: 0,
        minWidth: 0,
        display: 'grid',
        // 两列：左边给地图（最大的一块），右边给「结论 + 构成」。
        // 两列都用 minmax(0, …) 而不是固定下限：1280 宽下舞台只有约 560px，
        // 任何像素下限都会把这一屏顶出横向滚动条。
        gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)',
        // 三带：图/结论 → 走向/街道 → 通栏雨情。底带定高 146，其余按比例分，
        // 这样窗口变高时只有地图和两个列表会长，雨情图不会跟着拉成一条竖线。
        gridTemplateRows: 'minmax(0, 1.86fr) minmax(0, 1.08fr) 146px',
        gap: 12,
        padding: 12,
      }}
    >
      {/* 数据每 30 秒刷一轮。这个呼吸点是把「它在动」变成看得见的东西：
          数字可能只变一点点，但值班员需要知道这一屏是活的。
          只动透明度，不发光、不引入任何新颜色。 */}
      <style>{`
        @keyframes sit-live { 0%, 100% { opacity: .22 } 50% { opacity: 1 } }
        .sit-live-dot { animation: sit-live 2.4s ease-in-out infinite }
        @media (prefers-reduced-motion: reduce) { .sit-live-dot { animation: none; opacity: .55 } }
      `}</style>

      {/* ---------------------------------------------- 1 地图：回答「哪里」 */}
      <div
        data-tour="wb-map"
        style={{ minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}
      >
        <Block
          title="一张图"
          sub={`${sit.total} 个站点`}
          aside={
            <span
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: W.ink4 }}
            >
              <span
                className="sit-live-dot"
                style={{ width: 6, height: 6, borderRadius: 3, background: W.accent, display: 'inline-block' }}
              />
              {fmtTime(sit.issuedAt, 'HH:mm')} 更新
            </span>
          }
          grow
          pad={0}
        >
          <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: '1 1 0', minHeight: 0, position: 'relative' }}>
              <RealMap
                stations={stations}
                onPick={(id) => ctx.goStage({ kind: 'site', siteId: id })}
                height="100%"
                fitKey={`overview-${stations.length}`}
              />
            </div>
            {/* 图例不是装饰：颜色与半径这两套编码必须写出来，
                否则用户只能靠猜（而猜错一次之后就不再相信这张图了）。 */}
            <div
              style={{
                flex: '0 0 auto',
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                padding: '7px 10px',
                borderTop: `1px solid ${W.lineSoft}`,
                fontSize: 10.5,
                color: W.ink3,
                flexWrap: 'wrap',
              }}
            >
              {ALARM_LEVELS.map((lv) => (
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
              <span style={{ marginLeft: 'auto', color: W.ink4, whiteSpace: 'nowrap' }}>
                气泡半径 = 水深
              </span>
            </div>
          </div>
        </Block>
      </div>

      {/* ---------------------------- 右列上：2 最严重 + 3 等级构成 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, minWidth: 0 }}>
        {/* 2 此刻最严重：回答「现在哪一个站最该派人去」。
            站名 + 等级 + 一个能读的大数字 + 离四个阈值各有多远。 */}
        {worst ? (
          <WorstBlock g={worst} onOpen={() => ctx.goStage({ kind: 'site', siteId: worst.site.id })} />
        ) : (
          <Block title="此刻最严重" grow pad={10}>
            <Nothing why="十站里没有任何一个在报警" hint="地图上都是无预警的气泡，先把注意力放到雨情上。" />
          </Block>
        )}

        {/* 3 等级构成：回答「全城现在分成几档、哪一档最多」。
            一条按比例分段的堆叠条负责「占比」，下面五行负责「数量」。 */}
        <CompositionBlock
          counts={sit.counts}
          total={sit.total}
          onPick={(lv, count) => {
            ctx.setSort('level')
            const pct = sit.total > 0 ? ((count / sit.total) * 100).toFixed(0) : '0'
            ctx.toast('info', `左栏已按等级排序；${LEVEL_LABEL[lv]} ${count} 站，占 ${pct}%`)
          }}
        />
      </div>

      {/* ---------------------------- 中带左：5 十站三小时走向 */}
      <div
        data-tour="wb-forecast"
        style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}
      >
        <Block
          title="十站三小时走向"
          sub={
            top
              ? `峰值多在 ${top.label} 预见期 · ${top.n}/${peakTop.total} 站`
              : '还没有预测曲线，看不出峰值落在哪一档'
          }
          grow
          pad={0}
        >
          <div style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', padding: '6px 10px 12px' , maskImage: 'linear-gradient(to bottom, #000 calc(100% - 13px), transparent)', WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 13px), transparent)' }}>
            {list.map((g) => (
              <PeakBar
                key={g.site.id}
                g={g}
                scale={depthScale}
                forecast={fc.data?.sites[g.site.id] ?? null}
                horizon={peakLabels.get(g.site.id) ?? null}
                onPick={() => ctx.goStage({ kind: 'site', siteId: g.site.id })}
              />
            ))}
          </div>
        </Block>
      </div>

      {/* ---------------------------- 中带右：4 街道分化 */}
      {/* 4 街道分化：回答「按街道看，哪一片最该先派人」。
          十站太小，一条街道里往往不止一个站——把同街道的站并起来，
          取最深的那个当代表，点进去就是那一站。 */}
      <DistrictBlock
        rows={districts}
        scale={depthScale}
        onPick={(siteId) => ctx.goStage({ kind: 'site', siteId })}
      />

      {/* ---------------------------- 底带：6 城市雨情 */}
      {/* 6 城市雨情：回答「雨还在下吗、这场雨一共下了多少、什么时候最大」。
          十站雨强的均值就是城市面雨强，它解释的是「为什么这一屏在变」。 */}
      <div
        style={{
          gridColumn: '1 / 3',
          minHeight: 0,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Block
          title="城市雨情"
          sub="十站雨强均值 · 5 分钟一档 · 近 6 小时"
          aside={<span style={{ fontSize: 10.5, color: W.ink4 }}>累计按实测步长折算</span>}
          grow
          pad={0}
        >
          {rain ? (
            <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex', gap: 14, padding: '10px 12px' }}>
              <div
                style={{
                  flex: '1 1 0',
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                }}
              >
                <RainChart view={rain} />
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 9.5,
                    color: W.ink4,
                    marginTop: 4,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  <span>{fmtTime(rain.points[0].at, 'HH:mm')}</span>
                  <span>
                    {rain.points.length} 个点 · 步长 {rain.stepMin.toFixed(0)} 分钟
                  </span>
                  <span>{fmtTime(rain.points[rain.points.length - 1].at, 'HH:mm')}</span>
                </div>
              </div>
              <div
                style={{
                  flex: '0 0 168px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 7,
                  justifyContent: 'center',
                }}
              >
                <Stat
                  label="当前雨强"
                  value={rain.points[rain.points.length - 1].v.toFixed(1)}
                  unit="mm/h"
                  tone={W.accent}
                />
                <Stat label="6 小时累计雨量" value={rain.total.toFixed(1)} unit="mm" />
                <Stat
                  label="峰值时刻"
                  value={fmtTime(rain.peak.at, 'HH:mm')}
                  unit={`${rain.peak.v.toFixed(1)} mm/h`}
                />
              </div>
            </div>
          ) : hist.isError ? (
            <Nothing
              why="十站历史序列没有取到"
              hint="历史接口这一轮失败了；顶栏的链路指示能看到断在哪一层，下一轮刷新会自动重试。"
            />
          ) : hist.isLoading ? (
            <Nothing
              why="正在取十站过去 6 小时的雨强序列"
              hint="十站一次批量取回，回来之后这条曲线会立刻画出来。"
            />
          ) : (
            <Nothing
              why="十站的历史序列是空的"
              hint="接口返回了，但一个采样点都没有——通常是这一轮仿真还没把序列写进库里。"
            />
          )}
        </Block>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- 上带右 */

/**
 * 此刻最严重。
 *
 * 它要回答的不是「最深的数字是多少」，而是「离出事还差多少」——
 * 所以主视觉是那条带四个刻度的尺，数字只是它的读数。
 * 量程取红阈的 1.18 倍：红刻度不会顶到边，超阈之后那一段也还画得下。
 */
function WorstBlock({ g, onOpen }: { g: SiteGlance; onOpen: () => void }) {
  const level = g.assessment.level
  const depth = Math.max(0, g.reading.depth)
  const red = g.redThreshold
  const scale = Math.max(red * 1.18, 0.06)
  const over = depth >= red
  const marks = ALARM_LEVELS.map((lv) => ({
    at: g.site.thresholds[lv] / scale,
    color: W.level[lv],
  }))

  return (
    <Block
      title="此刻最严重"
      aside={
        <Pill tone={W.levelInk[level]} fill>
          {LEVEL_LABEL[level]}
        </Pill>
      }
      grow
      pad={10}
    >
      <div
        style={{
          flex: '1 1 0',
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 9,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: W.ink,
              lineHeight: 1.3,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {g.site.name}
          </span>
          <span
            style={{
              marginLeft: 'auto',
              flex: '0 0 auto',
              fontSize: 10,
              color: W.ink4,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 88,
            }}
          >
            {g.site.district}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
          <Figure value={depth.toFixed(2)} unit="m" label="积水深" size={34} tone={W.levelInk[level]} />
          <Figure
            value={`${(g.depthRatio * 100).toFixed(0)}%`}
            size={15}
            label="占红阈"
            tone={over ? W.levelInk.red : W.ink2}
          />
        </div>

        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 6,
              marginBottom: 5,
              fontSize: 9.5,
              color: W.ink4,
            }}
          >
            <span>四级阈值</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>量程 {scale.toFixed(2)}m</span>
            <span
              style={{
                marginLeft: 'auto',
                fontVariantNumeric: 'tabular-nums',
                color: over ? W.levelInk.red : W.ink3,
                fontWeight: over ? 600 : 400,
              }}
            >
              {over ? `已超红阈 ${(depth - red).toFixed(2)}m` : `距红阈 ${(red - depth).toFixed(2)}m`}
            </span>
          </div>
          <Ruler ratio={depth / scale} color={W.level[level]} height={8} marks={marks} />
          <div style={{ display: 'flex', gap: 4, marginTop: 5 }}>
            {ALARM_LEVELS.map((lv) => {
              const on = level === lv
              return (
                <span
                  key={lv}
                  style={{
                    flex: '1 1 0',
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 3,
                    fontSize: 9.5,
                    color: on ? W.levelInk[lv] : W.ink4,
                    fontWeight: on ? 600 : 400,
                  }}
                >
                  <span
                    style={{
                      width: 4,
                      height: 4,
                      borderRadius: 2,
                      background: W.level[lv],
                      flex: '0 0 auto',
                    }}
                  />
                  <span>{LEVEL_SHORT[lv]}</span>
                  <span style={{ fontFamily: W.mono, fontVariantNumeric: 'tabular-nums' }}>
                    {g.site.thresholds[lv].toFixed(2)}
                  </span>
                </span>
              )
            })}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <Stat
            label="当前雨强"
            value={g.reading.rain.toFixed(1)}
            unit="mm/h"
            tone={g.reading.rain >= 1 ? W.accent : W.ink2}
          />
          <Stat
            label="1h 变化"
            value={`${g.reading.trend1h > 0 ? '+' : ''}${g.reading.trend1h.toFixed(2)}`}
            unit="m"
            tone={g.reading.trend1h > 0 ? W.levelInk.orange : g.reading.trend1h < 0 ? W.ok : W.ink2}
          />
        </div>

        <button
          type="button"
          onClick={onOpen}
          style={{
            marginTop: 'auto',
            width: '100%',
            padding: '6px 0',
            fontSize: 11.5,
            color: W.stage,
            background: W.accent,
            border: 0,
            borderRadius: 5,
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          看这一站 →
        </button>
      </div>
    </Block>
  )
}

/** 等级构成：堆叠条回答「占比」，五行回答「数量」，行可点。 */
function CompositionBlock({
  counts,
  total,
  onPick,
}: {
  counts: readonly { readonly level: Level; readonly count: number }[]
  total: number
  onPick: (level: Level, count: number) => void
}) {
  const rows = counts.slice().reverse() // 红色排在最上面：先看到最严重的那一档
  const denom = Math.max(1, total)

  return (
    <Block title="等级构成" sub="点一行筛选左栏" pad={10}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div
          style={{
            display: 'flex',
            height: 10,
            borderRadius: 5,
            overflow: 'hidden',
            background: W.lineSoft,
          }}
        >
          {counts.map((c) =>
            c.count > 0 ? (
              <span
                key={c.level}
                title={`${LEVEL_LABEL[c.level]} ${c.count} 站`}
                style={{
                  width: `${(c.count / denom) * 100}%`,
                  background: W.level[c.level],
                  transition: `width 420ms ${ease}`,
                }}
              />
            ) : null,
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {rows.map((c) => {
            const pct = total > 0 ? c.count / total : 0
            return (
              <button
                key={c.level}
                type="button"
                onClick={() => onPick(c.level, c.count)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 16,
                  padding: 0,
                  border: 0,
                  background: 'transparent',
                  cursor: 'pointer',
                  font: 'inherit',
                }}
              >
                <span
                  style={{
                    width: 32,
                    flex: '0 0 auto',
                    fontSize: 10.5,
                    color: c.count > 0 ? W.levelInk[c.level] : W.ink4,
                  }}
                >
                  {LEVEL_LABEL[c.level]}
                </span>
                <span style={{ flex: '1 1 0', minWidth: 0 }}>
                  <Ruler ratio={pct} color={W.level[c.level]} height={5} />
                </span>
                <span
                  style={{
                    width: 14,
                    flex: '0 0 auto',
                    textAlign: 'right',
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: W.mono,
                    fontVariantNumeric: 'tabular-nums',
                    color: c.count > 0 ? W.ink : W.ink4,
                  }}
                >
                  {c.count}
                </span>
                <span
                  style={{
                    width: 26,
                    flex: '0 0 auto',
                    textAlign: 'right',
                    fontSize: 9.5,
                    color: W.ink4,
                    fontFamily: W.mono,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {(pct * 100).toFixed(0)}%
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </Block>
  )
}

/* ---------------------------------------------------------------- 中带右 */

/**
 * 街道分化。
 *
 * 「十站」对值班员来说太细了：他派的是街道的人。所以这里把同街道的站并起来，
 * 只留三个事实——这条街道有几站、最高到哪一档、最深受水多少，
 * 点下去直接进那条街道最深的那个站（那才是他真正要派人去的地方）。
 */
function DistrictBlock({
  rows,
  scale,
  onPick,
}: {
  rows: readonly DistrictRollup[]
  /** 和「十站走向」共用同一把水深尺子。 */
  scale: number
  onPick: (siteId: string) => void
}) {
  return (
    <Block title="街道分化" sub="点最深的一站" grow pad={0}>
      {rows.length === 0 ? (
        <Nothing why="十站都还没有街道归属" hint="站点资料里的 district 是空的，这一块就分不出街道。" />
      ) : (
        <div style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', padding: '2px 10px 12px' , maskImage: 'linear-gradient(to bottom, #000 calc(100% - 13px), transparent)', WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 13px), transparent)' }}>
          {rows.map((d) => {
            return (
              <button
                key={d.district}
                type="button"
                onClick={() => onPick(d.siteId)}
                title={`${d.district}：最深 ${d.siteName} ${d.deepest.toFixed(2)}m`}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '5px 2px',
                  border: 0,
                  borderBottom: `1px solid ${W.lineSoft}`,
                  background: 'transparent',
                  cursor: 'pointer',
                  font: 'inherit',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4, minWidth: 0 }}>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      background: W.level[d.topLevel],
                      flex: '0 0 auto',
                      alignSelf: 'center',
                    }}
                  />
                  <span
                    style={{
                      fontSize: 11.5,
                      color: W.ink,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {d.district}
                  </span>
                  <span style={{ fontSize: 9.5, color: W.ink4, flex: '0 0 auto' }}>{d.count} 站</span>
                  {d.rising > 0 ? (
                    <span
                      style={{
                        fontSize: 9.5,
                        color: W.warn,
                        flex: '0 0 auto',
                        whiteSpace: 'nowrap',
                      }}
                      title={`这条街道有 ${d.rising} 站近 1 小时在涨，最快 +${d.trend.toFixed(2)}m/h`}
                    >
                      ▲{d.rising} 在涨
                    </span>
                  ) : (
                    <span
                      style={{ fontSize: 9.5, color: W.ok, flex: '0 0 auto', whiteSpace: 'nowrap' }}
                      title="这条街道没有站近 1 小时在涨"
                    >
                      都在退
                    </span>
                  )}
                  <span
                    style={{
                      marginLeft: 'auto',
                      flex: '0 0 auto',
                      fontSize: 11.5,
                      fontWeight: 600,
                      fontFamily: W.mono,
                      fontVariantNumeric: 'tabular-nums',
                      color: W.levelInk[d.topLevel],
                    }}
                  >
                    {d.deepest.toFixed(2)}
                    <span style={{ fontSize: 9, color: W.ink4, fontWeight: 400 }}>m</span>
                  </span>
                </span>
                <span style={{ display: 'block', position: 'relative' }}>
                  <Ruler ratio={d.deepest / scale} color={W.level[d.topLevel]} height={4} />
                  {/* 红阈刻度：同一条街道内最深那站的红阈，和号码右边的大数字配着看 */}
                  <span
                    style={{
                      position: 'absolute',
                      left: `${Math.max(0, Math.min(1, d.red / scale)) * 100}%`,
                      top: -1,
                      bottom: -1,
                      width: 1,
                      background: W.level.red,
                      opacity: 0.75,
                    }}
                  />
                </span>
              </button>
            )
          })}
        </div>
      )}
    </Block>
  )
}

/* ---------------------------------------------------------------- 底带 */

/** 自绘雨强柱状图：一根柱 = 一个采样点，最高的那根就是峰值。 */
function RainChart({ view }: { view: RainView }) {
  const n = view.points.length
  const max = Math.max(...view.points.map((p) => p.v), 0.0001)
  const H = 64
  const slot = 100 / n
  const barW = Math.min(slot * 0.66, 3.2)
  const peakIdx = Math.max(
    0,
    view.points.findIndex((p) => p.at === view.peak.at),
  )
  const peakPct = ((peakIdx + 0.5) / n) * 100
  const dry = view.peak.v < 0.05

  return (
    <div style={{ position: 'relative', width: '100%', height: H, marginTop: 12 }}>
      <svg
        width="100%"
        height={H}
        role="img"
        aria-label={`近 6 小时十站平均雨强，共 ${n} 个采样点`}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* 基线：即使全是 0 也有一条参照，不然会以为图没画出来 */}
        <line x1="0" y1={H - 0.5} x2="100%" y2={H - 0.5} stroke={W.lineSoft} strokeWidth={1} />
        {view.points.map((p, i) => {
          const h = p.v > 0 ? Math.max(1.5, (p.v / max) * (H - 10)) : 0
          const isPeak = i === peakIdx && !dry
          return (
            <rect
              key={p.at}
              x={`${i * slot + (slot - barW) / 2}%`}
              y={H - h}
              width={`${barW}%`}
              height={h}
              fill={isPeak ? W.level.orange : W.accent}
              opacity={isPeak ? 1 : 0.8}
            />
          )
        })}
        {!dry && (
          <line
            x1={`${peakPct}%`}
            y1={2}
            x2={`${peakPct}%`}
            y2={H}
            stroke={W.level.orange}
            strokeWidth={1}
            opacity={0.45}
          />
        )}
      </svg>
      {/* 峰值标注：贴在那一根柱子的正上方，不压住柱头 */}
      {!dry ? (
        <span
          style={{
            position: 'absolute',
            top: -13,
            left: `${clamp(peakPct, 7, 93)}%`,
            transform: 'translateX(-50%)',
            fontSize: 9.5,
            color: W.levelInk.orange,
            background: W.stage,
            padding: '0 3px',
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          峰值 {view.peak.v.toFixed(1)} mm/h
        </span>
      ) : (
        <span
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 22,
            textAlign: 'center',
            fontSize: 10,
            color: W.ink4,
          }}
        >
          六小时内十站雨强都是 0，这条基线就是全部
        </span>
      )}
    </div>
  )
}

/** 一行「小标签 + 数字 + 单位」。雨情和站卡共用，保证字号一致。 */
function Stat({
  label,
  value,
  unit,
  tone,
}: {
  label: string
  value: string
  unit?: string
  tone?: string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: '1 1 0' }}>
      <span style={{ fontSize: 10, color: W.ink4, whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            fontFamily: W.mono,
            fontVariantNumeric: 'tabular-nums',
            color: tone ?? W.ink,
            letterSpacing: -0.3,
          }}
        >
          {value}
        </span>
        {unit && (
          <span style={{ fontSize: 9.5, color: W.ink4, fontFamily: W.mono, whiteSpace: 'nowrap' }}>
            {unit}
          </span>
        )}
      </span>
    </div>
  )
}

/* ---------------------------------------------------------------- 走向行 */

/**
 * 一个站的「三小时峰值」条。
 *
 * 横轴是水深，刻度是该站自己的红阈值（十站阈值不同，0.25~0.50 不等）。
 * 用统一刻度会让浅站看起来都安全、深站看起来都危险——那是刻度的错觉。
 * 右上角的 horizon 是这个站峰值落在哪一档预见期，和外层标题说的是同一件事。
 */
function PeakBar({
  g,
  forecast,
  horizon,
  scale,
  onPick,
}: {
  g: SiteGlance
  forecast: { curve: readonly { offsetMin: number; level: number }[] } | null
  horizon: string | null
  /** 十站共用的水深量程（父层算好传下来），保证条长可以横向比较。 */
  scale: number
  onPick: () => void
}) {
  const depths = useMemo(() => {
    if (!forecast) return []
    const base = g.site.baseLevel
    return forecast.curve
      .filter((p) => p.offsetMin <= 180)
      .map((p) => Math.max(0, p.level - base))
  }, [forecast, g.site.baseLevel])

  const peak = Math.max(g.reading.depth, g.assessment.peakValue, ...depths, 0)
  const red = g.redThreshold || 0.5
  const now = Math.max(0, g.reading.depth)
  // 峰值超过共享量程时（预测曲线比 assessment 给得更深）不把条画出血，
  // 改成夹到 100% 并在右侧加一个溢出小箭头。
  const over = peak > scale

  return (
    <button
      type="button"
      onClick={onPick}
      data-peak-row={g.site.id}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '4px 6px',
        marginBottom: 2,
        border: 0,
        borderBottom: `1px solid ${W.lineSoft}`,
        background: 'transparent',
        cursor: 'pointer',
        font: 'inherit',
      }}
      title={`${g.site.name}：当前 ${now.toFixed(2)}m，三小时内峰值 ${peak.toFixed(2)}m，红阈 ${red.toFixed(2)}m`}
    >
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
        <span
          style={{
            fontSize: 11,
            color: W.ink,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: '1 1 auto',
          }}
        >
          {g.site.name}
        </span>
        <span
          style={{
            fontSize: 10.5,
            fontFamily: W.mono,
            fontVariantNumeric: 'tabular-nums',
            color: peak > red ? W.levelInk.red : peak > red * 0.75 ? W.levelInk.orange : W.ink3,
            flex: '0 0 auto',
          }}
        >
          {peak.toFixed(2)}
        </span>
        {horizon && (
          <span
            style={{
              fontSize: 9,
              color: W.ink4,
              border: `1px solid ${W.lineSoft}`,
              borderRadius: 3,
              padding: '0 3px',
              flex: '0 0 auto',
              whiteSpace: 'nowrap',
            }}
          >
            {horizon}见顶
          </span>
        )}
        <span
          style={{
            fontSize: 9.5,
            color: W.ink4,
            marginLeft: 'auto',
            whiteSpace: 'nowrap',
            flex: '0 0 auto',
          }}
        >
          {peak > red ? `超红 ${(peak - red).toFixed(2)}m` : `距红 ${(red - peak).toFixed(2)}m`}
        </span>
      </span>
      <span style={{ display: 'block', position: 'relative' }}>
        {over && (
          <span
            style={{
              position: 'absolute',
              right: 0,
              top: '50%',
              transform: 'translate(9px, -50%)',
              fontSize: 9,
              lineHeight: 1,
              color: W.levelInk.red,
            }}
          >
            ▸
          </span>
        )}
        <Ruler
          ratio={Math.max(0, Math.min(1, peak / scale))}
          color={peak > red ? W.level.red : peak > red * 0.75 ? W.level.orange : W.level.blue}
          height={5}
        />
        {/* 当前值的位置：峰值条上再叠一个刻度，区分「已经涨到」与「预计会涨到」。 */}
        <span
          style={{
            position: 'absolute',
            left: `${Math.max(0, Math.min(1, now / scale)) * 100}%`,
            top: -1,
            bottom: -1,
            width: 1.5,
            background: W.ink,
            borderRadius: 1,
          }}
        />
        {/* 红阈刻度 */}
        <span
          style={{
            position: 'absolute',
            left: `${Math.max(0, Math.min(1, red / scale)) * 100}%`,
            top: -2,
            bottom: -2,
            width: 1,
            background: W.level.red,
            opacity: 0.8,
          }}
        />
      </span>
    </button>
  )
}

/* ---------------------------------------------------------------- 纯函数 */

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/**
 * 这一站的峰值落在哪一档预见期。
 *
 * 只看 offsetMin > 0 的点：offset 0 是「现在」，它不构成一个预见期。
 * 归到最近的标准档（60/180/360/720）而不是直接用 offset 小时数，
 * 因为标题要说的是一句人话——「峰值多在 1h 预见期」，不是「峰值在 73 分钟」。
 */
function peakHorizonOf(f: SiteForecast | undefined): string | null {
  if (!f || f.curve.length === 0) return null
  let best: number | null = null
  let at = 0
  for (const p of f.curve) {
    if (p.offsetMin <= 0) continue
    if (best === null || p.level > best) {
      best = p.level
      at = p.offsetMin
    }
  }
  if (best === null) return null
  let near: number = HORIZONS[0]
  for (const h of HORIZONS) if (Math.abs(h - at) < Math.abs(near - at)) near = h
  return horizonLabel(near)
}

interface DistrictRollup {
  district: string
  count: number
  topLevel: Level
  deepest: number
  siteId: string
  siteName: string
  red: number
  /** 这条街道里近 1 小时在涨的站数。 */
  rising: number
  /** 其中最快的那一个的涨速（m/h）。 */
  trend: number
}

/**
 * 按街道聚合。
 *
 * 只留三个能改变派单决定的事实：有几站、最高到哪一档、最深受水多少。
 * 排序口径固定「等级优先、同级比最深」——这就是「哪条街道最该先看」。
 */
function rollupDistricts(list: readonly SiteGlance[]): DistrictRollup[] {
  const out = new Map<string, DistrictRollup>()
  for (const g of list) {
    const key = g.site.district || '未分街道'
    const d = Math.max(0, g.reading.depth)
    const cur = out.get(key)
    if (!cur) {
      out.set(key, {
        district: key,
        count: 1,
        topLevel: g.assessment.level,
        deepest: d,
        siteId: g.site.id,
        siteName: g.site.name,
        red: g.redThreshold,
        rising: g.reading.trend1h >= 0.01 ? 1 : 0,
        trend: g.reading.trend1h,
      })
      continue
    }
    cur.count += 1
    if (g.reading.trend1h >= 0.01) cur.rising += 1
    if (g.reading.trend1h > cur.trend) cur.trend = g.reading.trend1h
    if (LEVEL_RANK[g.assessment.level] > LEVEL_RANK[cur.topLevel]) cur.topLevel = g.assessment.level
    if (d > cur.deepest) {
      cur.deepest = d
      cur.siteId = g.site.id
      cur.siteName = g.site.name
      cur.red = g.redThreshold
    }
  }
  return [...out.values()].sort(
    (a, b) => LEVEL_RANK[b.topLevel] - LEVEL_RANK[a.topLevel] || b.deepest - a.deepest,
  )
}

interface RainPoint {
  readonly at: number
  readonly v: number
}

interface RainView {
  readonly points: readonly RainPoint[]
  readonly peak: RainPoint
  readonly total: number
  readonly stepMin: number
}

/**
 * 城市面雨强序列：同一时刻十站的均值。
 *
 * 各站的采样时刻可能不齐（某一站晚一个 tick 上报），所以先按时刻分桶再取均值，
 * 而不是直接拿第 i 个点和第 i 个点相加——那样会把两条时间轴错开画在同一根柱子上。
 * 累计雨量按序列自己的步长折算（契约是 5 分钟，即 rain * 5 / 60），
 * 换成别的采样率时也不会把累计值算错 12 倍。
 */
function cityRain(hist: Record<string, SiteSeries> | undefined): RainView | null {
  if (!hist) return null
  const byTime = new Map<number, { sum: number; n: number }>()
  for (const series of Object.values(hist)) {
    for (const p of series.points) {
      const at = p.at as number
      const cell = byTime.get(at)
      if (cell) {
        cell.sum += p.rain
        cell.n += 1
      } else {
        byTime.set(at, { sum: p.rain, n: 1 })
      }
    }
  }
  if (byTime.size < 2) return null

  const points: RainPoint[] = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([at, cell]) => ({ at, v: cell.sum / cell.n }))

  const gaps: number[] = []
  for (let i = 1; i < points.length; i += 1) gaps.push(points[i].at - points[i - 1].at)
  gaps.sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)]
  const stepMin = median > 0 ? median / 60 : 5

  let total = 0
  let peak = points[0]
  for (const p of points) {
    total += p.v * (stepMin / 60)
    if (p.v > peak.v) peak = p
  }
  return { points, peak, total, stepMin }
}
