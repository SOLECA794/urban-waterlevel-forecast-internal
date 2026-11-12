// 数字滚动：让"数值变了"这件事被看见（规范 §5.2 状态变化动机）
//
// 实现约束（design-taste §3.B / §5.4）：
//   禁止 useState + requestAnimationFrame 逐帧改状态 —— 会触发整棵 React 树重渲染。
//   本组件用 motion 的 useMotionValue 持有数值，用 useMotionValueEvent 把结果直接写进 DOM，
//   React 树不参与逐帧更新。
import React, { useEffect, useRef } from 'react'
import { animate, useMotionValue, useMotionValueEvent, useReducedMotion } from 'motion/react'

interface AnimatedNumberProps {
  value: number
  /** 小数位数 */
  decimals?: number
  prefix?: string
  suffix?: string
  className?: string
  style?: React.CSSProperties
  /** 过渡时长（秒），规范默认 0.42s */
  duration?: number
}

const format = (v: number, decimals: number): string => v.toFixed(decimals)

export const AnimatedNumber: React.FC<AnimatedNumberProps> = ({
  value,
  decimals = 0,
  prefix = '',
  suffix = '',
  className,
  style,
  duration = 0.42,
}) => {
  const reduce = useReducedMotion()
  const mv = useMotionValue(value)
  const ref = useRef<HTMLSpanElement>(null)

  // 逐帧写入 DOM，不进 React state
  useMotionValueEvent(mv, 'change', (v) => {
    if (ref.current) ref.current.textContent = `${prefix}${format(v, decimals)}${suffix}`
  })

  useEffect(() => {
    if (ref.current) ref.current.textContent = `${prefix}${format(value, decimals)}${suffix}`
  }, [prefix, suffix, decimals])

  useEffect(() => {
    if (reduce) {
      mv.set(value)
      return
    }
    const controls = animate(mv, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
    })
    return () => controls.stop()
  }, [value, reduce, duration, mv])

  return (
    <span ref={ref} className={className} style={style}>
      {prefix}
      {format(value, decimals)}
      {suffix}
    </span>
  )
}

export default AnimatedNumber
