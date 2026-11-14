import { useMemo, useState, type CSSProperties } from 'react'
import {
  DISPOSITION_HINT,
  DISPOSITION_LABEL,
  DISPOSITION_ORDER,
  LEVEL_LABEL,
  LEVEL_MEANING,
  NOTE_KIND_LABEL,
  ROLE_LABEL,
  STATE_LABEL,
  WARN_STATES,
  can,
  canAck,
  canTransition,
  elapsed,
  fmtDepth,
  fmtMinutes,
  fmtRate,
  fmtTime,
  handlingMinutes,
  isActive,
  isTerminal,
  isUnack,
  minRoleFor,
  nextDispositions,
  type AlertEvent,
  type AlertNote,
  type Disposition,
  type SimTime,
  type WarnState,
} from '../../domain'
import { useAckAlert, useAddNote, useAlertDetail, useAssignAlert, useHealth, useSetDisposition } from '../../data/queries'
import { useSession } from '../../view/useSession'
import { Block, Figure, Nothing, Pill, Row, Shimmer } from '../kit'
import { W } from '../visual'
import type { StageCtx } from '../ctx'

/**
 * 舞台三：选中一条预警后的卷宗。
 *
 * 这一屏的全部动作都**就地完成**——确认、派单、推进处置、写备注，一个都不跳页。
 * 跳页在这里的代价特别大：值班员正在处理一条预警，跳到「预警中心」去改状态，
 * 回来时列表的筛选、排序、滚动位置全没了，他得重新找到刚才那条。
 *
 * 两个轴必须**分开显示**，这是最容易搞错的地方：
 *   - 阅读轴（四态）由**模型**决定：预警还成立吗（ACTIVE/CLEARED）× 有人看过吗（ACK/UNACK）
 *   - 处置轴（五态）由**人**决定：通知了没、到场了没、处置完了没
 * 把两者画成一条进度条，用户会以为「已解除」等于「已处置完毕」——实际上
 * 水位退了但没人去现场填记录时，处置轴还停在「待处置」，这两件事必须分栏。
 */

/** 处置轴为什么不能这么走。后端只回一句「不能从「X」直接改为「Y」」，
 *  前端要把**原因**补上，否则用户只会看到按钮点不动。 */
function transitionBlocked(from: Disposition, to: Disposition): string {
  if (from === 'dispatched' && to === 'open') {
    return '已派单不能退回「待处置」：派单这个动作已经发生过，退回会抹掉「通知过处置单位」这条事实。要收回请改到「已到场」，或直接给出结论。'
  }
  if (isTerminal(from) && to !== 'open') {
    return `「${DISPOSITION_LABEL[from]}」是结案态，只能退回「待处置」重开，不能直接跳到别的中间态。`
  }
  return `处置轴只允许向前推进，不能从「${DISPOSITION_LABEL[from]}」直接到「${DISPOSITION_LABEL[to]}」。`
}

/** 从 mutation 的 error 里取出**后端原话**。409 的「不能从「已处置」直接改为「误报归档」」
 *  这类文案本身就是给值班员看的，改写成「操作失败」等于把最有用的信息丢掉。 */
function errText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  if (typeof e === 'string' && e) return e
  return '请求失败，但没有返回原因'
}

export function EventStage({ ctx, eventId }: { ctx: StageCtx; eventId: number }) {
  const q = useAlertDetail(eventId)
  const health = useHealth()
  const { user } = useSession()

  const ack = useAckAlert()
  const assign = useAssignAlert()
  const disp = useSetDisposition()
  const note = useAddNote()

  const [assignee, setAssignee] = useState('')
  const [noteText, setNoteText] = useState('')
  const [dispNote, setDispNote] = useState('')

  const detail = q.data
  const ev = detail?.event ?? null

  // 「现在」取遥测时钟：/api/health 的 ts 就是 NowTS()（MAX(telemetry.ts)）。
  // 绝不能用 Date.now()——模拟器是 60 倍速的，用墙上时间算「升起到现在多久」
  // 会得到负数或者几十小时的荒谬值。
  const now = (health.data?.now ?? 0) as SimTime

  const notes = detail?.notes ?? []

  // 时间线把「模型动作」与「人工处置记录」合成一条轴：用户想知道的是
  // 「这条预警从头到尾经历了什么」，而不是「哪个字段被改过」。
  const timeline = useMemo(() => buildTimeline(ev, notes), [ev, notes])

  if (!ev) {
    return (
      <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex', padding: 12 }}>
        <Block title="预警卷宗" sub={`#${eventId}`} grow>
          {q.isLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Shimmer h={58} />
              <Shimmer h={14} w="48%" />
              <Shimmer h={180} />
            </div>
          ) : (
            <Nothing
              why={
                q.error
                  ? `取不到这条预警：${(q.error as Error).message}`
                  : `预警 #${eventId} 不存在`
              }
              hint="预警可能已被清理，或链接里的事件号不对。左栏的预警列表里可以直接点开其它事件——不必回到别的页面。"
            />
          )}
        </Block>
      </div>
    )
  }

  const dispIndex = DISPOSITION_ORDER.indexOf(ev.disposition)
  const ackable = canAck(ev.state)
  const allowed = nextDispositions(ev.disposition)
  const ageMin = now > 0 && ev.raisedAt > 0 ? Math.max(0, Math.round(elapsed(now, ev.raisedAt) / 60)) : null
  const ackMin = handlingAckMin(ev)
  const clearMin = handlingMinutes(ev)

  const busy = ack.isPending || assign.isPending || disp.isPending || note.isPending
  const mayAck = can(user, 'alert:ack')
  const mayDispatch = can(user, 'alert:dispatch')
  const mayNote = can(user, 'alert:note')

  // 「已解除但没归档」：预警不再成立，但处置轴还停在中间态。
  // 这一类不会触发任何告警，交接时最容易被漏掉，所以要在最显眼的位置说出来。
  const notArchived = !isActive(ev.state) && !isTerminal(ev.disposition)

  const doAck = () => {
    if (busy || !ackable || !mayAck) return
    ack.mutate(ev.id, {
      onSuccess: () => ctx.toast('ok', `预警 #${ev.id} 已确认`),
      onError: (e) => ctx.toast('err', errText(e)),
    })
  }

  const doAssign = () => {
    const who = assignee.trim() || ev.assignee
    if (busy || !who || !mayDispatch) return
    assign.mutate(
      { id: ev.id, assignee: who },
      {
        onSuccess: () => {
          setAssignee('')
          ctx.toast('ok', `已派单给 ${who}`)
        },
        onError: (e) => ctx.toast('err', errText(e)),
      },
    )
  }

  const doDisposition = (to: Disposition) => {
    if (busy || to === ev.disposition || !canTransition(ev.disposition, to) || !mayDispatch) return
    const text = dispNote.trim()
    disp.mutate(
      { id: ev.id, disposition: to, note: text || undefined },
      {
        onSuccess: () => {
          setDispNote('')
          ctx.toast(
            'ok',
            `处置状态：${DISPOSITION_LABEL[ev.disposition]} → ${DISPOSITION_LABEL[to]}`,
          )
        },
        onError: (e) => ctx.toast('err', errText(e)),
      },
    )
  }

  const doNote = () => {
    const text = noteText.trim()
    if (busy || !text || !mayNote) return
    note.mutate(
      { id: ev.id, text },
      {
        onSuccess: () => {
          setNoteText('')
          ctx.toast('ok', '备注已记录')
        },
        onError: (e) => ctx.toast('err', errText(e)),
      },
    )
  }

  return (
    <div
      style={{
        flex: '1 1 0',
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: 'minmax(340px, 1fr) minmax(320px, 1fr)',
        gap: 12,
        padding: 12,
      }}
    >
      {/* ------------------------------------------------ 左列：事实 + 两个轴 + 动作 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflowY: 'auto' }}>
        <Block
          title="事件事实"
          sub={`预警 #${ev.id}`}
          aside={
            <Pill tone={W.levelInk[ev.level]} fill>
              {LEVEL_LABEL[ev.level]}
            </Pill>
          }
        >
          {/* 站名是入口：点它换到那一站的舞台。用 goStage 而不是跳页——
              用户此刻在这个站上做过的判断（等级、距阈距离）在那边原样还在。 */}
          <button
            type="button"
            onClick={() => ctx.goStage({ kind: 'site', siteId: ev.siteId })}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 6,
              width: '100%',
              textAlign: 'left',
              padding: 0,
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
              font: 'inherit',
              marginBottom: 8,
            }}
          >
            <span style={{ fontSize: 15, fontWeight: 600, color: W.ink }}>{ev.siteName}</span>
            <span style={{ fontSize: 11, color: W.ink4, fontFamily: W.mono }}>{ev.siteId}</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: W.accent }}>看这一站 →</span>
          </button>

          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, flexWrap: 'wrap' }}>
            <Figure
              value={fmtDepth(ev.peakValue)}
              unit="m"
              label="峰值积水深"
              tone={W.levelInk[ev.level]}
              size={30}
            />
            <Figure value={fmtScore(ev.score)} label="综合分" size={20} />
            <Figure value={fmtRate(ev.slope)} unit="m/h" label="当时趋势" size={20} />
          </div>

          <div style={{ marginTop: 10 }}>
            <Row
              k="超阈持续"
              v={fmtMinutes(ev.durationMin)}
              hint={
                ev.peakAtMin !== null
                  ? `峰值在研判窗口第 ${fmtMinutes(ev.peakAtMin)}（自窗口起点，非距今）`
                  : undefined
              }
            />
            <Row k="升起于" v={fmtTime(ev.raisedAt, 'MM-DD HH:mm:ss')} />
            <Row
              k="至今"
              v={ageMin === null ? '—' : fmtMinutes(ageMin)}
              hint={now > 0 ? '按遥测时钟' : '拿不到遥测时钟'}
            />
            <Row
              k="确认耗时"
              v={ackMin === null ? '还未确认' : fmtMinutes(ackMin)}
              tone={ackMin === null ? W.warn : undefined}
            />
            <Row
              k="处置历时"
              v={clearMin === null ? '尚未解除' : fmtMinutes(clearMin)}
              hint="升起到解除"
            />
            <Row k="处理人" v={ev.assignee || '未指派'} tone={ev.assignee ? undefined : W.warn} />
            <Row k="最近更新" v={fmtTime(ev.updatedAt, 'MM-DD HH:mm:ss')} />
          </div>

          <div style={{ marginTop: 8, fontSize: 11, color: W.ink3, lineHeight: 1.6 }}>
            {LEVEL_MEANING[ev.level]}
          </div>
          {ev.reason && (
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
              {ev.reason}
            </div>
          )}
        </Block>

        {notArchived && (
          <div
            style={{
              padding: '7px 10px',
              border: `1px solid ${W.bad}`,
              borderRadius: 8,
              fontSize: 11.5,
              color: W.levelInk.red,
              lineHeight: 1.65,
            }}
          >
            已解除但未归档：预警不再成立，处置轴却停在「{DISPOSITION_LABEL[ev.disposition]}」。
            这类事件不会再报警，交班时最容易漏掉——请补完现场结果，把它推到「已处置」或「误报」。
          </div>
        )}

        {/* 两个轴分开画。合成一条会让用户以为「已解除」就是「已处置完」。 */}
        <Block title="阅读轴" sub="由模型决定 · 预警是否成立 × 是否有人看过" pad={10}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {WARN_STATES.map((s) => (
              <AxisCell key={s} current={s === ev.state} label={STATE_LABEL[s]} state={s} />
            ))}
          </div>
          <div style={{ marginTop: 7, fontSize: 10.5, color: W.ink4, lineHeight: 1.65 }}>
            当前 <span style={{ color: W.ink2 }}>{STATE_LABEL[ev.state]}</span>。
            {isActive(ev.state)
              ? '「激活」表示模型仍在判这条预警成立——即使现场已经处理完，退水前它也不会自己消失。'
              : '「解除」表示模型已判定条件不再满足（停雨停工后自动降档），但归档要人来做。'}
            {isUnack(ev.state) && ' 还没人确认过这条预警。'}
          </div>
        </Block>

        <Block title="处置轴" sub="由人决定 · 通知到了哪一步" pad={10}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            {DISPOSITION_ORDER.map((d, i) => (
              <div key={d} style={{ display: 'flex', alignItems: 'center', flex: '1 1 0', minWidth: 0 }}>
                <span
                  style={{
                    flex: '1 1 0',
                    minWidth: 0,
                    padding: '3px 2px',
                    textAlign: 'center',
                    fontSize: 10,
                    borderRadius: 4,
                    color: i <= dispIndex ? W.levelInk[ev.level] : W.ink4,
                    background: i === dispIndex ? W.levelWash[ev.level] : 'transparent',
                    border: `1px solid ${i === dispIndex ? W.level[ev.level] : W.lineSoft}`,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {DISPOSITION_LABEL[d]}
                </span>
                {i < DISPOSITION_ORDER.length - 1 && (
                  <span style={{ width: 6, height: 1, background: W.line, flex: '0 0 auto' }} />
                )}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 7, fontSize: 10.5, color: W.ink4, lineHeight: 1.65 }}>
            {DISPOSITION_HINT[ev.disposition]}
            {' '}
            注意「误报」也在这一轴上，它是处置结论而不是阅读状态——判成误报不会把预警从历史里抹掉。
          </div>
        </Block>

        <Block title="就地处置" sub="不跳页，点完即生效" pad={10}>
          {/* ---- 确认。**已确认的连按钮都不给**（不是灰掉）：后端会 409
              「已确认，无需重复确认」，摆一个点不动的按钮只会让人反复试。
              灰按钮留给「暂时不满足、以后能满足」，这里是不存在这条路径。 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            {ackable && (
              <Btn
                text={ack.isPending ? '确认中…' : '确认预警'}
                tone={W.accent}
                disabled={busy || !mayAck}
                title={mayAck ? undefined : `需要${ROLE_LABEL[minRoleFor('alert:ack')]}及以上`}
                onClick={doAck}
              />
            )}
            <span style={{ fontSize: 10.5, color: W.ink4, lineHeight: 1.5 }}>
              {!ackable
                ? `当前是「${STATE_LABEL[ev.state]}」，确认动作已经发生过，后端不允许重复确认——所以这里没有按钮。`
                : !mayAck
                  ? `需要${ROLE_LABEL[minRoleFor('alert:ack')]}及以上（当前 ${user ? user.roleLabel : '未登录'}）`
                  : '确认表示「我看到了这条预警」，不改变等级，也不代表已经处置。'}
            </span>
          </div>

          {/* ---- 派单。派单只写处理人，不会自动改处置状态，所以下面还要单独点处置。 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <input
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              placeholder={ev.assignee ? `当前 ${ev.assignee}，改派给…` : '派单给（处置单位 / 处理人）'}
              disabled={busy || !mayDispatch}
              style={inputStyle}
            />
            <Btn
              text={assign.isPending ? '派单中…' : ev.assignee ? '改派' : '派单'}
              tone={W.accent}
              disabled={busy || !mayDispatch || !(assignee.trim() || ev.assignee)}
              onClick={doAssign}
            />
          </div>
          <div style={{ fontSize: 10.5, color: W.ink4, marginBottom: 12, lineHeight: 1.6 }}>
            {!mayDispatch
              ? `需要${ROLE_LABEL[minRoleFor('alert:dispatch')]}及以上`
              : '派单不会顺手把处置推到「已派单」——后端只写处理人。要推进状态请在下面点「已派单」。'}
          </div>

          {/* ---- 五个处置按钮。只让能过的那个可点，其余写清为什么不能点。 */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {DISPOSITION_ORDER.map((d) => {
              const isCurrent = d === ev.disposition
              const ok = !isCurrent && canTransition(ev.disposition, d) && allowed.includes(d)
              return (
                <Btn
                  key={d}
                  text={DISPOSITION_LABEL[d]}
                  tone={ok ? W.accent : W.ink3}
                  plain={!ok}
                  disabled={busy || !ok || !mayDispatch}
                  title={
                    isCurrent
                      ? '当前状态，无需重复操作（后端会 409）'
                      : ok
                        ? `改为「${DISPOSITION_LABEL[d]}」`
                        : transitionBlocked(ev.disposition, d)
                  }
                  onClick={() => doDisposition(d)}
                />
              )
            })}
          </div>
          <input
            value={dispNote}
            onChange={(e) => setDispNote(e.target.value)}
            placeholder="可选：本次处置的说明，会写进处置记录"
            disabled={busy || !mayDispatch}
            style={{ ...inputStyle, marginTop: 7 }}
          />
          {/* 被禁的是「后端会拒绝的路径」，不是「还没做的前置动作」。
              把原因逐条写出来，比一个灰按钮更省事。 */}
          {allowed.length === 0 && (
            <div style={{ marginTop: 6, fontSize: 10.5, color: W.ink4, lineHeight: 1.6 }}>
              当前没有可推进的下一步。
            </div>
          )}
          {ev.disposition === 'dispatched' && (
            <div style={{ marginTop: 6, fontSize: 10.5, color: W.levelInk.yellow, lineHeight: 1.6 }}>
              从「已派单」退回「待处置」被后端故意禁止，所以那个按钮点不动——
              派单动作已经发生过，退回会抹掉这条事实。
            </div>
          )}
        </Block>

        <Block title="加备注" sub="谁写了什么都会被留下来" pad={10}>
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            rows={3}
            placeholder="现场情况、电话沟通结果、为什么判成误报…"
            disabled={busy || !mayNote}
            style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7 }}>
            <Btn
              text={note.isPending ? '提交中…' : '记一条'}
              tone={W.accent}
              disabled={busy || !mayNote || !noteText.trim()}
              onClick={doNote}
            />
            <span style={{ fontSize: 10.5, color: W.ink4 }}>
              {mayNote
                ? `以 ${user?.displayName ?? '值班员'} 的身份记入`
                : `需要${ROLE_LABEL[minRoleFor('alert:note')]}及以上`}
            </span>
          </div>
        </Block>
      </div>

      {/* ------------------------------------------------ 右列：时间线 + 备注 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
        <Block title="时间线" sub="升起 → 确认 → 处置变化 → 解除" pad={10}>
          {timeline.length === 0 ? (
            <Nothing why="还没有任何时间点" hint="事件刚刚写入，等一次刷新。" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0, maxHeight: 260, overflowY: 'auto' }}>
              {timeline.map((t, i) => (
                <div key={`${t.at}-${i}`} style={{ display: 'flex', gap: 8, padding: '4px 0' }}>
                  <span
                    style={{
                      flex: '0 0 auto',
                      width: 62,
                      fontSize: 10.5,
                      color: W.ink4,
                      fontFamily: W.mono,
                      fontVariantNumeric: 'tabular-nums',
                      paddingTop: 1,
                    }}
                  >
                    {fmtTime(t.at, 'MM-DD HH:mm')}
                  </span>
                  <span
                    style={{
                      flex: '0 0 auto',
                      width: 7,
                      marginTop: 5,
                      height: 7,
                      borderRadius: 4,
                      background: t.tone,
                    }}
                  />
                  <span style={{ flex: '1 1 0', minWidth: 0 }}>
                    <span style={{ fontSize: 11.5, color: W.ink, lineHeight: 1.6 }}>{t.text}</span>
                    {t.who && (
                      <span style={{ fontSize: 10.5, color: W.ink4, marginLeft: 6 }}>{t.who}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 6, fontSize: 10.5, color: W.ink4, lineHeight: 1.6 }}>
            「解除」由模型写，「确认」和处置变化由人写。同一条轴上能看出这条预警是自动退水结束的、
            还是处置完的——两者在复盘时的意义不同。
          </div>
        </Block>

        <Block
          title="处置备注"
          sub={`${notes.length} 条`}
          aside={ev.noteCount !== notes.length ? <Pill tone={W.ink4}>接口外另有 {ev.noteCount} 条</Pill> : null}
          grow
          pad={10}
        >
          {notes.length === 0 ? (
            <Nothing
              why="这条预警还没有任何备注"
              hint="派单与处置推进会由后端自动写入一条记录；「加备注」写的是补充说明。"
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: '1 1 0', minHeight: 0, overflowY: 'auto' }}>
              {notes
                .slice()
                .sort((a, b) => b.createdAt - a.createdAt)
                .map((n) => (
                  <NoteItem key={n.id} note={n} />
                ))}
            </div>
          )}
        </Block>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 局部件

const inputStyle: CSSProperties = {
  flex: '1 1 0',
  minWidth: 0,
  padding: '5px 8px',
  fontSize: 11.5,
  fontFamily: 'inherit',
  color: W.ink,
  background: W.stage,
  border: `1px solid ${W.line}`,
  borderRadius: 5,
  outline: 'none',
}

/** 就地动作按钮。样式全部走 W，不引 tokens —— 两套色混用会得到「一半玻璃一半硬边」。 */
function Btn({
  text,
  tone,
  plain,
  disabled,
  title,
  onClick,
}: {
  text: string
  tone: string
  plain?: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        flex: '0 0 auto',
        padding: '5px 11px',
        fontSize: 11.5,
        fontFamily: 'inherit',
        borderRadius: 5,
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled ? W.ink4 : plain ? tone : '#fff',
        background: disabled || plain ? 'transparent' : tone,
        border: `1px solid ${disabled ? W.line : plain ? tone + '66' : tone}`,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {text}
    </button>
  )
}

/** 阅读轴的一格。模型态没有「下一步」，所以它只是显示，不是按钮。 */
function AxisCell({ current, label, state }: { current: boolean; label: string; state: WarnState }) {
  const tone = isActive(state) ? W.levelInk.red : W.ok
  return (
    <span
      style={{
        padding: '3px 8px',
        fontSize: 10.5,
        borderRadius: 4,
        color: current ? tone : W.ink4,
        border: `1px solid ${current ? tone + '66' : W.lineSoft}`,
        background: current ? W.levelWash[isActive(state) ? 'red' : 'blue'] : 'transparent',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
      {isUnack(state) && <span style={{ opacity: 0.7 }}> · 待确认</span>}
    </span>
  )
}

function NoteItem({ note }: { note: AlertNote }) {
  return (
    <div
      style={{
        padding: '6px 8px',
        borderLeft: `2px solid ${note.kind === 'note' ? W.line : W.accent}`,
        background: note.kind === 'note' ? 'transparent' : W.accentSoft,
        borderRadius: '0 5px 5px 0',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 10.5, color: W.ink2 }}>{note.author}</span>
        <span
          style={{
            fontSize: 9.5,
            color: W.ink4,
            border: `1px solid ${W.line}`,
            borderRadius: 3,
            padding: '0 4px',
          }}
        >
          {NOTE_KIND_LABEL[note.kind]}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: W.ink4, fontFamily: W.mono }}>
          {fmtTime(note.createdAt, 'MM-DD HH:mm:ss')}
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: W.ink, lineHeight: 1.65, marginTop: 3, whiteSpace: 'pre-wrap' }}>
        {note.text}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 派生

/** 一条时间线的项。tone 用 W 的等级色，让「模型写的」与「人写的」在视觉上分开。 */
interface TimelineItem {
  at: SimTime
  text: string
  who?: string
  tone: string
}

/**
 * 合成时间线。
 *
 * 只用后端已经给的字段与备注，不推测：`raised_at` / `acked_at` / `cleared_at` 是
 * 事件自身的时刻；处置变化本来就是后端 AddNote 写进去的（kind='status'），
 * 所以从备注里取，而不是从字段差里猜——猜出来的时刻会和备注里的时刻打架。
 */
function buildTimeline(ev: AlertEvent | null, notes: readonly AlertNote[]): TimelineItem[] {
  if (!ev) return []
  const out: TimelineItem[] = []
  if (ev.raisedAt > 0) {
    out.push({
      at: ev.raisedAt,
      text: `事件升起 · 判为${LEVEL_LABEL[ev.level]}，综合分 ${fmtScore(ev.score)}`,
      tone: W.level[ev.level],
    })
  }
  if (ev.ackedAt) {
    out.push({ at: ev.ackedAt, text: '人工确认（阅读轴进入已确认）', tone: W.accent })
  }
  for (const n of notes) {
    if (n.kind === 'dispatch') {
      out.push({ at: n.createdAt, text: n.text, who: n.author, tone: W.accent })
    } else if (n.kind === 'status') {
      out.push({ at: n.createdAt, text: n.text, who: n.author, tone: W.level.yellow })
    } else if (n.kind === 'close') {
      out.push({ at: n.createdAt, text: n.text, who: n.author, tone: W.ok })
    }
  }
  if (ev.clearedAt) {
    out.push({ at: ev.clearedAt, text: '模型判定解除（阅读轴进入已解除）', tone: W.ok })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** 确认耗时（分钟）。未确认返回 null——不要用「到现在多久」占位，那会看起来像已经确认过。 */
function handlingAckMin(e: AlertEvent): number | null {
  if (!e.ackedAt || !e.raisedAt) return null
  return Math.max(0, Math.round(elapsed(e.ackedAt, e.raisedAt) / 60))
}

/** 0~1 无量纲量统一两位小数，与 `FactorBars` / `LevelChip` 同口径（同一个分数并排读）。 */
function fmtScore(v: number): string {
  if (!Number.isFinite(v)) return '—'
  return v.toFixed(2)
}
