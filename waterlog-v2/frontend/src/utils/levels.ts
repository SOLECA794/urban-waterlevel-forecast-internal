// 告警等级与状态的集中定义（规范 §1.3 双轨制）
// 此前同一套等级色在 DashboardPage / AlarmsPage / RulesPage 各写一份，
// 属于典型的"同一语义多处定义"，本模块收口为唯一来源。
import type { LevelKey } from '@/api/types'

export interface LevelMeta {
  /** 完整名称，如「橙色预警」 */
  label: string
  /** surface 色：用于色块、边框、图表线条 */
  color: string
  /** ink 色：用于文字，保证 WCAG AA */
  ink: string
  /** 浅底色：用于行底、标签底 */
  weak: string
  /** 等级序号，数值越大越严重 */
  rank: number
}

export const LEVEL_META: Record<LevelKey, LevelMeta> = {
  blue: { label: '蓝色预警', color: 'var(--level-blue)', ink: 'var(--level-blue-ink)', weak: 'var(--level-blue-weak)', rank: 1 },
  yellow: { label: '黄色预警', color: 'var(--level-yellow)', ink: 'var(--level-yellow-ink)', weak: 'var(--level-yellow-weak)', rank: 2 },
  orange: { label: '橙色预警', color: 'var(--level-orange)', ink: 'var(--level-orange-ink)', weak: 'var(--level-orange-weak)', rank: 3 },
  red: { label: '红色预警', color: 'var(--level-red)', ink: 'var(--level-red-ink)', weak: 'var(--level-red-weak)', rank: 4 },
}

export const levelLabel = (k: LevelKey): string => LEVEL_META[k]?.label ?? '未知等级'
export const levelColor = (k: LevelKey): string => LEVEL_META[k]?.color ?? 'var(--neutral)'
export const levelInk = (k: LevelKey): string => LEVEL_META[k]?.ink ?? 'var(--text-2)'

/** 告警生命周期状态（ThingsBoard 四态范式） */
export interface StateMeta {
  label: string
  color: string
  ink: string
  weak: string
}

export const ALARM_STATE_META: Record<string, StateMeta> = {
  ACTIVE_UNACK: { label: '生效 · 未确认', color: 'var(--danger)', ink: 'var(--danger-ink)', weak: 'var(--level-red-weak)' },
  ACTIVE_ACK: { label: '生效 · 已确认', color: 'var(--warning)', ink: 'var(--warning-ink)', weak: 'var(--level-yellow-weak)' },
  CLEARED_UNACK: { label: '解除 · 未确认', color: 'var(--text-3)', ink: 'var(--text-2)', weak: 'var(--bg-subtle)' },
  CLEARED_ACK: { label: '解除 · 已确认', color: 'var(--success)', ink: 'var(--success-ink)', weak: 'var(--bg-subtle)' },
}

export const alarmStateMeta = (s?: string): StateMeta =>
  ALARM_STATE_META[s ?? ''] ?? { label: s ?? '未知', color: 'var(--neutral)', ink: 'var(--text-2)', weak: 'var(--bg-subtle)' }
