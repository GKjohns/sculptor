import { compileSilhouette, silhouetteDistance } from './silhouette.ts'
import type { Bins, CompiledForm, Form, Grid, ShapeKind } from './types.ts'

// Signed distances (cm, negative inside) for the primitives a form is declared in, and forms
// themselves: a smooth union of rotated primitives. A strike that names a form is clipped by
// it, and later sprints measure the stone against the same function.

const KINDS: ShapeKind[] = ['ellipsoid', 'box', 'capsule', 'cone']
const STRIDE = 16

// Not exact away from the surface, but its zero set is, and it is well behaved near it.
export function sdEllipsoid(x: number, y: number, z: number, rx: number, ry: number, rz: number): number {
  const ax = x / rx
  const ay = y / ry
  const az = z / rz
  const k0 = Math.sqrt(ax * ax + ay * ay + az * az)
  const bx = ax / rx
  const by = ay / ry
  const bz = az / rz
  const k1 = Math.sqrt(bx * bx + by * by + bz * bz)
  if (k1 < 1e-9) return -Math.min(rx, ry, rz)
  return k0 * (k0 - 1) / k1
}

export function sdBox(x: number, y: number, z: number, hx: number, hy: number, hz: number): number {
  const dx = Math.abs(x) - hx
  const dy = Math.abs(y) - hy
  const dz = Math.abs(z) - hz
  if (dx <= 0 && dy <= 0 && dz <= 0) return Math.max(dx, dy, dz)
  const ox = dx > 0 ? dx : 0
  const oy = dy > 0 ? dy : 0
  const oz = dz > 0 ? dz : 0
  return Math.sqrt(ox * ox + oy * oy + oz * oz)
}

// Stands along Y. height is the full height including both caps.
export function sdCapsule(x: number, y: number, z: number, radius: number, height: number): number {
  const half = Math.max(0, height / 2 - radius)
  const ay = Math.abs(y)
  const dy = ay > half ? ay - half : 0
  return Math.sqrt(x * x + dy * dy + z * z) - radius
}

// Stands along Y: base of the given radius at -height/2, apex at +height/2.
export function sdCone(x: number, y: number, z: number, radius: number, height: number): number {
  const rho = Math.sqrt(x * x + z * z)
  const hy = height / 2
  // Base disc.
  const br = rho > radius ? rho - radius : 0
  const bd = (y + hy) * (y + hy) + br * br
  // Slanted side, from the base rim to the apex.
  const px = rho - radius
  const py = y + hy
  let t = (py * height - px * radius) / (radius * radius + height * height)
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const sx = px + radius * t
  const sy = py - height * t
  const sd = sx * sx + sy * sy
  const d = Math.sqrt(bd < sd ? bd : sd)
  const inside = y > -hy && y < hy && rho * height < radius * (hy - y)
  return inside ? -d : d
}

// Polynomial smooth minimum; k is the blend radius.
export function smoothMin(a: number, b: number, k: number): number {
  const m = a < b ? a : b
  if (k <= 0) return m
  const h = k - Math.abs(a - b)
  return h > 0 ? m - h * h / (4 * k) : m
}

// sin and cos of an angle in degrees, written into out[0] and out[1]. Math.sin and Math.cos
// may differ in the last bit between engines, which would be enough to break replays, so this
// is a fixed polynomial over basic arithmetic.
function sinCosDeg(deg: number, out: Float64Array): void {
  const a = deg - 360 * Math.floor((deg + 180) / 360)
  const k = Math.round(a / 90)
  const r = (a - 90 * k) * 0.017453292519943295
  const r2 = r * r
  const s = r * (1 - r2 / 6 * (1 - r2 / 20 * (1 - r2 / 42 * (1 - r2 / 72 * (1 - r2 / 110 * (1 - r2 / 156))))))
  const c = 1 - r2 / 2 * (1 - r2 / 12 * (1 - r2 / 30 * (1 - r2 / 56 * (1 - r2 / 90 * (1 - r2 / 132 * (1 - r2 / 182))))))
  switch (k & 3) {
    case 0:
      out[0] = s
      out[1] = c
      break
    case 1:
      out[0] = c
      out[1] = -s
      break
    case 2:
      out[0] = -s
      out[1] = -c
      break
    default:
      out[0] = -c
      out[1] = s
  }
}

export function compileForm(form: Form): CompiledForm {
  const count = form.silhouette ? 0 : form.shapes.length
  const kinds = new Uint8Array(count)
  const data = new Float64Array(count * STRIDE)
  const reach = new Float64Array(count * 3)
  const ceil = new Float64Array(count * 2)
  const sc = new Float64Array(2)
  for (let i = 0; i < count; i++) {
    const shape = form.shapes[i]!
    const kind = KINDS.indexOf(shape.kind)
    if (kind < 0) throw new Error(`unknown shape kind: ${shape.kind}`)
    kinds[i] = kind
    const o = i * STRIDE
    data[o] = shape.center[0]
    data[o + 1] = shape.center[1]
    data[o + 2] = shape.center[2]
    // Zero-thickness shapes would divide by zero; a hair of thickness is harmless.
    data[o + 3] = Math.max(1e-3, Math.abs(shape.size[0]) / 2)
    data[o + 4] = Math.max(1e-3, Math.abs(shape.size[1]) / 2)
    data[o + 5] = Math.max(1e-3, Math.abs(shape.size[2]) / 2)
    sinCosDeg(shape.rotation[0], sc)
    const b = sc[0]!
    const a = sc[1]!
    sinCosDeg(shape.rotation[1], sc)
    const d = sc[0]!
    const c = sc[1]!
    sinCosDeg(shape.rotation[2], sc)
    const f = sc[0]!
    const e = sc[1]!
    // Columns of the three.js 'XYZ' Euler matrix, stored as rows: the inverse rotation.
    data[o + 6] = c * e
    data[o + 7] = a * f + b * e * d
    data[o + 8] = b * f - a * e * d
    data[o + 9] = -c * f
    data[o + 10] = a * e - b * f * d
    data[o + 11] = b * e + a * f * d
    data[o + 12] = d
    data[o + 13] = -b * c
    data[o + 14] = a * c
    // The form's blend unless the shape brings its own (never more than the form's).
    data[o + 15] = shape.blend === undefined ? Math.max(0, form.blend) : Math.max(0, Math.min(shape.blend, Math.max(0, form.blend)))
    // A lower bound on the shape's distance r cm from its centre: a * r - c, for r beyond the
    // third number. The round kinds and the box have exact distances, so the sphere round them
    // bounds them everywhere (scaled by the squash for the round kinds). The ellipsoid's
    // approximation k0 (k0 - 1) / k1 is at least (rmin / rmax)² (r - rmax), but only outside
    // that sphere.
    const hx = data[o + 3]!
    const hy = data[o + 4]!
    const hz = data[o + 5]!
    const q = i * 3
    // And an upper bound, for the bins below: for the ellipsoid's approximation,
    // (rmax / rmin)² max(0, r - rmin); for the others, r less the radius of the ball round the
    // centre that the shape holds (in the squashed frame for the round kinds).
    const w = i * 2
    if (kind === 0) {
      const lo = Math.min(hx, hy, hz)
      const hi = Math.max(hx, hy, hz)
      reach[q] = (lo / hi) * (lo / hi)
      reach[q + 1] = reach[q]! * hi
      reach[q + 2] = hi
      ceil[w] = (hi / lo) * (hi / lo)
      ceil[w + 1] = lo
    } else if (kind === 1) {
      reach[q] = 1
      reach[q + 1] = Math.sqrt(hx * hx + hy * hy + hz * hz)
      ceil[w] = 1
      ceil[w + 1] = Math.min(hx, hy, hz)
    } else {
      const squash = hx / hz
      const sphere = kind === 2 ? Math.max(hx, hy) : Math.sqrt(hx * hx + hy * hy)
      const big = squash > 1 ? squash : 1
      reach[q] = (squash < 1 ? squash : 1) / big
      reach[q + 1] = sphere / big
      ceil[w] = 1
      ceil[w + 1] = (kind === 2 ? hx : Math.min(hy, hx * hy / Math.sqrt(hx * hx + 4 * hy * hy))) / big
    }
  }
  const compiled: CompiledForm = {
    count, kinds, data, reach, ceil,
    bins: count >= BIN_MIN_SHAPES ? binsFor(data, count) : undefined,
    // A holder, so the copies a strike makes with its own margin share one table.
    memo: count >= MEMO_MIN_SHAPES ? {} : undefined,
    blend: Math.max(0, form.blend),
    inflate: form.inflate ?? 0,
    // A plain copy: the form may arrive as a log entry carrying other fields.
    source: { shapes: form.shapes, blend: form.blend }
  }
  if (form.inflate !== undefined) compiled.source.inflate = form.inflate
  if (form.silhouette) {
    compiled.silhouette = compileSilhouette(form.silhouette)
    compiled.source.silhouette = form.silhouette
  }
  return compiled
}

// ---------- bins ----------
// A form of many solids (a posed figure is a hundred and more) is costly to measure at every
// sample, and most of its solids are far from any one point. The space round it is cut into
// cells, and each cell keeps, in the form's own order, only the solids that can change the
// union somewhere in it: a solid is left out when its least distance anywhere in the cell is a
// blend or more above the greatest distance of a solid kept before it. The union is a running
// smooth minimum that never rises, and smoothMin(best, d) is exactly best when d is a blend or
// more above it, so leaving such a solid out changes nothing, to the last bit: forms of any size
// measure as before and every log replays as it was written.

const BIN_MIN_SHAPES = 8
const BIN_CM = 2.5
// The cells reach this far past the solids' own bounds; beyond them every solid is measured.
const BIN_PAD = 8

function binsFor(data: Float64Array, count: number): Bins {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < count; i++) {
    const o = i * STRIDE
    const r = Math.sqrt(data[o + 3]! ** 2 + data[o + 4]! ** 2 + data[o + 5]! ** 2)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, data[o + k]! - r)
      hi[k] = Math.max(hi[k]!, data[o + k]! + r)
    }
  }
  const n = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    lo[k] = lo[k]! - BIN_PAD
    n[k] = Math.max(1, Math.min(160, Math.ceil((hi[k]! + BIN_PAD - lo[k]!) / BIN_CM)))
  }
  return { x0: lo[0]!, y0: lo[1]!, z0: lo[2]!, nx: n[0]!, ny: n[1]!, nz: n[2]!, lists: new Array(n[0]! * n[1]! * n[2]!) }
}

// The solids that matter anywhere in one cell, in order.
function binList(form: CompiledForm, bins: Bins, ix: number, iy: number, iz: number): Int32Array {
  const { count, data, reach, ceil } = form
  const half = BIN_CM / 2
  const cx = bins.x0 + (ix + 0.5) * BIN_CM
  const cy = bins.y0 + (iy + 0.5) * BIN_CM
  const cz = bins.z0 + (iz + 0.5) * BIN_CM
  const spread = Math.sqrt(3) * half
  const keep: number[] = []
  let top = Infinity
  for (let i = 0; i < count; i++) {
    const o = i * STRIDE
    const dx = cx - data[o]!
    const dy = cy - data[o + 1]!
    const dz = cz - data[o + 2]!
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const near = r - spread
    const q = i * 3
    // The least this solid's distance can be anywhere in the cell.
    const floor = near > reach![q + 2]! ? reach![q]! * near - reach![q + 1]! : -Infinity
    if (keep.length > 0 && floor >= top + data[o + 15]! + 1e-6) continue
    keep.push(i)
    // The most it can be anywhere in the cell.
    const w = i * 2
    const far = r + spread
    const most = form.kinds[i] === 0 ? ceil![w]! * Math.max(0, far - ceil![w + 1]!) : far - ceil![w + 1]!
    if (most < top) top = most
  }
  const list = Int32Array.from(keep)
  bins.lists[ix + bins.nx * (iy + bins.ny * iz)] = list
  return list
}

// Distance from a world point to the form, cm, negative inside.
export function formDistance(form: CompiledForm, x: number, y: number, z: number): number {
  if (form.silhouette !== undefined) return silhouetteDistance(form.silhouette, x, y, z) - form.inflate
  return union(form, x, y, z) - form.inflate
}

// ---------- the sample memo ----------
// A strike clipped by a form measures the form at every sample it would cut, and the bites of
// one pass overlap many times. A form of many solids keeps what it measured at grid samples in
// a fixed table (slot by sample index, newest wins), so a sample measured again costs a lookup.
// It is the same number to the last bit; only a sample's index and its grid's layout key it.

const MEMO_BITS = 19
const MEMO_MIN_SHAPES = 16

export interface SampleGrid { nx: number, ny: number, voxel: number, x0: number, y0: number, z0: number }

// formDistance at grid sample `index`, which sits at (x, y, z) of `grid`.
export function formDistanceAt(form: CompiledForm, grid: SampleGrid, index: number, x: number, y: number, z: number): number {
  const box = form.memo
  if (form.silhouette !== undefined || box === undefined) return formDistance(form, x, y, z)
  let memo = box.table
  if (memo === undefined) {
    memo = { keys: new Int32Array(1 << MEMO_BITS).fill(-1), values: new Float64Array(1 << MEMO_BITS), nx: grid.nx, ny: grid.ny, voxel: grid.voxel, x0: grid.x0, y0: grid.y0, z0: grid.z0 }
    box.table = memo
  } else if (memo.nx !== grid.nx || memo.ny !== grid.ny || memo.voxel !== grid.voxel || memo.x0 !== grid.x0 || memo.y0 !== grid.y0 || memo.z0 !== grid.z0) {
    return formDistance(form, x, y, z)
  }
  const slot = Math.imul(index, 0x9e3779b1) >>> (32 - MEMO_BITS)
  if (memo.keys[slot] === index) return memo.values[slot]! - form.inflate
  const u = union(form, x, y, z)
  memo.keys[slot] = index
  memo.values[slot] = u
  return u - form.inflate
}

// The smooth union of the form's solids at a point, before any inflation.
function union(form: CompiledForm, x: number, y: number, z: number): number {
  const { count, kinds, data, reach, bins } = form
  let list: Int32Array | undefined
  if (bins !== undefined) {
    const ix = Math.floor((x - bins.x0) / BIN_CM)
    const iy = Math.floor((y - bins.y0) / BIN_CM)
    const iz = Math.floor((z - bins.z0) / BIN_CM)
    if (ix >= 0 && iy >= 0 && iz >= 0 && ix < bins.nx && iy < bins.ny && iz < bins.nz) {
      list = bins.lists[ix + bins.nx * (iy + bins.ny * iz)] ?? binList(form, bins, ix, iy, iz)
    }
  }
  const n = list === undefined ? count : list.length
  let best = 1e9
  let first = true
  for (let t = 0; t < n; t++) {
    const i = list === undefined ? t : list[t]!
    const o = i * STRIDE
    const px = x - data[o]!
    const py = y - data[o + 1]!
    const pz = z - data[o + 2]!
    // A shape whose distance here is surely a blend or more above the union so far cannot
    // change it: smoothMin(best, d) is exactly best when d >= best + blend. So skipping it
    // gives the same number, to the last bit, and every log replays as before.
    if (reach !== undefined && !first) {
      const r = Math.sqrt(px * px + py * py + pz * pz)
      const q = i * 3
      if (r > reach[q + 2]! && reach[q]! * r - reach[q + 1]! >= best + data[o + 15]! + 1e-6) continue
    }
    const lx = data[o + 6]! * px + data[o + 7]! * py + data[o + 8]! * pz
    const ly = data[o + 9]! * px + data[o + 10]! * py + data[o + 11]! * pz
    const lz = data[o + 12]! * px + data[o + 13]! * py + data[o + 14]! * pz
    const hx = data[o + 3]!
    const hy = data[o + 4]!
    const hz = data[o + 5]!
    let d: number
    const kind = kinds[i]!
    if (kind === 0) {
      d = sdEllipsoid(lx, ly, lz, hx, hy, hz)
    } else if (kind === 1) {
      d = sdBox(lx, ly, lz, hx, hy, hz)
    } else {
      // Capsules and cones are round in their own frame. An elliptical cross-section is the
      // round one squashed along Z, which shrinks distances by at most the squash factor.
      const squash = hx / hz
      d = kind === 2
        ? sdCapsule(lx, ly, lz * squash, hx, 2 * hy)
        : sdCone(lx, ly, lz * squash, hx, 2 * hy)
      if (squash > 1) d /= squash
    }
    best = first ? d : smoothMin(best, d, data[o + 15]!)
    first = false
  }
  return best
}

// Registers (or replaces) a named form on a grid. Strikes with protect: name will not cut
// into it. Anything that keeps a strike log should declare forms through a 'form' entry
// (applyStrike calls this), so a replay learns them at the same points in the log.
export function declareForm(grid: Grid, name: string, form: Form): CompiledForm {
  const compiled = compileForm(form)
  grid.forms.set(name, compiled)
  return compiled
}

export function forgetForm(grid: Grid, name: string): void {
  grid.forms.delete(name)
}
