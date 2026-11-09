import { createContext, useContext } from 'react'
import type { Level } from '../domain'


/**
 * 大屏配色 —— 演播室版。
 *
 * 三层各自的亮度是刻意拉开的：背景最深（#03101A），地图平面最亮（米绿/浅蓝），
 * 面板用纯白。这样即便都放在同一屏上，眼睛也能立刻分出「远 / 中 / 近」。
 * 不用主应用的 --* 令牌：主应用是白底文档，处置状态色为了过 AA 压成 ink 深色，
 * 搬到这种对比度很高的大屏上会糊成一块。
 *
 * 冷蓝科技盘（浅色）。
 *
 * 为什么换掉上一版：上一版是「纯白卡片 + 冷青强调」的科技盘，实测**白色区太多**——
 * 一屏十来块纯白面板连成一片，眼睛找不到边界，而且冷白 + 中性灰看着像后台管理系统。
 *
 * 这一版按旧气象图来：纸基是暖米色（不是白），墨是暖褐（不是黑），
 * 强调色是旧图纸上的砖红与灰蓝，再叠一层印刷颗粒与四角做旧。
 * 三条硬约束保持不变：不许有暗区、正文对比度 4.5:1、颜色只承载含义不承载装饰。
 */
export type BoardTheme = 'light' | 'dark'

export interface Palette {
  theme: BoardTheme
  bg1: string
  bg2: string
  grid: string
  panel: string
  panelBorder: string
  panelLine: string
  /** 四级浮起高度（buildui dimensional-layering）：1=贴地 2=常规卡 3=当前焦点 4=浮层 */
  elev: readonly [string, string, string, string]
  text: string
  textDim: string
  textFaint: string
  accent: string
  accent2: string
  level: Record<Level, string>
  /** 白底上的同色系深色文字（#DC2626 做正文只有 4.0:1，黄橙更低） */
  levelInk: Record<Level, string>
  levelSoft: Record<Level, string>
  rain: string
  forecast: string
  observed: string
}

export const PALETTE: Palette = {
  theme: 'light',
  bg1: '#E8F0F8',
  bg2: '#CFE1F0',
  grid: 'rgba(11,37,69,0.045)',
  // 实色白，不做半透明：底图是真实路网瓦片，地名与路名有深色笔画，
  // 卡片透明时这些笔画会透到正文下面，读数字时要跟地图抢注意力（实测踩过）。
  // 通透感改由「卡片之间的空隙露出地图」来提供，而不是「卡片本身透」。
  panel: '#F4F8FD',
  panelBorder: 'rgba(60,110,160,0.24)',
  panelLine: 'rgba(30,80,130,0.13)',
  // 四级阴影全部带 -12~-18px 的扩散偏移，而不是均匀发虚：
  // 均匀模糊会让白卡「浮」不起来，只有「近处硬、远处散」才读得出高度差。
  elev: [
    '0 1px 2px rgba(8,40,60,0.07), 0 0 0 1px rgba(12,60,90,0.05)',
    '0 1px 3px rgba(8,40,60,0.09), 0 8px 18px -6px rgba(8,40,60,0.13), 0 0 0 1px rgba(12,60,90,0.06)',
    '0 2px 6px rgba(8,40,60,0.11), 0 18px 40px -12px rgba(8,40,60,0.24), 0 0 0 1px rgba(12,60,90,0.07)',
    '0 4px 12px rgba(8,40,60,0.13), 0 34px 66px -18px rgba(8,40,60,0.32), 0 0 0 1px rgba(12,60,90,0.08)',
  ] as const,
  text: '#0B2545',
  textDim: '#41608A',
  textFaint: '#5C7A96',
  accent: '#1565C0',
  accent2: '#0097A7',
  level: {
    none: '#8296A8',
    blue: '#1E88E5',
    yellow: '#C08A00',
    orange: '#EF6C00',
    red: '#D93B3B',
  },
  levelInk: {
    none: '#556A7D',
    blue: '#0D5FA8',
    yellow: '#8A6100',
    orange: '#A64A00',
    red: '#B32424',
  },
  levelSoft: {
    none: 'rgba(132,151,166,0.16)',
    blue: 'rgba(30,136,229,0.14)',
    yellow: 'rgba(192,138,0,0.18)',
    orange: 'rgba(239,108,0,0.15)',
    red: 'rgba(217,59,59,0.14)',
  },
  rain: '#1E88C7',
  forecast: '#5E35B1',
  observed: '#0B2545',
}

export const PALETTES: Record<BoardTheme, Palette> = { light: PALETTE, dark: PALETTE }

export const PaletteCtx = createContext<Palette>(PALETTE)

export function usePalette(): Palette {
  return useContext(PaletteCtx)
}

export function isBoardTheme(v: string | null): v is BoardTheme {
  return v === 'light' || v === 'dark'
}
