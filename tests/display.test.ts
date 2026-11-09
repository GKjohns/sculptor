/**
 * The stone on screen may drop loose pieces before the log's own island check does. The log's
 * stone must not notice: same hash with or without the early checks, and once the log's check
 * has run, what is drawn is the log's stone again, chunk for chunk.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDisplayStone } from '../shared/sculpt/display.ts'
import { chunkCount, createGrid, hashGrid, takeDirty } from '../shared/sculpt/grid.ts'
import { meshChunk } from '../shared/sculpt/mesher.ts'
import { createRng } from '../shared/sculpt/rng.ts'
import { applyStrike } from '../shared/sculpt/strike.ts'
import type { Grid, Strike, ToolId, Vec3 } from '../shared/sculpt/types.ts'

const BLOCK = { width: 16, height: 24, depth: 16, voxel: 0.4, chunk: 16 }
const DETACH: Strike = { kind: 'detach' }

// Heavy strikes into a small block from its four sides and its top, in passes that each end
// with the log's island check. Bites this deep meet in the middle, so pieces come loose well
// before their pass ends and later strikes of the same pass go through them.
function log(seed: number, passes: number): Strike[] {
  const rng = createRng(seed)
  const tools: ToolId[] = ['point', 'claw', 'flat', 'point', 'rasp']
  const out: Strike[] = []
  for (let p = 0; p < passes; p++) {
    const tool = tools[p % tools.length]!
    if (p === 2) out.push({ kind: 'form', name: 'core', shapes: [{ kind: 'ellipsoid', center: [0, 8, 0], size: [8, 14, 8], rotation: [0, 0, 0] }], blend: 0 })
    const n = 30 + rng.int(40)
    for (let k = 0; k < n; k++) {
      const face = rng.int(5)
      const u = rng.range(-7, 7)
      const y = rng.range(3, 23)
      const sign = face % 2 === 0 ? 1 : -1
      const at: Vec3 = face < 2 ? [u, y, sign * 8] : face < 4 ? [sign * 8, y, u] : [u, 24, rng.range(-7, 7)]
      const dir: Vec3 = face < 2 ? [0, rng.range(-0.3, 0.3), -sign] : face < 4 ? [-sign, rng.range(-0.3, 0.3), 0] : [0, -1, 0]
      out.push({ kind: 'cut', tool, at, dir, size: rng.range(4, 8), depth: tool === 'rasp' ? 0.6 : rng.range(3, 7), seed: rng.int(1 << 30), ...(p >= 2 && k % 3 === 0 ? { protect: 'core', margin: 1 } : {}), ms: 200 })
    }
    if (p % 3 === 1) out.push({ kind: 'saw', plane: { point: [rng.range(-6, 6), 20 - p, 0], normal: [rng.range(-0.4, 0.4), 1, rng.range(-0.4, 0.4)] }, ms: 1500 })
    out.push(DETACH)
  }
  return out
}

function digest(grid: Grid, chunk: number): string {
  const m = meshChunk(grid, chunk)
  let h = m.indices.length
  const words = new Uint32Array(m.positions.buffer, m.positions.byteOffset, m.positions.length)
  for (let i = 0; i < words.length; i++) h = (Math.imul(h, 31) + words[i]!) | 0
  for (let i = 0; i < m.finish.length; i++) h = (Math.imul(h, 31) + m.finish[i]!) | 0
  for (let i = 0; i < m.indices.length; i++) h = (Math.imul(h, 31) + m.indices[i]!) | 0
  return `${m.indices.length}:${h}`
}

for (const seed of [11, 12, 13]) {
  test(`early island checks leave the log's stone and the finished mesh alone (seed ${seed})`, () => {
    const strikes = log(seed, 9)

    const plain = createGrid(BLOCK)
    for (const s of strikes) applyStrike(plain, s)

    const stone = createDisplayStone(createGrid(BLOCK))
    const rng = createRng(seed * 7919)
    // The mesh as a page would hold it: remeshed only where the drawn grid says it is stale.
    const meshes = new Map<number, string>()
    const flush = () => {
      const g = stone.drawn()
      for (const id of takeDirty(g)) meshes.set(id, digest(g, id))
    }
    let early = 0
    let splits = 0
    for (const s of strikes) {
      stone.apply(s)
      if (s.kind === 'detach') {
        assert.equal(stone.split(), false, 'the copy is dropped at the log\'s own check')
        assert.equal(stone.drawn(), stone.grid)
      } else if (rng.int(4) === 0) {
        const before = stone.split()
        early += stone.settle().length
        if (!before && stone.split()) splits++
      }
      if (rng.int(3) === 0) flush()
    }
    flush()

    assert.ok(splits > 0 && early > 0, `the log never left a piece hanging (splits ${splits}, pieces ${early}); the test proves nothing`)
    assert.equal(hashGrid(stone.grid), hashGrid(plain), 'the log\'s stone has the log\'s hash')
    assert.equal(stone.grid.solidUnits, plain.solidUnits)
    for (let id = 0; id < chunkCount(plain); id++) {
      assert.equal(meshes.get(id), digest(plain, id), `chunk ${id} on screen is not the log's stone`)
    }
  })
}

test('with nothing hanging, a check changes nothing and draws the log\'s stone', () => {
  const stone = createDisplayStone(createGrid(BLOCK))
  takeDirty(stone.grid)
  stone.apply({ kind: 'cut', tool: 'point', at: [0, 12, 8], dir: [0, 0, -1], size: 3, depth: 1.5, seed: 5, ms: 200 })
  assert.deepEqual(stone.settle(), [])
  assert.equal(stone.split(), false)
  assert.ok(takeDirty(stone.drawn()).length > 0)
})

test('a piece cut free falls at the check, once, and not again at the end of the pass', () => {
  const stone = createDisplayStone(createGrid(BLOCK))
  // Bites all the way through at one height leave the top standing on nothing.
  for (let z = 8; z >= -9; z -= 1.5) {
    for (let x = -8; x <= 8; x += 1.5) stone.apply({ kind: 'cut', tool: 'point', at: [x, 14, z], dir: [0, 0, -1], size: 4, depth: 3, seed: 3, ms: 200 })
  }
  const before = stone.grid.solidUnits
  const fell = stone.settle()
  assert.ok(fell.length >= 1, 'the top came loose')
  assert.ok(stone.split())
  assert.equal(stone.grid.solidUnits, before, 'the log\'s stone still holds the piece')
  assert.ok(stone.drawn().solidUnits < before, 'the drawn stone does not')
  assert.deepEqual(stone.settle(), [], 'nothing new is loose')
  const end = stone.apply(DETACH)
  assert.deepEqual(end.offcuts, [], 'the piece is not dropped twice')
  assert.ok(end.removedCm3 > 0, 'the log\'s stone lets go of it here')
  assert.equal(stone.split(), false)
})
