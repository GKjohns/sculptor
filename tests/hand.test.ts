/**
 * The hand: a pass (saw, chisel, rasp, rough_out) expanded into strikes against the true
 * stone. Where the tool lands, what comes off, what is protected, and that the strike list
 * alone rebuilds the stone.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FINISH, cloneGrid, createGrid, hashGrid, stoneVolumeCm3, takeDirty } from '../shared/sculpt/grid.ts'
import { DETACH_EVERY_MS, chisel, drill, polish, rasp, roughOut, saw, silhouetteForm, sketch, standingProud } from '../shared/sculpt/hand.ts'
import { detachIslands } from '../shared/sculpt/islands.ts'
import type { ChiselPass, Discard, Mask, PassResult } from '../shared/sculpt/hand.ts'
import { raycast, sampleDistance } from '../shared/sculpt/raycast.ts'
import { createRng } from '../shared/sculpt/rng.ts'
import { formDistance } from '../shared/sculpt/shapes.ts'
import { applyStrike } from '../shared/sculpt/strike.ts'
import { nominalBiteCm3, toolSpec } from '../shared/sculpt/tools.ts'
import type { CompiledForm, Form, Grid, Strike, Vec3 } from '../shared/sculpt/types.ts'
import type { AxisView } from '../shared/sculpt/views.ts'
import { within } from './helpers.ts'

// A 20 cm cube: x and z from -10 to 10, y from 0 to 20.
const cube = () => createGrid({ width: 20, height: 20, depth: 20 })
const isStone = (grid: Grid, p: Vec3) => sampleDistance(grid, p[0], p[1], p[2]) < 0

function replay(start: Grid, strikes: Strike[]): Grid {
  const grid = cloneGrid(start)
  for (const strike of strikes) applyStrike(grid, strike)
  return grid
}

function endsWithDetach(result: PassResult): boolean {
  return result.strikes.length > 0 && result.strikes[result.strikes.length - 1]!.kind === 'detach'
}

// Which way each side of the image points in the block, per the plan's view table: `back`
// and `right` have rulers that increase to the left, and `top` has Z increasing downward.
const SIDES: Record<AxisView, Record<Discard, Vec3>> = {
  front: { left: [-1, 0, 0], right: [1, 0, 0], above: [0, 1, 0], below: [0, -1, 0] },
  back: { left: [1, 0, 0], right: [-1, 0, 0], above: [0, 1, 0], below: [0, -1, 0] },
  right: { left: [0, 0, 1], right: [0, 0, -1], above: [0, 1, 0], below: [0, -1, 0] },
  left: { left: [0, 0, -1], right: [0, 0, 1], above: [0, 1, 0], below: [0, -1, 0] },
  top: { left: [-1, 0, 0], right: [1, 0, 0], above: [0, 0, -1], below: [0, 0, 1] }
}

// Ruler axes per view: which block axis is horizontal, which vertical.
const RULERS: Record<AxisView, [number, number]> = { front: [0, 1], back: [0, 1], right: [2, 1], left: [2, 1], top: [0, 2] }

test('the saw discards the side of the line named, as seen in each axis view', () => {
  const centre: Vec3 = [0, 10, 0]
  for (const view of Object.keys(SIDES) as AxisView[]) {
    for (const discard of ['left', 'right', 'above', 'below'] as Discard[]) {
      const grid = cube()
      const away = SIDES[view][discard]
      const [hAxis, vAxis] = RULERS[view]
      // A cut line 3 cm from the centre on the side that is to go, right across the view.
      const upright = discard === 'left' || discard === 'right'
      const at = centre[upright ? hAxis : vAxis]! + 3 * away[upright ? hAxis : vAxis]!
      const from: [number, number] = upright ? [at, -50] : [-50, at]
      const to: [number, number] = upright ? [at, 50] : [50, at]
      const result = saw(grid, { view, from, to, discard })
      const label = `${view} / ${discard}`
      assert.equal(result.error, undefined, label)
      assert.deepEqual(result.strikes.map(s => s.kind), ['saw', 'detach'], label)
      const gone: Vec3 = [centre[0] + 7 * away[0], centre[1] + 7 * away[1], centre[2] + 7 * away[2]]
      const kept: Vec3 = [centre[0] - 7 * away[0], centre[1] - 7 * away[1], centre[2] - 7 * away[2]]
      assert.ok(!isStone(grid, gone), `${label}: stone at ${gone} should be gone`)
      assert.ok(isStone(grid, kept), `${label}: stone at ${kept} should remain`)
      assert.ok(isStone(grid, centre), `${label}: the centre is on the kept side`)
      // 7 of the cube's 20 cm go.
      assert.ok(within(result.removedCm3, 7 * 20 * 20, 0.02), `${label}: removed ${result.removedCm3}`)
      assert.equal(result.offcuts.length, 1, label)
      assert.ok(result.ms >= 1800 && result.ms <= 6000, `${label}: ${result.ms} ms`)
    }
  }
})

test('a slanted saw cut takes the named side whichever way the line was drawn', () => {
  const hashes: string[] = []
  for (const [from, to, discard] of [
    [[-10, 0], [10, 20], 'above'],
    [[10, 20], [-10, 0], 'above'],
    [[-10, 0], [10, 20], 'left']
  ] as [[number, number], [number, number], Discard][]) {
    const grid = cube()
    const result = saw(grid, { view: 'front', from, to, discard })
    assert.ok(!isStone(grid, [-5, 15, 0]) && isStone(grid, [5, 5, 0]), `${discard}: the upper left half goes`)
    assert.ok(within(result.removedCm3, 4000, 0.02), `removed ${result.removedCm3}`)
    // Both ends of the line are reported where they met the stone.
    assert.equal(result.hits.length, 2)
    hashes.push(hashGrid(grid))
  }
  assert.equal(hashes[0], hashes[1])
  assert.equal(hashes[0], hashes[2])
})

test('a saw pass that makes no sense is refused in words and cuts nothing', () => {
  const grid = cube()
  const before = hashGrid(grid)
  const upright = saw(grid, { view: 'front', from: [3, 0], to: [3, 20], discard: 'above' })
  assert.match(upright.error ?? '', /left or right/)
  const quarter = saw(grid, { view: 'front_left', from: [3, 0], to: [3, 20], discard: 'left' })
  assert.match(quarter.error ?? '', /front, back, left, right or top/)
  const point = saw(grid, { view: 'front', from: [3, 4], to: [3, 4], discard: 'left' })
  assert.ok(point.error)
  assert.deepEqual([upright.strikes.length, quarter.strikes.length, point.strikes.length], [0, 0, 0])
  assert.equal(hashGrid(grid), before)
  // A cut clear of the stone is carried out and says so.
  const clear = saw(grid, { view: 'front', from: [15, 0], to: [15, 20], discard: 'right' })
  assert.equal(clear.error, undefined)
  assert.equal(clear.removedCm3, 0)
  assert.match(clear.summary, /Nothing came off/)
  assert.equal(hashGrid(grid), before)
})

test('one chisel blow lands on the point reported and takes about a bite', () => {
  const grid = cube()
  const result = chisel(grid, { tool: 'flat', view: 'front', path: [[2, 12]], depth_cm: 1, width_cm: 4 })
  assert.equal(result.error, undefined)
  assert.deepEqual(result.strikes.map(s => s.kind), ['cut', 'detach'])
  // Seen from the front, [2, 12] is x = 2, y = 12 on the face at z = +10.
  const hit = result.hits[0]!.point!
  assert.ok(Math.abs(hit[0] - 2) < 1e-6 && Math.abs(hit[1] - 12) < 1e-6 && Math.abs(hit[2] - 10) < 0.1, `hit ${hit}`)
  const strike = result.strikes[0]!
  assert.ok(strike.kind === 'cut')
  assert.ok(Math.abs(strike.at[2] - 10) < 0.1)
  // Into the stone along the face normal.
  assert.ok(strike.dir[2] < -0.99, `dir ${strike.dir}`)
  assert.ok(strike.ms >= 250 && strike.ms <= 600)
  assert.ok(within(result.removedCm3, nominalBiteCm3(toolSpec('flat'), 4, 1), 0.15), `removed ${result.removedCm3}`)
  assert.match(result.summary, /x 2\.0, y 12\.0, z 10\.0/)
  // The stone really is gone there, and only there.
  assert.ok(!isStone(grid, [2, 12, 9.6]) && isStone(grid, [2, 12, 8.5]) && isStone(grid, [-6, 12, 9.6]))
})

test('a chisel stroke cuts a groove of the depth and width asked for, in layers', () => {
  const grid = cube()
  const result = chisel(grid, { tool: 'point', view: 'front', path: [[-6, 10], [6, 10]], depth_cm: 3, width_cm: 3 })
  assert.ok(result.hits.length >= 9 && result.hits.every(h => h.point !== null))
  const cuts = result.strikes.filter(s => s.kind === 'cut')
  // The point sinks 0.7 of its width a blow, so 3 cm takes two layers: two blows a point,
  // less the few where a neighbouring bite had already gone deep enough.
  assert.ok(cuts.length > 1.5 * result.hits.length && cuts.length <= 2 * result.hits.length, `${cuts.length} blows on ${result.hits.length} points`)
  assert.match(result.summary, /in 2 layers/)
  assert.ok(endsWithDetach(result))
  // Along the line the groove is about 3 cm deep; 3 cm above it the face is untouched.
  for (const x of [-4, 0, 4]) {
    const floor = raycast(grid, [x, 10, 30], [0, 0, -1])!.point[2]
    assert.ok(floor < 7.8 && floor > 6.2, `groove floor at x ${x}: z ${floor}`)
    assert.ok(raycast(grid, [x, 13, 30], [0, 0, -1])!.point[2] > 9.9)
  }
  // A trench 12 cm long and 3 wide: the second layer's blows start 1.5 cm down, so the top
  // half has straight sides and the bottom half tapers to the point. Plus its two round ends.
  const trench = 12 * (3 * 1.5 + 3 * 1.5 / 2) + Math.PI * 1.5 * 1.5 * 2
  assert.ok(within(result.removedCm3, trench, 0.25), `removed ${result.removedCm3} against a trench of ${trench}`)
  // Every blow goes in along the face normal.
  for (const s of cuts) assert.ok(s.kind === 'cut' && s.dir[2] < -0.98)
})

test('chisel bites follow the surface normal, not the view direction', () => {
  const grid = cube()
  // A 45° face: the upper left half of the cube sawn away, seen from the front.
  saw(grid, { view: 'front', from: [-10, 0], to: [10, 20], discard: 'above' })
  const result = chisel(grid, { tool: 'flat', view: 'top', path: [[0, -4], [0, 4]], depth_cm: 0.8, width_cm: 3 })
  const cuts = result.strikes.filter(s => s.kind === 'cut')
  assert.ok(cuts.length >= 3)
  const s = Math.SQRT1_2
  for (const c of cuts) {
    assert.ok(c.kind === 'cut')
    // The slope faces up and to the left: its normal is (-1, 1, 0) / √2.
    assert.ok(c.dir[0] * s - c.dir[1] * s > 0.98, `dir ${c.dir}`)
    assert.ok(Math.abs(c.at[0]) < 0.2 && Math.abs(c.at[1] - 10) < 0.3, `at ${c.at}`)
  }
})

test('a stroke that runs off the stone reports the misses and does not throw', () => {
  const grid = cube()
  const off = chisel(grid, { tool: 'claw', view: 'right', path: [[0, 10], [24, 10]], depth_cm: 0.6, width_cm: 3 })
  const missed = off.hits.filter(h => h.point === null)
  const landed = off.hits.filter(h => h.point !== null)
  assert.ok(missed.length > 0 && landed.length > 0)
  // From the right the ruler is Z: everything past z = 10 is off the block.
  for (const h of off.hits) assert.equal(h.point === null, h.ruler[0] > 10, `ruler ${h.ruler}`)
  for (const h of landed) assert.ok(Math.abs(h.point![0] - 10) < 0.1 && Math.abs(h.point![2] - h.ruler[0]) < 1e-6)
  assert.match(off.summary, /missed the stone/)
  assert.equal(off.strikes.filter(s => s.kind === 'cut').length, landed.length)

  const before = hashGrid(grid)
  const nowhere = chisel(grid, { tool: 'point', view: 'front', path: [[40, 40], [50, 50]], depth_cm: 2, width_cm: 3 })
  assert.equal(nowhere.error, undefined)
  assert.ok(nowhere.hits.length > 0 && nowhere.hits.every(h => h.point === null))
  assert.equal(nowhere.removedCm3, 0)
  assert.match(nowhere.summary, /nothing was cut/)
  assert.equal(hashGrid(grid), before)
  const air = rasp(grid, { view: 'top', path: [[40, 0], [50, 0]], width_cm: 5, passes: 2 })
  assert.ok(air.hits.every(h => h.point === null))
  assert.match(air.summary, /Nothing was smoothed/)
  assert.equal(hashGrid(grid), before)

  const bad = chisel(grid, { tool: 'point', view: 'back_left', path: [[0, 0]], depth_cm: 1, width_cm: 2 })
  assert.ok(bad.error && bad.strikes.length === 0)
})

// Heights of the front face over a patch: how uneven it is, and its highest and lowest points.
function relief(grid: Grid): { deviation: number, high: number, low: number } {
  let n = 0
  let sum = 0
  let squares = 0
  let low = Infinity
  let high = -Infinity
  for (let x = -5; x <= 5; x += 0.25) {
    for (let y = 9; y <= 11; y += 0.25) {
      const z = raycast(grid, [x, y, 30], [0, 0, -1])!.point[2]
      n++
      sum += z
      squares += z * z
      low = Math.min(low, z)
      high = Math.max(high, z)
    }
  }
  return { deviation: Math.sqrt(squares / n - (sum / n) ** 2), high, low }
}

test('the rasp takes the high spots off a roughed patch and leaves a flat face alone', () => {
  const grid = cube()
  const flat = rasp(grid, { view: 'front', path: [[-6, 4], [6, 4]], width_cm: 5, passes: 2 })
  assert.ok(flat.removedCm3 < 0.5, `a flat face lost ${flat.removedCm3}`)
  for (const y of [9, 10, 11]) chisel(grid, { tool: 'point', view: 'front', path: [[-7, y], [7, y]], depth_cm: 1, width_cm: 2 })
  const rough = relief(grid)
  const result = rasp(grid, { view: 'front', path: [[-7, 10], [7, 10]], width_cm: 6, passes: 4 })
  const smooth = relief(grid)
  assert.equal(result.error, undefined)
  assert.ok(result.removedCm3 > 3, `removed ${result.removedCm3}`)
  // Ridges come down; the floors of the pits are where they were (stone cannot be put back,
  // and the rasp does not dig).
  assert.ok(smooth.high < rough.high - 0.1, `highest point ${rough.high} → ${smooth.high}`)
  assert.ok(Math.abs(smooth.low - rough.low) < 0.05, `lowest point ${rough.low} → ${smooth.low}`)
  assert.ok(smooth.deviation < 0.9 * rough.deviation, `deviation ${rough.deviation} → ${smooth.deviation}`)
  const strokes = result.strikes.filter(s => s.kind === 'cut')
  assert.equal(strokes.length, 4 * result.hits.length)
  assert.ok(strokes.every(s => s.kind === 'cut' && s.tool === 'rasp' && s.ms > 0))
  assert.ok(endsWithDetach(result))
  assert.ok(result.hits.every(h => h.point !== null && Math.abs(h.point[1] - 10) < 1e-6))
  // Back and forth: the second pass starts where the first one ended.
  const n = result.hits.length
  assert.ok(strokes[n]!.kind === 'cut' && strokes[n - 1]!.kind === 'cut' && Math.abs(strokes[n]!.at[0] - strokes[n - 1]!.at[0]) < 0.01)
})

// The front face over a patch, read on a quarter-centimetre grid: its mean depth, its deepest
// point, and its roughness (how far each point stands from the mean of the 2 cm square
// around it, RMS).
function patch(grid: Grid): { roughness: number, mean: number, deepest: number } {
  const rows: number[][] = []
  for (let y = 9; y <= 21.01; y += 0.25) {
    const row: number[] = []
    for (let x = -6; x <= 6.01; x += 0.25) row.push(raycast(grid, [x, y, 40], [0, 0, -1])!.point[2])
    rows.push(row)
  }
  const k = 4
  let squares = 0
  let n = 0
  let sum = 0
  let deepest = Infinity
  for (let j = k; j < rows.length - k; j++) {
    for (let i = k; i < rows[0]!.length - k; i++) {
      let around = 0
      for (let b = -k; b <= k; b++) {
        for (let a = -k; a <= k; a++) around += rows[j + b]![i + a]!
      }
      const z = rows[j]![i]!
      const bump = z - around / ((2 * k + 1) * (2 * k + 1))
      squares += bump * bump
      sum += z
      deepest = Math.min(deepest, z)
      n++
    }
  }
  return { roughness: Math.sqrt(squares / n), mean: sum / n, deepest }
}

test('rasp passes take point-chisel roughing down to an even skin, a little each pass, and add nothing', () => {
  const rough = createGrid({ width: 30, height: 30, depth: 20 })
  // The front face roughed the way a rough-out leaves it: overlapping point bites about a
  // centimetre deep, unevenly placed.
  const rng = createRng(11)
  let seed = 0
  for (let y = 2; y <= 28; y += 2.5) {
    for (let x = -13; x <= 13; x += 2.5) {
      applyStrike(rough, { kind: 'cut', tool: 'point', at: [x + rng.range(-0.6, 0.6), y + rng.range(-0.6, 0.6), 10], dir: [0, 0, -1], size: 5, depth: rng.range(0.7, 1.2), seed: seed++, ms: 300 })
    }
  }
  const before = patch(rough)
  assert.ok(before.roughness > 0.12, `the roughed face is only ${before.roughness} cm rough`)

  const lines = [9, 12, 15, 18, 21]
  const after = [before]
  let five: Grid = rough
  for (const passes of [1, 2, 3, 4, 5, 6, 12]) {
    const grid = cloneGrid(rough)
    const log: Strike[] = []
    for (const y of lines) {
      const result = rasp(grid, { view: 'front', path: [[-10, y], [10, y]], width_cm: 6, passes })
      assert.equal(result.error, undefined)
      log.push(...result.strikes)
    }
    after.push(patch(grid))
    // Removal only: no sample anywhere moved back toward stone, and the volume went down.
    let gained = 0
    for (let i = 0; i < grid.dist.length; i++) {
      if (grid.dist[i]! < rough.dist[i]!) gained++
    }
    assert.equal(gained, 0, `${passes} passes put stone back at ${gained} samples`)
    assert.ok(stoneVolumeCm3(grid) < stoneVolumeCm3(rough))
    if (passes === 5) {
      five = grid
      assert.equal(hashGrid(replay(rough, log)), hashGrid(grid))
    }
  }
  const [, one, two, three, four, fiveP, six, twelve] = after
  const report = after.map(a => `${a.roughness.toFixed(3)} (${(before.mean - a.mean).toFixed(2)})`).join(', ')

  // Every pass up to six still smooths, and by five the pitting is gone.
  for (let n = 1; n <= 6; n++) assert.ok(after[n]!.roughness < after[n - 1]!.roughness, `roughness by passes: ${report}`)
  assert.ok(one!.roughness < 0.8 * before.roughness && one!.roughness > 0.4 * before.roughness, `one pass: ${report}`)
  assert.ok(two!.roughness > 0.2 * before.roughness, `two passes: ${report}`)
  assert.ok(fiveP!.roughness < 0.25 * before.roughness, `five passes: ${report}`)
  assert.ok(three!.roughness > fiveP!.roughness && four!.roughness > six!.roughness)

  // A bounded amount each pass: the face goes down by a millimetre or two a pass at first...
  for (let n = 1; n <= 6; n++) {
    const drop = after[n - 1]!.mean - after[n]!.mean
    assert.ok(drop > 0 && drop < 0.2, `pass ${n} took the face down ${drop} cm: ${report}`)
  }
  // ...to about the level of the pit floors, and no further: nothing is dug below the
  // deepest pit, and six more passes on an even face take next to nothing.
  const total = before.mean - six!.mean
  assert.ok(total > 0.2 && total < 0.8, `six passes took the face down ${total} cm`)
  assert.ok(six!.mean > before.deepest - 0.05 && six!.deepest > before.deepest - 0.05, `mean ${six!.mean}, deepest ${six!.deepest}, was ${before.deepest}`)
  assert.ok(six!.mean - twelve!.mean < 0.06, `passes 7 to 12 took ${six!.mean - twelve!.mean} cm more`)
  assert.ok(twelve!.roughness <= 1.1 * six!.roughness)

  // The worked face carries the rasp's finish; the roughing beside it keeps the point's.
  const { nx, ny, voxel, x0, y0, z0 } = five
  const finishAt = (x: number, y: number): number => {
    const z = raycast(five, [x, y, 40], [0, 0, -1])!.point[2] - 0.5 * voxel
    return five.finish[Math.round((x - x0) / voxel) + nx * (Math.round((y - y0) / voxel) + ny * Math.round((z - z0) / voxel))]!
  }
  for (const [x, y] of [[0, 15], [-5, 11], [6, 19]]) assert.equal(finishAt(x!, y!), FINISH.rasp, `finish at ${x}, ${y}`)
  assert.equal(finishAt(0, 27), FINISH.point)
})

test('the claw leaves parallel grooves across the stroke', () => {
  const grid = cube()
  applyStrike(grid, { kind: 'cut', tool: 'claw', at: [0, 20, 0], dir: [0, -1, 0], size: 10, depth: 2, seed: 7, across: [1, 0, 0], ms: 300 })
  const height = (x: number, z: number) => raycast(grid, [x, 40, z], [0, -1, 0])!.point[1]
  const spread = (along: 'x' | 'z') => {
    let lo = Infinity
    let hi = -Infinity
    for (let t = -2.4; t <= 2.4; t += 0.2) {
      const y = along === 'x' ? height(t, 0) : height(0, t)
      lo = Math.min(lo, y)
      hi = Math.max(hi, y)
    }
    return hi - lo
  }
  // Teeth are spaced along x, so the floor of the bite is ridged across x and even along z.
  assert.ok(spread('x') > 0.5, `across ${spread('x')}`)
  assert.ok(spread('z') < 0.5 * spread('x'), `along ${spread('z')} against ${spread('x')}`)
})

// Every sample that was stone and lies inside `inside` must still be stone.
function cutInside(before: Grid, after: Grid, inside: (x: number, y: number, z: number) => boolean): number {
  const { nx, ny, nz, voxel, x0, y0, z0 } = after
  let n = 0
  for (let z = 0, i = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, i++) {
        if (before.dist[i]! < 0 && after.dist[i]! >= 0 && inside(x0 + x * voxel, y0 + y * voxel, z0 + z * voxel)) n++
      }
    }
  }
  return n
}

function grown(form: CompiledForm, margin: number): CompiledForm {
  return { ...form, inflate: form.inflate + margin }
}

const EGG: Form = { shapes: [{ kind: 'ellipsoid', center: [0, 40, 0], size: [40, 80, 40], rotation: [0, 0, 0] }], blend: 0 }

test('a rough-out to an ellipsoid leaves the ellipsoid plus margin and nothing else', () => {
  const start = createGrid()
  applyStrike(start, { kind: 'form', name: 'egg', ...EGG })
  const grid = cloneGrid(start)
  const margin = 4
  const result = roughOut(grid, { to: 'egg', margin_cm: margin, tool: 'point' })
  assert.equal(result.error, undefined)
  const stats = result.stats!
  const target = grown(grid.forms.get('egg')!, margin)

  // Nothing inside ellipsoid + margin was touched. Exactly nothing.
  assert.equal(cutInside(start, grid, (x, y, z) => formDistance(target, x, y, z) < 0), 0)

  // Nothing else is left: no stone anywhere stands far outside it, on average under a
  // centimetre, and the stone that remains is the target plus a thin skin.
  const proud = standingProud(grid, target)
  assert.ok(proud.meanCm < 1, `mean ${proud.meanCm} cm proud`)
  assert.ok(proud.maxCm < 3.5, `max ${proud.maxCm} cm proud`)
  assert.ok(Math.abs(stats.proudMeanCm - proud.meanCm) < 0.01 && Math.abs(stats.proudMaxCm - proud.maxCm) < 0.01)
  const { nx, ny, nz, voxel, x0, y0, z0 } = grid
  let targetVoxels = 0
  let beyond = 0
  for (let z = 0, i = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, i++) {
        if (start.dist[i]! >= 0) continue
        const d = formDistance(target, x0 + x * voxel, y0 + y * voxel, z0 + z * voxel)
        if (d < 0) targetVoxels++
        else if (grid.dist[i]! < 0 && d > 3.5) beyond++
      }
    }
  }
  assert.equal(beyond, 0)
  const targetCm3 = targetVoxels * voxel ** 3
  const left = stoneVolumeCm3(grid)
  assert.ok(left >= 0.995 * targetCm3 && left < 1.08 * targetCm3, `${left} cm³ left around a target of ${targetCm3}`)

  // It was done the way the plan says: the form entry first, slabs sawn off before any
  // chiselling, every chisel strike clipped by the target plus the margin, a detach to end.
  const kinds = result.strikes.map(s => s.kind)
  assert.equal(kinds[0], 'form')
  assert.ok(endsWithDetach(result))
  assert.ok(stats.saws >= 4, `${stats.saws} saw cuts`)
  assert.ok(kinds.lastIndexOf('saw') < kinds.indexOf('cut'))
  assert.ok(stats.slabCm3 > 3 * stats.chiselCm3, `slabs ${stats.slabCm3}, chisels ${stats.chiselCm3}`)
  assert.equal(result.offcuts.length >= stats.saws, true)
  const cuts = result.strikes.filter(s => s.kind === 'cut')
  assert.ok(cuts.every(s => s.kind === 'cut' && s.protect === 'egg' && s.margin === margin && s.tool === 'point'))
  assert.ok(cuts.every(s => s.kind === 'cut' && s.ms >= 250 && s.ms <= 600))
  assert.ok(cuts.length <= 1600, `${cuts.length} chisel strikes`)
  // Largest bites first.
  assert.ok(cuts[0]!.kind === 'cut' && cuts[cuts.length - 1]!.kind === 'cut' && cuts[0]!.size > cuts[cuts.length - 1]!.size)

  // The skin is pitted point work, not a smooth shell on the margin: it carries the point's
  // finish nearly everywhere, its height varies, and little of it sits right on the margin.
  const nxy = nx * ny
  let surface = 0
  let pointed = 0
  let onMargin = 0
  let sum = 0
  let squares = 0
  for (let z = 1; z < nz - 1; z++) {
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const i = x + nx * (y + ny * z)
        const d = grid.dist[i]!
        if (d >= 0 || d < -40) continue
        if (grid.dist[i - 1]! < 0 && grid.dist[i + 1]! < 0 && grid.dist[i + nx]! < 0 && grid.dist[i - nxy]! < 0 && grid.dist[i + nxy]! < 0) continue
        const h = formDistance(target, x0 + x * voxel, y0 + y * voxel, z0 + z * voxel) - d / grid.qPerCm
        surface++
        if (grid.finish[i] === FINISH.point) pointed++
        if (h < 0.1) onMargin++
        sum += h
        squares += h * h
      }
    }
  }
  const deviation = Math.sqrt(squares / surface - (sum / surface) ** 2)
  assert.ok(pointed / surface > 0.95, `${pointed} of ${surface} surface voxels carry the point's finish`)
  assert.ok(onMargin / surface < 0.15, `${onMargin} of ${surface} sit on the margin`)
  assert.ok(deviation > 0.2, `surface height deviates ${deviation} cm`)

  // The strike list alone rebuilds the stone.
  assert.equal(hashGrid(replay(start, result.strikes)), hashGrid(grid))
})

const BUST: Form = {
  shapes: [
    { kind: 'ellipsoid', center: [0, 30, 0], size: [14, 16, 15], rotation: [0, 0, 0] },
    { kind: 'capsule', center: [0, 20, 0], size: [7, 12, 7], rotation: [0, 0, 0] },
    { kind: 'box', center: [0, 7, 0], size: [22, 14, 14], rotation: [0, 0, 0] }
  ],
  blend: 2
}

test('the same pass on the same stone gives the same strikes, and they replay to the same stone', () => {
  const start = createGrid({ width: 30, height: 40, depth: 30, voxel: 0.5 })
  applyStrike(start, { kind: 'form', name: 'bust', ...BUST })
  for (const tool of ['point', 'claw'] as const) {
    const a = cloneGrid(start)
    const b = cloneGrid(start)
    const first = roughOut(a, { to: 'bust', margin_cm: 2, tool })
    const second = roughOut(b, { to: 'bust', margin_cm: 2, tool })
    assert.deepEqual(second.strikes, first.strikes)
    assert.equal(hashGrid(a), hashGrid(b))
    assert.equal(second.summary, first.summary)
    // Replayed from the log as it would be saved: through JSON.
    assert.equal(hashGrid(replay(start, JSON.parse(JSON.stringify(first.strikes)))), hashGrid(a))
    const target = grown(a.forms.get('bust')!, 2)
    assert.equal(cutInside(start, a, (x, y, z) => formDistance(target, x, y, z) < 0), 0)
    assert.ok(first.stats!.proudMeanCm < 1 && first.stats!.proudMaxCm < 3.5, JSON.stringify(first.stats))
    // Head on shoulders: the neck is an undercut the saw cannot reach, so it was chiselled.
    assert.ok(!isStone(a, [9, 22, 0]) && isStone(a, [0, 22, 0]) && isStone(a, [9, 8, 0]))

    // Carrying on from there: a closer second pass, then strokes, all in one log.
    const closer = roughOut(a, { to: 'bust', margin_cm: 0.5, tool })
    assert.equal(closer.stats!.saws, 0)
    const stroke = chisel(a, { tool: 'flat', view: 'front', path: [[-4, 30], [4, 30]], depth_cm: 0.5, width_cm: 2 })
    const smooth = rasp(a, { view: 'left', path: [[-3, 30], [3, 30]], width_cm: 4, passes: 2 })
    const cut = saw(a, { view: 'top', from: [-15, 6], to: [15, 6], discard: 'below' })
    const log = [...first.strikes, ...closer.strikes, ...stroke.strikes, ...smooth.strikes, ...cut.strikes]
    assert.equal(hashGrid(replay(start, log)), hashGrid(a))
  }
})

test('roughing out refuses what it cannot do and leaves the stone alone', () => {
  const grid = createGrid({ width: 30, height: 40, depth: 30, voxel: 0.5 })
  const before = hashGrid(grid)
  const ball = (center: Vec3): Form['shapes'][number] => ({ kind: 'ellipsoid', center, size: [12, 12, 12], rotation: [0, 0, 0] })
  const refused: [PassResult, RegExp][] = [
    [roughOut(grid, { to: 'torso', margin_cm: 2, tool: 'point' }), /No form named 'torso'/],
    [roughOut(grid, { to: { shapes: [{ kind: 'box', center: [80, 20, 0], size: [10, 10, 10], rotation: [0, 0, 0] }], blend: 0 }, margin_cm: 2, tool: 'point' }), /no stone inside/],
    // A form in mid air would be cut loose from the base and fall with the waste.
    [roughOut(grid, { to: { shapes: [ball([0, 25, 0])], blend: 0 }, margin_cm: 2, tool: 'point' }), /does not reach the bottom.*about 17 cm up/],
    // So would the upper of two shapes that do not touch.
    [roughOut(grid, { to: { shapes: [ball([0, 6, 0]), ball([0, 30, 0])], blend: 0 }, margin_cm: 2, tool: 'claw' }), /not joined/]
  ]
  for (const [result, message] of refused) {
    assert.match(result.error ?? '', message)
    assert.equal(result.summary, result.error)
    assert.equal(result.strikes.length, 0)
  }
  assert.equal(hashGrid(grid), before)
  assert.equal(grid.forms.size, 0)
  // Nothing outside the margin: carried out, nothing to do.
  const all = roughOut(grid, { to: { shapes: [{ kind: 'box', center: [0, 20, 0], size: [60, 60, 60], rotation: [0, 0, 0] }], blend: 0 }, margin_cm: 2, tool: 'point' })
  assert.equal(all.error, undefined)
  assert.deepEqual(all.strikes.map(s => s.kind), ['form', 'detach'])
  assert.match(all.summary, /nothing left outside the margin/)
  assert.equal(hashGrid(grid), before)
})

// A binary image painted from a test function of block coordinates (h across, y up).
function paint(width: number, height: number, face: number, tall: number, inside: (h: number, y: number) => boolean): Mask {
  const data = new Uint8Array(width * height)
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const h = -face / 2 + (col + 0.5) / width * face
      const y = tall - (row + 0.5) / height * tall
      if (inside(h, y)) data[row * width + col] = 1
    }
  }
  return { width, height, data }
}

// Grows a mask by a square of `r` cells, so "near the outline" needs no distance maths.
function dilate(mask: Mask, r: number): Mask {
  const { width, height, data } = mask
  const rows = new Uint8Array(width * height)
  const out = new Uint8Array(width * height)
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      for (let c = Math.max(0, col - r); c <= Math.min(width - 1, col + r) && !rows[row * width + col]; c++) {
        if (data[row * width + c]) rows[row * width + col] = 1
      }
    }
  }
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      for (let k = Math.max(0, row - r); k <= Math.min(height - 1, row + r) && !out[row * width + col]; k++) {
        if (rows[k * width + col]) out[row * width + col] = 1
      }
    }
  }
  return { width, height, data: out }
}

test('a rough-out to two outlines keeps the stone both cover and clears the rest', () => {
  const block = { width: 30, height: 40, depth: 30 }
  const start = createGrid({ ...block, voxel: 0.5 })
  // Front: a round head on a wide body, off centre toward +X. Left: a plain column toward
  // the back, so getting an axis or a direction wrong cannot pass.
  const front = paint(60, 80, 30, 40, (x, y) => (y < 18 && Math.abs(x - 2) < 11) || (x - 3) ** 2 + (y - 27) ** 2 < 49)
  const left = paint(60, 80, 30, 40, (z, y) => y < 35 && z > -11 && z < 5)
  const pixel = (mask: Mask, h: number, y: number): boolean => {
    const col = Math.floor((h + 15) / 30 * mask.width)
    const row = Math.floor((40 - y) / 40 * mask.height)
    return col >= 0 && col < mask.width && row >= 0 && row < mask.height && mask.data[row * mask.width + col] === 1
  }
  const margin = 1.5
  const grid = cloneGrid(start)
  const result = roughOut(grid, { to: silhouetteForm(front, left, block), margin_cm: margin, tool: 'point' })
  assert.equal(result.error, undefined)
  assert.ok(result.stats!.saws >= 2 && result.stats!.chiselStrikes > 50, JSON.stringify(result.stats))

  // Stone under both outlines is all still there.
  assert.equal(cutInside(start, grid, (x, y, z) => pixel(front, x, y) && pixel(left, z, y)), 0)
  // And no stone is left further from either outline than the margin and a bite's ridges.
  const reach = Math.ceil((margin + 3) / 0.5)
  const nearFront = dilate(front, reach)
  const nearLeft = dilate(left, reach)
  const { nx, ny, nz, voxel, x0, y0, z0 } = grid
  let stray = 0
  let kept = 0
  for (let z = 0, i = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, i++) {
        if (grid.dist[i]! >= 0) continue
        kept++
        if (!pixel(nearFront, x0 + x * voxel, y0 + y * voxel) || !pixel(nearLeft, z0 + z * voxel, y0 + y * voxel)) stray++
      }
    }
  }
  assert.ok(kept > 0)
  assert.equal(stray, 0)
  assert.ok(result.stats!.proudMeanCm < 1 && result.stats!.proudMaxCm < 3.5, JSON.stringify(result.stats))
  // Spot checks in block coordinates: head, body, and the air beside, in front and above.
  assert.ok(isStone(grid, [3, 27, -3]) && isStone(grid, [-7, 8, -3]))
  assert.ok(!isStone(grid, [-10, 27, -3]) && !isStone(grid, [3, 27, 10]) && !isStone(grid, [3, 38.5, -3]))

  // The outlines ride in the log: the list replays on its own, even after a trip through JSON.
  const form = result.strikes[0]!
  assert.ok(form.kind === 'form' && form.silhouette !== undefined)
  assert.equal(hashGrid(replay(start, JSON.parse(JSON.stringify(result.strikes)))), hashGrid(grid))

  // Declared by name first, the same target gives the same stone.
  const named = cloneGrid(start)
  applyStrike(named, { kind: 'form', name: 'reference', ...silhouetteForm(front, left, block) })
  const again = roughOut(named, { to: 'reference', margin_cm: margin, tool: 'point' })
  assert.ok(again.strikes.every(s => s.kind !== 'cut' || s.protect === 'reference'))
  assert.equal(hashGrid(named), hashGrid(grid))
})

// ---------- the Sprint 3 tools ----------

// How far below the cube's top face (y = 20) the stone starts at (x, z).
const sunk = (grid: Grid, x: number, z: number) => 20 - raycast(grid, [x, 40, z], [0, -1, 0])!.point[1]

test('the roundel leaves a round-bottomed channel as wide and as deep as asked', () => {
  // As deep as half its width: a half-round channel. Shallower: an arc of a wider circle.
  for (const [width, depth] of [[4, 2], [5, 1]] as const) {
    const start = cube()
    const grid = cloneGrid(start)
    const result = chisel(grid, { tool: 'roundel', view: 'top', path: [[-6, 0], [6, 0]], depth_cm: depth, width_cm: width })
    assert.equal(result.error, undefined)
    assert.ok(endsWithDetach(result))
    const cuts = result.strikes.filter(s => s.kind === 'cut')
    // Every bite is the whole tool, sunk from the face the stroke started on.
    assert.ok(cuts.length > 5 && cuts.every(s => s.kind === 'cut' && s.tool === 'roundel' && s.depth === depth && Math.abs(s.at[1] - 20) < 0.05 && s.dir[1] < -0.99))
    const half = width / 2
    const radius = (half * half + depth * depth) / (2 * depth)
    for (const off of [0, 0.3, 0.6, 0.85]) {
      const z = off * half
      const want = depth - radius + Math.sqrt(radius * radius - z * z)
      for (const x of [-3, 0, 3]) {
        const got = sunk(grid, x, z)
        assert.ok(Math.abs(got - want) < 0.25, `${width}×${depth}: ${got.toFixed(2)} deep at ${z.toFixed(2)} from the centre line, wanted ${want.toFixed(2)}`)
      }
    }
    // Nothing is cut beyond the width, and the floor carries the roundel's finish.
    assert.ok(sunk(grid, 0, half + 0.8) < 0.1 && sunk(grid, 0, -half - 0.8) < 0.1)
    const floor = Math.round((20 - depth - 0.3 - grid.y0) / grid.voxel)
    assert.equal(grid.finish[Math.round(-grid.x0 / grid.voxel) + grid.nx * (floor + grid.ny * Math.round(-grid.z0 / grid.voxel))], FINISH.roundel)
    assert.equal(hashGrid(replay(start, JSON.parse(JSON.stringify(result.strikes)))), hashGrid(grid))
  }
  // A flat chisel of the same size leaves a flat floor; the roundel's is deepest in the middle.
  const flat = cube()
  chisel(flat, { tool: 'flat', view: 'top', path: [[-6, 0], [6, 0]], depth_cm: 1, width_cm: 5 })
  const round = cube()
  chisel(round, { tool: 'roundel', view: 'top', path: [[-6, 0], [6, 0]], depth_cm: 1, width_cm: 5 })
  assert.ok(sunk(flat, 0, 1.5) > sunk(round, 0, 1.5) + 0.2)

  // Too deep for its width is a slot, and is cut back to a channel.
  const deep = chisel(cube(), { tool: 'roundel', view: 'top', path: [[-6, 0], [6, 0]], depth_cm: 6, width_cm: 2 })
  assert.match(deep.summary, /Depth was limited to 3 cm/)
  assert.match(deep.summary, /^Roundel from the top view/)
})

test('a protected stroke clears the stone round a form and cannot cut into it', () => {
  const start = cube()
  const nose: Form = { shapes: [{ kind: 'ellipsoid', center: [0, 19, 0], size: [4, 6, 4], rotation: [0, 0, 0] }], blend: 0 }
  applyStrike(start, { kind: 'form', name: 'nose', ...nose })
  const inside = (x: number, y: number, z: number) => formDistance(start.forms.get('nose')!, x, y, z) < 0
  const pass: ChiselPass = { tool: 'flat', view: 'top', path: [[-6, 0], [6, 0]], depth_cm: 2.5, width_cm: 5 }

  const kept = cloneGrid(start)
  const guarded = chisel(kept, { ...pass, protect: 'nose' })
  assert.equal(guarded.error, undefined)
  assert.ok(guarded.strikes.filter(s => s.kind === 'cut').every(s => s.kind === 'cut' && s.protect === 'nose'))
  assert.equal(cutInside(start, kept, inside), 0)
  // The stone either side of it did come down.
  assert.ok(sunk(kept, -5, 0) > 2 && sunk(kept, 5, 0) > 2 && sunk(kept, 0, 0) < 0.1)
  assert.match(guarded.summary, /Nothing inside 'nose' was cut/)
  assert.equal(hashGrid(replay(start, guarded.strikes)), hashGrid(kept))

  const bare = cloneGrid(start)
  chisel(bare, pass)
  assert.ok(cutInside(start, bare, inside) > 50)

  const before = hashGrid(kept)
  const refused = chisel(kept, { ...pass, protect: 'chin' })
  assert.match(refused.error!, /No form named 'chin'/)
  assert.equal(refused.strikes.length, 0)
  assert.equal(hashGrid(kept), before)
})

test('the drill bores along the view direction to the depth asked and says where it went in', () => {
  const start = cube()
  const grid = cloneGrid(start)
  const result = drill(grid, { view: 'front', at: [2, 12], diameter_cm: 2, depth_cm: 6 })
  assert.equal(result.error, undefined)
  assert.ok(endsWithDetach(result))
  const pecks = result.strikes.filter(s => s.kind === 'cut')
  assert.equal(pecks.length, 3)
  assert.ok(pecks.every(s => s.kind === 'cut' && s.tool === 'drill' && s.dir[2] === -1 && s.size === 2 && s.depth === 2 && s.at[0] === 2 && s.at[1] === 12))
  const bore = result.bore!
  assert.ok(Math.abs(bore.entry[0] - 2) < 1e-6 && Math.abs(bore.entry[1] - 12) < 1e-6 && Math.abs(bore.entry[2] - 10) < 0.1, `entry ${bore.entry}`)
  assert.equal(bore.through, false)
  assert.ok(Math.abs(bore.depthCm - 6) < 0.3, `depth ${bore.depthCm}`)
  // Open down its axis to the depth, stone beyond it and beside it.
  assert.ok(!isStone(grid, [2, 12, 9]) && !isStone(grid, [2, 12, 4.6]) && isStone(grid, [2, 12, 3.4]))
  assert.ok(isStone(grid, [3.6, 12, 7]) && isStone(grid, [2, 13.6, 7]) && !isStone(grid, [2.6, 12, 7]))
  // A straight bore of about its nominal volume.
  assert.ok(within(result.removedCm3, Math.PI * 6, 0.12), `removed ${result.removedCm3}`)
  assert.match(result.summary, /went in at \(x 2\.0, y 12\.0, z 10\.0\) and bored a hole 2 cm across, 6\.\d cm deep/)
  assert.equal(hashGrid(replay(start, JSON.parse(JSON.stringify(result.strikes)))), hashGrid(grid))

  // Off the stone: said, not thrown, and nothing is logged.
  const miss = drill(grid, { view: 'front', at: [30, 12], diameter_cm: 2, depth_cm: 6 })
  assert.equal(miss.strikes.length, 0)
  assert.match(miss.summary, /missed the stone/)
  assert.match(drill(grid, { view: 'front_left', at: [0, 0], diameter_cm: 2, depth_cm: 2 }).error!, /not 'front_left'/)
})

test('a drill that comes out into open air stops there', () => {
  // A wall about 3 cm thick across the front of the cube, with a slot some 4 cm wide sunk
  // from the top behind it.
  const grid = cube()
  for (let x = -8; x <= 8; x += 2) applyStrike(grid, { kind: 'cut', tool: 'flat', at: [x, 20, 5], dir: [0, -1, 0], size: 4, depth: 16, seed: 3, ms: 1 })
  assert.ok(isStone(grid, [0, 10, 8.5]) && !isStone(grid, [0, 10, 5]) && isStone(grid, [0, 10, 1]))
  const behind = stoneVolumeCm3(grid)
  const result = drill(grid, { view: 'front', at: [0, 10], diameter_cm: 1.6, depth_cm: 12 })
  const bore = result.bore!
  assert.equal(bore.through, true)
  assert.ok(bore.depthCm > 2.4 && bore.depthCm < 4.4, `stopped at ${bore.depthCm}`)
  assert.match(result.summary, /came out into open air/)
  // Through the wall, and the stone across the gap is untouched.
  assert.ok(!isStone(grid, [0, 10, 8.5]) && isStone(grid, [0, 10, 2.5]))
  assert.ok(behind - stoneVolumeCm3(grid) < Math.PI * 0.8 * 0.8 * 5, `${behind - stoneVolumeCm3(grid)} cm³ came out`)
})

test('polish raises the finish under the path and moves no stone', () => {
  const start = cube()
  chisel(start, { tool: 'point', view: 'top', path: [[-6, -3], [6, -3]], depth_cm: 1, width_cm: 3 })
  takeDirty(start)
  const grid = cloneGrid(start)
  const dist = grid.dist.slice()
  const result = polish(grid, { view: 'top', path: [[-6, 0], [6, 0]], width_cm: 4, passes: 2 })
  assert.equal(result.error, undefined)
  // Not one distance changed: the shape, the volume and what a look renders are the same.
  assert.deepEqual(grid.dist, dist)
  assert.equal(grid.solidUnits, start.solidUnits)
  assert.equal(result.removedCm3, 0)
  assert.equal(result.offcuts.length, 0)
  // No island check either: nothing can have come loose.
  assert.ok(result.strikes.length > 10 && result.strikes.every(s => s.kind === 'cut' && s.tool === 'polish' && s.ms > 0))
  // The finish did change, so the hash did, and the chunks that bake it in are stale.
  assert.notEqual(hashGrid(grid), hashGrid(start))
  assert.ok(takeDirty(grid).length > 0)
  assert.equal(result.sheen!.before, FINISH.sawn)
  assert.ok(result.sheen!.after > 220, `after ${result.sheen!.after}`)
  const at = (g: Grid, x: number, z: number) => g.finish[Math.round((x - g.x0) / g.voxel) + g.nx * (Math.round((19.8 - g.y0) / g.voxel) + g.ny * Math.round((z - g.z0) / g.voxel))]!
  assert.ok(at(grid, 0, 0) > 220 && at(grid, 0, 0) <= 255)
  // Outside the band nothing was touched: the sawn face, and the chisel work beside it.
  assert.equal(at(grid, 0, 6), FINISH.sawn)
  assert.equal(at(grid, 8, 8), at(start, 8, 8))
  assert.match(result.summary, /The finish under the path went from 90 to 2\d\d/)
  assert.match(result.summary, /No stone was removed/)

  // More passes, more shine; it tops out at a full polish and never wraps.
  const once = cloneGrid(start)
  const one = polish(once, { view: 'top', path: [[-6, 0], [6, 0]], width_cm: 4, passes: 1 })
  assert.ok(one.sheen!.after > FINISH.sawn + 40 && one.sheen!.after < result.sheen!.after)
  const many = cloneGrid(start)
  for (let n = 0; n < 4; n++) polish(many, { view: 'top', path: [[-6, 0], [6, 0]], width_cm: 4, passes: 8 })
  assert.equal(at(many, 0, 0), FINISH.polished)
  assert.deepEqual(many.dist, dist)

  assert.equal(hashGrid(replay(start, JSON.parse(JSON.stringify(result.strikes)))), hashGrid(grid))
  assert.match(polish(grid, { view: 'top', path: [[40, 0], [50, 0]], width_cm: 4, passes: 1 }).summary, /Nothing was polished/)
})

test('a sketch lays charcoal on the surface, is logged as one entry, and leaves the grid alone', () => {
  const grid = cube()
  const before = hashGrid(grid)
  takeDirty(grid)
  // Across the front face and off its right edge: x from -6 to 14, the face ends at 10.
  const result = sketch(grid, { view: 'front', path: [[-6, 5], [-6, 15], [14, 15]] })
  assert.equal(result.error, undefined)
  assert.equal(hashGrid(grid), before)
  assert.equal(takeDirty(grid).length, 0)
  assert.equal(result.removedCm3, 0)
  assert.equal(result.strikes.length, 1)
  const entry = result.strikes[0]!
  assert.ok(entry.kind === 'sketch')
  assert.equal(entry.view, 'front')
  assert.deepEqual(entry.points, [[-6, 5], [-6, 15], [14, 15]])
  assert.ok(entry.ms >= 600 && entry.ms === result.ms)
  // One run of marks about a centimetre apart, all on the face at z = 10, ending at its edge.
  assert.equal(entry.strokes.length, 1)
  const marks = entry.strokes[0]!
  assert.ok(marks.length >= 24 && marks.length <= 28, `${marks.length} marks`)
  assert.ok(marks.every(m => Math.abs(m[2] - 10) < 0.1 && m[0] >= -6.01 && m[0] <= 10.01 && m[1] >= 4.99 && m[1] <= 15.01))
  assert.deepEqual(marks[0]!.slice(0, 2), [-6, 5])
  for (let i = 1; i < marks.length; i++) {
    const step = Math.hypot(marks[i]![0] - marks[i - 1]![0], marks[i]![1] - marks[i - 1]![1], marks[i]![2] - marks[i - 1]![2])
    assert.ok(step > 0.5 && step < 1.3, `marks ${step} apart`)
  }
  assert.ok(Math.abs(result.line!.drawnCm - 26) < 1.2 && Math.abs(result.line!.missedCm - 4) < 1.2, JSON.stringify(result.line))
  assert.match(result.summary, /drew 2\d cm of line on the stone/)
  assert.match(result.summary, /No stone was cut/)

  // The kernel takes the entry and does nothing with it, so a log that holds one replays.
  const applied = applyStrike(grid, JSON.parse(JSON.stringify(entry)) as Strike)
  assert.deepEqual(applied, { dirtyChunks: [], removedCm3: 0, offcuts: [] })
  assert.equal(hashGrid(grid), before)

  // A line that runs down into a pocket 5 cm deep breaks there into two runs.
  const stepped = cube()
  for (let y = 3; y <= 17; y += 2) applyStrike(stepped, { kind: 'cut', tool: 'flat', at: [5, y, 10], dir: [0, 0, -1], size: 6, depth: 5, seed: 3, ms: 1 })
  const over = sketch(stepped, { view: 'front', path: [[-8, 10], [6, 10]] })
  assert.equal(over.error, undefined)
  const runs = over.strikes[0]!
  assert.ok(runs.kind === 'sketch' && runs.strokes.length === 2, JSON.stringify(runs))
  assert.ok(runs.strokes[0]!.every(m => m[2] > 9.8) && runs.strokes[1]!.every(m => m[2] < 6.5))

  // A line that misses the stone, or has no length, is refused and nothing is logged.
  const none = sketch(stepped, { view: 'front', path: [[12, 5], [16, 15]] })
  assert.match(none.error!, /does not lie on the stone/)
  assert.equal(none.strikes.length, 0)
  assert.match(sketch(stepped, { view: 'front', path: [[2, 5], [2, 5]] }).error!, /no length/)
  assert.match(sketch(grid, { view: 'back_left', path: [[0, 0], [1, 1]] }).error!, /not 'back_left'/)
})

// How many strikes in a row land while stone that has been cut free is still in the grid.
function longestFloat(start: Grid, strikes: Strike[]): { strikes: number, ms: number, drops: number } {
  const grid = cloneGrid(start)
  let floating = false
  let run = 0
  let ms = 0
  let worst = 0
  let worstMs = 0
  let drops = 0
  for (const strike of strikes) {
    const result = applyStrike(grid, strike)
    if (strike.kind === 'detach') {
      if (result.removedCm3 > 0) drops++
      floating = false
      run = 0
      ms = 0
      continue
    }
    if (strike.kind !== 'cut' && strike.kind !== 'saw') continue
    if (!floating) floating = detachIslands(cloneGrid(grid)).removedCm3 > 0
    if (floating) {
      run++
      ms += strike.ms
      if (run > worst) worst = run
      if (ms > worstMs) worstMs = ms
    }
  }
  return { strikes: worst, ms: worstMs, drops }
}

test('loose stone never hangs for more than a few strikes: passes check for islands as they go', () => {
  // A cat: the stone between and beside the ears is cut free in pieces as the layers go down.
  const cat: Form = {
    shapes: [
      { kind: 'box', center: [0, 4, 0], size: [50, 8, 54], rotation: [0, 0, 0] },
      { kind: 'ellipsoid', center: [0, 28, -4], size: [44, 44, 50], rotation: [0, 0, 0] },
      { kind: 'ellipsoid', center: [0, 56, 12], size: [30, 28, 28], rotation: [0, 0, 0] },
      { kind: 'cone', center: [-9, 72, 12], size: [9, 12, 7], rotation: [0, 0, 0] },
      { kind: 'cone', center: [9, 72, 12], size: [9, 12, 7], rotation: [0, 0, 0] }
    ],
    blend: 4
  }
  const start = createGrid({ voxel: 0.8 })
  const grid = cloneGrid(start)
  const result = roughOut(grid, { to: cat, margin_cm: 2, tool: 'point' })
  assert.equal(result.error, undefined)
  const { strikes } = result
  // The slowest blow is 600 ms, so a check comes round at least every 2.6 s of work, and
  // no more than nine blows (at 250 ms each) can pass between two of them.
  const K = Math.ceil(DETACH_EVERY_MS / 250) + 1
  let since = 0
  let sinceMs = 0
  let checks = 0
  for (let i = 0; i < strikes.length; i++) {
    const s = strikes[i]!
    if (s.kind === 'detach') {
      checks++
      since = 0
      sinceMs = 0
    } else if (s.kind === 'saw') {
      // Every saw cut is followed at once by a check.
      assert.equal(strikes[i + 1]!.kind, 'detach')
    } else if (s.kind === 'cut') {
      since++
      sinceMs += s.ms
      assert.ok(since <= K && sinceMs < DETACH_EVERY_MS + 600, `${since} blows, ${sinceMs} ms without an island check at entry ${i}`)
    }
  }
  assert.ok(endsWithDetach(result))
  const cuts = strikes.filter(s => s.kind === 'cut').length
  assert.ok(checks > cuts / K && checks < cuts / 2, `${checks} checks for ${cuts} blows`)
  // Measured on the stone itself: with an island in the grid, at most K strikes go by.
  const float = longestFloat(start, strikes)
  assert.ok(float.strikes <= K, JSON.stringify(float))
  // And there were islands to drop: the checks along the way found loose stone many times.
  assert.ok(float.drops > 5, JSON.stringify(float))
  // The same stone as ever comes out of it.
  assert.ok(result.stats!.proudMeanCm < 1 && result.stats!.proudMaxCm < 3.5, JSON.stringify(result.stats))
  assert.equal(hashGrid(replay(start, JSON.parse(JSON.stringify(strikes)))), hashGrid(grid))

  // A long stroke checks as it goes too, and still ends on one.
  const block = createGrid({ voxel: 0.8 })
  const stroke = chisel(block, { tool: 'point', view: 'front', path: [[-25, 20], [25, 20], [25, 80], [-25, 80]], depth_cm: 6, width_cm: 4 })
  const kinds = stroke.strikes.map(s => s.kind)
  assert.ok(kinds.filter(k => k === 'detach').length > 10 && endsWithDetach(stroke))
  assert.ok(longestFloat(createGrid({ voxel: 0.8 }), stroke.strikes).strikes <= K)
})

test('a windowed pass takes only the window down onto the form, with the flat, and never saws', () => {
  const grid = createGrid()
  applyStrike(grid, { kind: 'form', name: 'egg', ...EGG })
  assert.equal(roughOut(grid, { to: 'egg', margin_cm: 3, tool: 'point' }).error, undefined)
  const egg = grid.forms.get('egg')!
  // The front of the egg's upper half, worked from the front.
  const box = { x0: -22, y0: 40, z0: -30, x1: 22, y1: 82, z1: 30 }
  const result = roughOut(grid, { to: 'egg', margin_cm: 0.1, tool: 'flat', window: { box, facing: [0, 0, 1] } })
  assert.equal(result.error, undefined)
  assert.ok(result.strikes.every(s => s.kind !== 'saw'), 'no saw in a windowed pass')
  assert.ok(result.strikes.filter(s => s.kind === 'cut').every(s => s.tool === 'flat' && s.protect === 'egg'))
  assert.match(result.summary, /Brought the stone in the window down to 'egg' with the flat chisel/)
  // Inside the window, the surface facing the viewer sits on the form; behind, the roughing margin still stands.
  const { nx, ny, nz, voxel, x0, y0, z0, qPerCm } = grid
  let frontSum = 0
  let frontN = 0
  let backSum = 0
  let backN = 0
  for (let z = 1; z < nz - 1; z++) {
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const i = x + nx * (y + ny * z)
        const d = grid.dist[i]!
        if (d >= 0 || d < -12) continue
        const wy = y0 + y * voxel
        const wz = z0 + z * voxel
        const wx = x0 + x * voxel
        if (wy < 50 || wy > 75 || Math.abs(wx) > 10) continue
        const h = formDistance(egg, wx, wy, wz) - d / qPerCm
        if (wz > 5) {
          frontSum += h
          frontN++
        } else if (wz < -5) {
          backSum += h
          backN++
        }
      }
    }
  }
  assert.ok(frontN > 0 && backN > 0)
  assert.ok(frontSum / frontN < 0.35, `front stands ${frontSum / frontN} cm proud`)
  assert.ok(backSum / backN > 2, `back stands ${backSum / backN} cm proud`)
  // The flat alone is refused without a window.
  assert.match(roughOut(grid, { to: 'egg', margin_cm: 0.1, tool: 'flat' }).error ?? '', /point or the claw/)
})

test('a protected rasp wears ridges down to the form and not into it', () => {
  const grid = createGrid()
  applyStrike(grid, { kind: 'form', name: 'egg', ...EGG })
  assert.equal(roughOut(grid, { to: 'egg', margin_cm: 0.3, tool: 'claw' }).error, undefined)
  const egg = grid.forms.get('egg')!
  const before = cloneGrid(grid)
  const path: [number, number][] = [[-8, 70], [8, 70], [8, 60], [-8, 60], [-8, 50], [8, 50]]
  const result = rasp(grid, { view: 'front', path, width_cm: 6, passes: 6, protect: 'egg' })
  assert.equal(result.error, undefined)
  assert.ok(result.removedCm3 > 0)
  assert.ok(result.strikes.filter(s => s.kind === 'cut').every(s => s.protect === 'egg'))
  assert.equal(cutInside(before, grid, (x, y, z) => formDistance(egg, x, y, z) < 0), 0)
  assert.match(rasp(grid, { view: 'front', path, width_cm: 6, passes: 1, protect: 'nothing' }).error ?? '', /No form named 'nothing'/)
})
