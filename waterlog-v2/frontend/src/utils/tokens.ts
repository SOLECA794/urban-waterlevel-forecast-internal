// 需要交给 canvas / SVG 渲染的色值（ECharts / MapLibre）无法读取 CSS 变量，
// 因此这里保留一份与 src/styles/tokens.css 同源的十六进制常量。
// 两处取值必须保持一致：改一个就要改另一个。
export const HEX = {
  primary: '#2563EB',
  primaryWeak: '#EFF6FF',
  accentAi: '#0E7490',
  text1: '#0F172A',
  text2: '#475569',
  text3: '#94A3B8',
  border1: '#E2E8F0',
  surface: '#FFFFFF',
  canvas: '#F5F7FA',
  success: '#16A34A',
  warning: '#D97706',
  danger: '#DC2626',
} as const

export const LEVEL_HEX: Record<'blue' | 'yellow' | 'orange' | 'red', string> = {
  blue: '#2563EB',
  yellow: '#D97706',
  orange: '#EA580C',
  red: '#DC2626',
}

export const LEVEL_HEX_INK: Record<'blue' | 'yellow' | 'orange' | 'red', string> = {
  blue: '#2563EB',
  yellow: '#B45309',
  orange: '#C2410C',
  red: '#DC2626',
}

/** ECharts 主题色 */
export const CHART = {
  axisLine: '#CBD5E1',
  axisLabel: '#64748B',
  splitLine: '#EAEFF5',
  tooltipBg: 'rgba(15, 23, 42, 0.92)',
  tooltipBorder: '#334155',
  tooltipText: '#F1F5F9',
  legendText: '#475569',
  rain: '#0EA5E9',
  rainSoft: 'rgba(14, 165, 233, 0.32)',
} as const

/** MapLibre / 平面示意图色值 */
export const MAP = {
  darkBg: '#0B1120',
  darkSurface: '#1E293B',
  darkBorder: '#334155',
  darkText: '#94A3B8',
  lightBg: '#F1F5F9',
  lightBorder: '#CBD5E1',
  lightBorderSoft: '#E2E8F0',
  lightText: '#475569',
  muted: '#64748B',
  accentSoft: '#93C5FD',
  primaryWeakBorder: '#BFDBFE',
  warnBg: '#FEF3C7',
  warnBorder: '#FCD34D',
  warnInk: '#92400E',
} as const
