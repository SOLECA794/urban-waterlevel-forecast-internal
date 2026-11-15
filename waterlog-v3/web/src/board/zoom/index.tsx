import type { ZoomId, ZoomProps } from './types'
import { ZoomMap } from './Map'
import { Lines10 } from './Lines10'
import { LineOne } from './LineOne'
import { Points } from './Points'
import { Cross } from './Cross'
import { Acc } from './Acc'
import { Rank } from './Rank'
import { Rain } from './Rain'

/**
 * 八块放大图的分发口。
 *
 * 为什么用 switch 而不是 `Record<ZoomId, 组件>` 查表：
 * 查表会把八块图的 props 统一退化成一个宽泛的函数类型，
 * 于是任何一块多接一个必填参数都不会报错，等到运行期才炸。
 * switch 里每一支都是具体组件的具体签名，少传一个字段 tsc 立刻拦下。
 *
 * `detail` 决定同一块图在两种尺寸下的密度：
 *   - 第 1 页（compact）：只留最小的字和最关键的数，塞进 700×440 的格子；
 *   - 第 2~9 页（full）：铺满 1896×940，补上二级信息。
 * 两种尺寸共用一份实现，是为了让「放大页看到的东西」永远是
 * 「第 1 页那块图里本来就有的东西」，不会出现放大后多出一套新指标。
 */
export function ZoomChart(props: ZoomProps & { id: ZoomId }) {
  const { id, ...rest } = props
  switch (id) {
    case 'zmap':
      return <ZoomMap {...rest} />
    case 'zlines':
      return <Lines10 {...rest} />
    case 'zline1':
      return <LineOne {...rest} />
    case 'zpoints':
      return <Points {...rest} />
    case 'zcross':
      return <Cross {...rest} />
    case 'zacc':
      return <Acc {...rest} />
    case 'zrank':
      return <Rank {...rest} />
    case 'zrain':
      return <Rain {...rest} />
  }
}

export * from './types'
