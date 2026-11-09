import { Q_MAX, chunkCoords, chunkCount } from './grid.ts'
import type { ChunkMesh, Grid, MeshData } from './types.ts'

// Naive surface nets. Every cell (the cube between eight neighbouring samples) that the
// surface passes through gets one vertex, and every sample-to-sample edge that crosses the
// surface gets one quad joining the four cells around it.
//
// A chunk emits the quads for the edges that start at its own samples, so each quad comes
// from exactly one chunk. The cells one step below the chunk supply some of those quads'
// corners, so their vertices are rebuilt here too; they come out bit-identical to the
// neighbouring chunk's copies because both read the same samples through the same
// arithmetic. That, and normals taken from the distance gradient instead of from triangles,
// is what makes seams invisible.
//
// The mesh is closed, base included: the grid keeps air under the block, so the underside is
// meshed like any other face.

// Output buffers and the field being meshed live at module level so the per-vertex and
// per-quad functions need no closures and no allocation. The mesher is not re-entrant.
let vPos = new Float32Array(3 * 8192)
let vNrm = new Float32Array(3 * 8192)
let vFin = new Uint8Array(8192)
let tris = new Uint32Array(6 * 8192)
let nVert = 0
let nIdx = 0
let cellVert = new Int32Array(0)

const NO_FIELD = new Int8Array(0)
let fDist: Int8Array = NO_FIELD
let fFinish: Uint8Array | null = null
let fSx = 0
let fSxy = 0
let fGx = 0
let fGy = 0
let fGz = 0
let fOx = 0
let fOy = 0
let fOz = 0
let fVoxel = 1

// Cell corners are numbered x + 2y + 4z; these are the twelve edges as corner pairs.
const EDGE_A = new Uint8Array([0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3])
const EDGE_B = new Uint8Array([1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7])
const corner = new Float64Array(8)

function growVertices(): void {
  const cap = vFin.length * 2
  const pos = new Float32Array(cap * 3)
  pos.set(vPos)
  vPos = pos
  const nrm = new Float32Array(cap * 3)
  nrm.set(vNrm)
  vNrm = nrm
  const fin = new Uint8Array(cap)
  fin.set(vFin)
  vFin = fin
}

function growIndices(): void {
  const idx = new Uint32Array(tris.length * 2)
  idx.set(tris)
  tris = idx
}

// The vertex for cell c (indexed by its lowest corner sample), created on first use.
function vertexAt(c: number): number {
  const known = cellVert[c]!
  if (known >= 0) return known
  const d = fDist
  const sx = fSx
  const sxy = fSxy
  // A stored distance of exactly zero counts as air, and is nudged off zero here. Left at
  // zero it would put the crossing exactly on the sample, where the cells around it could
  // all place their vertex, and the mesh would grow zero-area triangles there.
  for (let k = 0; k < 8; k++) {
    const v = d[c + (k & 1) + ((k >> 1) & 1) * sx + (k >> 2) * sxy]!
    corner[k] = v === 0 ? 0.5 : v
  }

  // Position: the mean of the points where the surface crosses the cell's edges.
  let px = 0
  let py = 0
  let pz = 0
  let crossings = 0
  for (let e = 0; e < 12; e++) {
    const ia = EDGE_A[e]!
    const ib = EDGE_B[e]!
    const a = corner[ia]!
    const b = corner[ib]!
    if ((a < 0) === (b < 0)) continue
    const t = a / (a - b)
    const axis = e >> 2
    px += (ia & 1) + (axis === 0 ? t : 0)
    py += ((ia >> 1) & 1) + (axis === 1 ? t : 0)
    pz += (ia >> 2) + (axis === 2 ? t : 0)
    crossings++
  }
  px /= crossings
  py /= crossings
  pz /= crossings

  // Normal: the gradient of the distance field (central differences at the eight corners,
  // blended to the vertex), which points out of the stone.
  let gx = 0
  let gy = 0
  let gz = 0
  let finish = 0
  let solid = 0
  const f = fFinish
  for (let k = 0; k < 8; k++) {
    const kx = k & 1
    const ky = (k >> 1) & 1
    const kz = k >> 2
    const j = c + kx + ky * sx + kz * sxy
    const w = (kx === 1 ? px : 1 - px) * (ky === 1 ? py : 1 - py) * (kz === 1 ? pz : 1 - pz)
    gx += w * (d[j + 1]! - d[j - 1]!)
    gy += w * (d[j + sx]! - d[j - sx]!)
    gz += w * (d[j + sxy]! - d[j - sxy]!)
    if (f !== null && corner[k]! < 0) {
      finish += f[j]!
      solid++
    }
  }
  const len = Math.sqrt(gx * gx + gy * gy + gz * gz)
  if (len > 0) {
    gx /= len
    gy /= len
    gz /= len
  } else {
    gy = 1
  }

  if (nVert === vFin.length) growVertices()
  const cz = Math.floor(c / sxy)
  const rest = c - cz * sxy
  const cy = Math.floor(rest / sx)
  const cx = rest - cy * sx
  const v = nVert++
  vPos[3 * v] = fOx + (fGx + cx + px) * fVoxel
  vPos[3 * v + 1] = fOy + (fGy + cy + py) * fVoxel
  vPos[3 * v + 2] = fOz + (fGz + cz + pz) * fVoxel
  vNrm[3 * v] = gx
  vNrm[3 * v + 1] = gy
  vNrm[3 * v + 2] = gz
  vFin[v] = solid > 0 ? Math.round(finish / solid) : 0
  cellVert[c] = v
  return v
}

// One quad over the four cells around a crossing edge, given in the order that winds
// counter-clockwise seen from the edge's far end. outward says the far end is the air side.
function quad(c0: number, c1: number, c2: number, c3: number, outward: boolean): void {
  const v0 = vertexAt(c0)
  const v1 = vertexAt(c1)
  const v2 = vertexAt(c2)
  const v3 = vertexAt(c3)
  if (nIdx + 6 > tris.length) growIndices()
  // Split along the shorter diagonal.
  const p = vPos
  let dx = p[3 * v0]! - p[3 * v2]!
  let dy = p[3 * v0 + 1]! - p[3 * v2 + 1]!
  let dz = p[3 * v0 + 2]! - p[3 * v2 + 2]!
  const d02 = dx * dx + dy * dy + dz * dz
  dx = p[3 * v1]! - p[3 * v3]!
  dy = p[3 * v1 + 1]! - p[3 * v3 + 1]!
  dz = p[3 * v1 + 2]! - p[3 * v3 + 2]!
  const d13 = dx * dx + dy * dy + dz * dz
  const a = outward ? v1 : v3
  const b = outward ? v3 : v1
  if (d02 <= d13) {
    tris[nIdx] = v0
    tris[nIdx + 1] = a
    tris[nIdx + 2] = v2
    tris[nIdx + 3] = v0
    tris[nIdx + 4] = v2
    tris[nIdx + 5] = b
  } else {
    tris[nIdx] = v0
    tris[nIdx + 1] = a
    tris[nIdx + 2] = b
    tris[nIdx + 3] = a
    tris[nIdx + 4] = v2
    tris[nIdx + 5] = b
  }
  nIdx += 6
}

export function emptyMesh(): MeshData {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    finish: new Uint8Array(0),
    indices: new Uint32Array(0)
  }
}

// Meshes part of a distance field of sx × sy × sz samples. Quads are emitted for edges that
// start at samples in [lo, hi) on each axis; that range must sit at least two samples in from
// every side of the field. Sample (i, j, k) is at world (ox + (gx + i) * voxel, ...), where
// the g offsets are whole numbers, so two fields cut from the same grid agree exactly.
// finish may be null, in which case the finish output is all zero.
export function surfaceNets(
  dist: Int8Array, finish: Uint8Array | null,
  sx: number, sy: number, sz: number,
  loX: number, loY: number, loZ: number,
  hiX: number, hiY: number, hiZ: number,
  gx: number, gy: number, gz: number,
  ox: number, oy: number, oz: number,
  voxel: number
): MeshData {
  const sxy = sx * sy
  const cells = sxy * sz
  if (cellVert.length < cells) cellVert = new Int32Array(cells)
  cellVert.fill(-1, 0, cells)
  fDist = dist
  fFinish = finish
  fSx = sx
  fSxy = sxy
  fGx = gx
  fGy = gy
  fGz = gz
  fOx = ox
  fOy = oy
  fOz = oz
  fVoxel = voxel
  nVert = 0
  nIdx = 0
  for (let z = loZ; z < hiZ; z++) {
    for (let y = loY; y < hiY; y++) {
      let i = loX + sx * y + sxy * z
      for (let x = loX; x < hiX; x++, i++) {
        const inside = dist[i]! < 0
        if ((dist[i + 1]! < 0) !== inside) quad(i - sx - sxy, i - sxy, i, i - sx, inside)
        if ((dist[i + sx]! < 0) !== inside) quad(i - sxy - 1, i - 1, i, i - sxy, inside)
        if ((dist[i + sxy]! < 0) !== inside) quad(i - 1 - sx, i - sx, i, i - 1, inside)
      }
    }
  }
  // Drop the references so a large offcut field can be collected.
  fDist = NO_FIELD
  fFinish = null
  return {
    positions: vPos.slice(0, nVert * 3),
    normals: vNrm.slice(0, nVert * 3),
    finish: vFin.slice(0, nVert),
    indices: tris.slice(0, nIdx)
  }
}

let padDist = new Int8Array(0)
let padFinish = new Uint8Array(0)

// Meshes one chunk. The returned arrays are freshly allocated and exactly sized, ready to
// transfer out of a worker. A chunk with no surface in it returns empty arrays.
export function meshChunk(grid: Grid, chunk: number): ChunkMesh {
  const { nx, ny, nz, dist, finish } = grid
  const c = grid.chunk
  const s = c + 4
  if (padDist.length !== s * s * s) {
    padDist = new Int8Array(s * s * s)
    padFinish = new Uint8Array(s * s * s)
  }
  const [cx, cy, cz] = chunkCoords(grid, chunk)
  const bx = cx * c - 2
  const by = cy * c - 2
  const bz = cz * c - 2
  // Copy the chunk and two samples around it; anything beyond the grid is air. The two
  // accumulators end up saying whether any sample is stone and whether any is air.
  let anyBits = 0
  let allBits = -1
  let j = 0
  for (let pz = 0; pz < s; pz++) {
    const z = bz + pz
    for (let py = 0; py < s; py++) {
      const y = by + py
      if (z < 0 || z >= nz || y < 0 || y >= ny) {
        padDist.fill(Q_MAX, j, j + s)
        allBits &= Q_MAX
        j += s
        continue
      }
      const row = nx * (y + ny * z)
      for (let px = 0; px < s; px++, j++) {
        const x = bx + px
        if (x < 0 || x >= nx) {
          padDist[j] = Q_MAX
          allBits &= Q_MAX
        } else {
          const v = dist[row + x]!
          padDist[j] = v
          padFinish[j] = finish[row + x]!
          anyBits |= v
          allBits &= v
        }
      }
    }
  }
  if (anyBits >= 0 || allBits < 0) return { chunk, ...emptyMesh() }
  const mesh = surfaceNets(
    padDist, padFinish, s, s, s,
    2, 2, 2, c + 2, c + 2, c + 2,
    bx, by, bz, grid.x0, grid.y0, grid.z0, grid.voxel
  )
  return { chunk, ...mesh }
}

// Every chunk that has surface in it. Mostly for tests and offline use; the live worker
// meshes takeDirty() instead.
export function meshAll(grid: Grid): ChunkMesh[] {
  const out: ChunkMesh[] = []
  const n = chunkCount(grid)
  for (let id = 0; id < n; id++) {
    const mesh = meshChunk(grid, id)
    if (mesh.indices.length > 0) out.push(mesh)
  }
  return out
}
