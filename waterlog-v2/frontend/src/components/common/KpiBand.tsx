// KPI 指标带：总览首屏指挥中心式指标卡
// 数据全部来自真实接口，空值按契约弱化
// 规范：docs/02-design/DESIGN-v2-设计系统规范.md §2 / §4 / §5.2 / §6
import React, { type CSSProperties } from 'react'
import { AnimatedNumber } from './AnimatedNumber'

interface KpiItem {
  label: string
  value: React.ReactNode
  unit?: string
  hint?: React.ReactNode
  tone?: 'default' | 'primary' | 'warning' | 'danger' | 'success'
  /** 覆盖数值颜色（如告警等级色），优先于 tone */
  color?: string
  icon?: React.ReactNode
  /** 小数位（value 为数字时生效） */
  decimals?: number
}

const TONE_COLOR: Record<NonNullable<KpiItem['tone']>, string> = {
  default: 'var(--text-1)',
  primary: 'var(--primary)',
  warning: 'var(--warning-ink)',
  danger: 'var(--danger-ink)',
  success: 'var(--success-ink)',
}

const KpiCard: React.FC<{ item: KpiItem; index: number }> = ({ item, index }) => {
  const isNumber = typeof item.value === 'number'
  const isEmpty = item.value === '—' || item.value === null || item.value === undefined
  const valueColor = isEmpty ? 'var(--text-3)' : (item.color ?? TONE_COLOR[item.tone ?? 'default'])
  const valueStyle: CSSProperties = {
    fontSize: 'var(--fs-2xl)',
    color: valueColor,
  }

  return (
    <div
      className="kpi-card surface-card stagger-item"
      style={{ '--i': index, padding: 'var(--sp-4) var(--sp-5)', minWidth: 0 } as CSSProperties}
    >
      <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-3)' }}>
        {item.icon}
        <span className="truncate">{item.label}</span>
      </div>

      <div className="flex items-baseline gap-1 mt-1.5">
        {isNumber ? (
          <AnimatedNumber
            value={item.value as number}
            decimals={item.decimals ?? 0}
            className="num font-bold leading-none truncate"
            style={valueStyle}
          />
        ) : (
          <span className="num font-bold leading-none truncate" style={valueStyle}>
            {item.value}
          </span>
        )}
        {item.unit && !isEmpty && (
          <span className="text-xs" style={{ color: 'var(--text-3)' }}>{item.unit}</span>
        )}
      </div>

      {item.hint && (
        <div className="text-xs mt-1.5 truncate" style={{ color: 'var(--text-3)' }}>{item.hint}</div>
      )}
    </div>
  )
}

export const KpiBand: React.FC<{ items: KpiItem[] }> = ({ items }) => (
  <div
    className="grid gap-3 mb-3"
    style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}
  >
    {items.map((it, i) => <KpiCard key={i} item={it} index={i} />)}
  </div>
)

export type { KpiItem }
