import { useMemo } from 'react'
import {
  DISPOSITION_LABEL,
  FACTOR_LABEL,
  HORIZONS,
  LEVEL_LABEL,
  LEVEL_MEANING,
  STATE_LABEL,
  curvePeak,
  depth,
  depthOf,
  fmtDelta,
  fmtDepth,
  fmtMeters,
  fmtMinutes,
  fmtPct,
  fmtRate,
  fmtTime,
  horizonLabel,
  horizonOf,
  isActive,
  isTerminal,
  isUnack,
  levelForDepth,
  levelOfScore,
  meters,
  ratioTo,
  redThreshold,
  seriesPeak,
  sinceSim,
  thresholdRows,
  type AlertEvent,
  type Assessment,
  type FactorWeights,
  type Horizon,
  type Meters,
  type SimTime,
  type SiteForecast,
  type SiteSeries,
  type Thresholds,
} from '../../domain'
import { useAlerts, useForecast, useRules } from '../../data/queries'
import { StationTrend } from '../../components/interactive/StationTrend'
import { displayDepth, useSiteEvidence } from '../../view/useSiteEvidence'
import { Block, Figure, Nothing, Pill, Row, Ruler, Shimmer } from '../kit'
import { W } from '../visual'
import type { StageCtx } from '../ctx'

/**
 * 舞台二：选中一个站。
 *
 * 这一屏要**同时**回答四件事，缺一件值班员就得自己去找别的地方：
 *   1. 现在多严重 —— 积水深、研判等级、离下一档还差多少（画出来，不是只给个数字）
 *   2. 接下来会怎样 —— 6h 实测 + 12h 预测的曲线，四预见期的落点与变化量
 *   3. 凭什么这样判 —— 三因子 + 综合分，而且要能对上账（权重×原始值×折算分）
 *   4. 谁在管 —— 这个站的预警事件，以及「已解除但没归档」这种最容易漏掉的状态
 *
 * 布局是两列：左列「事实 + 预见期」（读数），右列「曲线 + 判据 + 事件」（走向与依据）。
 * 曲线拿最大面积，因为它是唯一能同时表达「已经发生」和「将要发生」的东西。
 */

/** 三因子权重兜底值，与引擎 `engine/waterlog/config.py` 的 DEFAULT_RULES 同源。
 *  只在 `/api/rules` 还没回来时用一次：这一块的全部价值是「能对上账」，
 *  权重写死会让 0.45×0.62 这类展开与引擎真实算分不一致，那比不展开更糟。 */
const FALLBACK_WEIGHTS: FactorWeights = { peak: 0.45, duration: 0.35, trend: 0.2 }

/** 研判结论的触发来源。这一档差异很大：实测已越限是既成事实，预测越限还只是预警。 */
const SOURCE_LABEL: Record<Assessment['alarmSource'], string> = {
  observed: '实测已越限',
  forecast: '预见期内将越限',
  both: '实测与预测都越限',
  none: '两者都未越限',
}

const FACTOR_KEYS = ['peak', 'duration', 'trend'] as const

export function SiteStage({ ctx, siteId }: { ctx: StageCtx; siteId: string }) {
  const ev = useSiteEvidence(siteId)
  const fcQ = useForecast()
  const alertsQ = useAlerts(false)
  const rulesQ = useRules()

  // 这个站的事件。**激活的排在前面**——「已解除未归档」虽然也需要人管，
  // 但它不会再变严重，抢在激活事件前面会让人先处理不紧急的那条。
  const events = useMemo(() => {
    const all = alertsQ.data ?? []
    return all
      .filter((e) => e.siteId === siteId)
      .sort((a, b) => {
        const ai = isActive(a.state) ? 0 : 1
        const bi = isActive(b.state) ? 0 : 1
        if (ai !== bi) return ai - bi
        return b.raisedAt - a.raisedAt
      })
  }, [alertsQ.data, siteId])

  const data = ev.data

  if (!data) {
    return (
      <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex', padding: 12 }}>
        <Block title="站点详情" sub={siteId} grow>
          {ev.isLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Shimmer h={62} />
              <Shimmer h={14} w="55%" />
              <Shimmer h={220} />
            </div>
          ) : (
            <Nothing
              why={ev.error ? `这一站的数据取不到：${ev.error}` : `站点 ${siteId} 还没有实测序列`}
              hint="站点不存在、或该站最近 24 小时没有上报。左栏换一个站即可；顶栏的链路指示能告诉你是数据源断了还是这一站自己没数据。"
            />
          )}
        </Block>
      </div>
    )
  }

  const { site, series, assessment } = data
  const base = site.baseLevel
  const thresholds = site.thresholds
  const red = redThreshold(thresholds)
  const level = assessment.level

  // 序列优先：详情接口自己的 forecast 与全局 forecast 是同一轮快照，
  // 但详情可能缺（引擎刚重启还没发布），这时退回全局那份，避免整块变空。
  const siteFc = data.forecast ?? fcQ.data?.sites[siteId] ?? null

  // 「占红阈」的满量程取 1.18×红阈：留出超阈后的余量，否则红线正好压在框边上看不见。
  // 与 components/domain/Value.tsx 的 ThresholdRuler 同口径，两处读同一张图时不会错位。
  const scale = meters(red * 1.18)

  // 展示用的水深钳到 0：传感器噪声会给出 -0.004。等级与趋势仍用原值，
  // 因为那两处是判定，不该被展示层的整理反过来影响。
  const shown = displayDepth(data.nowDepth)

  // 按深度查表得到的等级，与研判等级**不是一回事**：前者只比阈值，
  // 后者还叠了「超阈持续够不够久」和「趋势是否跨档」两条。两个都显示，
  // 是为了让「深度已经到红了但结论还是橙」这种情形有解释，而不是看起来像算错了。
  const byLookup = levelForDepth(data.nowDepth, thresholds)
  const rows = thresholdRows(thresholds)
  const nextRow = rows.find((r) => r.value > data.nowDepth) ?? null
  const overRed = depth(data.nowDepth - red)

  const weights = rulesQ.data?.weights ?? FALLBACK_WEIGHTS
  const byScore = rulesQ.data ? levelOfScore(assessment.score, rulesQ.data.scoreCutoffs) : null

  // 曲线只回看 6h：详情接口给的是整 24h，全画上去会把 12h 的前瞻压成屏幕右边一小段。
  // 裁剪锚点取序列末点而不是「墙上时间」——仿真时钟 60 倍速，两者差着一小时。
  const lastAt = series.points[series.points.length - 1]?.at ?? null
  const recent = lastAt ? sinceSim(series, (lastAt - 6 * 3600) as SimTime) : series

  // 实测峰值必须在**和图同一个窗口**里算（近 6h）。useSiteEvidence 的
  // observedPeak 是整段序列（后端给的是 24h）的峰值，直接拿来标「6h 内」会
  // 把三小时前已经退掉的那次洪峰算进来，和图上的最高点对不上。
  const observedPeak6h = seriesPeak(recent, base)

  const peakPoint = siteFc ? curvePeak(siteFc.curve) : null
  const peakDepth = peakPoint ? depthOf(peakPoint.level, base) : null

  const activeCount = events.filter((e) => isActive(e.state)).length
  const backlog = events.filter((e) => !isActive(e.state) && !isTerminal(e.disposition))

  return (
    <div
      style={{
        flex: '1 1 0',
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: 'minmax(300px, 1fr) minmax(360px, 1.45fr)',
        gap: 12,
        padding: 12,
      }}
    >
      {/* ------------------------------------------------ 左列：读数 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
        <Block
          title="现在多严重"
          sub={`${site.district} · ${site.name} · ${site.id}`}
          aside={
            <Pill tone={W.levelInk[level]} fill>
              {LEVEL_LABEL[level]}
            </Pill>
          }
        >
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, flexWrap: 'wrap' }}>
            <Figure
              value={fmtDepth(shown)}
              unit="m"
              label="当前积水深"
              tone={W.levelInk[level]}
              size={36}
            />
            <Figure value={fmtMinutes(assessment.durationMin)} label="超阈持续" size={17} />
            <Figure value={fmtRate(assessment.slope)} unit="m/h" label="变化趋势" size={17} />
          </div>

          {/* 四级阈值的距离：只给一个「距红阈 0.12m」也能读，但看不出
              现在到底踩进了第几档、下一档还有多远。标尺把整条量程和四档位置都摊开。 */}
          <div style={{ marginTop: 12, position: 'relative', paddingBottom: 16 }}>
            <Ruler
              ratio={ratioTo(shown, scale)}
              color={W.level[level]}
              height={9}
              marks={rows.map((r) => ({ at: ratioTo(depth(r.value), scale), color: W.level[r.level] }))}
            />
            {rows.map((r) => (
              <span
                key={r.level}
                style={{
                  position: 'absolute',
                  left: `${Math.min(100, ratioTo(depth(r.value), scale) * 100)}%`,
                  top: 12,
                  transform: 'translateX(-50%)',
                  fontSize: 9.5,
                  fontFamily: W.mono,
                  color: W.levelInk[r.level],
                  whiteSpace: 'nowrap',
                }}
              >
                {fmtDepth(r.value)}
              </span>
            ))}
          </div>

          <div style={{ marginTop: 4 }}>
            {nextRow ? (
              <Row
                k={`距${LEVEL_LABEL[nextRow.level]}阈值`}
                v={`${fmtDepth(depth(nextRow.value - data.nowDepth))} m`}
                hint="再涨这么多就到下一档"
              />
            ) : (
              <Row
                k="已超红阈"
                v={`${fmtDepth(overRed)} m`}
                tone={W.levelInk.red}
                hint="四级阈值已全部越过"
              />
            )}
            <Row k="绝对水位" v={`${fmtMeters(data.nowLevel)} m`} hint={`基准 ${fmtMeters(base)}`} />
            <Row k="占红阈" v={fmtPct(ratioTo(shown, red))} hint={`红阈 ${fmtDepth(red)} m`} />
            <Row
              k="按深度查表"
              v={LEVEL_LABEL[byLookup]}
              hint="只比阈值，不含持续与趋势"
              tone={W.ink2}
            />
            <Row k="研判来源" v={SOURCE_LABEL[assessment.alarmSource]} />
            <Row k="实测峰值" v={`${fmtDepth(observedPeak6h)} m`} hint="近 6h（与左图同窗口）" />
            <Row
              k="预测峰值"
              v={`${fmtDepth(data.forecastPeak)} m`}
              hint={peakPoint ? `${horizonLabel(peakPoint.offsetMin)} 后` : '本轮无预测'}
            />
          </div>

          <div style={{ marginTop: 8, fontSize: 11, color: W.ink3, lineHeight: 1.6 }}>
            {LEVEL_MEANING[level]}
          </div>
        </Block>

        <Block
          title="四预见期"
          sub="落点水深与相对现在的变化量"
          aside={
            siteFc ? (
              <Pill tone={W.ink3}>{siteFc.decision.shouldForecast ? '本轮已预测' : '本轮未预测'}</Pill>
            ) : null
          }
          grow
          pad={10}
        >
          {siteFc ? (
            <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 0, overflowY: 'auto' }}>
              {HORIZONS.map((h) => (
                <HorizonRow
                  key={h}
                  h={h}
                  row={horizonOf(siteFc, h)}
                  base={base}
                  thresholds={thresholds}
                  scale={scale}
                />
              ))}
              {/* 曲线的时间基准必须写清楚：图上的「现在」是预测发布时刻，
                  不是此刻的墙上时间（仿真时钟 60 倍速，两者差着一小时）。 */}
              <div style={{ marginTop: 6, fontSize: 10.5, color: W.ink4, lineHeight: 1.6 }}>
                {data.issuedAt
                  ? `以 ${fmtTime(data.issuedAt)} 发布的预测为锚`
                  : '本轮预测没有发布时刻，落点以最新实测为锚'}
                {` · 研判窗口 ${fmtMinutes(assessment.horizonMin || 180)}`}
              </div>
            </div>
          ) : (
            <Nothing
              why="这一站本轮没有预测结果"
              hint="引擎每 60 秒发布一轮全站预测。取不到可能是引擎刚重启、或这一站被判定为「无需预测」（历史太短、水位平稳）。"
            />
          )}
        </Block>
      </div>

      {/* ------------------------------------------------ 右列：走向与依据 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
        <Block
          title="6h 回看 + 12h 预见"
          sub={
            data.issuedAt
              ? `发布于 ${fmtTime(data.issuedAt)}${data.modelVersion ? ` · ${data.modelVersion}` : ''}`
              : '尚无预测发布时刻'
          }
          aside={
            peakDepth !== null && peakPoint ? (
              <Pill tone={W.levelInk[level]}>
                峰值 {fmtDepth(peakDepth)} m · {horizonLabel(peakPoint.offsetMin)} 后
              </Pill>
            ) : null
          }
          grow
          pad={0}
        >
          <div style={{ flex: '1 1 0', minHeight: 200, overflow: 'hidden', padding: '6px 4px 0' }}>
            <StationTrendChart
              series={recent}
              forecast={siteFc}
              base={base}
              thresholds={thresholds}
              issuedAt={data.issuedAt}
            />
          </div>
          <div
            style={{
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              padding: '6px 10px',
              borderTop: `1px solid ${W.lineSoft}`,
              fontSize: 10.5,
              color: W.ink3,
            }}
          >
            <span>实线 = 实测（近 6h）</span>
            <span>虚线 = 预测</span>
            <span>带子 = 90% 置信区间</span>
            <span>细虚线 = 四级阈值（绝对水位）</span>
            <span style={{ marginLeft: 'auto', color: W.ink4 }}>
              数据质量 {data.quality.label}
            </span>
          </div>
        </Block>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
            gap: 12,
            flex: '0 0 auto',
            minHeight: 0,
          }}
        >
          <Block
            title="凭什么这样判"
            sub={`权重 × 原始值 → 折算分，三者相加即综合分`}
            aside={
              <Pill tone={W.levelInk[level]}>
                {fmtScore(assessment.score)}
              </Pill>
            }
            pad={10}
          >
            <FactorTable assessment={assessment} weights={weights} />
            <div style={{ marginTop: 8, fontSize: 10.5, color: W.ink4, lineHeight: 1.7 }}>
              {byScore && byScore !== level ? (
                <>
                  按分档表 {fmtScore(assessment.score)} 应为 {LEVEL_LABEL[byScore]}，研判结论是{' '}
                  {LEVEL_LABEL[level]}：差异来自硬约束（持续时长不够则只能降级）。
                </>
              ) : (
                <>综合分与研判等级一致；折算分是 0~1 归一化后的因子值，与 FactorBars 同口径。</>
              )}
            </div>
            {assessment.blockedBy && (
              <div
                style={{
                  marginTop: 6,
                  padding: '5px 8px',
                  borderLeft: `2px solid ${W.warn}`,
                  fontSize: 11,
                  color: W.levelInk.yellow,
                  lineHeight: 1.6,
                }}
              >
                已按硬约束下调：{assessment.blockedBy}
              </div>
            )}
            {/* 研判原文是引擎算出来的，前端不加工——加工过的依据就不再是依据了。 */}
            <div
              style={{
                marginTop: 8,
                padding: '6px 8px',
                borderLeft: `2px solid ${W.accent}`,
                fontSize: 11.5,
                color: W.ink2,
                lineHeight: 1.65,
              }}
            >
              {assessment.reason || '引擎本轮没有给出研判原文'}
            </div>
          </Block>

          <Block
            title="谁在管"
            sub={`${events.length} 条事件`}
            aside={
              <Pill tone={activeCount > 0 ? W.levelInk[level] : W.ink4} fill={activeCount > 0}>
                激活 {activeCount}
              </Pill>
            }
            pad={10}
          >
            {events.length === 0 ? (
              <Nothing
                why="这一站没有预警事件"
                hint="预警由引擎按三因子判定生成。没有事件说明研判等级一直没到报警线，或历史事件已被清理。"
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 176, overflowY: 'auto' }}>
                {backlog.length > 0 && (
                  <div style={{ fontSize: 10.5, color: W.bad, padding: '2px 0 5px' }}>
                    {backlog.length} 条已解除但未归档 —— 处置轴还停在中间态，需要人补完记录
                  </div>
                )}
                {events.map((e) => (
                  <EventLine
                    key={e.id}
                    e={e}
                    onOpen={() => ctx.openEvent(e.id, site.name, e.level)}
                  />
                ))}
              </div>
            )}
          </Block>
        </div>
      </div>
    </div>
  )
}

/**
 * 曲线本体。
 *
 * 单独包一层是为了把三个约束钉在这一个地方（它们是踩过的坑，不是风格选择），
 * 顺手把高度定成舞台要的 300px：
 * 1. x 轴锚 `issuedAt`——仿真时钟 60 倍速，用「此刻」会把整段预测推出画布；
 * 2. 阈值线画**绝对水位**（base + 阈值），因为主轴是绝对水位；
 * 3. 置信带上界传 `upper - lower`（stack 累加语义），传绝对值会长出第二条曲线。
 *
 * 这三条由 StationTrend 内部实现，这里只负责把参数按契约传对。
 */
function StationTrendChart({
  series,
  forecast,
  base,
  thresholds,
  issuedAt,
}: {
  series: SiteSeries
  forecast: SiteForecast | null
  base: Meters
  thresholds: Thresholds
  issuedAt: SimTime | null
}) {
  return (
    <StationTrend
      series={series}
      forecast={forecast}
      baseLevel={base}
      thresholds={thresholds}
      issuedAt={issuedAt}
      height={300}
    />
  )
}

/** 一个预见期一行：落点水深 + 变化量 + 相对红阈的位置。 */
function HorizonRow({
  h,
  row,
  base,
  thresholds,
  scale,
}: {
  h: number
  row: Horizon | null
  base: Meters
  thresholds: Thresholds
  scale: Meters
}) {
  if (!row) {
    return (
      <div
        style={{
          padding: '6px 0',
          borderBottom: `1px solid ${W.lineSoft}`,
          fontSize: 11,
          color: W.ink4,
        }}
      >
        {horizonLabel(h)} · 这一档没有发布结果（引擎只发布算得出来的预见期）
      </div>
    )
  }
  const d = depthOf(row.level, base)
  const lv = levelForDepth(d, thresholds)
  const rising = Number(row.delta) > 0
  return (
    <div
      style={{
        flex: '1 1 0',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 4,
        padding: '6px 0',
        borderBottom: `1px solid ${W.lineSoft}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ width: 34, fontSize: 11, color: W.ink3, fontFamily: W.mono }}>
          {horizonLabel(h)}
        </span>
        <span
          style={{
            fontFamily: W.mono,
            fontVariantNumeric: 'tabular-nums',
            fontSize: 13.5,
            fontWeight: 600,
            color: W.levelInk[lv],
          }}
        >
          {fmtDepth(d)}
        </span>
        <span style={{ fontSize: 10, color: W.ink4 }}>m</span>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: W.mono,
            fontVariantNumeric: 'tabular-nums',
            fontSize: 11.5,
            color: rising ? W.levelInk.red : Number(row.delta) < 0 ? W.levelInk.blue : W.ink4,
          }}
        >
          {fmtDelta(row.delta)}
        </span>
        <span style={{ fontSize: 10, color: W.ink4 }}>m</span>
      </div>
      <div>
        <Ruler
          ratio={ratioTo(d, scale)}
          color={W.level[lv]}
          height={4}
          marks={[{ at: ratioTo(depth(redThreshold(thresholds)), scale), color: W.level.red }]}
        />
      </div>
    </div>
  )
}

/**
 * 三因子展开。
 *
 * 只显示「0.80 分」是不够的：用户会问 0.80 是怎么来的。所以每一行都要能看到
 * **权重（固定）× 原始值（有物理含义）× 折算分（0~1）**，以及贡献 = 权重 × 折算分。
 * 三行贡献相加就是综合分——这样对不上账时用户能自己发现，而不是只能相信结论。
 */
function FactorTable({ assessment, weights }: { assessment: Assessment; weights: FactorWeights }) {
  const raw: Record<(typeof FACTOR_KEYS)[number], string> = {
    peak: `${fmtDepth(assessment.peakValue)} m`,
    duration: fmtMinutes(assessment.durationMin),
    trend: `${fmtRate(assessment.slope)} m/h`,
  }
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          fontSize: 10,
          color: W.ink4,
          paddingBottom: 3,
          borderBottom: `1px solid ${W.line}`,
        }}
      >
        <span style={{ width: 52 }}>因子</span>
        <span style={{ width: 30 }}>权重</span>
        <span style={{ flex: '1 1 0' }}>原始值</span>
        <span style={{ width: 42, textAlign: 'right' }}>折算</span>
        <span style={{ width: 42, textAlign: 'right' }}>贡献</span>
      </div>
      {FACTOR_KEYS.map((k) => {
        const v = assessment.factors[k]
        const contrib = weights[k] * v
        return (
          <div key={k} style={{ padding: '3px 0', borderBottom: `1px solid ${W.lineSoft}` }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11 }}>
              <span style={{ width: 52, color: W.ink2 }}>{FACTOR_LABEL[k]}</span>
              <span style={{ width: 30, color: W.ink3, fontFamily: W.mono }}>
                {fmtScore(weights[k])}
              </span>
              <span style={{ flex: '1 1 0', color: W.ink, fontFamily: W.mono }}>{raw[k]}</span>
              <span
                style={{
                  width: 42,
                  textAlign: 'right',
                  color: W.ink2,
                  fontFamily: W.mono,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {fmtScore(v)}
              </span>
              <span
                style={{
                  width: 42,
                  textAlign: 'right',
                  color: W.accent,
                  fontFamily: W.mono,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {fmtScore(contrib)}
              </span>
            </div>
            <div style={{ marginTop: 2 }}>
              <Ruler ratio={v} color={W.level.none} height={3} />
            </div>
          </div>
        )
      })}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11, paddingTop: 5 }}>
        <span style={{ width: 52, color: W.ink2, fontWeight: 600 }}>综合分</span>
        <span style={{ color: W.ink4, fontSize: 10 }}>
          {FACTOR_KEYS.map((k) => fmtScore(weights[k] * assessment.factors[k])).join(' + ')}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: W.mono,
            fontVariantNumeric: 'tabular-nums',
            fontSize: 14,
            fontWeight: 600,
            color: W.ink,
          }}
        >
          {fmtScore(assessment.score)}
        </span>
      </div>
    </div>
  )
}

/** 事件一行：等级、状态、处置进展、跟办提示。点进去看卷宗。 */
function EventLine({ e, onOpen }: { e: AlertEvent; onOpen: () => void }) {
  const follow = followUp(e)
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '5px 4px',
        border: 0,
        borderBottom: `1px solid ${W.lineSoft}`,
        background: 'transparent',
        cursor: 'pointer',
        font: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            background: W.level[e.level],
            flex: '0 0 auto',
          }}
        />
        <span style={{ fontSize: 11.5, color: W.ink }}>#{e.id}</span>
        <span style={{ fontSize: 10.5, color: W.levelInk[e.level] }}>{LEVEL_LABEL[e.level]}</span>
        <span style={{ fontSize: 10.5, color: W.ink3 }}>{STATE_LABEL[e.state]}</span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: W.ink3, fontFamily: W.mono }}>
          {DISPOSITION_LABEL[e.disposition]}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 2 }}>
        <span style={{ fontSize: 10, color: W.ink4, fontFamily: W.mono }}>
          {fmtTime(e.raisedAt)}
        </span>
        <span style={{ fontSize: 10, color: follow.tone, lineHeight: 1.5 }}>{follow.text}</span>
      </div>
    </button>
  )
}

/**
 * 一条事件「下一步该看什么」。判据是「预警还成立吗」× 「处置闭环了吗」，
 * 两者交叉出四种情况。单独抽出来，是因为「已解除但未归档」是最容易被漏掉的一类：
 * 它不再报警，却还挂着一个没做完的处置记录，交接时没人认领。
 */
function followUp(e: AlertEvent): { text: string; tone: string } {
  const unack = isUnack(e.state)
  if (isActive(e.state)) {
    return unack
      ? { text: '模型仍判成立，且还没人确认', tone: W.bad }
      : { text: '模型仍判成立，已确认，等处置推进', tone: W.warn }
  }
  if (isTerminal(e.disposition)) {
    return {
      text: unack ? '已解除、处置已闭环，但从未确认' : '已解除且处置已闭环',
      tone: unack ? W.warn : W.ok,
    }
  }
  return {
    text: `已解除但未归档（处置仍停在「${DISPOSITION_LABEL[e.disposition]}」${unack ? '，且未确认' : ''}）`,
    tone: W.bad,
  }
}

/**
 * 0~1 无量纲量（权重、折算分、综合分、贡献）统一两位小数。
 *
 * 不自己发明位数：FactorBars 与 LevelChip 对同一批数都是两位，
 * 这一屏要和它们并排读同一个分数，位数不同会让人以为是两个不同的量。
 */
function fmtScore(v: number): string {
  if (!Number.isFinite(v)) return '—'
  return v.toFixed(2)
}
