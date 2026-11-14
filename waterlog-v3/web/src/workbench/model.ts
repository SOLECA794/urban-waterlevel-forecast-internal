/**
 * 工作台的状态模型：**整套业务能力都在这一屏里，靠「选中什么 + 钻到第几层」决定看见什么。**
 *
 * 为什么不用路由：路由的语义是「换了一页」，于是每次跳转都重置滚动、排序、筛选，
 * 用户失去刚才在看的东西。而值班员真正的工作是连续的——「这个站怎么样 → 旁边那个呢
 * → 这条预警谁在管 → 处置记录写了什么」，这中间不该有任何一次「回到列表重找」。
 *
 * 为什么不用标签：十个页面本来就是「同一批数据换了十个筛选条件」。加一行标签栏，
 * 等于把十个筛选条件摆出来让人挑，还是没有回答「我现在应该看什么」。
 * 这一屏的回答方式是：**入口就是屏幕上已经写着的事实**——
 * 那个「4 站红色」的计数、那个模型版本号、那个因子权重、那盏链路指示灯。
 *
 * 三条约束（也是验收标准）：
 *   1. 一屏里同时看得见四件事：这个站的事实 / 它接下来的走向 / 它凭什么这样判 / 谁在管。
 *   2. 换选中对象时，除「舞台」以外的东西不重置——左栏滚动位置、排序、筛选、右栏栈的上层。
 *   3. 任何一条预警都能在这一屏里处理到「已归档」，中间不跳页、不丢上下文。
 */

import type { Level } from '../domain'

/** 舞台当前显示什么。**这是唯一的「页面」概念**，但它不是一个 URL。 */
export type Stage =
  /** 默认：一张图（地图 + 十站态势）。没有人选中任何东西时是它。 */
  | { readonly kind: 'situation' }
  /** 选中一个站点：中舞台换成该站的四块面板。 */
  | { readonly kind: 'site'; readonly siteId: string }
  /** 选中一条预警：中舞台换成该事件的卷宗（含处置动作）。 */
  | { readonly kind: 'event'; readonly eventId: number }
  /** 本班交接：这一班还剩什么没完。 */
  | { readonly kind: 'handoff' }
  /** 模型可信度：准入的依据。 */
  | { readonly kind: 'trust' }
  /** 规则与阈值：改之前先预演。 */
  | { readonly kind: 'rules' }
  /** 链路与接口：哪一层断了。 */
  | { readonly kind: 'plumbing' }
  /** 账号、审计、推送：治理面。 */
  | { readonly kind: 'governance' }
  /** 大屏：无交互轮换。 */
  | { readonly kind: 'wall' }

export const STAGE_TITLE: Record<Stage['kind'], string> = {
  situation: '全域态势',
  site: '站点详情',
  event: '预警卷宗',
  handoff: '本班交接',
  trust: '模型可信度',
  rules: '规则与阈值',
  plumbing: '链路与接口',
  governance: '治理',
  wall: '大厅大屏',
}

/**
 * 钻取栈的一层。
 *
 * 右栏不是「详情面板」，是**一条能回去的路**：站点 › 预警 › 处置 › 审计。
 * 每一层都记得自己是怎么来的，所以任何一层都能收起，也能一路退回去。
 */
export type Crumb =
  | { readonly kind: 'site'; readonly siteId: string; readonly name: string }
  | { readonly kind: 'event'; readonly eventId: number; readonly name: string; readonly level: Level }
  | { readonly kind: 'metric'; readonly key: string; readonly name: string }
  | { readonly kind: 'layer'; readonly key: string; readonly name: string }
  | { readonly kind: 'api'; readonly key: string; readonly name: string }

/** 左栏的排序，与 `useWatchlist` 的 `WatchSort` 同源，但这里额外允许按街道分组。 */
export type RailSort = 'level' | 'depth' | 'trend' | 'rain'

export interface WorkbenchState {
  readonly stage: Stage
  /** 钻取栈。空数组表示没有在钻取，右栏显示「此刻该管什么」。 */
  readonly trail: readonly Crumb[]
  /** 左栏搜索词。**切舞台不重置**——用户刚筛好的东西不该被清掉。 */
  readonly query: string
  readonly sort: RailSort
  readonly alarmsOnly: boolean
}

export const INITIAL: WorkbenchState = {
  stage: { kind: 'situation' },
  trail: [],
  query: '',
  sort: 'level',
  alarmsOnly: false,
}

/** 这些动作都是「继续往下看」，不改变左栏状态。 */
export type Action =
  | { readonly type: 'stage'; readonly stage: Stage }
  /**
   * 「选中一个对象」= 换舞台 + 记一层，**一次 dispatch 完成**。
   *
   * 拆成 `stage` 再 `push` 两步也能跑，但那样「换舞台清空栈」的规则会先把栈清掉，
   * 于是「从这个站点到那个站」永远只剩一层——用户刚才看过的就被吃掉了。
   * 而横向换对象恰恰是最需要回退路径的时刻：值班员挨个看十个站，看到第七个
   * 想退回第五个。
   */
  | { readonly type: 'pick'; readonly stage: Stage; readonly crumb: Crumb }
  | { readonly type: 'push'; readonly crumb: Crumb }
  | { readonly type: 'popTo'; readonly index: number }
  | { readonly type: 'pop' }
  | { readonly type: 'query'; readonly query: string }
  | { readonly type: 'sort'; readonly sort: RailSort }
  | { readonly type: 'alarmsOnly'; readonly on: boolean }
  | { readonly type: 'home' }

export function reduce(state: WorkbenchState, a: Action): WorkbenchState {
  switch (a.type) {
    case 'stage':
      // 换舞台时清空钻取栈：栈记录的是「在某个舞台上怎么钻下去的」，
      // 换了舞台还留着旧路径，用户看到的层级关系就是假的。
      return { ...state, stage: a.stage, trail: [] }

    case 'pick': {
      // 换的是**同一类对象**（站点→站点）时保留栈：那是一次横向移动，不是换了场景。
      // 换了类的（态势→站点、站点→预警）才清栈——层次关系已经不同了。
      const keep = state.stage.kind === a.stage.kind
      const base = keep ? state.trail : []
      const last = base[base.length - 1]
      // 同一对象不重复入栈：连点两下同一个站不该出现两层一样的。
      if (last && sameCrumb(last, a.crumb)) return { ...state, stage: a.stage }
      // 栈里已经有的对象：截断到它，而不是再压一层。这样「回到之前看过的」是后退不是重复。
      const at = base.findIndex((c) => sameCrumb(c, a.crumb))
      const trail = at >= 0 ? base.slice(0, at + 1) : [...base, a.crumb]
      return { ...state, stage: a.stage, trail }
    }

    case 'push': {
      // 同一个对象不重复入栈（连点两下同一个站不该出现两层一样的）。
      const last = state.trail[state.trail.length - 1]
      if (last && sameCrumb(last, a.crumb)) return state
      // 栈里已经有的对象：截断到它，而不是再压一层。这样「回到之前看过的」是后退不是重复。
      const at = state.trail.findIndex((c) => sameCrumb(c, a.crumb))
      if (at >= 0) return { ...state, trail: state.trail.slice(0, at + 1) }
      return { ...state, trail: [...state.trail, a.crumb] }
    }

    case 'popTo':
      return { ...state, trail: state.trail.slice(0, Math.max(0, a.index + 1)) }

    case 'pop':
      return { ...state, trail: state.trail.slice(0, -1) }

    case 'query':
      return { ...state, query: a.query }

    case 'sort':
      return { ...state, sort: a.sort }

    case 'alarmsOnly':
      return { ...state, alarmsOnly: a.on }

    case 'home':
      return { ...INITIAL, query: state.query, sort: state.sort, alarmsOnly: state.alarmsOnly }

    default:
      return state
  }
}

function sameCrumb(a: Crumb, b: Crumb): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'site' && b.kind === 'site') return a.siteId === b.siteId
  if (a.kind === 'event' && b.kind === 'event') return a.eventId === b.eventId
  if (a.kind === 'metric' && b.kind === 'metric') return a.key === b.key
  if (a.kind === 'layer' && b.kind === 'layer') return a.key === b.key
  if (a.kind === 'api' && b.kind === 'api') return a.key === b.key
  return false
}

/**
 * 把状态映射成一个 URL。
 *
 * 不进路由（那样每次点选都触发一次导航、把 history 撑满），
 * 但**必须可分享**——值班员在群里发「你看这个站」时的链接得能打开同一个画面。
 * 用 `replaceState` 静默更新，刷新能复原，但不产生历史记录。
 */
export function encodeUrl(s: WorkbenchState): string {
  const p = new URLSearchParams()
  if (s.stage.kind !== 'situation') {
    p.set('on', s.stage.kind)
    if (s.stage.kind === 'site') p.set('site', s.stage.siteId)
    if (s.stage.kind === 'event') p.set('event', String(s.stage.eventId))
  }
  if (s.trail.length > 0) {
    p.set(
      'trail',
      s.trail
        .map((c) =>
          c.kind === 'site'
            ? `s:${c.siteId}`
            : c.kind === 'event'
              ? `e:${c.eventId}`
              : c.kind === 'metric'
                ? `m:${c.key}`
                : c.kind === 'layer'
                  ? `l:${c.key}`
                  : `a:${c.key}`,
        )
        .join(','),
    )
  }
  if (s.query) p.set('q', s.query)
  if (s.sort !== 'level') p.set('sort', s.sort)
  if (s.alarmsOnly) p.set('alarms', '1')
  const qs = p.toString()
  return qs ? `?${qs}` : ''
}

/** 从 URL 还原。认不出的部分一律退回默认值，**绝不因为一个坏参数白屏**。 */
export function decodeUrl(search: string, siteName: (id: string) => string): WorkbenchState {
  const p = new URLSearchParams(search)
  const on = p.get('on')
  let stage: Stage = { kind: 'situation' }
  if (on === 'site' && p.get('site')) stage = { kind: 'site', siteId: p.get('site') as string }
  else if (on === 'event' && p.get('event')) stage = { kind: 'event', eventId: Number(p.get('event')) }
  else if (on && ['handoff', 'trust', 'rules', 'plumbing', 'governance', 'wall'].includes(on)) {
    stage = { kind: on as 'handoff' | 'trust' | 'rules' | 'plumbing' | 'governance' | 'wall' }
  }

  const trail: Crumb[] = []
  const raw = p.get('trail')
  if (raw) {
    for (const item of raw.split(',')) {
      const [k, ...rest] = item.split(':')
      const v = rest.join(':')
      if (!v) continue
      if (k === 's') trail.push({ kind: 'site', siteId: v, name: siteName(v) })
      else if (k === 'e' && Number.isFinite(Number(v)))
        trail.push({ kind: 'event', eventId: Number(v), name: `预警 #${v}`, level: 'none' })
      else if (k === 'm') trail.push({ kind: 'metric', key: v, name: v })
      else if (k === 'l') trail.push({ kind: 'layer', key: v, name: v })
      else if (k === 'a') trail.push({ kind: 'api', key: v, name: v })
    }
  }

  const sortRaw = p.get('sort')
  const sort: RailSort = ['level', 'depth', 'trend', 'rain'].includes(sortRaw ?? '')
    ? (sortRaw as RailSort)
    : 'level'

  return {
    stage,
    trail,
    query: p.get('q') ?? '',
    sort,
    alarmsOnly: p.get('alarms') === '1',
  }
}
