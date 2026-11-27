import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TrendChart } from './Charts'
import type { Station } from './types'

const now = Date.UTC(2026, 6, 1, 2)
const hour = 3_600_000
const station: Station = {
  id: 'a', name: '测试站', district: '海淀', lon: 116.3, lat: 39.9, baseLevel: 40,
  thresholds: { blue: 0.15, yellow: 0.3, orange: 0.45, red: 0.6 }, actual: 0.2, rain: 3,
  history: Array.from({ length: 7 }, (_, i) => ({ at: now - (6-i)*hour, depth: i * 0.04, rain: i })),
  forecast: Array.from({ length: 13 }, (_, i) => ({ at: now+i*hour, depth: 0.2+i*0.02, lower: 0.15+i*0.02, upper: 0.25+i*0.02 })),
}
const markup = (component: React.ReactElement) => renderToStaticMarkup(component)

test('trend exposes six observed hours, twelve forecast hours, interval, threshold, and Shanghai time', () => {
  const html = markup(React.createElement(TrendChart, { station, now }))
  assert.match(html, /积水深度/)
  assert.match(html, /04:00/)
  assert.match(html, /22:00/)
  assert.match(html, /红色阈值/)
  assert.match(html, /置信区间/)
  assert.match(html, /观测/)
  assert.match(html, /预报/)
  assert.doesNotMatch(html, /NaN|Infinity/)
})

export { station, now, hour, markup }
