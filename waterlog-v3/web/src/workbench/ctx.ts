import type { Level } from '../domain'
import type { Stage, Crumb, RailSort } from './model'

/**
 * 每个舞台（stage）拿到的上下文。
 *
 * 刻意做成**一个对象**而不是一堆 props：舞台有九个，每个都要「换舞台 / 往下钻 /
 * 开抽屉 / 出提示」这四件事，逐个透传会让每个舞台的签名都长成一个样，
 * 而它们真正不同的部分（这个舞台要显示什么）会被淹没在参数列表里。
 *
 * 也刻意**不给数据获取能力**：舞台自己去调 `data/queries` 的 hook。
 * 把取数收进 ctx 会让「这个舞台依赖什么数据」变得不可见，
 * 而缓存与去重是 React Query 已经在做的事，不需要我再包一层。
 */
export interface StageCtx {
  readonly state: {
    readonly stage: Stage
    readonly trail: readonly Crumb[]
  }
  /** 换舞台。会清空钻取栈——栈记录的是「在某个舞台上怎么钻下去的」。 */
  readonly goStage: (s: Stage) => void
  /**
   * 「选中一个对象」：换舞台 + 记一层，**一次做完**。
   *
   * 拆成 `goStage` 再 `push` 也能跑，但那样「换舞台清空栈」会先执行，
   * 于是横向换对象（站点→站点）永远只剩一层，用户刚看过的就被吃掉了——
   * 而挨个看十个站、看到第七个想退回第五个，正是最需要回退路径的时刻。
   */
  readonly pick: (s: Stage, c: Crumb) => void
  /** 往下钻一层，右栏会多一条。 */
  readonly push: (c: Crumb) => void
  /** 回到某一层（含）。 */
  readonly popTo: (index: number) => void
  /** 关掉最上面一层。 */
  readonly pop: () => void
  /** 回到全域态势（保留左栏筛选）。 */
  readonly home: () => void
  /** 右栏打开某个站点的钻取。 */
  readonly openSite: (siteId: string, name?: string) => void
  readonly openEvent: (eventId: number, name?: string, level?: Level) => void
  readonly openMetric: (key: string, name: string) => void
  readonly openLayer: (key: string, name: string) => void
  readonly openApi: (key: string, name: string) => void
  readonly setSort: (s: RailSort) => void
  readonly toast: (k: 'ok' | 'err' | 'info', msg: string) => void
}
