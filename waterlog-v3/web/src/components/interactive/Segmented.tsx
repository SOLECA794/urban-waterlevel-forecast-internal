import type { ReactNode } from 'react'
import { T } from '../../utils/tokens'

/**
 * 分段控件：一排互斥选项，当前项有「滑块」。
 *
 * 为什么不用下拉框：选项只有 3~5 个而且是高频切换（排序方式、时间窗），
 * 下拉要多点一次、还把选项藏起来。分段控件一眼看到全部选项，一次点击切到位。
 *
 * 滑块用 CSS transition 而不是 motion：它只是背景块平移，
 * 上 motion 反而会和列表重排抢帧。
 */
export function Segmented<K extends string>({
  value,
  options,
  onChange,
  size = 'md',
  iconOnly = false,
}: {
  value: K
  options: readonly { value: K; label: string; hint?: string; icon?: ReactNode }[]
  onChange: (v: K) => void
  size?: 'sm' | 'md'
  iconOnly?: boolean
}) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value))
  const h = size === 'sm' ? 24 : 30
  const pad = size === 'sm' ? '0 9px' : '0 12px'

  return (
    <div
      role="tablist"
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        height: h,
        padding: 2,
        borderRadius: 8,
        background: '#EDF3F9',
        border: `1px solid ${T.border1}`,
        gap: 2,
      }}
    >
      {/* 滑块：宽度按等分算——选项文字长度差得多时会略偏，但比逐个量 DOM 便宜得多 */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 2,
          bottom: 2,
          left: `calc(${(idx / options.length) * 100}% + 2px)`,
          width: `calc(${100 / options.length}% - 4px)`,
          borderRadius: 6,
          background: T.surface,
          boxShadow: '0 1px 3px rgba(11,37,69,0.12)',
          transition: 'left 220ms cubic-bezier(.22,.61,.36,1)',
        }}
      />
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            title={o.hint ?? o.label}
            onClick={() => onChange(o.value)}
            style={{
              position: 'relative',
              zIndex: 1,
              flex: 1,
              height: '100%',
              padding: iconOnly ? 0 : pad,
              border: 0,
              background: 'transparent',
              borderRadius: 6,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              fontSize: size === 'sm' ? 11.5 : 12.5,
              fontWeight: on ? 700 : 500,
              color: on ? T.text1 : T.text2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 5,
              transition: 'color 140ms ease',
            }}
          >
            {o.icon}
            {iconOnly ? null : o.label}
          </button>
        )
      })}
    </div>
  )
}
