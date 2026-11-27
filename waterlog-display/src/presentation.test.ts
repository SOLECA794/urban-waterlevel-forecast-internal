import test from 'node:test'
import assert from 'node:assert/strict'
import { pageFromSearch, nextPage, rotationDelay } from './presentation.ts'

test('only two display pages exist; invalid query returns overview', () => {
  assert.equal(pageFromSearch('?page=1'), 0)
  assert.equal(pageFromSearch('?page=2'), 1)
  assert.equal(pageFromSearch('?page=9'), 0)
  assert.equal(pageFromSearch(''), 0)
})
test('rotation alternates two pages and defaults to three seconds', () => {
  assert.equal(nextPage(0), 1)
  assert.equal(nextPage(1), 0)
  assert.equal(rotationDelay(''), 3000)
  assert.equal(rotationDelay('?interval=8'), 8000)
  assert.equal(rotationDelay('?interval=-1'), 3000)
  assert.equal(rotationDelay('?interval=999999'), 60000)
})
