/**
 * The mesh work the studio does on pieces that have come off the block (app/studio/rubble.ts):
 * thinning a slab's mesh, cleaving it in two, and picking points for a convex collider.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boundsOf, cleave, extremes, thin, volumeOf } from '../app/studio/rubble.ts'
import type { Shell } from '../app/studio/rubble.ts'
import { createGrid } from '../shared/sculpt/grid.ts'
import { applyStrike } from '../shared/sculpt/strike.ts'

// A slab sawn off the top of a small block, as the kernel hands it over, about its own centroid.
function slab(): { shell: Shell, cm3: number } {
  const grid = createGrid({ width: 30, height: 40, depth: 24 })
  const { offcuts } = applyStrike(grid, { kind: 'saw', plane: { point: [0, 32, 0], normal: [0, 1, 0] }, ms: 1000 })
  assert.equal(offcuts.length, 1)
  const offcut = offcuts[0]!
  const positions = offcut.positions.slice()
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i]! - offcut.centroid[0]
    positions[i + 1] = positions[i + 1]! - offcut.centroid[1]
    positions[i + 2] = positions[i + 2]! - offcut.centroid[2]
  }
  return { shell: { positions, normals: offcut.normals, indices: offcut.indices }, cm3: offcut.cm3 }
}

function run(work: Generator<void, Shell>): { shell: Shell, slices: number } {
  let slices = 0
  let step = work.next()
  while (!step.done) {
    slices++
    step = work.next()
  }
  return { shell: step.value, slices }
}

const near = (a: number, b: number, share: number) => Math.abs(a - b) <= Math.abs(b) * share

test('a slab\'s mesh encloses the volume the kernel says it has', () => {
  const { shell, cm3 } = slab()
  assert.ok(near(volumeOf(shell), cm3, 0.03), `${volumeOf(shell)} against ${cm3}`)
})

test('thinning keeps the slab\'s shape and volume with far fewer triangles, a slice at a time', () => {
  const { shell, cm3 } = slab()
  const { shell: low, slices } = run(thin(shell, 1.2, 2000))
  assert.ok(slices > 3, 'the work is spread over several slices')
  assert.ok(low.indices.length < shell.indices.length / 4, `${low.indices.length / 3} triangles from ${shell.indices.length / 3}`)
  assert.ok(near(volumeOf(low), cm3, 0.08), `${volumeOf(low)} against ${cm3}`)
  const before = boundsOf(shell.positions)
  const after = boundsOf(low.positions)
  for (let a = 0; a < 3; a++) {
    assert.ok(Math.abs(before.min[a]! - after.min[a]!) < 1.2 && Math.abs(before.max[a]! - after.max[a]!) < 1.2)
  }
  for (let i = 0; i < low.normals.length; i += 3) {
    assert.ok(near(Math.hypot(low.normals[i]!, low.normals[i + 1]!, low.normals[i + 2]!), 1, 0.01))
  }
})

test('cleaving gives two closed halves that add up to the whole', () => {
  const { shell } = slab()
  const { shell: low } = run(thin(shell, 1.2))
  const whole = volumeOf(low)
  const halves = cleave(low, [0.96, 0.2, 0.2], 1.5)
  assert.ok(halves)
  const [a, b] = halves
  const va = volumeOf(a)
  const vb = volumeOf(b)
  assert.ok(va > whole * 0.25 && vb > whole * 0.25, `${va} and ${vb} of ${whole}`)
  // The cut faces close each half: without them the two would not add up.
  assert.ok(near(va + vb, whole, 0.03), `${va} + ${vb} against ${whole}`)
  // Each half stays on its own side of the plane.
  for (let i = 0; i < a.positions.length; i += 3) assert.ok(0.96 * a.positions[i]! + 0.2 * a.positions[i + 1]! + 0.2 * a.positions[i + 2]! >= 1.5 - 1e-3)
  for (let i = 0; i < b.positions.length; i += 3) assert.ok(0.96 * b.positions[i]! + 0.2 * b.positions[i + 1]! + 0.2 * b.positions[i + 2]! <= 1.5 + 1e-3)
})

test('a plane that misses the piece, or only clips a corner of it, cleaves nothing', () => {
  const { shell } = slab()
  assert.ok(cleave(shell, [1, 0, 0], 500) === null)
  // Through the last few vertices of one corner.
  const n = Math.hypot(1, 1, 1)
  assert.ok(cleave(shell, [1 / n, 1 / n, 1 / n], (15 + 4 + 12 - 0.3) / n) === null)
})

test('the collider\'s points are the slab\'s own corners', () => {
  const { shell } = slab()
  const points = extremes(shell.positions)
  assert.ok(points.length / 3 >= 8 && points.length / 3 <= 42)
  const all = boundsOf(shell.positions)
  const hull = boundsOf(points)
  for (let a = 0; a < 3; a++) {
    assert.ok(Math.abs(all.min[a]! - hull.min[a]!) < 0.5 && Math.abs(all.max[a]! - hull.max[a]!) < 0.5)
  }
})
