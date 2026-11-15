import { useMemo } from 'react'
import {
  DISPOSITION_LABEL,
  handlingMinutes,
  isActive,
  isTerminal,
  isUnack,
  maxLevel,
  type AlertEvent,
  type Level,
  type SimTime,
} from '../domain'
import { useAlerts, useMetrics, useOverview } from '../data/queries'

/**
 * 值班台的视图模型：把「一堆预警」整理成「下一班需要接手的事」。
 *
 * 为什么不在页面里算：上一版每个页面各算一遍，关注清单和站点表对同一批数据的
 * 排序已经不一致过。这里只产出**结论**，页面只负责排版。
 *
 * 与预警中心的分工：预警中心是「这一条预警的完整卷宗」（读 + 改），
 * 值班台是「这 12 小时的整体交代」（读）。前者按事件组织，后者按交接组织。
 */

export const SHIFT_HOURS = 12

/** 交接事项的严重度，决定排序与配色。 */
export type TodoTone = 'critical' | 'warn' | 'info'

export interface ShiftTodo {
  readonly event: AlertEvent
  /** 从升起到现在多少分钟 */
  readonly ageMin: number
  /** 从升起到确认多少分钟（未确认则 null） */
  readonly ackMin: number | null
  /** 该谁做、做什么——这是交班报告里真正有用的那一行 */
  readonly action: string
  readonly tone: TodoTone
}

export interface ShiftReport {
  readonly hasData: boolean
  readonly from: SimTime
  readonly to: SimTime
  readonly hours: number
  /** 本班次内新升起的预警数 */
  readonly raised: number
  /** 本班次内解除的 */
  readonly cleared: number
  /** 仍在激活中的（不限于本班次内） */
  readonly active: number
  readonly worst: Level
  /** 本班次内的平均确认耗时（分钟），无样本为 null */
  readonly avgAckMin: number | null
  /** 未闭环事项：还需要有人现在动手的，按严重度与时长排序 */
  readonly todos: readonly ShiftTodo[]
  /** 已解除但没有任何处置记录的事件数——只需要事后归档，不算交接事项 */
  readonly backlog: number
  /** 本班次事件流，新的在前 */
  readonly timeline: readonly AlertEvent[]
  /** 在线滚动评估，用来看「这个班的预测靠不靠谱」 */
  readonly quality: { readonly n: number; readonly skill: number | null } | null
}

const TONE_RANK: Record<TodoTone, number> = { critical: 0, warn: 1, info: 2 }

/**
 * 一条未闭环的预警，下一步该做什么。
 *
 * 这里写的是**业务规则**而不是文案：判据是「预警还成立吗」×「处置到哪一步了」，
 * 两者交叉出六种情况。分散在界面里写 if 就会出现「已处置但预警仍成立却不提示复核」这种漏。
 */
function nextAction(e: AlertEvent, now: SimTime): { action: string; tone: TodoTone } {
  const ageMin = Math.max(0, Math.round((now - e.raisedAt) / 60))

  if (!isActive(e.state)) {
    return { action: '预警已解除，核对处置记录是否闭环后归档', tone: 'info' }
  }
  if (isTerminal(e.disposition)) {
    return {
      action: `已标记「${DISPOSITION_LABEL[e.disposition]}」但预警仍然成立，需复核是否真的退水`,
      tone: 'critical',
    }
  }
  if (e.disposition === 'open') {
    return isUnack(e.state)
      ? { action: '未确认且未派单，需立即确认并指定处置单位', tone: 'critical' }
      : { action: '已确认但未派单，需指定处置单位', tone: 'critical' }
  }
  if (e.disposition === 'dispatched') {
    return ageMin > 30
      ? { action: `已派单 ${ageMin} 分钟仍未到场，需催办`, tone: 'critical' }
      : { action: '已派单，等待处置单位到场', tone: 'warn' }
  }
  return { action: '现场处置中，待回填结果', tone: 'warn' }
}

export function useShiftReport(hours = SHIFT_HOURS): ShiftReport {
  const overview = useOverview()
  const alerts = useAlerts(false)
  const metrics = useMetrics(hours)

  return useMemo(() => {
    const all = alerts.data ?? []
    const rows = overview.data?.rows ?? []

    // 「现在」取仿真时钟：优先用预测发布时间（它跟引擎心跳对齐），
    // 再退化到最新一条预警的更新时间。绝不用 Date.now()——模拟器是 60 倍速的。
    const now = (overview.data?.issuedAt ??
      (all.length > 0 ? Math.max(...all.map((a) => a.updatedAt)) : 0)) as SimTime

    const to = now
    const from = (now - hours * 3600) as SimTime

    const inWindow = all.filter((a) => a.raisedAt >= from && a.raisedAt <= to)
    const raised = inWindow.length
    const cleared = inWindow.filter((a) => !isActive(a.state)).length

    const active = all.filter((a) => isActive(a.state)).length
    const worst = maxLevel(all.filter((a) => isActive(a.state)).map((a) => a.level))

    const acks = inWindow
      .map((a) => (a.ackedAt ? Math.round((a.ackedAt - a.raisedAt) / 60) : null))
      .filter((v): v is number => v !== null && v >= 0)
    const avgAckMin = acks.length > 0 ? Math.round(acks.reduce((s, v) => s + v, 0) / acks.length) : null

    // 「需要动手」的两种：预警还成立（不管处置到哪一步），
    // 或者人还在现场（已派单/已到场）——后者即使预警解除了也得有人回填结果。
    // 已解除 + 无处置记录的（backlog）不进这里：那是事后归档，不是交接事项。
    const needsHand = (a: AlertEvent) =>
      isActive(a.state) || a.disposition === 'dispatched' || a.disposition === 'onsite'

    const backlog = all.filter((a) => !isActive(a.state) && a.disposition === 'open').length

    const todos: ShiftTodo[] = all
      .filter(needsHand)
      .map((a) => {
        const { action, tone } = nextAction(a, now)
        return {
          event: a,
          ageMin: Math.max(0, Math.round((now - a.raisedAt) / 60)),
          ackMin: a.ackedAt ? Math.max(0, Math.round((a.ackedAt - a.raisedAt) / 60)) : null,
          action,
          tone,
        }
      })
      .sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.ageMin - a.ageMin)

    const timeline = [...inWindow].sort((a, b) => b.raisedAt - a.raisedAt)

    const rolling = metrics.data?.rolling
    const stat = rolling?.[String(180)] ?? rolling?.[String(60)] ?? null

    return {
      hasData: rows.length > 0,
      from,
      to,
      hours,
      raised,
      cleared,
      active,
      worst,
      avgAckMin,
      todos,
      backlog,
      timeline,
      quality: stat ? { n: stat.n, skill: stat.skill } : null,
    }
  }, [alerts.data, overview.data, metrics.data, hours])
}

/** 把「多少分钟」说成人话：交接时不需要 137 分钟这种数。 */
export function ageText(min: number): string {
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟`
  // 超过一天要说「天」，不能写「10757 小时」：那串数字读不出量级，
  // 而且它一旦出现就说明数据有问题（仿真时钟跳变过的旧事件），
  // 写成天数至少让人一眼看出「这是很久以前的事」。
  if (min >= 1440) {
    const d = Math.floor(min / 1440)
    const h = Math.floor((min % 1440) / 60)
    return h === 0 ? `${d} 天` : `${d} 天 ${h} 小时`
  }
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

/** 本班次的处置完成率，用于一句话结论。 */
export function closureRate(r: ShiftReport): number | null {
  const total = r.raised
  if (total === 0) return null
  return r.cleared / total
}

/** 确认耗时是否算「慢」。消防/排水类处置的常见口径是 15 分钟内确认。 */
export const ACK_SLA_MIN = 15

export function ackVerdict(r: ShiftReport): { text: string; ok: boolean } | null {
  if (r.avgAckMin === null) return null
  return r.avgAckMin <= ACK_SLA_MIN
    ? { text: `平均 ${r.avgAckMin} 分钟，在 ${ACK_SLA_MIN} 分钟要求内`, ok: true }
    : { text: `平均 ${r.avgAckMin} 分钟，超过 ${ACK_SLA_MIN} 分钟要求`, ok: false }
}

/** 供页面直接取用的辅助：某条是将要归档的「已解除」还是仍需动手。 */
export function isOpenTodo(t: ShiftTodo): boolean {
  return isActive(t.event.state) || !isTerminal(t.event.disposition)
}

export { handlingMinutes }
