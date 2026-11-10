import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 大屏场景轮播引擎。
 *
 * 五条纪律，都是这类屏踩出来的：
 *
 *  1) **轮播与数据刷新彻底解耦**。轮播只管「到点换一屏」，
 *     数据什么时候刷新、刷新多少次都跟它无关。
 *     反过来做（把轮播绑在某个请求的 then 上）会出现「请求慢了就卡屏」。
 *  2) **不用逐帧 setState 推进度条**。1920×1080 的整棵树每帧重渲染，
 *     在常驻的会议室盒子上会直接掉帧。进度条交给 CSS 动画，
 *     于是每秒的重渲染次数从 60 降到 0，只有换屏那一下才渲染。
 *  3) **页面不可见（document.hidden）时挂起计时器**。
 *     否则切到别的标签页之后，屏已经翻了好几页，回来看是一片陈旧数据。
 *  4) **定屏（?scene=N）时不自动推进**，但手动切换仍然可用——
 *     截图脚本要的就是「定在第 N 屏别动」。
 *  5) **时长按场景取，不取平均**。主页组件多、密度高，需要更长的阅读时间；
 *     统一一个平均值会让主页读不完、其余场景又读腻。
 */

export interface SceneRotation {
  /** 目标场景下标 */
  index: number
  /** 是否正在自动推进 */
  playing: boolean
  setIndex: (i: number) => void
  setPlaying: (v: boolean) => void
  next: () => void
  prev: () => void
  togglePlay: () => void
}

export function useSceneRotation(opts: {
  count: number
  /** 取第 i 屏的停留时长（毫秒） */
  durationMs: (index: number) => number
  /** 定屏：锁住不自动推进 */
  locked?: boolean
  /** 初始场景下标 */
  initial?: number
}): SceneRotation {
  const { count, durationMs, locked = false, initial = 0 } = opts

  const [index, setIndexRaw] = useState(initial)
  const [playing, setPlaying] = useState(!locked)
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden)

  // durationMs 每渲染都是新函数，用 ref 固定住，
  // 否则下面那个 effect 的依赖每次都变，计时器会被无限重建 —— 屏永远不换。
  const durationRef = useRef(durationMs)
  durationRef.current = durationMs

  useEffect(() => {
    const onVis = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // 场景数变化（未来可能按条件过滤场景）时把游标收回范围
  useEffect(() => {
    if (index >= count) setIndexRaw(0)
  }, [count, index])

  useEffect(() => {
    if (locked || !playing || hidden || count <= 1) return
    const ms = Math.max(1000, durationRef.current(index))
    const t = window.setTimeout(() => setIndexRaw((i) => (i + 1) % count), ms)
    return () => window.clearTimeout(t)
  }, [index, count, playing, hidden, locked])

  const setIndex = useCallback(
    (i: number) => {
      if (count <= 0) return
      setIndexRaw(((i % count) + count) % count)
    },
    [count],
  )

  return {
    index,
    playing,
    setIndex,
    setPlaying,
    next: useCallback(() => setIndexRaw((i) => (i + 1) % Math.max(1, count)), [count]),
    prev: useCallback(() => setIndexRaw((i) => (i - 1 + Math.max(1, count)) % Math.max(1, count)), [count]),
    togglePlay: useCallback(() => setPlaying((v) => !v), []),
  }
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
