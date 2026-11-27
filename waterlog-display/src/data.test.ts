import test from 'node:test'
import assert from 'node:assert/strict'
import { createDemoSnapshot } from './data.ts'

const STEP = 300_000
const HOUR = 3_600_000
const finite = (n: number) => Number.isFinite(n)
const atDepthSpan = (a: number[]) => Math.max(...a) - Math.min(...a)

test('demo is deterministic, rolling in 5 minute steps with six hours of actual observations', () => {
  const a = createDemoSnapshot(0)
  const b = createDemoSnapshot(1)
  assert.deepEqual(a, createDemoSnapshot(0))
  assert.equal(a.now, a.issuedAt)
  assert.equal(b.now - a.now, STEP)
  assert.equal(a.source, 'demo')
  assert.equal(a.model, '演示·降雨响应阻尼外推')
  assert.equal(a.stations.length, 10)
  assert.equal(new Set(a.stations.map(s => s.id)).size, 10)
  a.stations.forEach((s, i) => {
    assert.ok(s.lon > 120.7 && s.lon < 121.4 && s.lat > 28.3 && s.lat < 28.8)
    assert.equal(s.history.length, 73)
    assert.equal(s.history.at(-1)?.at, a.now)
    assert.equal(s.history[0].at, a.now - 6 * HOUR)
    assert.equal(s.actual, s.history.at(-1)?.depth)
    assert.equal(s.rain, s.history.at(-1)?.rain)
    // Window scroll: each observation is keyed by absolute timestamp, so the
    // overlapping 72 points are identical objects in the next step's window.
    assert.deepEqual(s.history.slice(1).map(p => p.at), b.stations[i].history.slice(0, -1).map(p => p.at))
    assert.deepEqual(s.history[1], b.stations[i].history[0])
    const depths = s.history.map(p => p.depth)
    assert.ok(atDepthSpan(depths) > 0.05)
    assert.ok(depths.every(d => d >= 0.05 && d <= 0.9))
  })
})

test('forecast spans 12 hours with valid, widening confidence bands and damped growth', () => {
  const snap = createDemoSnapshot(3)
  snap.stations.forEach(s => {
    assert.equal(s.forecast.length, 145)
    assert.equal(s.forecast[0].at, snap.now)
    assert.equal(s.forecast[144].at, snap.now + 12 * HOUR)
    assert.equal(s.forecast[0].depth, s.actual)
    s.forecast.forEach((p, h) => {
      assert.equal(p.at, snap.now + h * STEP)
      assert.ok(finite(p.at) && finite(p.depth) && finite(p.lower) && finite(p.upper))
      assert.ok(p.lower < p.depth && p.depth < p.upper, `${s.id} h=${h}: ${p.lower}<${p.depth}<${p.upper}`)
      assert.ok(p.depth >= 0.05 && p.depth <= 0.95)
    })
    // No absurd one-hour jumps: rate limits are +0.5 m/h and -0.2 m/h.
    for (let h = 0; h < s.forecast.length; h++) {
      const delta = s.forecast[h].depth - s.forecast[0].depth
      assert.ok(delta <= 0.5 * h / 12 + 1e-4 && delta >= -0.2 * h / 12 - 1e-4)
    }
    const band = (p: typeof s.forecast[number]) => p.upper - p.lower
    const widths = [1, 3, 6, 12].map(hours => band(s.forecast[hours * 12]))
    assert.ok(widths[0] < widths[1] && widths[1] < widths[2] && widths[2] < widths[3], `band widths ${widths}`)
    assert.ok(widths[0] >= 0.04, `one hour band should be visible, got ${widths[0]}`)
    assert.ok(widths[3] >= 0.3, `twelve hour band should be wide, got ${widths[3]}`)
  })
})

test('key forecast horizons (1/3/6/12h) are present and distinguishable', () => {
  const s = createDemoSnapshot(7).stations[0]
  const atHours = (h: number) => s.forecast.find(p => p.at === s.forecast[0].at + h * HOUR)
  const horizons = [1, 3, 6, 12].map(h => atHours(h))
  assert.ok(horizons.every(p => p))
  const depths = horizons.map(p => p!.depth)
  assert.ok(depths.some(d => Math.abs(d - depths[0]) > 0.01))
  const widths = horizons.map(p => p!.upper - p!.lower)
  assert.ok(new Set(widths.map(w => w.toFixed(3))).size === 4, `widths should differ: ${widths}`)
})

test('evaluation compares 1h-ahead forecasts with observations over the past 12 hours', () => {
  const snap = createDemoSnapshot(9)
  assert.equal(snap.evaluation.length, 25)
  assert.equal(snap.evaluationSiteId, 'HY01')
  assert.equal(snap.evaluationHorizonMin, 60)
  assert.equal(snap.evaluation[0].at, snap.now - 12 * HOUR)
  assert.equal(snap.evaluation.at(-1)?.at, snap.now)
  snap.evaluation.forEach((p, i) => {
    assert.ok(finite(p.at) && finite(p.predicted) && finite(p.actual))
    assert.ok(p.actual >= 0.05 && p.actual <= 0.9)
    assert.ok(Math.abs(p.predicted - p.actual) < 0.35, `eval point ${i}: ${p.predicted} vs ${p.actual}`)
  })
  const errors = snap.evaluation.map(p => Math.abs(p.predicted - p.actual))
  assert.ok(Math.max(...errors) > 0.005, 'forecast errors should be visible')
  assert.ok(Math.min(...errors) < 0.04, 'forecast should be reasonably close')
  const actuals = snap.evaluation.map(p => p.actual)
  const predicted = snap.evaluation.map(p => p.predicted)
  assert.ok(atDepthSpan(actuals) > 0.1 && atDepthSpan(predicted) > 0.1)
})

test('each step visibly changes observations, rain, forecast, and evaluation', () => {
  const a = createDemoSnapshot(20)
  const b = createDemoSnapshot(21)
  assert.notDeepEqual(a, b)
  const maxDepthDelta = Math.max(...a.stations.map((s, i) => Math.abs(s.actual - b.stations[i].actual)))
  const maxRainDelta = Math.max(...a.stations.map((s, i) => Math.abs(s.rain - b.stations[i].rain)))
  // The 73-point history is a rolling window, so only the newest point changes;
  // that point must visibly move when rain pulses evolve.
  const maxHistoryDelta = Math.max(...a.stations.map((s, i) =>
    Math.abs(s.history.at(-1)!.depth - b.stations[i].history.at(-1)!.depth)))
  const maxForecastDelta = Math.max(...a.stations.map((s, i) =>
    Math.max(...s.forecast.map((p, j) => Math.abs(p.depth - b.stations[i].forecast[j].depth)))))
  const maxEvalDelta = Math.max(...a.evaluation.map((p, i) => Math.abs(p.actual - b.evaluation[i].actual)))
  assert.ok(maxDepthDelta > 0.005, `actual depth delta ${maxDepthDelta}`)
  assert.ok(maxRainDelta > 3, `rain delta ${maxRainDelta}`)
  assert.ok(maxHistoryDelta > 0.005, `history delta ${maxHistoryDelta}`)
  assert.ok(maxForecastDelta > 0.01, `forecast delta ${maxForecastDelta}`)
  assert.ok(maxEvalDelta > 0.005, `evaluation delta ${maxEvalDelta}`)
  // Multiple stations differ at the same instant.
  assert.ok(atDepthSpan(a.stations.map(s => s.actual)) > 0.03)
})

test('rain pulses drive visible rise/recession and stations cross warning thresholds', () => {
  const snaps = Array.from({ length: 48 }, (_, i) => createDemoSnapshot(i))
  const depths = snaps.map(s => s.stations[0].actual)
  const rains = snaps.map(s => s.stations[0].rain)
  assert.ok(atDepthSpan(depths) > 0.12, `depth range ${atDepthSpan(depths)}`)
  assert.ok(Math.max(...rains) >= 30, `peak rain ${Math.max(...rains)}`)
  assert.ok(Math.min(...rains) <= 10, `low rain ${Math.min(...rains)}`)
  // A wet episode is followed by a recession: not all values stay red forever.
  const levels = new Set(snaps.flatMap(s => s.stations.map(st =>
    st.actual >= 0.65 ? 'red' : st.actual >= 0.5 ? 'orange' : st.actual >= 0.35 ? 'yellow' : st.actual >= 0.2 ? 'blue' : 'none')))
  assert.ok(levels.size >= 3, `warning levels observed: ${[...levels]}`)
  assert.ok(levels.has('none') || levels.has('blue'), 'stations are not always red')
})

test('all snapshot values are finite and depths stay in a plausible range', () => {
  for (const step of [0, 1, 12, 100, 999]) {
    const snap = createDemoSnapshot(step)
    assert.ok(finite(snap.now) && finite(snap.issuedAt))
    snap.stations.forEach(s => {
      assert.ok(finite(s.lon) && finite(s.lat) && finite(s.baseLevel) && finite(s.actual) && finite(s.rain))
      assert.ok(s.actual >= 0.05 && s.actual <= 0.9)
      assert.ok(s.rain >= 0 && s.rain <= 120)
      s.history.forEach(p => {
        assert.ok(finite(p.at) && finite(p.depth) && finite(p.rain))
        assert.ok(p.depth >= 0.05 && p.depth <= 0.9)
        assert.ok(p.rain >= 0 && p.rain <= 120)
      })
      s.forecast.forEach(p => {
        assert.ok(finite(p.at) && finite(p.depth) && finite(p.lower) && finite(p.upper))
        assert.ok(p.depth >= 0.05 && p.depth <= 0.95)
      })
    })
  }
})

test('non-finite step input is normalised to a valid snapshot', () => {
  const snap = createDemoSnapshot(Number.NaN)
  assert.deepEqual(snap, createDemoSnapshot(0))
})

// ---- New coverage for the "research plotting / 10-station comparison" round ----

test('3h / 6h / 12h forecast depths differ markedly for at least 8 stations across steps', () => {
  for (const step of [0, 3, 7, 20, 50]) {
    const snap = createDemoSnapshot(step)
    let qualifying = 0
    const examples: string[] = []
    snap.stations.forEach(s => {
      const atHours = (h: number) => s.forecast[h * 12].depth
      const d3 = atHours(3)
      const d6 = atHours(6)
      const d12 = atHours(12)
      const ok = Math.abs(d3 - d6) > 0.03 && Math.abs(d6 - d12) > 0.03
      if (ok) {
        qualifying++
        if (examples.length < 2) examples.push(`${s.id}: 3h=${d3} 6h=${d6} 12h=${d12}`)
      }
    })
    assert.ok(qualifying >= 8,
      `step=${step}: only ${qualifying}/10 stations have |d3-d6|>0.03 and |d6-d12|>0.03 (${examples.join('; ')})`)
  }
})

test('10 stations show distinct forecast shapes at the same instant (not one shared curve)', () => {
  for (const step of [3, 20]) {
    const snap = createDemoSnapshot(step)
    const shapes = snap.stations.map(s => {
      const base = s.forecast[0].depth
      return [3, 6, 12].map(h => s.forecast[h * 12].depth - base).map(v => v.toFixed(3)).join('/')
    })
    assert.ok(new Set(shapes).size >= 8, `step=${step}: distinct forecast shapes ${new Set(shapes).size}/10`)
    assert.ok(atDepthSpan(snap.stations.map(s => s.actual)) > 0.1,
      `step=${step}: actual depth span ${atDepthSpan(snap.stations.map(s => s.actual))}`)
  }
})

test('adjacent ticks move water levels by > 0.02 m', () => {
  let worst = Infinity
  for (const step of [0, 3, 7, 20, 50]) {
    const a = createDemoSnapshot(step)
    const b = createDemoSnapshot(step + 1)
    const maxDelta = Math.max(...a.stations.map((s, i) => Math.abs(s.actual - b.stations[i].actual)))
    worst = Math.min(worst, maxDelta)
    assert.ok(maxDelta > 0.02, `step=${step}: max depth delta ${maxDelta}`)
  }
  assert.ok(worst > 0.02, `worst adjacent-step delta ${worst}`)
})

test('warning-level mix spans at least 3 classes and is never all red', () => {
  for (const step of [0, 3, 7, 20, 50]) {
    const levels = new Set(createDemoSnapshot(step).stations.map(st =>
      st.actual >= 0.65 ? 'red' : st.actual >= 0.5 ? 'orange' : st.actual >= 0.35 ? 'yellow' : st.actual >= 0.2 ? 'blue' : 'none'))
    assert.ok(levels.size >= 3, `step=${step}: warning levels ${[...levels]}`)
    assert.ok(!(levels.size === 1 && levels.has('red')), `step=${step}: all stations red`)
  }
})
