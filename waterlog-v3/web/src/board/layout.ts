/**
 * 大屏组件版面：默认值 + 三套预设 + 本地持久化。
 *
 * 为什么把版面从「组件内部写死高度」搬到一个独立的 layout 模块：
 * 1. 用户要求组件能自己拖、自己缩 —— 尺寸是运行期状态，不能再散落在各处 style 里；
 * 2. 预设和手工微调要能共存 —— 预设负责「一眼可用」，拖动负责「这一场活动想突出哪块」；
 * 3. 刷新不能丢 —— 大厅屏重启后版面要原样回来，所以落到 localStorage。
 *
 * 坐标是 1920×1080 画布内的绝对像素，画布整体 transform: scale() 适配实际屏幕。
 */

export const BOARD_W = 1920
export const BOARD_H = 1080

/** 顶部标题栏高度；组件不允许压到它下面。 */
export const TOP_SAFE = 58
export const MIN_W = 180
export const MIN_H = 70

export type WidgetId =
  | 'situation'
  | 'pie'
  | 'density'
  | 'alerts'
  | 'station'
  | 'compare'
  | 'forecast'
  | 'decision'
  | 'trend'
  | 'horizon'
  | 'judge'
  | 'map'
  | 'rain'
  | 'cumul'
  | 'spread'
  | 'rank'
  | 'health'
  | 'panorama'
  | 'response'
  | 'duration'
  | 'alerttrend'
  | 'lifecycle'
  | 'residual'
  | 'skillmatrix'
  | 'decisions'
  | 'districts'
  | 'quality'
  | 'latency'
  | 'delivery'
  | 'auditfeed'
  | 'versions'
  | 'zonegrid'
  | 'heatmap'
  | 'riskmap'
  | 'trendout'
  | 'confidence'
  | 'districtcmp'

export const WIDGET_IDS: readonly WidgetId[] = [
  'situation',
  'pie',
  'density',
  'alerts',
  'station',
  'compare',
  'forecast',
  'decision',
  'trend',
  'horizon',
  'judge',
  'map',
  'rain',
  'cumul',
  'spread',
  'rank',
  'health',
  'panorama',
  'response',
  'duration',
  'alerttrend',
  'lifecycle',
  'residual',
  'skillmatrix',
  'decisions',
  'districts',
  'quality',
  'latency',
  'delivery',
  'auditfeed',
  'versions',
  'zonegrid',
  'heatmap',
  'riskmap',
  'trendout',
  'confidence',
  'districtcmp',
]

export const WIDGET_TITLE: Record<WidgetId, string> = {
  situation: '此刻态势',
  pie: '预警构成',
  density: '24 小时告警密度',
  alerts: '最近告警',
  station: '观测点',
  compare: '多类别对比',
  forecast: '十站 12 小时预测',
  decision: '智能体决策',
  trend: '水位与预测',
  horizon: '多预见期预测',
  judge: '三因子研判',
  map: '全城积水分布',
  rain: '分时雨量',
  cumul: '累计雨量曲线',
  spread: '预测离散度',
  rank: '站点排行',
  health: '数据质量',
  panorama: '预报全景',
  response: '降雨-积水响应',
  duration: '超阈时长',
  alerttrend: '告警趋势',
  lifecycle: '告警生命周期',
  residual: '预测偏差分布',
  skillmatrix: '模型精度矩阵',
  decisions: '研判决策时序',
  districts: '辖区看板',
  quality: '数据质量监测',
  latency: '告警响应时延',
  delivery: '通知投递',
  auditfeed: '操作审计',
  versions: '模型版本轨迹',
  zonegrid: '辖区预测',
  heatmap: '全域水位演进',
  riskmap: '风险格局',
  trendout: '全域趋势研判',
  confidence: '预测可信度',
  districtcmp: '多区对比',
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type PresetName = 'balanced' | 'map' | 'info'

export const PRESET_LABEL: Record<PresetName, string> = {
  balanced: '均衡',
  map: '地图优先',
  info: '信息优先',
}

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })

/** 均衡：两侧标准宽度，地图留出中上部整块。 */
const BALANCED: Record<WidgetId, Rect> = {
  situation: R(12, 62, 292, 233),
  pie: R(12, 307, 292, 214),
  density: R(12, 533, 292, 116),
  alerts: R(12, 661, 292, 407),
  map: R(316, 62, 606, 452),
  rain: R(934, 62, 329, 220),
  cumul: R(934, 294, 329, 220),
  spread: R(1275, 62, 329, 220),
  alerttrend: R(1275, 294, 329, 220),
  panorama: R(316, 526, 631, 177),
  response: R(959, 526, 645, 177),
  trend: R(316, 715, 465, 353),
  horizon: R(824, 715, 350, 353),
  judge: R(1186, 715, 350, 353),
  station: R(1616, 62, 292, 183),
  compare: R(1616, 257, 292, 134),
  forecast: R(1616, 403, 292, 134),
  rank: R(1616, 549, 292, 104),
  duration: R(1616, 665, 292, 154),
  health: R(1616, 963, 292, 105),
  lifecycle: R(1616, 831, 292, 120),
  decision: R(1616, 1068, 292, 0),
  // 分析面板：归「全域研判」屏专用，坐标写在 scene.tsx 里。
  // 这里给 h=0 的备用位是**有意为之**：预设版面本来已铺满，硬塞必然重叠；
  // 而 scene.rects 会在轮播时覆盖这几个值，所以落不到这来。
  // 注意它们仍会被渲染（Widget 对非当前场景只淡出、不卸载），
  // 因此 scripts/measure-overflow.mjs 必须跳过不可见块，否则会报假溢出。
  residual: R(12, 1068, 292, 0),
  skillmatrix: R(316, 1068, 606, 0),
  decisions: R(934, 1068, 329, 0),
  districts: R(0, 0, 0, 0),
  quality: R(0, 0, 0, 0),
  latency: R(0, 0, 0, 0),
  delivery: R(0, 0, 0, 0),
  auditfeed: R(0, 0, 0, 0),
  versions: R(0, 0, 0, 0),
  zonegrid: R(0, 0, 0, 0),
  heatmap: R(0, 0, 0, 0),
  riskmap: R(0, 0, 0, 0),
  trendout: R(0, 0, 0, 0),
  confidence: R(0, 0, 0, 0),
  districtcmp: R(0, 0, 0, 0),
}

/** 地图优先：两侧收窄，中间留给底图。 */
const MAP_FIRST: Record<WidgetId, Rect> = {
  situation: R(12, 62, 250, 233),
  pie: R(12, 307, 250, 214),
  density: R(12, 533, 250, 116),
  alerts: R(12, 661, 250, 407),
  map: R(274, 62, 760, 452),
  rain: R(1046, 62, 294, 220),
  cumul: R(1046, 294, 294, 220),
  spread: R(1352, 62, 294, 220),
  alerttrend: R(1352, 294, 294, 220),
  panorama: R(274, 526, 672, 177),
  response: R(958, 526, 688, 177),
  trend: R(274, 715, 512, 353),
  horizon: R(798, 715, 418, 353),
  judge: R(1228, 715, 418, 353),
  station: R(1658, 62, 250, 183),
  compare: R(1658, 257, 250, 134),
  forecast: R(1658, 403, 250, 134),
  rank: R(1658, 549, 250, 104),
  duration: R(1658, 665, 250, 154),
  health: R(1658, 963, 250, 105),
  lifecycle: R(1658, 831, 250, 120),
  decision: R(1658, 1068, 250, 0),
  // 同 BALANCED：这几块归「全域研判」屏，坐标在 scene.tsx
  residual: R(12, 1068, 250, 0),
  skillmatrix: R(274, 1068, 760, 0),
  decisions: R(1046, 1068, 294, 0),
  districts: R(0, 0, 0, 0),
  quality: R(0, 0, 0, 0),
  latency: R(0, 0, 0, 0),
  delivery: R(0, 0, 0, 0),
  auditfeed: R(0, 0, 0, 0),
  versions: R(0, 0, 0, 0),
  zonegrid: R(0, 0, 0, 0),
  heatmap: R(0, 0, 0, 0),
  riskmap: R(0, 0, 0, 0),
  trendout: R(0, 0, 0, 0),
  confidence: R(0, 0, 0, 0),
  districtcmp: R(0, 0, 0, 0),
}

/** 信息优先：两侧加宽，底图退成背景。 */
const INFO_FIRST: Record<WidgetId, Rect> = {
  situation: R(12, 62, 360, 233),
  pie: R(12, 307, 360, 214),
  density: R(12, 533, 360, 116),
  alerts: R(12, 661, 360, 407),
  map: R(384, 62, 560, 452),
  rain: R(956, 62, 284, 220),
  cumul: R(956, 294, 284, 220),
  spread: R(1252, 62, 284, 220),
  alerttrend: R(1252, 294, 284, 220),
  panorama: R(384, 526, 564, 177),
  response: R(960, 526, 576, 177),
  trend: R(384, 715, 428, 353),
  horizon: R(824, 715, 350, 353),
  judge: R(1186, 715, 350, 353),
  station: R(1548, 62, 360, 183),
  compare: R(1548, 257, 360, 134),
  forecast: R(1548, 403, 360, 134),
  rank: R(1548, 549, 360, 104),
  duration: R(1548, 665, 360, 154),
  health: R(1548, 963, 360, 105),
  lifecycle: R(1548, 831, 360, 120),
  decision: R(1548, 1068, 360, 0),
  // 同 BALANCED：这几块归「全域研判」屏，坐标在 scene.tsx
  residual: R(12, 1068, 360, 0),
  skillmatrix: R(384, 1068, 560, 0),
  decisions: R(956, 1068, 284, 0),
  districts: R(0, 0, 0, 0),
  quality: R(0, 0, 0, 0),
  latency: R(0, 0, 0, 0),
  delivery: R(0, 0, 0, 0),
  auditfeed: R(0, 0, 0, 0),
  versions: R(0, 0, 0, 0),
  zonegrid: R(0, 0, 0, 0),
  heatmap: R(0, 0, 0, 0),
  riskmap: R(0, 0, 0, 0),
  trendout: R(0, 0, 0, 0),
  confidence: R(0, 0, 0, 0),
  districtcmp: R(0, 0, 0, 0),
}

export const PRESETS: Record<PresetName, Record<WidgetId, Rect>> = {
  balanced: BALANCED,
  map: MAP_FIRST,
  info: INFO_FIRST,
}

export interface BoardLayout {
  preset: PresetName | 'custom'
  rects: Record<WidgetId, Rect>
}

export const DEFAULT_LAYOUT: BoardLayout = { preset: 'balanced', rects: BALANCED }

const KEY = 'wl-board-layout-v3'

/** 夹到画布内：拖到屏幕外的组件找不回来，是这类编辑器最常见的坑。 */
export function clampRect(r: Rect): Rect {
  const w = Math.min(Math.max(MIN_W, r.w), BOARD_W - 8)
  const h = Math.min(Math.max(MIN_H, r.h), BOARD_H - TOP_SAFE - 8)
  const x = Math.min(Math.max(2, r.x), BOARD_W - w - 2)
  const y = Math.min(Math.max(TOP_SAFE + 4, r.y), BOARD_H - h - 2)
  return { x, y, w, h }
}

export function loadLayout(): BoardLayout {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed = JSON.parse(raw) as Partial<BoardLayout>
    if (!parsed || typeof parsed !== 'object' || !parsed.rects) return DEFAULT_LAYOUT
    const rects = { ...BALANCED }
    for (const id of WIDGET_IDS) {
      const r = parsed.rects[id]
      if (r && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h)) {
        rects[id] = clampRect(r)
      }
    }
    const preset: BoardLayout['preset'] =
      parsed.preset === 'balanced' || parsed.preset === 'map' || parsed.preset === 'info' ? parsed.preset : 'custom'
    return { preset, rects }
  } catch {
    // localStorage 可能被隐私模式禁用；版面丢失不该让整页白屏
    return DEFAULT_LAYOUT
  }
}

export function saveLayout(layout: BoardLayout) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(layout))
  } catch {
    /* 存不进去就算了，这次会话内仍然可用 */
  }
}

export function clearLayout() {
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
