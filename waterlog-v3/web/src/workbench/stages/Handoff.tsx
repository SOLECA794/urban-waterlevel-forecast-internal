import {
  ACK_SLA_MIN,
  SHIFT_HOURS,
  ackVerdict,
  ageText,
  closureRate,
  useShiftReport,
  type ShiftTodo,
  type TodoTone,
} from '../../view/useShiftReport'
import {
  DISPOSITION_LABEL,
  LEVEL_LABEL,
  fmtTime,
  isActive,
  type AlertEvent,
} from '../../domain'
import { Block, Figure, Nothing, Pill, Shimmer } from '../kit'
import { W } from '../visual'
import type { StageCtx } from '../ctx'

/**
 * 舞台：本班交接。
 *
 * 这一屏要回答的问题**不是**「这一班有哪些预警」——那是预警中心的事。
 * 它要回答的是：**这一班还剩什么没完，交给下一班的时候该说哪几句话。**
 *
 * 由此推出一条排版纪律，也是上一版踩过的坑：
 * `todos`（还要人现在动手的）和「已解除但没人归档的」**必须分开**。
 * 当时把两类混在一个列表里，一次降雨过程中积下 89 条「已解除没人处理」，
 * 页面被撑到 8000px，真正要交接的那 3 条被埋在最下面——
 * 雨停了不需要人现在到场，只需要有人事后点一下归档，这两件事的紧急度差一个量级。
 *
 * 第二件纪律：每行的主语是 `ShiftTodo.action`（「该谁做、做什么」），
 * 不是等级、不是分数。等级只是这行的配色依据，值班员交接时说出口的那句话
 * 恰好就是 action 的内容，所以它必须是列表里字号最大的一行。
 */

/** 严重度 → 配色。critical 用 bad/warn/bad 三档而不是等级色： */
// 交接的紧急度由「处置卡在哪一步」决定，不由水位多高决定——
// 一条蓝色预警卡在「已派单 40 分钟没人到场」比一条红色预警「现场处置中」更该先说。
const TONE_INK: Record<TodoTone, string> = {
  critical: W.bad,
  warn: W.warn,
  info: W.ink3,
}

const TONE_LABEL: Record<TodoTone, string> = {
  critical: '现在就要动',
  warn: '盯着',
  info: '可稍后',
}

export function HandoffStage({ ctx }: { ctx: StageCtx }) {
  const report = useShiftReport(SHIFT_HOURS)

  if (!report.hasData) {
    return (
      <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex', padding: 12 }}>
        <Block title="本班交接" grow>
          {report.timeline.length === 0 && report.todos.length === 0 ? (
            <Nothing
              why="还没有拿到本班的预警与处置记录"
              hint="交接报告要读预警四态机和处置轴两条线，任何一条没到都算不出「还剩什么没完」。顶栏链路指示能看出断在哪一层。"
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Shimmer h={64} />
              <Shimmer h={120} />
            </div>
          )}
        </Block>
      </div>
    )
  }

  const closed = closureRate(report)
  const verdict = ackVerdict(report)

  // 超过 15 分钟没确认的，和确认了但确认得太慢的，是两种不同的失职：
  // 前者是「根本没人看见」，后者是「看见了但拖了」。点名要分开点。
  const unackedOver = report.todos.filter((t) => t.ackMin === null && t.ageMin > ACK_SLA_MIN)
  const slowAck = report.todos.filter((t) => t.ackMin !== null && t.ackMin > ACK_SLA_MIN)

  // 已解除 + 处置轴还挂在 open 的：不是交接事项，是归档积压。
  // 只在本班事件流里数——全库那个数（report.backlog）太大且与本班无关，
  // 放在「这一班」的报告里会让人误以为是这一班没做完的事。
  const archiveInShift = report.timeline.filter(
    (e) => !isActive(e.state) && e.disposition === 'open',
  ).length

  return (
    <div
      style={{
        flex: '1 1 0',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 12,
        // 整页不滚：交接是一屏之内要看完的事。
        // 需要滚的是「未闭环清单」与「事件流」这两个内部列表，各滚各的。
        overflow: 'hidden',
      }}
    >
      {/* 四个数字：一屏之内先给交代，明细在下面。 */}
      <Block
        title={`这一班（近 ${report.hours} 小时）`}
        sub={`${fmtTime(report.from, 'MM-DD HH:mm')} — ${fmtTime(report.to, 'HH:mm')}`}
        aside={verdict ? <Pill tone={verdict.ok ? W.ok : W.warn}>{verdict.text}</Pill> : undefined}
        pad={10}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            gap: 10,
            alignItems: 'end',
          }}
        >
          <Figure
            value={report.raised}
            label="本班新升起"
            hint={closed === null ? '本班没有新预警' : `其中 ${report.cleared} 条已解除`}
          />
          <Figure
            value={report.cleared}
            label="已解除"
            tone={W.ok}
            hint={closed === null ? '—' : `处置完成率 ${(closed * 100).toFixed(0)}%`}
          />
          <Figure
            value={report.active}
            label="仍激活"
            tone={report.active > 0 ? W.levelInk[report.worst] ?? W.ink : W.ink}
            hint={`最严重 ${LEVEL_LABEL[report.worst]}`}
          />
          <Figure
            value={report.todos.length}
            label="未闭环待办"
            tone={report.todos.length > 0 ? W.bad : W.ok}
            hint={report.todos.length > 0 ? '下一班要接手的就是这些' : '可以干净交班'}
          />
        </div>
      </Block>

      {/* 主区：左「还剩什么没完」，右「SLA + 归档积压」。 */}
      <div
        style={{
          flex: '1 1 0',
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.6fr) minmax(300px, 1fr)',
          gap: 12,
        }}
      >
        <Block
          title="未闭环清单"
          sub="按「谁现在该动手」排序，不是按等级"
          aside={
            <Pill tone={report.todos.length > 0 ? W.bad : W.ok}>
              {report.todos.length} 条待接
            </Pill>
          }
          grow
          pad={0}
        >
          {report.todos.length === 0 ? (
            <Nothing
              why="本班没有需要下一班接手的事"
              hint="所有预警都已解除，且没有卡在派单/到场任一环节的事件。"
            />
          ) : (
            <div style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', padding: '2px 8px 8px' }}>
              {report.todos.map((t) => (
                <TodoRow key={t.event.id} t={t} ctx={ctx} />
              ))}
            </div>
          )}
        </Block>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflowY: 'auto' }}>
          {/* SLA：唯一可以量化「这班干得好不好」的东西。 */}
          <Block
            title="确认时效"
            sub={`${ACK_SLA_MIN} 分钟内确认是行业常见口径`}
            aside={<Pill tone={verdict?.ok ? W.ok : verdict ? W.warn : W.ink4}>{ACK_SLA_MIN}m</Pill>}
            pad={10}
          >
            <SlaLine
              label="平均确认耗时"
              value={report.avgAckMin === null ? '—' : `${report.avgAckMin} 分钟`}
              tone={
                report.avgAckMin === null
                  ? W.ink4
                  : report.avgAckMin <= ACK_SLA_MIN
                    ? W.ok
                    : W.warn
              }
            />
            <SlaLine
              label={`超 ${ACK_SLA_MIN} 分钟仍未确认`}
              value={`${unackedOver.length} 条`}
              tone={unackedOver.length > 0 ? W.bad : W.ink3}
            />
            <SlaLine
              label="确认了但确认晚了"
              value={`${slowAck.length} 条`}
              tone={slowAck.length > 0 ? W.warn : W.ink3}
            />
            {(unackedOver.length > 0 || slowAck.length > 0) && (
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontSize: 10.5, color: W.ink4 }}>点名（站名即入口）</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {unackedOver.slice(0, 8).map((t) => (
                    <Pill
                      key={`u-${t.event.id}`}
                      tone={W.bad}
                      onClick={() => ctx.openEvent(t.event.id, t.event.siteName, t.event.level)}
                      title={`升起 ${ageText(t.ageMin)}，至今未确认`}
                    >
                      {t.event.siteName} {ageText(t.ageMin)}
                    </Pill>
                  ))}
                  {slowAck.slice(0, 6).map((t) => (
                    <Pill
                      key={`s-${t.event.id}`}
                      tone={W.warn}
                      onClick={() => ctx.openEvent(t.event.id, t.event.siteName, t.event.level)}
                      title={`确认用了 ${t.ackMin} 分钟`}
                    >
                      {t.event.siteName} {t.ackMin}m 才确认
                    </Pill>
                  ))}
                </div>
              </div>
            )}
          </Block>

          {/* 归档积压：故意单独一块，且明确写「不需要现在处理」。
              混进待办列表是这个页面上一版撑到 8000px 的直接原因。 */}
          <Block
            title="已解除 · 待归档"
            sub="不需要现在处理，但要有人事后归档"
            aside={<Pill tone={archiveInShift > 0 ? W.ink3 : W.ok}>{archiveInShift} 条</Pill>}
            pad={10}
          >
            {archiveInShift === 0 ? (
              <span style={{ fontSize: 11.5, color: W.ink3, lineHeight: 1.7 }}>
                本班事件全部有处置记录，没有需要补归档的。
              </span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11.5, color: W.ink2, lineHeight: 1.7 }}>
                  这些是「雨停了、预警解除了，但处置轴上一直没留记录」的事件。
                  它们不进上面的未闭环清单：现场不需要派人，只需要有人在系统里补一笔归档，
                  否则下次复盘时这批事件既不算处置过、也说不清当时查没查。
                </span>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    paddingTop: 4,
                    borderTop: `1px solid ${W.lineSoft}`,
                  }}
                >
                  <span style={{ fontSize: 11, color: W.ink3 }}>全库累计</span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 13,
                      fontFamily: W.mono,
                      fontVariantNumeric: 'tabular-nums',
                      color: report.backlog > 0 ? W.ink2 : W.ok,
                    }}
                  >
                    {report.backlog} 条
                  </span>
                </div>
              </div>
            )}
          </Block>

          {/* 这一班的预测靠不靠谱：用在线滚动口径（唯一能证伪的），不用离线指标。 */}
          <Block title="本班预测水平" sub="在线滚动口径" pad={10}>
            {report.quality ? (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <Figure
                  value={`${report.quality.skill !== null && report.quality.skill > 0 ? '+' : ''}${
                    report.quality.skill === null ? '—' : report.quality.skill.toFixed(3)
                  }`}
                  label="skill（3h）"
                  size={22}
                  tone={
                    report.quality.skill !== null && report.quality.skill > 0 ? W.ok : W.warn
                  }
                  hint={`n=${report.quality.n}`}
                />
                <button
                  type="button"
                  onClick={() => ctx.openMetric('skill', '技巧分 skill')}
                  style={{
                    marginLeft: 'auto',
                    border: 0,
                    background: 'none',
                    padding: 0,
                    fontSize: 10.5,
                    color: W.accent,
                    cursor: 'pointer',
                    font: 'inherit',
                  }}
                >
                  这个数怎么算 →
                </button>
              </div>
            ) : (
              <span style={{ fontSize: 11.5, color: W.ink3, lineHeight: 1.7 }}>
                还没有已结算的预测。1h 预见期要先走完一轮才会结算，约 1 分钟。
              </span>
            )}
          </Block>
        </div>
      </div>

      {/* 事件流：这一班发生过什么。新的在前。 */}
      <div style={{ flex: '0 0 186px', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Block
          title="本班事件流"
          sub="新的在前 · 点站名进站点，点右箭头进事件卷宗"
          aside={<Pill tone={W.ink4}>{report.timeline.length} 条</Pill>}
          grow
          dense
          pad={0}
        >
          {report.timeline.length === 0 ? (
            <Nothing why="本班次没有新升起的预警" hint="事件流只收本班窗口内升起的事件。" />
          ) : (
            <div style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', padding: '6px 10px 2px' }}>
              {report.timeline.map((e) => (
                <TimelineRow key={e.id} e={e} ctx={ctx} />
              ))}
            </div>
          )}
        </Block>
      </div>
    </div>
  )
}

/** 一行未闭环事项。action 是主语，所以它占两个行高、字号最大。 */
function TodoRow({ t, ctx }: { t: ShiftTodo; ctx: StageCtx }) {
  const e = t.event
  const ink = TONE_INK[t.tone]
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '7px 6px 7px 8px',
        borderLeft: `3px solid ${ink}`,
        borderBottom: `1px solid ${W.lineSoft}`,
      }}
    >
      <div style={{ flex: '1 1 0', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => ctx.goStage({ kind: 'site', siteId: e.siteId })}
            title="打开这一站的详情"
            style={{
              border: 0,
              background: 'none',
              padding: 0,
              font: 'inherit',
              fontSize: 12,
              fontWeight: 600,
              color: W.ink,
              cursor: 'pointer',
            }}
          >
            {e.siteName}
          </button>
          <Pill tone={W.levelInk[e.level] ?? W.ink3} fill>
            {LEVEL_LABEL[e.level]}
          </Pill>
          <span
            style={{
              fontSize: 10.5,
              color: W.ink4,
              fontFamily: W.mono,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            已挂 {ageText(t.ageMin)}
          </span>
          {t.ackMin === null ? (
            <Pill tone={t.ageMin > ACK_SLA_MIN ? W.bad : W.warn}>未确认</Pill>
          ) : (
            <span
              style={{
                fontSize: 10.5,
                color: t.ackMin > ACK_SLA_MIN ? W.warn : W.ink4,
                fontFamily: W.mono,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              确认用 {t.ackMin}m
            </span>
          )}
          <Pill tone={ink}>{TONE_LABEL[t.tone]}</Pill>
        </div>
        {/* 交接时真正要说出口的那一句。 */}
        <button
          type="button"
          onClick={() => ctx.openEvent(e.id, e.siteName, e.level)}
          title="打开这条预警的卷宗"
          style={{
            display: 'block',
            width: '100%',
            marginTop: 4,
            border: 0,
            background: 'none',
            padding: 0,
            font: 'inherit',
            textAlign: 'left',
            fontSize: 12.5,
            lineHeight: 1.55,
            color: W.ink,
            cursor: 'pointer',
          }}
        >
          {t.action}
        </button>
        <div style={{ marginTop: 2, fontSize: 10.5, color: W.ink4 }}>
          {DISPOSITION_LABEL[e.disposition]} · 峰值 {(e.peakValue).toFixed(2)}m · 评分{' '}
          {e.score.toFixed(2)}
        </div>
      </div>
      <button
        type="button"
        onClick={() => ctx.openEvent(e.id, e.siteName, e.level)}
        title="进事件卷宗"
        style={{
          flex: '0 0 auto',
          border: 0,
          background: 'none',
          padding: '2px 4px',
          font: 'inherit',
          fontSize: 13,
          color: W.ink4,
          cursor: 'pointer',
        }}
      >
        →
      </button>
    </div>
  )
}

/** SLA 的一行：标签 + 值 + 是否达标由 tone 表达。 */
function SlaLine({ label, value, tone }: { label: string; value: string; tone: string }) {
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
      <span style={{ fontSize: 11.5, color: W.ink3 }}>{label}</span>
      <span
        style={{
          marginLeft: 'auto',
          fontSize: 12.5,
          fontWeight: 600,
          color: tone,
          fontFamily: W.mono,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
    </div>
  )
}

/** 时间轴的一行：左边一条竖线 + 节点，节点颜色是事件等级。 */
function TimelineRow({ e, ctx }: { e: AlertEvent; ctx: StageCtx }) {
  const active = isActive(e.state)
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <div style={{ position: 'relative', width: 9, flex: '0 0 auto' }}>
        <span
          style={{
            position: 'absolute',
            left: 4,
            top: 0,
            bottom: 0,
            width: 1,
            background: W.lineSoft,
          }}
        />
        <span
          style={{
            position: 'absolute',
            left: 1,
            top: 7,
            width: 7,
            height: 7,
            borderRadius: 4,
            background: active ? W.level[e.level] : W.levelWash[e.level] ?? W.line,
            border: `1px solid ${W.level[e.level]}`,
          }}
        />
      </div>
      <div style={{ flex: '1 1 0', minWidth: 0, paddingBottom: 7 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: 10.5,
              color: W.ink4,
              fontFamily: W.mono,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {fmtTime(e.raisedAt, 'HH:mm')}
          </span>
          <button
            type="button"
            onClick={() => ctx.goStage({ kind: 'site', siteId: e.siteId })}
            style={{
              border: 0,
              background: 'none',
              padding: 0,
              font: 'inherit',
              fontSize: 11.5,
              color: W.ink,
              cursor: 'pointer',
            }}
          >
            {e.siteName}
          </button>
          <Pill tone={W.levelInk[e.level] ?? W.ink3}>{LEVEL_LABEL[e.level]}</Pill>
          <Pill tone={active ? W.bad : W.ok}>{active ? '仍激活' : '已解除'}</Pill>
          {e.disposition !== 'open' && (
            <span style={{ fontSize: 10.5, color: W.ink3 }}>{DISPOSITION_LABEL[e.disposition]}</span>
          )}
          <button
            type="button"
            onClick={() => ctx.openEvent(e.id, e.siteName, e.level)}
            style={{
              marginLeft: 'auto',
              border: 0,
              background: 'none',
              padding: 0,
              font: 'inherit',
              fontSize: 10.5,
              color: W.accent,
              cursor: 'pointer',
            }}
          >
            卷宗 →
          </button>
        </div>
        <div
          style={{
            marginTop: 1,
            fontSize: 11,
            color: W.ink3,
            lineHeight: 1.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={e.reason}
        >
          {e.reason}
        </div>
      </div>
    </div>
  )
}
