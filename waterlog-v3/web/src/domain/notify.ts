import type { Level } from './level'
import type { SimTime } from './time'

/**
 * 推送渠道。
 *
 * 一条预警最终要"到达"某个人，渠道就是那条路。这里刻意只有两个真渠道：
 * inapp（站内弹窗，永远开）与 webhook（推给外部系统）。
 * 短信/邮件/钉钉都留了名字但不假装能用——登记一个能点"测试"却永远
 * 失败的行，比不登记更误导人。
 */
export type ChannelName = 'inapp' | 'webhook'

export interface NotifyChannel {
  readonly name: ChannelName | string
  readonly enabled: boolean
  readonly endpoint: string
  /** 后端已打码；回传打码串表示「不改」。 */
  readonly secret: string
  readonly minLevel: Level
  readonly debounceMin: number
  readonly updatedAt: SimTime | null
}

/** 渠道的人话说明，用来说明「这个渠道是干什么的」，而不是重复名字。 */
export const CHANNEL_LABEL: Record<string, string> = {
  inapp: '站内弹窗',
  webhook: '外部 Webhook',
}

export const CHANNEL_HINT: Record<string, string> = {
  inapp: '值班页面的实时提示。永远启用——关掉它等于把预警的可靠性押在第三方可用性上。',
  webhook: '把预警 POST 给你自己的系统（短信网关、钉钉机器人、工单系统都行）。',
}

/** 一次推送尝试。失败也留痕：值班员要能证明「这条没推出去」。 */
export interface Delivery {
  readonly id: number
  readonly at: SimTime
  readonly channel: string
  readonly siteId: string
  readonly level: Level
  readonly ok: boolean
  readonly detail: string
}

/**
 * 是否允许关闭该渠道。
 *
 * 只有 inapp 不可关。这条判断放在领域层，是为了让界面与后端用同一句话
 * 解释「为什么这个开关是灰的」——后端 service.NotifyChannel 里有同样的约束。
 */
export function canDisableChannel(name: string): boolean {
  return name !== 'inapp'
}

/** 该渠道是否"真的能发出去"（配置齐全且已启用）。 */
export function isChannelLive(c: NotifyChannel): boolean {
  if (!c.enabled) return false
  if (c.name === 'inapp') return true
  return c.endpoint.trim().length > 0
}
