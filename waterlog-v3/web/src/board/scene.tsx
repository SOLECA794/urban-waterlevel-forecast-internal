import { createContext, useContext, type ReactNode } from 'react'
import type { Rect, WidgetId } from './layout'

/**
 * 大屏轮播场景契约。
 *
 * ## 为什么是「场景」而不是「页面」
 *
 * 大屏是投给会议室那面墙的，观众不会去点导航。它要的不是多页，而���
 * **同一块画布按节拍换一套版面**。所以场景 = 一组组件 + 这组组件各自的坐标，
 * 而不是一条新路由：
 *
 *   - 换场景 = 换坐标 + 换可见集合，不重新拉数据、不重建页面骨架；
 *   - 地图、预警等级、数据口径在所有场景里完全一致，观众不会以为在看另一套系统；
 *   - 切换用「整层淡出 → 换版面 → 淡入」两阶段。逐组件滑过去看着高级，
 *     但地图瓦片是按**最终尺寸**算好的，容器在过渡中被拉伸就会露出没铺满的边，
 *     与其做半个残缺的地图，不如一次干净的叠化。
 *
 * ## 场景边界按「数据类别」切，不按「页面」切
 *
 * 五屏各回答一个问题：
 *
 *   | 场景       | 回答的问题                     | 数据类别 |
 *   |------------|--------------------------------|----------|
 *   | 全域态势   | 此刻全城怎么样                 | 汇总     |
 *   | 站点透视   | 这个站接下来会怎样             | 纵向     |
 *   | 多站对比   | 该先管哪个站                   | 横向     |
 *   | 预警统计   | 告警在恶化还是在收尾           | 事件     |
 *   | 雨情响应   | 雨和积水之间隔了多久           | 成因     |
 *
 * 轮播一圈，观众看到的是同一座城市的五种切片，而不是五张互不相干的报表。
 * 「全域态势」是主页：组件最全、密度最高，适合值班常驻；其余四屏是把主页里
 * 被压缩到看不清的东西摊开讲。
 */

export interface SceneDef {
  /** 稳定标识，进 URL 与日志用 */
  key: string
  /** 顶栏切换器上的名字，越短越好（大屏上字号只有 11px） */
  title: string
  /** 一句话说明这屏讲什么，鼠标悬停或文档里用 */
  subtitle: string
  /** 本屏停留时长（毫秒）。主页组件最多，给的时间也最长。 */
  durationMs: number
  /** 本屏显示哪些组件；'all' 表示全部（主页） */
  widgets: 'all' | readonly WidgetId[]
  /**
   * 本屏各组件的坐标。**没列出来的组件沿用当前版面**——
   * 于是「主页的手拖版面」不会因为切到别的场景而被清掉。
   */
  rects: Partial<Record<WidgetId, Rect>>
}

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })

/**
 * 画布是 1920×1080，顶栏占 62px，所以内容的 y 从 62 起、下沿到 1080。
 * 下面的坐标都按这条安全区排，不允许压到顶栏下面。
 *
 * ## 坐标不是随手填的：每张图有自己的「天然比例」
 *
 * 大屏里的图都是 `preserveAspectRatio="none"` 的 SVG，意思是**一律拉伸填满盒子**。
 * 这对纯几何图（曲线、柱阵）无害，对**带文字的**图会出事——字会被抻高。
 * 所以版面尺寸按各图的 viewBox 反推：
 *
 *   | 图                 | viewBox  | 天然比例 | 版面给的盒子   |
 *   |--------------------|----------|----------|----------------|
 *   | 水位与预测（trend）| 720×330  | 2.18     | 940×430（2.19）|
 *   | 预报全景/累计雨量/降雨响应 | 100×30 | 3.33 | 宽扁即可，几何图不怕拉伸 |
 *   | 预警构成（pie）    | 104px 圆环 + 5 行图例 | ~120 | 704×190（横向一行）|
 *   | 站点排行（rank）   | 3 维度 × 各 3 条       | ~120 | 704×250（宽而矮）|
 *
 * 比例对不上的后果不是「丑」，是**读错**：水位曲线被抻高之后，
 * 阈值色带的上下沿不再对应真实水位，读图的人会以为水位更高。
 */
export const SCENES: SceneDef[] = [
  {
    key: 'overview',
    title: '全域态势',
    subtitle: '全部监测要素 · 值班常驻主屏',
    durationMs: 24000,
    widgets: 'all',
    rects: {},
  },
  {
    key: 'station',
    title: '站点透视',
    subtitle: '单站水位过程 · 多预见期 · 三因子研判',
    durationMs: 18000,
    widgets: ['trend', 'horizon', 'map', 'station', 'judge', 'decision'],
    rects: {
      // 940×430 ≈ 720:330，曲线不被抻
      trend: R(12, 62, 940, 430),
      horizon: R(964, 62, 460, 430),
      map: R(1436, 62, 472, 430),
      station: R(12, 504, 700, 564),
      judge: R(724, 504, 580, 564),
      decision: R(1316, 504, 592, 564),
    },
  },
  {
    key: 'compare',
    title: '多站对比',
    subtitle: '同一时刻横向比 · 谁最该先管',
    durationMs: 18000,
    widgets: ['panorama', 'rank', 'forecast', 'compare', 'spread', 'duration'],
    rects: {
      panorama: R(12, 62, 1180, 470),
      // 站点排行是「3 维度 × 各 3 条」的三列网格，给宽不給高
      rank: R(1204, 62, 704, 250),
      forecast: R(1204, 324, 704, 244),
      compare: R(12, 544, 580, 524),
      spread: R(604, 544, 580, 524),
      duration: R(1196, 544, 712, 524),
    },
  },
  {
    key: 'alerts',
    title: '预警统计',
    subtitle: '等级构成 · 触发趋势 · 未闭环清单',
    durationMs: 18000,
    widgets: ['density', 'alerttrend', 'alerts', 'pie', 'lifecycle', 'duration'],
    rects: {
      density: R(12, 62, 1180, 210),
      alerttrend: R(12, 284, 1180, 320),
      alerts: R(12, 616, 1180, 452),
      // 圆环是固定 104px，图例 5 行，给成横向一条最省地方
      pie: R(1204, 62, 704, 190),
      lifecycle: R(1204, 264, 704, 300),
      duration: R(1204, 576, 704, 492),
    },
  },
  {
    key: 'rain',
    title: '雨情响应',
    subtitle: '雨强到积水的滞后关系',
    durationMs: 18000,
    widgets: ['rain', 'cumul', 'response', 'map', 'health', 'situation'],
    rects: {
      rain: R(12, 62, 596, 288),
      cumul: R(620, 62, 596, 288),
      response: R(1228, 62, 680, 288),
      map: R(12, 362, 1176, 706),
      health: R(1200, 362, 708, 342),
      situation: R(1200, 716, 708, 352),
    },
  },
]

export interface SceneRuntime {
  /** 当前场景下标 */
  index: number
  /** 当前场景定义 */
  scene: SceneDef
  /** 当前场景可见的组件集合 */
  visible: ReadonlySet<WidgetId>
}

const SceneCtx = createContext<SceneRuntime | null>(null)

export function SceneProvider({ value, children }: { value: SceneRuntime; children: ReactNode }) {
  return <SceneCtx.Provider value={value}>{children}</SceneCtx.Provider>
}

/**
 * 在 Widget 里读当前场景。
 * 没有 Provider 时返回 null —— 组件按「全部可见」渲染，
 * 这样 Widget 可以脱离大屏单独复用（比如以后做单页嵌入）。
 */
export function useSceneRuntime(): SceneRuntime | null {
  return useContext(SceneCtx)
}
