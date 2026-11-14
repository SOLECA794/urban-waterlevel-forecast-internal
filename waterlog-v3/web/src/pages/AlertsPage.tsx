import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  canAck,
  DISPOSITION_HINT,
  DISPOSITION_LABEL,
  DISPOSITION_ORDER,
  fmtMinutes,
  fmtTime,
  isActive,
  isTerminal,
  isUnack,
  handlingMinutes,
  LEVEL_LABEL,
  nextDispositions,
  NOTE_KIND_LABEL,
  STATE_LABEL,
  WARN_STATES,
  type AlertEvent,
  type Disposition,
  type WarnState,
} from '../domain'
import {
  useAckAlert,
  useAddNote,
  useAlertDetail,
  useAlerts,
  useAssignAlert,
  useSetDisposition,
} from '../data/queries'
import { EmptyState, KeyValue, SectionHead, Skeleton } from '../components/primitives/Bits'
import { StatCard } from '../components/primitives/Stat'
import { Icon } from '../components/primitives/Icons'
import { LevelChip, StatusDot, Tag } from '../components/domain/LevelChip'
import { SiteDrawer } from '../components/interactive/StationDetail'
import { T } from '../utils/tokens'

/**
 * 预警中心。这里同时跑着**两条独立的轴**：
 *
 *   阅读轴（四态）：ACTIVE_UNACK → ACTIVE_ACK → CLEARED_*   —— 由模型决定，预警还成不成立
 *   处置轴（五态）：open → dispatched → onsite → resolved    —— 由人决定，我们做了什么
 *
 * 分开的理由很具体：一条预警可以在 40 分钟前就 CLEARED 了，但处置还停在 dispatched
 * （人还没到现场）。如果强行合成一条状态，要么「解除」把处置记录抹掉，
 * 要么「已处置」把预警还成立这件事盖住。两个都不对。
 */
export function AlertsPage() {
  const nav = useNavigate()
  const [activeOnly, setActiveOnly] = useState(true)
  const [selected, setSelected] = useState<number | null>(null)
  // 站名点击打开的站点抽屉：与预警卷宗是两个独立的面板，互不顶掉
  const [siteId, setSiteId] = useState<string | null>(null)
  const { data: events, isLoading, error } = useAlerts(activeOnly)
  const detail = useAlertDetail(selected)

  const rows = events ?? []
  const active = rows.filter((e) => isActive(e.state))
  const cleared = rows.filter((e) => !isActive(e.state))
  const unack = rows.filter((e) => isUnack(e.state))
  const top = rows.reduce<AlertEvent | null>(
    (a, e) => (a === null || e.score > a.score ? e : a),
    null,
  )

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3 stagger">
        <StatCard label="激活中" value={active.length} unit="条" icon="bell" tone="red" emphasis />
        <StatCard label="待确认" value={unack.length} unit="条" icon="alertTriangle" tone="orange" footer="未确认的预警不会被自动追认" />
        <StatCard label="已解除" value={cleared.length} unit="条" icon="check" tone="neutral" footer="含已解除但未确认" />
        <StatCard
          label="最高等级"
          value={top ? LEVEL_LABEL[top.level] : '—'}
          icon="shield"
          tone={top ? (top.level as 'red') : 'neutral'}
          footer={top ? `${top.siteName} · 综合分 ${top.score.toFixed(2)}` : '当前没有预警'}
        />
      </div>

      <div className="grid grid-cols-[1fr_400px] gap-4 items-start">
        <div className="card p-4" data-tour="alerts-table">
          <SectionHead
            title="预警事件"
            sub="点任意一行查看处置卷宗；四态由模型推进，处置由人推进"
            icon="bell"
            right={
              <div className="seg">
                <button className="seg-item" data-active={activeOnly} onClick={() => setActiveOnly(true)}>
                  仅激活
                </button>
                <button className="seg-item" data-active={!activeOnly} onClick={() => setActiveOnly(false)}>
                  全部历史
                </button>
              </div>
            }
          />

          {error && (
            <div
              className="mt-2 rounded-control px-3 py-2 text-[12px] flex items-start gap-2"
              style={{ background: T.levelWeak.red, color: T.levelInk.red }}
            >
              <Icon name="alertTriangle" size={14} className="mt-0.5 shrink-0" />
              <span>{(error as Error).message}</span>
            </div>
          )}

          {isLoading ? (
            <div className="mt-3 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} h={34} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="py-12">
              <EmptyState
                icon="shield"
                title={activeOnly ? '当前没有激活中的预警' : '还没有任何预警记录'}
                hint={
                  activeOnly
                    ? '可以切到「全部历史」看已解除的事件。需要验证解除链路，可在系统状态页注入一段降雨过程。'
                    : '到「系统状态」注入暴雨，几十秒内就会看到多站点逐级升警。'
                }
                action={
                  <button className="btn" onClick={() => nav('/system')}>
                    去系统状态
                  </button>
                }
              />
            </div>
          ) : (
            <div className="overflow-x-auto mt-2">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">触发时间</th>
                    <th className="th">站点</th>
                    <th className="th">等级</th>
                    <th className="th">四态</th>
                    <th className="th">处置</th>
                    <th className="th">责任人</th>
                    <th className="th text-right">峰值 / 持续</th>
                    <th className="th text-right">备注</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr
                      key={e.id}
                      className="row-hover cursor-pointer"
                      onClick={() => setSelected(e.id)}
                      style={{
                        background:
                          selected === e.id
                            ? T.aiWeak
                            : isUnack(e.state)
                              ? `${T.levelWeak[e.level]}99`
                              : undefined,
                      }}
                    >
                      <td className="td num text-[12px] text-ink-2">
                        {fmtTime(e.raisedAt, 'MM-DD HH:mm')}
                      </td>
                      <td className="td">
                        <div className="flex items-center gap-1.5">
                          <StatusDot level={e.level} />
                          {/* 站名单独可点：点站名看站点，点行内其它地方选这条预警。
                              两个动作都保留，因为它们是两个不同的问题。 */}
                          <button
                            type="button"
                            data-site-name={e.siteId}
                            onClick={(ev) => {
                              ev.stopPropagation()
                              setSiteId(e.siteId)
                            }}
                            title="查看该站点当前水位与预测"
                            style={{
                              border: 0,
                              background: 'none',
                              padding: 0,
                              cursor: 'pointer',
                              fontSize: 12.5,
                              fontWeight: 500,
                              color: T.text1,
                              maxWidth: 128,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              textAlign: 'left',
                              textDecoration: 'underline',
                              textDecorationColor: T.borderStrong,
                              textUnderlineOffset: 3,
                            }}
                          >
                            {e.siteName}
                          </button>
                          <span className="text-[10px] text-ink-3 num">{e.siteId}</span>
                        </div>
                      </td>
                      <td className="td">
                        <LevelChip level={e.level} score={e.score} />
                      </td>
                      <td className="td">
                        <StateTag state={e.state} />
                      </td>
                      <td className="td">
                        <DispositionTag d={e.disposition} />
                      </td>
                      <td className="td text-[12px] text-ink-2">{e.assignee ?? '—'}</td>
                      <td className="td text-right num text-[11.5px]">
                        {e.peakValue.toFixed(2)}m
                        <span className="text-ink-3"> / {fmtMinutes(e.durationMin)}</span>
                      </td>
                      <td className="td text-right num text-[12px] text-ink-2">{e.noteCount || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-3">
            <span>未确认行有底色：红色越深说明越需要马上有人接手。</span>
            <span>重复确认会被后端拒绝（409），错误原话直接显示在页面上，不吞。</span>
          </div>
        </div>

        {/* 处置卷宗 */}
        <div className="card p-4 sticky top-4" data-tour="alerts-dossier">
          {selected == null ? (
            <EmptyState icon="layers" title="选一条预警" hint="左侧点任意一行，这里会显示四态、处置动作与备注时间线。" compact />
          ) : detail.isLoading ? (
            <div className="space-y-2">
              <Skeleton h={16} w="60%" />
              <Skeleton h={30} />
              <Skeleton h={30} />
              <Skeleton h={80} />
            </div>
          ) : detail.data ? (
            <AlertPanel detailId={selected} onClose={() => setSelected(null)} />
          ) : (
            <EmptyState icon="alertTriangle" title="这条预警打不开" hint={String(detail.error ?? '未知错误')} compact />
          )}
        </div>
      </div>

      <SiteDrawer
        siteId={siteId}
        onClose={() => setSiteId(null)}
        onPick={setSiteId}
        width={470}
        onOpenArchive={siteId ? () => nav(`/sites/${siteId}`) : undefined}
      />
    </div>
  )
}

function StateTag({ state }: { state: WarnState }) {
  const tone = isActive(state) ? (isUnack(state) ? 'danger' : 'warn') : isUnack(state) ? 'neutral' : 'ok'
  return (
    <Tag tone={tone}>
      <span className="num text-[10px] mr-1">{state.split('_')[1] === 'UNACK' ? '○' : '●'}</span>
      {STATE_LABEL[state]}
    </Tag>
  )
}

function DispositionTag({ d }: { d: Disposition }) {
  const tone = isTerminal(d) ? (d === 'false_alarm' ? 'neutral' : 'ok') : d === 'open' ? 'warn' : 'ai'
  return <Tag tone={tone}>{DISPOSITION_LABEL[d]}</Tag>
}

/** 处置卷宗：一条预警的全部可操作面。 */
function AlertPanel({ detailId, onClose }: { detailId: number; onClose: () => void }) {
  const { data, isLoading } = useAlertDetail(detailId)
  const ack = useAckAlert()
  const assign = useAssignAlert()
  const setDisp = useSetDisposition()
  const addNote = useAddNote()
  const [assignee, setAssignee] = useState('')
  const [note, setNote] = useState('')

  if (isLoading || !data) {
    return (
      <div className="space-y-2">
        <Skeleton h={18} w="50%" />
        <Skeleton h={60} />
        <Skeleton h={100} />
      </div>
    )
  }

  const e = data.event
  const nexts = nextDispositions(e.disposition)
  const busy = ack.isPending || assign.isPending || setDisp.isPending || addNote.isPending
  const err =
    (ack.error as Error | null)?.message ??
    (assign.error as Error | null)?.message ??
    (setDisp.error as Error | null)?.message ??
    (addNote.error as Error | null)?.message ??
    null

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <StatusDot level={e.level} />
            <span className="text-[13.5px] font-semibold text-ink truncate">{e.siteName}</span>
            <LevelChip level={e.level} score={e.score} />
          </div>
          <div className="text-[11px] text-ink-3 num mt-0.5">
            #{e.id} · {e.siteId} · {fmtTime(e.raisedAt, 'MM-DD HH:mm')} 触发
          </div>
        </div>
        <button className="text-[11px] text-ink-3 hover:text-ink shrink-0" onClick={onClose}>
          关闭
        </button>
      </div>

      <div className="rounded-control px-3 py-2 text-[11.5px] text-ink-2 leading-snug" style={{ background: T.bgCanvas }}>
        {e.reason}
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <KeyValue k="峰值水深" v={`${e.peakValue.toFixed(2)} m`} />
        <KeyValue k="峰值时刻" v={e.peakAtMin == null ? '—' : fmtMinutes(e.peakAtMin)} />
        <KeyValue k="超阈持续" v={fmtMinutes(e.durationMin)} />
        <KeyValue k="当前趋势" v={`${(e.slope as number).toFixed(2)} m/h`} />
        <KeyValue k="处置时长" v={handlingMinutes(e) == null ? '进行中' : fmtMinutes(handlingMinutes(e) as number)} />
        <KeyValue k="状态更新" v={fmtTime(e.updatedAt, 'MM-DD HH:mm')} />
      </div>

      {err && (
        <div className="rounded-control px-2.5 py-1.5 text-[11.5px]" style={{ background: T.levelWeak.red, color: T.levelInk.red }}>
          {err}
        </div>
      )}

      {/* 阅读轴 */}
      <div>
        <div className="text-[10px] uppercase tracking-[0.1em] text-ink-3 mb-1">阅读轴 · 预警还成不成立</div>
        <div className="flex flex-wrap items-center gap-1">
          {WARN_STATES.map((s, i) => (
            <span key={s} className="flex items-center gap-1">
              {i > 0 && <Icon name="chevronRight" size={10} className="text-ink-3" />}
              <span style={{ opacity: s === e.state ? 1 : 0.4 }}>
                <StateTag state={s} />
              </span>
            </span>
          ))}
        </div>
        <button
          className="btn btn-primary w-full mt-1.5"
          disabled={!canAck(e.state) || busy}
          onClick={() => ack.mutate(e.id)}
          title={canAck(e.state) ? undefined : '已确认，无需重复确认'}
        >
          {canAck(e.state) ? (isActive(e.state) ? '确认收到' : '确认解除') : '已确认'}
        </button>
      </div>

      {/* 处置轴 */}
      <div>
        <div className="text-[10px] uppercase tracking-[0.1em] text-ink-3 mb-1">处置轴 · 我们做了什么</div>
        <div className="flex flex-wrap gap-1">
          {DISPOSITION_ORDER.map((d) => (
            <span key={d} style={{ opacity: d === e.disposition ? 1 : 0.45 }}>
              <DispositionTag d={d} />
            </span>
          ))}
        </div>
        <div className="text-[11px] text-ink-3 mt-1">{DISPOSITION_HINT[e.disposition]}</div>
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {nexts.map((d) => (
            <button
              key={d}
              className="btn text-[11.5px] h-7 px-2.5"
              disabled={busy}
              onClick={() => setDisp.mutate({ id: e.id, disposition: d })}
            >
              改为 {DISPOSITION_LABEL[d]}
            </button>
          ))}
        </div>
      </div>

      {/* 派单 */}
      <div>
        <div className="text-[10px] uppercase tracking-[0.1em] text-ink-3 mb-1">
          责任人 {e.assignee ? <span className="text-ink-2">（当前 {e.assignee}）</span> : null}
        </div>
        <div className="flex gap-1.5">
          <input
            className="field h-7 text-[12px] flex-1"
            placeholder="例如：排水公司 张工"
            value={assignee}
            onChange={(ev) => setAssignee(ev.target.value)}
          />
          <button
            className="btn h-7 px-2.5 text-[11.5px]"
            disabled={!assignee.trim() || busy}
            onClick={() => {
              assign.mutate({ id: e.id, assignee: assignee.trim() })
              setAssignee('')
            }}
          >
            派单
          </button>
        </div>
      </div>

      {/* 备注时间线 */}
      <div>
        <div className="text-[10px] uppercase tracking-[0.1em] text-ink-3 mb-1">处置记录（{data.notes.length}）</div>
        {data.notes.length === 0 ? (
          <div className="text-[11.5px] text-ink-3">还没有记录。派单与改状态会自动留下痕迹。</div>
        ) : (
          <div className="space-y-1.5 max-h-[180px] overflow-auto pr-1">
            {data.notes.map((n) => (
              <div key={n.id} className="rounded-control px-2 py-1.5" style={{ background: T.bgCanvas }}>
                <div className="flex items-center gap-1.5 text-[10px] text-ink-3">
                  <Tag tone={n.kind === 'dispatch' ? 'ai' : n.kind === 'status' ? 'warn' : 'neutral'}>
                    {NOTE_KIND_LABEL[n.kind]}
                  </Tag>
                  <span className="num">{fmtTime(n.createdAt, 'MM-DD HH:mm')}</span>
                  <span>{n.author}</span>
                </div>
                <div className="text-[11.5px] text-ink-2 mt-0.5 leading-snug">{n.text}</div>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-1.5 mt-1.5">
          <input
            className="field h-7 text-[12px] flex-1"
            placeholder="补一条现场情况…"
            value={note}
            onChange={(ev) => setNote(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && note.trim()) {
                addNote.mutate({ id: e.id, text: note.trim() })
                setNote('')
              }
            }}
          />
          <button
            className="btn h-7 px-2.5 text-[11.5px]"
            disabled={!note.trim() || busy}
            onClick={() => {
              addNote.mutate({ id: e.id, text: note.trim() })
              setNote('')
            }}
          >
            添加
          </button>
        </div>
      </div>
    </div>
  )
}
