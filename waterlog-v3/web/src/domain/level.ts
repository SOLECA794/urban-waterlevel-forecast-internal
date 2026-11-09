/**
 * 预警等级。这是一个**枚举**，而水位是一个**数字**——
 * 之前它们叫同一类名字（`warn_level` 与 `level`）并列在同一个 DTO 里，
 * 每次读都要靠上下文判断哪个是米、哪个是档位。
 */

export type Level = 'none' | 'blue' | 'yellow' | 'orange' | 'red'

/** 真正会报警的四级（不含 none）。阈值、分档、最短持续时长都以这四级为键。 */
export const ALARM_LEVELS = ['blue', 'yellow', 'orange', 'red'] as const
export type AlarmLevel = (typeof ALARM_LEVELS)[number]

export function isAlarm(l: Level): l is AlarmLevel {
  return l !== 'none'
}

/** 从低到高。用于遍历、画刻度、校验单调性。 */
export const LEVEL_ORDER: readonly Level[] = ['none', ...ALARM_LEVELS]

export const LEVEL_RANK: Record<Level, number> = {
  none: 0,
  blue: 1,
  yellow: 2,
  orange: 3,
  red: 4,
}

export const LEVEL_LABEL: Record<Level, string> = {
  none: '无预警',
  blue: '蓝色',
  yellow: '黄色',
  orange: '橙色',
  red: '红色',
}

export const LEVEL_FULL: Record<Level, string> = {
  none: '无预警',
  blue: '蓝色预警',
  yellow: '黄色预警',
  orange: '橙色预警',
  red: '红色预警',
}

/** 阈值/分档用的短名，画在刻度尺上。 */
export const LEVEL_SHORT: Record<AlarmLevel, string> = {
  blue: '蓝',
  yellow: '黄',
  orange: '橙',
  red: '红',
}

/** 四级的业务含义，写清楚才知道"为什么蓝就够了、红意味着什么"。 */
export const LEVEL_MEANING: Record<Level, string> = {
  none: '当前与预见期内均未触及最低阈值',
  blue: '有积水但未影响通行，需持续观察',
  yellow: '积水开始影响通行，需派人巡查',
  orange: '积水明显、可能中断交通，需现场处置',
  red: '积水较深或持续超阈，需封控并上报',
}

export function maxLevel(levels: Iterable<Level>): Level {
  let out: Level = 'none'
  for (const l of levels) if (LEVEL_RANK[l] > LEVEL_RANK[out]) out = l
  return out
}

/** 取更严重的那个。 */
export function worseOf(a: Level, b: Level): Level {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b
}
