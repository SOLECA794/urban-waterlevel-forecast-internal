// 冷面板质感（科技盘）
//
// 上一版这里放的是"羊皮纸"四层：纸基 / 折痕 / 四角做旧 / 印刷颗粒。
// 现在整屏改成冷蓝科技盘，那套暖东西全部撤掉——但**质感这一层不能空着**：
// 纯色平铺的面板在 1920×1080 上会显得很薄，像没画完的线框图。
//
// 冷面板的质感来自三件事，都不需要图片：
//   ① 细网格（工程图纸 / 示波器屏幕的底纹）
//   ② 顶部一道冷光（受光面在上沿）
//   ③ 边缘一圈极淡的内描边（把面"收"住，替代厚重的阴影）

import type { CSSProperties } from 'react'

/** 24px 工程网格。alpha 给得很低（0.05 量级）——网格是底纹不是内容。 */
export function techGrid(color: string, size = 24, alpha = 0.06): CSSProperties {
  const line = `1px solid ${color}`
  return {
    backgroundImage: `linear-gradient(to right, ${line}, transparent 1px), linear-gradient(to bottom, ${line}, transparent 1px)`,
    backgroundSize: `${size}px ${size}px, ${size}px ${size}px`,
    opacity: 1,
    // 用 mask 让网格在面板中部最淡、到边缘消失，避免四边出现"格子被切断"的硬边
    WebkitMaskImage: 'radial-gradient(120% 100% at 50% 0%, #000 0%, #000 58%, transparent 100%)',
    maskImage: 'radial-gradient(120% 100% at 50% 0%, #000 0%, #000 58%, transparent 100%)',
    ['--grid-alpha' as string]: String(alpha),
  }
}

/** 网格的 data URI 版本：面板底要叠多层背景，用 data URI 才能和同色渐变并列写。 */
export function techGridUri(color: string, size = 24): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'>
    <path d='M ${size} 0 L 0 0 0 ${size}' fill='none' stroke='${color}' stroke-width='1'/>
  </svg>`
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`
}

/** 面板纸：冷白，比页底亮一档。 */
export const PANEL_TONE = '#FCFDFF'

/** 面板描边与分隔线（冷色系）。 */
export const PANEL_BORDER = 'rgba(60,110,160,0.24)'
export const PANEL_RULE = 'rgba(30,80,130,0.13)'

/** 墨：冷调深蓝，不用纯黑（纯黑在浅蓝底上会显脏）。 */
export const INK = '#0B2545'
export const INK_DIM = '#41608A'
export const INK_FAINT = '#5C7A96'

/** 强调：科技蓝 + 青。 */
export const TECH_ACCENT = '#1565C0'
export const TECH_ACCENT2 = '#0097A7'
