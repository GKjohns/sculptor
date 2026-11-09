/**
 * The replay's bookkeeping: when log entries land on the virtual clock and which pass they belong to.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { passAt, passStarts, strikeEnds } from '../shared/agent/replay.ts'
import type { Strike } from '../shared/sculpt/types.ts'

const cut = (ms: number): Strike => ({ kind: 'cut', tool: 'point', at: [0, 50, 30], dir: [0, 0, -1], size: 3, depth: 1, seed: 1, ms })
const saw = (ms: number): Strike => ({ kind: 'saw', plane: { point: [0, 90, 0], normal: [0, 1, 0] }, ms })
const DETACH: Strike = { kind: 'detach' }
const FORM: Strike = { kind: 'form', name: 'a', shapes: [], blend: 0 }

test('entries land at the end of their duration; forms and detaches take no time', () => {
  const ends = strikeEnds([FORM, saw(1500), DETACH, cut(200), cut(300), DETACH])
  assert.deepEqual([...ends], [0, 1500, 1500, 1700, 2000, 2000])
  assert.equal(strikeEnds([]).length, 0)
})

test('a charcoal line takes its time on screen like a cut does', () => {
  const sketch: Strike = { kind: 'sketch', view: 'front', points: [[0, 10], [0, 40]], strokes: [[[0, 10, 30], [0, 40, 30]]], ms: 1800 }
  assert.deepEqual([...strikeEnds([sketch, FORM, cut(200)])], [1800, 1800, 2000])
})

test('pass starts add up to the log or are refused', () => {
  const passes = [{ strikes: 2 }, { strikes: 1 }, { strikes: 0 }, { strikes: 3 }]
  assert.deepEqual(passStarts(passes, 6), [0, 2, 3, 3])
  assert.equal(passStarts(passes, 7), null)
  assert.equal(passStarts(passes, 5), null)
  assert.deepEqual(passStarts([], 0), [])
})

test('an entry belongs to the last pass that starts at or before it', () => {
  const starts = passStarts([{ strikes: 2 }, { strikes: 1 }, { strikes: 0 }, { strikes: 3 }], 6)!
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(i => passAt(starts, i)), [0, 0, 1, 3, 3, 3])
  assert.equal(passAt([], 0), -1)
})
