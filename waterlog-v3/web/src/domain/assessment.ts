import type { Level } from './level'
import type { SimTime } from './time'
import type { Depth, Rate } from './units'

/**
 * 预警研判（三因子加权）+ 事件处置。
 *
 * 这里刻意把两个轴分开，因为它们回答的是不同的问题：
 *
 * - **阅读轴 WarnState**：这条预警我看见了没有？（ACTIVE/ CLEARED × UNACK/ACK）
 *   由后端四态机维护，前端只能触发 ack。
 * - **处置轴 Disposition**：看见了之后动手了没有？动到哪一步了？
 *   这条轴原来根本不存在——值班员点一下「确认」，事件就躺在表里结束，
 *   但真实业务里 ack 只是「我看到了」，后面还有派单、到场、封路、排空、误报。
 *
 * 把两者塞进一个枚举会立刻退化成 4×5 的笛卡尔积，而且再也加不动第三件事。
 */

export interface Factors {
  readonly peak: number
  readonly duration: number
  readonly trend: number
  readonly score: number
}

/** 研判结论。`score` 是 0~1 的综合分，`level` 是它落到哪一档。 */
export interface Assessment {
  readonly level: Level
  readonly score: number
  /** 预见期内峰值水深（不是绝对水位） */
  readonly peakValue: Depth
  /** 峰值本身落在哪一档，可能与综合等级不同（被持续时间或趋势降级过） */
  readonly peakLevel: Level
  readonly peakAtMin: number | null
  /** 超阈持续时长 */
  readonly durationMin: number
  readonly slope: Rate
  /** 一句话研判依据，直接给值班员看，不要他再点开详情 */
  readonly reason: string
  /** 被哪条硬约束降级过（持续时长不足 / 趋势回落）。null 表示没被降级。 */
  readonly blockedBy: string | null
  readonly factors: Factors
  readonly horizonMin: number
}

export const EMPTY_ASSESSMENT: Assessment = {
  level: 'none',
  score: 0,
  peakValue: 0 as Depth,
  peakLevel: 'none',
  peakAtMin: null,
  durationMin: 0,
  slope: 0 as Rate,
  reason: '尚无研判结果',
  blockedBy: null,
  factors: { peak: 0, duration: 0, trend: 0, score: 0 },
  horizonMin: 0,
}

// ---------------------------------------------------------------- 阅读轴

export type WarnState = 'ACTIVE_UNACK' | 'ACTIVE_ACK' | 'CLEARED_UNACK' | 'CLEARED_ACK'

export const WARN_STATES: readonly WarnState[] = [
  'ACTIVE_UNACK',
  'ACTIVE_ACK',
  'CLEARED_UNACK',
  'CLEARED_ACK',
]

export const STATE_LABEL: Record<WarnState, string> = {
  ACTIVE_UNACK: '激活·未确认',
  ACTIVE_ACK: '激活·已确认',
  CLEARED_UNACK: '解除·未确认',
  CLEARED_ACK: '解除·已确认',
}

export function isActive(state: WarnState): boolean {
  return state.startsWith('ACTIVE')
}

export function isUnack(state: WarnState): boolean {
  return state.endsWith('UNACK')
}

/** 只有未确认的才能确认；已确认再点应当被后端拒绝（409），界面不该给出按钮。 */
export function canAck(state: WarnState): boolean {
  return isUnack(state)
}

// ---------------------------------------------------------------- 处置轴

export type Disposition = 'open' | 'dispatched' | 'onsite' | 'resolved' | 'false_alarm'

export const DISPOSITION_ORDER: readonly Disposition[] = [
  'open',
  'dispatched',
  'onsite',
  'resolved',
  'false_alarm',
]

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  open: '待处置',
  dispatched: '已派单',
  onsite: '已到场',
  resolved: '已处置',
  false_alarm: '误报',
}

export const DISPOSITION_HINT: Record<Disposition, string> = {
  open: '还没有人接手',
  dispatched: '已通知处置单位，等他们到场',
  onsite: '有人到现场了，正在处理',
  resolved: '现场处置完毕，等积水退去或已排除',
  false_alarm: '核查后确认是误报，不算一次真实内涝',
}

export function isTerminal(d: Disposition): boolean {
  return d === 'resolved' || d === 'false_alarm'
}

/**
 * 处置状态机。允许的迁移：
 *
 *   open ──→ dispatched ──→ onsite ──→ resolved
 *     │           │            │    └─→ false_alarm
 *     │           │            └──────→ false_alarm
 *     ├──→ onsite（跳过派单：值班员自己就在现场）
 *     ├──→ resolved / false_alarm（直接排除）
 *     └──→ false_alarm
 *   resolved / false_alarm ──→ open（复盘发现判错了，重新打开）
 *
 * 故意不允许 dispatched → open：撤单是一次有记录的动作，不该退化成"没发生过"。
 */
const TRANSITIONS: Record<Disposition, readonly Disposition[]> = {
  open: ['dispatched', 'onsite', 'resolved', 'false_alarm'],
  dispatched: ['onsite', 'resolved', 'false_alarm'],
  onsite: ['resolved', 'false_alarm'],
  resolved: ['open'],
  false_alarm: ['open'],
}

export function canTransition(from: Disposition, to: Disposition): boolean {
  return from === to ? false : TRANSITIONS[from].includes(to)
}

export function nextDispositions(from: Disposition): Disposition[] {
  return [...TRANSITIONS[from]]
}

// ---------------------------------------------------------------- 事件

/** 一条预警事件（后端 warning_event 行的领域视图）。 */
export interface AlertEvent {
  readonly id: number
  readonly siteId: string
  readonly siteName: string
  readonly level: Level
  readonly score: number
  readonly peakValue: Depth
  readonly peakAtMin: number | null
  readonly durationMin: number
  readonly slope: Rate
  readonly reason: string
  readonly state: WarnState
  readonly disposition: Disposition
  /** 处置责任人。open 时为 null。 */
  readonly assignee: string | null
  readonly raisedAt: SimTime
  readonly ackedAt: SimTime | null
  readonly clearedAt: SimTime | null
  readonly updatedAt: SimTime
  readonly noteCount: number
}

export type NoteKind = 'note' | 'dispatch' | 'status' | 'close'

export const NOTE_KIND_LABEL: Record<NoteKind, string> = {
  note: '备注',
  dispatch: '派单',
  status: '处置进展',
  close: '结案',
}

export interface AlertNote {
  readonly id: number
  readonly eventId: number
  readonly author: string
  readonly kind: NoteKind
  readonly text: string
  readonly createdAt: SimTime
}

/** 一条事件的完整处置时长（从触发到解除）。 */
export function handlingMinutes(e: AlertEvent): number | null {
  if (!e.clearedAt) return null
  return Math.max(0, Math.round((e.clearedAt - e.raisedAt) / 60))
}


/** 一条预警的完整卷宗：事件本身 + 处置记录。 */
export interface AlertDetail {
  readonly event: AlertEvent
  readonly notes: readonly AlertNote[]
}
