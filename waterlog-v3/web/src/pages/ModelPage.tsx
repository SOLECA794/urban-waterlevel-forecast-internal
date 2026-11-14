import { useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import {
  compareAt,
  fmtDuration,
  fmtPct,
  fmtTime,
  HORIZONS,
  horizonLabel,
  MODEL_FAMILIES,
  MODEL_HINT,
  MODEL_LABEL,
  regressions,
  sortedRows,
  type DecisionRow,
  type EvalPair,
  type MetricsBundle,
  type ModelVersion,
  type RetrainState,
  type RollingStat,
  type SimTime,
} from '../domain'
import {
  useAdoptModel,
  useDecisions,
  useEvalPairs,
  useMetrics,
  useModelVersions,
  useRetrain,
  useRetrainStatus,
} from '../data/queries'
import { EmptyState, SectionHead, Skeleton } from '../components/primitives/Bits'
import { StatCard } from '../components/primitives/Stat'
import { Icon } from '../components/primitives/Icons'
import { Tag } from '../components/domain/LevelChip'
import { FONT, SERIES, T } from '../utils/tokens'
import { SiteDrawer } from '../components/interactive/StationDetail'
import { Glossary } from '../components/interactive/Tooltip'

/**
 * 模型评估与版本治理。
 *
 * 三种口径必须分开看，混在一起就会得出错误结论：
 *   离线指标   —— 这个模型在历史数据上有多准（可以刷，不能证明现在准）
 *   在线滚动   —— 最近几小时实盘误差是多少（唯一能证伪离线指标的）
 *   预测-实际配对 —— 某一条预测具体错多少（看系统性偏差）
 *
 * 第四块是版本治理：能看历史版本、能采纳回滚。没有这个，模型只能「重训」不能「退回」，
 * 一次重训变差就只能靠再训一次赌运气。
 */
export function ModelPage() {
  const metrics = useMetrics(6)
  const versions = useModelVersions()
  const retrain = useRetrainStatus()
  const retrainMut = useRetrain()
  const adopt = useAdoptModel()
  const pairs = useEvalPairs(12)
  const decisions = useDecisions(40)
  const [msg, setMsg] = useState<string | null>(null)
  // 决策日志里点站点 → 开抽屉。这一条日志只说了「怎么算的」，
  // 用户接下来必问的是「算出来的数是多少、准不准」——那在站点抽屉里。
  const [siteId, setSiteId] = useState<string | null>(null)

  if (metrics.isLoading || !metrics.data) {
    return (
      <div className="space-y-3">
        <Skeleton h={64} />
        <Skeleton h={120} />
        <Skeleton h={200} />
      </div>
    )
  }

  const m = metrics.data
  const latest = m.latest
  const blendRows = sortedRows(latest.metrics.blend)
  const bad = regressions(latest)
  const rollingRows = HORIZONS.map((h) => ({ h: h as number, s: m.rolling[String(h)] })).filter(
    (x): x is { h: number; s: RollingStat } => !!x.s,
  )
  const pairList = pairs.data ?? []

  return (
    <div className="space-y-4">
      {/* 头部 */}
      <div className="card p-4">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Icon name="cpu" size={15} className="text-ink-2" />
              <span className="text-[13.5px] font-semibold text-ink">当前激活模型</span>
              <Tag tone="ai">{latest.version}</Tag>
            </div>
            <div className="text-[11px] text-ink-3 mt-1">
              训练于 {fmtTime(latest.trainedAt, 'MM-DD HH:mm:ss')} · 耗时 {latest.trainSeconds.toFixed(1)}s ·{' '}
              {latest.folds} 折分块交叉验证
            </div>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-1.5">
            <Tag tone="neutral">{latest.nTrain.toLocaleString()} 训练样本</Tag>
            <Tag tone="neutral">{latest.nFeatures} 维特征</Tag>
            <Tag tone={bad.length === 0 ? 'ok' : 'warn'}>
              {bad.length === 0 ? '全部预见期优于持久化' : `${bad.length} 项低于持久化`}
            </Tag>
          </div>
          <button
            className="btn"
            disabled={retrainMut.isPending || retrain.data?.status === 'running'}
            onClick={() => {
              setMsg(null)
              retrainMut.mutate(undefined, {
                onSuccess: () => setMsg('重训已开始（约 90 秒）。完成后会自动热切换，无需重启。'),
                onError: (e) => setMsg(`重训失败：${(e as Error).message}`),
              })
            }}
          >
            <Icon name="refresh" size={13} />
            {retrain.data?.status === 'running' ? '训练中…' : '重训模型'}
          </button>
        </div>

        {retrain.data && retrain.data.status !== 'idle' && (
          <div className="mt-2 rounded-control px-3 py-1.5 text-[11.5px] flex items-center gap-2" style={{ background: T.bgCanvas }}>
            <RetrainTag st={retrain.data} />
            <span className="text-ink-2">
              {retrain.data.status === 'running'
                ? '训练进行中，页面每 3 秒刷新状态。'
                : retrain.data.status === 'done'
                  ? `已产出 ${retrain.data.version}，用时 ${retrain.data.seconds?.toFixed(1) ?? '?'}s。`
                  : (retrain.data.error ?? '训练失败')}
            </span>
          </div>
        )}

        {msg && (
          <div className="mt-2 rounded-control px-3 py-2 text-[11.5px] flex items-start gap-2" style={{ background: T.aiWeak, color: T.aiInk }}>
            <Icon name="info" size={13} className="mt-0.5 shrink-0" />
            <span>{msg}</span>
          </div>
        )}

        <div className="grid grid-cols-4 gap-3 mt-3 stagger">
          {blendRows.map((r) => (
            <StatCard
              key={r.horizonMin}
              label={`${horizonLabel(r.horizonMin)} RMSE`}
              value={r.rmse.toFixed(3)}
              unit="m"
              icon="target"
              tone={r.skill > 0.3 ? 'blue' : 'neutral'}
              footer={`skill ${r.skill > 0 ? '+' : ''}${r.skill.toFixed(3)} · PICP90 ${fmtPct(r.picp90)}`}
            />
          ))}
        </div>
      </div>

      {/* 四模型对比 */}
      <div className="grid grid-cols-[1fr_1fr] gap-4 items-start">
        <div className="card p-4" data-tour="model-compare">
          <SectionHead
            title="四模型对比（全样本）"
            sub="同一批验证样本、同一套特征，只换模型族"
            icon="layers"
          />
          <MetricTable latest={latest} />
          <div className="mt-2 space-y-1">
            {MODEL_FAMILIES.map((f) => (
              <div key={f} className="text-[10.5px] text-ink-3 leading-snug flex gap-1.5">
                <span className="w-2 h-2 rounded-sm mt-1 shrink-0" style={{ background: SERIES[f] }} />
                <span>
                  <span className="text-ink-2 font-medium">{MODEL_LABEL[f]}：</span>
                  {MODEL_HINT[f]}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="card p-4">
          <SectionHead
            title="事件样本对比"
            sub="只取预见期末确实超了蓝阈的样本 —— 这批才决定报警对不对"
            icon="alertTriangle"
          />
          <EventTable latest={latest} />
          <div className="mt-2 rounded-control px-3 py-2 text-[11px] text-ink-2 leading-relaxed" style={{ background: T.bgCanvas }}>
            把 12 天全样本混在一起时，大量平静时段会让所有模型看起来都不错。
            线性外推在全样本上 skill 已经是负的，在事件样本上更差（退水期它会一路外推到负值）；
            梯度提升在事件样本上的优势比全样本更明显。
          </div>
        </div>
      </div>

      {/* 曲线与重要性 */}
      <div className="grid grid-cols-[1.1fr_1fr] gap-4 items-start">
        <div className="card p-4">
          <SectionHead title="RMSE 随预见期变化" sub="对数纵轴：0.01m 与 0.1m 的差距在一屏里都看得见" icon="activity" />
          <RmseChart latest={latest} />
        </div>
        <div className="card p-4">
          <SectionHead title="特征重要性（3h 模型 · 置换重要性 Top 14）" sub="置换重要性：打乱某一列后误差涨多少" icon="layers" />
          <ImportanceChart data={latest.featureImportance ?? []} />
        </div>
      </div>

      {/* 在线滚动 + 散点 */}
      <div className="grid grid-cols-[1fr_1fr] gap-4 items-start">
        <div className="card p-4">
          <SectionHead
            title={`在线滚动评估（近 ${m.rollingWindowH}h 已结算）`}
            sub="唯一能证伪离线指标的实盘口径"
            icon="activity"
          />
          {rollingRows.length === 0 ? (
            <div className="py-8">
              <EmptyState icon="clock" title="还没有已结算的预测" hint="1h 预见期要先走完一轮才会结算，约 1 分钟。" compact />
            </div>
          ) : (
            <div className="overflow-x-auto mt-1">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">预见期</th>
                    <th className="th text-right">样本</th>
                    <th className="th text-right">RMSE</th>
                    <th className="th text-right">基线</th>
                    <th className="th text-right">MAE</th>
                    <th className="th text-right">bias</th>
                    <th className="th text-right">P95</th>
                    <th className="th text-right">skill</th>
                  </tr>
                </thead>
                <tbody>
                  {rollingRows.map(({ h, s }) => (
                    <tr key={h} className="row-hover">
                      <td className="td text-[12px]">{horizonLabel(h)}</td>
                      <td className="td text-right num text-[11.5px]">{s.n}</td>
                      <td className="td text-right num text-[11.5px]">{s.rmse.toFixed(4)}</td>
                      <td className="td text-right num text-[11.5px] text-ink-3">{s.baselineRmse.toFixed(4)}</td>
                      <td className="td text-right num text-[11.5px]">{s.mae.toFixed(4)}</td>
                      <td className="td text-right num text-[11.5px]">{s.bias >= 0 ? '+' : ''}{s.bias.toFixed(4)}</td>
                      <td className="td text-right num text-[11.5px]">{s.p95Abs.toFixed(4)}</td>
                      <td className="td text-right num text-[11.5px]" style={{ color: s.skill > 0 ? T.success : T.danger }}>
                        {s.skill > 0 ? '+' : ''}{s.skill.toFixed(3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-2 rounded-control px-3 py-2 text-[11px] text-ink-2 leading-relaxed" style={{ background: T.bgCanvas }}>
            <div className="font-medium text-ink mb-1">skill 的分母是持久化基线，不是实际值的标准差</div>
            曾用「实际值的标准差」当基线分母，跨站点高程差（3.6~16.3m）远大于预测误差，
            skill 被虚抬到 0.98。现在基线是「发布预测那一刻的实测水位保持不变」的误差，
            这才是「不用模型」的真实水平。
          </div>
        </div>

        <div className="card p-4">
          <SectionHead
            title="预测 vs 实际"
            sub={`${pairList.length} 对 · 45° 为完美预测（画的是积水深，不是绝对水位）`}
            icon="target"
          />
          {pairList.length === 0 ? (
            <div className="py-8">
              <EmptyState icon="clock" title="还没有配对样本" hint="预测到期后才会结算成一对。" compact />
            </div>
          ) : (
            <ScatterChart pairs={pairList} />
          )}
          <div className="mt-1 text-[10.5px] text-ink-3 leading-snug">
            十站点的基准水位差十几米，画绝对水位会得到几簇互不相干的点云；
            画积水深（水位 − 基准水位）才能放在同一个坐标系里比较。
            <span className="text-ink-2"> 负的积水深不钳到 0</span>——传感器噪声会让平静水面读到 −0.004m，抹掉就是造假。
          </div>
        </div>
      </div>

      {/* 版本治理 */}
      <div className="card p-4">
        <SectionHead
          title="模型版本"
          sub="能采纳、能回滚 —— 一次重训变差不该只能靠再训一次赌运气"
          icon="database"
          right={<Tag tone="neutral">{(versions.data?.versions ?? []).length} 个版本</Tag>}
        />
        {!versions.data ? (
          <Skeleton h={80} />
        ) : (
          <div className="overflow-x-auto mt-1">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">版本</th>
                  <th className="th">训练时间</th>
                  <th className="th text-right">3h RMSE</th>
                  <th className="th text-right">3h skill</th>
                  <th className="th text-right">耗时</th>
                  <th className="th">状态</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody>
                {versions.data.versions.map((v) => (
                  <VersionRow
                    key={v.version}
                    v={v}
                    busy={adopt.isPending}
                    onAdopt={() => {
                      setMsg(null)
                      adopt.mutate(v.version, {
                        onSuccess: () => setMsg(`已采纳 ${v.version}，下一轮预测（≤60 秒）生效。`),
                        onError: (e) => setMsg(`采纳失败：${(e as Error).message}`),
                      })
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-2 text-[10.5px] text-ink-3">
          采纳前后端会先尝试加载该版本的 joblib，加载失败直接拒绝——不会出现「切过去才发现文件坏了」。
        </div>
      </div>

      {/* 决策日志 */}
      <div className="card p-4">
        <SectionHead
          title="智能体决策日志"
          sub="每个站点每轮都记一条：为什么算、用哪个模型、修正增益多少"
          icon="cpu"
          right={<Tag tone="neutral">最近 {decisions.data?.length ?? 0} 条</Tag>}
        />
        {!decisions.data ? (
          <Skeleton h={100} />
        ) : decisions.data.length === 0 ? (
          <div className="py-6">
            <EmptyState icon="cpu" title="还没有决策记录" hint="等第一轮预测推送。" compact />
          </div>
        ) : (
          <div className="overflow-x-auto mt-1 max-h-[320px] overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0" style={{ background: T.surface }}>
                <tr>
                  <th className="th">时间</th>
                  <th className="th">站点</th>
                  <th className="th">决策</th>
                  <th className="th">模型</th>
                  <th className="th text-right">增益</th>
                  <th className="th">理由</th>
                </tr>
              </thead>
              <tbody>
                {decisions.data.map((d, i) => (
                  <DecisionRowView key={`${d.ts}-${d.siteId}-${i}`} d={d} onPick={setSiteId} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 方法论 */}
      <SiteDrawer
        siteId={siteId}
        onClose={() => setSiteId(null)}
        onPick={setSiteId}
        width={470}
      />

      <div className="card p-4">
        <SectionHead title="三个必须回答的问题" sub="答不上来就说明还没做完" icon="info" />
        <div className="grid grid-cols-3 gap-3 mt-1">
          {[
            ['比「水位不变」强多少', `全样本 skill ${sortedRows(latest.metrics.blend).map((r) => r.skill.toFixed(2)).join(' / ')}；事件样本 ${sortedRows(latest.metrics.blend).map((r) => r.eventSkill.toFixed(2)).join(' / ')}（1h/3h/6h/12h）。这个数如果接近 0，模型就没有存在价值。`],
            ['置信区间可信吗（PICP90 = 90% 区间的实际覆盖率）', `PICP90 平均 ${fmtPct(sortedRows(latest.metrics.blend).reduce((a, r) => a + r.picp90, 0) / Math.max(1, blendRows.length))}，目标 90%。覆盖不足说明区间太窄，会漏报；过宽则没有决策价值。`],
            ['现在准不准', rollingRows.length ? `近 ${m.rollingWindowH}h 实盘 skill ${rollingRows.map(({ h, s }) => `${horizonLabel(h)} ${s.skill.toFixed(2)}`).join(' / ')}。这是唯一能证伪离线指标的口径。` : '还没有结算样本。'],
          ].map(([q, a]) => (
            <div key={q} className="rounded-control p-2.5" style={{ background: T.bgCanvas }}>
              <div className="text-[11.5px] font-medium text-ink">{q}</div>
              <div className="text-[11px] text-ink-2 leading-relaxed mt-1">{a}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function RetrainTag({ st }: { st: RetrainState }) {
  if (st.status === 'running') return <Tag tone="warn">训练中</Tag>
  if (st.status === 'done') return <Tag tone="ok">已完成</Tag>
  if (st.status === 'failed') return <Tag tone="danger">失败</Tag>
  return <Tag tone="neutral">空闲</Tag>
}

function MetricTable({ latest }: { latest: MetricsBundle }) {
  const rows = HORIZONS
  return (
    <div className="overflow-x-auto mt-1">
      <table className="w-full">
        <thead>
          <tr>
            <th className="th">模型</th>
            {rows.map((h) => (
              <th key={h} className="th text-right">
                {horizonLabel(h)}
              </th>
            ))}
            <th className="th text-right">NSE(3h)</th>
          </tr>
        </thead>
        <tbody>
          {MODEL_FAMILIES.map((f) => {
            const cells = rows.map(
              (h) => compareAt(latest.metrics, h).find((x) => x.family === f)?.row,
            )
            const nse3h = latest.metrics[f]?.find((r) => r.horizonMin === 180)?.nse
            return (
              <tr key={f} className="row-hover" style={{ background: f === 'blend' ? `${T.aiWeak}88` : undefined }}>
                <td className="td">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: SERIES[f] }} />
                    <span className={`text-[12px] ${f === 'blend' ? 'font-semibold text-ink' : 'text-ink-2'}`}>
                      {MODEL_LABEL[f]}
                    </span>
                  </span>
                </td>
                {cells.map((r, i) => (
                  <td key={i} className="td text-right num text-[11.5px]">
                    {r ? (
                      <span style={{ color: r.skill < 0 ? T.danger : undefined }}>
                        {r.rmse.toFixed(3)}
                        <span className="text-ink-3 text-[10px]"> / {r.skill > 0 ? '+' : ''}{r.skill.toFixed(2)}</span>
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                ))}
                <td className="td text-right num text-[11.5px]">{nse3h == null ? '—' : nse3h.toFixed(3)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="text-[10.5px] text-ink-3 mt-1">
        单元格：RMSE(m) / <Glossary term="skill" />（相对持久化基线，&gt;0 才算有价值）
      </div>
    </div>
  )
}

function EventTable({ latest }: { latest: MetricsBundle }) {
  return (
    <div className="overflow-x-auto mt-1">
      <table className="w-full">
        <thead>
          <tr>
            <th className="th">模型</th>
            {HORIZONS.map((h) => (
              <th key={h} className="th text-right">
                {horizonLabel(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MODEL_FAMILIES.map((f) => (
            <tr key={f} className="row-hover" style={{ background: f === 'blend' ? `${T.aiWeak}88` : undefined }}>
              <td className="td">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: SERIES[f] }} />
                  <span className={`text-[12px] ${f === 'blend' ? 'font-semibold text-ink' : 'text-ink-2'}`}>
                    {MODEL_LABEL[f]}
                  </span>
                </span>
              </td>
              {HORIZONS.map((h) => {
                const r = latest.metrics[f]?.find((x) => x.horizonMin === h)
                return (
                  <td key={h} className="td text-right num text-[11.5px]">
                    {r ? (
                      <span style={{ color: r.eventSkill < 0 ? T.danger : undefined }}>
                        {r.eventRmse.toFixed(3)}
                        <span className="text-ink-3 text-[10px]"> / {r.eventSkill > 0 ? '+' : ''}{r.eventSkill.toFixed(2)}</span>
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-[10.5px] text-ink-3 mt-1">
        单元格：事件样本 RMSE(m) / event_skill；事件样本 n ={' '}
        {latest.metrics.blend?.[0]?.eventN ?? '—'}
      </div>
    </div>
  )
}

function RmseChart({ latest }: { latest: MetricsBundle }) {
  const option = useMemo(() => {
    const xs = HORIZONS.map((h) => horizonLabel(h))
    return {
      grid: { left: 46, right: 16, top: 22, bottom: 26 },
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => `${Number(v).toFixed(4)} m` },
      legend: {
        bottom: 0,
        itemWidth: 10,
        itemHeight: 8,
        textStyle: { fontSize: 10, color: T.text2, fontFamily: FONT },
        data: MODEL_FAMILIES.map((f) => MODEL_LABEL[f]),
      },
      xAxis: {
        type: 'category',
        data: xs,
        axisLabel: { fontSize: 10, color: T.text3, fontFamily: FONT },
        axisLine: { lineStyle: { color: T.border1 } },
      },
      yAxis: {
        type: 'log',
        min: 0.005,
        max: 0.5,
        axisLabel: { fontSize: 10, color: T.text3, fontFamily: FONT, formatter: (v: number) => v.toFixed(3) },
        splitLine: { lineStyle: { color: T.border2 } },
      },
      series: MODEL_FAMILIES.map((f) => {
        const rows = sortedRows(latest.metrics[f])
        return {
          name: MODEL_LABEL[f],
          type: 'line',
          smooth: false,
          symbol: 'circle',
          symbolSize: 5,
          lineStyle: { width: f === 'blend' ? 2.6 : 1.6, type: f === 'persistence' ? [5, 4] : 'solid' },
          itemStyle: { color: SERIES[f] },
          z: f === 'blend' ? 5 : 2,
          data: HORIZONS.map((h) => rows.find((r) => r.horizonMin === h)?.rmse ?? null),
        }
      }),
    }
  }, [latest])
  return <ReactECharts option={option} style={{ height: 236 }} opts={{ renderer: 'canvas' }} notMerge />
}

function ImportanceChart({ data }: { data: readonly { name: string; importance: number }[] }) {
  const top = useMemo(() => [...data].sort((a, b) => b.importance - a.importance).slice(0, 14), [data])
  const option = useMemo(
    () => ({
      grid: { left: 108, right: 26, top: 8, bottom: 18 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: T.text3, fontFamily: FONT },
        splitLine: { lineStyle: { color: T.border2 } },
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: top.map((d) => d.name),
        axisLabel: { fontSize: 10, color: T.text2, fontFamily: FONT },
        axisLine: { lineStyle: { color: T.border1 } },
      },
      series: [
        {
          type: 'bar',
          barWidth: 9,
          itemStyle: {
            borderRadius: [0, 4, 4, 0],
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 1,
              y2: 0,
              colorStops: [
                { offset: 0, color: T.ai },
                { offset: 1, color: '#22d3ee' },
              ],
            },
          },
          data: top.map((d) => d.importance),
        },
      ],
    }),
    [top],
  )
  if (top.length === 0) return <EmptyState icon="layers" title="没有重要性数据" compact />
  return <ReactECharts option={option} style={{ height: 236 }} opts={{ renderer: 'canvas' }} notMerge />
}

function ScatterChart({ pairs }: { pairs: readonly EvalPair[] }) {
  const option = useMemo(() => {
    const pts = pairs
      .filter((p) => p.actual != null)
      .map((p) => [p.yhat - p.baseLevel, (p.actual as number) - p.baseLevel])
    const all = pts.flat()
    const lo = Math.min(...all, 0)
    const hi = Math.max(...all, 0.1)
    return {
      grid: { left: 48, right: 18, top: 16, bottom: 34 },
      tooltip: {
        formatter: (p: { value: [number, number] }) =>
          `预测 ${p.value[0].toFixed(3)}m<br/>实际 ${p.value[1].toFixed(3)}m`,
      },
      xAxis: {
        type: 'value',
        name: '预测积水深 (m)',
        nameLocation: 'middle',
        nameGap: 20,
        nameTextStyle: { fontSize: 10, color: T.text3, fontFamily: FONT },
        min: lo,
        max: hi,
        axisLabel: { fontSize: 10, color: T.text3, fontFamily: FONT, formatter: (v: number) => v.toFixed(2) },
        splitLine: { lineStyle: { color: T.border2 } },
      },
      yAxis: {
        type: 'value',
        name: '实际积水深 (m)',
        nameGap: 10,
        nameTextStyle: { fontSize: 10, color: T.text3, fontFamily: FONT, align: 'left' },
        min: lo,
        max: hi,
        axisLabel: { fontSize: 10, color: T.text3, fontFamily: FONT, formatter: (v: number) => v.toFixed(2) },
        splitLine: { lineStyle: { color: T.border2 } },
      },
      series: [
        {
          type: 'scatter',
          symbolSize: 5,
          itemStyle: { color: T.primary, opacity: 0.55 },
          data: pts,
        },
        {
          type: 'line',
          symbol: 'none',
          silent: true,
          lineStyle: { color: T.level.orange, width: 1.2, type: [5, 4] },
          data: [
            [lo, lo],
            [hi, hi],
          ],
        },
      ],
    }
  }, [pairs])
  return <ReactECharts option={option} style={{ height: 250 }} opts={{ renderer: 'canvas' }} notMerge />
}

function VersionRow({ v, busy, onAdopt }: { v: ModelVersion; busy: boolean; onAdopt: () => void }) {
  return (
    <tr className="row-hover" style={{ background: v.active ? `${T.aiWeak}88` : undefined }}>
      <td className="td mono text-[11.5px]">
        <span className="flex items-center gap-1.5">
          {v.version}
          {v.active && <Tag tone="ai">激活</Tag>}
        </span>
      </td>
      <td className="td text-[11.5px] text-ink-2 num">{v.trainedAt ? fmtTime(v.trainedAt, 'MM-DD HH:mm') : '—'}</td>
      <td className="td text-right num text-[11.5px]">{v.rmse3h == null ? '—' : v.rmse3h.toFixed(4)}</td>
      <td className="td text-right num text-[11.5px]" style={{ color: v.skill3h != null && v.skill3h < 0 ? T.danger : undefined }}>
        {v.skill3h == null ? '—' : `${v.skill3h > 0 ? '+' : ''}${v.skill3h.toFixed(3)}`}
      </td>
      <td className="td text-right num text-[11.5px] text-ink-3">
        {v.trainSeconds == null ? '—' : fmtDuration(v.trainSeconds)}
      </td>
      <td className="td text-[11.5px] text-ink-2">{v.active ? '当前在用' : '可采纳'}</td>
      <td className="td text-right">
        {!v.active && (
          <button className="btn h-6 px-2 text-[11px]" disabled={busy} onClick={onAdopt}>
            采纳
          </button>
        )}
      </td>
    </tr>
  )
}

function DecisionRowView({ d, onPick }: { d: DecisionRow; onPick: (id: string) => void }) {
  const sig = Object.entries(d.signals ?? {}).slice(0, 4)
  return (
    <tr className="row-hover cursor-pointer" data-site-row={d.siteId} onClick={() => onPick(d.siteId)}>
      <td className="td num text-[11px] text-ink-3">{fmtTime(d.ts as SimTime, 'MM-DD HH:mm:ss')}</td>
      <td className="td text-[11.5px] num">
        <span style={{ color: T.primary, fontWeight: 600 }}>{d.siteId}</span>
      </td>
      <td className="td">
        <Tag tone={d.shouldForecast ? 'ai' : 'neutral'}>{d.shouldForecast ? '主动加算' : '常规'}</Tag>
      </td>
      <td className="td text-[11px] text-ink-2">{d.model ?? '—'}</td>
      <td className="td text-right num text-[11px]">{d.correctionGain == null ? '—' : d.correctionGain.toFixed(2)}</td>
      <td className="td text-[11px] text-ink-2">
        <div className="truncate max-w-[300px]" title={d.reason}>
          {d.reason}
        </div>
        {sig.length > 0 && (
          <div className="text-[10px] text-ink-3 num truncate max-w-[300px]">
            {sig.map(([k, v]) => `${k}=${v}`).join(' · ')}
          </div>
        )}
      </td>
    </tr>
  )
}
