import type { EvalPoint, Point, Prediction, Snapshot, Station } from './types.ts'

const START = Date.UTC(2026, 6, 18, 2) // milliseconds, as consumed by Intl.DateTimeFormat in Charts.tsx
const STEP = 300_000 // five minutes in milliseconds
const HISTORY_STEPS = 72 // 73 observed points covering the past six hours
const FORECAST_STEPS = 144 // 145 forecast points covering the next twelve hours
const EVAL_INTERVAL_STEPS = 6 // 30 minutes between evaluation points
const EVAL_COUNT = 25 // twelve hours, inclusive of both endpoints
const HOUR_STEPS = 12 // one hour = twelve five-minute steps

// Geographic reference points in Huangyan; depths and rain are simulated, not gauge observations.
const SITES = [
  ['HY01', '永宁江·西江桥', 121.245, 28.65],
  ['HY02', '东城·九峰路', 121.274, 28.645],
  ['HY03', '西城·世纪大道', 121.239, 28.649],
  ['HY04', '南城·十里铺', 121.257, 28.603],
  ['HY05', '北城·长塘', 121.262, 28.687],
  ['HY06', '新前·新前路', 121.205, 28.678],
  ['HY07', '澄江·桥头王', 121.195, 28.645],
  ['HY08', '江口·江口街', 121.306, 28.684],
  ['HY09', '院桥·院桥街', 121.287, 28.555],
  ['HY10', '宁溪·宁川路', 120.995, 28.603],
] as const

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const round = (n: number) => Math.round(n * 10000) / 10000

/** Deterministic 32-bit hash; no Math.random, so SSR and deepEqual are reproducible. */
function hash(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Pseudorandom showers: each episode has an intensity drawn from a deterministic hash
 * of (episode, station), rises over a few steps, then decays. Dry intervals stay near zero. */
function rainAt(step: number, index: number): number {
  const episode = Math.floor(step / 21)
  const local = step - episode * 21
  const intensity = 42 + 38 * hash(episode, index + 7)
  const shape = local <= 3 ? (local + 1) / 4 : Math.exp(-(local - 3) / 6.5)
  const pulse = intensity * shape * (0.7 + 0.45 * hash(episode, index + 101))
  const base = 3 + 2 * Math.sin(step * 0.13 + index * 0.9) + 1.5 * Math.sin(step * 0.047 + index * 2.1)
  return round(clamp(base + pulse, 0, 95))
}

/** Explicit storm hydrograph: depth peaks ~25min after the rain peak, then recedes
 * over ~1h40m. Summing episodes gives a clear rise-and-fall driven by rainfall. */
function runoffPeak(step: number, index: number): number {
  const phase = step / HOUR_STEPS
  let total = 0
  for (let ep = Math.floor(phase) - 3; ep <= Math.floor(phase) + 1; ep++) {
    const age = phase - ep - 0.4
    if (age <= 0) continue
    const amplitude = 0.21 + 0.11 * hash(ep, index + 211)
    total += amplitude * (age / 0.42) * Math.exp(1 - age / 0.42)
  }
  return total
}

const baselineDepth = (index: number) => 0.15 + index * 0.009

function observationAtStep(step: number, index: number): Point {
  const phase = index * 0.61
  const wave = 0.06 * Math.sin(step * 0.085 + phase)
    + 0.035 * Math.sin(step * 0.031 + phase * 1.7)
    + 0.02 * Math.sin(step * 0.21 + phase * 0.8)
  const rain = rainAt(step, index)
  const depth = clamp(baselineDepth(index) + wave + runoffPeak(step, index), 0.08, 0.87)
  return { at: START + step * STEP, depth: round(depth), rain }
}

/** Damped extrapolation of the current observation, capped at +0.5 / -0.2 m per hour. */
function forecastFrom(originStep: number, index: number): Prediction[] {
  const current = observationAtStep(originStep, index)
  const oneHourAgo = observationAtStep(originStep - HOUR_STEPS, index)
  const trend = clamp(current.depth - oneHourAgo.depth, -0.2, 0.5) // observed m/h
  const baseline = baselineDepth(index)
  // Extrapolate half the recent trend; half of a large storm signal is deliberately
  // left as forecast error, which is what the evaluation chart compares.
  const slope = trend * 0.5
  const result: Prediction[] = []

  for (let h = 0; h <= FORECAST_STEPS; h++) {
    const hours = h / HOUR_STEPS
    let depth: number
    if (h === 0) {
      depth = current.depth
    } else {
      const naive = current.depth + slope * hours * Math.exp(-hours / 2.5)
      const pull = 1 - Math.exp(-hours / 5)
      const target = baseline + (naive - baseline) * (1 - pull)
      // Enforce per-step rate limits without letting the clamp accumulate rounding error.
      const limited = clamp(target,
        current.depth - 0.2 * hours,
        current.depth + 0.5 * hours)
      depth = clamp(limited, 0.08, 0.92)
    }
    const halfWidth = 0.012 + 0.166 * Math.pow(hours / 12, 0.85)
    result.push({
      at: current.at + h * STEP,
      depth: round(depth),
      lower: round(Math.max(0.01, depth - halfWidth)),
      upper: round(depth + halfWidth),
    })
  }
  return result
}

/** One-hour-ahead forecasts issued every 30 minutes, checked against the later observation. */
function evaluationAt(step: number): EvalPoint[] {
  const index = 0
  return Array.from({ length: EVAL_COUNT }, (_, k) => {
    const atStep = step - 144 + k * EVAL_INTERVAL_STEPS
    const actual = observationAtStep(atStep, index)
    const predicted = forecastFrom(atStep - HOUR_STEPS, index)[HOUR_STEPS].depth
    return { at: actual.at, predicted, actual: actual.depth }
  })
}

export function createDemoSnapshot(step: number): Snapshot {
  const s = Number.isFinite(step) ? Math.trunc(step) : 0
  const now = START + s * STEP
  const stations: Station[] = SITES.map(([id, name, lon, lat], index) => {
    const history = Array.from({ length: HISTORY_STEPS + 1 }, (_, n) => observationAtStep(s - HISTORY_STEPS + n, index))
    const current = history[HISTORY_STEPS]
    return {
      id, name, lon, lat, district: '黄岩区', baseLevel: 0,
      thresholds: { blue: 0.2, yellow: 0.35, orange: 0.5, red: 0.65 },
      history,
      forecast: forecastFrom(s, index),
      actual: current.depth,
      rain: current.rain,
    }
  })
  return {
    now,
    issuedAt: now,
    source: 'demo',
    model: '演示·降雨响应阻尼外推',
    stations,
    evaluation: evaluationAt(s),
    evaluationSiteId: 'HY01',
    evaluationHorizonMin: 60,
  }
}
