import { useEffect, useMemo, useState } from 'react'
import {
  ALARM_LEVELS,
  FACTOR_LABEL,
  fmtMinutes,
  hasError,
  LEVEL_LABEL,
  levelOfScore,
  validateRules,
  weightShares,
  weightsSum,
  type AlarmLevel,
  type FactorWeights,
  type Rules,
  type RulesImpact,
} from '../domain'
import { usePreviewRules, useRules, useSaveRules } from '../data/queries'
import { EmptyState, KeyValue, Meter, SectionHead, Skeleton } from '../components/primitives/Bits'
import { Icon } from '../components/primitives/Icons'
import { LevelChip, Tag } from '../components/domain/LevelChip'
import { T } from '../utils/tokens'

/**
 * 规则配置。
 *
 * 这个页面最难的部分不是编辑，而是**让人敢按保存**：改一个分档阈值，
 * 全城 10 个站点的等级立刻重算，值班员可能在不知情的情况下把 3 个红警降成黄警。
 * 所以「预演」不是锦上添花的功能，它是保存按钮的前置条件——
 * 用同一条已发布曲线重判 before/after，变化只可能来自规则，不可能来自模型噪声。
 */

const LV_CN: Record<AlarmLevel, string> = { blue: '蓝', yellow: '黄', orange: '橙', red: '红' }

export function RulesPage() {
  const { data, isLoading } = useRules()
  const save = useSaveRules()
  const preview = usePreviewRules()
  const [draft, setDraft] = useState<Rules | null>(null)
  const [impact, setImpact] = useState<RulesImpact | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  // 服务端规则到达后初始化草稿；保存成功后 useSaveRules 会失效 rules，这里跟随刷新
  useEffect(() => {
    if (data && draft === null) setDraft(data)
  }, [data, draft])

  const issues = useMemo(() => (draft ? validateRules(draft) : []), [draft])
  const bad = hasError(issues)
  const dirty = draft != null && data != null && JSON.stringify(draft) !== JSON.stringify(data)
  const sum = draft ? weightsSum(draft.weights) : 0

  if (isLoading || !draft) {
    return (
      <div className="space-y-3">
        <Skeleton h={44} />
        <Skeleton h={120} />
        <Skeleton h={120} />
      </div>
    )
  }

  const setW = (k: keyof FactorWeights, v: number) =>
    setDraft({ ...draft, weights: { ...draft.weights, [k]: v } })
  const setCut = (k: AlarmLevel, v: number) =>
    setDraft({ ...draft, scoreCutoffs: { ...draft.scoreCutoffs, [k]: v } })
  const setDur = (k: AlarmLevel, v: number) =>
    setDraft({ ...draft, minDurationMin: { ...draft.minDurationMin, [k]: v } })

  const runPreview = () => {
    setMsg(null)
    preview.mutate(draft, {
      onSuccess: (r) => {
        setImpact(r)
        setMsg(
          r.summary.total === 0
            ? '预演完成，但引擎还没有已发布的曲线（等第一轮预测）。'
            : `预演完成：升级 ${r.summary.upgraded} 条、降级 ${r.summary.downgraded} 条、不变 ${r.summary.unchanged} 条。`,
        )
      },
      onError: (e) => setMsg(`预演失败：${(e as Error).message}`),
    })
  }

  const doSave = () => {
    setMsg(null)
    save.mutate(draft, {
      onSuccess: () => {
        setImpact(null)
        setMsg('已保存。引擎下一轮预测（≤60 秒）会用新规则重算全城等级。')
      },
      onError: (e) => setMsg(`保存失败：${(e as Error).message}`),
    })
  }

  return (
    <div className="space-y-4">
      {/* 状态条 */}
      <div className="card p-3 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Icon name="sliders" size={14} className="text-ink-2" />
          <span className="text-[12.5px] font-semibold text-ink">研判规则</span>
        </div>
        <Tag tone={Math.abs(sum - 1) < 1e-6 ? 'ok' : 'danger'}>
          权重和 {sum.toFixed(3)}
        </Tag>
        <Tag tone={monotonic(draft.scoreCutoffs) ? 'ok' : 'danger'}>
          分档{monotonic(draft.scoreCutoffs) ? '单调' : '不单调'}
        </Tag>
        <Tag tone={durMonotonic(draft) ? 'ok' : 'danger'}>
          持续门槛{durMonotonic(draft) ? '非递减' : '递减'}
        </Tag>
        {dirty && <Tag tone="warn">有未保存修改</Tag>}

        <div className="flex-1" />

        <button className="btn" disabled={preview.isPending || bad} onClick={runPreview} title={bad ? '先修正校验错误' : '用已发布曲线重判全城'}>
          <Icon name="target" size={13} /> {preview.isPending ? '预演中…' : '影响预演'}
        </button>
        <button className="btn btn-primary" disabled={save.isPending || bad || !dirty} onClick={doSave} title={bad ? '先修正校验错误' : !dirty ? '没有改动' : undefined}>
          <Icon name="check" size={13} /> 保存并生效
        </button>
      </div>

      {msg && (
        <div className="rounded-control px-3 py-2 text-[11.5px] leading-snug flex items-start gap-2" style={{ background: T.aiWeak, color: T.aiInk }}>
          <Icon name="info" size={13} className="mt-0.5 shrink-0" />
          <span>{msg}</span>
        </div>
      )}

      {issues.length > 0 && (
        <div className="rounded-control px-3 py-2 space-y-1" style={{ background: T.levelWeak.red }}>
          {issues.map((i, n) => (
            <div key={n} className="text-[11.5px] flex items-start gap-1.5" style={{ color: i.severity === 'error' ? T.levelInk.red : T.levelInk.orange }}>
              <Icon name="alertTriangle" size={12} className="mt-0.5 shrink-0" />
              <span>{i.message}</span>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 items-start">
        {/* 三因子权重 */}
        <div className="card p-4">
          <SectionHead title="三因子权重" sub="综合分 = 峰值 × w₁ + 持续 × w₂ + 趋势 × w₃，三者之和必须为 1" icon="gauge" />
          <div className="flex h-2.5 rounded-pill overflow-hidden mt-1" style={{ background: T.border2 }}>
            {weightShares(draft.weights).map((s, i) => (
              <div
                key={s.key}
                style={{
                  width: `${Math.max(0, s.share) * 100}%`,
                  background: [T.primary, T.level.orange, T.ai][i],
                }}
              />
            ))}
          </div>
          <div className="flex items-center gap-3 mt-1.5">
            {weightShares(draft.weights).map((s, i) => (
              <span key={s.key} className="flex items-center gap-1 text-[11px] text-ink-2">
                <span className="w-2 h-2 rounded-sm" style={{ background: [T.primary, T.level.orange, T.ai][i] }} />
                {FACTOR_LABEL[s.key]} <span className="num text-ink">{(s.share * 100).toFixed(0)}%</span>
              </span>
            ))}
          </div>
          <div className="mt-3 space-y-2">
            {(['peak', 'duration', 'trend'] as const).map((k) => (
              <NumField
                key={k}
                label={FACTOR_LABEL[k]}
                hint={FACTOR_HINT[k]}
                value={draft.weights[k]}
                step={0.05}
                onChange={(v) => setW(k, v)}
              />
            ))}
          </div>
        </div>

        {/* 评分分档 */}
        <div className="card p-4">
          <SectionHead title="评分分档" sub="综合分落到哪一档就是哪一级，必须严格递增" icon="layers" />
          <CutoffRuler cutoffs={draft.scoreCutoffs} />
          <div className="mt-3 space-y-2">
            {ALARM_LEVELS.map((lv) => (
              <NumField
                key={lv}
                label={`${LV_CN[lv]}色起评`}
                hint={`综合分 ≥ ${draft.scoreCutoffs[lv].toFixed(2)} 判为${LEVEL_LABEL[lv]}`}
                value={draft.scoreCutoffs[lv]}
                step={0.02}
                onChange={(v) => setCut(lv, v)}
              />
            ))}
          </div>
        </div>

        {/* 最短持续门槛 */}
        <div className="card p-4">
          <SectionHead
            title="最短持续门槛"
            sub="峰值再高，超阈时间不够也不给这一级 —— 这是第一道只降不升的硬约束"
            icon="clock"
          />
          <div className="space-y-2 mt-1">
            {ALARM_LEVELS.map((lv) => (
              <div key={lv} className="grid grid-cols-[52px_1fr_86px] items-center gap-2">
                <LevelChip level={lv} />
                <div>
                  <Meter
                    value={Math.min(100, (draft.minDurationMin[lv] / Math.max(1, draft.durationSaturationMin)) * 100)}
                    color={T.level[lv]}
                    height={6}
                    ticks={[25, 50, 75]}
                  />
                  <div className="text-[10px] text-ink-3 num mt-0.5">
                    {fmtMinutes(draft.minDurationMin[lv])} / 饱和 {fmtMinutes(draft.durationSaturationMin)}
                  </div>
                </div>
                <input
                  className="field h-7 text-[12px] num text-right"
                  type="number"
                  min={0}
                  step={5}
                  value={draft.minDurationMin[lv]}
                  onChange={(e) => setDur(lv, Number(e.target.value))}
                />
              </div>
            ))}
          </div>
          <div className="mt-2">
            <NumField
              label="持续饱和值"
              hint="超过这个时长，持续因子记满分"
              value={draft.durationSaturationMin}
              step={15}
              suffix="min"
              onChange={(v) => setDraft({ ...draft, durationSaturationMin: v })}
            />
          </div>
        </div>

        {/* 趋势跨档 */}
        <div className="card p-4">
          <SectionHead
            title="趋势跨档与研判窗口"
            sub="第二道硬约束：涨得猛可以升一级，退得快可以降一级，但都只动一档"
            icon="activity"
          />
          <div className="space-y-2 mt-1">
            <NumField
              label="升级斜率"
              hint={`1h 水位涨幅 ≥ ${draft.trendUpgradeSlope.toFixed(2)} m/h 时升一级`}
              value={draft.trendUpgradeSlope as number}
              step={0.05}
              suffix="m/h"
              onChange={(v) => setDraft({ ...draft, trendUpgradeSlope: v as Rules['trendUpgradeSlope'] })}
            />
            <NumField
              label="降级斜率"
              hint={`1h 水位退幅 ≤ ${(draft.trendDowngradeSlope as number).toFixed(2)} m/h 时降一级`}
              value={draft.trendDowngradeSlope as number}
              step={0.05}
              suffix="m/h"
              onChange={(v) => setDraft({ ...draft, trendDowngradeSlope: v as Rules['trendDowngradeSlope'] })}
            />
            <NumField
              label="趋势归一化跨度"
              hint="趋势因子从 0 记到 1 所跨的斜率范围"
              value={draft.trendScoreSpan}
              step={0.1}
              suffix="m/h"
              onChange={(v) => setDraft({ ...draft, trendScoreSpan: v })}
            />
            <NumField
              label="研判窗口"
              hint="看未来多久的预测来判峰值与持续，默认 180 分钟"
              value={draft.horizonMin}
              step={30}
              suffix="min"
              onChange={(v) => setDraft({ ...draft, horizonMin: v })}
            />
            <div className="grid grid-cols-[1fr_auto] items-center gap-2">
              <div className="min-w-0">
                <div className="text-[12px] text-ink leading-tight">最低报警等级</div>
                <div className="text-[10.5px] text-ink-3 leading-tight mt-0.5">
                  低于这一级的一律压成「无预警」，用来把某一级整个关掉
                </div>
              </div>
              <div className="seg">
                {ALARM_LEVELS.map((lv) => (
                  <button
                    key={lv}
                    className="seg-item"
                    data-active={draft.minLevelForAlarm === ALARM_LEVELS.indexOf(lv) + 1}
                    onClick={() => setDraft({ ...draft, minLevelForAlarm: ALARM_LEVELS.indexOf(lv) + 1 })}
                  >
                    {LV_CN[lv]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 影响预演结果 */}
      {impact && (
        <div className="card p-4">
          <SectionHead
            title="影响预演"
            sub="同一条已发布曲线、两套规则各判一次 —— 变化只可能来自规则"
            icon="target"
            right={
              <div className="flex items-center gap-1.5">
                <Tag tone="danger">升 {impact.summary.upgraded}</Tag>
                <Tag tone="ok">降 {impact.summary.downgraded}</Tag>
                <Tag tone="neutral">不变 {impact.summary.unchanged}</Tag>
              </div>
            }
          />
          {impact.changes.length === 0 ? (
            <div className="py-8">
              <EmptyState icon="check" title="没有站点受影响" hint="这次改动对当前这轮研判的等级没有影响。" compact />
            </div>
          ) : (
            <div className="overflow-x-auto mt-1">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">站点</th>
                    <th className="th">改前</th>
                    <th className="th">改后</th>
                    <th className="th text-right">分值变化</th>
                    <th className="th">研判依据（改后）</th>
                  </tr>
                </thead>
                <tbody>
                  {impact.changes.map((c) => (
                    <tr key={c.siteId} className="row-hover" style={{ background: c.direction === 'up' ? `${T.levelWeak.red}66` : c.direction === 'down' ? `${T.levelWeak.blue}66` : undefined }}>
                      <td className="td">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12.5px] font-medium text-ink truncate max-w-[130px]">{c.name}</span>
                          <span className="text-[10px] text-ink-3 num">{c.siteId}</span>
                        </div>
                      </td>
                      <td className="td">
                        <span className="flex items-center gap-1">
                          <LevelChip level={c.beforeLevel} />
                          <span className="num text-[11px] text-ink-3">{c.beforeScore.toFixed(2)}</span>
                        </span>
                      </td>
                      <td className="td">
                        <span className="flex items-center gap-1">
                          <Icon name={c.direction === 'up' ? 'arrowUp' : c.direction === 'down' ? 'arrowDown' : 'minus'} size={11} className="text-ink-3" />
                          <LevelChip level={c.afterLevel} />
                          <span className="num text-[11px] text-ink-3">{c.afterScore.toFixed(2)}</span>
                        </span>
                      </td>
                      <td className="td text-right num text-[11.5px]" style={{ color: c.afterScore > c.beforeScore ? T.levelInk.red : c.afterScore < c.beforeScore ? T.levelInk.blue : T.text3 }}>
                        {c.afterScore >= c.beforeScore ? '+' : ''}
                        {(c.afterScore - c.beforeScore).toFixed(3)}
                      </td>
                      <td className="td text-[11.5px] text-ink-2 max-w-[380px]">{c.afterReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 方法论 */}
      <div className="card p-4">
        <SectionHead title="为什么是这三个因子" sub="四问，答案都在数据里" icon="cpu" />
        <div className="grid grid-cols-2 gap-3 mt-1">
          {[
            ['为什么不只看峰值', '单点峰值高但只超阈 5 分钟的积水，和超阈两小时的积水，处置需求完全不同。峰值回答「多深」，持续回答「多久」。'],
            ['为什么要有趋势', '两条曲线峰值一样、持续一样，一条还在涨一条已经在退，值班优先级不同。趋势是唯一带方向的因子。'],
            ['为什么两道硬约束只降不升', '持续不够就封顶、退得快就降级，都是往下走。往上加档必须靠分值本身，不能靠一个斜率读数把黄警顶成红警。'],
            ['为什么改规则要先预演', '保存那一刻全城等级立刻重算。用同一条已发布曲线重判，变化才只可能来自规则；重新预测就分不清是规则还是模型噪声。'],
          ].map(([q, a]) => (
            <div key={q} className="rounded-control p-2.5" style={{ background: T.bgCanvas }}>
              <div className="text-[11.5px] font-medium text-ink">{q}</div>
              <div className="text-[11px] text-ink-2 leading-relaxed mt-1">{a}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-4 gap-3">
          <KeyValue k="当前研判窗口" v={fmtMinutes(draft.horizonMin)} />
          <KeyValue k="最低报警等级" v={LEVEL_LABEL[ALARM_LEVELS[draft.minLevelForAlarm - 1] ?? 'blue']} />
          <KeyValue k="红警需要持续" v={fmtMinutes(draft.minDurationMin.red)} />
          <KeyValue k="按当前分档，0.50 分是" v={LEVEL_LABEL[levelOfScore(0.5, draft.scoreCutoffs)]} />
        </div>
      </div>
    </div>
  )
}

const FACTOR_HINT: Record<keyof FactorWeights, string> = {
  peak: '预见期内最高水位相对红阈值的比例',
  duration: '超阈持续时间相对饱和值的比例',
  trend: '当前 1h 变化趋势的归一化值',
}

function monotonic(c: Record<AlarmLevel, number>): boolean {
  let prev = -Infinity
  for (const lv of ALARM_LEVELS) {
    if (!(c[lv] > prev)) return false
    prev = c[lv]
  }
  return true
}

function durMonotonic(r: Rules): boolean {
  let prev = -Infinity
  for (const lv of ALARM_LEVELS) {
    if (r.minDurationMin[lv] < prev) return false
    prev = r.minDurationMin[lv]
  }
  return true
}

/** 把四个分档画在 0~1 数轴上。0.22/0.40/0.60/0.78 与 0.05/0.10/0.12/0.90 在表格里长得一样，在尺子上完全不同。 */
function CutoffRuler({ cutoffs }: { cutoffs: Record<AlarmLevel, number> }) {
  return (
    <div className="mt-2">
      <div className="flex h-6 rounded-control overflow-hidden" style={{ background: T.border2 }}>
        {ALARM_LEVELS.map((lv) => {
          const start = lv === 'blue' ? 0 : cutoffs[ALARM_LEVELS[ALARM_LEVELS.indexOf(lv) - 1]]
          const width = Math.max(0, Math.min(1, cutoffs[lv]) - start)
          return (
            <div
              key={lv}
              className="grid place-items-center text-[10px] font-medium"
              style={{ width: `${width * 100}%`, background: T.levelWeak[lv], color: T.levelInk[lv] }}
              title={`${LEVEL_LABEL[lv]}：综合分 ≥ ${cutoffs[lv].toFixed(2)}`}
            >
              {width > 0.06 ? LV_CN[lv] : ''}
            </div>
          )
        })}
        <div className="flex-1 grid place-items-center text-[10px] text-ink-3">不报警</div>
      </div>
      <div className="flex justify-between text-[10px] text-ink-3 num mt-0.5">
        <span>0.00</span>
        <span>0.50</span>
        <span>1.00</span>
      </div>
    </div>
  )
}

function NumField({
  label,
  hint,
  value,
  step,
  suffix,
  onChange,
}: {
  label: string
  hint?: string
  value: number
  step: number
  suffix?: string
  onChange: (v: number) => void
}) {
  return (
    <div className="grid grid-cols-[1fr_100px] items-center gap-2">
      <div className="min-w-0">
        <div className="text-[12px] text-ink leading-tight">{label}</div>
        {hint && <div className="text-[10.5px] text-ink-3 leading-tight mt-0.5">{hint}</div>}
      </div>
      <div className="relative">
        <input
          className="field h-7 text-[12px] num text-right w-full"
          type="number"
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={suffix ? { paddingRight: 34 } : undefined}
        />
        {suffix && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-ink-3 pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
    </div>
  )
}
