import type { Grid, GridInfo, GridOptions, Vec3 } from './types.ts'

// The distance channel keeps a band of this many voxels either side of the surface.
export const BAND_VOXELS = 4
export const Q_MAX = 127
export const Q_PER_VOXEL = Q_MAX / BAND_VOXELS

// Carrara marble, g/cm³.
export const DENSITY = 2.71

// Finish-channel values: 0 is rough, 255 is polished.
export const FINISH = { point: 20, claw: 60, sawn: 90, flat: 110, rasp: 170, polished: 255 } as const

// Air samples kept on every side of the block. Two is the least that lets the mesher and the
// island check read a neighbour of a neighbour of any stone voxel without bounds checks.
export const MIN_PAD = 2

// Stone occupancy of a voxel from its stored distance, 0 to 254, linear across the half voxel
// either side of the surface. Integers, so the running total is exact whatever order edits
// arrive in. Indexed by q + 128.
export const OCC_FULL = 254
export const OCC = new Uint8Array(256)
for (let q = -128; q <= 127; q++) {
  OCC[q + 128] = Math.max(0, Math.min(OCC_FULL, 127 - 8 * q))
}

function paddedCount(voxels: number, chunk: number): number {
  return Math.ceil((voxels + 2 * MIN_PAD) / chunk) * chunk
}

// A fresh block. The default is 60 × 100 × 60 cm at 0.4 cm, which pads out to 160 × 256 × 160
// samples in 32³ chunks. Block faces fall midway between two samples, so the fresh block's
// volume is exact, and the air padding means the surface (base included) never reaches the
// edge of the grid.
export function createGrid(options: Partial<GridOptions> = {}): Grid {
  const voxel = options.voxel ?? 0.4
  const chunk = options.chunk ?? 32
  if (chunk % 4 !== 0) throw new Error('chunk size must be a multiple of 4')
  const vx = Math.max(1, Math.round((options.width ?? 60) / voxel))
  const vy = Math.max(1, Math.round((options.height ?? 100) / voxel))
  const vz = Math.max(1, Math.round((options.depth ?? 60) / voxel))
  const nx = paddedCount(vx, chunk)
  const ny = paddedCount(vy, chunk)
  const nz = paddedCount(vz, chunk)
  const padX = (nx - vx) >> 1
  const padY = (ny - vy) >> 1
  const padZ = (nz - vz) >> 1
  const hx = vx * voxel / 2
  const hy = vy * voxel / 2
  const hz = vz * voxel / 2
  const grid: Grid = {
    nx,
    ny,
    nz,
    voxel,
    x0: -hx + (0.5 - padX) * voxel,
    y0: (0.5 - padY) * voxel,
    z0: -hz + (0.5 - padZ) * voxel,
    chunk,
    ncx: nx / chunk,
    ncy: ny / chunk,
    ncz: nz / chunk,
    baseY: padY,
    size: [2 * hx, 2 * hy, 2 * hz],
    qPerCm: Q_PER_VOXEL / voxel,
    dist: new Int8Array(nx * ny * nz),
    finish: new Uint8Array(nx * ny * nz).fill(FINISH.sawn),
    dirty: new Uint8Array(nx * ny * nz / (chunk * chunk * chunk)).fill(1),
    solidUnits: 0,
    forms: new Map()
  }

  // Exact box distance, built from one signed distance per axis.
  const ax = new Float64Array(nx)
  const ay = new Float64Array(ny)
  const az = new Float64Array(nz)
  for (let i = 0; i < nx; i++) ax[i] = Math.abs(grid.x0 + i * voxel) - hx
  for (let j = 0; j < ny; j++) ay[j] = Math.abs(grid.y0 + j * voxel - hy) - hy
  for (let k = 0; k < nz; k++) az[k] = Math.abs(grid.z0 + k * voxel) - hz
  const { dist, qPerCm } = grid
  let i = 0
  for (let z = 0; z < nz; z++) {
    const dz = az[z]!
    for (let y = 0; y < ny; y++) {
      const dy = ay[y]!
      const m = dy > dz ? dy : dz
      for (let x = 0; x < nx; x++, i++) {
        const dx = ax[x]!
        let d: number
        if (dx <= 0 && m <= 0) {
          d = dx > m ? dx : m
        } else {
          const ox = dx > 0 ? dx : 0
          const oy = dy > 0 ? dy : 0
          const oz = dz > 0 ? dz : 0
          d = Math.sqrt(ox * ox + oy * oy + oz * oz)
        }
        const q = Math.round(d * qPerCm)
        dist[i] = q > Q_MAX ? Q_MAX : q < -Q_MAX ? -Q_MAX : q
      }
    }
  }
  grid.solidUnits = recountSolid(grid)
  return grid
}

// An independent copy, e.g. the shown stone beside the true stone. Compiled forms are
// immutable, so the two copies share them.
export function cloneGrid(grid: Grid): Grid {
  return {
    ...grid,
    size: [grid.size[0], grid.size[1], grid.size[2]],
    dist: grid.dist.slice(),
    finish: grid.finish.slice(),
    dirty: grid.dirty.slice(),
    forms: new Map(grid.forms)
  }
}

export function voxelIndex(grid: Grid, x: number, y: number, z: number): number {
  return x + grid.nx * (y + grid.ny * z)
}

// World position of sample (x, y, z).
export function voxelCenter(grid: Grid, x: number, y: number, z: number): Vec3 {
  return [grid.x0 + x * grid.voxel, grid.y0 + y * grid.voxel, grid.z0 + z * grid.voxel]
}

// The sample nearest a world position, clamped to the grid.
export function nearestVoxel(grid: Grid, p: Vec3): Vec3 {
  const clamp = (v: number, n: number) => Math.max(0, Math.min(n - 1, Math.round(v)))
  return [
    clamp((p[0] - grid.x0) / grid.voxel, grid.nx),
    clamp((p[1] - grid.y0) / grid.voxel, grid.ny),
    clamp((p[2] - grid.z0) / grid.voxel, grid.nz)
  ]
}

// The layout of a grid, detached from its buffers.
export function gridInfo(grid: Grid): GridInfo {
  const { nx, ny, nz, voxel, x0, y0, z0, chunk, ncx, ncy, ncz, baseY, qPerCm } = grid
  return { nx, ny, nz, voxel, x0, y0, z0, chunk, ncx, ncy, ncz, baseY, size: [grid.size[0], grid.size[1], grid.size[2]], qPerCm }
}

export function chunkCount(grid: GridInfo): number {
  return grid.ncx * grid.ncy * grid.ncz
}

export function chunkId(grid: Grid, cx: number, cy: number, cz: number): number {
  return cx + grid.ncx * (cy + grid.ncy * cz)
}

export function chunkCoords(grid: GridInfo, id: number): Vec3 {
  const cx = id % grid.ncx
  const rest = (id - cx) / grid.ncx
  const cy = rest % grid.ncy
  return [cx, cy, (rest - cy) / grid.ncy]
}

// World-space box that contains every vertex of a chunk's mesh, for culling.
export function chunkBounds(grid: GridInfo, id: number): { min: Vec3, max: Vec3 } {
  const [cx, cy, cz] = chunkCoords(grid, id)
  const s = (grid.chunk + 1) * grid.voxel
  const min: Vec3 = [
    grid.x0 + (cx * grid.chunk - 1) * grid.voxel,
    grid.y0 + (cy * grid.chunk - 1) * grid.voxel,
    grid.z0 + (cz * grid.chunk - 1) * grid.voxel
  ]
  return { min, max: [min[0] + s, min[1] + s, min[2] + s] }
}

// Flags every chunk whose mesh reads a sample in the inclusive box, and adds new ids to out.
// A chunk's mesh reads two samples beyond its own range on every side: one for the cells
// that straddle a seam, one more for normals.
export function markDirtyBox(
  grid: Grid,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
  out: number[]
): void {
  const c = grid.chunk
  const ax = Math.max(0, Math.floor((minX - 2) / c))
  const ay = Math.max(0, Math.floor((minY - 2) / c))
  const az = Math.max(0, Math.floor((minZ - 2) / c))
  const bx = Math.min(grid.ncx - 1, Math.floor((maxX + 2) / c))
  const by = Math.min(grid.ncy - 1, Math.floor((maxY + 2) / c))
  const bz = Math.min(grid.ncz - 1, Math.floor((maxZ + 2) / c))
  for (let cz = az; cz <= bz; cz++) {
    for (let cy = ay; cy <= by; cy++) {
      for (let cx = ax; cx <= bx; cx++) {
        const id = cx + grid.ncx * (cy + grid.ncy * cz)
        grid.dirty[id] = 1
        if (!out.includes(id)) out.push(id)
      }
    }
  }
}

// Every chunk flagged since the last call, in id order; clears the flags. A fresh grid starts
// with all of them flagged. Use this to remesh once per frame however many strikes landed.
export function takeDirty(grid: Grid): number[] {
  const out: number[] = []
  const { dirty } = grid
  for (let i = 0; i < dirty.length; i++) {
    if (dirty[i] === 1) {
      out.push(i)
      dirty[i] = 0
    }
  }
  return out
}

// Recomputes the stone total from scratch. Edits keep grid.solidUnits current; this is the
// slow cross-check.
export function recountSolid(grid: Grid): number {
  const { dist } = grid
  let units = 0
  for (let i = 0; i < dist.length; i++) units += OCC[dist[i]! + 128]!
  return units
}

export function unitsToCm3(grid: Grid, units: number): number {
  return units * grid.voxel * grid.voxel * grid.voxel / OCC_FULL
}

export function stoneVolumeCm3(grid: Grid): number {
  return unitsToCm3(grid, grid.solidUnits)
}

export function stoneMassKg(grid: Grid): number {
  return stoneVolumeCm3(grid) * DENSITY / 1000
}

function mixWords(words: Int32Array, seed: number): number {
  let h = seed | 0
  for (let i = 0; i < words.length; i++) {
    let k = Math.imul(words[i]!, 0xcc9e2d51)
    k = (k << 15) | (k >>> 17)
    k = Math.imul(k, 0x1b873593)
    h ^= k
    h = (h << 13) | (h >>> 19)
    h = (Math.imul(h, 5) + 0xe6546b64) | 0
  }
  h ^= words.length
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

// 16 hex digits covering both channels and the grid's shape. Two stones with the same hash
// are the same stone, which is how a replay or a resume is checked. Reads the buffers four
// bytes at a time in platform byte order; every platform we run on is little-endian.
export function hashGrid(grid: Grid): string {
  const shape = Math.imul(grid.nx, 73856093) ^ Math.imul(grid.ny, 19349663) ^ Math.imul(grid.nz, 83492791)
  const a = mixWords(new Int32Array(grid.dist.buffer, grid.dist.byteOffset, grid.dist.length >> 2), shape)
  const b = mixWords(new Int32Array(grid.finish.buffer, grid.finish.byteOffset, grid.finish.length >> 2), a)
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}
