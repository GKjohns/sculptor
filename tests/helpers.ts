/**
 * Mesh checks shared by the kernel tests. Not a test file itself.
 */
import type { MeshData, Offcut } from '../shared/sculpt/types.ts'

type Mesh = Pick<MeshData, 'positions' | 'indices'> | Offcut

export interface Stitched {
  vertexCount: number
  // Triangle corners as welded vertex ids.
  triangles: Uint32Array
  // For each input mesh, the welded id of each of its vertices.
  ids: Uint32Array[]
}

// Welds vertices that sit at exactly the same position (compared bit for bit), which is how
// the copies of a vertex on either side of a chunk seam are meant to line up.
export function stitch(meshes: Mesh[]): Stitched {
  let total = 0
  let corners = 0
  for (const m of meshes) {
    total += m.positions.length / 3
    corners += m.indices.length
  }
  let cap = 16
  while (cap < total * 2) cap *= 2
  const table = new Int32Array(cap).fill(-1)
  const keys = new Uint32Array(total * 3)
  const triangles = new Uint32Array(corners)
  const allIds: Uint32Array[] = []
  let unique = 0
  let out = 0
  for (const m of meshes) {
    const bits = new Uint32Array(m.positions.buffer, m.positions.byteOffset, m.positions.length)
    const ids = new Uint32Array(bits.length / 3)
    for (let v = 0; v < ids.length; v++) {
      const a = bits[3 * v]!
      const b = bits[3 * v + 1]!
      const c = bits[3 * v + 2]!
      // Float bit patterns of round coordinates differ mostly in their high bits, so the
      // hash is stirred before its low bits pick the slot.
      let h = Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)
      h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
      h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
      let slot = ((h ^ (h >>> 16)) >>> 0) % cap
      for (;;) {
        const id = table[slot]!
        if (id < 0) {
          table[slot] = unique
          keys[3 * unique] = a
          keys[3 * unique + 1] = b
          keys[3 * unique + 2] = c
          ids[v] = unique++
          break
        }
        if (keys[3 * id] === a && keys[3 * id + 1] === b && keys[3 * id + 2] === c) {
          ids[v] = id
          break
        }
        slot = (slot + 1) % cap
      }
    }
    for (let k = 0; k < m.indices.length; k++) triangles[out++] = ids[m.indices[k]!]!
    allIds.push(ids)
  }
  return { vertexCount: unique, triangles, ids: allIds }
}

export interface EdgeReport {
  triangles: number
  // Triangles with two corners welded together.
  degenerate: number
  // Directed edges used by more than one triangle.
  repeated: number
  // Directed edges with no triangle running the other way along them.
  unmatched: number
}

// A mesh is watertight when every edge is shared by exactly two triangles. This checks the
// stronger, oriented form: every directed edge a→b appears once, and b→a appears once. All
// three counts are zero for a closed surface with consistent winding, and only then.
export function edgeReport(mesh: Stitched): EdgeReport {
  const { triangles, vertexCount } = mesh
  const n = triangles.length
  const forward = new Float64Array(n)
  const backward = new Float64Array(n)
  let degenerate = 0
  for (let t = 0; t < n; t += 3) {
    const a = triangles[t]!
    const b = triangles[t + 1]!
    const c = triangles[t + 2]!
    if (a === b || b === c || c === a) degenerate++
    forward[t] = a * vertexCount + b
    forward[t + 1] = b * vertexCount + c
    forward[t + 2] = c * vertexCount + a
    backward[t] = b * vertexCount + a
    backward[t + 1] = c * vertexCount + b
    backward[t + 2] = a * vertexCount + c
  }
  forward.sort()
  backward.sort()
  let repeated = 0
  let unmatched = 0
  for (let i = 0; i < n; i++) {
    if (i > 0 && forward[i] === forward[i - 1]) repeated++
    if (forward[i] !== backward[i]) unmatched++
  }
  return { triangles: n / 3, degenerate, repeated, unmatched }
}

export const WATERTIGHT = { degenerate: 0, repeated: 0, unmatched: 0 }

export function watertight(report: EdgeReport) {
  return { degenerate: report.degenerate, repeated: report.repeated, unmatched: report.unmatched }
}

// Volume enclosed by closed meshes, cm³. Positive when triangles wind counter-clockwise
// seen from outside.
export function meshVolume(meshes: Mesh[]): number {
  let six = 0
  for (const m of meshes) {
    const p = m.positions
    const idx = m.indices
    for (let t = 0; t < idx.length; t += 3) {
      const a = 3 * idx[t]!
      const b = 3 * idx[t + 1]!
      const c = 3 * idx[t + 2]!
      const ax = p[a]!
      const ay = p[a + 1]!
      const az = p[a + 2]!
      const bx = p[b]!
      const by = p[b + 1]!
      const bz = p[b + 2]!
      const cx = p[c]!
      const cy = p[c + 1]!
      const cz = p[c + 2]!
      six += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)
    }
  }
  return six / 6
}

// Share of triangles whose stored vertex normals point the same way the triangle faces.
export function normalAgreement(meshes: (MeshData | Offcut)[]): number {
  let agree = 0
  let total = 0
  for (const m of meshes) {
    const p = m.positions
    const nrm = m.normals
    const idx = m.indices
    for (let t = 0; t < idx.length; t += 3) {
      const a = 3 * idx[t]!
      const b = 3 * idx[t + 1]!
      const c = 3 * idx[t + 2]!
      const ux = p[b]! - p[a]!
      const uy = p[b + 1]! - p[a + 1]!
      const uz = p[b + 2]! - p[a + 2]!
      const vx = p[c]! - p[a]!
      const vy = p[c + 1]! - p[a + 1]!
      const vz = p[c + 2]! - p[a + 2]!
      const fx = uy * vz - uz * vy
      const fy = uz * vx - ux * vz
      const fz = ux * vy - uy * vx
      const sx = nrm[a]! + nrm[b]! + nrm[c]!
      const sy = nrm[a + 1]! + nrm[b + 1]! + nrm[c + 1]!
      const sz = nrm[a + 2]! + nrm[b + 2]! + nrm[c + 2]!
      if (fx * sx + fy * sy + fz * sz > 0) agree++
      total++
    }
  }
  return total === 0 ? 1 : agree / total
}

// Number of vertices whose copies in different meshes (the two sides of a chunk seam)
// disagree on normal or finish. Seams are invisible only if this is zero.
export function seamMismatches(meshes: MeshData[], stitched: Stitched): { shared: number, mismatched: number } {
  const first = new Int32Array(stitched.vertexCount * 2).fill(-1)
  let shared = 0
  let mismatched = 0
  for (let m = 0; m < meshes.length; m++) {
    const mesh = meshes[m]!
    const ids = stitched.ids[m]!
    for (let v = 0; v < ids.length; v++) {
      const id = ids[v]!
      if (first[2 * id]! < 0) {
        first[2 * id] = m
        first[2 * id + 1] = v
        continue
      }
      const other = meshes[first[2 * id]!]!
      const w = first[2 * id + 1]!
      shared++
      const same = mesh.normals[3 * v] === other.normals[3 * w]
        && mesh.normals[3 * v + 1] === other.normals[3 * w + 1]
        && mesh.normals[3 * v + 2] === other.normals[3 * w + 2]
        && mesh.finish[v] === other.finish[w]
      if (!same) mismatched++
    }
  }
  return { shared, mismatched }
}

export function within(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= Math.abs(expected) * tolerance
}
