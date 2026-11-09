import { useEffect, useState } from 'react'

/**
 * 轮换节拍。
 *
 * 不用「每帧 setState 推进度条」：那会让 1920×1080 的整棵树 60fps 重渲染，
 * 而大屏本来就常驻在低配盒子/会议室电脑上。改成
 *   ① setTimeout 只负责「到点换一屏」
 *   ② 进度条交给 CSS 动画（key 变化就重放）
 * 于是每秒的重渲染次数从 60 降到 0，只有换屏那一下才渲染。
 */
export function useRotation(count: number, durationMs: number): number {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (count <= 1) return
    const id = window.setTimeout(() => setIndex((i) => (i + 1) % count), durationMs)
    return () => window.clearTimeout(id)
  }, [index, count, durationMs])

  // 屏数变少时（比如筛选后）把游标收回范围内
  useEffect(() => {
    if (index >= count) setIndex(0)
  }, [count, index])

  return index
}

/** 每秒走一次的墙钟，只给「几秒前更新」这类文案用。 */
export function useTick(ms = 1000): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setN((v) => v + 1), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return n
}
