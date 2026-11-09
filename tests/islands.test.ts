/**
 * Saw cuts, offcuts and the island check: what comes off, how much of it, and what stays.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGrid, hashGrid, recountSolid, stoneVolumeCm3, takeDirty } from '../shared/sculpt/grid.ts'
import { MIN_OFFCUT_CM3 } from '../shared/sculpt/islands.ts'
import { meshAll } from '../shared/sculpt/mesher.ts'
import { sampleDistance } from '../shared/sculpt/raycast.ts'
import { applyStrike } from '../shared/sculpt/strike.ts'
import type { CutStrike, Grid, Strike } from '../shared/sculpt/types.ts'
import { WATERTIGHT, edgeReport, meshVolume, normalAgreement, stitch, watertight, within } from './helpers.ts'

const DETACH: Strike = { kind: 'detach' }

function saw(point: [number, number, number], normal: [number, number, number]): Strike {
  return { kind: 'saw', plane: { point, normal }, ms: 1000 }
}

function flat(at: [number, number, number], dir: [number, number, number], size: number, depth: number, seed: number): CutStrike {
  return { kind: 'cut', tool: 'flat', at, dir, size, depth, seed, ms: 100 }
}

test('a sawn-off corner comes back as one offcut with the right volume', () => {
  const grid = createGrid()
  takeDirty(grid)
  const before = stoneVolumeCm3(grid)
  // The plane x + y + z = 140 cuts 20 cm along each edge from the corner (30, 100, 30): a
  // tetrahedron of 20³ / 6 cm³ with its centroid 5 cm in from the corner on every axis.
  const result = applyStrike(grid, saw([10, 100, 30], [1, 1, 1]))
  const expected = 20 * 20 * 20 / 6
  assert.equal(result.offcuts.length, 1)
  const offcut = result.offcuts[0]!
  assert.ok(within(offcut.cm3, expected, 0.02), `offcut ${offcut.cm3} cm³, expected ${expected}`)
  assert.ok(within(result.removedCm3, expected, 0.02), `removed ${result.removedCm3} cm³`)
  assert.ok(Math.abs(before - stoneVolumeCm3(grid) - result.removedCm3) < 1e-6)
  for (const [axis, want] of [[0, 25], [1, 95], [2, 25]] as const) {
    assert.ok(Math.abs(offcut.centroid[axis] - want) < 0.15, `centroid ${offcut.centroid}`)
  }

  // The offcut is a closed mesh of the piece itself, in block coordinates.
  assert.deepEqual(watertight(edgeReport(stitch([offcut]))), WATERTIGHT)
  assert.ok(within(meshVolume([offcut]), expected, 0.03), `offcut mesh encloses ${meshVolume([offcut])} cm³`)
  assert.ok(normalAgreement([offcut]) > 0.999)
  assert.equal(offcut.normals.length, offcut.positions.length)
  for (let v = 0; v < offcut.positions.length; v += 3) {
    const sum = offcut.positions[v]! + offcut.positions[v + 1]! + offcut.positions[v + 2]!
    if (sum < 139.5) assert.fail(`offcut vertex behind the saw plane (x + y + z = ${sum})`)
  }

  // What is left is closed too, with a new face where the corner was, and only the chunks
  // near the cut need remeshing.
  const meshes = meshAll(grid)
  assert.deepEqual(watertight(edgeReport(stitch(meshes))), WATERTIGHT)
  assert.ok(within(meshVolume(meshes), 360000 - expected, 0.002))
  assert.ok(sampleDistance(grid, 28, 98, 28) > 0 && sampleDistance(grid, 20, 90, 20) < 0)
  assert.ok(result.dirtyChunks.length > 0 && result.dirtyChunks.length <= 8, `${result.dirtyChunks.length} dirty chunks`)
  assert.deepEqual(takeDirty(grid), result.dirtyChunks.slice().sort((a, b) => a - b))
  assert.equal(grid.solidUnits, recountSolid(grid))
})

test('a slab sawn off the side of the block is 10 × 100 × 60 cm', () => {
  const grid = createGrid()
  const result = applyStrike(grid, saw([20, 50, 0], [1, 0, 0]))
  assert.equal(result.offcuts.length, 1)
  assert.ok(within(result.offcuts[0]!.cm3, 60000, 0.002), `slab ${result.offcuts[0]!.cm3} cm³`)
  assert.ok(within(stoneVolumeCm3(grid), 300000, 0.002))
  assert.ok(Math.abs(result.offcuts[0]!.centroid[0] - 25) < 0.05)
  assert.deepEqual(watertight(edgeReport(stitch([result.offcuts[0]!]))), WATERTIGHT)
  // The block is still standing on its base: nothing to detach.
  assert.deepEqual(applyStrike(grid, DETACH), { dirtyChunks: [], removedCm3: 0, offcuts: [] })
})

test('a saw that separates two pieces returns two offcuts', () => {
  const grid = createGrid({ width: 20, height: 30, depth: 20 })
  // A trench 8 cm deep down the middle of the top splits the upper part in two. A level cut
  // 6 cm down then frees a piece on each side of it.
  let seed = 0
  for (let z = -11; z <= 11; z += 1.5) applyStrike(grid, flat([0, 30, z], [0, -1, 0], 4, 8, seed++))
  const result = applyStrike(grid, saw([0, 24, 0], [0, 1, 0]))
  assert.equal(result.offcuts.length, 2)
  const a = result.offcuts[0]!
  const b = result.offcuts[1]!
  assert.ok(a.centroid[0] * b.centroid[0] < 0, 'one piece either side of the trench')
  assert.ok(within(a.cm3 + b.cm3, result.removedCm3, 0.01))
  for (const offcut of result.offcuts) assert.deepEqual(watertight(edgeReport(stitch([offcut]))), WATERTIGHT)
})

// A 20 × 30 × 20 block with a slot cut most of the way through at mid height from both
// sides, leaving the top joined to the bottom by a neck `neck` cm thick running front to back.
function slotted(neck: number): Grid {
  const grid = createGrid({ width: 20, height: 30, depth: 20 })
  let seed = 0
  for (let z = -11; z <= 11; z += 1) {
    applyStrike(grid, flat([10, 15, z], [-1, 0, 0], 6, 10 - neck / 2, seed++))
    applyStrike(grid, flat([-10, 15, z], [1, 0, 0], 6, 10 - neck / 2, seed++))
  }
  return grid
}

test('a thin bridge left standing is not detached', () => {
  const grid = slotted(1.2)
  // The slot is open on both sides of the neck, and the neck itself is stone, about three
  // voxels thick.
  assert.ok(sampleDistance(grid, 5, 15, 0) > 0 && sampleDistance(grid, -5, 15, 0) > 0)
  assert.ok(sampleDistance(grid, 0, 15, 0) < 0)
  assert.ok(sampleDistance(grid, 1, 15, 0) > 0 && sampleDistance(grid, -1, 15, 0) > 0, 'the neck is under 2 cm thick')

  const hash = hashGrid(grid)
  const result = applyStrike(grid, DETACH)
  assert.deepEqual(result, { dirtyChunks: [], removedCm3: 0, offcuts: [] })
  assert.equal(hashGrid(grid), hash, 'the check changed nothing')
  assert.ok(sampleDistance(grid, 0, 25, 0) < 0, 'the top is still there')
})

test('cutting the bridge detaches the top, which leaves the grid as an offcut', () => {
  const grid = slotted(1.2)
  takeDirty(grid)
  // One long cut from the front, straight along the neck.
  applyStrike(grid, flat([0, 15, 10], [0, 0, -1], 5, 21, 777))
  assert.ok(sampleDistance(grid, 0, 15, 0) > 0, 'the neck is gone')
  assert.ok(sampleDistance(grid, 0, 25, 0) < 0, 'the top floats until the island check runs')
  takeDirty(grid)

  const before = stoneVolumeCm3(grid)
  const result = applyStrike(grid, DETACH)
  assert.equal(result.offcuts.length, 1)
  const top = result.offcuts[0]!
  // The top is the 20 × 20 block above the slot: roughly 12 cm tall.
  assert.ok(top.cm3 > 4400 && top.cm3 < 5200, `top piece ${top.cm3} cm³`)
  assert.ok(within(result.removedCm3, top.cm3, 0.01), `removed ${result.removedCm3}, offcut ${top.cm3}`)
  assert.ok(Math.abs(before - stoneVolumeCm3(grid) - result.removedCm3) < 1e-6)
  assert.ok(Math.abs(top.centroid[0]) < 0.3 && Math.abs(top.centroid[2]) < 0.3 && Math.abs(top.centroid[1] - 24) < 1, `centroid ${top.centroid}`)
  assert.deepEqual(watertight(edgeReport(stitch([top]))), WATERTIGHT)
  assert.ok(within(meshVolume([top]), top.cm3, 0.02))

  // The stone above the slot has left the grid; the bottom half is untouched.
  assert.ok(sampleDistance(grid, 0, 25, 0) > 0 && sampleDistance(grid, 8, 28, 8) > 0)
  assert.ok(sampleDistance(grid, 0, 5, 0) < 0)
  assert.ok(result.dirtyChunks.length > 0)
  assert.deepEqual(takeDirty(grid), result.dirtyChunks.slice().sort((a, b) => a - b))
  assert.equal(grid.solidUnits, recountSolid(grid))
  const meshes = meshAll(grid)
  assert.deepEqual(watertight(edgeReport(stitch(meshes))), WATERTIGHT)
  assert.ok(within(meshVolume(meshes), stoneVolumeCm3(grid), 0.01))
  // Nothing more to find.
  assert.deepEqual(applyStrike(grid, DETACH), { dirtyChunks: [], removedCm3: 0, offcuts: [] })
})

test('pieces that only touch at an edge are not attached', () => {
  const grid = createGrid({ width: 8, height: 8, depth: 8 })
  // Hand-place a 4-voxel cube of stone in the air, touching the block's top corner edge to
  // edge (diagonally), with no shared face.
  const { nx, ny, dist } = grid
  const x = grid.nx / 2
  const top = grid.baseY + 20
  assert.ok(dist[x + nx * (top - 1 + ny * x)]! < 0 && dist[x + nx * (top + ny * x)]! > 0)
  const corner = grid.nx / 2 + 10
  for (let k = 0; k < 4; k++) {
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) dist[corner + i + nx * (top + j + ny * (x + k))] = -16
    }
  }
  grid.solidUnits = recountSolid(grid)
  const result = applyStrike(grid, DETACH)
  assert.equal(result.offcuts.length, 1)
  assert.ok(result.offcuts[0]!.cm3 > MIN_OFFCUT_CM3)
  assert.ok(within(stoneVolumeCm3(grid), 512, 0.001), 'the block itself is whole')
})

test('with the base gone, whatever stone sits lowest is what stays', () => {
  const grid = createGrid({ width: 20, height: 30, depth: 20 })
  // Saw away everything below y = 10 (normal pointing down). The block now starts at y = 10.
  const result = applyStrike(grid, saw([0, 10, 0], [0, -1, 0]))
  assert.equal(result.offcuts.length, 1)
  assert.ok(within(result.offcuts[0]!.cm3, 4000, 0.005))
  assert.deepEqual(applyStrike(grid, DETACH), { dirtyChunks: [], removedCm3: 0, offcuts: [] })
  assert.ok(within(stoneVolumeCm3(grid), 8000, 0.005))
})

test('the island check on the full-size block is quick and finds nothing', () => {
  const grid = createGrid()
  applyStrike(grid, DETACH)
  const start = performance.now()
  const result = applyStrike(grid, DETACH)
  const ms = performance.now() - start
  assert.deepEqual(result, { dirtyChunks: [], removedCm3: 0, offcuts: [] })
  assert.ok(ms < 100, `island check took ${ms.toFixed(1)} ms`)
})
