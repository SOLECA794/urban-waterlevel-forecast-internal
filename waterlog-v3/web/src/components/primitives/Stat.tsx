import type { ReactNode } from 'react'
import { T } from '../../utils/tokens'
import { Icon, type IconName } from './Icons'
import { Sparkline } from './Sparkline'

export type Tone = 'red' | 'orange' | 'yellow' | 'blue' | 'none' | 'neutral'

const TONE_TEXT: Record<Tone, string> = {
  red: T.levelInk.red,
  orange: T.levelInk.orange,
  yellow: T.levelInk.yellow,
  blue: T.levelInk.blue,
  none: T.levelInk.none,
  neutral: T.text2,
}

/** 变化量徽标：箭头 + 数值。
 *  用箭头而不是只靠颜色——色盲用户和黑白打印都需要第二重编码。 */
export function Delta({
  value,
  digits = 2,
  suffix = '',
  goodWhenDown = false,
  className,
}: {
  value: number | null | undefined
  digits?: number
  suffix?: string
  goodWhenDown?: boolean
  className?: string
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className={`text-[11px] text-ink-3 ${className ?? ''}`}>—</span>
  }
  const flat = Math.abs(value) < 10 ** -digits / 2
  const up = value > 0
  const good = goodWhenDown ? !up : up
  const color = flat ? T.text3 : good ? T.success : T.level.red
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[11px] font-medium num ${className ?? ''}`}
      style={{ color }}
    >
      {flat ? <Icon name="minus" size={11} /> : <Icon name={up ? 'arrowUp' : 'arrowDown'} size={11} />}
      {value > 0 ? '+' : ''}
      {value.toFixed(digits)}
      {suffix}
    </span>
  )
}

/** 指标卡。参考 Tremor / Vercel Analytics 的 stat 卡结构：
 *  小标签 → 大数字 → 变化徽标 → 迷你曲线，四层信息按"从结论到证据"排。 */
export function StatCard({
  label,
  value,
  unit,
  delta,
  deltaSuffix,
  deltaDigits = 3,
  goodWhenDown,
  tone = 'neutral',
  spark,
  sparkColor,
  footer,
  icon,
  onClick,
  emphasis = false,
}: {
  label: string
  value: ReactNode
  unit?: string
  delta?: number | null
  deltaSuffix?: string
  deltaDigits?: number
  goodWhenDown?: boolean
  tone?: Tone
  spark?: number[]
  sparkColor?: string
  footer?: ReactNode
  /** 图标名，不是节点——卡片图标只有「哪个」这一个自由度，传节点会让每个调用点各写一遍 size/颜色 */
  icon?: IconName
  onClick?: () => void
  emphasis?: boolean
}) {
  const tinted = tone !== 'neutral'
  const bg = tinted ? T.levelGrad[tone] : undefined
  const accent = tinted ? T.level[tone] : T.borderStrong
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      onClick={onClick}
      className={`card p-3 text-left w-full ${onClick ? 'card-hover' : ''}`}
      style={{
        backgroundImage: bg,
        borderColor: emphasis && tinted ? `${T.level[tone]}44` : undefined,
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {icon ? (
            <span style={{ color: tinted ? TONE_TEXT[tone] : T.text3 }}>
              <Icon name={icon} size={13} />
            </span>
          ) : (
            <span className="chip-dot" style={{ background: accent }} />
          )}
          <span className="text-[12px] font-medium truncate" style={{ color: tinted ? TONE_TEXT[tone] : T.text2 }}>
            {label}
          </span>
        </div>
        {delta !== undefined && (
          <Delta value={delta} digits={deltaDigits} suffix={deltaSuffix} goodWhenDown={goodWhenDown} />
        )}
      </div>

      <div className="mt-1.5 flex items-end gap-1">
        <span className="stat-value" style={{ color: tinted ? TONE_TEXT[tone] : T.text1 }}>
          {value}
        </span>
        {unit && <span className="text-[11px] text-ink-3 mb-0.5">{unit}</span>}
      </div>

      {spark && spark.length > 1 && (
        <div className="mt-1 -mb-0.5 opacity-90">
          <Sparkline data={spark} color={sparkColor ?? accent} height={26} area showLast={false} />
        </div>
      )}

      {footer && <div className="mt-1.5 text-[11px] text-ink-3 truncate">{footer}</div>}
    </Tag>
  )
}
