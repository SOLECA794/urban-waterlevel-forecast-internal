export type Level = 'none' | 'blue' | 'yellow' | 'orange' | 'red'
export interface Point { at: number; depth: number; rain: number }
export interface Prediction { at: number; depth: number; lower: number; upper: number }
export interface Station {
  id: string; name: string; district: string; lon: number; lat: number; baseLevel: number
  thresholds: { blue: number; yellow: number; orange: number; red: number }
  history: Point[]; forecast: Prediction[]; actual: number; rain: number
}
export interface EvalPoint { at: number; predicted: number; actual: number }
export interface Snapshot {
  now: number; issuedAt: number; source: 'demo' | 'api'; model: string
  stations: Station[]; evaluation: EvalPoint[]; evaluationSiteId: string; evaluationHorizonMin: number
}
export const LEVEL_COLORS: Record<Level, string> = { none: '#2c9281', blue: '#307bd0', yellow: '#bd8a13', orange: '#df7531', red: '#cc4c50' }
export const LEVEL_NAMES: Record<Level, string> = { none: '正常', blue: '蓝色', yellow: '黄色', orange: '橙色', red: '红色' }
