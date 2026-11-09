/**
 * The stone grid and strikes: block creation, volume accounting, the bite tools, the rasp,
 * protection, dirty chunks and determinism.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FINISH, chunkCount, chunkId, cloneGrid, createGrid, hashGrid, nearestVoxel, recountSolid,
  stoneMassKg, stoneVolumeCm3, takeDirty, voxelIndex
} from '../shared/sculpt/grid.ts'
import { raycast } from '../shared/sculpt/raycast.ts'
import { createRng } from '../shared/sculpt/rng.ts'
import { declareForm, formDistance } from '../shared/sculpt/shapes.ts'
import { applyStrike } from '../shared/sculpt/strike.ts'
import { nominalBiteCm3, prepareTool, toolDistance, toolSpec } from '../shared/sculpt/tools.ts'
import type { CutStrike, Grid, Strike, ToolId } from '../shared/sculpt/types.ts'
import { within } from './helpers.ts'

function cut(tool: ToolId, at: [number, number, number], dir: [number, number, number], size: number, depth: number, seed = 1, protect?: string): CutStrike {
  return protect === undefined
    ? { kind: 'cut', tool, at, dir, size, depth, seed, ms: 100 }
    : { kind: 'cut', tool, at, dir, size, depth, seed, protect, ms: 100 }
}

// Volume of (tool ∩ block) by brute force: the midpoint rule on a lattice six times finer
// than the grid. The block is the fresh default one, so "inside the block" is a box test.
function integrateBite(grid: Grid, strike: CutStrike): number {
  const tool = prepareTool(toolSpec(strike.tool), strike, grid.voxel)
  const step = grid.voxel / 6
  const reach = strike.size / 2 + strike.depth + 0.6
  const [hx, height, hz] = [grid.size[0] / 2, grid.size[1], grid.size[2] / 2]
  const cells = Math.ceil(2 * reach / step)
  let inside = 0
  for (let k = 0; k < cells; k++) {
    const z = strike.at[2] - reach + (k + 0.5) * step
    if (Math.abs(z) > hz) continue
    for (let j = 0; j < cells; j++) {
      const y = strike.at[1] - reach + (j + 0.5) * step
      if (y < 0 || y > height) continue
      for (let i = 0; i < cells; i++) {
        const x = strike.at[0] - reach + (i + 0.5) * step
        if (Math.abs(x) <= hx && toolDistance(tool, x, y, z) < 0) inside++
      }
    }
  }
  return inside * step * step * step
}

test('the default block is 60 × 100 × 60 cm of marble in 200 chunks', () => {
  const grid = createGrid()
  assert.deepEqual([grid.nx, grid.ny, grid.nz], [160, 256, 160])
  assert.equal(grid.chunk, 32)
  assert.equal(chunkCount(grid), 200)
  assert.deepEqual(grid.size, [60, 100, 60])
  assert.ok(Math.abs(stoneVolumeCm3(grid) - 360000) < 1e-6, `volume ${stoneVolumeCm3(grid)}`)
  assert.ok(Math.abs(stoneMassKg(grid) - 975.6) < 0.01, `mass ${stoneMassKg(grid)}`)
  // Origin at the centre of the base, +Y up: stone just above y = 0, air just below.
  const d = (p: [number, number, number]) => grid.dist[voxelIndex(grid, ...nearestVoxel(grid, p))]!
  assert.ok(d([0, 0.2, 0]) < 0 && d([0, -0.2, 0]) > 0)
  assert.ok(d([29.8, 50, 0]) < 0 && d([30.2, 50, 0]) > 0)
  assert.ok(d([0, 99.8, 29.8]) < 0 && d([0, 100.2, 0]) > 0)
  assert.equal(d([0, 50, 0]), -127)
  assert.equal(grid.finish[voxelIndex(grid, ...nearestVoxel(grid, [0, 99.8, 0]))], FINISH.sawn)
  assert.equal(takeDirty(grid).length, 200, 'a fresh grid needs every chunk meshed')
  assert.equal(takeDirty(grid).length, 0)
})

test('block size and voxel size are parameters', () => {
  const grid = createGrid({ width: 20, height: 30, depth: 10, voxel: 0.25 })
  assert.deepEqual(grid.size, [20, 30, 10])
  assert.ok(Math.abs(stoneVolumeCm3(grid) - 6000) < 1e-6)
  assert.equal(grid.nx % 32 + grid.ny % 32 + grid.nz % 32, 0)
})

test('a flat-chisel strike removes its nominal volume within 5%', () => {
  const grid = createGrid()
  const before = stoneVolumeCm3(grid)
  const strike = cut('flat', [0, 100, 0], [0, -1, 0], 6, 2)
  const expected = nominalBiteCm3(toolSpec('flat'), 6, 2)
  const result = applyStrike(grid, strike)
  assert.ok(within(result.removedCm3, expected, 0.05), `removed ${result.removedCm3}, expected ${expected}`)
  assert.ok(Math.abs(before - stoneVolumeCm3(grid) - result.removedCm3) < 1e-6)
  assert.equal(result.offcuts.length, 0)
  assert.equal(grid.solidUnits, recountSolid(grid))
})

test('point-chisel strikes each remove what their own noisy shape holds, within 5%', () => {
  const grid = createGrid()
  const nominal = nominalBiteCm3(toolSpec('point'), 4, 2)
  let total = 0
  let count = 0
  const distinct = new Set<string>()
  for (let gx = -20; gx <= 20; gx += 10) {
    for (let gz = -20; gz <= 20; gz += 10) {
      // Off the voxel lattice on purpose, so the test is not flattered by alignment.
      const strike = cut('point', [gx + 0.13 * count, 100, gz - 0.07 * count], [0, -1, 0], 4, 2, 1000 + count)
      const expected = integrateBite(grid, strike)
      const { removedCm3 } = applyStrike(grid, strike)
      assert.ok(within(removedCm3, expected, 0.05), `strike ${count}: removed ${removedCm3}, shape holds ${expected}`)
      total += removedCm3
      distinct.add(removedCm3.toFixed(3))
      count++
    }
  }
  assert.equal(distinct.size, count, 'seeded noise makes every chip different')
  // The noise fattens the cone a little on average (a bulge adds more than a dent takes),
  // so the smooth cone's volume is a planning figure, good to about 10%.
  assert.ok(within(total / count, nominal, 0.1), `mean ${total / count}, nominal ${nominal}`)
})

test('a strike into an edge at an angle still removes what its shape overlaps', () => {
  const grid = createGrid()
  const strike = cut('flat', [30, 80.1, 10.2], [-0.8, -0.6, 0], 5, 3, 9)
  const expected = integrateBite(grid, strike)
  const { removedCm3 } = applyStrike(grid, strike)
  assert.ok(within(removedCm3, expected, 0.05), `removed ${removedCm3}, shape holds ${expected}`)
})

test('tools mark the finish of the surface they leave', () => {
  const grid = createGrid()
  applyStrike(grid, cut('point', [-10, 100, 0], [0, -1, 0], 4, 2))
  applyStrike(grid, cut('flat', [10, 100, 0], [0, -1, 0], 4, 2))
  const finishUnder = (x: number) => {
    const hit = raycast(grid, [x, 120, 0], [0, -1, 0])!
    return grid.finish[voxelIndex(grid, ...nearestVoxel(grid, [x, hit.point[1] - 0.2, 0]))]
  }
  assert.equal(finishUnder(-10), FINISH.point)
  assert.equal(finishUnder(10), FINISH.flat)
  assert.equal(finishUnder(0), FINISH.sawn)
})

test('a protected form is never cut', () => {
  const grid = createGrid({ width: 24, height: 24, depth: 24 })
  const form = declareForm(grid, 'core', {
    shapes: [
      { kind: 'ellipsoid', center: [0, 12, 0], size: [12, 16, 10], rotation: [0, 0, 20] },
      { kind: 'capsule', center: [3, 14, 2], size: [5, 14, 5], rotation: [70, 0, 0] },
      { kind: 'cone', center: [-3, 6, 0], size: [8, 8, 8], rotation: [0, 0, 0] },
      { kind: 'box', center: [0, 2, 0], size: [10, 4, 10], rotation: [0, 30, 0] }
    ],
    blend: 1.5
  })
  const kept: number[] = []
  for (let z = 0; z < grid.nz; z++) {
    for (let y = 0; y < grid.ny; y++) {
      for (let x = 0; x < grid.nx; x++) {
        const i = voxelIndex(grid, x, y, z)
        const inForm = formDistance(form, grid.x0 + x * grid.voxel, grid.y0 + y * grid.voxel, grid.z0 + z * grid.voxel) < 0
        if (inForm && grid.dist[i]! < 0) kept.push(i)
      }
    }
  }
  assert.ok(kept.length > 5000, 'the form holds a real amount of stone')

  // Hammer the block from every side, aiming straight at the form and far deeper than the
  // stone in front of it.
  const rng = createRng(11)
  const tools: ToolId[] = ['point', 'flat', 'rasp']
  const before = stoneVolumeCm3(grid)
  for (let k = 0; k < 600; k++) {
    const from: [number, number, number] = [rng.range(-13, 13), rng.range(0, 25), rng.range(-13, 13)]
    const hit = raycast(grid, from, [-from[0], 12 - from[1], -from[2]])
    if (!hit) continue
    const dir: [number, number, number] = [-hit.normal[0], -hit.normal[1], -hit.normal[2]]
    applyStrike(grid, cut(tools[k % 3]!, hit.point, dir, rng.range(2, 6), rng.range(1, 8), k, 'core'))
  }
  assert.ok(before - stoneVolumeCm3(grid) > 2000, `the strikes removed ${before - stoneVolumeCm3(grid)} cm³ around the form`)
  for (const i of kept) assert.ok(grid.dist[i]! < 0, `voxel ${i} inside the form was cut`)

  // The same strike without protection does bite into the form, so the check above means something.
  const bare = cut('point', [0, 24, 0], [0, -1, 0], 6, 12, 5)
  applyStrike(grid, { ...bare, protect: 'core' })
  assert.ok(kept.every(i => grid.dist[i]! < 0))
  applyStrike(grid, bare)
  assert.ok(kept.some(i => grid.dist[i]! >= 0))
})

test('a strike that names an undeclared form throws instead of cutting unprotected', () => {
  const grid = createGrid({ width: 10, height: 10, depth: 10 })
  const hash = hashGrid(grid)
  assert.throws(() => applyStrike(grid, cut('point', [0, 10, 0], [0, -1, 0], 3, 2, 1, 'nope')), /undeclared form/)
  assert.equal(hashGrid(grid), hash)
})

test('tools that are not built yet, and the saw used as a cut, are refused', () => {
  const grid = createGrid({ width: 10, height: 10, depth: 10 })
  assert.throws(() => applyStrike(grid, cut('roundel', [0, 10, 0], [0, -1, 0], 3, 2)), /no such tool/)
  assert.throws(() => applyStrike(grid, cut('saw', [0, 10, 0], [0, -1, 0], 3, 2)), /not a cut/)
})

function topHeight(grid: Grid, x: number, z: number): number {
  return raycast(grid, [x, grid.size[1] + 20, z], [0, -1, 0])!.point[1]
}

// Small-scale roughness of the top surface: how far each point stands from the mean of its
// four neighbours 0.4 cm away, RMS, cm.
function roughness(grid: Grid, half: number): number {
  let sum = 0
  let n = 0
  for (let x = -half; x <= half; x += 0.4) {
    for (let z = -half; z <= half; z += 0.4) {
      const around = topHeight(grid, x - 0.4, z) + topHeight(grid, x + 0.4, z) + topHeight(grid, x, z - 0.4) + topHeight(grid, x, z + 0.4)
      const bump = topHeight(grid, x, z) - around / 4
      sum += bump * bump
      n++
    }
  }
  return Math.sqrt(sum / n)
}

function rasp(at: [number, number, number], size: number, depth: number, seed: number): CutStrike {
  return cut('rasp', at, [0, -1, 0], size, depth, seed)
}

test('the rasp leaves flat faces alone, whatever their angle', () => {
  const grid = createGrid({ width: 24, height: 24, depth: 24 })
  takeDirty(grid)
  // On an untouched face it removes nothing, but the face now reads as rasped.
  const flat = applyStrike(grid, rasp([0, 24, 0], 6, 0.2, 1))
  assert.equal(flat.removedCm3, 0)
  assert.ok(flat.dirtyChunks.length > 0)
  assert.equal(grid.finish[voxelIndex(grid, ...nearestVoxel(grid, [0, 23.8, 0]))], FINISH.rasp)

  // A sawn face at an odd angle, rasped fifty times over.
  applyStrike(grid, { kind: 'saw', plane: { point: [0, 16, 0], normal: [0.37, 1, 0.21] }, ms: 500 })
  let removed = 0
  for (let pass = 0; pass < 50; pass++) {
    for (let x = -6; x <= 6; x += 3) {
      for (let z = -6; z <= 6; z += 3) {
        removed += applyStrike(grid, rasp([x, topHeight(grid, x, z), z], 6, 0.15, pass)).removedCm3
      }
    }
  }
  assert.ok(removed < 0.5, `rasping a flat tilted face took off ${removed} cm³`)
})

test('the rasp wears a ridge down to the surface around it and stops there', () => {
  const grid = createGrid({ width: 24, height: 24, depth: 24 })
  // Two channels 1 cm deep along Z leave a ridge about 1 cm wide standing between them.
  let seed = 0
  for (const x of [-2.5, 2.5]) {
    for (let z = -8; z <= 8; z += 1) applyStrike(grid, cut('flat', [x, 24, z], [0, -1, 0], 4, 1, seed++))
  }
  const along = (x: number) => {
    let sum = 0
    for (let z = -4; z <= 4; z += 0.5) sum += topHeight(grid, x, z)
    return sum / 17
  }
  const ridge = along(0)
  const floor = Math.min(along(-2.5), along(2.5))
  assert.ok(ridge - floor > 0.9, `ridge stands ${ridge - floor} cm proud`)

  const snapshot = grid.dist.slice()
  let removed = 0
  const heights: number[] = []
  for (let pass = 0; pass < 30; pass++) {
    for (let z = -8; z <= 8; z += 1) {
      removed += applyStrike(grid, rasp([0, topHeight(grid, 0, z), z], 4, 0.2, pass)).removedCm3
    }
    heights.push(along(0))
  }
  assert.ok(removed > 10, `removed ${removed} cm³`)
  assert.ok(heights[2]! < ridge - 0.5, `after three passes the ridge is at ${heights[2]}`)
  assert.ok(heights[29]! - floor < 0.1, `after thirty the ridge stands ${heights[29]! - floor} cm proud`)
  // The hollows either side were not dug any deeper: nothing went below the old floor.
  assert.ok(Math.min(along(-2.5), along(2.5)) > floor - 0.05)
  assert.ok(heights[29]! > floor - 0.05)
  // And every distance only ever rose: no stone was put back anywhere.
  for (let i = 0; i < snapshot.length; i++) {
    if (grid.dist[i]! < snapshot[i]!) assert.fail(`voxel ${i} gained stone`)
  }
  assert.equal(grid.solidUnits, recountSolid(grid))
})

test('the rasp smooths chisel marks', () => {
  const grid = createGrid({ width: 24, height: 24, depth: 24 })
  const rng = createRng(3)
  for (let k = 0; k < 120; k++) {
    applyStrike(grid, cut('flat', [rng.range(-7, 7), 24, rng.range(-7, 7)], [0, -1, 0], 3, rng.range(0.6, 1.6), k))
  }
  const rough = roughness(grid, 5)
  for (let pass = 0; pass < 4; pass++) {
    for (let x = -7; x <= 7; x += 2) {
      for (let z = -7; z <= 7; z += 2) applyStrike(grid, rasp([x, topHeight(grid, x, z), z], 6, 0.15, pass))
    }
  }
  const smooth = roughness(grid, 5)
  assert.ok(smooth < rough * 0.25, `roughness ${rough.toFixed(4)} → ${smooth.toFixed(4)} cm`)
})

test('a strike dirties only the chunks around it', () => {
  const grid = createGrid()
  takeDirty(grid)
  // Middle of a chunk: sample (80, 250, 80) is chunk (2, 7, 2).
  const middle = applyStrike(grid, cut('point', [0, 100, 0], [0, -1, 0], 3, 1.5))
  assert.deepEqual(middle.dirtyChunks, [chunkId(grid, 2, 7, 2)])
  assert.deepEqual(takeDirty(grid), middle.dirtyChunks)
  // On the line where four chunks meet on the top face (samples x = z = 128).
  const seam = applyStrike(grid, cut('point', [19.4, 100, 19.4], [0, -1, 0], 3, 1.5))
  assert.deepEqual(seam.dirtyChunks.slice().sort((a, b) => a - b), [
    chunkId(grid, 3, 7, 3), chunkId(grid, 4, 7, 3), chunkId(grid, 3, 7, 4), chunkId(grid, 4, 7, 4)
  ].sort((a, b) => a - b))
  // A miss changes nothing and dirties nothing.
  const miss = applyStrike(grid, cut('point', [0, 130, 0], [0, 1, 0], 3, 1.5))
  assert.deepEqual(miss, { dirtyChunks: [], removedCm3: 0, offcuts: [] })
})

function session(seed: number): Strike[] {
  const rng = createRng(seed)
  const strikes: Strike[] = []
  const tools: ToolId[] = ['point', 'flat', 'point', 'rasp']
  for (let k = 0; k < 400; k++) {
    const face = rng.int(3)
    const u = rng.range(-28, 28)
    const v = rng.range(5, 95)
    const at: [number, number, number] = face === 0 ? [u, v, 30] : face === 1 ? [30, v, u] : [u, 100, rng.range(-28, 28)]
    const into: [number, number, number] = face === 0 ? [0, 0, -1] : face === 1 ? [-1, 0, 0] : [0, -1, 0]
    const dir: [number, number, number] = [into[0] + rng.range(-0.3, 0.3), into[1] + rng.range(-0.3, 0.3), into[2] + rng.range(-0.3, 0.3)]
    const strike = cut(tools[k % 4]!, at, dir, rng.range(2, 7), rng.range(0.5, 4), rng.int(1 << 30))
    strikes.push(k % 5 === 0 ? { ...strike, protect: 'keep' } : strike)
    if (k === 150) strikes.push({ kind: 'saw', plane: { point: [22, 90, 0], normal: [1, 1, 0.2] }, ms: 900 })
    if (k % 100 === 99) strikes.push({ kind: 'detach' })
  }
  return strikes
}

function carve(strikes: Strike[]): Grid {
  const grid = createGrid()
  declareForm(grid, 'keep', { shapes: [{ kind: 'ellipsoid', center: [0, 50, 0], size: [40, 80, 40], rotation: [10, 20, 30] }], blend: 0 })
  for (const strike of strikes) applyStrike(grid, strike)
  return grid
}

test('the same strikes on the same block give the same stone, bit for bit', () => {
  const strikes = session(42)
  const a = carve(strikes)
  const b = carve(JSON.parse(JSON.stringify(strikes)) as Strike[])
  assert.equal(hashGrid(a), hashGrid(b))
  assert.deepEqual(a.dist, b.dist)
  assert.deepEqual(a.finish, b.finish)
  assert.equal(a.solidUnits, b.solidUnits)
  assert.equal(a.solidUnits, recountSolid(a), 'the running stone total matches a recount')
  assert.notEqual(hashGrid(a), hashGrid(createGrid()))

  // One different seed in one chisel strike is a different stone.
  assert.ok(strikes[8]!.kind === 'cut' && strikes[8]!.tool === 'point')
  const altered = strikes.map((s, i) => (i === 8 && s.kind === 'cut' ? { ...s, seed: s.seed + 1 } : s))
  assert.notEqual(hashGrid(carve(altered)), hashGrid(a))

  // A copy taken part-way and carried on separately ends up identical too.
  const first = createGrid()
  declareForm(first, 'keep', { shapes: [{ kind: 'ellipsoid', center: [0, 50, 0], size: [40, 80, 40], rotation: [10, 20, 30] }], blend: 0 })
  for (const strike of strikes.slice(0, 200)) applyStrike(first, strike)
  const second = cloneGrid(first)
  for (const strike of strikes.slice(200)) applyStrike(second, strike)
  assert.equal(hashGrid(second), hashGrid(a))
  assert.notEqual(hashGrid(first), hashGrid(a), 'the original was not touched through the copy')
})

test('a log with form entries replays onto a fresh block with nothing declared by hand', () => {
  const keep = { shapes: [{ kind: 'ellipsoid' as const, center: [0, 50, 0] as [number, number, number], size: [40, 80, 40] as [number, number, number], rotation: [10, 20, 30] as [number, number, number] }], blend: 0 }
  const strikes = session(42)
  const direct = carve(strikes)

  // The entry itself moves no stone and dirties nothing.
  const probe = createGrid({ width: 10, height: 10, depth: 10 })
  takeDirty(probe)
  const before = hashGrid(probe)
  assert.deepEqual(applyStrike(probe, { kind: 'form', name: 'keep', ...keep }), { dirtyChunks: [], removedCm3: 0, offcuts: [] })
  assert.equal(hashGrid(probe), before)
  assert.deepEqual(takeDirty(probe), [])
  assert.ok(probe.forms.has('keep'))

  // The form in the log gives the stone that declaring it by hand gave.
  const log: Strike[] = [{ kind: 'form', name: 'keep', ...keep }, ...strikes]
  const replay = (entries: Strike[]) => {
    const grid = createGrid()
    for (const entry of entries) applyStrike(grid, entry)
    return grid
  }
  assert.equal(hashGrid(replay(log)), hashGrid(direct))
  assert.equal(hashGrid(replay(JSON.parse(JSON.stringify(log)) as Strike[])), hashGrid(direct))

  // Declaring the name again part-way replaces the form from that entry onward, in every replay.
  const grown: Strike[] = [...log.slice(0, 120), { kind: 'form', name: 'keep', ...keep, inflate: 6 }, ...log.slice(120)]
  const a = replay(grown)
  assert.equal(hashGrid(replay(JSON.parse(JSON.stringify(grown)) as Strike[])), hashGrid(a))
  assert.notEqual(hashGrid(a), hashGrid(direct), 'the larger form kept stone the first one let go')
  assert.equal(a.solidUnits, recountSolid(a))
})
