/** ECharts / canvas / SVG 读不到 CSS 变量，这里放一份 hex 副本。
 *  改色必须先改 tokens.css，再同步本文件——两处不一致会导致图表和 UI 撞色。 */

export const T = {
  bgCanvas: '#F2F7FC',
  surface: '#ffffff',
  border1: '#DCE7F2',
  border2: '#EAF1F8',
  borderStrong: '#C3D4E4',
  text1: '#0B2545',
  text2: '#4D7191',
  text3: '#5C6F7F',

  primary: '#0E7490',
  ai: '#5B21B6',
  aiInk: '#4C1D95',
  aiWeak: '#F1EAFB',

  level: {
    none: '#8497A6',
    blue: '#0284C7',
    yellow: '#C08A00',
    orange: '#ea580c',
    red: '#dc2626',
  } as Record<string, string>,

  levelInk: {
    none: '#5C7080',
    blue: '#0273AE',
    yellow: '#8E6600',
    orange: '#BD470A',
    red: '#D22222',
  } as Record<string, string>,

  levelWeak: {
    none: '#EDF2F6',
    blue: '#E7F3FB',
    yellow: '#FBF3E0',
    orange: '#FCEDE4',
    red: '#FCE9E9',
  } as Record<string, string>,

  /** 卡片/气泡的渐变底（与 tokens.css 的 --grad-* 对应，供 inline style 使用） */
  levelGrad: {
    none: 'linear-gradient(135deg, #EDF2F6 0%, #F7FAFC 78%)',
    blue: 'linear-gradient(135deg, #E7F3FB 0%, #F5FAFE 78%)',
    yellow: 'linear-gradient(135deg, #FBF3E0 0%, #FEFBF3 78%)',
    orange: 'linear-gradient(135deg, #FCEDE4 0%, #FEF8F4 78%)',
    red: 'linear-gradient(135deg, #FCE9E9 0%, #FEF6F6 78%)',
  } as Record<string, string>,

  /** 更浅一档的实色，用于地图填充与图表柱体 */
  levelSoft: {
    none: '#DCE5EC',
    blue: '#8EC4E4',
    yellow: '#E3C169',
    orange: '#F2A379',
    red: '#EFA1A1',
  } as Record<string, string>,

  /* 抽象底图配色：比中性层偏冷偏蓝，让站点气泡能"跳"出来 */
  mapGrid: '#E3EBF4',
  mapRoad: '#D8E3EF',
  mapRiver: '#BBD9EE',
  mapPark: '#DFEBDA',
  mapWater: '#A9CFE9',

  fcLine: '#6D28D9',
  fcBand: '#67e8f9',
  obsLine: '#0B2545',
  corrLine: '#B45309',
  rainBar: '#7FBEE4',
  success: '#15803D',
  danger: '#D22222',
} as const

/** 多序列图表配色：按固定顺序取，保证同一模型在各页同色 */
export const SERIES: Record<string, string> = {
  persistence: '#8FA3B5',
  linear: '#B45309',
  gbr: '#0E7490',
  blend: '#6D28D9',
}

export const FONT =
  "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif"
