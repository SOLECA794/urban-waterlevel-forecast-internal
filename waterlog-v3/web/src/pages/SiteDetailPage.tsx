import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  fmtMinutes,
  fmtTime,
  HORIZONS,
  horizonLabel,
  LEVEL_FULL,
  horizonOf,
  SITE_KIND_LABEL,
  thresholdRows,
  type SiteForecast,
} from '../domain'
import { useSiteEvidence } from '../view/useSiteEvidence'
import { TrendChart } from '../components/charts/TrendChart'
import { EpisodeTimeline } from '../components/domain/EpisodeTimeline'
import { SectionHead, EmptyState, KeyValue, Legend, Skeleton } from '../components/primitives/Bits'
import { Gauge } from '../components/primitives/Gauge'
import { Icon } from '../components/primitives/Icons'
import { AssessmentHeadline, AssessmentReason, BlockedNote, FactorBars } from '../components/domain/Assessment'
import { LevelBadge, LevelChip, Tag } from '../components/domain/LevelChip'
import { QualityBadge } from '../components/domain/Trust'
import { DeltaValue, DepthValue, LevelValue, ThresholdRuler } from '../components/domain/Value'
import { T } from '../utils/tokens'
import { Emph } from '../components/primitives/Rich'

/**
 * 站点详情 = L4 溯源。整页只回答一个问题：**凭什么判我这一级？**
 *
 * 所以四块内容缺一不可：
 *   实测序列 → 发生了什么
 *   预测曲线 → 将要发生什么
 *   三因子   → 怎么算出来的
 *   智能体   → 这一轮为什么这么算
 *
 * 页面自己不做 `level - base`、不判断 `thresholds[3]`——
 * `useSiteEvidence` 给的已经是 `Depth` 与 `Thresholds` 品牌类型，
 * 换算只可能在 adapter 层发生一次。
 */
export function SiteDetailPage() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const { data, isLoading, error } = useSiteEvidence(id)

  const horizonRows = useMemo(() => {
    if (!data?.forecast) return []
    return HORIZONS.map((h) => ({ h, row: horizonOf(data.forecast as SiteForecast, h) }))
  }, [data?.forecast])

  if (error) {
    return (
      <div className="card p-8">
        <EmptyState
          icon="alertTriangle"
          title="这个站点打不开"
          hint={error}
          action={
            <button className="btn" onClick={() => nav('/sites')}>
              返回站点列表
            </button>
          }
        />
      </div>
    )
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-3">
        <div className="card p-5">
          <Skeleton h={18} w="30%" />
          <div className="mt-4 grid grid-cols-3 gap-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} h={38} w="60%" />
            ))}
          </div>
        </div>
        <div className="card p-4">
          <Skeleton h={340} />
        </div>
      </div>
    )
  }

  const { site, assessment, forecast, series, issuedAt } = data
  const level = assessment.level
  const color = T.level[level]

  return (
    <div className="space-y-4">
      {/* 头卡：底色取自等级，左边一句话结论，右边三个数字 */}
      <div className="card p-0 overflow-hidden" style={{ backgroundImage: T.levelGrad[level] }}>
        <div className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <button className="text-[11px] text-ink-3 hover:text-ink" onClick={() => nav('/sites')}>
                  ← 站点列表
                </button>
                <LevelBadge level={level} score={assessment.score} />
                <Tag tone="neutral">{SITE_KIND_LABEL[site.kind]}</Tag>
                {data.modelVersion && <Tag tone="ai">{data.modelVersion}</Tag>}
              </div>
              <h1 className="text-[19px] font-semibold text-ink mt-1.5">{site.name}</h1>
              <div className="text-[11.5px] text-ink-2 num mt-0.5">
                {site.id} · {site.district} · {site.lon.toFixed(4)}, {site.lat.toFixed(4)} · 基准高程{' '}
                {site.baseLevel.toFixed(3)} m
              </div>
              {site.drainage && (
                <div className="text-[11px] text-ink-3 num mt-1 flex flex-wrap gap-x-3">
                  <span>汇水 {site.drainage.catchmentHa.toFixed(1)} ha</span>
                  <span>调蓄 {site.drainage.pondHa.toFixed(1)} ha</span>
                  <span>不透水率 {(site.drainage.impervious * 100).toFixed(0)}%</span>
                  <span>管网 {site.drainage.drainageMmH.toFixed(0)} mm/h</span>
                </div>
              )}
            </div>

            <div className="flex items-end gap-6">
              <div>
                <div className="text-[10px] uppercase tracking-[0.1em] text-ink-3">实测水位</div>
                <div className="mt-0.5">
                  <LevelValue value={data.nowLevel} />
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.1em] text-ink-3">积水深</div>
                <div className="mt-0.5">
                  <DepthValue value={data.nowDepth} size="lg" />
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.1em] text-ink-3">数据质量</div>
                <div className="mt-1.5">
                  <QualityBadge quality={data.quality} />
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-[1fr_auto] gap-4 items-end">
            <div>
              <div className="flex items-center justify-between text-[10px] text-ink-3 mb-1">
                <span>当前积水在四级阈值中的位置</span>
                <span className="num">
                  实测峰值 {data.observedPeak.toFixed(2)}m · 预测峰值 {data.forecastPeak.toFixed(2)}m
                </span>
              </div>
              <ThresholdRuler depth={data.nowDepth} thresholds={site.thresholds} level={level} height={9} />
            </div>
            <div className="flex gap-1.5">
              {thresholdRows(site.thresholds).map((t) => (
                <div
                  key={t.level}
                  className="rounded-control px-2 py-1 text-center min-w-[56px]"
                  style={{ background: T.levelWeak[t.level], color: T.levelInk[t.level] }}
                  title={`${LEVEL_FULL[t.level]}：积水深达到 ${t.value.toFixed(2)} m 触发`}
                >
                  <div className="text-[10px] font-medium">{LEVEL_FULL[t.level]}</div>
                  <div className="text-[12px] num font-semibold">{t.value.toFixed(2)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 曲线 */}
      <div className="card p-4">
        <SectionHead
          title="历史实测与未来预测"
          sub={
            issuedAt
              ? `预测发布于 ${fmtTime(issuedAt, 'MM-DD HH:mm')} · 曲线含 90% 置信区间与四级阈值`
              : '暂无预测'
          }
          icon="activity"
          right={
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-ink-3 num">
                {forecast ? `${forecast.curve.length} 个曲线点 · 采样 5min` : '—'}
              </span>
              <LevelChip level={level} />
            </div>
          }
        />
        <div className="mt-2">
          <TrendChart
            series={series}
            forecast={forecast}
            baseLevel={site.baseLevel}
            thresholds={site.thresholds}
            issuedAt={issuedAt}
            height={380}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 mt-2">
          <Legend
            items={[
              { color: T.obsLine, label: '历史实测' },
              { color: T.fcLine, label: '预测水位' },
              { color: T.fcBand, label: '90% 置信区间', square: true },
              { color: T.rainBar, label: '降雨（mm/h）', square: true },
              { color: T.level.red, label: '四级阈值线', dashed: true },
            ]}
          />
          <span className="text-[11px] text-ink-3">
            置信区间由分站点分预见期的残差 σ 标定；区间越宽说明该站该预见期越不确定
          </span>
        </div>
      </div>

      {/* 涨水过程分段。曲线回答「水位怎么变」，这一块回答三个值班复盘必问的问题：
          这次涨水什么时候开始、最高到过哪一级、超橙持续了多久。
          12 小时里常有两三段分开的积水，在曲线上连成一片，数不出次数。 */}
      <div className="card p-4">
        <SectionHead
          title={`近 ${series.hours} 小时涨水过程`}
          sub="横条按实测深度着色 · 空白处为不积水时段 · 按段给出持续时长与峰值"
          icon="rain"
        />
        <div className="mt-3">
          <EpisodeTimeline series={series} baseLevel={site.baseLevel} thresholds={site.thresholds} />
        </div>
      </div>

      <div className="grid grid-cols-[1.35fr_1fr] gap-4 items-start">
        <div className="space-y-4">
          {/* 四预见期 */}
          <div className="card p-4">
            <SectionHead title="多预见期预测" sub="修正量 = 滚动修正叠加的偏差；增益 = 该站点该预见期当前的信任权重" icon="target" />
            {horizonRows.length === 0 ? (
              <div className="py-6">
                <EmptyState icon="activity" title="还没有预测结果" hint="引擎每 60 秒发布一轮预测，稍后再看。" compact />
              </div>
            ) : (
              <table className="w-full mt-2">
                <thead>
                  <tr>
                    <th className="th">预见期</th>
                    <th className="th text-right">预测水位</th>
                    <th className="th text-right">变化</th>
                    <th className="th text-right">90% 区间</th>
                    <th className="th text-right">修正量</th>
                    <th className="th text-right">增益</th>
                    <th className="th">模型</th>
                  </tr>
                </thead>
                <tbody>
                  {horizonRows.map(({ h, row }) => {
                    if (!row) return null
                    return (
                      <tr key={h} className="row-hover">
                        <td className="td font-medium text-[12.5px]">{horizonLabel(h)}</td>
                        <td className="td text-right">
                          <LevelValue value={row.level} />
                        </td>
                        <td className="td text-right">
                          <DeltaValue value={row.delta} digits={3} />
                        </td>
                        <td className="td text-right num text-[11.5px] text-ink-2">
                          {row.lower.toFixed(3)} ~ {row.upper.toFixed(3)}
                          <span className="text-ink-3 ml-1">±{(row.sigma as number).toFixed(3)}</span>
                        </td>
                        <td className="td text-right">
                          <DeltaValue value={row.corrected} digits={4} />
                        </td>
                        <td className="td text-right num text-[12px]">{(row.gain as number).toFixed(2)}</td>
                        <td className="td">
                          <Tag tone={row.model === 'linear' ? 'warn' : 'ai'}>{row.model}</Tag>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            <div className="mt-2 text-[11px] text-ink-3">
              变化列以当前实测为锚；修正量是新息（指数加权系统性偏差）× 增益 × 衰减，
              并且被钳制在 ±3σ 内——修正器再出问题也不允许把曲线推出置信带。
            </div>
          </div>

          {/* 三因子 */}
          <div className="card p-4">
            <SectionHead
              title="三因子研判"
              sub={`预测峰值 + 超阈持续时长 + 变化趋势，按权重 ${(assessment.horizonMin / 60).toFixed(0)}h 窗口加权`}
              icon="gauge"
              right={<LevelChip level={level} score={assessment.score} />}
            />
            <div className="grid grid-cols-[168px_1fr] gap-5 items-center mt-2">
              <div className="flex flex-col items-center">
                <Gauge value={assessment.score} color={color} label="综合分" caption={LEVEL_FULL[level]} />
                <div className="mt-1 text-center">
                  <AssessmentHeadline assessment={assessment} />
                </div>
              </div>
              <div>
                <FactorBars assessment={assessment} />
                <div className="mt-3 rounded-control px-3 py-2" style={{ background: T.bgCanvas }}>
                  <AssessmentReason assessment={assessment} />
                </div>
                {assessment.blockedBy && (
                  <div className="mt-2">
                    <BlockedNote blockedBy={assessment.blockedBy} />
                  </div>
                )}
                <div className="mt-2 grid grid-cols-4 gap-2 text-[11px]">
                  <KeyValue k="峰值" v={`${assessment.peakValue.toFixed(2)} m`} />
                  <KeyValue k="峰值时刻" v={assessment.peakAtMin == null ? '—' : fmtMinutes(assessment.peakAtMin)} />
                  <KeyValue k="超阈持续" v={fmtMinutes(assessment.durationMin)} />
                  <KeyValue k="当前趋势" v={`${(assessment.slope as number).toFixed(2)} m/h`} />
                </div>
              </div>
            </div>
            <div className="mt-3 text-[11px] text-ink-3">
              <Emph text="两道硬约束**只降不升**：持续时间不达门槛封顶降级，趋势明显回落再降一级。分数够高但雨已经停了的情况，不该弹红警。" />
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {/* 智能体 */}
          <div className="card p-4">
            <SectionHead title="本轮为什么这么算" sub="智能体值班决策，不是对话机器人" icon="cpu" />
            {!forecast ? (
              <EmptyState icon="cpu" title="暂无决策记录" hint="等下一轮预测。" compact />
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  <Tag tone={forecast.decision.shouldForecast ? 'ai' : 'neutral'}>
                    {forecast.decision.shouldForecast ? '主动加算' : '跳过（静默）'}
                  </Tag>
                  <Tag tone={forecast.decision.model === 'linear' ? 'warn' : 'ai'}>模型 {forecast.decision.model}</Tag>
                  <Tag tone="neutral">修正增益 {(forecast.decision.gain as number).toFixed(2)}</Tag>
                </div>
                <div className="mt-2 text-[11.5px] text-ink-2 leading-snug rounded-control px-3 py-2" style={{ background: T.bgCanvas }}>
                  {forecast.decision.reason}
                </div>
                <div className="mt-3">
                  <div className="text-[10px] uppercase tracking-[0.1em] text-ink-3 mb-1.5">触发信号</div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {Object.entries(forecast.decision.signals).map(([k, v]) => (
                      <div key={k} className="rounded-control border border-line-2 px-2 py-1.5" style={{ background: T.bgCanvas }}>
                        <div className="text-[10px] text-ink-3 truncate" title={k}>
                          {k}
                        </div>
                        <div className="text-[12px] num font-medium text-ink">{(v as number).toFixed(2)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* 站点静态参数 */}
          <div className="card p-4">
            <SectionHead title="站点参数" sub="来自引擎站点配置，前端只读" icon="layers" />
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 mt-2">
              <KeyValue k="站点编号" v={site.id} />
              <KeyValue k="类型" v={SITE_KIND_LABEL[site.kind]} />
              <KeyValue k="行政区" v={site.district} />
              <KeyValue k="基准高程" v={`${site.baseLevel.toFixed(3)} m`} />
              {site.drainage && <KeyValue k="汇水面积" v={`${site.drainage.catchmentHa.toFixed(1)} ha`} />}
              {site.drainage && <KeyValue k="调蓄面积" v={`${site.drainage.pondHa.toFixed(1)} ha`} />}
              {site.drainage && <KeyValue k="不透水率" v={`${(site.drainage.impervious * 100).toFixed(0)}%`} />}
              {site.drainage && <KeyValue k="管网能力" v={`${site.drainage.drainageMmH.toFixed(0)} mm/h`} />}
            </div>
          </div>

          <div className="card p-3 flex items-start gap-2 text-[11px] text-ink-3">
            <Icon name="info" size={13} className="mt-0.5 shrink-0" />
            <span>
              详情页的结论优先取本轮预测（3h 窗口的完整研判），拿不到才退回一张图那一行——
              后者只有分数没有因子分解。
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
