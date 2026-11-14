import { useState } from 'react'
import {
  useAdoptModel,
  useDecisions,
  useEvalPairs,
  useMetrics,
  useModelVersions,
  useRetrain,
  useRetrainStatus,
} from '../../data/queries'
import { useSession } from '../../view/useSession'
import { HORIZONS, horizonLabel } from '../../domain/forecast'
import {
  MODEL_FAMILIES,
  MODEL_HINT,
  MODEL_LABEL,
  regressions,
  sortedRows,
  type MetricRow,
  type ModelFamily,
} from '../../domain/metrics'
import { ROLE_LABEL, can, minRoleFor } from '../../domain/auth'
import { fmtDuration, fmtPct, fmtTime } from '../../domain/format'
import { Block, Figure, Nothing, Pill, Ruler, Shimmer } from '../kit'
import { W } from '../visual'
import type { StageCtx } from '../ctx'

/**
 * 舞台：模型可信度。
 *
 * 这一屏要回答的问题是「**模型凭什么可信**」，不是「模型的 RMSE 是多少」。
 * 数字只是证据，判据是三个口径能不能互相印证：
 *
 * 1. **离线指标**：在 12 天历史验证集上算出来的。它能被刷——调特征、调权重、
 *    多试几个版本挑最好看的那个，都能让它变漂亮，而它对「现在准不准」零承诺。
 * 2. **在线滚动**：最近 N 小时真实发生的、已结算的预测误差。**只有这个能证伪离线指标**，
 *    因为它不接受挑选：样本是自然流过来的，跑完就结算。
 * 3. **配对**：某一条预测具体错多少。用来找系统性偏差（例如总是高估退水速度）。
 *
 * 把它们合成一个「准确率 92%」是本项目反复踩过的坑：三个口径的分母完全不同，
 * 合起来之后哪个都不成立。所以这一屏**结构上就不给合并的机会**——三块各自成区，
 * 各自写清分母是什么。
 *
 * 第二件纪律：四个模型族要**同列对比 skill**，而不是只夸融合模型。
 * 让用户看见线性外推的 skill 是负的（−0.24 → −3.27，事件样本上更差），
 * 比在文案里说「线性外推不行」有用得多——负号是它自己的证据。
 */

/**
 * PICP90 的单位判断（这一屏唯一的量纲陷阱）。
 *
 * 引擎 sidecar 输出的 JSON 是**百分数**：`"picp90": 92.36`（实测 engine/data/metrics.json）；
 * 而 domain 层 MetricRow.picp90 的注释约定是**比例**（0.9236，理想值 0.9）。
 * 归一化已经在 `web/src/data/adapters.ts:387` 里做了：
 *
 *   picp90: num(d.picp90) > 1.5 ? num(d.picp90) / 100 : num(d.picp90)
 *
 * 也就是说——**从 hook 拿到的 picp90 一定是比例**，页面直接用 fmtPct 乘 100 显示即可，
 * 既不能再除一次 100，也不能自己乘 100 之后当百分数用（那会显示成 "9236.0%"，
 * 这个错本项目已经犯过一次）。
 *
 * 这里仍然兜一层 `> 1.5` 的除法：万一日后有人绕开 adapter 直接把原始 DTO 塞进来，
 * 最坏结果也只是显示正确，而不是显示一个荒唐的数。判断依据写在这里，不留猜的余地。
 */
function picp90Text(v: number): string {
  const ratio = v > 1.5 ? v / 100 : v
  return fmtPct(ratio)
}

/** skill 带符号，正负一眼分得出。 */
function skillText(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(3)}`
}

export function TrustStage({ ctx }: { ctx: StageCtx }) {
  const metrics = useMetrics(6)
  const pairs = useEvalPairs(12)
  const decisions = useDecisions(40)
  const versions = useModelVersions()
  const retrainStatus = useRetrainStatus()
  const retrain = useRetrain()
  const adopt = useAdoptModel()
  const session = useSession()

  // 采纳是不可撤销的业务动作：全城等级会立刻按新模型重算，回滚只能靠再采纳一次。
  // 所以不用 window.confirm（项目禁止），就地展开一条确认带——它比弹窗更明确地
  // 说明了「会发生什么」，而且不会被误点穿透。
  const [confirmAdopt, setConfirmAdopt] = useState<string | null>(null)

  const canAdopt = can(session.user, 'model:adopt')
  const canRetrain = can(session.user, 'model:retrain')

  if (metrics.isLoading || !metrics.data) {
    return (
      <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex', padding: 12 }}>
        <Block title="模型可信度" grow>
          {metrics.error ? (
            <Nothing
              why="读不到模型指标"
              hint={`指标来自 ${'/api/metrics'}，它由引擎 sidecar 训练完写回。顶栏链路指示能看出是引擎没起来还是这一层没通。`}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Shimmer h={70} />
              <Shimmer h={150} />
            </div>
          )}
        </Block>
      </div>
    )
  }

  const m = metrics.data
  const latest = m.latest
  const bad = regressions(latest)
  const blendRows = sortedRows(latest.metrics.blend)
  const h3 = blendRows.find((r) => r.horizonMin === 180) ?? blendRows[0] ?? null
  const h12 = blendRows.find((r) => r.horizonMin === 720) ?? blendRows[blendRows.length - 1] ?? null
  const rollRows = HORIZONS.map((h) => ({ h: h as number, s: m.rolling[String(h)] })).filter(
    (x): x is { h: number; s: NonNullable<(typeof m.rolling)[string]> } => !!x.s,
  )
  const roll3 = rollRows.find((r) => r.h === 180) ?? null

  const pairList = (pairs.data ?? []).filter((p) => p.actual !== null)
  const pairStats = HORIZONS.map((h) => {
    const rows = pairList.filter((p) => p.horizonMin === h)
    if (rows.length === 0) return { h: h as number, n: 0, mae: 0, bias: 0, cover: 0 }
    let sumAbs = 0
    let sumErr = 0
    let inside = 0
    for (const p of rows) {
      const a = p.actual as number
      const err = p.yhat - a
      sumAbs += Math.abs(err)
      sumErr += err
      if (a >= p.lower && a <= p.upper) inside += 1
    }
    return {
      h: h as number,
      n: rows.length,
      mae: sumAbs / rows.length,
      bias: sumErr / rows.length,
      cover: inside / rows.length,
    }
  }).filter((r) => r.n > 0)

  const dec = decisions.data ?? []
  const suppressed = dec.filter((d) => !d.shouldForecast).length
  const gains = dec.map((d) => d.correctionGain).filter((g): g is number => g !== null)
  const avgGain = gains.length > 0 ? gains.reduce((s, g) => s + g, 0) / gains.length : null
  const latestDecision = dec[0] ?? null

  return (
    <div
      style={{
        flex: '1 1 0',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 12,
        overflowY: 'auto',
      }}
    >
      {/* 结论先行：一段人话 + 三个不同口径的数并排。
          并排而不是合并，本身就是这一屏的主张。 */}
      <Block
        title="凭什么信它"
        sub={`当前激活 ${latest.version} · 训练于 ${fmtTime(latest.trainedAt, 'MM-DD HH:mm')} · ${latest.folds} 折分块验证`}
        aside={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {/* 可信度回答「模型准不准」，规则回答「准的数怎么变成等级」。
                两件事互为两半：水位再准，规则配错了结论一样是错的。
                所以入口放在这里——用户正在琢磨「凭什么信」，正是要追问「判据是什么」的时候。 */}
            <button
              type="button"
              onClick={() => ctx.goStage({ kind: 'rules' })}
              data-trust-link="rules"
              title="看三因子权重与分档怎么把水位变成四级预警（改前可先预演）"
              style={{
                border: `1px solid ${W.line}`,
                background: W.stage,
                borderRadius: 5,
                padding: '2px 7px',
                fontSize: 10.5,
                color: W.accent,
                cursor: 'pointer',
                font: 'inherit',
              }}
            >
              判据是什么 →
            </button>
            <Pill tone={bad.length === 0 ? W.ok : W.warn}>
              {bad.length === 0 ? '各预见期均优于持久化' : `${bad.length} 项低于持久化基线`}
            </Pill>
          </span>
        }
        pad={10}
      >
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.75, color: W.ink2 }}>
          {h3 && h12 ? (
            <>
              融合模型在 3h 上比「水位不变」准 {(Math.max(0, h3.skill) * 100).toFixed(0)}%，
              但 12h 掉到 {(Math.max(0, h12.skill) * 100).toFixed(0)}%
              {h12.skill < h3.skill
                ? '，说明长预见期不可轻信：越往后模型越接近「假设水位不变」，它的价值主要在 1~3 小时。'
                : '。'}
              {roll3 ? (
                <>
                  {' '}
                  最近 {m.rollingWindowH}h 的实盘口径是{' '}
                  <span style={{ color: roll3.s.skill > 0 ? W.ok : W.warn }}>
                    {skillText(roll3.s.skill)}
                  </span>
                  （n={roll3.s.n}）——
                  {roll3.s.skill > 0
                    ? '和离线指标方向一致，离线没在吹。'
                    : '离线为正而实盘为负，说明离线指标撑不住，别拿它对外报数。'}
                </>
              ) : null}
            </>
          ) : (
            '这套指标里没有融合模型的记录，下面只能看别的模型族。'
          )}
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            gap: 10,
            alignItems: 'end',
            marginTop: 10,
            paddingTop: 8,
            borderTop: `1px solid ${W.lineSoft}`,
          }}
        >
          <Figure
            value={h3 ? skillText(h3.skill) : '—'}
            label="离线 skill（3h）"
            size={22}
            tone={h3 && h3.skill > 0 ? W.ok : W.warn}
            hint="可刷，不证明现在准"
          />
          <Figure
            value={roll3 ? skillText(roll3.s.skill) : '—'}
            label="在线 skill（3h）"
            size={22}
            tone={roll3 && roll3.s.skill > 0 ? W.ok : W.warn}
            hint={roll3 ? `近 ${m.rollingWindowH}h · n=${roll3.s.n}` : '还没有结算样本'}
          />
          <Figure
            value={h3 ? picp90Text(h3.picp90) : '—'}
            label="PICP90（3h）"
            size={22}
            tone={h3 && Math.abs((h3.picp90 > 1.5 ? h3.picp90 / 100 : h3.picp90) - 0.9) < 0.05 ? W.ok : W.warn}
            hint="90% 区间的实际覆盖率"
          />
          <Figure
            value={latest.nFeatures}
            unit="维"
            label={`特征 · ${latest.nTrain.toLocaleString()} 训练样本`}
            size={22}
            hint={`训练耗时 ${latest.trainSeconds.toFixed(1)}s`}
          />
        </div>
      </Block>

      {/* 口径一（离线）与口径二（在线）并排。两块的标题里就写着它们的分母，
          防止有人把两列数放在一起比大小。 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)',
          gap: 12,
          alignItems: 'start',
        }}
      >
        <Block
          title="口径一 · 离线指标"
          sub="12 天历史验证集，同批样本同一套特征，只换模型族"
          aside={<Pill tone={W.ink4}>可被刷</Pill>}
          pad={10}
        >
          <FamilyTable metrics={latest.metrics} onTerm={(k, n) => ctx.openMetric(k, n)} />

          {/* 事件样本单独一张：决定「报警对不对」的只有这批。 */}
          <div style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: W.ink2 }}>事件样本 skill</span>
              <span style={{ fontSize: 10.5, color: W.ink4 }}>
                只取预见期末确实超了蓝阈的样本
              </span>
            </div>
            <FamilyTable metrics={latest.metrics} field="eventSkill" compact />
          </div>

          <div
            style={{
              marginTop: 8,
              paddingTop: 6,
              borderTop: `1px solid ${W.lineSoft}`,
              fontSize: 10.5,
              lineHeight: 1.65,
              color: W.ink3,
            }}
          >
            {(MODEL_FAMILIES as readonly ModelFamily[]).map((f) => (
              <div key={f} style={{ display: 'flex', gap: 5 }}>
                <span style={{ color: W.ink2, flex: '0 0 auto' }}>{MODEL_LABEL[f]}：</span>
                <span>{MODEL_HINT[f]}</span>
              </div>
            ))}
            <div style={{ marginTop: 4, color: bad.some((b) => b.family === 'linear') ? W.bad : W.ink3 }}>
              线性外推的 skill 是负的
              {bad.some((b) => b.family === 'linear')
                ? `（最低 ${bad.filter((b) => b.family === 'linear')[0].skill.toFixed(2)}）——比什么都不做还差，不配做融合基线。`
                : '（本版已剔除）。'}
            </div>
          </div>
        </Block>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <Block
            title="口径二 · 在线滚动"
            sub={`近 ${m.rollingWindowH}h 已结算的真实预测`}
            aside={<Pill tone={W.ok}>唯一能证伪离线</Pill>}
            pad={10}
          >
            {rollRows.length === 0 ? (
              <Nothing
                why="还没有已结算的预测"
                hint="1h 预见期要先走完一轮才会结算，约 1 分钟。这一块空着就代表离线指标目前无法被验证。"
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '44px 40px 1fr 1fr 52px',
                    gap: 4,
                    fontSize: 10,
                    color: W.ink4,
                    paddingBottom: 3,
                    borderBottom: `1px solid ${W.lineSoft}`,
                  }}
                >
                  <span>预见期</span>
                  <span style={{ textAlign: 'right' }}>n</span>
                  <span style={{ textAlign: 'right' }}>RMSE</span>
                  <span style={{ textAlign: 'right' }}>基线</span>
                  <span style={{ textAlign: 'right' }}>skill</span>
                </div>
                {rollRows.map(({ h, s }) => (
                  <div
                    key={h}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '44px 40px 1fr 1fr 52px',
                      gap: 4,
                      alignItems: 'baseline',
                      padding: '4px 0',
                      borderBottom: `1px solid ${W.lineSoft}`,
                      fontFamily: W.mono,
                      fontVariantNumeric: 'tabular-nums',
                      fontSize: 11,
                    }}
                  >
                    <span style={{ color: W.ink2 }}>{horizonLabel(h)}</span>
                    <span style={{ textAlign: 'right', color: W.ink4 }}>{s.n}</span>
                    <span style={{ textAlign: 'right', color: W.ink }}>{s.rmse.toFixed(4)}</span>
                    <span style={{ textAlign: 'right', color: W.ink4 }}>
                      {s.baselineRmse.toFixed(4)}
                    </span>
                    <span
                      style={{
                        textAlign: 'right',
                        fontWeight: 600,
                        color: s.skill > 0 ? W.ok : W.bad,
                      }}
                    >
                      {skillText(s.skill)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 6, fontSize: 10.5, lineHeight: 1.6, color: W.ink3 }}>
              skill 的分母是持久化基线（发布时刻的水位保持不变），不是实际值的标准差。
              曾用实际值标准差当分母，跨站高程差 3.6~16.3m 远大于预测误差，skill 被虚抬到 0.98。
            </div>
          </Block>

          <Block title="口径三 · 配对" sub={`近 12h 已到期结算的 ${pairList.length} 对`} pad={10}>
            {pairStats.length === 0 ? (
              <Nothing
                why="还没有配对样本"
                hint="预测到期后才会结算成一对。这一块空着时，上面两张表的数字都只是统计量，没有逐条证据。"
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '44px 40px 1fr 1fr 1fr',
                    gap: 4,
                    fontSize: 10,
                    color: W.ink4,
                    paddingBottom: 3,
                    borderBottom: `1px solid ${W.lineSoft}`,
                  }}
                >
                  <span>预见期</span>
                  <span style={{ textAlign: 'right' }}>n</span>
                  <span style={{ textAlign: 'right' }}>MAE</span>
                  <span style={{ textAlign: 'right' }}>偏差</span>
                  <span style={{ textAlign: 'right' }}>区间命中</span>
                </div>
                {pairStats.map((p) => (
                  <div
                    key={p.h}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '44px 40px 1fr 1fr 1fr',
                      gap: 4,
                      alignItems: 'baseline',
                      padding: '4px 0',
                      borderBottom: `1px solid ${W.lineSoft}`,
                      fontFamily: W.mono,
                      fontVariantNumeric: 'tabular-nums',
                      fontSize: 11,
                    }}
                  >
                    <span style={{ color: W.ink2 }}>{horizonLabel(p.h)}</span>
                    <span style={{ textAlign: 'right', color: W.ink4 }}>{p.n}</span>
                    <span style={{ textAlign: 'right', color: W.ink }}>{p.mae.toFixed(3)}</span>
                    <span style={{ textAlign: 'right', color: Math.abs(p.bias) > p.mae ? W.warn : W.ink3 }}>
                      {p.bias >= 0 ? '+' : ''}
                      {p.bias.toFixed(3)}
                    </span>
                    <span
                      style={{
                        textAlign: 'right',
                        color: Math.abs(p.cover - 0.9) < 0.06 ? W.ok : W.warn,
                      }}
                    >
                      {fmtPct(p.cover, 0)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 6, fontSize: 10.5, lineHeight: 1.6, color: W.ink3 }}>
              偏差为正表示模型高估水位。区间命中率是配对样本上重算出来的，
              它与离线 PICP90 对不上时，说明那一批离线样本和这两小时的天气不一样 ——
              这时以配对命中率为准。
            </div>
          </Block>
        </div>
      </div>

      {/* PICP90 单独给一条可视带：它是「区间可不可信」的唯一指标，
          理想值 90，低于 90 说明区间太窄、会漏掉真实值。 */}
      <Block
        title="区间覆盖率 PICP90"
        sub="90% 区间的实际覆盖率 · 理想 90% · 低了说明区间太窄"
        aside={
          <button
            type="button"
            onClick={() => ctx.openMetric('picp90', '区间覆盖率 PICP90')}
            style={{
              border: 0,
              background: 'none',
              padding: 0,
              font: 'inherit',
              fontSize: 10.5,
              color: W.accent,
              cursor: 'pointer',
            }}
          >
            这个指标怎么读 →
          </button>
        }
        pad={10}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
          {blendRows.map((r) => {
            const ratio = r.picp90 > 1.5 ? r.picp90 / 100 : r.picp90
            const off = ratio < 0.9
            return (
              <div key={r.horizonMin} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 11, color: W.ink3 }}>{horizonLabel(r.horizonMin)}</span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 13,
                      fontWeight: 600,
                      fontFamily: W.mono,
                      fontVariantNumeric: 'tabular-nums',
                      color: off ? W.warn : W.ok,
                    }}
                  >
                    {picp90Text(r.picp90)}
                  </span>
                </div>
                <Ruler
                  ratio={ratio}
                  color={off ? W.warn : W.ok}
                  height={6}
                  marks={[{ at: 0.9, color: W.ink }]}
                />
                <span style={{ fontSize: 10, color: W.ink4 }}>
                  {off ? `漏掉 ${((0.9 - ratio) * 100).toFixed(1)}% 的真实值` : '达标'}
                  {' · '}区间宽 {(r.pinaw * 100).toFixed(1)}cm
                </span>
              </div>
            )
          })}
        </div>
        <div style={{ marginTop: 8, fontSize: 10.5, lineHeight: 1.65, color: W.ink3 }}>
          引擎给的是百分数（<span style={{ fontFamily: W.mono }}>92.36</span>），domain 层约定的是比例（
          <span style={{ fontFamily: W.mono }}>0.9236</span>）。归一化在{' '}
          <span style={{ fontFamily: W.mono }}>data/adapters.ts</span> 里做，页面只负责乘 100 显示 ——
          两边都当比例时，界面上出现过「9236.0%」这种数。
        </div>
      </Block>

      {/* 决策日志：模型自己承认「这段时间别用它」的地方，也是可信度的一部分。 */}
      <Block
        title="模型在哪放弃预测"
        sub={`最近 ${dec.length} 条逐站决策 · ${suppressed} 条判为「水位平稳，持久化即可」`}
        aside={
          avgGain !== null ? (
            <Pill tone={W.ink4}>平均修正增益 {avgGain.toFixed(3)}</Pill>
          ) : undefined
        }
        pad={10}
      >
        {dec.length === 0 ? (
          <Nothing why="还没有决策记录" hint="每轮预测都会留一条决策日志，用来解释「为什么这个站用了/没用模型」。" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {latestDecision && (
              <div style={{ fontSize: 11.5, lineHeight: 1.65, color: W.ink2 }}>
                <span style={{ fontFamily: W.mono, color: W.ink4 }}>
                  {fmtTime(latestDecision.ts, 'HH:mm')}
                </span>{' '}
                <button
                  type="button"
                  onClick={() =>
                    ctx.goStage({ kind: 'site', siteId: latestDecision.siteId })
                  }
                  style={{
                    border: 0,
                    background: 'none',
                    padding: 0,
                    font: 'inherit',
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: W.ink,
                    cursor: 'pointer',
                  }}
                >
                  {latestDecision.siteId}
                </button>{' '}
                <Pill tone={latestDecision.shouldForecast ? W.ok : W.ink4}>
                  {latestDecision.shouldForecast ? '用模型' : '退化到持久化'}
                </Pill>{' '}
                <span style={{ color: W.ink3 }}>{latestDecision.reason}</span>
              </div>
            )}
            <div style={{ fontSize: 10.5, color: W.ink4, lineHeight: 1.6 }}>
              修炼结论：一个模型愿意说「这里我用不上」，比它在所有地方都硬给一个数更可信。
              判据来自模型自身特征（质量位、雨强、水位距阈值的余量），不是事后挑出来的。
            </div>
          </div>
        )}
      </Block>

      {/* 版本治理 + 重训。两块都必须在这屏上：能采纳却不能重训，
          或者能重训却不能回滚，都会让「换模型」变成一个赌运气的动作。 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
          gap: 12,
          alignItems: 'start',
        }}
      >
        <Block
          title="版本治理"
          sub="能采纳、能回滚 —— 一次重训变差不该只能再训一次赌运气"
          aside={
            <Pill tone={W.ink4}>{(versions.data?.versions ?? []).length} 个版本</Pill>
          }
          pad={10}
        >
          {!versions.data ? (
            <Shimmer h={80} />
          ) : versions.data.versions.length === 0 ? (
            <Nothing why="还没有可采纳的版本" hint="训练完成后会在这里出现，采纳即热切换。" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.35fr 66px 60px 56px 46px 1fr',
                  gap: 4,
                  fontSize: 10,
                  color: W.ink4,
                  paddingBottom: 3,
                  borderBottom: `1px solid ${W.lineSoft}`,
                }}
              >
                <span>版本</span>
                <span>训练时间</span>
                <span style={{ textAlign: 'right' }}>3h RMSE</span>
                <span style={{ textAlign: 'right' }}>3h skill</span>
                <span style={{ textAlign: 'right' }}>耗时</span>
                <span />
              </div>
              {versions.data.versions.map((v) => (
                <div key={v.version}>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1.35fr 66px 60px 56px 46px 1fr',
                      gap: 4,
                      alignItems: 'baseline',
                      padding: '4px 0',
                      borderBottom: `1px solid ${W.lineSoft}`,
                      fontFamily: W.mono,
                      fontVariantNumeric: 'tabular-nums',
                      fontSize: 10.5,
                    }}
                  >
                    <span
                      style={{
                        color: v.active ? W.ink : W.ink2,
                        fontWeight: v.active ? 600 : 400,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={v.version}
                    >
                      {v.version}
                      {v.active ? ' ·在用' : ''}
                    </span>
                    <span style={{ color: W.ink4 }}>
                      {v.trainedAt ? fmtTime(v.trainedAt, 'MM-DD HH:mm') : '—'}
                    </span>
                    <span style={{ textAlign: 'right', color: W.ink3 }}>
                      {v.rmse3h === null ? '—' : v.rmse3h.toFixed(4)}
                    </span>
                    <span
                      style={{
                        textAlign: 'right',
                        color:
                          v.skill3h === null ? W.ink4 : v.skill3h > 0 ? W.ok : W.bad,
                      }}
                    >
                      {v.skill3h === null ? '—' : skillText(v.skill3h)}
                    </span>
                    <span style={{ textAlign: 'right', color: W.ink4 }}>
                      {v.trainSeconds === null ? '—' : `${v.trainSeconds.toFixed(0)}s`}
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      {v.active ? (
                        <Pill tone={W.ok}>当前</Pill>
                      ) : (
                        <button
                          type="button"
                          disabled={!canAdopt || adopt.isPending}
                          title={
                            canAdopt
                              ? '采纳这个版本（会立刻重算全城等级）'
                              : `需要${ROLE_LABEL[minRoleFor('model:adopt')]}及以上`
                          }
                          onClick={() => setConfirmAdopt(v.version)}
                          style={{
                            border: 0,
                            background: 'none',
                            padding: 0,
                            font: 'inherit',
                            fontSize: 10.5,
                            color: canAdopt ? W.accent : W.ink4,
                            cursor: canAdopt ? 'pointer' : 'not-allowed',
                          }}
                        >
                          采纳
                        </button>
                      )}
                    </span>
                  </div>

                  {/* 就地确认带。写明后果与不可撤销性，比弹窗更有信息量。 */}
                  {confirmAdopt === v.version && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                        margin: '4px 0 6px',
                        padding: '6px 8px',
                        border: `1px solid ${W.warn}`,
                        borderRadius: 6,
                        background: W.levelWash.yellow,
                      }}
                    >
                      <span style={{ fontSize: 11, color: W.ink2, lineHeight: 1.55, flex: '1 1 200px' }}>
                        采纳 <span style={{ fontFamily: W.mono }}>{v.version}</span> 会立刻用它重算全城十个站的等级，
                        下一轮预测（≤60 秒）生效。这个动作不可撤销，只能靠再采纳一个版本覆盖。
                      </span>
                      <button
                        type="button"
                        disabled={adopt.isPending}
                        onClick={() => {
                          adopt.mutate(v.version, {
                            onSuccess: () => {
                              setConfirmAdopt(null)
                              ctx.toast('ok', `已采纳 ${v.version}，下一轮预测生效`)
                            },
                            onError: (e) => {
                              setConfirmAdopt(null)
                              ctx.toast('err', `采纳失败：${(e as Error).message}`)
                            },
                          })
                        }}
                        style={{
                          border: 0,
                          borderRadius: 5,
                          padding: '4px 10px',
                          font: 'inherit',
                          fontSize: 11,
                          color: '#fff',
                          background: W.warn,
                          cursor: adopt.isPending ? 'wait' : 'pointer',
                        }}
                      >
                        {adopt.isPending ? '切换中…' : '确认采纳'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmAdopt(null)}
                        style={{
                          border: `1px solid ${W.lineStrong}`,
                          borderRadius: 5,
                          padding: '3px 9px',
                          font: 'inherit',
                          fontSize: 11,
                          color: W.ink2,
                          background: 'transparent',
                          cursor: 'pointer',
                        }}
                      >
                        取消
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 6, fontSize: 10.5, color: W.ink4, lineHeight: 1.6 }}>
            新版刚训完时 3h 指标可能还是空的（结果还没回写），所以「—」不代表这个版本更差；
            看指标要等下一轮指标刷新。
          </div>
        </Block>

        <Block
          title="重训"
          sub="约 90 秒 · 完成后自动热切换，不需要重启引擎"
          aside={
            retrainStatus.data ? (
              <Pill
                tone={
                  retrainStatus.data.status === 'running'
                    ? W.warn
                    : retrainStatus.data.status === 'failed'
                      ? W.bad
                      : retrainStatus.data.status === 'done'
                        ? W.ok
                        : W.ink4
                }
              >
                {retrainStatus.data.status === 'running'
                  ? '训练中'
                  : retrainStatus.data.status === 'done'
                    ? '已完成'
                    : retrainStatus.data.status === 'failed'
                      ? '失败'
                      : '空闲'}
              </Pill>
            ) : undefined
          }
          pad={10}
        >
          <button
            type="button"
            disabled={
              !canRetrain || retrain.isPending || retrainStatus.data?.status === 'running'
            }
            title={
              canRetrain
                ? '用最新数据重训一版'
                : `需要${ROLE_LABEL[minRoleFor('model:retrain')]}及以上`
            }
            onClick={() => {
              retrain.mutate(undefined, {
                onSuccess: () => ctx.toast('info', '重训已开始，约 90 秒后自动热切换'),
                onError: (e) => ctx.toast('err', `重训失败：${(e as Error).message}`),
              })
            }}
            style={{
              width: '100%',
              padding: '6px 0',
              font: 'inherit',
              fontSize: 12,
              color: canRetrain ? '#fff' : W.ink4,
              background: canRetrain ? W.accent : W.lineSoft,
              border: 0,
              borderRadius: 5,
              cursor: canRetrain ? 'pointer' : 'not-allowed',
            }}
          >
            {retrainStatus.data?.status === 'running'
              ? '训练中…（每 3 秒刷新）'
              : retrain.isPending
                ? '提交中…'
                : '用最新数据重训'}
          </button>

          {retrainStatus.data && retrainStatus.data.status !== 'idle' ? (
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {retrainStatus.data.version && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                  <span style={{ fontSize: 11, color: W.ink3 }}>产出</span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 11,
                      color: W.ink,
                      fontFamily: W.mono,
                    }}
                  >
                    {retrainStatus.data.version}
                  </span>
                </div>
              )}
              {retrainStatus.data.seconds !== null && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                  <span style={{ fontSize: 11, color: W.ink3 }}>用时</span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 11,
                      color: W.ink2,
                      fontFamily: W.mono,
                    }}
                  >
                    {retrainStatus.data.seconds.toFixed(1)}s
                  </span>
                </div>
              )}
              {retrainStatus.data.error && (
                <div style={{ fontSize: 10.5, color: W.bad, lineHeight: 1.6 }}>
                  {retrainStatus.data.error}
                </div>
              )}
            </div>
          ) : (
            <div style={{ marginTop: 6, fontSize: 10.5, color: W.ink4, lineHeight: 1.6 }}>
              这一班还没重训过。重训是可撤销的：新版本生成后不会自动生效，
              要在左边的版本列表里显式采纳才会切换。
            </div>
          )}

          {latest.trainSeconds > 0 && (
            <div style={{ marginTop: 6, paddingTop: 5, borderTop: `1px solid ${W.lineSoft}` }}>
              <div style={{ fontSize: 10.5, color: W.ink4 }}>
                上一版训练耗时 {fmtDuration(latest.trainSeconds)} · {latest.nValid.toLocaleString()} 条验证样本
              </div>
            </div>
          )}
        </Block>
      </div>
    </div>
  )
}

/**
 * 四模型族 × 四预见期的 skill 矩阵。
 *
 * 为什么是矩阵而不是「每个模型一张卡」：可信度问题本质是**相对**的
 * （它比不用模型好多少），只有把四族放在同一列上，负号才刺眼。
 * 负值同时用红字和 `↓` 标出，因为红字在投影仪上会掉色，符号不会。
 */
function FamilyTable({
  metrics,
  field = 'skill',
  compact,
  onTerm,
}: {
  metrics: Readonly<Record<string, readonly MetricRow[]>>
  field?: 'skill' | 'eventSkill'
  compact?: boolean
  onTerm?: (key: string, name: string) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '78px repeat(4, minmax(0, 1fr))',
          gap: 4,
          fontSize: 10,
          color: W.ink4,
          paddingBottom: 3,
          borderBottom: `1px solid ${W.lineSoft}`,
        }}
      >
        <span>
          {field === 'skill' && onTerm ? (
            <button
              type="button"
              onClick={() => onTerm('skill', '技巧分 skill')}
              title="skill = 1 − 本模型误差 / 持久化误差"
              style={{
                border: 0,
                background: 'none',
                padding: 0,
                font: 'inherit',
                fontSize: 10,
                color: W.accent,
                cursor: 'pointer',
              }}
            >
              模型族 · skill
            </button>
          ) : (
            '模型族'
          )}
        </span>
        {HORIZONS.map((h) => (
          <span key={h} style={{ textAlign: 'right' }}>
            {horizonLabel(h)}
          </span>
        ))}
      </div>
      {(MODEL_FAMILIES as readonly ModelFamily[]).map((f) => {
        const rows = sortedRows(metrics[f])
        const isBlend = f === 'blend'
        const isBrake = f === 'linear'
        return (
          <div
            key={f}
            style={{
              display: 'grid',
              gridTemplateColumns: '78px repeat(4, minmax(0, 1fr))',
              gap: 4,
              alignItems: 'baseline',
              padding: compact ? '2.5px 0' : '4px 0',
              borderBottom: `1px solid ${W.lineSoft}`,
              // 融合模型是当前在用的那个，给它一条左标线而不是底色——
              // 底色会和「负值高亮」抢注意力。
              borderLeft: isBlend ? `2px solid ${W.accent}` : '2px solid transparent',
              paddingLeft: isBlend ? 5 : 0,
              opacity: isBrake ? 0.92 : 1,
            }}
          >
            <span
              style={{
                fontSize: 10.5,
                color: isBlend ? W.ink : W.ink2,
                fontWeight: isBlend ? 600 : 400,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={MODEL_LABEL[f]}
            >
              {MODEL_LABEL[f]}
            </span>
            {HORIZONS.map((h) => {
              const row = rows.find((r) => r.horizonMin === h)
              const v = row ? row[field] : null
              const neg = v !== null && v < 0
              return (
                <span
                  key={h}
                  style={{
                    textAlign: 'right',
                    fontSize: 10.5,
                    fontFamily: W.mono,
                    fontVariantNumeric: 'tabular-nums',
                    fontWeight: neg ? 600 : 400,
                    color: v === null ? W.ink4 : neg ? W.bad : v > 0.3 ? W.ok : W.ink2,
                  }}
                  title={
                    neg
                      ? `${MODEL_LABEL[f]} 在 ${horizonLabel(h)} 上比「水位不变」还差`
                      : undefined
                  }
                >
                  {v === null ? '—' : neg ? `↓${v.toFixed(2)}` : skillText(v)}
                </span>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
