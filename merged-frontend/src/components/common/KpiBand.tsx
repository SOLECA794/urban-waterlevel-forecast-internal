// KPI 指标带：总览首屏指挥中心式指标卡（观感升级 ①）
// 数据全部来自真实接口，空值按契约弱化
import React from 'react'

interface KpiItem {
  label: string
  value: React.ReactNode
  unit?: string
  hint?: React.ReactNode
  tone?: 'default' | 'primary' | 'warning' | 'danger' | 'success'
  icon?: React.ReactNode
}

const TONE_COLOR: Record<NonNullable<KpiItem['tone']>, string> = {
  default: 'var(--text-1)',
  primary: '#2563EB',
  warning: '#D97706',
  danger: '#DC2626',
  success: '#16A34A',
}

const KpiCard: React.FC<{ item: KpiItem }> = ({ item }) => (
  <div
    className="kpi-card"
    style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border-1)',
      borderRadius: 10,
      padding: '14px 18px',
      minWidth: 0,
    }}
  >
    <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-3)' }}>
      {item.icon}
      <span className="truncate">{item.label}</span>
    </div>
    <div className="flex items-baseline gap-1 mt-1.5">
      <span
        className="num font-bold leading-none truncate"
        style={{ fontSize: 28, color: item.value === '—' ? 'var(--text-3)' : TONE_COLOR[item.tone ?? 'default'] }}
      >
        {item.value}
      </span>
      {item.unit && item.value !== '—' && (
        <span className="text-xs" style={{ color: 'var(--text-3)' }}>{item.unit}</span>
      )}
    </div>
    {item.hint && (
      <div className="text-xs mt-1.5 truncate" style={{ color: 'var(--text-3)' }}>{item.hint}</div>
    )}
  </div>
)

export const KpiBand: React.FC<{ items: KpiItem[] }> = ({ items }) => (
  <div
    className="grid gap-3 mb-3"
    style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}
  >
    {items.map((it, i) => <KpiCard key={i} item={it} />)}
  </div>
)

export type { KpiItem }
