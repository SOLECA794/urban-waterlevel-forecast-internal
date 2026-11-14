/**
 * 工作台的视觉语言。
 *
 * 刻意**不复用** `utils/tokens.ts` 的那套：那套是「十张卡片平铺」的排版假设，
 * 颜色是按「卡片底 + 等级色」组织的。这一屏的骨架是**三层纵向分区**
 * （顶部事实条 / 左侧对象栏 / 中央舞台 / 右侧钻取），需要的是
 * 「区域底色 + 一条分隔线 + 一个强调色」这种更克制的层级，
 * 卡片底色越少，越能看出哪块是主内容。混用两套会得到「一半玻璃一半硬边」。
 */

export const W = {
  /** 三个分区各自的底色，靠明度差分区，不靠边框。 */
  shell: '#EEF2F7',
  rail: '#F7F9FC',
  stage: '#FFFFFF',
  drill: '#F7F9FC',

  /** 事实条（顶部）比 shell 更深一档，它是「不属于任何分区」的全局信息。 */
  bar: '#12304A',
  barInk: '#E8F1F8',
  barInkDim: '#8FAFC7',

  line: '#DCE3EC',
  lineSoft: '#E9EEF5',
  lineStrong: '#C6D2DF',

  ink: '#0D1F33',
  ink2: '#43586E',
  ink3: '#6B7D90',
  ink4: '#93A2B2',

  accent: '#0B6E8C',
  accentSoft: '#E4F1F6',

  level: {
    none: '#8497A6',
    blue: '#0284C7',
    yellow: '#C08A00',
    orange: '#ea580c',
    red: '#dc2626',
  } as Record<string, string>,

  levelInk: {
    none: '#5C7080',
    blue: '#026E9E',
    yellow: '#8A6300',
    orange: '#B8450A',
    red: '#CC1F1F',
  } as Record<string, string>,

  levelWash: {
    none: '#EFF3F7',
    blue: '#E6F2FA',
    yellow: '#FAF3E1',
    orange: '#FBEDE5',
    red: '#FBE8E8',
  } as Record<string, string>,

  ok: '#12805C',
  warn: '#B45309',
  bad: '#C62828',

  mono: "'JetBrains Mono', 'Cascadia Mono', ui-monospace, Menlo, Consolas, monospace",
  sans: "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
} as const

/** 分区宽度。左栏与右栏是固定像素——它们的内容是列表与表单，宽度不该随窗口伸缩。 */
export const RAIL_W = 236
export const DRILL_W = 452
export const BAR_H = 54

export const ease = 'cubic-bezier(.22,.61,.36,1)'
