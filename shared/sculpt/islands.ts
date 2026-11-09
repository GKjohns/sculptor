import { OCC, Q_MAX, markDirtyBox, unitsToCm3 } from './grid.ts'
import { surfaceNets } from './mesher.ts'
import type { Grid, Offcut, StrikeResult } from './types.ts'

// Connected pieces of stone, found at full resolution. Stone is cut into runs (unbroken
// stretches of stone along X), runs that touch in the row above or behind are merged with a
// union-find, and whatever is not merged with the stone standing on the banker is loose.
// Voxels are connected through faces only; pieces touching at an edge or corner are apart.

// Loose pieces smaller than this are dust: they leave the grid and count as removed stone,
// but no offcut mesh is built for them.
export const MIN_OFFCUT_CM3 = 0.5

// Air kept around an offcut's own field: what surfaceNets needs, plus one.
const PAD = 3

let runX0 = new Int32Array(1 << 16)
let runX1 = new Int32Array(1 << 16)
let runRow = new Int32Array(1 << 16)
let parent = new Int32Array(1 << 16)
let rowStart = new Int32Array(0)
let nRuns = 0

function addRun(x0: number, x1: number, row: number): void {
  if (nRuns === runX0.length) {
    const cap = nRuns * 2
    const a = new Int32Array(cap)
    a.set(runX0)
    runX0 = a
    const b = new Int32Array(cap)
    b.set(runX1)
    runX1 = b
    const c = new Int32Array(cap)
    c.set(runRow)
    runRow = c
    parent = new Int32Array(cap)
  }
  runX0[nRuns] = x0
  runX1[nRuns] = x1
  runRow[nRuns] = row
  nRuns++
}

// The sign bits of four samples at once.
const SIGNS = 0x80808080 | 0

// Needs nx to be a multiple of 4 and the buffer to start on a 4-byte boundary, so whole
// words of all-stone or all-air can be stepped over.
function scanRuns(dist: Int8Array, nx: number, rows: number): void {
  if (rowStart.length < rows + 1) rowStart = new Int32Array(rows + 1)
  const words = new Int32Array(dist.buffer, dist.byteOffset, dist.length >> 2)
  const perRow = nx >> 2
  nRuns = 0
  for (let row = 0; row < rows; row++) {
    rowStart[row] = nRuns
    const base = row * nx
    const wordBase = row * perRow
    let open = -1
    for (let w = 0; w < perRow; w++) {
      const signs = words[wordBase + w]! & SIGNS
      if (signs === 0) {
        if (open >= 0) {
          addRun(open, w * 4, row)
          open = -1
        }
      } else if (signs === SIGNS) {
        if (open < 0) open = w * 4
      } else {
        for (let x = w * 4; x < w * 4 + 4; x++) {
          if (dist[base + x]! < 0) {
            if (open < 0) open = x
          } else if (open >= 0) {
            addRun(open, x, row)
            open = -1
          }
        }
      }
    }
    if (open >= 0) addRun(open, nx, row)
  }
  rowStart[rows] = nRuns
}

function find(i: number): number {
  while (parent[i]! !== i) {
    parent[i] = parent[parent[i]!]!
    i = parent[i]!
  }
  return i
}

function union(a: number, b: number): void {
  const ra = find(a)
  const rb = find(b)
  if (ra < rb) parent[rb] = ra
  else if (rb < ra) parent[ra] = rb
}

// Merges every pair of runs in two neighbouring rows that share an x.
function linkRows(a: number, b: number): void {
  let i = rowStart[a]!
  let j = rowStart[b]!
  const ie = rowStart[a + 1]!
  const je = rowStart[b + 1]!
  while (i < ie && j < je) {
    if (runX1[i]! <= runX0[j]!) {
      i++
    } else if (runX1[j]! <= runX0[i]!) {
      j++
    } else {
      union(i, j)
      if (runX1[i]! < runX1[j]!) i++
      else j++
    }
  }
}

function labelRuns(dist: Int8Array, nx: number, ny: number, nz: number): void {
  if (nx % 4 !== 0 || dist.byteOffset % 4 !== 0) throw new Error('field rows must be 4-byte aligned')
  scanRuns(dist, nx, ny * nz)
  for (let i = 0; i < nRuns; i++) parent[i] = i
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const row = y + ny * z
      if (rowStart[row] === rowStart[row + 1]) continue
      if (y > 0) linkRows(row, row - 1)
      if (z > 0) linkRows(row, row - ny)
    }
  }
}

// Runs grouped by piece, leaving out the piece rooted at skipRoot. Pieces come out in the
// order their first run was scanned, which is fixed for a given grid.
function groupRuns(skipRoot: number): number[][] {
  const groups = new Map<number, number[]>()
  for (let r = 0; r < nRuns; r++) {
    const root = find(r)
    if (root === skipRoot) continue
    const group = groups.get(root)
    if (group) group.push(r)
    else groups.set(root, [r])
  }
  return [...groups.values()]
}

function voxelCount(runs: number[]): number {
  let n = 0
  for (let k = 0; k < runs.length; k++) n += runX1[runs[k]!]! - runX0[runs[k]!]!
  return n
}

interface Box {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

function boundsOf(runs: number[], ny: number): Box {
  const box = { minX: 1e9, minY: 1e9, minZ: 1e9, maxX: -1, maxY: -1, maxZ: -1 }
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k]!
    const row = runRow[r]!
    const y = row % ny
    const z = (row - y) / ny
    if (runX0[r]! < box.minX) box.minX = runX0[r]!
    if (runX1[r]! - 1 > box.maxX) box.maxX = runX1[r]! - 1
    if (y < box.minY) box.minY = y
    if (y > box.maxY) box.maxY = y
    if (z < box.minZ) box.minZ = z
    if (z > box.maxZ) box.maxZ = z
  }
  return box
}

// Lifts one piece out of a field into a field of its own (its stone plus the ring of air
// samples that say exactly where its surface is), then measures and meshes it. The source
// field needs a sample of padding on every side of the piece.
function buildOffcut(
  dist: Int8Array, nx: number, ny: number, runs: number[],
  gx: number, gy: number, gz: number,
  ox: number, oy: number, oz: number, voxel: number
): Offcut {
  const box = boundsOf(runs, ny)
  const bx = box.maxX - box.minX + 1 + 2 * PAD
  const by = box.maxY - box.minY + 1 + 2 * PAD
  const bz = box.maxZ - box.minZ + 1 + 2 * PAD
  const bxy = bx * by
  const sub = new Int8Array(bxy * bz).fill(Q_MAX)
  // Field index = source index mapped through this shift, row by row.
  const sx = PAD - box.minX
  const sy = PAD - box.minY
  const sz = PAD - box.minZ
  const nxy = nx * ny
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k]!
    const x0 = runX0[r]!
    const x1 = runX1[r]!
    const row = runRow[r]!
    const y = row % ny
    const z = (row - y) / ny
    const src = nx * row
    const dst = sx + bx * (y + sy) + bxy * (z + sz)
    for (let x = x0 - 1; x <= x1; x++) sub[dst + x] = dist[src + x]!
    // Face neighbours in the four rows around are either air or more of this piece.
    for (let x = x0; x < x1; x++) {
      sub[dst + x - bx] = dist[src + x - nx]!
      sub[dst + x + bx] = dist[src + x + nx]!
      sub[dst + x - bxy] = dist[src + x - nxy]!
      sub[dst + x + bxy] = dist[src + x + nxy]!
    }
  }

  let units = 0
  let mx = 0
  let my = 0
  let mz = 0
  let j = 0
  for (let z = 0; z < bz; z++) {
    for (let y = 0; y < by; y++) {
      for (let x = 0; x < bx; x++, j++) {
        const occ = OCC[sub[j]! + 128]!
        if (occ === 0) continue
        units += occ
        mx += occ * x
        my += occ * y
        mz += occ * z
      }
    }
  }
  const mesh = surfaceNets(
    sub, null, bx, by, bz,
    2, 2, 2, bx - 2, by - 2, bz - 2,
    gx - sx, gy - sy, gz - sz, ox, oy, oz, voxel
  )
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    indices: mesh.indices,
    centroid: [
      ox + (gx - sx + mx / units) * voxel,
      oy + (gy - sy + my / units) * voxel,
      oz + (gz - sz + mz / units) * voxel
    ],
    cm3: units * voxel * voxel * voxel / 254
  }
}

// Every connected piece of stone in a free-standing field, as offcuts. Used for what a saw
// cut takes off. Sample (0, 0, 0) of the field is grid sample (gx, gy, gz); nx must be a
// multiple of 4 and the stone must sit at least two samples in from every side.
export function extractOffcuts(
  dist: Int8Array, nx: number, ny: number, nz: number,
  gx: number, gy: number, gz: number,
  ox: number, oy: number, oz: number, voxel: number
): Offcut[] {
  labelRuns(dist, nx, ny, nz)
  const offcuts: Offcut[] = []
  const pieces = groupRuns(-1)
  const voxelCm3 = voxel * voxel * voxel
  for (let p = 0; p < pieces.length; p++) {
    const runs = pieces[p]!
    if (voxelCount(runs) * voxelCm3 < MIN_OFFCUT_CM3) continue
    offcuts.push(buildOffcut(dist, nx, ny, runs, gx, gy, gz, ox, oy, oz, voxel))
  }
  return offcuts
}

// Turns an air sample next to removed stone into open air, unless it also borders stone
// that is staying, in which case its value still places that stone's surface.
function clearHalo(grid: Grid, j: number): void {
  const { dist, nx } = grid
  const v = dist[j]!
  if (v < 0 || v === Q_MAX) return
  const nxy = nx * grid.ny
  if (dist[j - 1]! < 0 || dist[j + 1]! < 0 || dist[j - nx]! < 0 || dist[j + nx]! < 0) return
  if (dist[j - nxy]! < 0 || dist[j + nxy]! < 0) return
  grid.solidUnits -= OCC[v + 128]!
  dist[j] = Q_MAX
}

// The island check. Stone connected to the lowest layer of stone (the base, standing on the
// banker) stays. Everything else leaves the grid and comes back as offcuts.
export function detachIslands(grid: Grid): StrikeResult {
  const { dist, nx, ny, nz } = grid
  const result: StrikeResult = { dirtyChunks: [], removedCm3: 0, offcuts: [] }
  labelRuns(dist, nx, ny, nz)
  if (nRuns === 0) return result

  let anchor = -1
  for (let y = 0; y < ny && anchor < 0; y++) {
    for (let z = 0; z < nz; z++) {
      const row = y + ny * z
      for (let r = rowStart[row]!; r < rowStart[row + 1]!; r++) {
        if (anchor < 0) anchor = r
        else union(anchor, r)
      }
    }
  }
  const pieces = groupRuns(find(anchor))
  if (pieces.length === 0) return result

  // Build every offcut before anything is removed, so each sees the stone as it was.
  const voxelCm3 = grid.voxel * grid.voxel * grid.voxel
  for (let p = 0; p < pieces.length; p++) {
    const runs = pieces[p]!
    if (voxelCount(runs) * voxelCm3 < MIN_OFFCUT_CM3) continue
    result.offcuts.push(buildOffcut(dist, nx, ny, runs, 0, 0, 0, grid.x0, grid.y0, grid.z0, grid.voxel))
  }

  const before = grid.solidUnits
  let units = before
  for (let p = 0; p < pieces.length; p++) {
    const runs = pieces[p]!
    for (let k = 0; k < runs.length; k++) {
      const r = runs[k]!
      const src = nx * runRow[r]!
      for (let x = runX0[r]!; x < runX1[r]!; x++) {
        units -= OCC[dist[src + x]! + 128]!
        dist[src + x] = Q_MAX
      }
    }
  }
  grid.solidUnits = units
  const nxy = nx * ny
  for (let p = 0; p < pieces.length; p++) {
    const runs = pieces[p]!
    for (let k = 0; k < runs.length; k++) {
      const r = runs[k]!
      const x0 = runX0[r]!
      const x1 = runX1[r]!
      const src = nx * runRow[r]!
      clearHalo(grid, src + x0 - 1)
      clearHalo(grid, src + x1)
      for (let x = x0; x < x1; x++) {
        clearHalo(grid, src + x - nx)
        clearHalo(grid, src + x + nx)
        clearHalo(grid, src + x - nxy)
        clearHalo(grid, src + x + nxy)
      }
    }
    const box = boundsOf(runs, ny)
    markDirtyBox(
      grid, box.minX - 1, box.minY - 1, box.minZ - 1,
      box.maxX + 1, box.maxY + 1, box.maxZ + 1, result.dirtyChunks
    )
  }
  result.removedCm3 = unitsToCm3(grid, before - grid.solidUnits)
  return result
}
