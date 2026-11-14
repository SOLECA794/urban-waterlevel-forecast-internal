import { useCallback, useMemo, useRef, useState } from 'react'
import type { Level } from '../domain'
import type { StageCtx } from './ctx'
import {
  decodeUrl,
  encodeUrl,
  INITIAL,
  reduce,
  type Action,
  type Crumb,
  type Stage,
  type WorkbenchState,
} from './model'

/**
 * 工作台的唯一状态源 + 对外的 ctx。
 *
 * 为什么用 `useReducer` 而不是一堆 `useState`：舞台、钻取栈、左栏筛选这三组状态
 * 之间是有约束的（换舞台必须清栈、压栈可能截断栈、同一对象不重复入栈）。
 * 分开写 `useState` 时这些约束只能靠调用方自觉遵守，漏一处就会出现
 * 「栈里还是上一个舞台的路径」这种不会报错但会骗人的状态。
 *
 * 为什么 URL 用 `replaceState`：每点一个站都塞一条 history，
 * 用户按一次后退只退掉「刚才点了哪个站」，要退很多次才离开这一屏——
 * 那等于把「钻取」和「导航」混成了一件事。这里 history 只记真正的场景切换，
 * 屏内的层次变化只更新地址栏，让链接可分享、刷新能复原。
 */
export function useWorkbench() {
  const [state, setState] = useState<WorkbenchState>(() =>
    typeof window === 'undefined' ? INITIAL : decodeUrl(window.location.search, (id) => id),
  )
  const [flash, setFlash] = useState<{ k: 'ok' | 'err' | 'info'; msg: string; id: number } | null>(null)
  const flashId = useRef(0)

  const dispatch = useCallback((a: Action) => setState((s) => reduce(s, a)), [])

  // 地址栏同步写在渲染期而不是 effect 里：放进 effect 会比渲染慢一帧，
  // 用户点完站、地址栏还停在旧值上，此刻刷新就会回到上一个画面。
  // 用 ref 区分首次挂载——首次是「从地址栏读」，之后才是「往地址栏写」。
  const first = useRef(true)
  if (typeof window !== 'undefined' && !first.current) {
    const qs = encodeUrl(state)
    const want = `${window.location.pathname}${qs}`
    const now = `${window.location.pathname}${window.location.search}`
    if (want !== now) window.history.replaceState(null, '', want)
  }
  first.current = false

  const toast = useCallback((k: 'ok' | 'err' | 'info', msg: string) => {
    flashId.current += 1
    setFlash({ k, msg, id: flashId.current })
  }, [])

  const ctx: StageCtx = useMemo(() => {
    const goStage = (s: Stage) => dispatch({ type: 'stage', stage: s })
    return {
      state: { stage: state.stage, trail: state.trail },
      goStage,
      pick: (s: Stage, c: Crumb) => dispatch({ type: 'pick', stage: s, crumb: c }),
      push: (c: Crumb) => dispatch({ type: 'push', crumb: c }),
      popTo: (i: number) => dispatch({ type: 'popTo', index: i }),
      pop: () => dispatch({ type: 'pop' }),
      home: () => dispatch({ type: 'home' }),
      openSite: (siteId: string, name?: string) =>
        dispatch({ type: 'push', crumb: { kind: 'site', siteId, name: name ?? siteId } }),
      openEvent: (eventId: number, name?: string, level?: Level) =>
        dispatch({
          type: 'push',
          crumb: { kind: 'event', eventId, name: name ?? `预警 #${eventId}`, level: level ?? 'none' },
        }),
      openMetric: (key: string, name: string) =>
        dispatch({ type: 'push', crumb: { kind: 'metric', key, name } }),
      openLayer: (key: string, name: string) =>
        dispatch({ type: 'push', crumb: { kind: 'layer', key, name } }),
      openApi: (key: string, name: string) =>
        dispatch({ type: 'push', crumb: { kind: 'api', key, name } }),
      setSort: (s) => dispatch({ type: 'sort', sort: s }),
      toast,
    }
  }, [state.stage, state.trail, dispatch, toast])

  const setQuery = useCallback((query: string) => dispatch({ type: 'query', query }), [dispatch])
  const setAlarmsOnly = useCallback((on: boolean) => dispatch({ type: 'alarmsOnly', on }), [dispatch])

  return { state, ctx, setQuery, setAlarmsOnly, flash, clearFlash: () => setFlash(null) }
}
