import type { SimTime } from './time'

/**
 * 系统健康。这一层的意义是把「服务是不是活着」变成**别的页面也能用的类型**，
 * 而不是只让系统页自己去看。
 *
 * 之前的问题：引擎挂掉时系统页显示红点，一张图照旧展示 10 个站点的警报——
 * 那些警报来自 2 小时前的缓存，值班员看不出来。
 */

export interface EngineHealth {
  readonly modelVersion: string
  readonly cycles: number
  /** 已发出但还没到结算时刻的预测条数。为 0 且 cycles 不涨就是引擎卡住了。 */
  readonly pending: number
  readonly uptimeS: number
  readonly lastTs: SimTime
}

export const UNKNOWN_ENGINE: EngineHealth = {
  modelVersion: '—',
  cycles: 0,
  pending: 0,
  uptimeS: 0,
  lastTs: 0 as SimTime,
}

export interface SystemHealth {
  readonly apiOk: boolean
  readonly service: string
  readonly engineOk: boolean
  readonly engine: EngineHealth
  /** 当前 SSE 连接数。0 说明这条浏览器链路没有在推。 */
  readonly clients: number
  readonly now: SimTime
}

/** 两段链路各自的通断，供顶栏与各页共用。 */
export interface LinkStatus {
  readonly api: 'up' | 'down'
  readonly engine: 'up' | 'down'
  readonly stream: 'up' | 'down'
}

export function linkStatus(h: SystemHealth | undefined, streamLive: boolean): LinkStatus {
  return {
    api: h?.apiOk ? 'up' : 'down',
    engine: h?.engineOk ? 'up' : 'down',
    stream: streamLive ? 'up' : 'down',
  }
}

export function allLinksUp(l: LinkStatus): boolean {
  return l.api === 'up' && l.engine === 'up' && l.stream === 'up'
}

export function uptimeText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${s}s`
}
