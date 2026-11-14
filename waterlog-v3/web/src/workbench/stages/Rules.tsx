import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { usePreviewRules, useRules, useSaveRules } from '../../data/queries'
import { useSession } from '../../view/useSession'
import {
  ALARM_LEVELS,
  FACTOR_LABEL,
  LEVEL_LABEL,
  LEVEL_ORDER,
  LEVEL_RANK,
  ROLE_LABEL,
  can,
  fmtMinutes,
  fmtRate,
  hasError,
  minRoleFor,
  validateRules,
  weightShares,
  weightsSum,
  type FactorWeights,
  type Level,
  type RuleImpact,
  type RuleIssue,
  type Rules,
  type RulesImpact,
} from '../../domain'
import { Block, Figure, Nothing, Pill, Row, Ruler, Shimmer } from '../kit'
import { W, ease } from '../visual'
import type { StageCtx } from '../ctx'

/**
 * 舞台：规则与阈值。
 *
 * 这一块要回答的是**「改之前会变成什么样」**，不是「现在的规则是什么」——
 * 后者把 JSON 念一遍就够了，前者才是没人敢拍的那个决定。
 *
 * 三条口径决定了它长什么样：
 *
 * 1. **预演用的是同一条已发布的预测曲线。** 后端 `POST /api/rules/preview` 不重新预测，
 *    拿现成曲线重判 before/after。所以看到的差异**只可能来自规则**。
 *    若重新跑一次预测，模型噪声会混进差异里，那个数字就不能拿来做决定。
 * 2. **落盘是一次不可逆的全城重算。** 保存那一刻十个站点的等级立刻按新规则重判，
 *    值班员可能在不知情的情况下把三条红警降成黄警（漏报）。所以「改前先预演」
 *    和「预演之后草稿又变了」这两件事必须在界面上看得见，不能只靠记忆。
 * 3. **`minLevelForAlarm` 是等级序整数（1=蓝 2=黄 3=橙 4=红），不是 0~1 的分数。**
 *    旧页面在这里按分值渲染，读起来像「0.22 分才报警」——把数量级说错了十倍以上。
 */
export function RulesStage({ ctx }: { ctx: StageCtx }) {
  const q = useRules()
  const save = useSaveRules()
  const preview = usePreviewRules()
  const { user } = useSession()

  /**
   * 草稿只留在本地、不写回缓存。
   *
   * `useRules()` 每 120s 轮询一次，如果直接改缓存里的对象，下一次轮询就会把
   * 用户刚调好的权重悄悄改回线上值——而用户以为自己已经改好了。
   */
  const [draft, setDraft] = useState<Rules | null>(null)
  const [impact, setImpact] = useState<RulesImpact | null>(null)
  /** 预演对应的那一版草稿指纹。没有它就无法回答「这个预演还算不算数」。 */
  const [previewSig, setPreviewSig] = useState('')
  /** 预演发生的墙钟时刻。它是操作行为，不是遥测，所以不套仿真时钟。 */
  const [previewedAt, setPreviewedAt] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [onlyChanged, setOnlyChanged] = useState(true)

  const base = q.data ?? null
  const cur = draft ?? base
  const sig = cur ? JSON.stringify(cur) : ''

  const issues = useMemo(() => (cur ? validateRules(cur) : []), [cur])
  const dirty = !!cur && !!base && sig !== JSON.stringify(base)
  const previewStale = impact !== null && previewSig !== sig

  const canPreview = can(user, 'rules:preview')
  const canSave = can(user, 'rules:save')
  const readOnly = !canPreview
  const busy = save.isPending || preview.isPending
  const roleText = user ? ROLE_LABEL[user.role] : '未登录'

  if (q.isLoading && !base) {
    return (
      <div style={{ flex: '1 1 0', minHeight: 0, padding: 12 }}>
        <Block title="规则与阈值" grow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Shimmer h={64} />
            <Shimmer h={160} />
            <Shimmer h={90} />
          </div>
        </Block>
      </div>
    )
  }

  if (!cur) {
    return (
      <div style={{ flex: '1 1 0', minHeight: 0, padding: 12 }}>
        <Block title="规则与阈值" grow>
          <Nothing
            why="没拿到规则文档"
            hint={
              q.error
                ? `后端原话：${(q.error as Error).message}。规则挂在 Go API 的 /api/rules 上，先在「链路与接口」里确认是哪一层断了。`
                : 'GET /api/rules 返回空。规则文档是等级判定的唯一依据，读不到时不能拿默认值顶上——那等于悄悄换了一套判据。'
            }
          />
        </Block>
      </div>
    )
  }

  const onEdit = (next: Rules) => {
    setDraft(next)
    // 草稿一动，上一次预演就作废了：留着它会让用户对着「旧的 before/after」按保存。
    setConfirming(false)
  }

  const doPreview = () => {
    preview.mutate(cur, {
      onSuccess: (r) => {
        setImpact(r)
        setPreviewSig(JSON.stringify(cur))
        setPreviewedAt(Date.now() / 1000)
        const s = r.summary
        ctx.toast(
          'ok',
          s.upgraded === 0 && s.downgraded === 0
            ? `预演完成：${s.total} 个站点的等级都不会变`
            : `预演完成：升级 ${s.upgraded} 站、降级 ${s.downgraded} 站`,
        )
      },
      // 保留后端原话：这类 400 里写的就是「哪一档不合法」，改写会丢掉定位信息。
      onError: (e: Error) => ctx.toast('err', e.message),
    })
  }

  const doSave = () => {
    save.mutate(cur, {
      onSuccess: () => {
        setConfirming(false)
        // 清掉草稿与预演：落盘后 useSaveRules 会让 ['rules'] 失效并重取，
        // 继续留着草稿会让界面显示「刚保存的值」而不是「后端真正存下的值」。
        setDraft(null)
        setImpact(null)
        setPreviewSig('')
        ctx.toast('ok', '规则已落盘，全城等级已按新规则开始重算')
      },
      onError: (e: Error) => {
        setConfirming(false)
        ctx.toast('err', e.message)
      },
    })
  }

  return (
    <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <SaveBar
        issues={issues}
        dirty={dirty}
        canPreview={canPreview}
        canSave={canSave}
        roleText={roleText}
        hasImpact={impact !== null}
        previewStale={previewStale}
        confirming={confirming}
        busy={busy}
        onPreview={doPreview}
        onReset={() => {
          setDraft(null)
          setImpact(null)
          setPreviewSig('')
          setConfirming(false)
        }}
        onAskSave={() => setConfirming(true)}
        onConfirm={doSave}
        onCancel={() => setConfirming(false)}
      />

      <div style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', padding: 12 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(380px, 1.15fr) minmax(340px, 1fr)',
            gap: 12,
            alignItems: 'start',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
            <PreviewBlock
              impact={impact}
              stale={previewStale}
              previewedAt={previewedAt}
              previewing={preview.isPending}
              canPreview={canPreview}
              readOnly={readOnly}
              onlyChanged={onlyChanged}
              onToggleOnlyChanged={() => setOnlyChanged((v) => !v)}
              onPreview={doPreview}
              openSite={(id, name) => ctx.openSite(id, name)}
            />

            <Block title="这一块的口径" sub="四问，答案决定了上面每一个数怎么读">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {DOCTRINE.map(([q0, a]) => (
                  <div key={q0} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: W.ink2 }}>{q0}</span>
                    <span style={{ fontSize: 11, color: W.ink3, lineHeight: 1.7 }}>{a}</span>
                  </div>
                ))}
              </div>
            </Block>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
            <WeightBlock rules={cur} issues={issues} disabled={readOnly} onEdit={onEdit} />

            <CutoffBlock rules={cur} issues={issues} disabled={readOnly} onEdit={onEdit} />

            <DurationBlock rules={cur} issues={issues} disabled={readOnly} onEdit={onEdit} />

            <MinLevelBlock rules={cur} disabled={readOnly} onEdit={onEdit} />

            <TrendBlock rules={cur} issues={issues} disabled={readOnly} onEdit={onEdit} />
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 预演

/**
 * 预演结果。它占主位，因为它是这一屏唯一的「决定依据」。
 *
 * 排序把**降级排在升级前面**：升级顶多是多跑一趟现场，
 * 降级是漏报——红警被降成黄警之后，值班台上没有任何东西会提醒你
 * 「这里原本是红的」。风险不对称，顺序就不该对半开。
 */
function PreviewBlock({
  impact,
  stale,
  previewedAt,
  previewing,
  canPreview,
  readOnly,
  onlyChanged,
  onToggleOnlyChanged,
  onPreview,
  openSite,
}: {
  impact: RulesImpact | null
  stale: boolean
  previewedAt: number
  previewing: boolean
  canPreview: boolean
  readOnly: boolean
  onlyChanged: boolean
  onToggleOnlyChanged: () => void
  onPreview: () => void
  openSite: (id: string, name: string) => void
}) {
  const changes = useMemo(() => {
    if (!impact) return []
    const rank = (c: RuleImpact) => Math.abs(LEVEL_RANK[c.afterLevel] - LEVEL_RANK[c.beforeLevel])
    return [...impact.changes]
      .filter((c) => (onlyChanged ? c.direction !== 'same' : true))
      .sort((a, b) => {
        const dir = (c: RuleImpact) => (c.direction === 'down' ? 0 : c.direction === 'up' ? 1 : 2)
        return dir(a) - dir(b) || rank(b) - rank(a) || a.siteId.localeCompare(b.siteId)
      })
  }, [impact, onlyChanged])

  const moved = impact ? impact.summary.upgraded + impact.summary.downgraded : 0

  return (
    <Block
      title="改动前先预演"
      sub="用同一条已发布的预测曲线重判 before / after，不重新预测"
      aside={
        impact ? (
          <Pill tone={stale ? W.warn : W.ink3}>
            {stale ? '草稿已改动，需重新预演' : `预演于 ${fmtClockLike(previewedAt)}`}
          </Pill>
        ) : (
          <Pill tone={W.ink4}>尚未预演</Pill>
        )
      }
      pad={10}
    >
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
        <Figure
          value={impact ? impact.summary.total : '—'}
          label="参与重判的站点"
          size={22}
          hint="当前已发布曲线覆盖的站点数"
        />
        <Figure
          value={impact ? impact.summary.upgraded : '—'}
          label="升级"
          size={22}
          tone={W.accent}
          hint="多跑一趟现场，代价是误报"
        />
        <Figure
          value={impact ? impact.summary.downgraded : '—'}
          label="降级"
          size={22}
          tone={W.levelInk.red}
          hint="漏报，值班台上不会有任何提示"
        />
        <Figure value={impact ? impact.summary.unchanged : '—'} label="不变" size={22} tone={W.ink3} />
        <span style={{ marginLeft: 'auto', flex: '0 0 auto' }}>
          <button
            type="button"
            onClick={onPreview}
            disabled={!canPreview || previewing}
            title={canPreview ? '把当前草稿发给后端试算' : '预演需要值班员及以上角色'}
            style={btn(!canPreview || previewing, 'accent')}
          >
            {previewing ? '预演中…' : impact ? '重新预演' : '预演当前草稿'}
          </button>
        </span>
      </div>

      {readOnly && (
        <div style={{ fontSize: 11, color: W.ink4, lineHeight: 1.7, marginBottom: 8 }}>
          只读角色看不到预演——预演是「准备改规则」这个动作的一部分，
          它的输出会被马上用于决策。要看影响，先让管理员给到值班员。
        </div>
      )}

      <div style={{ borderTop: `1px solid ${W.lineSoft}`, paddingTop: 8 }}>
        <Row k="重判依据" v="同一条已发布曲线" hint="后端不重新预测" />
        <Row k="差异来源" v="只有规则" hint="模型噪声不参与，否则差异不可归因" />
        <Row
          k="预演时刻"
          v={previewedAt ? fmtClockLike(previewedAt) : '—'}
          hint="墙钟，不是仿真时钟"
        />
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          margin: '10px 0 4px',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 11.5, fontWeight: 600, color: W.ink2 }}>
          等级变化 {impact ? `（${moved} 站会变档）` : ''}
        </span>
        {impact && impact.summary.unchanged > 0 && (
          <button
            type="button"
            onClick={onToggleOnlyChanged}
            style={{
              border: `1px solid ${onlyChanged ? W.lineStrong : 'transparent'}`,
              background: onlyChanged ? W.lineSoft : 'transparent',
              color: W.ink3,
              borderRadius: 4,
              padding: '2px 7px',
              fontSize: 10.5,
              cursor: 'pointer',
              fontFamily: W.sans,
            }}
            title="档位不变的站点也要一起看，才能确认改动没有误伤"
          >
            含不变的 {impact.summary.unchanged} 站
          </button>
        )}
      </div>

      {!impact ? (
        <Nothing
          why="还没有预演"
          hint="保存规则会让全城十个站点的等级立刻按新规则重判。先预演一次，看清楚哪几个站会升、哪几个会降、各自从哪一档到哪一档——这一步不需要落盘。"
        />
      ) : changes.length === 0 ? (
        <Nothing
          why={onlyChanged ? '这份草稿不会改变任何一个站点的等级' : '后端没有返回任何站点的影响'}
          hint={
            onlyChanged
              ? '说明改动落在没有任何站点命中的区间里。也可能只是「不同的路径算出了同一个等级」——点上面的按钮把不变的站点也展开看一眼。'
              : '预演返回了空的 changes。要么这条已发布曲线没有覆盖任何站点，要么后端换了字段名——去「链路与接口」核对 /api/rules/preview 的返回。'
          }
        />
      ) : (
        <div style={{ marginTop: 4 }}>
          {changes.map((c) => (
            <ChangeRow key={c.siteId} c={c} onPick={() => openSite(c.siteId, c.name)} />
          ))}
        </div>
      )}
    </Block>
  )
}

/** 一行「哪个站、从哪档到哪档、凭什么」。 */
function ChangeRow({ c, onPick }: { c: RuleImpact; onPick: () => void }) {
  const down = c.direction === 'down'
  const up = c.direction === 'up'
  const dRank = LEVEL_RANK[c.afterLevel] - LEVEL_RANK[c.beforeLevel]
  const tone = down ? W.levelInk.red : up ? W.accent : W.ink4

  return (
    <div
      data-impact-site={c.siteId}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        padding: '7px 0',
        borderBottom: `1px solid ${W.lineSoft}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onPick}
          title="在右栏打开这个站点，看它现在的实测与预测"
          style={{
            border: 0,
            background: 'transparent',
            padding: 0,
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
            color: W.accent,
            fontFamily: W.sans,
            borderBottom: `1px dashed ${W.accent}66`,
          }}
        >
          {c.name}
        </button>
        <span style={{ fontSize: 10, color: W.ink4, fontFamily: W.mono }}>{c.siteId}</span>
        <Pill tone={W.level[c.beforeLevel]} title="改前的等级与综合分">
          改前 {LEVEL_LABEL[c.beforeLevel]} {fmtScore(c.beforeScore)}
        </Pill>
        <span style={{ fontSize: 11, color: W.ink4 }}>→</span>
        <Pill tone={W.level[c.afterLevel]} title="改后的等级与综合分">
          改后 {LEVEL_LABEL[c.afterLevel]} {fmtScore(c.afterScore)}
        </Pill>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            fontFamily: W.mono,
            fontVariantNumeric: 'tabular-nums',
            color: tone,
            whiteSpace: 'nowrap',
          }}
        >
          {dRank > 0 ? `升 ${dRank} 档` : dRank < 0 ? `降 ${-dRank} 档` : '档位不变'}
        </span>
      </div>
      {/* 依据用「改后」的那句：用户要判断的是新规则为什么这样判，
          而不是旧规则为什么那样判。旧依据只在改后没有时兜底。 */}
      <div style={{ fontSize: 11, color: W.ink3, lineHeight: 1.65 }}>
        {c.afterReason || c.beforeReason || '后端没有给出研判依据'}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 权重

/** `minLevelForAlarm` 存的是等级序整数。这里是唯一的读法。 */
function levelFromRankInt(n: number): Level {
  const i = Math.max(0, Math.min(LEVEL_ORDER.length - 1, Math.round(n)))
  return LEVEL_ORDER[i]
}

const FACTOR_COLOR: Record<keyof FactorWeights, string> = {
  peak: W.accent,
  duration: W.level.blue,
  trend: W.level.orange,
}

const FACTOR_HINT: Record<keyof FactorWeights, string> = {
  peak: '预见期内最高水位相对红阈值的比例——回答「最深能到多少」',
  duration: '超阈累计时长相对饱和值的比例——回答「要持续多久」',
  trend: '当前 1h 变化率的归一化值——唯一带方向的因子',
}

const KEYS = ['peak', 'duration', 'trend'] as const

function WeightBlock({
  rules,
  issues,
  disabled,
  onEdit,
}: {
  rules: Rules
  issues: readonly RuleIssue[]
  disabled: boolean
  onEdit: (r: Rules) => void
}) {
  const shares = weightShares(rules.weights)
  const sum = weightsSum(rules.weights)
  const sumIssue = issues.find((i) => i.field === 'weights')

  return (
    <Block
      title="三因子权重"
      sub="三者之和必须等于 1"
      aside={<Pill tone={sumIssue ? W.bad : W.ink3}>合计 {fmtScore(sum)}</Pill>}
    >
      {/* 三段占比条：把「谁在说话」摊开。三项各自的数字在下面一行一行的。 */}
      <div
        style={{
          display: 'flex',
          gap: 2,
          height: 12,
          borderRadius: 6,
          overflow: 'hidden',
          border: `1px solid ${W.line}`,
        }}
      >
        {shares.map((s) => (
          <span
            key={s.key}
            style={{
              width: `${Math.max(0, Math.min(1, s.share)) * 100}%`,
              background: FACTOR_COLOR[s.key],
            }}
            title={`${FACTOR_LABEL[s.key]} 占 ${fmtPctLocal(s.share)}`}
          />
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 10 }}>
        {KEYS.map((k) => {
          const bad = issues.find((i) => i.field === `weights.${k}`)
          return (
            <div key={k} data-rule-factor={k} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    background: FACTOR_COLOR[k],
                    flex: '0 0 auto',
                  }}
                />
                <span style={{ fontSize: 11.5, color: W.ink2 }}>{FACTOR_LABEL[k]}</span>
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: 12,
                    fontFamily: W.mono,
                    fontVariantNumeric: 'tabular-nums',
                    color: bad ? W.bad : W.ink,
                  }}
                >
                  {fmtScore(rules.weights[k])}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.005}
                value={rules.weights[k]}
                disabled={disabled}
                onChange={(e) => onEdit(withWeight(rules, k, Number(e.currentTarget.value)))}
                style={{ width: '100%', accentColor: W.accent, cursor: disabled ? 'not-allowed' : 'pointer' }}
              />
              <Ruler ratio={rules.weights[k]} color={FACTOR_COLOR[k]} height={3} />
              <span style={{ fontSize: 10.5, color: W.ink4, lineHeight: 1.6 }}>{FACTOR_HINT[k]}</span>
              {bad && <span style={{ fontSize: 10.5, color: W.bad }}>{bad.message}</span>}
            </div>
          )
        })}
      </div>

      {sumIssue && (
        <div
          style={{
            marginTop: 9,
            padding: '6px 8px',
            borderRadius: 6,
            border: `1px solid ${W.bad}55`,
            fontSize: 11,
            color: W.bad,
            lineHeight: 1.6,
          }}
        >
          {sumIssue.message}
          <br />
          <span style={{ color: W.ink3 }}>
            拖动任一因子时，另外两项会按原比例吃下差额——所以正常拖拽不会破坏这条约束。
            只有手工把某一项直接归零时才可能失衡，这种情况下另外两项均分余量。
          </span>
        </div>
      )}
    </Block>
  )
}

/**
 * 改一个因子，另外两项按原比例补偿。
 *
 * 为什么必须补偿而不是各改各的：`validateRules()` 会直接判「和不为 1」为 error，
 * 而保存按钮在 hasError 时是禁用的——不补偿的话，用户每拖一次滑块都会把保存按钮
 * 锁死，还得手工去凑那三个数。补偿之后，拖拽始终落在合法域内。
 *
 * 浮点补偿：0.1 + 0.2 这类误差会被 1e-6 的容差判成「和不为 1」。所以最后把
 * **第三项直接定为 1 减去另两项**，让和在任何浮点表示下都精确等于 1。
 */
function withWeight(rules: Rules, key: keyof FactorWeights, next: number): Rules {
  const v = Math.max(0, Math.min(1, Number.isFinite(next) ? next : 0))
  const others = KEYS.filter((k) => k !== key)
  const rest = 1 - v
  const oldRest = others.reduce((s, k) => s + rules.weights[k], 0)
  const w: Record<keyof FactorWeights, number> = { ...rules.weights }
  w[key] = v
  for (const k of others) {
    // 另外两项本来就被清零时没有比例可分，只能均分；否则用户把它们拉到 0 之后
    // 就再也回不到「和 = 1」了。
    w[k] = oldRest > 1e-9 ? (rules.weights[k] / oldRest) * rest : rest / 2
  }
  const peak = round6(w.peak)
  const duration = round6(w.duration)
  return { ...rules, weights: { peak, duration, trend: round6(1 - peak - duration) } }
}

// ---------------------------------------------------------------- 分档阈值

function CutoffBlock({
  rules,
  issues,
  disabled,
  onEdit,
}: {
  rules: Rules
  issues: readonly RuleIssue[]
  disabled: boolean
  onEdit: (r: Rules) => void
}) {
  const cut = rules.scoreCutoffs
  const segments: { key: Level; from: number; to: number; color: string }[] = [
    { key: 'none', from: 0, to: clamp01(cut.blue), color: W.levelWash.none },
    ...ALARM_LEVELS.map((lv, i) => {
      const from = clamp01(cut[ALARM_LEVELS[i]])
      const to = i === ALARM_LEVELS.length - 1 ? 1 : clamp01(cut[ALARM_LEVELS[i + 1]])
      return { key: lv as Level, from, to, color: W.level[lv] }
    }),
  ]

  return (
    <Block
      title="分档阈值"
      sub="综合分 → 等级，四档必须严格递增"
      aside={<Pill tone={W.ink4}>0 ~ 1 数轴</Pill>}
    >
      {/* 四个数字在表格里长得一样，画在数轴上就完全不同：0.05/0.10/0.12/0.90
          和 0.22/0.40/0.60/0.78 是两种系统。 */}
      <div
        style={{
          display: 'flex',
          height: 20,
          borderRadius: 4,
          overflow: 'hidden',
          border: `1px solid ${W.line}`,
        }}
      >
        {segments.map((s) => (
          <span
            key={s.key}
            title={`${LEVEL_LABEL[s.key]}：${fmtScore(s.from)} → ${fmtScore(s.to)}`}
            style={{
              width: `${Math.max(0, Math.min(1, s.to - s.from)) * 100}%`,
              background: s.key === 'none' ? W.levelWash.none : s.color,
            }}
          />
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: W.ink4, marginTop: 5, lineHeight: 1.7 }}>
        左端 0 分 = 无预警；某档的分段宽度为 0，说明该档的区间是空的，永远不会被判到。
        红色段顶到右端 = 红档可达；右端留白 = 红档的区间被浪费掉了。
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 }}>
        {ALARM_LEVELS.map((lv) => {
          const bad = issues.find((i) => i.field === `score_cutoffs.${lv}`)
          return (
            <div
              key={lv}
              data-cutoff-level={lv}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 0',
                borderBottom: `1px solid ${W.lineSoft}`,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  background: W.level[lv],
                  flex: '0 0 auto',
                }}
              />
              <span style={{ fontSize: 11.5, color: W.ink2, width: 46 }}>
                {LEVEL_LABEL[lv]}
              </span>
              {/* 这一档的**下界**：综合分 ≥ 这个数才进这一档 */}
              <span style={{ fontSize: 10.5, color: W.ink4 }}>≥</span>
              <NumField
                value={cut[lv]}
                step={0.01}
                min={0}
                max={1.5}
                disabled={disabled}
                bad={!!bad}
                onCommit={(n) => onEdit({ ...rules, scoreCutoffs: { ...cut, [lv]: n } })}
              />
              <span style={{ marginLeft: 'auto', fontSize: 10.5, color: bad ? W.bad : W.ink4 }}>
                {bad ? bad.message : `进入这一档的门槛`}
              </span>
            </div>
          )
        })}
      </div>
    </Block>
  )
}

// ---------------------------------------------------------------- 最短时长

function DurationBlock({
  rules,
  issues,
  disabled,
  onEdit,
}: {
  rules: Rules
  issues: readonly RuleIssue[]
  disabled: boolean
  onEdit: (r: Rules) => void
}) {
  const dur = rules.minDurationMin
  const sat = rules.durationSaturationMin
  const satBad = issues.find((i) => i.field === 'duration_saturation_min')

  return (
    <Block
      title="最短超阈时长"
      sub="各级要求的最短持续，必须非递减"
      aside={<Pill tone={W.ink4}>分钟</Pill>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {ALARM_LEVELS.map((lv) => {
          const bad = issues.find((i) => i.field === `min_duration_min.${lv}`)
          const ratio = sat > 0 ? dur[lv] / sat : 0
          return (
            <div
              key={lv}
              data-min-duration-level={lv}
              style={{ padding: '5px 0', borderBottom: `1px solid ${W.lineSoft}` }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11.5, color: W.ink2, width: 46 }}>
                  {LEVEL_LABEL[lv]}
                </span>
                <NumField
                  value={dur[lv]}
                  step={5}
                  min={0}
                  max={1440}
                  disabled={disabled}
                  bad={!!bad}
                  suffix="min"
                  onCommit={(n) =>
                    onEdit({ ...rules, minDurationMin: { ...dur, [lv]: n } })
                  }
                />
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: 10.5,
                    fontFamily: W.mono,
                    fontVariantNumeric: 'tabular-nums',
                    color: W.ink3,
                  }}
                >
                  {fmtMinutes(dur[lv])}
                </span>
              </div>
              {/* 这一档要求的时长占饱和值的多少。饱和值是「超过它持续因子记满分」，
                  所以这个比例直接说明该档的时长要求有多难达到。 */}
              <div style={{ marginTop: 4 }}>
                <Ruler
                  ratio={ratio}
                  color={bad ? W.bad : W.level[lv]}
                  height={3}
                  marks={[{ at: 1, color: W.lineStrong }]}
                />
              </div>
              {bad && (
                <div style={{ fontSize: 10.5, color: W.bad, marginTop: 3 }}>{bad.message}</div>
              )}
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
        <span style={{ fontSize: 11.5, color: W.ink2 }}>持续饱和值</span>
        <NumField
          value={sat}
          step={10}
          min={1}
          max={1440}
          disabled={disabled}
          bad={!!satBad}
          suffix="min"
          onCommit={(n) => onEdit({ ...rules, durationSaturationMin: n })}
        />
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: W.ink4 }}>
          {fmtMinutes(sat)} 之后持续因子记满分
        </span>
      </div>
      {satBad && <div style={{ fontSize: 10.5, color: W.bad, marginTop: 4 }}>{satBad.message}</div>}
      <div style={{ fontSize: 10.5, color: W.ink4, marginTop: 6, lineHeight: 1.7 }}>
        「非递减」允许相等：黄档和橙档都要求 10 分钟是合法的。它不允许的是
        「橙档只要 5 分钟、黄档却要 20 分钟」——那会让高等级比低等级更容易触发。
      </div>
    </Block>
  )
}

// ---------------------------------------------------------------- 最低报警等级

/**
 * `minLevelForAlarm`：判完等级之后，低于这一级的一律压成「无预警」。
 *
 * 它是**等级序整数**（1=蓝 2=黄 3=橙 4=红），不是 0~1 的分数。
 * 界面上必须把整数写在档位旁边，否则下一个人看到「2」还会以为是个阈值比例。
 */
function MinLevelBlock({
  rules,
  disabled,
  onEdit,
}: {
  rules: Rules
  disabled: boolean
  onEdit: (r: Rules) => void
}) {
  const cur = Math.round(rules.minLevelForAlarm)
  const curLevel = levelFromRankInt(cur)
  const outOfRange = cur < 1 || cur > 4

  return (
    <Block
      title="最低报警等级"
      sub="低于这一级的一律不报警"
      aside={<Pill tone={outOfRange ? W.warn : W.ink3}>当前 {cur}</Pill>}
    >
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {ALARM_LEVELS.map((lv) => {
          const rank = LEVEL_RANK[lv]
          const on = rank === cur
          return (
            <button
              key={lv}
              type="button"
              disabled={disabled}
              onClick={() => onEdit({ ...rules, minLevelForAlarm: rank })}
              title={`${LEVEL_LABEL[lv]}：低于这一级的预警都不会发出`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '5px 9px',
                borderRadius: 6,
                cursor: disabled ? 'not-allowed' : 'pointer',
                font: 'inherit',
                fontSize: 11.5,
                border: `1px solid ${on ? W.level[lv] : W.line}`,
                background: on ? W.levelWash[lv] : 'transparent',
                color: on ? W.levelInk[lv] : W.ink3,
                transition: `background 140ms ${ease}`,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  background: W.level[lv],
                  opacity: on ? 1 : 0.5,
                }}
              />
              {LEVEL_LABEL[lv]}
              <span style={{ fontFamily: W.mono, fontSize: 10.5, opacity: 0.75 }}>{rank}</span>
            </button>
          )
        })}
      </div>

      <div style={{ fontSize: 11, color: W.ink2, lineHeight: 1.75, marginTop: 9 }}>
        现在等于 <b style={{ color: W.levelInk[curLevel] }}>{LEVEL_LABEL[curLevel]}</b>
        {curLevel === 'none'
          ? '：低于它的一律不报警，也就是四级全部静默——这是「维护窗口」的用法，不是常规配置。'
          : `：判出来的等级低于${LEVEL_LABEL[curLevel]}的一律压成「无预警」，不发通知、不进待办。`}
        <br />
        <span style={{ color: W.ink4 }}>
          这个数字是<b style={{ color: W.ink3 }}>等级序</b>（1=蓝 2=黄 3=橙 4=红），
          不是 0~1 的分数。旧界面按分值渲染过它，读起来像「0.22 分才报警」——
          同一个 2，两种读法差了五百倍。
        </span>
      </div>
      {outOfRange && (
        <div style={{ fontSize: 10.5, color: W.warn, marginTop: 6 }}>
          当前值 {rules.minLevelForAlarm} 不在 1~4 之间。0 表示四级全部静默，
          大于 4 表示永远不报警；选一个档位把它拉回合法范围。
        </div>
      )}
    </Block>
  )
}

// ---------------------------------------------------------------- 趋势跨档

function TrendBlock({
  rules,
  issues,
  disabled,
  onEdit,
}: {
  rules: Rules
  issues: readonly RuleIssue[]
  disabled: boolean
  onEdit: (r: Rules) => void
}) {
  const upBad = issues.find((i) => i.field === 'trend_upgrade_slope')
  const downBad = issues.find((i) => i.field === 'trend_downgrade_slope')
  const horizonBad = issues.find((i) => i.field === 'horizon_min')

  return (
    <Block title="趋势跨档与研判窗口" sub="单位 m/h，退得比降级斜率快就降一级">
      <Row
        k="升级斜率"
        v={
          <span style={{ color: upBad ? W.bad : W.ink }}>
            {fmtRate(rules.trendUpgradeSlope)} m/h
          </span>
        }
        hint="涨得比它快就升一级"
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${W.lineSoft}` }}>
        <span style={{ fontSize: 12, color: W.ink3 }}>改这个数</span>
        <NumField
          value={rules.trendUpgradeSlope}
          step={0.01}
          min={0.001}
          disabled={disabled}
          bad={!!upBad}
          suffix="m/h"
          onCommit={(n) => onEdit({ ...rules, trendUpgradeSlope: n as Rules['trendUpgradeSlope'] })}
        />
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: W.ink4 }}>
          必须为正——只有涨才升级
        </span>
      </div>
      {upBad && <div style={{ fontSize: 10.5, color: W.bad, marginTop: 3 }}>{upBad.message}</div>}

      <Row
        k="降级斜率"
        v={
          <span style={{ color: downBad ? W.bad : W.ink }}>
            {fmtRate(rules.trendDowngradeSlope)} m/h
          </span>
        }
        hint="退得比它快就降一级"
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${W.lineSoft}` }}>
        <span style={{ fontSize: 12, color: W.ink3 }}>改这个数</span>
        <NumField
          value={rules.trendDowngradeSlope}
          step={0.01}
          max={-0.001}
          disabled={disabled}
          bad={!!downBad}
          suffix="m/h"
          onCommit={(n) =>
            onEdit({ ...rules, trendDowngradeSlope: n as Rules['trendDowngradeSlope'] })
          }
        />
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: W.ink4 }}>
          必须为负——只有退才降级
        </span>
      </div>
      {downBad && (
        <div style={{ fontSize: 10.5, color: W.bad, marginTop: 3 }}>{downBad.message}</div>
      )}

      <Row k="趋势归一化跨度" v={`${fmtScore(rules.trendScoreSpan, 3)} m/h`} hint="趋势因子记满分的斜率" />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <span style={{ fontSize: 11.5, color: W.ink2 }}>研判窗口</span>
        <NumField
          value={rules.horizonMin}
          step={15}
          min={1}
          max={1440}
          disabled={disabled}
          bad={!!horizonBad}
          suffix="min"
          onCommit={(n) => onEdit({ ...rules, horizonMin: n })}
        />
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: W.ink4 }}>{fmtMinutes(rules.horizonMin)}</span>
      </div>
      {horizonBad && (
        <div style={{ fontSize: 10.5, color: W.bad, marginTop: 4 }}>{horizonBad.message}</div>
      )}

      <div style={{ fontSize: 10.5, color: W.ink4, marginTop: 8, lineHeight: 1.7 }}>
        这两条是只降不升的硬约束：持续不够就封顶、退得快就降级，都是往下走。
        往上加档只能靠综合分本身，不能靠一个斜率读数把黄警顶成红警——
        单点斜率是十秒钟就能翻号的东西，不该有升档的权力。
      </div>
    </Block>
  )
}

// ---------------------------------------------------------------- 保存条

function SaveBar({
  issues,
  dirty,
  canPreview,
  canSave,
  roleText,
  hasImpact,
  previewStale,
  confirming,
  busy,
  onPreview,
  onReset,
  onAskSave,
  onConfirm,
  onCancel,
}: {
  issues: readonly RuleIssue[]
  dirty: boolean
  canPreview: boolean
  canSave: boolean
  roleText: string
  hasImpact: boolean
  previewStale: boolean
  confirming: boolean
  busy: boolean
  onPreview: () => void
  onReset: () => void
  onAskSave: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const errs = issues.filter((i) => i.severity === 'error')
  const warns = issues.filter((i) => i.severity === 'warn')
  const blocked = hasError(issues)

  /**
   * 保存按钮为什么按不动。三种原因写在按钮下面，而不是等用户点下去再报错——
   * 「点了没反应」和「点了之后告诉你为什么」是两种体验，后者才能让人淡定。
   */
  const reason = !canSave
    ? `当前角色（${roleText}）不能落盘规则：需要${ROLE_LABEL[minRoleFor('rules:save')]}及以上。${
        canPreview ? '你可以调参数并用「预演」看影响，只是改动不会被保存。' : '当前只能查看。'
      }`
    : errs.length > 0
      ? `${errs.length} 项错误必须先修正，否则这份草稿连预演都算不对`
      : !dirty
        ? '草稿与线上规则一致，没有可保存的改动'
        : ''
  const disabled = !canSave || blocked || !dirty || busy

  return (
    <div
      style={{
        flex: '0 0 auto',
        borderBottom: `1px solid ${W.line}`,
        background: W.stage,
        padding: '9px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: W.ink2 }}>规则草稿</span>
        <Pill tone={dirty ? W.accent : W.ink4}>{dirty ? '已改动，未落盘' : '与线上一致'}</Pill>
        {warns.length > 0 && <Pill tone={W.warn}>{warns.length} 项提醒</Pill>}
        {blocked && <Pill tone={W.bad}>{errs.length} 项错误</Pill>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 7 }}>
          <button
            type="button"
            onClick={onReset}
            disabled={!dirty || busy}
            style={btn(!dirty || busy, 'plain')}
            title="丢弃本地草稿，回到线上当前值"
          >
            丢弃改动
          </button>
          <button
            type="button"
            onClick={onPreview}
            disabled={!canPreview || busy}
            style={btn(!canPreview || busy, 'plain')}
          >
            {busy && canPreview ? '…' : '预演'}
          </button>
          <button
            type="button"
            onClick={onAskSave}
            disabled={disabled}
            style={btn(disabled, 'accent')}
            title={reason || '把当前草稿落盘，全城等级立刻重算'}
          >
            {confirming ? '等待确认' : '保存并全城重算'}
          </button>
        </span>
      </div>

      {reason && <div style={{ fontSize: 11, color: W.ink3, lineHeight: 1.6 }}>{reason}</div>}

      {errs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {errs.slice(0, 4).map((i) => (
            <div
              key={i.field + i.message}
              style={{ fontSize: 11, color: W.bad, lineHeight: 1.6 }}
            >
              <code style={{ fontFamily: W.mono, fontSize: 10.5 }}>{i.field}</code> · {i.message}
            </div>
          ))}
          {errs.length > 4 && (
            <div style={{ fontSize: 10.5, color: W.ink4 }}>还有 {errs.length - 4} 项错误</div>
          )}
        </div>
      )}

      {/* 二次确认就地展开。这里不能用 window.confirm：它会冻结整屏，
          而确认需要的信息（会变几站、往哪个方向变）就在上一块里，看不见就白问。 */}
      {confirming && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
            padding: '8px 10px',
            borderRadius: 7,
            border: `1px solid ${hasImpact && !previewStale ? W.accent + '55' : W.warn + '66'}`,
            background: hasImpact && !previewStale ? W.accentSoft : W.levelWash.yellow,
          }}
        >
          <span style={{ fontSize: 11.5, color: W.ink2, lineHeight: 1.7 }}>
            保存后全城站点的等级会立刻按新规则重判，通知与待办随之改变。
            {hasImpact && !previewStale
              ? '上方预演就是这次改动的结果，确认无误再落盘。'
              : '当前草稿还没有用「预演」看过结果，落盘前你不会知道哪几个站会变档。'}
          </span>
          <div style={{ display: 'flex', gap: 7 }}>
            {!(hasImpact && !previewStale) && (
              <button type="button" onClick={onPreview} disabled={busy} style={btn(busy, 'plain')}>
                先预演一次
              </button>
            )}
            <button type="button" onClick={onCancel} disabled={busy} style={btn(busy, 'plain')}>
              取消
            </button>
            <button type="button" onClick={onConfirm} disabled={busy} style={btn(busy, 'accent')}>
              {busy ? '保存中…' : '确认落盘'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 小件

/** 数字输入：编辑期间保留用户原样输入，失焦才提交并对齐格式。 */
function NumField({
  value,
  onCommit,
  step = 1,
  min,
  max,
  disabled,
  bad,
  suffix,
  width = 84,
}: {
  value: number
  onCommit: (n: number) => void
  step?: number
  min?: number
  max?: number
  disabled?: boolean
  bad?: boolean
  suffix?: string
  width?: number
}) {
  const [text, setText] = useState(() => fmtNum(value))
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    // 只在非编辑态跟随外部值。编辑中如果同步，用户打「0.」的中间态会被当成 0
    // 覆盖回去，小数点永远打不出来。
    if (!editing) setText(fmtNum(value))
  }, [value, editing])

  const commit = () => {
    setEditing(false)
    const n = Number(text)
    if (!Number.isFinite(n)) {
      setText(fmtNum(value))
      return
    }
    if (min !== undefined && n < min) return onCommit(min)
    if (max !== undefined && n > max) return onCommit(max)
    onCommit(n)
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input
        type="number"
        value={text}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onFocus={() => setEditing(true)}
        onChange={(e) => {
          setEditing(true)
          setText(e.currentTarget.value)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        style={{
          width,
          padding: '3px 6px',
          borderRadius: 5,
          border: `1px solid ${bad ? W.bad : W.line}`,
          background: disabled ? W.lineSoft : W.stage,
          color: disabled ? W.ink4 : W.ink,
          textAlign: 'right',
          fontSize: 12,
          fontFamily: W.mono,
          fontVariantNumeric: 'tabular-nums',
        }}
      />
      {suffix && <span style={{ fontSize: 10.5, color: W.ink4 }}>{suffix}</span>}
    </span>
  )
}

function btn(disabled: boolean, kind: 'accent' | 'plain'): CSSProperties {
  const accent = kind === 'accent'
  return {
    padding: '5px 11px',
    borderRadius: 6,
    fontSize: 11.5,
    fontWeight: accent ? 600 : 400,
    fontFamily: W.sans,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    border: `1px solid ${accent ? W.accent : W.line}`,
    background: accent ? W.accent : 'transparent',
    color: accent ? W.stage : W.ink2,
    transition: `background 140ms ${ease}`,
  }
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6
const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))

/**
 * 综合分、分档阈值、权重都是 0~1 的**无量纲量**。领域层故意没有给它们配 fmt*：
 * 套 `fmtPct` 会被读成「概率 22%」，而术语表里写明了综合分不是概率。
 * 所以这里固定按小数展示——看到小数点就是「这是评分」，看到 % 才是概率。
 */
function fmtScore(v: number, digits = 3): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '—'
}

function fmtNum(v: number): string {
  return Number.isFinite(v) ? String(round6(v)) : ''
}

function fmtPctLocal(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

/** 预演时刻是操作行为（墙钟），不是遥测，所以不走 fmtTime 的仿真轴语义。 */
function fmtClockLike(t: number): string {
  if (!t) return '—'
  const d = new Date(t * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const DOCTRINE: readonly (readonly [string, string])[] = [
  [
    '为什么不只看峰值',
    '单点峰值高但只超阈 5 分钟的积水，和超阈两小时的积水，处置需求完全不同。峰值回答「多深」，持续回答「多久」。',
  ],
  [
    '为什么要有趋势',
    '两条曲线峰值一样、持续一样，一条还在涨一条已经在退，值班优先级不同。趋势是唯一带方向的因子。',
  ],
  [
    '为什么两条硬约束只降不升',
    '持续不够就封顶、退得快就降级，都是往下走。往上加档必须靠综合分本身，不能靠一个斜率读数把黄警顶成红警。',
  ],
  [
    '为什么改规则要先预演',
    '保存那一刻全城等级立刻重算。用同一条已发布曲线重判，变化才只可能来自规则；重新预测就分不清是规则还是模型噪声。',
  ],
]
