import type { CompiledSilhouette, Form, Outline, OutlineField, Silhouette } from './types.ts'

// A form made from two outlines instead of primitives: "the volume common to the front and
// left reference outlines pushed through the block". It is declared, protected, logged and
// replayed like any other form; the outlines ride in the `form` log entry as runs.
//
// Mask convention (the same one shared/agent/reference.ts writes): data[row * width + col],
// non-zero = inside. The image spans a whole face of the block. Row 0 is the top of the block
// and the last row its base. Front: column 0 is X = -width/2, columns run toward +X. Left:
// column 0 is Z = -depth/2 (the back), columns run toward +Z.

export interface Mask { width: number, height: number, data: Uint8Array }

export interface BlockSize { width: number, height: number, depth: number }

export function maskOutline(mask: Mask): Outline {
  const { width, height, data } = mask
  if (data.length < width * height) throw new Error('mask data is shorter than width × height')
  const rows: number[][] = []
  for (let r = 0; r < height; r++) {
    const runs: number[] = []
    let open = -1
    for (let c = 0; c < width; c++) {
      if (data[r * width + c]) {
        if (open < 0) open = c
      } else if (open >= 0) {
        runs.push(open, c)
        open = -1
      }
    }
    if (open >= 0) runs.push(open, width)
    rows.push(runs)
  }
  return { width, height, rows }
}

// The form whose volume is common to both outlines pushed through a block of this size.
// Declare it with a `form` strike (or hand it to roughOut, which does).
export function silhouetteForm(front: Mask, left: Mask, block: BlockSize): Form {
  return {
    shapes: [],
    blend: 0,
    silhouette: { front: maskOutline(front), left: maskOutline(left), size: [block.width, block.height, block.depth] }
  }
}

const FAR = 1e20

// One pass of the Felzenszwalb–Huttenlocher distance transform along a line of n cells:
// d[q] = min over p of (s2 × (q − p)² + f[p]). Plain arithmetic only, so it compiles to the
// same field on every engine.
function transformLine(f: Float64Array, n: number, s2: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    // Where q's parabola crosses the last one kept; drop kept ones it undercuts entirely.
    // z[0] is -Infinity and s is always finite, so k never goes below 0.
    const fq = f[q]! + s2 * q * q
    let p = v[k]!
    let s = (fq - (f[p]! + s2 * p * p)) / (2 * s2 * (q - p))
    while (s <= z[k]!) {
      k--
      p = v[k]!
      s = (fq - (f[p]! + s2 * p * p)) / (2 * s2 * (q - p))
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++
    const p = v[k]!
    d[q] = s2 * (q - p) * (q - p) + f[p]!
  }
}

// Squared distance, cm², from every cell to the nearest cell where seed is `want`.
function squaredDistances(seed: Uint8Array, want: number, w: number, h: number, sx: number, sy: number): Float64Array {
  const out = new Float64Array(w * h)
  const n = Math.max(w, h)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  for (let c = 0; c < w; c++) {
    for (let r = 0; r < h; r++) f[r] = seed[r * w + c] === want ? 0 : FAR
    transformLine(f, h, sy * sy, d, v, z)
    for (let r = 0; r < h; r++) out[r * w + c] = d[r]!
  }
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) f[c] = out[r * w + c]!
    transformLine(f, w, sx * sx, d, v, z)
    for (let c = 0; c < w; c++) out[r * w + c] = d[c]!
  }
  return out
}

// Far enough to count as "nowhere near" for an outline with nothing in it (or nothing out).
const NOWHERE = 1000

function compileOutline(outline: Outline, faceWidth: number, faceHeight: number): OutlineField {
  const { width: w, height: h } = outline
  if (!(w > 0 && h > 0) || outline.rows.length < h) throw new Error('outline has no cells')
  const cells = new Uint8Array(w * h)
  for (let r = 0; r < h; r++) {
    const runs = outline.rows[r]!
    for (let k = 0; k + 1 < runs.length; k += 2) {
      const a = Math.max(0, Math.min(w, runs[k]!))
      const b = Math.max(a, Math.min(w, runs[k + 1]!))
      cells.fill(1, r * w + a, r * w + b)
    }
  }
  const sx = faceWidth / w
  const sy = faceHeight / h
  const toInside = squaredDistances(cells, 1, w, h, sx, sy)
  const toOutside = squaredDistances(cells, 0, w, h, sx, sy)
  // The outline's edge runs midway between an inside cell and the outside cell next to it.
  const half = (sx + sy) / 4
  const field = new Float32Array(w * h)
  for (let i = 0; i < field.length; i++) {
    const d = cells[i] === 1 ? half - Math.sqrt(toOutside[i]!) : Math.sqrt(toInside[i]!) - half
    field[i] = d > NOWHERE ? NOWHERE : d < -NOWHERE ? -NOWHERE : d
  }
  return { width: w, height: h, sx, sy, left: -faceWidth / 2, top: faceHeight, field }
}

export function compileSilhouette(s: Silhouette): CompiledSilhouette {
  return {
    front: compileOutline(s.front, s.size[0], s.size[1]),
    left: compileOutline(s.left, s.size[2], s.size[1])
  }
}

// Bilinear read of an outline's distance image at horizontal coordinate u and height y. Past
// the image's edge the edge value carries on, so a figure standing on the base (or touching a
// face) reads as continuing through it.
function outlineDistance(o: OutlineField, u: number, y: number): number {
  let fc = (u - o.left) / o.sx - 0.5
  let fr = (o.top - y) / o.sy - 0.5
  const maxC = o.width - 1
  const maxR = o.height - 1
  fc = fc < 0 ? 0 : fc > maxC ? maxC : fc
  fr = fr < 0 ? 0 : fr > maxR ? maxR : fr
  let c = Math.floor(fc)
  let r = Math.floor(fr)
  if (c >= maxC && maxC > 0) c = maxC - 1
  if (r >= maxR && maxR > 0) r = maxR - 1
  const tc = fc - c
  const tr = fr - r
  const { field, width } = o
  const i = r * width + c
  const right = maxC > 0 ? 1 : 0
  const down = maxR > 0 ? width : 0
  const a = field[i]! + (field[i + right]! - field[i]!) * tc
  const b = field[i + down]! + (field[i + down + right]! - field[i + down]!) * tc
  return a + (b - a) * tr
}

// Distance from a world point to the silhouette volume, cm, negative inside. Not an exact
// 3D distance (it is the larger of the two outline distances), but its zero set is exact and
// growing it by a margin never under-covers the true offset.
export function silhouetteDistance(s: CompiledSilhouette, x: number, y: number, z: number): number {
  const f = outlineDistance(s.front, x, y)
  const l = outlineDistance(s.left, z, y)
  return f > l ? f : l
}
