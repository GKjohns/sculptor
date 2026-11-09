/**
 * The mesher and the raycast: watertight meshes across chunk seams, dirty-chunk remeshing,
 * normals, baked finish, and rays against the stone.
 *
 * "Watertight" here is the plan's definition, checked on the whole stitched mesh: every edge
 * is shared by exactly two triangles (and they wind the same way). The mesh is closed all the
 * way round, base included: the grid keeps air under the block, so the underside at y = 0 is
 * meshed like any other face and there is no open rim for the test to excuse.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FINISH, chunkCount, createGrid, stoneVolumeCm3, takeDirty } from '../shared/sculpt/grid.ts'
import { meshAll, meshChunk } from '../shared/sculpt/mesher.ts'
import { raycast, sampleDistance } from '../shared/sculpt/raycast.ts'
import { createRng } from '../shared/sculpt/rng.ts'
import { declareForm } from '../shared/sculpt/shapes.ts'
import { applyStrike } from '../shared/sculpt/strike.ts'
import type { ChunkMesh, CutStrike, Grid, ToolId } from '../shared/sculpt/types.ts'
import { WATERTIGHT, edgeReport, meshVolume, normalAgreement, seamMismatches, stitch, watertight, within } from './helpers.ts'

function cut(tool: ToolId, at: [number, number, number], dir: [number, number, number], size: number, depth: number, seed = 1): CutStrike {
  return { kind: 'cut', tool, at, dir, size, depth, seed, ms: 100 }
}

// Chisels away the top front right corner of the default block, (30, 100, 30), with strikes
// from all three faces that meet there.
function chiselCorner(grid: Grid): number[] {
  const rng = createRng(5)
  const dirty = new Set<number>()
  for (let k = 0; k < 90; k++) {
    const face = k % 3
    const u = rng.range(0, 14)
    const v = rng.range(0, 14)
    const at: [number, number, number] = face === 0 ? [30 - u, 100, 30 - v] : face === 1 ? [30, 100 - u, 30 - v] : [30 - u, 100 - v, 30]
    const dir: [number, number, number] = face === 0 ? [0.2, -1, 0.2] : face === 1 ? [-1, 0.2, 0.2] : [0.2, 0.2, -1]
    const result = applyStrike(grid, cut(k % 2 === 0 ? 'point' : 'flat', at, dir, rng.range(3, 7), rng.range(1, 4), k))
    for (const id of result.dirtyChunks) dirty.add(id)
  }
  return [...dirty]
}

test('the untouched block meshes as one closed surface, base included', () => {
  const grid = createGrid()
  const meshes = meshAll(grid)
  assert.ok(meshes.length > 100 && meshes.length < chunkCount(grid), 'the surface spans many chunks; interior chunks are empty')
  const report = edgeReport(stitch(meshes))
  assert.ok(report.triangles > 300000)
  assert.deepEqual(watertight(report), WATERTIGHT)
  assert.ok(within(meshVolume(meshes), 360000, 0.002), `mesh encloses ${meshVolume(meshes)} cm³`)
  assert.equal(normalAgreement(meshes), 1)

  // The base is really there: a sheet of downward-facing vertices at y = 0, 60 cm square.
  let below = 0
  let minY = Infinity
  for (const m of meshes) {
    for (let v = 0; v < m.positions.length; v += 3) {
      minY = Math.min(minY, m.positions[v + 1]!)
      if (Math.abs(m.positions[v + 1]!) < 1e-4 && m.normals[v + 1]! < -0.99) below++
    }
  }
  assert.ok(Math.abs(minY) < 1e-4, `lowest vertex at y = ${minY}`)
  assert.ok(below > 148 * 148, `${below} base vertices`)
})

test('a block with one corner chiselled is watertight across chunk seams', () => {
  const grid = createGrid()
  const before = stoneVolumeCm3(grid)
  const dirty = chiselCorner(grid)
  assert.ok(dirty.length >= 4, `the corner work spans ${dirty.length} chunks`)
  assert.ok(before - stoneVolumeCm3(grid) > 500, `chiselled off ${before - stoneVolumeCm3(grid)} cm³`)

  const meshes = meshAll(grid)
  const stitched = stitch(meshes)
  assert.deepEqual(watertight(edgeReport(stitched)), WATERTIGHT)
  assert.ok(within(meshVolume(meshes), stoneVolumeCm3(grid), 0.002), `mesh ${meshVolume(meshes)} vs grid ${stoneVolumeCm3(grid)}`)
  // Each seam vertex exists once per chunk that uses it, and every copy carries the same
  // normal and finish, so shading does not break at chunk boundaries.
  const seams = seamMismatches(meshes, stitched)
  assert.ok(seams.shared > 5000, `${seams.shared} seam vertices`)
  assert.equal(seams.mismatched, 0)
  assert.ok(normalAgreement(meshes) > 0.999)
  for (const m of meshes) {
    for (let v = 0; v < m.normals.length; v += 3) {
      const len = Math.hypot(m.normals[v]!, m.normals[v + 1]!, m.normals[v + 2]!)
      if (Math.abs(len - 1) > 1e-4) assert.fail(`normal of length ${len}`)
    }
  }
})

test('strikes on the line where four chunks meet leave no cracks', () => {
  const grid = createGrid()
  // Samples x = 128 and z = 128 are chunk boundaries; on the top face that is (19.4, 100, 19.4).
  const rng = createRng(8)
  for (let k = 0; k < 40; k++) {
    const at: [number, number, number] = [19.4 + rng.range(-3, 3), 100, 19.4 + rng.range(-3, 3)]
    applyStrike(grid, cut(k % 2 === 0 ? 'point' : 'flat', at, [rng.range(-0.3, 0.3), -1, rng.range(-0.3, 0.3)], rng.range(2, 5), rng.range(0.5, 3), k))
  }
  // And one deep cut exactly through the point where eight chunks meet inside the stone.
  applyStrike(grid, cut('point', [19.4, 100, 19.4], [0, -1, 0], 6, 12, 99))
  assert.ok(sampleDistance(grid, 19.4, 89.6, 19.4) > 0, 'the cut reaches the eight-chunk corner at sample y = 224')
  const meshes = meshAll(grid)
  assert.deepEqual(watertight(edgeReport(stitch(meshes))), WATERTIGHT)
})

test('a long mixed session (chisels, rasp, saw, protection, island checks) still meshes watertight', () => {
  const grid = createGrid()
  declareForm(grid, 'keep', {
    shapes: [
      { kind: 'ellipsoid', center: [0, 60, 0], size: [30, 50, 26], rotation: [0, 0, 15] },
      { kind: 'capsule', center: [0, 25, 0], size: [16, 50, 16], rotation: [0, 0, 0] }
    ],
    blend: 4
  })
  const rng = createRng(21)
  const tools: ToolId[] = ['point', 'flat', 'point', 'rasp']
  let offcuts = 0
  for (let k = 0; k < 1500; k++) {
    // Strike wherever a ray from a random direction first meets the stone, along the
    // surface normal, so the work follows the stone inward as it is cut back.
    const from: [number, number, number] = [rng.range(-60, 60), rng.range(20, 130), rng.range(-60, 60)]
    const hit = raycast(grid, from, [rng.range(-10, 10) - from[0], rng.range(30, 90) - from[1], rng.range(-10, 10) - from[2]])
    if (!hit) continue
    const strike = cut(tools[k % 4]!, hit.point, [-hit.normal[0], -hit.normal[1], -hit.normal[2]], rng.range(2, 9), rng.range(0.3, 5), k)
    applyStrike(grid, k % 3 === 0 ? strike : { ...strike, protect: 'keep' })
    if (k === 400) offcuts += applyStrike(grid, { kind: 'saw', plane: { point: [18, 100, 0], normal: [1, 0.6, 0.1] }, ms: 900 }).offcuts.length
    if (k % 250 === 249) offcuts += applyStrike(grid, { kind: 'detach' }).offcuts.length
  }
  assert.ok(offcuts >= 1)
  assert.ok(stoneVolumeCm3(grid) < 345000, `${stoneVolumeCm3(grid)} cm³ left`)
  const meshes = meshAll(grid)
  assert.deepEqual(watertight(edgeReport(stitch(meshes))), WATERTIGHT)
  assert.ok(within(meshVolume(meshes), stoneVolumeCm3(grid), 0.005), `mesh ${meshVolume(meshes)} vs grid ${stoneVolumeCm3(grid)}`)
})

test('remeshing only the dirty chunks gives exactly the full remesh', () => {
  const grid = createGrid()
  const cache = new Map<number, ChunkMesh>()
  for (const id of takeDirty(grid)) cache.set(id, meshChunk(grid, id))

  const reported = chiselCorner(grid)
  const dirty = takeDirty(grid)
  assert.deepEqual(reported.slice().sort((a, b) => a - b), dirty, 'per-strike dirtyChunks add up to takeDirty')
  assert.ok(dirty.length < 30, `only ${dirty.length} of 200 chunks need remeshing`)
  for (const id of dirty) cache.set(id, meshChunk(grid, id))

  for (let id = 0; id < chunkCount(grid); id++) {
    const fresh = meshChunk(grid, id)
    const kept = cache.get(id)!
    assert.deepEqual(kept.positions, fresh.positions, `chunk ${id} positions`)
    assert.deepEqual(kept.normals, fresh.normals, `chunk ${id} normals`)
    assert.deepEqual(kept.finish, fresh.finish, `chunk ${id} finish`)
    assert.deepEqual(kept.indices, fresh.indices, `chunk ${id} indices`)
  }
})

test('chunk meshes carry a finish value per vertex, exactly sized and ready to transfer', () => {
  const grid = createGrid()
  applyStrike(grid, cut('flat', [0, 100, 0], [0, -1, 0], 8, 2))
  applyStrike(grid, cut('point', [15, 100, 0], [0, -1, 0], 6, 3))
  const meshes = meshAll(grid)
  const seen = { sawn: 0, flat: 0, point: 0 }
  for (const m of meshes) {
    const vertices = m.finish.length
    assert.equal(m.positions.length, vertices * 3)
    assert.equal(m.normals.length, vertices * 3)
    assert.equal(m.indices.length % 3, 0)
    assert.equal(m.positions.byteOffset, 0)
    assert.equal(m.positions.buffer.byteLength, m.positions.byteLength)
    for (let v = 0; v < vertices; v++) {
      const x = m.positions[3 * v]!
      const y = m.positions[3 * v + 1]!
      const z = m.positions[3 * v + 2]!
      if (y > 97 && y < 99.5 && Math.hypot(x, z) < 2.5) {
        assert.equal(m.finish[v], FINISH.flat, `floor of the flat cut at (${x}, ${y}, ${z})`)
        seen.flat++
      } else if (y > 96 && y < 99.5 && Math.hypot(x - 15, z) < 1) {
        assert.equal(m.finish[v], FINISH.point)
        seen.point++
      } else if (Math.hypot(x, z) > 6 && Math.hypot(x - 15, z) > 5) {
        assert.equal(m.finish[v], FINISH.sawn)
        seen.sawn++
      }
    }
  }
  assert.ok(seen.flat > 50 && seen.point > 5 && seen.sawn > 100000, JSON.stringify(seen))
})

test('a ray finds the first surface it meets, with its normal', () => {
  const grid = createGrid()
  const top = raycast(grid, [3.3, 150, -7.1], [0, -1, 0])!
  assert.ok(Math.abs(top.point[1] - 100) < 0.02, `top face at y = ${top.point[1]}`)
  assert.ok(Math.abs(top.distance - 50) < 0.02)
  assert.ok(top.normal[1] > 0.999)
  assert.deepEqual([top.point[0], top.point[2]], [3.3, -7.1])

  // Unnormalised, oblique, from the front right: enters through the front face (z = 30).
  const oblique = raycast(grid, [40, 60, 80], [-2, -1, -5])!
  assert.ok(Math.abs(oblique.point[2] - 30) < 0.02, `front face at z = ${oblique.point[2]}`)
  assert.ok(oblique.normal[2] > 0.999)
  assert.ok(Math.abs(oblique.point[0] - 20) < 0.02 && Math.abs(oblique.point[1] - 50) < 0.02)

  assert.equal(raycast(grid, [45, 150, 0], [0, -1, 0]), null, 'beside the block')
  assert.equal(raycast(grid, [0, 150, 0], [0, 1, 0]), null, 'pointing away')
  assert.equal(raycast(grid, [0, 150, 0], [0, -1, 0], 30), null, 'out of reach')
  assert.equal(raycast(grid, [0, 50, 0], [1, 0, 0])!.distance, 0, 'starting inside the stone')

  // After a flat cut 2 cm deep, the ray lands on its floor.
  applyStrike(grid, cut('flat', [0, 100, 0], [0, -1, 0], 8, 2))
  const floor = raycast(grid, [0, 150, 0], [0, -1, 0])!
  assert.ok(Math.abs(floor.point[1] - 98) < 0.3, `floor of the cut at y = ${floor.point[1]}`)
  assert.ok(floor.normal[1] > 0.9)
})
