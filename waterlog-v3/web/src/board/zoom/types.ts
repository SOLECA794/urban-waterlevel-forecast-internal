import type { Palette } from '../theme'

/**
 * 九页大屏的放大件契约。
 *
 * 每个放大件在两处被渲染：
 *   - 第 1 页（总览）里以 compact 尺寸占一块（约 600×250 画布像素）；
 *   - 它自己那一页里以 full 尺寸铺满（约 1896×1000 画布像素）。
 * 尺寸差异不是「把同一张图放大」——字体、留白、能容下几行说明都要按
 * `detail` 分开给，否则总览页会因为字太大而塞不下，放大页会因为留白
 * 太多而空。**同一个数字在两页上的字号可以差三倍，但格式与口径必须一致。**
 *
 * 三条硬约束（评审逐条看）：
 * 1. 不做任何交互：不挂 onMouseEnter / onClick / Tooltip / 折叠。这块屏
 *    常年无人操作，任何「要点开才看得见」的信息在 3 秒里等于不存在。
 * 2. 动效必须跟着**数据**变（曲线末端、柱高、条长、气泡直径、数字跳），
 *    不要缓慢自转、扫光、粒子这类看不出变化的装饰。
 * 3. 文字只用 p.text / p.textDim / p.textFaint 三档颜色，字号在画布像素下
 *    不得小于 11（放大页里不放小于 14 的字）。
 *
 * `w` / `h` 是画布像素（1920×1080 坐标系），整块屏由外层 transform: scale
 * 缩放到实际屏幕，所以这里直接按画布像素排版，不要用 vw/vh。
 */
export interface ZoomProps {
  p: Palette
  /** 画布像素宽 */
  w: number
  /** 画布像素高 */
  h: number
  /** compact = 总览页里的小块；full = 自己那一页铺满 */
  detail: 'compact' | 'full'
}

/** 放大件 id 与本文件的组件一一对应，顺序即轮播顺序。 */
export const ZOOM_IDS = [
  'zmap',
  'zlines',
  'zline1',
  'zpoints',
  'zcross',
  'zacc',
  'zrank',
  'zrain',
] as const

export type ZoomId = (typeof ZOOM_IDS)[number]
