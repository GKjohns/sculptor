import { BAND_VOXELS, MESH_REACH, Q_MAX, chunkCoords, chunkCount } from './grid.ts'
import type { ChunkMesh, Grid, MeshData, Vec3 } from './types.ts'

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
    thickness: new Uint8Array(0),
    smooth: new Float32Array(0),
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
  const normals = vNrm.slice(0, nVert * 3)
  return {
    positions: vPos.slice(0, nVert * 3),
    normals,
    finish: vFin.slice(0, nVert),
    thickness: new Uint8Array(nVert).fill(255),
    smooth: normals.slice(),
    indices: tris.slice(0, nIdx)
  }
}

// Smooth normals: the gradient of the distance field blurred by a Gaussian two voxels wide, for
// the renderer to shade worked stone with. The geometry keeps every groove a tool left, a voxel or
// two deep and as regular as the hand's strokes; shaded with its own normals a clawed or rasped
// face reads as corduroy. The blur takes ridges three voxels apart down to nothing and ridges six
// apart (the hand's stroke spacing) to about a tenth, where a nose or a brow, some centimetres
// across, keeps its shape. Like thickness it is no part of the geometry.
const SIGMA = 2
// Samples either side of the vertex that the blur reads: 2.5 sigma.
const SPAN = 5
const SIDE = 2 * SPAN
// The field's slope across the surface, q per voxel.
const SLOPE = Q_MAX / BAND_VOXELS
const wx = new Float64Array(SIDE)
const ux = new Float64Array(SIDE)
const wy = new Float64Array(SIDE)
const uy = new Float64Array(SIDE)
const wz = new Float64Array(SIDE)
const uz = new Float64Array(SIDE)
function gaussian(w: Float64Array, u: Float64Array, f: number): number {
  let sum = 0
  for (let k = 0; k < SIDE; k++) {
    const d = k - (SPAN - 1) - f
    w[k] = Math.exp(-d * d / (2 * SIGMA * SIGMA))
    u[k] = w[k]! * d
    sum += w[k]!
  }
  return sum
}

function bakeSmooth(grid: Grid, mesh: MeshData): void {
  const { positions, normals, smooth } = mesh
  const { nx, ny, nz, dist } = grid
  const sxy = nx * ny
  const inv = 1 / grid.voxel
  for (let v = 0; v < smooth.length; v += 3) {
    const px = (positions[v]! - grid.x0) * inv
    const py = (positions[v + 1]! - grid.y0) * inv
    const pz = (positions[v + 2]! - grid.z0) * inv
    const x0 = Math.floor(px) - (SPAN - 1)
    const y0 = Math.floor(py) - (SPAN - 1)
    const z0 = Math.floor(pz) - (SPAN - 1)
    // The weights are separable: one row of them per axis, and the same rows times the offset.
    const norm = gaussian(wx, ux, px - Math.floor(px)) * gaussian(wy, uy, py - Math.floor(py)) * gaussian(wz, uz, pz - Math.floor(pz))
    const inside = x0 >= 0 && y0 >= 0 && z0 >= 0 && x0 + SIDE <= nx && y0 + SIDE <= ny && z0 + SIDE <= nz
    let gx = 0
    let gy = 0
    let gz = 0
    for (let c = 0; c < SIDE; c++) {
      const z = z0 + c
      for (let b = 0; b < SIDE; b++) {
        const y = y0 + b
        // Along one row of x: the plain blur and the blur times the x offset.
        let sx = 0
        let tx = 0
        if (inside) {
          const row = x0 + nx * y + sxy * z
          for (let a = 0; a < SIDE; a++) {
            const d = dist[row + a]!
            sx += d * wx[a]!
            tx += d * ux[a]!
          }
        } else {
          for (let a = 0; a < SIDE; a++) {
            const xx = x0 + a
            // Beyond the grid is air.
            const d = xx < 0 || y < 0 || z < 0 || xx >= nx || y >= ny || z >= nz ? Q_MAX : dist[xx + nx * y + sxy * z]!
            sx += d * wx[a]!
            tx += d * ux[a]!
          }
        }
        gx += tx * wy[b]! * wz[c]!
        gy += sx * uy[b]! * wz[c]!
        gz += sx * wy[b]! * uz[c]!
      }
    }
    // The blurred field's gradient, q per voxel.
    const k = 1 / (norm * SIGMA * SIGMA)
    gx *= k
    gy *= k
    gz *= k
    const len = Math.sqrt(gx * gx + gy * gy + gz * gz)
    if (len < 1e-6) continue
    // A sheet or a spike thinner than the blur has stone on both sides of it and next to no slope
    // left, or a slope that is not its own: it eases back to its own normal.
    const own = gx * normals[v]! + gy * normals[v + 1]! + gz * normals[v + 2]!
    const t = ease(len / SLOPE, 0.15, 0.45) * ease(own / len, 0.2, 0.6)
    if (t <= 0) continue
    const ox = normals[v]! * (1 - t) + gx / len * t
    const oy = normals[v + 1]! * (1 - t) + gy / len * t
    const oz = normals[v + 2]! * (1 - t) + gz / len * t
    const ol = Math.sqrt(ox * ox + oy * oy + oz * oz) || 1
    smooth[v] = ox / ol
    smooth[v + 1] = oy / ol
    smooth[v + 2] = oz / ol
  }
}

function ease(x: number, from: number, to: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)))
  return t * t * (3 - 2 * t)
}

// Thickness: how much stone the studio's key light has to come through to reach each vertex
// from behind, for the renderer's light through thin sections (an ear, a drapery edge, a slab
// left standing). It is no part of the geometry: the kernel never reads it and it changes no hash.
//
// A vertex that faces the light is lit from the front and is given full thickness. One that
// faces away sends a ray from just under its surface toward the light and adds up the stone
// along its first THICKNESS_CM. A head is thick this way whatever its surface is doing; a slab
// or an ear with air behind it is as thin as it is.
export const THICKNESS_CM = 3.2

// Where the key light comes from, block coordinates, unit length: down through the studio's
// window (app/studio/atelier.ts places its key on this line).
export const KEY_FROM: Vec3 = [-0.65294, 0.54847, 0.52235]

// A grid whose chunks are to be meshed with smooth normals and thickness. The rays leave the
// chunk, so a changed sample has to flag every chunk with a vertex in ray's reach of it, not only
// the chunks whose geometry reads it. Call it before the first edit.
export function trackThickness(grid: Grid): void {
  grid.reach = MESH_REACH + Math.ceil(THICKNESS_CM / grid.voxel)
}

const VOXELS_PER_Q = BAND_VOXELS / Q_MAX
// Voxels under the surface that a ray starts from.
const START = 0.9
// How squarely a vertex has to face the light before it counts as lit from the front, and how
// far past edge-on the thickness is eased toward full, so the terminator has no seam.
const FRONT = 0.2
const BEHIND = -0.15

// How many voxels of stone lie along the first `reach` voxels of a ray from (px, py, pz), in
// sample coordinates. All of it, not just as far as the first air: the far flank of a tool
// groove has a rib and then the whole block between it and the light, and is not thin.
// Each half-voxel step counts for as much of itself as the stored distance says is stone.
const STEP = 0.5
function stoneAlong(grid: Grid, px: number, py: number, pz: number, dx: number, dy: number, dz: number, reach: number): number {
  const { nx, ny, nz, dist } = grid
  let stone = 0
  for (let t = STEP / 2; t < reach; t += STEP) {
    const x = Math.round(px + dx * t)
    const y = Math.round(py + dy * t)
    const z = Math.round(pz + dz * t)
    // Beyond the grid there is only air, however far the ray goes on.
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) break
    const inside = 0.5 - dist[x + nx * (y + ny * z)]! * VOXELS_PER_Q / STEP
    stone += inside >= 1 ? STEP : inside > 0 ? inside * STEP : 0
  }
  return stone
}

function bakeThickness(grid: Grid, mesh: MeshData): void {
  const { positions, smooth, thickness } = mesh
  const inv = 1 / grid.voxel
  const reach = THICKNESS_CM * inv
  const [lx, ly, lz] = KEY_FROM
  for (let v = 0; v < thickness.length; v++) {
    const nx = smooth[3 * v]!
    const ny = smooth[3 * v + 1]!
    const nz = smooth[3 * v + 2]!
    const facing = nx * lx + ny * ly + nz * lz
    if (facing >= FRONT) {
      thickness[v] = 255
      continue
    }
    const through = stoneAlong(
      grid,
      (positions[3 * v]! - grid.x0) * inv - nx * START,
      (positions[3 * v + 1]! - grid.y0) * inv - ny * START,
      (positions[3 * v + 2]! - grid.z0) * inv - nz * START,
      lx, ly, lz, reach
    ) / reach
    const eased = facing > BEHIND ? through + (1 - through) * (facing - BEHIND) / (FRONT - BEHIND) : through
    thickness[v] = Math.round(255 * eased)
  }
}

let padDist = new Int8Array(0)
let padFinish = new Uint8Array(0)

// Meshes one chunk. The returned arrays are freshly allocated and exactly sized, ready to
// transfer out of a worker. A chunk with no surface in it returns empty arrays. Smooth normals
// and thickness are baked only on a grid that trackThickness() was called on.
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
  if (grid.reach > MESH_REACH) {
    bakeSmooth(grid, mesh)
    bakeThickness(grid, mesh)
  }
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
