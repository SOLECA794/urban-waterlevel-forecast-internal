import type { ReactNode } from 'react'
import { T } from '../../utils/tokens'
import { Icon, type IconName } from './Icons'

/** 区块标题：图标 + 主标题 + 一句说明 + 右侧操作。
 *  每个卡片都自带标题栏，是为了让"这块在讲什么"不需要靠猜。 */
export function SectionHead({
  title,
  sub,
  icon,
  right,
  className,
}: {
  title: ReactNode
  sub?: ReactNode
  icon?: IconName
  right?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex items-start justify-between gap-3 ${className ?? ''}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          {icon && (
            <span style={{ color: T.ai }}>
              <Icon name={icon} size={14} />
            </span>
          )}
          <div className="card-title">{title}</div>
        </div>
        {sub && <div className="text-[11px] text-ink-3 mt-0.5 leading-snug">{sub}</div>}
      </div>
      {right && <div className="shrink-0 flex items-center gap-2">{right}</div>}
    </div>
  )
}

export function EmptyState({
  icon = 'info',
  title,
  hint,
  action,
  compact = false,
}: {
  icon?: IconName
  title: string
  hint?: ReactNode
  action?: ReactNode
  compact?: boolean
}) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? 'py-8' : 'py-16'}`}>
      <div
        className="rounded-full grid place-items-center mb-3"
        style={{ width: 44, height: 44, background: T.levelWeak.none, color: T.text3 }}
      >
        <Icon name={icon} size={20} />
      </div>
      <div className="text-[13px] font-medium text-ink-2">{title}</div>
      {hint && <div className="text-[12px] text-ink-3 mt-1 max-w-[46ch] leading-relaxed">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

export function Skeleton({ h = 14, w = '100%', className }: { h?: number; w?: number | string; className?: string }) {
  return <div className={`skeleton ${className ?? ''}`} style={{ height: h, width: w }} />
}

/** 横向计量条：0~1 归一化值 + 可选阈值刻度。
 *  刻度是这套界面的一个通用语言——"还差多少到红"比"现在是 0.42m"更直观。 */
export function Meter({
  value,
  color,
  height = 6,
  ticks = [],
  track = '#eef2f6',
  className,
}: {
  value: number
  color: string
  height?: number
  ticks?: number[]
  track?: string
  className?: string
}) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
  return (
    <div
      className={`relative w-full rounded-pill overflow-hidden ${className ?? ''}`}
      style={{ height, background: track }}
    >
      <div
        className="h-full rounded-pill grow-x"
        style={{ width: `${v * 100}%`, background: color }}
      />
      {ticks.map((t, i) => (
        <span
          key={i}
          className="absolute top-0 bottom-0"
          style={{ left: `${Math.min(100, t * 100)}%`, width: 1, background: 'rgba(255,255,255,0.85)' }}
        />
      ))}
    </div>
  )
}

export function Legend({
  items,
  className,
}: {
  items: { color: string; label: string; dashed?: boolean; square?: boolean }[]
  className?: string
}) {
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${className ?? ''}`}>
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5 text-[11px] text-ink-3">
          {it.square ? (
            <span style={{ width: 8, height: 8, borderRadius: 2, background: it.color }} />
          ) : (
            <span
              style={{
                width: 14,
                height: 0,
                borderTop: `2px ${it.dashed ? 'dashed' : 'solid'} ${it.color}`,
                display: 'inline-block',
              }}
            />
          )}
          {it.label}
        </span>
      ))}
    </div>
  )
}

/** 时间条（Tracker）：把最近若干小时的最高预警等级压成一条色带。
 *  参考 GitHub 贡献图 / Tremor Tracker——它回答的是"这半天有多不太平"，
 *  表格回答不了这个问题。 */
export function Tracker({
  slots,
  height = 26,
  onHover,
}: {
  slots: { key: string; label: string; level: string; count: number }[]
  height?: number
  onHover?: (key: string | null) => void
}) {
  return (
    <div className="flex items-stretch gap-[3px] w-full" style={{ height }}>
      {slots.map((s) => {
        const color = s.count > 0 ? (T.level[s.level] ?? T.level.none) : T.levelWeak.none
        return (
          <div
            key={s.key}
            title={`${s.label} · ${s.count > 0 ? `${s.count} 条告警` : '无告警'}`}
            onMouseEnter={() => onHover?.(s.key)}
            onMouseLeave={() => onHover?.(null)}
            className="flex-1 rounded-[3px] transition-transform duration-150 hover:scale-y-110"
            style={{ background: color, opacity: s.count > 0 ? 0.9 : 1, minWidth: 4 }}
          />
        )
      })}
    </div>
  )
}

export function KeyValue({ k, v, mono = true }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-1 border-b border-line-2 last:border-0">
      <span className="text-[12px] text-ink-3">{k}</span>
      <span className={`text-[12px] text-ink ${mono ? 'num' : ''}`}>{v}</span>
    </div>
  )
}
