import { useMemo } from 'react'
import { useAlerts } from '../data/queries'
import { useWatchlist } from '../view/useWatchlist'
import { ageText, useShiftReport } from '../view/useShiftReport'
import { useSituation } from '../view/useSituation'
import { GLOSSARY, Glossary } from '../components/interactive/Tooltip'
import {
  DISPOSITION_HINT,
  DISPOSITION_LABEL,
  LEVEL_LABEL,
  STATE_LABEL,
  fmtDelta,
  fmtDepth,
  fmtTime,
  isActive,
  isUnack,
} from '../domain'
import { Nothing, Ruler } from './kit'
import { W, DRILL_W, ease } from './visual'
import type { StageCtx } from './ctx'
import type { Crumb } from './model'

/**
 * 右栏：钻取栈。
 *
 * 它不是「第五个页面」，是**一条能回去的路**。左栏回答「有哪些对象」，
 * 中舞台回答「我正在处理什么」，而这一栏回答**「我是怎么走到这里的、
 * 路上顺手看过什么」**——这正好是标签导航永远给不出来的东西：
 * 导航只告诉你「还能去哪」，栈告诉你「你从哪来」。
 *
 * 三件事决定了它的形状：
 *
 * 1. **只展开最上面一层**，下面几层压成一条轨迹条。若每层都展开，
 *    452px 里塞进三四块内容，每块都只剩标题——那就退回成「字段罗列」了。
 * 2. **轨迹条上的每一段都可点**，点了就回到那一层（含它自己）。
 *    这是「层次关系」这件事唯一诚实的表达方式：能回退，才算层次。
 * 3. 栈空时它**不是空白**，而是「此刻该管什么」——否则一屏里就永远有一块
 *    452px 的空地，而这一屏的全部主张就是「不留白、不换页」。
 */
export function Drill({ ctx }: { ctx: StageCtx }) {
  const { trail } = ctx.state
  const top = trail.length > 0 ? trail[trail.length - 1] : null

  return (
    <aside
      data-tour="wb-drill"
      data-drill="stack"
      aria-label="钻取面板"
      style={{
        width: DRILL_W,
        flex: '0 0 auto',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: W.drill,
        borderLeft: `1px solid ${W.line}`,
      }}
    >
      <header
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderBottom: `1px solid ${W.line}`,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: W.ink2, letterSpacing: 0.4 }}>
          {top ? '钻取' : '此刻该管什么'}
        </span>
        {trail.length > 0 && (
          <span style={{ fontSize: 11, color: W.ink4 }}>{trail.length} 层</span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {trail.length > 1 && (
            <DrillBtn onClick={ctx.pop} title="收起最上面一层（回到上一层）">
              上一层
            </DrillBtn>
          )}
          {trail.length > 0 && (
            <DrillBtn onClick={() => ctx.popTo(0)} title="清空钻取栈，回到「此刻该管什么」">
              清空
            </DrillBtn>
          )}
        </div>
      </header>

      {/* 轨迹条。横向滚动而不是换行——换行会让下面那块内容的位置随层数上下跳。 */}
      {trail.length > 0 && (
        <div
          data-trail=""
          style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            padding: '7px 12px',
            borderBottom: `1px solid ${W.lineSoft}`,
            overflowX: 'auto',
            scrollbarWidth: 'none',
          }}
        >
          {trail.map((c, i) => (
            <span key={`${c.kind}-${i}`} style={{ display: 'inline-flex', alignItems: 'center' }}>
              {i > 0 && <span style={{ color: W.ink4, fontSize: 11, padding: '0 2px' }}>›</span>}
              <button
                type="button"
                onClick={() => ctx.popTo(i)}
                title={i === trail.length - 1 ? '当前层' : `回到「${c.name}」`}
                style={{
                  border: 0,
                  background: i === trail.length - 1 ? W.accentSoft : 'none',
                  padding: '2px 5px',
                  borderRadius: 5,
                  cursor: 'pointer',
                  font: 'inherit',
                  fontSize: 11,
                  whiteSpace: 'nowrap',
                  color: i === trail.length - 1 ? W.ink : W.ink3,
                  fontWeight: i === trail.length - 1 ? 600 : 400,
                }}
              >
                {c.name}
              </button>
            </span>
          ))}
        </div>
      )}

      <div style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', padding: 12 }}>
        {top ? <CrumbBody c={top} ctx={ctx} /> : <NowWhat ctx={ctx} />}
      </div>
    </aside>
  )
}

function DrillBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        border: `1px solid ${W.line}`,
        background: W.stage,
        borderRadius: 6,
        padding: '3px 8px',
        fontSize: 11,
        color: W.ink2,
        cursor: 'pointer',
        font: 'inherit',
      }}
    >
      {children}
    </button>
  )
}

/** 钻取面板里的小节。刻意不做成卡片：卡片底一多，就分不清哪块是主内容。 */
function Part({
  title,
  hint,
  children,
}: {
  title: string
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section
      data-sec={title}
      style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
        <h5 style={{ margin: 0, fontSize: 11.5, fontWeight: 600, color: W.ink2 }}>{title}</h5>
        {hint && <span style={{ fontSize: 10.5, color: W.ink4 }}>{hint}</span>}
      </div>
      {children}
    </section>
  )
}

function KV({
  k,
  v,
  tone,
  mono = true,
}: {
  k: string
  v: React.ReactNode
  tone?: string
  mono?: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        padding: '4px 0',
        borderBottom: `1px solid ${W.lineSoft}`,
      }}
    >
      <span style={{ fontSize: 11.5, color: W.ink3, flex: '0 0 auto' }}>{k}</span>
      <span
        style={{
          marginLeft: 'auto',
          fontSize: 12,
          color: tone ?? W.ink,
          fontFamily: mono ? W.mono : W.sans,
          fontVariantNumeric: 'tabular-nums',
          textAlign: 'right',
        }}
      >
        {v}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------- 栈空时

/**
 * 栈空时右栏显示什么。
 *
 * 这里刻意**不显示「暂无内容」**。右栏占着 452px，如果它是空的，
 * 整屏就有四分之一是装饰。它应该回答**当前最该动手的几件事**，
 * 而这几件事正好也在左栏顶部——两个地方都能开始干活。
 */
function NowWhat({ ctx }: { ctx: StageCtx }) {
  const shift = useShiftReport()
  const sit = useSituation()

  const top3 = shift.todos.slice(0, 3)

  return (
    <>
      <Part title="现在" hint={sit.issuedAt ? `发布于 ${fmtTime(sit.issuedAt, 'HH:mm')}` : undefined}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '6px 10px',
            padding: '8px 10px',
            background: W.stage,
            border: `1px solid ${W.line}`,
            borderRadius: 8,
          }}
        >
          <MiniFigure
            v={String(sit.alarmCount)}
            label="站需关注"
            tone={sit.alarmCount > 0 ? W.bad : W.ok}
          />
          <MiniFigure v={String(sit.rainingSites)} label="站在下雨" tone={W.accent} />
          <MiniFigure
            v={String(shift.todos.length)}
            label="项未闭环"
            tone={shift.todos.length > 0 ? W.warn : W.ok}
          />
          <MiniFigure v={String(shift.active)} label="条预警成立" tone={W.ink} />
        </div>
      </Part>

      <Part title="优先处理" hint="按严重度与滞留时长排序">
        {top3.length === 0 ? (
          <Nothing
            why="本班没有未闭环的预警"
            hint="雨停之后没有人在等处置。已解除但没归档的条数在「本班交接」里。"
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {top3.map((t) => (
              <button
                key={t.event.id}
                type="button"
                onClick={() => ctx.goStage({ kind: 'event', eventId: t.event.id })}
                style={{
                  textAlign: 'left',
                  border: `1px solid ${W.line}`,
                  borderLeft: `3px solid ${
                    t.tone === 'critical' ? W.bad : t.tone === 'warn' ? W.warn : W.accent
                  }`,
                  background: W.stage,
                  borderRadius: 6,
                  padding: '7px 9px',
                  cursor: 'pointer',
                  font: 'inherit',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: W.ink }}>
                    {t.event.siteName}
                  </span>
                  <span style={{ fontSize: 10.5, color: W.levelInk[t.event.level] }}>
                    {LEVEL_LABEL[t.event.level]}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, color: W.ink4 }}>
                    滞留 {ageText(t.ageMin)}
                  </span>
                </span>
                {/* 这一行是交接里唯一真正有用的：该谁做、做什么。 */}
                <span style={{ fontSize: 11.5, color: W.ink2, lineHeight: 1.5 }}>{t.action}</span>
              </button>
            ))}
          </div>
        )}
      </Part>

      <Part title="从哪开始" hint="左栏点站，顶栏点事实">
        <div style={{ fontSize: 11.5, color: W.ink3, lineHeight: 1.85 }}>
          这一栏会记住你看过的东西，一层压一层。
          <br />
          点左栏任何一个站、或点地图上的气泡，它就会开始记路径；
          沿着轨迹条上的名字往回点，就能退回去。
        </div>
      </Part>
    </>
  )
}

function MiniFigure({ v, label, tone }: { v: string; label: string; tone: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
      <span
        style={{
          fontSize: 19,
          fontWeight: 600,
          color: tone,
          fontFamily: W.mono,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {v}
      </span>
      <span style={{ fontSize: 10.5, color: W.ink4 }}>{label}</span>
    </div>
  )
}

// ---------------------------------------------------------------- 各层内容

function CrumbBody({ c, ctx }: { c: Crumb; ctx: StageCtx }) {
  switch (c.kind) {
    case 'site':
      return <SiteCrumb siteId={c.siteId} ctx={ctx} />
    case 'event':
      return <EventCrumb eventId={c.eventId} ctx={ctx} />
    case 'metric':
      return <MetricCrumb term={c.key} name={c.name} />
    case 'layer':
      return <LayerCrumb layerKey={c.key} name={c.name} ctx={ctx} />
    case 'api':
      return <ApiCrumb apiKey={c.key} name={c.name} ctx={ctx} />
  }
}

/**
 * 站点这一层：**只做「顺手看一眼」的事**。
 *
 * 完整的四问（现在多严重 / 接下来怎样 / 凭什么这样判 / 谁在管）在中舞台里，
 * 这里只给三个数字、一条阈值距离、它的预警。若这里也铺开四问，
 * 右栏就变成第二个详情页，用户会不知道哪个才是「真的」。
 */
function SiteCrumb({ siteId, ctx }: { siteId: string; ctx: StageCtx }) {
  const list = useWatchlist('level')
  const alerts = useAlerts(false)
  const g = list.find((x) => x.site.id === siteId) ?? null

  const mine = useMemo(
    () => (alerts.data ?? []).filter((a) => a.siteId === siteId).slice(0, 5),
    [alerts.data, siteId],
  )

  if (!g) {
    return (
      <Nothing
        why="这个站不在当前列表里"
        hint="它可能被左栏的筛选挡掉了，清空筛选即可看到。"
      />
    )
  }

  return (
    <>
      <Part title="一眼" hint={`${g.site.district} · ${g.site.id}`}>
        <div style={{ display: 'flex', gap: 14, padding: '2px 0 8px' }}>
          <MiniFigure
            v={fmtDepth(g.reading.depth)}
            label="m 积水"
            tone={W.levelInk[g.assessment.level]}
          />
          <MiniFigure v={fmtDelta(g.reading.trend1h)} label="m/1h" tone={W.ink} />
          <MiniFigure
            v={LEVEL_LABEL[g.assessment.level]}
            label="等级"
            tone={W.levelInk[g.assessment.level]}
          />
        </div>
        <Ruler
          ratio={g.depthRatio}
          color={W.level[g.assessment.level]}
          height={6}
          marks={[{ at: 1, color: W.level.red }]}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 4,
            fontSize: 10.5,
            color: W.ink4,
          }}
        >
          <span>相对红色阈值 {Math.round(g.depthRatio * 100)}%</span>
          <span>红阈 {fmtDepth(g.redThreshold)} m</span>
        </div>
      </Part>

      <Part title="这个站的预警" hint={mine.length > 0 ? `${mine.length} 条` : undefined}>
        {mine.length === 0 ? (
          <div style={{ fontSize: 11.5, color: W.ink3 }}>
            这个站没有报过预警——它可能只是跟着涨，没到档。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {mine.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() =>
                  ctx.openEvent(a.id, `${a.siteName} ${LEVEL_LABEL[a.level]}`, a.level)
                }
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 7,
                  textAlign: 'left',
                  border: `1px solid ${W.line}`,
                  background: W.stage,
                  borderRadius: 6,
                  padding: '6px 8px',
                  cursor: 'pointer',
                  font: 'inherit',
                }}
              >
                <span
                  style={{
                    width: 3,
                    height: 12,
                    borderRadius: 2,
                    background: W.level[a.level],
                    alignSelf: 'center',
                  }}
                />
                <span style={{ fontSize: 11.5, color: W.levelInk[a.level] }}>
                  {LEVEL_LABEL[a.level]}
                </span>
                <span style={{ fontSize: 10.5, color: W.ink4 }}>{STATE_LABEL[a.state]}</span>
                <span style={{ marginLeft: 'auto', fontSize: 10.5, color: W.ink4 }}>
                  {fmtTime(a.raisedAt, 'MM-DD HH:mm')}
                </span>
              </button>
            ))}
          </div>
        )}
      </Part>

      <OpenBtn label="在中舞台看这个站" onClick={() => ctx.goStage({ kind: 'site', siteId })} />
    </>
  )
}

/** 预警这一层：给「要不要进去处理」用的几个判断，把处置动作留给中舞台。 */
function EventCrumb({ eventId, ctx }: { eventId: number; ctx: StageCtx }) {
  const alerts = useAlerts(false)
  const e = (alerts.data ?? []).find((a) => a.id === eventId) ?? null

  if (!e) {
    return (
      <Nothing
        why="这条预警已不在列表里"
        hint="可能已经超出查询窗口。处理动作在中舞台的卷宗里。"
      />
    )
  }

  return (
    <>
      <Part title="这条预警" hint={`#${e.id}`}>
        <KV k="站点" v={e.siteName} mono={false} />
        <KV k="等级" v={LEVEL_LABEL[e.level]} tone={W.levelInk[e.level]} mono={false} />
        <KV k="综合分" v={e.score.toFixed(2)} />
        <KV
          k="峰值"
          v={`${fmtDepth(e.peakValue)} m${e.peakAtMin != null ? ` @+${e.peakAtMin}min` : ''}`}
        />
        <KV k="超阈时长" v={`${e.durationMin} min`} />
        <KV k="阅读状态" v={STATE_LABEL[e.state]} mono={false} />
        <KV k="处置状态" v={DISPOSITION_LABEL[e.disposition]} mono={false} />
      </Part>

      <Part title="两条轴为什么分开">
        <div style={{ fontSize: 11.5, color: W.ink3, lineHeight: 1.8 }}>
          <b style={{ color: W.ink2 }}>{STATE_LABEL[e.state]}</b> 是模型说的——
          {isActive(e.state) ? '现在仍然成立' : '模型认为已经退水'}
          {isUnack(e.state) ? '，但还没有人确认过' : '，已有人确认'}。
          <br />
          <b style={{ color: W.ink2 }}>{DISPOSITION_LABEL[e.disposition]}</b> 是人做的——
          {DISPOSITION_HINT[e.disposition]}
          <br />
          合成一个「状态」会出现「已解除但没人去过现场」这种说不清的情况。
        </div>
      </Part>

      <OpenBtn label="打开卷宗，就地处置" onClick={() => ctx.goStage({ kind: 'event', eventId })} />
    </>
  )
}

/**
 * 术语这一层：解释**只从词表取一份**（`GLOSSARY`）。
 * 在组件里手抄第二遍，就会出现两处对同一个词给出不同说法。
 */
function MetricCrumb({ term, name }: { term: string; name: string }) {
  const text = GLOSSARY[term]
  return (
    <Part title={name} hint="术语">
      {text ? (
        <div style={{ fontSize: 11.5, color: W.ink2, lineHeight: 1.85 }}>
          <Glossary term={term} />
          <div style={{ marginTop: 6, color: W.ink3 }}>{text}</div>
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: W.ink3, lineHeight: 1.8 }}>
          这个词还没有写进词表。词表在{' '}
          <code style={{ fontFamily: W.mono }}>components/interactive/Tooltip.tsx</code> 的{' '}
          <code style={{ fontFamily: W.mono }}>GLOSSARY</code>。
        </div>
      )}
    </Part>
  )
}

function LayerCrumb({
  layerKey,
  name,
  ctx,
}: {
  layerKey: string
  name: string
  ctx: StageCtx
}) {
  return (
    <>
      <Part title={name} hint="链路的一层">
        <div style={{ fontSize: 11.5, color: W.ink2, lineHeight: 1.85 }}>
          这一层的现象、判据、恢复动作都写在「链路与接口」里，
          <b style={{ color: W.ink }}>这里不重复一遍</b>——同一个事实写两处，
          改一处忘一处就会出现两块内容互相矛盾。
        </div>
      </Part>
      <OpenBtn
        label="去「链路与接口」看这一层"
        onClick={() => ctx.goStage({ kind: 'plumbing' })}
      />
      <div style={{ fontSize: 10.5, color: W.ink4, marginTop: 6 }}>层标识：{layerKey}</div>
    </>
  )
}

function ApiCrumb({ apiKey, name, ctx }: { apiKey: string; name: string; ctx: StageCtx }) {
  return (
    <>
      <Part title={name} hint="接口">
        <div style={{ fontSize: 11.5, color: W.ink2, lineHeight: 1.85 }}>
          接口的鉴权、权限、返回样例、curl 都在「链路与接口」里，这里只记你点过它。
        </div>
      </Part>
      <OpenBtn
        label="去「链路与接口」看这个接口"
        onClick={() => ctx.goStage({ kind: 'plumbing' })}
      />
      <div style={{ fontSize: 10.5, color: W.ink4, marginTop: 6 }}>接口标识：{apiKey}</div>
    </>
  )
}

function OpenBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        border: `1px solid ${W.accent}44`,
        background: W.accentSoft,
        color: W.accent,
        borderRadius: 7,
        padding: '8px 10px',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        font: 'inherit',
        transition: `background 160ms ${ease}`,
      }}
    >
      {label}
    </button>
  )
}
