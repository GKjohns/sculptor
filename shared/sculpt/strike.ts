import { BAND_VOXELS, OCC, Q_MAX, Q_PER_VOXEL, markDirtyBox, unitsToCm3 } from './grid.ts'
import { detachIslands, extractOffcuts } from './islands.ts'
import { declareForm, formDistance } from './shapes.ts'
import { prepareTool, toolDistance, toolSpec } from './tools.ts'
import type { ToolSpec } from './tools.ts'
import type { CompiledForm, CutStrike, Grid, SawStrike, Strike, StrikeResult } from './types.ts'

// Every edit to the stone goes through applyStrike, and every edit is the same move:
// d = max(d, something). Distances only ever rise, so stone only ever leaves.

// A tool marks the finish of the stone it leaves behind to this depth below the new surface,
// in stored distance units (two voxels).
const FINISH_REACH = -2 * Q_PER_VOXEL

function requireForm(grid: Grid, name: string): CompiledForm {
  const form = grid.forms.get(name)
  // Cutting unprotected when protection was asked for would be the worst way to fail.
  if (!form) throw new Error(`strike protects an undeclared form: ${name}`)
  return form
}

// The stored distance of a point from a protected form. Anything inside the form, however
// slightly, stays at least one unit inside the stone.
function protectedLimit(form: CompiledForm, x: number, y: number, z: number, qPerCm: number): number {
  const d = formDistance(form, x, y, z)
  const q = Math.round(d * qPerCm)
  return d < 0 && q > -1 ? -1 : q
}

// Bounds of the samples an edit changed: min x, y, z then max x, y, z. Empty while max < min.
const changed = new Int32Array(6)

// Turns one of two diagonal stone samples into air, preferring the shallower one and never
// one inside the protected form. Returns the stone units that went, or -1 if both are
// protected and the contact has to stay.
function breakContact(dist: Int8Array, nx: number, ny: number, p: number, q: number, form: CompiledForm | null, grid: Grid): number {
  let pick = dist[p]! >= dist[q]! ? p : q
  for (let attempt = 0; attempt < 2; attempt++) {
    const x = pick % nx
    const rest = (pick - x) / nx
    const y = rest % ny
    const z = (rest - y) / ny
    const free = form === null
      || formDistance(form, grid.x0 + x * grid.voxel, grid.y0 + y * grid.voxel, grid.z0 + z * grid.voxel) >= 0
    if (free) {
      const units = OCC[dist[pick]! + 128]! - OCC[1 + 128]!
      dist[pick] = 1
      if (x < changed[0]!) changed[0] = x
      if (y < changed[1]!) changed[1] = y
      if (z < changed[2]!) changed[2] = z
      if (x > changed[3]!) changed[3] = x
      if (y > changed[4]!) changed[4] = y
      if (z > changed[5]!) changed[5] = z
      return units
    }
    pick = pick === p ? q : p
  }
  return -1
}

// Stone joined to other stone only along a voxel edge is not really joined: the island check
// counts the two sides as separate, and the mesher would have to hang four faces off one
// edge there. After every edit, wherever the edit left such a contact, the shallower of the
// two stone samples becomes air. Works inside the `changed` box (growing it as needed) and
// returns the stone units removed. The grid is only used to place samples for the form test.
function settle(dist: Int8Array, nx: number, ny: number, nz: number, form: CompiledForm | null, grid: Grid): number {
  const nxy = nx * ny
  let units = 0
  for (let pass = 0; pass < 64; pass++) {
    const ax = Math.max(0, changed[0]! - 1)
    const ay = Math.max(0, changed[1]! - 1)
    const az = Math.max(0, changed[2]! - 1)
    const bx = Math.min(nx - 2, changed[3]!)
    const by = Math.min(ny - 2, changed[4]!)
    const bz = Math.min(nz - 2, changed[5]!)
    let broke = 0
    for (let z = az; z <= bz; z++) {
      for (let y = ay; y <= by; y++) {
        let i = ax + nx * (y + ny * z)
        for (let x = ax; x <= bx; x++, i++) {
          const a = dist[i]! < 0
          const b = dist[i + 1]! < 0
          const c = dist[i + nx]! < 0
          const e = dist[i + nxy]! < 0
          if (a === b && a === c && a === e) continue
          // The three faces with this sample at their lowest corner. A face is an edge
          // contact when its diagonals disagree: stone, air, air, stone going round. After
          // a break the signs read above are stale, so the rest wait for the next pass.
          let got = 0
          if (a !== b && b === c && (dist[i + nx + 1]! < 0) === a) {
            got = a ? breakContact(dist, nx, ny, i, i + nx + 1, form, grid) : breakContact(dist, nx, ny, i + 1, i + nx, form, grid)
          }
          if (got <= 0 && a !== b && b === e && (dist[i + nxy + 1]! < 0) === a) {
            got = a ? breakContact(dist, nx, ny, i, i + nxy + 1, form, grid) : breakContact(dist, nx, ny, i + 1, i + nxy, form, grid)
          }
          if (got <= 0 && a !== c && c === e && (dist[i + nxy + nx]! < 0) === a) {
            got = a ? breakContact(dist, nx, ny, i, i + nxy + nx, form, grid) : breakContact(dist, nx, ny, i + nx, i + nxy, form, grid)
          }
          if (got > 0) {
            units += got
            broke++
          }
        }
      }
    }
    // Breaking one contact can expose another next to it, so go round until a clean pass.
    if (broke === 0) break
  }
  return units
}

// Closes an edit to the grid: tidies the changed region, brings the stone total up to date
// and flags the chunks to remesh.
function commit(
  grid: Grid, removed: number, form: CompiledForm | null,
  minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number
): StrikeResult {
  const result: StrikeResult = { dirtyChunks: [], removedCm3: 0, offcuts: [] }
  if (maxX < 0) return result
  changed[0] = minX
  changed[1] = minY
  changed[2] = minZ
  changed[3] = maxX
  changed[4] = maxY
  changed[5] = maxZ
  removed += settle(grid.dist, grid.nx, grid.ny, grid.nz, form, grid)
  grid.solidUnits -= removed
  result.removedCm3 = unitsToCm3(grid, removed)
  markDirtyBox(grid, changed[0]!, changed[1]!, changed[2]!, changed[3]!, changed[4]!, changed[5]!, result.dirtyChunks)
  return result
}

function bite(grid: Grid, strike: CutStrike, spec: ToolSpec): StrikeResult {
  const { nx, ny, nz, voxel, x0, y0, z0, dist, finish, qPerCm } = grid
  const tool = prepareTool(spec, strike, voxel)
  const form = strike.protect === undefined ? null : requireForm(grid, strike.protect)

  // Bounding box of the tool (a cylinder around its axis), padded by the band so the
  // distances of the stone left standing next to the cut are brought up to date too.
  const half = (tool.depth + tool.back) / 2
  const mid = (tool.depth - tool.back) / 2
  const pad = BAND_VOXELS * voxel + tool.amp
  const ex = half * Math.abs(tool.dx) + tool.radius * Math.sqrt(Math.max(0, 1 - tool.dx * tool.dx)) + pad
  const ey = half * Math.abs(tool.dy) + tool.radius * Math.sqrt(Math.max(0, 1 - tool.dy * tool.dy)) + pad
  const ez = half * Math.abs(tool.dz) + tool.radius * Math.sqrt(Math.max(0, 1 - tool.dz * tool.dz)) + pad
  const cx = tool.ax + tool.dx * mid
  const cy = tool.ay + tool.dy * mid
  const cz = tool.az + tool.dz * mid
  const ia = Math.max(0, Math.ceil((cx - ex - x0) / voxel))
  const ib = Math.min(nx - 1, Math.floor((cx + ex - x0) / voxel))
  const ja = Math.max(0, Math.ceil((cy - ey - y0) / voxel))
  const jb = Math.min(ny - 1, Math.floor((cy + ey - y0) / voxel))
  const ka = Math.max(0, Math.ceil((cz - ez - z0) / voxel))
  const kb = Math.min(nz - 1, Math.floor((cz + ez - z0) / voxel))

  const mark = spec.finish
  let removed = 0
  let minX = nx
  let maxX = -1
  let minY = ny
  let maxY = -1
  let minZ = nz
  let maxZ = -1
  for (let z = ka; z <= kb; z++) {
    const pz = z0 + z * voxel
    for (let y = ja; y <= jb; y++) {
      const py = y0 + y * voxel
      let i = ia + nx * (y + ny * z)
      let touched = false
      for (let x = ia; x <= ib; x++, i++) {
        const old = dist[i]!
        if (old === Q_MAX) continue
        const px = x0 + x * voxel
        let q = Math.round(-toolDistance(tool, px, py, pz) * qPerCm)
        if (q <= old) continue
        if (q > Q_MAX) q = Q_MAX
        if (form !== null) {
          const limit = protectedLimit(form, px, py, pz, qPerCm)
          if (limit < q) {
            if (limit <= old) continue
            q = limit
          }
        }
        dist[i] = q
        removed += OCC[old + 128]! - OCC[q + 128]!
        if (q > FINISH_REACH) finish[i] = mark
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        touched = true
      }
      if (touched) {
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
    }
  }
  return commit(grid, removed, form, minX, minY, minZ, maxX, maxY, maxZ)
}

let snapshot = new Int8Array(0)

// How far the rasp looks along each axis, in samples. Three is the most that still lands
// inside the distance band for a voxel next to the surface.
const RINGS = 3

// The distance a voxel must have, given the nearest of its two neighbours along each axis
// (as distances from the surface, all on the voxel's own side of it), for the field to keep
// a slope of one: the upwind solution of |∇d| = 1 used by fast-sweeping methods. In stored
// units.
function eikonal(a: number, b: number, c: number): number {
  let t: number
  if (a > b) {
    t = a
    a = b
    b = t
  }
  if (b > c) {
    t = b
    b = c
    c = t
  }
  if (a > b) {
    t = a
    a = b
    b = t
  }
  const h = Q_PER_VOXEL
  let d = a + h
  if (d > b) {
    d = (a + b + Math.sqrt(2 * h * h - (a - b) * (a - b))) / 2
    if (d > c) {
      const sum = a + b + c
      d = (sum + Math.sqrt(sum * sum - 3 * (a * a + b * b + c * c - h * h))) / 3
    }
  }
  return d
}

// The rasp. Inside its pad, a voxel is raised toward the mean of its neighbours along each
// axis wherever that mean is higher, which is exactly where the surface bulges outward:
// bumps and ridges wear down, hollows and flat faces are left alone. depth caps how much one
// stroke takes at the middle of the pad.
function abrade(grid: Grid, strike: CutStrike, spec: ToolSpec): StrikeResult {
  const { nx, ny, nz, voxel, x0, y0, z0, dist, finish, qPerCm } = grid
  const form = strike.protect === undefined ? null : requireForm(grid, strike.protect)
  const radius = Math.max(strike.size / 2, voxel)
  const r2 = radius * radius
  const cap = strike.depth * qPerCm
  const [ax, ay, az] = strike.at
  const ia = Math.max(0, Math.ceil((ax - radius - x0) / voxel))
  const ib = Math.min(nx - 1, Math.floor((ax + radius - x0) / voxel))
  const ja = Math.max(0, Math.ceil((ay - radius - y0) / voxel))
  const jb = Math.min(ny - 1, Math.floor((ay + radius - y0) / voxel))
  const ka = Math.max(0, Math.ceil((az - radius - z0) / voxel))
  const kb = Math.min(nz - 1, Math.floor((az + radius - z0) / voxel))
  if (ia > ib || ja > jb || ka > kb) return { dirtyChunks: [], removedCm3: 0, offcuts: [] }

  // Work from a copy (with room for the neighbours, air beyond the grid) so the result does
  // not depend on the order voxels are visited in.
  const bx = ib - ia + 1 + 2 * RINGS
  const by = jb - ja + 1 + 2 * RINGS
  const bz = kb - ka + 1 + 2 * RINGS
  const bxy = bx * by
  if (snapshot.length < bxy * bz) snapshot = new Int8Array(bxy * bz)
  const snap = snapshot
  let dst = 0
  for (let sz = 0; sz < bz; sz++) {
    const z = ka - RINGS + sz
    for (let sy = 0; sy < by; sy++) {
      const y = ja - RINGS + sy
      if (z < 0 || z >= nz || y < 0 || y >= ny) {
        snap.fill(Q_MAX, dst, dst + bx)
        dst += bx
        continue
      }
      const row = nx * (y + ny * z)
      for (let sx = 0; sx < bx; sx++) {
        const x = ia - RINGS + sx
        snap[dst++] = x < 0 || x >= nx ? Q_MAX : dist[row + x]!
      }
    }
  }

  const mark = spec.finish
  let removed = 0
  let minX = nx
  let maxX = -1
  let minY = ny
  let maxY = -1
  let minZ = nz
  let maxZ = -1
  for (let z = ka; z <= kb; z++) {
    const pz = z0 + z * voxel
    const dz = pz - az
    for (let y = ja; y <= jb; y++) {
      const py = y0 + y * voxel
      const dy = py - ay
      let i = ia + nx * (y + ny * z)
      let j = RINGS + bx * (y - ja + RINGS) + bxy * (z - ka + RINGS)
      let touched = false
      for (let x = ia; x <= ib; x++, i++, j++) {
        const px = x0 + x * voxel
        const dx = px - ax
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 >= r2) continue
        const old = snap[j]!
        let q = old
        // Rings of six neighbours, one, two and three samples out. A ring counts only if
        // none of it is clamped: past the band the field says nothing about the surface.
        let lift = 0
        let rings = 0
        let lo = 0
        let hi = 0
        let near = 0
        for (let ring = 1; ring <= RINGS; ring++) {
          const a = snap[j - ring]!
          const b = snap[j + ring]!
          const c = snap[j - ring * bx]!
          const d = snap[j + ring * bx]!
          const e = snap[j - ring * bxy]!
          const f = snap[j + ring * bxy]!
          const ringLo = Math.min(a, b, c, d, e, f)
          const ringHi = Math.max(a, b, c, d, e, f)
          if (ring === 1) {
            lo = ringLo
            hi = ringHi
            // Where this voxel's whole neighbourhood is on one side of the surface, what its
            // distance should be going by the neighbours nearer the surface.
            if (ringLo >= 0) near = eikonal(Math.min(a, b), Math.min(c, d), Math.min(e, f))
            else if (ringHi < 0) near = eikonal(-Math.max(a, b), -Math.max(c, d), -Math.max(e, f))
          }
          if (ringHi === Q_MAX || ringLo === -Q_MAX) break
          lift += (a + b + c + d + e + f) / 6 - old
          rings++
        }
        if (rings > 0 && lift > 0) {
          q = Math.round(old + Math.min(lift / rings, cap) * (1 - d2 / r2))
        }
        // As the surface wears down, the voxels behind it (on both sides) have to follow, or
        // their stale distances bend the field and the rasp stalls on its own earlier work.
        // This also only ever raises a distance.
        if (old >= 0 && lo >= 0) {
          const air = Math.min(Q_MAX, Math.floor(near))
          if (air > q) q = air
        } else if (old < 0 && hi < 0) {
          const stone = -Math.ceil(near)
          if (stone > q) q = stone
        }
        if (q > old && form !== null) {
          const limit = protectedLimit(form, px, py, pz, qPerCm)
          if (limit < q) q = limit
        }
        let edited = false
        if (q > old) {
          dist[i] = q
          removed += OCC[old + 128]! - OCC[q + 128]!
          edited = true
        } else {
          q = old
        }
        if (q > FINISH_REACH && q < Q_PER_VOXEL && finish[i] !== mark) {
          finish[i] = mark
          edited = true
        }
        if (edited) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          touched = true
        }
      }
      if (touched) {
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
    }
  }
  return commit(grid, removed, form, minX, minY, minZ, maxX, maxY, maxZ)
}

// The stretch of a row of samples that lies less than `reach` behind a plane whose signed
// distance along the row is slope * x + offset. Empty when first > last.
function firstInRow(slope: number, offset: number, reach: number): number {
  return slope > 1e-9 ? Math.max(0, Math.floor((-reach - offset) / slope)) : 0
}

function lastInRow(slope: number, offset: number, reach: number, nx: number): number {
  if (slope < -1e-9) return Math.min(nx - 1, Math.ceil((-reach - offset) / slope))
  if (slope <= 1e-9 && offset <= -reach) return -1
  return nx - 1
}

// The saw: everything on the side of the plane its normal points to goes in one operation,
// and comes back as offcuts (one per connected piece).
function sawCut(grid: Grid, strike: SawStrike): StrikeResult {
  const { nx, ny, nz, voxel, x0, y0, z0, dist, finish, qPerCm } = grid
  let [nxn, nyn, nzn] = strike.plane.normal
  const len = Math.sqrt(nxn * nxn + nyn * nyn + nzn * nzn)
  if (!(len > 0)) throw new Error('saw plane normal has no length')
  nxn /= len
  nyn /= len
  nzn /= len
  const [px, py, pz] = strike.plane.point
  // Signed distance to the plane along one row of samples is slope * x + offset. Only the
  // stretch of each row less than a band behind the plane can change.
  const slope = nxn * voxel
  const reach = (BAND_VOXELS + 0.5) * voxel
  const rowOffset = (y: number, z: number) =>
    (x0 - px) * nxn + (y0 + y * voxel - py) * nyn + (z0 + z * voxel - pz) * nzn

  // First pass: the box around the stone that will come off, which is the stone at least
  // half a stored unit in front of the plane (where the rounded plane distance is positive).
  const front = 0.5 / qPerCm
  let minX = nx
  let maxX = -1
  let minY = ny
  let maxY = -1
  let minZ = nz
  let maxZ = -1
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const offset = rowOffset(y, z)
      const first = firstInRow(slope, offset, -front)
      const last = lastInRow(slope, offset, -front, nx)
      let i = first + nx * (y + ny * z)
      let touched = false
      for (let x = first; x <= last; x++, i++) {
        if (dist[i]! >= 0 || slope * x + offset < front) continue
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        touched = true
      }
      if (touched) {
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
    }
  }

  // The offcut gets a field of its own: the stone that was there, kept only in front of the
  // plane. Its rows are a multiple of four samples long for the island scan.
  const cut = maxX >= 0
  const pad = 3
  const tx = cut ? Math.ceil((maxX - minX + 1 + 2 * pad) / 4) * 4 : 0
  const ty = cut ? maxY - minY + 1 + 2 * pad : 0
  const tz = cut ? maxZ - minZ + 1 + 2 * pad : 0
  const piece = new Int8Array(tx * ty * tz).fill(Q_MAX)
  const gx = minX - pad
  const gy = minY - pad
  const gz = minZ - pad

  const mark = toolSpec('saw').finish
  let removed = 0
  let cMinX = nx
  let cMaxX = -1
  let cMinY = ny
  let cMaxY = -1
  let cMinZ = nz
  let cMaxZ = -1
  for (let z = 0; z < nz; z++) {
    const inZ = cut && z >= minZ - 1 && z <= maxZ + 1
    for (let y = 0; y < ny; y++) {
      const offset = rowOffset(y, z)
      const first = firstInRow(slope, offset, reach)
      const last = lastInRow(slope, offset, reach, nx)
      const copy = inZ && y >= minY - 1 && y <= maxY + 1
      const shift = copy ? -gx + tx * (y - gy + ty * (z - gz)) : 0
      let i = first + nx * (y + ny * z)
      let touched = false
      for (let x = first; x <= last; x++, i++) {
        let q = Math.round((slope * x + offset) * qPerCm)
        if (q > Q_MAX) q = Q_MAX
        else if (q < -Q_MAX) q = -Q_MAX
        const old = dist[i]!
        if (copy && x >= minX - 1 && x <= maxX + 1) piece[shift + x] = old > -q ? old : -q
        if (q <= old) continue
        dist[i] = q
        removed += OCC[old + 128]! - OCC[q + 128]!
        if (q > FINISH_REACH) finish[i] = mark
        if (x < cMinX) cMinX = x
        if (x > cMaxX) cMaxX = x
        touched = true
      }
      if (touched) {
        if (y < cMinY) cMinY = y
        if (y > cMaxY) cMaxY = y
        if (z < cMinZ) cMinZ = z
        if (z > cMaxZ) cMaxZ = z
      }
    }
  }
  const result = commit(grid, removed, null, cMinX, cMinY, cMinZ, cMaxX, cMaxY, cMaxZ)
  if (cut) {
    // The piece is a field of its own and gets the same tidying before it is meshed.
    changed[0] = 0
    changed[1] = 0
    changed[2] = 0
    changed[3] = tx - 1
    changed[4] = ty - 1
    changed[5] = tz - 1
    settle(piece, tx, ty, tz, null, grid)
    result.offcuts = extractOffcuts(piece, tx, ty, tz, gx, gy, gz, x0, y0, z0, voxel)
  }
  return result
}

// Applies one entry of the strike log to a grid. dirtyChunks lists the chunks whose meshes
// are now stale (they are also flagged on the grid for takeDirty). Same grid plus same
// strikes gives the same grid, bit for bit.
export function applyStrike(grid: Grid, strike: Strike): StrikeResult {
  if (strike.kind === 'saw') return sawCut(grid, strike)
  if (strike.kind === 'detach') return detachIslands(grid)
  if (strike.kind === 'form') {
    // Forms ride in the log so every copy of the stone learns them at the same point.
    declareForm(grid, strike.name, strike)
    return { dirtyChunks: [], removedCm3: 0, offcuts: [] }
  }
  const spec = toolSpec(strike.tool)
  if (spec.mode === 'bite') return bite(grid, strike, spec)
  if (spec.mode === 'abrade') return abrade(grid, strike, spec)
  throw new Error(`the ${strike.tool} works as a '${spec.mode}' strike, not a cut`)
}
