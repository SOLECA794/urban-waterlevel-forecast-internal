import type { EvalPoint, Point, Prediction, Snapshot, Station } from './types.ts'

const START = Date.UTC(2026, 6, 18, 2) // milliseconds, as consumed by Intl.DateTimeFormat in Charts.tsx
const STEP = 300_000 // five minutes in milliseconds
const HISTORY_STEPS = 72 // 73 observed points covering the past six hours
const FORECAST_STEPS = 144 // 145 forecast points covering the next twelve hours
const EVAL_INTERVAL_STEPS = 6 // 30 minutes between evaluation points
const EVAL_COUNT = 25 // twelve hours, inclusive of both endpoints
const HOUR_STEPS = 12 // one hour = twelve five-minute steps
const STATION_STAGGER = 3 // steps of phase offset per station, so gauges never move in lockstep

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

/** Rain episode for a gauge, shifted by a station-specific phase so the ten
 * gauges never share the same storm timing. Each episode rises in a few steps
 * then decays; intensity and shape come from deterministic hashes. */
function rainPulse(localStep: number, index: number): number {
  const episode = Math.floor(localStep / 21)
  const local = localStep - episode * 21
  const intensity = 45 + 65 * hash(episode, index + 7)
  const peak = 2 + Math.floor(2 * hash(episode, index + 53))
  const tail = 4 + 4 * hash(episode, index + 71)
  const shape = local <= peak ? (local + 1) / (peak + 1) : Math.exp(-(local - peak) / tail)
  return intensity * shape * (0.75 + 0.45 * hash(episode, index + 101))
}

function rainAt(step: number, index: number): number {
  const localStep = step + index * STATION_STAGGER
  const base = 3 + 3 * Math.sin(step * 0.19 + index * 0.9) + 2 * Math.sin(step * 0.071 + index * 2.1)
  return round(clamp(base + rainPulse(localStep, index), 0, 120))
}

/** Explicit storm hydrograph: depth peaks ~25min after the rain peak, then recedes
 * over ~1h40m. Summing episodes gives a clear rise-and-fall driven by rainfall. */
function runoffPeak(step: number, index: number): number {
  const phase = (step + index * STATION_STAGGER) / HOUR_STEPS
  let total = 0
  for (let ep = Math.floor(phase) - 3; ep <= Math.floor(phase) + 1; ep++) {
    const age = phase - ep - 0.4
    if (age <= 0) continue
    const amplitude = 0.21 + 0.11 * hash(ep, index + 211)
    total += amplitude * (age / 0.42) * Math.exp(1 - age / 0.42)
  }
  return total
}

const baselineDepth = (index: number) => 0.08 + index * 0.045

function observationAtStep(step: number, index: number): Point {
  const phase = index * 0.61
  // Multiple frequencies, including a fast term so numbers visibly move every tick.
  const wave = 0.08 * Math.sin(step * 0.13 + phase)
    + 0.045 * Math.sin(step * 0.047 + phase * 1.7)
    + 0.025 * Math.sin(step * 0.31 + phase * 0.8)
    + 0.04 * Math.sin(step * 0.68 + phase * 1.3)
    + 0.035 * Math.sin(index * 1.37 + 0.6)
  const rain = rainAt(step, index)
  // A modest direct rain coupling makes depth respond promptly to each shower.
  const depth = clamp(baselineDepth(index) + wave + runoffPeak(step, index) + 0.0008 * rain, 0.08, 0.87)
  return { at: START + step * STEP, depth: round(depth), rain }
}

/** Damped extrapolation: recent trend is projected with a slow exponential decay
 * toward the baseline, plus deterministic future rainfall pulses and a per-station
 * seasonal wave (both phase-shifted per gauge). Rate limits: +0.5 m/h rise,
 * -0.2 m/h recession, measured relative to the origin so rounding cannot accumulate. */
function forecastFrom(originStep: number, index: number, forEvaluation = false): Prediction[] {
  const current = observationAtStep(originStep, index)
  const oneHourAgo = observationAtStep(originStep - HOUR_STEPS, index)
  const trend = clamp(current.depth - oneHourAgo.depth, -0.2, 0.5) // observed m/h
  const baseline = baselineDepth(index)
  // Half the recent trend is carry-over momentum; the rest is left as forecast error.
  const slope = trend * 0.5
  const result: Prediction[] = []

  for (let h = 0; h <= FORECAST_STEPS; h++) {
    const hours = h / HOUR_STEPS
    let depth: number
    if (h === 0) {
      depth = current.depth
    } else {
      const futureStep = originStep + h
      // Upcoming rain contributes a lagged runoff response, damped toward the baseline.
      const upcoming = (
        rainPulse(futureStep + index * STATION_STAGGER - 4, index)
        + rainPulse(futureStep + index * STATION_STAGGER - 8, index)
      ) / 2
      const rainEffect = 0.0018 * upcoming * (1 - Math.exp(-hours / 4))
      // Per-station seasonal wave: smooth, deterministic trend reversals give the
      // 3/6/12h horizons distinct levels; each station gets its own phase.
      const fullSeasonal = 0.15 * Math.sin(hours * 1.15 + 0.7 + index * 0.9)
        + 0.09 * Math.sin(hours * 0.5 + index * 1.7)
      // The evaluation forecast (issued 1h ahead) omits this beyond-horizon term,
      // keeping skill-score errors small but non-zero.
      const seasonalRamp = forEvaluation ? 0 : fullSeasonal * clamp((hours - 1) / 1.5, 0, 1)
      const naive = current.depth + slope * hours * Math.exp(-hours / 6) + rainEffect + seasonalRamp
      const pull = 1 - Math.exp(-hours / 12)
      const target = baseline + (naive - baseline) * (1 - pull)
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
    const predicted = forecastFrom(atStep - HOUR_STEPS, index, true)[HOUR_STEPS].depth
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
