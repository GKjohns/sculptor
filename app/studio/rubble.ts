/**
 * Mesh work on pieces that have come off the block, kept apart from the physics so it can be read
 * (and run) on its own: thinning a piece's very dense mesh, cleaving a piece in two along a plane,
 * and picking the points a convex collider is wrapped round. No three.js; plain typed arrays.
 *
 * A piece arrives as the kernel meshed it: surface nets at the grid's 0.4 cm, so a sawn slab is
 * over 100,000 triangles of which nearly all lie in six flat faces. Nothing here needs to be exact.
 * It needs to be cheap and to look like stone that broke.
 */

export interface Shell {
  /** xyz per vertex, cm, about the piece's own origin. */
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
}

export interface Bounds {
  min: [number, number, number]
  max: [number, number, number]
}

export function boundsOf(positions: Float32Array): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a]!
      if (v < min[a]!) min[a] = v
      if (v > max[a]!) max[a] = v
    }
  }
  return { min, max }
}

/** Volume enclosed by a closed shell, cm³ (the sum of the tetrahedra its triangles make with the origin). */
export function volumeOf(shell: Shell): number {
  const { positions: p, indices } = shell
  let six = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3
    const b = indices[i + 1]! * 3
    const c = indices[i + 2]! * 3
    six += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!)
      + p[a + 1]! * (p[b + 2]! * p[c]! - p[b]! * p[c + 2]!)
      + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)
  }
  return Math.abs(six) / 6
}

/**
 * Thins a shell by vertex clustering: every vertex in a `cell`-sized box becomes one vertex at
 * their average, and triangles that collapse are dropped. Flat faces stay flat and edges soften by
 * about a cell. A generator, so a 130,000 triangle slab can be thinned a few thousand vertices a
 * frame while it is still in the air: it yields between slices and returns the thinned shell.
 */
export function* thin(shell: Shell, cell: number, slice = 12000): Generator<void, Shell> {
  const { positions, normals, indices } = shell
  const verts = positions.length / 3
  const { min, max } = boundsOf(positions)
  const nx = Math.floor((max[0] - min[0]) / cell) + 1
  const ny = Math.floor((max[1] - min[1]) / cell) + 1
  const nz = Math.floor((max[2] - min[2]) / cell) + 1
  const cells = nx * ny * nz
  // A dense table when the box is small enough to afford one; a map for a long thin piece's diagonal.
  const table = cells <= 3_000_000 ? new Int32Array(cells).fill(-1) : null
  const sparse = table ? null : new Map<number, number>()
  const remap = new Uint32Array(verts)
  const sum = new Float32Array(verts * 3)
  const facing = new Float32Array(verts * 3)
  const members = new Uint32Array(verts)
  let clusters = 0
  yield
  for (let v = 0; v < verts; v++) {
    const x = positions[v * 3]!
    const y = positions[v * 3 + 1]!
    const z = positions[v * 3 + 2]!
    const key = Math.floor((x - min[0]) / cell) + nx * (Math.floor((y - min[1]) / cell) + ny * Math.floor((z - min[2]) / cell))
    let c = table ? table[key]! : sparse!.get(key) ?? -1
    if (c < 0) {
      c = clusters++
      if (table) table[key] = c
      else sparse!.set(key, c)
    }
    remap[v] = c
    sum[c * 3] = sum[c * 3]! + x
    sum[c * 3 + 1] = sum[c * 3 + 1]! + y
    sum[c * 3 + 2] = sum[c * 3 + 2]! + z
    facing[c * 3] = facing[c * 3]! + normals[v * 3]!
    facing[c * 3 + 1] = facing[c * 3 + 1]! + normals[v * 3 + 1]!
    facing[c * 3 + 2] = facing[c * 3 + 2]! + normals[v * 3 + 2]!
    members[c] = members[c]! + 1
    if (v % slice === slice - 1) yield
  }
  for (let c = 0; c < clusters; c++) {
    const n = members[c]!
    sum[c * 3] = sum[c * 3]! / n
    sum[c * 3 + 1] = sum[c * 3 + 1]! / n
    sum[c * 3 + 2] = sum[c * 3 + 2]! / n
    const fx = facing[c * 3]!
    const fy = facing[c * 3 + 1]!
    const fz = facing[c * 3 + 2]!
    const len = Math.hypot(fx, fy, fz) || 1
    facing[c * 3] = fx / len
    facing[c * 3 + 1] = fy / len
    facing[c * 3 + 2] = fz / len
  }
  yield
  const kept = new Uint32Array(indices.length)
  let corners = 0
  const step = slice * 3
  for (let i = 0; i < indices.length; i += 3) {
    const a = remap[indices[i]!]!
    const b = remap[indices[i + 1]!]!
    const c = remap[indices[i + 2]!]!
    if (a !== b && b !== c && a !== c) {
      kept[corners++] = a
      kept[corners++] = b
      kept[corners++] = c
    }
    if (i % step === step - 3) yield
  }
  return { positions: sum.slice(0, clusters * 3), normals: facing.slice(0, clusters * 3), indices: kept.slice(0, corners) }
}

interface Half {
  positions: number[]
  normals: number[]
  indices: number[]
  remap: Int32Array
}

/**
 * Cuts a closed shell in two along the plane n·p = d and closes both cuts, so each half is a
 * solid again. The first half is the side the normal points to. The cut face is a fan about the
 * middle of the cut, which is right for the roughly convex sections slabs have and close enough
 * for the rest. Null if the plane misses the shell or takes off no more than a few vertices of it.
 */
export function cleave(shell: Shell, n: [number, number, number], d: number): [Shell, Shell] | null {
  const { positions: p, normals: q, indices } = shell
  const verts = p.length / 3
  const dist = new Float32Array(verts)
  let above = 0
  for (let v = 0; v < verts; v++) {
    dist[v] = n[0] * p[v * 3]! + n[1] * p[v * 3 + 1]! + n[2] * p[v * 3 + 2]! - d
    if (dist[v]! >= 0) above++
  }
  if (above < 8 || verts - above < 8) return null

  const halves: [Half, Half] = [
    { positions: [], normals: [], indices: [], remap: new Int32Array(verts).fill(-1) },
    { positions: [], normals: [], indices: [], remap: new Int32Array(verts).fill(-1) }
  ]
  const take = (h: Half, v: number) => {
    let i = h.remap[v]!
    if (i < 0) {
      i = h.positions.length / 3
      h.positions.push(p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!)
      h.normals.push(q[v * 3]!, q[v * 3 + 1]!, q[v * 3 + 2]!)
      h.remap[v] = i
    }
    return i
  }
  // Where the cut crosses each triangle it splits: six numbers a segment.
  const cut: number[] = []
  const tri = [0, 0, 0]
  const poly: [number[], number[]] = [[], []]
  for (let i = 0; i < indices.length; i += 3) {
    tri[0] = indices[i]!
    tri[1] = indices[i + 1]!
    tri[2] = indices[i + 2]!
    const s0 = dist[tri[0]]! >= 0
    const s1 = dist[tri[1]!]! >= 0
    const s2 = dist[tri[2]!]! >= 0
    if (s0 === s1 && s1 === s2) {
      const h = halves[s0 ? 0 : 1]
      h.indices.push(take(h, tri[0]), take(h, tri[1]!), take(h, tri[2]!))
      continue
    }
    poly[0].length = poly[1].length = 0
    for (let e = 0; e < 3; e++) {
      const a = tri[e]!
      const b = tri[(e + 1) % 3]!
      const da = dist[a]!
      const db = dist[b]!
      const side = da >= 0 ? 0 : 1
      poly[side].push(take(halves[side], a))
      if ((da >= 0) === (db >= 0)) continue
      const t = da / (da - db)
      const x = p[a * 3]! + (p[b * 3]! - p[a * 3]!) * t
      const y = p[a * 3 + 1]! + (p[b * 3 + 1]! - p[a * 3 + 1]!) * t
      const z = p[a * 3 + 2]! + (p[b * 3 + 2]! - p[a * 3 + 2]!) * t
      const nx = q[a * 3]! + (q[b * 3]! - q[a * 3]!) * t
      const ny = q[a * 3 + 1]! + (q[b * 3 + 1]! - q[a * 3 + 1]!) * t
      const nz = q[a * 3 + 2]! + (q[b * 3 + 2]! - q[a * 3 + 2]!) * t
      const len = Math.hypot(nx, ny, nz) || 1
      for (let s = 0; s < 2; s++) {
        const h = halves[s]!
        poly[s]!.push(h.positions.length / 3)
        h.positions.push(x, y, z)
        h.normals.push(nx / len, ny / len, nz / len)
      }
      cut.push(x, y, z)
    }
    for (let s = 0; s < 2; s++) {
      const ring = poly[s]!
      for (let k = 1; k + 1 < ring.length; k++) halves[s]!.indices.push(ring[0]!, ring[k]!, ring[k + 1]!)
    }
  }
  if (cut.length < 18 || halves[0].indices.length < 36 || halves[1].indices.length < 36) return null

  // The cut face: a fan about the middle of the crossings, facing out of each half.
  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < cut.length; i += 3) {
    cx += cut[i]!
    cy += cut[i + 1]!
    cz += cut[i + 2]!
  }
  const points = cut.length / 3
  cx /= points
  cy /= points
  cz /= points
  for (let i = 0; i + 5 < cut.length; i += 6) {
    const ax = cut[i]! - cx
    const ay = cut[i + 1]! - cy
    const az = cut[i + 2]! - cz
    const bx = cut[i + 3]! - cx
    const by = cut[i + 4]! - cy
    const bz = cut[i + 5]! - cz
    // Which way this triangle of the fan winds, seen along the plane's normal.
    const w = (ay * bz - az * by) * n[0] + (az * bx - ax * bz) * n[1] + (ax * by - ay * bx) * n[2]
    for (let s = 0; s < 2; s++) {
      const h = halves[s]!
      // The first half lies on the normal's side, so its cut face looks back along the normal.
      const sign = s === 0 ? -1 : 1
      const base = h.positions.length / 3
      h.positions.push(cx, cy, cz, cut[i]!, cut[i + 1]!, cut[i + 2]!, cut[i + 3]!, cut[i + 4]!, cut[i + 5]!)
      for (let k = 0; k < 3; k++) h.normals.push(n[0] * sign, n[1] * sign, n[2] * sign)
      if (w * sign >= 0) h.indices.push(base, base + 1, base + 2)
      else h.indices.push(base, base + 2, base + 1)
    }
  }
  const shellOf = (h: Half): Shell => ({ positions: new Float32Array(h.positions), normals: new Float32Array(h.normals), indices: new Uint32Array(h.indices) })
  return [shellOf(halves[0]), shellOf(halves[1])]
}

// The directions a collider's corners are looked for in: the axes, the face diagonals, the cube
// diagonals, and a ring of in-betweens. 42 in all, which wraps a slab or a wedge closely.
const SEEK: number[] = (() => {
  const out: number[] = []
  const add = (x: number, y: number, z: number) => {
    const len = Math.hypot(x, y, z)
    out.push(x / len, y / len, z / len)
  }
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) add(x, y, z)
  for (const s of [-1, 1]) {
    for (const t of [-1, 1]) {
      add(s * 2, t, 0)
      add(s, t * 2, 0)
      add(s * 2, 0, t)
      add(s, 0, t * 2)
    }
  }
  return out
})()

/** The vertices that stand furthest out in a spread of directions: the points to wrap a convex collider round. */
export function extremes(positions: Float32Array, most = 4000): Float32Array {
  const verts = positions.length / 3
  const stride = Math.max(1, Math.floor(verts / most))
  const dirs = SEEK.length / 3
  const best = new Float32Array(dirs).fill(-Infinity)
  const at = new Int32Array(dirs).fill(-1)
  for (let v = 0; v < verts; v += stride) {
    const x = positions[v * 3]!
    const y = positions[v * 3 + 1]!
    const z = positions[v * 3 + 2]!
    for (let k = 0; k < dirs; k++) {
      const dot = x * SEEK[k * 3]! + y * SEEK[k * 3 + 1]! + z * SEEK[k * 3 + 2]!
      if (dot > best[k]!) {
        best[k] = dot
        at[k] = v
      }
    }
  }
  const seen = new Set<number>()
  const out: number[] = []
  for (let k = 0; k < dirs; k++) {
    const v = at[k]!
    if (v < 0 || seen.has(v)) continue
    seen.add(v)
    out.push(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!)
  }
  return new Float32Array(out)
}
