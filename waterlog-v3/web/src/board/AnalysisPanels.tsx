import type { Palette } from './theme'
import { MODEL_FAMILIES, MODEL_LABEL, horizonLabel, type DecisionRow, type EvalPair, type Metrics } from '../domain'

/**
 * 大屏专用的三个「分析类」面板。
 *
 * 与 BoardPage 里那些卡片不同，这三块不回答「现在怎么样」，
 * 而是回答「这台机器靠不靠得住」——它们在「图表分析」屏里。
 * 大屏放这类内容的风险是：观众把它当装饰。所以每块都只留一个结论句，
 * 其余全部用来支撑那句话。
 */

/** 把 Meters 洗成 number（只在这一层做，不与品牌类型混用）。 */
const n = (v: unknown) => Number(v ?? 0)

/**
 * 预测偏差分布：横轴是预见期，纵轴是「预测 − 实测」。
 *
 * 不用经典残差直方图：大屏是一次性扫读，直方图要先理解横轴才能判断好坏；
 * 散点图看「点的分布有没有偏在零线一侧」是一眼的事。
 * 零线上下各给一条 ±0.05m 的引导带——超出这条带说明误差已经大于一脚深的量级。
 */
export function ResidualScatter({ pairs, p }: { pairs: readonly EvalPair[]; p: Palette }) {
  const done = pairs.filter((x) => x.actual != null)
  if (!done.length) return <div style={{ fontSize: 11, color: p.textFaint }}>等待预测结算</div>

  const HORIZON_X = [60, 180, 360, 720]
  const errs = done.map((x) => n(x.yhat) - n(x.actual))
  const maxAbs = Math.max(0.08, ...errs.map((e) => Math.abs(e)))
  const W = 100
  const Hh = 34
  const yOf = (e: number) => Hh / 2 - (e / maxAbs) * (Hh / 2 - 2)
  const xOf = (h: number) => {
    const i = HORIZON_X.indexOf(h)
    return i < 0 ? 0 : 8 + (i / (HORIZON_X.length - 1)) * (W - 14)
  }

  const mean = errs.reduce((a, b) => a + b, 0) / errs.length
  const over = errs.filter((e) => e > 0).length
  const bias = mean > 0.02 ? '整体偏高估' : mean < -0.02 ? '整体偏低估' : '无明显偏倚'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 3 }}>
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <svg viewBox={`0 0 ${W} ${Hh}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
          <rect x={0} y={yOf(0.05)} width={W} height={Math.max(0.1, yOf(-0.05) - yOf(0.05))} fill={p.accent} opacity={0.06} />
          <line x1={0} y1={yOf(0)} x2={W} y2={yOf(0)} stroke={p.textDim} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {HORIZON_X.map((h) => (
            <line key={h} x1={xOf(h)} y1={0} x2={xOf(h)} y2={Hh} stroke={p.panelLine} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
          ))}
          {done.map((x, i) => {
            const e = n(x.yhat) - n(x.actual)
            return <circle key={i} cx={xOf(x.horizonMin)} cy={yOf(e)} r={0.55} fill={StateColor(e, p)} opacity={0.72} />
          })}
        </svg>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: p.textFaint }}>
        {HORIZON_X.map((h) => (
          <span key={h}>{horizonLabel(h as never)}</span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, fontSize: 9.5, color: p.textDim, flexWrap: 'wrap' }}>
        <span>
          样本 <b style={{ color: p.text }}>{errs.length}</b>
        </span>
        <span>
          平均偏差 <b style={{ color: p.text }}>{mean >= 0 ? '+' : ''}{(mean * 100).toFixed(1)}cm</b>
        </span>
        <span>
          高估占比 <b style={{ color: p.text }}>{((over / errs.length) * 100).toFixed(0)}%</b>
        </span>
        <span style={{ color: p.accent }}>{bias}</span>
      </div>
    </div>
  )
}

function StateColor(e: number, p: Palette) {
  const a = Math.abs(e)
  if (a < 0.03) return p.forecast
  if (a < 0.08) return p.accent2
  return p.level.orange
}

/**
 * 模型精度矩阵：轻松看懂「哪个模型在哪个预见期上能信」。
 *
 * 用 skill 而不是 RMSE 做底色：RMSE 有量纲，跨站不可比；
 * skill 是相对持久化基线的，>0 才比「水位不变」强，一眼能看出临界。
 */
export function SkillMatrix({ metrics, p }: { metrics: Metrics; p: Palette }) {
  // metrics.latest.metrics 的第一层键**是模型族名**（persistence/linear/gbr/blend），
  // 数组里是该族的各个预见期。所以行 = 模型族，列 = 预见期，取法要按这两层反过来找。
  const horizons = Array.from(
    new Set(Object.values(metrics.latest.metrics).flat().map((m) => m.horizonMin)),
  ).sort((a, b) => a - b)
  if (!horizons.length) return <div style={{ fontSize: 11, color: p.textFaint }}>暂无离线指标</div>

  const cell = (fam: string, h: number) => {
    const row = (metrics.latest.metrics[fam] ?? []).find((m) => m.horizonMin === h)
    return row ? row.skill : null
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 4 }}>
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: `62px repeat(${horizons.length}, 1fr)`, gridAutoRows: '1fr', gap: 3, minHeight: 0 }}>
        <div />
        {horizons.map((h) => (
          <div key={h} style={{ fontSize: 9.5, color: p.textFaint, textAlign: 'center', alignSelf: 'center' }}>
            {horizonLabel(h as never)}
          </div>
        ))}
        {MODEL_FAMILIES.map((fam) => [
          <div key={`n-${fam}`} style={{ fontSize: 9.5, color: p.textDim, alignSelf: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {MODEL_LABEL[fam]}
          </div>,
          ...horizons.map((h) => {
            const v = cell(fam, h)
            const ok = v != null && v > 0
            return (
              <div
                key={`${fam}-${h}`}
                title={v == null ? '无数据' : `skill ${v.toFixed(3)}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 3,
                  fontSize: 10.5,
                  fontVariantNumeric: 'tabular-nums',
                  color: ok ? p.text : p.textFaint,
                  background: v == null ? p.panelLine : ok ? p.levelSoft.blue : p.levelSoft.orange,
                }}
              >
                {v == null ? '—' : v.toFixed(2)}
              </div>
            )
          }),
        ])}
      </div>
      <div style={{ fontSize: 9, color: p.textFaint, lineHeight: 1.4 }}>
        skill &gt; 0 才优于「水位不变」基线；橙色格为负技巧（不如不预测）
      </div>
    </div>
  )
}

/**
 * 研判决策时序：每条决策一格，加算与跳过分别上色。
 *
 * 这块的价值不在读具体数值，而在看**密度**：连续长时间「静默跳过」
 * 说明引擎认为这波已经结束，突然密集「主动加算」说明有新情况。
 */
export function DecisionStrip({ rows, p }: { rows: readonly DecisionRow[]; p: Palette }) {
  if (!rows.length) return <div style={{ fontSize: 11, color: p.textFaint }}>等待决策记录</div>
  // 只取最近 28 轮：42 格塞进这块面板（240 高）时每格不到 3px 宽，
  // 分不清是「加算」还是「跳过」，等于没画。28 格宽约 8px，颜色能认出来。
  const recent = rows.slice(0, 28)
  const forecasts = recent.filter((r) => r.shouldForecast).length
  // 按站点汇总加算次数与平均增益；次数多的排前面
  const acc = new Map<string, { count: number; gain: number }>()
  for (const r of recent) {
    if (!r.shouldForecast) continue
    const cur = acc.get(r.siteId) ?? { count: 0, gain: 0 }
    cur.count += 1
    cur.gain += r.correctionGain ?? 0
    acc.set(r.siteId, cur)
  }
  const bySite = Array.from(acc.entries())
    .map(([k, v]) => [k, { count: v.count, gain: v.gain / v.count }] as const)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 6)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 6 }}>
      {/* 格区给固定高度、不用 flex:1 —— 用 flex:1 时它会先把底注空间吃掉，
          底注就压在最后一格上（截图里正是这个现象）。 */}
      <div style={{ display: 'flex', gap: 2, height: 34, flex: '0 0 auto' }}>
        {recent.map((r, i) => (
          <div
            key={i}
            title={`${r.siteId} · ${r.shouldForecast ? '主动加算' : '静默跳过'}${r.correctionGain != null ? ` · 增益 ${r.correctionGain.toFixed(2)}` : ''}`}
            style={{
              flex: '1 1 0',
              borderRadius: 2,
              background: r.shouldForecast ? p.accent : p.panelLine,
              opacity: r.shouldForecast ? 0.9 : 0.55,
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, fontSize: 9.5, color: p.textDim, flex: '0 0 auto' }}>
        <span>
          近 {recent.length} 轮 <b style={{ color: p.text }}>{forecasts}</b> 次加算
        </span>
        <span style={{ color: p.textFaint }}>{((forecasts / recent.length) * 100).toFixed(0)}% 触发率</span>
        <span style={{ marginLeft: 'auto', color: p.textFaint }}>左旧 → 右新</span>
      </div>
      {/* 下半区不留空：按站点汇总「本轮被加算了几次、平均增益多少」。
          这块回答的是格区看不出的问题——加算是集中在一两个站（说明那几站
          模型确实跑了），还是十个站平摊（说明只是例行公事）。 */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
        {bySite.map(([siteId, g]) => {
          const share = g.count / forecasts
          return (
            <div key={siteId} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9.5, color: p.textDim, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ flex: '0 0 34px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{siteId}</span>
              <span style={{ flex: '1 1 auto', height: 8, background: p.panelLine, borderRadius: 2, overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${share * 100}%`, background: p.accent, opacity: 0.75, borderRadius: 2 }} />
              </span>
              <span style={{ flex: '0 0 30px', textAlign: 'right', color: p.textFaint }}>{g.count}次</span>
              <span style={{ flex: '0 0 46px', textAlign: 'right', color: p.textFaint }}>+{g.gain.toFixed(2)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}


/**
 * 辖区统计：按街道聚合十站，回答「哪个辖区最紧张」。
 *
 * 「地图分区」屏若只放一个单站详情（观测点），会有一半高度空着——
 * 单站永远只有四个数。而分区屏要回答的不是「某个站怎么样」，
 * 而是「几个街道里该先顾哪个」，所以这里按 district 聚合：
 * 最深积水、平均涨速、超阈站数、最紧张的那个站。
 *
 * 聚合口径三条：
 *   - 积水深按**最深**取，不做平均——街道内一个涵洞淹了就是淹了，
 *     平均会被旁边没淹的站摊平，读起来像没事；
 *   - 涨速按平均（它代表整片区域还在不在持续上涨）；
 *   - 排序按「等级优先、同级比深度」，与地图气泡同一套可见顺序。
 */
export interface DistrictRow {
  readonly siteId: string
  readonly name: string
  readonly district: string
  readonly level: 'none' | 'blue' | 'yellow' | 'orange' | 'red'
  readonly depth: number
  readonly slope: number
  readonly rain: number
}

const RANK: Record<string, number> = { none: 0, blue: 1, yellow: 2, orange: 3, red: 4 }

export function DistrictStats({ rows, p, levelLabel }: { rows: readonly DistrictRow[]; p: Palette; levelLabel: Record<string, string> }) {
  if (!rows.length) return <div style={{ fontSize: 11, color: p.textFaint }}>等待监测数据</div>

  const byDistrict = new Map<string, DistrictRow[]>()
  for (const r of rows) {
    const list = byDistrict.get(r.district) ?? []
    list.push(r)
    byDistrict.set(r.district, list)
  }

  const groups = Array.from(byDistrict.entries())
    .map(([district, list]) => {
      const worst = [...list].sort((a, b) => RANK[b.level] - RANK[a.level] || b.depth - a.depth)[0]
      const maxDepth = Math.max(...list.map((x) => x.depth))
      const avgSlope = list.reduce((a, b) => a + b.slope, 0) / list.length
      const over = list.filter((x) => RANK[x.level] > 0).length
      return { district, n: list.length, worst, maxDepth, avgSlope, over }
    })
    .sort((a, b) => RANK[b.worst.level] - RANK[a.worst.level] || b.maxDepth - a.maxDepth)

  const maxD = Math.max(...groups.map((g) => g.maxDepth), 0.1)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 5 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '86px 1fr 52px 46px', gap: 6, fontSize: 9, color: p.textFaint, letterSpacing: 0.4 }}>
        <span>街道</span>
        <span>最深积水（条长按街道最大值）</span>
        <span style={{ textAlign: 'right' }}>1h 变幅</span>
        <span style={{ textAlign: 'right' }}>超阈</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {groups.map((g) => (
          <div key={g.district} style={{ flex: '1 1 0', display: 'grid', gridTemplateColumns: '86px 1fr 52px 46px', gap: 6, alignItems: 'center', minHeight: 0 }}>
            <span style={{ fontSize: 10.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${g.district} · ${g.n} 站`}>
              {g.district}
              <span style={{ color: p.textFaint, fontSize: 9 }}> ·{g.n}站</span>
            </span>
            <span style={{ position: 'relative', height: 13, background: p.panelLine, borderRadius: 3, overflow: 'hidden' }}>
              <span
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: `${(g.maxDepth / maxD) * 100}%`,
                  background: p.level[g.worst.level],
                  borderRadius: 3,
                  opacity: 0.82,
                }}
              />
              <span style={{ position: 'absolute', left: 5, top: 0, lineHeight: '13px', fontSize: 9.5, color: '#fff', fontVariantNumeric: 'tabular-nums' }}>
                {g.maxDepth.toFixed(2)}m
              </span>
            </span>
            {/* trend1h 是「1 小时水位变化量」（Delta，单位 m，正涨负退），
                不是速度（m/h）。原列名写「涨速」会让人以为单位是 m/h，
                并且三位小数在这个量级上过细，两位够看。 */}
            <b style={{ fontSize: 10.5, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: g.avgSlope > 0.02 ? p.levelInk.orange : g.avgSlope < -0.02 ? p.levelInk.blue : p.textDim }}>
              {g.avgSlope >= 0 ? '+' : ''}
              {g.avgSlope.toFixed(2)}
            </b>
            <span style={{ fontSize: 10.5, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: g.over ? p.levelInk.red : p.textFaint }}>
              {g.over}/{g.n}
            </span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 9, color: p.textFaint, display: 'flex', gap: 10 }}>
        <span>
          最紧张：<b style={{ color: p.levelInk[groups[0].worst.level] }}>{groups[0].worst.name}</b>
          <span style={{ marginLeft: 4 }}>{levelLabel[groups[0].worst.level]}</span>
        </span>
        <span style={{ marginLeft: 'auto' }}>深按最深 · 变幅按均值（m/1h）</span>
      </div>
    </div>
  )
}
