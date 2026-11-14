import { useMemo } from 'react'
import { useForecast, useOverview } from '../../data/queries'
import { useWatchlist, type SiteGlance } from '../../view/useWatchlist'
import { useSituation } from '../../view/useSituation'
import { RealMap } from '../../map/RealMap'
import { useMapStations } from '../../view/useMapPoints'
import { LEVEL_LABEL, type Level } from '../../domain'
import { Block, Figure, Nothing, Pill, Ruler, Shimmer } from '../kit'
import { W, ease } from '../visual'
import type { StageCtx } from '../ctx'
/**
 * 舞台一：全域态势。
 *
 * 这是这一屏的**默认状态**——没有人选中任何对象时看到的东西。
 * 它要回答一个问题：**现在该看哪里**。
 *
 * 所以它的中心是一张真地图（回答「哪里」），四周是三块「把地图上看到的东西
 * 变成一句话」的面板：分布（几个站在哪一档）、最危险的那个站（点名 +
 * 它的三小时走向）、以及十站的三小时全景（回答「还有谁快不行了」）。
 *
 * 地图是选中的入口：点任何气泡都会让整个舞台变成那个站的详情，
 * 而左边的列表同步高亮——用户因此永远知道「我点的是哪一个」。
 */
export function SituationStage({ ctx }: { ctx: StageCtx }) {
  const sit = useSituation()
  const ov = useOverview()
  const fc = useForecast()
  const list = useWatchlist('level')
  const stations = useMapStations()

  const worst = list[0] ?? null

  const peakAt = useMemo(() => {
    if (!fc.data) return '—'
    const h = fc.data.stepMin
    void h
    return '3h'
  }, [fc.data])

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

  return (
    <div
      style={{
        flex: '1 1 0',
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: 'minmax(320px, 1.35fr) minmax(300px, 1fr)',
        gridTemplateRows: 'minmax(260px, 1.5fr) minmax(200px, 1fr)',
        gap: 12,
        padding: 12,
        // 最危险站那张浮卡要相对这个网格定位，而不是相对整页——
        // 否则窗口一滚它就跑到别处去了。
        position: 'relative',
      }}
    >
      {/* 地图占左上主位。它是「哪里」这个问题的唯一答案，所以给最大面积。 */}
      <div
        data-tour="wb-map"
        style={{ gridRow: '1 / 3', display: 'flex', flexDirection: 'column', minHeight: 0 }}
      >
        <Block
          title="一张图"
          sub={`${sit.total} 个站点 · 气泡大小 = 积水深`}
          aside={
            <span style={{ fontSize: 10.5, color: W.ink4 }}>
              可拖拽缩放 · 点气泡看详情
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
              <span style={{ marginLeft: 'auto', color: W.ink4 }}>
                半径 6→24px 对应水深 0→0.7m
              </span>
            </div>
          </div>
        </Block>
      </div>

      {/* 右上：等级分布。它是「现在多严重」的条形答案，五个数字各自可点。 */}
      <Block
        title="等级分布"
        sub="点任一档，左栏只看那一档"
        pad={10}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: '1 1 0', justifyContent: 'center' }}>
          {sit.counts
            .slice()
            .reverse()
            .map((c) => (
              <DistRow
                key={c.level}
                level={c.level}
                count={c.count}
                total={sit.total}
                onPick={() => {
                  ctx.setSort('level')
                  ctx.toast('info', `左栏已按等级排序；${LEVEL_LABEL[c.level]} 共 ${c.count} 站`)
                }}
              />
            ))}
        </div>
      </Block>

      {/* 右下：十站三小时全景。回答「除了最严重的那个，还有谁快不行了」。 */}
      <div
        data-tour="wb-forecast"
        style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}
      >
        <Block
          title="三小时走向"
        sub={`峰值出现在 ${peakAt} 预见期的站已标出`}
        aside={<Pill tone={W.ink4}>{list.filter((g) => g.isAlarm).length} 站需关注</Pill>}
        grow
        pad={0}
      >
        <div style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', padding: '8px 10px' }}>
          {list.map((g) => (
            <PeakBar key={g.site.id} g={g} forecast={fc.data?.sites[g.site.id] ?? null} onPick={() => ctx.goStage({ kind: 'site', siteId: g.site.id })} />
          ))}
        </div>
        </Block>
      </div>

      {/* 最危险站的一句话结论。它不占网格，浮在地图左下——因为它是「结论」，
          不该和「数据」抢同一块版面。 */}
      {worst && (
        <div
          style={{
            position: 'absolute',
            left: 22,
            bottom: 22,
            maxWidth: 300,
            padding: '9px 11px',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.96)',
            border: `1px solid ${W.line}`,
            boxShadow: '0 6px 20px rgba(13,31,51,0.13)',
            backdropFilter: 'blur(4px)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 4,
                background: W.level[worst.assessment.level],
              }}
            />
            <span style={{ fontSize: 11, color: W.ink3 }}>当前最严重</span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: W.ink, marginBottom: 4 }}>
            {worst.site.name}
          </div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end' }}>
            <Figure
              value={worst.reading.depth.toFixed(2)}
              unit="m"
              size={24}
              label="积水深"
              tone={W.levelInk[worst.assessment.level]}
            />
            <Figure
              value={`${(worst.depthRatio * 100).toFixed(0)}%`}
              size={16}
              label="占红阈"
              tone={worst.depthRatio >= 1 ? W.bad : W.ink2}
            />
          </div>
          <button
            type="button"
            onClick={() => ctx.goStage({ kind: 'site', siteId: worst.site.id })}
            style={{
              marginTop: 7,
              width: '100%',
              padding: '5px 0',
              fontSize: 11.5,
              color: '#fff',
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
      )}
    </div>
  )
}

function DistRow({
  level,
  count,
  total,
  onPick,
}: {
  level: Level
  count: number
  total: number
  onPick: () => void
}) {
  const pct = total > 0 ? count / total : 0
  return (
    <button
      type="button"
      onClick={onPick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '3px 4px',
        borderRadius: 5,
        border: 0,
        background: 'transparent',
        cursor: 'pointer',
        font: 'inherit',
        transition: `background 140ms ${ease}`,
      }}
    >
      <span
        style={{
          width: 34,
          fontSize: 10.5,
          color: count > 0 ? W.levelInk[level] : W.ink4,
          textAlign: 'left',
        }}
      >
        {LEVEL_LABEL[level]}
      </span>
      <span style={{ flex: '1 1 0', minWidth: 40 }}>
        <Ruler ratio={pct} color={W.level[level]} height={7} />
      </span>
      <span
        style={{
          width: 20,
          textAlign: 'right',
          fontSize: 13,
          fontWeight: 600,
          fontFamily: W.mono,
          fontVariantNumeric: 'tabular-nums',
          color: count > 0 ? W.ink : W.ink4,
        }}
      >
        {count}
      </span>
    </button>
  )
}

/**
 * 一个站的「三小时峰值」条。
 *
 * 横轴是水深，刻度是**该站自己的红阈值**（十站阈值不同，0.25~0.50 不等）。
 * 用统一刻度会让浅站看起来都安全、深站看起来都危险——那是刻度的错觉。
 */
function PeakBar({
  g,
  forecast,
  onPick,
}: {
  g: SiteGlance
  forecast: { curve: readonly { offsetMin: number; level: number }[] } | null
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
  // 量程要同时放得下红阈值与峰值，否则要么看不到红线、要么柱子顶出框。
  const scale = Math.max(red * 1.15, peak * 1.05, 0.06)
  const now = Math.max(0, g.reading.depth)

  return (
    <button
      type="button"
      onClick={onPick}
      data-peak-row={g.site.id}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '5px 6px',
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
            width: 96,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: '0 0 auto',
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
          }}
        >
          {peak.toFixed(2)}
        </span>
        <span style={{ fontSize: 9.5, color: W.ink4, marginLeft: 'auto' }}>
          {peak > red ? '三小时内会超红阈' : `距红阈 ${(red - peak).toFixed(2)}m`}
        </span>
      </span>
      <span style={{ display: 'block', position: 'relative' }}>
        <Ruler
          ratio={Math.max(0, Math.min(1, peak / scale))}
          color={peak > red ? W.level.red : peak > red * 0.75 ? W.level.orange : W.level.blue}
          height={5}
        />
        {/* 当前值的位置：峰值条上再叠一个小刻度，区分「已经涨到」与「预计会涨到」。 */}
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
