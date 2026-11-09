import { OCC, OCC_FULL, stoneMassKg, stoneVolumeCm3, unitsToCm3 } from './grid.ts'
import { sampleDistance } from './raycast.ts'
import { formDistance } from './shapes.ts'
import { VIEWS } from './views.ts'
import type { AxisView } from './views.ts'
import type { CompiledForm, Grid, Vec3 } from './types.ts'

// Numbers computed by code, to keep the model honest: vision models misjudge subtle 3D
// differences, so every look carries these beside the picture.
//
// MASK ↔ BLOCK MAPPING. Silhouettes, reference outlines, rough_out to a reference and the
// observer's reference overlay all use this one mapping.
//
// A mask is a row-major binary image (data[row * width + col], non-zero = inside; masks made
// here hold 1) of one face of the block, drawn as that view shows it. It spans the whole
// face of the ORIGINAL block and nothing else: no margin, any resolution, pixels need not
// be square. Pixel (col, row), counted from the top-left, covers the ruler coordinates
//
//   h = hLeft + (col + 0.5) / width  * hSpan
//   v = vTop  + (row + 0.5) / height * vSpan
//
//   view    h   col 0 is at   last col is at   v   row 0 is at    last row is at
//   front   X   -w/2          +w/2             Y   height (top)   0 (base)
//   back    X   +w/2          -w/2             Y   height         0
//   left    Z   -d/2          +d/2             Y   height         0
//   right   Z   +d/2          -d/2             Y   height         0
//   top     X   -w/2          +w/2             Z   -d/2           +d/2
//
// with w, height, d = grid.size (60, 100, 60 by default). The mask pushed through the block
// along the view direction is the solid it stands for: a world point (x, y, z) is inside the
// front mask's solid when the pixel under (x, y) is set, whatever z is. maskToBlock,
// blockToMask and maskCovers are that mapping as code.

export interface Mask { width: number, height: number, data: Uint8Array }

export type SideView = 'front' | 'back' | 'right' | 'left'

type Sized = Pick<Grid, 'size'>

interface Face { h: 0 | 2, v: 1 | 2, hLeft: number, hSpan: number, vTop: number, vSpan: number }

function face(size: Vec3, view: AxisView): Face {
  const def = VIEWS[view]
  const h = def.h!
  const v = def.v!
  // Signed, so a ruler that runs right to left (back, right) has a negative span.
  const hSpan = def.right[h] * size[h]
  const vSpan = -def.up[v] * size[v]
  const cv = v === 1 ? size[1] / 2 : 0
  return { h, v, hLeft: -hSpan / 2, hSpan, vTop: cv - vSpan / 2, vSpan }
}

// Centre of mask pixel (col, row) as the view's two ruler coordinates, cm.
export function maskToBlock(grid: Sized, view: AxisView, width: number, height: number, col: number, row: number): [number, number] {
  const f = face(grid.size, view)
  return [f.hLeft + (col + 0.5) / width * f.hSpan, f.vTop + (row + 0.5) / height * f.vSpan]
}

// Ruler coordinates to continuous mask coordinates: the pixel that holds the point is
// (floor(col), floor(row)), and it is off the mask when either is outside [0, size).
export function blockToMask(grid: Sized, view: AxisView, width: number, height: number, h: number, v: number): [number, number] {
  const f = face(grid.size, view)
  return [(h - f.hLeft) / f.hSpan * width, (v - f.vTop) / f.vSpan * height]
}

// Whether a world point lies inside the mask pushed through the block along its view.
export function maskCovers(mask: Mask, grid: Sized, view: AxisView, x: number, y: number, z: number): boolean {
  const f = face(grid.size, view)
  const p = [x, y, z]
  const col = Math.floor((p[f.h]! - f.hLeft) / f.hSpan * mask.width)
  const row = Math.floor((p[f.v]! - f.vTop) / f.vSpan * mask.height)
  if (col < 0 || row < 0 || col >= mask.width || row >= mask.height) return false
  return mask.data[col + row * mask.width]! > 0
}

// The lowest stored distance in every column of samples along one axis: negative wherever
// the column passes through stone. Indexed ih + nh * iv, where h and v are the other two
// axes in the order (x, y), (x, z) or (z, y) for columns along z, y and x.
function columnMin(grid: Grid, axis: number): Int8Array {
  const { nx, ny, nz, dist } = grid
  if (axis === 2) {
    const out = new Int8Array(nx * ny).fill(127)
    const layer = nx * ny
    for (let k = 0, p = 0; k < nz; k++) {
      for (let m = 0; m < layer; m++, p++) if (dist[p]! < out[m]!) out[m] = dist[p]!
    }
    return out
  }
  if (axis === 1) {
    const out = new Int8Array(nx * nz).fill(127)
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        let p = nx * (j + ny * k)
        for (let m = nx * k, end = m + nx; m < end; m++, p++) if (dist[p]! < out[m]!) out[m] = dist[p]!
      }
    }
    return out
  }
  const out = new Int8Array(nz * ny).fill(127)
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      let low = 127
      for (let p = nx * (j + ny * k), end = p + nx; p < end; p++) if (dist[p]! < low) low = dist[p]!
      out[k + nz * j] = low
    }
  }
  return out
}

// The stone's own silhouette from an axis view as a mask in the mapping above. Edges are
// placed to a fraction of a voxel by interpolating between columns.
export function stoneSilhouette(grid: Grid, view: AxisView, width: number, height: number): Mask {
  const f = face(grid.size, view)
  const low = columnMin(grid, 3 - f.h - f.v)
  const n = [grid.nx, grid.ny, grid.nz]
  const o = [grid.x0, grid.y0, grid.z0]
  const nh = n[f.h]!
  const nv = n[f.v]!
  const data = new Uint8Array(width * height)
  for (let row = 0; row < height; row++) {
    const fv = (f.vTop + (row + 0.5) / height * f.vSpan - o[f.v]!) / grid.voxel
    const iv = Math.floor(fv)
    if (iv < 0 || iv >= nv - 1) continue
    const tv = fv - iv
    for (let col = 0; col < width; col++) {
      const fh = (f.hLeft + (col + 0.5) / width * f.hSpan - o[f.h]!) / grid.voxel
      const ih = Math.floor(fh)
      if (ih < 0 || ih >= nh - 1) continue
      const th = fh - ih
      const m = ih + nh * iv
      const a = low[m]! + (low[m + 1]! - low[m]!) * th
      const b = low[m + nh]! + (low[m + nh + 1]! - low[m + nh]!) * th
      if (a + (b - a) * tv < 0) data[col + row * width] = 1
    }
  }
  return { width, height, data }
}

export interface SilhouetteAgreement {
  // Intersection over union of the stone's silhouette and the outline; 1 is a perfect match.
  iou: number
  // Share of the stone's silhouette that lies outside the outline: stone still to remove.
  stoneOutside: number
  // Share of the outline with no stone behind it: lost, stone cannot be put back.
  outlineOutside: number
  stoneAreaCm2: number
  outlineAreaCm2: number
}

// How well the stone's silhouette in a view agrees with an outline given as a mask in the
// mapping above. Compared at the mask's own resolution.
export function silhouetteAgreement(grid: Grid, view: AxisView, outline: Mask): SilhouetteAgreement {
  const stone = stoneSilhouette(grid, view, outline.width, outline.height).data
  let both = 0
  let stoneOnly = 0
  let outlineOnly = 0
  for (let i = 0; i < stone.length; i++) {
    const s = stone[i] === 1
    const m = outline.data[i]! > 0
    if (s && m) both++
    else if (s) stoneOnly++
    else if (m) outlineOnly++
  }
  const f = face(grid.size, view)
  const pixel = Math.abs(f.hSpan / outline.width * f.vSpan / outline.height)
  const union = both + stoneOnly + outlineOnly
  return {
    iou: union === 0 ? 1 : both / union,
    stoneOutside: both + stoneOnly === 0 ? 0 : stoneOnly / (both + stoneOnly),
    outlineOutside: both + outlineOnly === 0 ? 0 : outlineOnly / (both + outlineOnly),
    stoneAreaCm2: (both + stoneOnly) * pixel,
    outlineAreaCm2: (both + outlineOnly) * pixel
  }
}

export interface StoneBounds { min: Vec3, max: Vec3, empty: boolean }

// The box around what stone is left, cm, block coordinates. Each side is placed from the
// outermost stone sample's own distance to the surface, so flat faces come out exact.
export function stoneBounds(grid: Grid): StoneBounds {
  const { nx, ny, nz, dist, voxel } = grid
  // Outermost stone sample index on each side (min x, y, z then max x, y, z), and the
  // deepest stored distance among the stone samples of that outermost layer.
  const edge = [nx, ny, nz, -1, -1, -1]
  const deep = [0, 0, 0, 0, 0, 0]
  const note = (side: number, index: number, q: number): void => {
    const further = side < 3 ? index < edge[side]! : index > edge[side]!
    if (further) {
      edge[side] = index
      deep[side] = q
    } else if (index === edge[side] && q < deep[side]!) {
      deep[side] = q
    }
  }
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const row = nx * (j + ny * k)
      let a = 0
      while (a < nx && dist[row + a]! >= 0) a++
      if (a === nx) continue
      let b = nx - 1
      while (dist[row + b]! >= 0) b--
      note(0, a, dist[row + a]!)
      note(3, b, dist[row + b]!)
      note(1, j, 0)
      note(4, j, 0)
      note(2, k, 0)
      note(5, k, 0)
    }
  }
  if (edge[3]! < 0) return { min: [0, 0, 0], max: [0, 0, 0], empty: true }
  // The y and z sides need the deepest sample of their whole outermost layer.
  const layer = (side: number, j: number, k: number): void => {
    const row = nx * (j + ny * k)
    for (let i = edge[0]!; i <= edge[3]!; i++) if (dist[row + i]! < deep[side]!) deep[side] = dist[row + i]!
  }
  for (let k = edge[2]!; k <= edge[5]!; k++) {
    layer(1, edge[1]!, k)
    layer(4, edge[4]!, k)
  }
  for (let j = edge[1]!; j <= edge[4]!; j++) {
    layer(2, j, edge[2]!)
    layer(5, j, edge[5]!)
  }
  const o = [grid.x0, grid.y0, grid.z0]
  const side = (n: number): number => {
    const out = Math.min(voxel, -deep[n]! / grid.qPerCm)
    return o[n % 3]! + edge[n]! * voxel + (n < 3 ? -out : out)
  }
  return { min: [side(0), side(1), side(2)], max: [side(3), side(4), side(5)], empty: false }
}

export interface FormFit {
  // Furthest the stone's surface stands outside the form, cm.
  proudMaxCm: number
  // Mean of the same over the whole carvable surface (not the base), counting zero where
  // the surface is at or inside the form. Falls to zero as the stone closes on the form.
  proudMeanCm: number
  // Stone outside the form: what is still to come off.
  outsideCm3: number
  // The reverse, which cannot be undone: the deepest point of the form, and the volume of
  // it, that no longer has stone. Only the part of the form inside the original block counts.
  overcutMaxCm: number
  overcutCm3: number
  // Share of the carvable surface within NEAR_FORM_CM of the form, 0 to 1.
  nearShare: number
}

export const NEAR_FORM_CM = 1

function unionDistance(forms: CompiledForm[], x: number, y: number, z: number): number {
  let best = formDistance(forms[0]!, x, y, z)
  for (let i = 1; i < forms.length; i++) {
    const d = formDistance(forms[i]!, x, y, z)
    if (d < best) best = d
  }
  return best
}

// The stone against a declared form (or the union of several). Distances are formDistance's:
// exact for spheres, boxes and round capsules, first-order for squashed ellipsoids, and the
// same measure rough_out's margin is in.
export function proudOfForm(grid: Grid, form: CompiledForm | CompiledForm[]): FormFit {
  const forms = Array.isArray(form) ? form : [form]
  if (forms.length === 0) throw new Error('proudOfForm needs at least one form')
  const { nx, ny, nz, dist, voxel, x0, y0, z0, qPerCm } = grid
  const sy = nx
  const sz = nx * ny

  // Surface pass: stone samples with air beside them. The base face rests on the banker
  // and cannot be carved, so air underneath the lowest layer does not count.
  let count = 0
  let near = 0
  let sum = 0
  let proudMax = 0
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      let p = 1 + nx * (j + ny * k)
      for (let i = 1; i < nx - 1; i++, p++) {
        const q = dist[p]!
        if (q >= 0 || q < -64) continue
        if (!(dist[p - 1]! >= 0 || dist[p + 1]! >= 0 || dist[p + sy]! >= 0 || dist[p - sz]! >= 0
          || dist[p + sz]! >= 0 || (j !== grid.baseY && dist[p - sy]! >= 0))) continue
        // The sample sits a little inside the stone; the surface is that much further out.
        const f = unionDistance(forms, x0 + i * voxel, y0 + j * voxel, z0 + k * voxel) - q / qPerCm
        count++
        if (f > 0) {
          sum += f
          if (f > proudMax) proudMax = f
        }
        if (f < NEAR_FORM_CM && f > -NEAR_FORM_CM) near++
      }
    }
  }

  // Volume pass over the original block in cells of 2³ samples. Where a cell is all stone,
  // all air, or clear of the form's surface, one form evaluation settles it; cells that
  // straddle both surfaces are settled sample by sample. Stone and form are treated as
  // nested within a cell, so a stone that fits its form exactly scores zero both ways.
  const i0 = Math.round((-grid.size[0] / 2 + voxel / 2 - x0) / voxel)
  const j0 = Math.round((voxel / 2 - y0) / voxel)
  const k0 = Math.round((-grid.size[2] / 2 + voxel / 2 - z0) / voxel)
  const i1 = i0 + Math.round(grid.size[0] / voxel)
  const j1 = j0 + Math.round(grid.size[1] / voxel)
  const k1 = k0 + Math.round(grid.size[2] / voxel)
  const clear = 2.5 * voxel
  let outside = 0
  let overcut = 0
  let overMax = 0
  for (let k = k0; k < k1; k += 2) {
    const dk = k + 1 < k1 ? 2 : 1
    for (let j = j0; j < j1; j += 2) {
      const dj = j + 1 < j1 ? 2 : 1
      for (let i = i0; i < i1; i += 2) {
        const di = i + 1 < i1 ? 2 : 1
        let s = 0
        for (let c = 0; c < dk; c++) {
          for (let b = 0; b < dj; b++) {
            const p = i + nx * (j + b + ny * (k + c))
            s += OCC[dist[p]! + 128]!
            if (di === 2) s += OCC[dist[p + 1]! + 128]!
          }
        }
        const full = di * dj * dk * OCC_FULL
        const f = unionDistance(forms, x0 + (i + (di - 1) / 2) * voxel, y0 + (j + (dj - 1) / 2) * voxel, z0 + (k + (dk - 1) / 2) * voxel)
        const settled = s === 0 || s === full || f > clear || f < -clear
        if (settled) {
          const inside = f <= -voxel ? 1 : f >= voxel ? 0 : 0.5 - f / (2 * voxel)
          const diff = s - inside * full
          if (diff > 0) outside += diff
          else overcut -= diff
          // Worth a closer look only if some sample here could beat the deepest so far.
          if (s === full || -f <= overMax - 2 * voxel) continue
        }
        for (let c = 0; c < dk; c++) {
          for (let b = 0; b < dj; b++) {
            for (let a = 0; a < di; a++) {
              const q = dist[i + a + nx * (j + b + ny * (k + c))]!
              if (settled && q < 0) continue
              const fs = unionDistance(forms, x0 + (i + a) * voxel, y0 + (j + b) * voxel, z0 + (k + c) * voxel)
              if (q >= 0 && -fs > overMax) overMax = -fs
              if (settled) continue
              const inside = fs <= -voxel / 2 ? 1 : fs >= voxel / 2 ? 0 : 0.5 - fs / voxel
              const diff = OCC[q + 128]! - inside * OCC_FULL
              if (diff > 0) outside += diff
              else overcut -= diff
            }
          }
        }
      }
    }
  }
  return {
    proudMaxCm: proudMax,
    proudMeanCm: count === 0 ? 0 : sum / count,
    outsideCm3: unitsToCm3(grid, outside),
    overcutMaxCm: overMax,
    overcutCm3: unitsToCm3(grid, overcut),
    nearShare: count === 0 ? 0 : near / count
  }
}

export interface SurfaceFinish {
  // Shares of the carvable surface (not the base), 0 to 1, by the finish its last tool left.
  // rough: point, drill and claw work. tooled: sawn faces, the flat chisel, the roundel.
  // rasped: the rasp, and polish that has only begun. polished: POLISHED_FROM and above.
  rough: number
  tooled: number
  rasped: number
  polished: number
  // Mean finish over the same surface, 0 to 255.
  mean: number
}

export const ROUGH_BELOW = 80
export const RASPED_FROM = 150
export const POLISHED_FROM = 230

// How the surface is finished. A look renders every finish as the same matte clay, so this
// is the only way the sculptor can tell rasped stone from raw, or see that a polish took.
export function surfaceFinish(grid: Grid): SurfaceFinish {
  const { nx, ny, nz, dist, finish } = grid
  const sy = nx
  const sz = nx * ny
  let rough = 0
  let tooled = 0
  let rasped = 0
  let polished = 0
  let sum = 0
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      let p = 1 + nx * (j + ny * k)
      for (let i = 1; i < nx - 1; i++, p++) {
        const q = dist[p]!
        if (q >= 0 || q < -64) continue
        if (!(dist[p - 1]! >= 0 || dist[p + 1]! >= 0 || dist[p + sy]! >= 0 || dist[p - sz]! >= 0
          || dist[p + sz]! >= 0 || (j !== grid.baseY && dist[p - sy]! >= 0))) continue
        const f = finish[p]!
        sum += f
        if (f < ROUGH_BELOW) rough++
        else if (f < RASPED_FROM) tooled++
        else if (f < POLISHED_FROM) rasped++
        else polished++
      }
    }
  }
  const count = rough + tooled + rasped + polished
  if (count === 0) return { rough: 0, tooled: 0, rasped: 0, polished: 0, mean: 0 }
  return { rough: rough / count, tooled: tooled / count, rasped: rasped / count, polished: polished / count, mean: sum / count }
}

export type SliceAxis = 'x' | 'y' | 'z'

// The axis view a cross-section is drawn as, so its rulers run the same way as that view's:
// a level slice as `top` (X across, Z down the image, the front at the bottom), a slice
// facing the viewer as `front` (X across, Y up), a slice through the piece from front to back
// as `left` (Z across with the front on the right, Y up).
export const SLICE_VIEW: Record<SliceAxis, AxisView> = { x: 'left', y: 'top', z: 'front' }

export interface SliceOptions {
  // Names of declared forms to compare the section with, as one union. Default: all of them.
  forms?: string[]
  // The reference's front and left outlines. The volume inside both, pushed through the
  // block, is what the section is compared with.
  outlines?: { front: Mask, left: Mask }
}

// Numbers for the stone's cross-section in the plane <axis> = at (block cm): its area, its
// extent along the two rulers of SLICE_VIEW[axis], and how it sits against the declared forms
// and the reference in that same plane. Sampled every half voxel.
export function measureSlice(grid: Grid, axis: SliceAxis, at: number, opts: SliceOptions = {}): Record<string, number> {
  const def = VIEWS[SLICE_VIEW[axis]]
  const h = def.h!
  const v = def.v!
  const a = 3 - h - v
  const step = grid.voxel / 2
  const lo = [-grid.size[0] / 2, 0, -grid.size[2] / 2]
  const forms: CompiledForm[] = []
  for (const name of opts.forms ?? grid.forms.keys()) {
    const form = grid.forms.get(name)
    if (form) forms.push(form)
  }
  const nh = Math.round(grid.size[h] / step)
  const nv = Math.round(grid.size[v] / step)
  const p = [0, 0, 0]
  p[a] = at
  let stone = 0
  let hMin = Infinity
  let hMax = -Infinity
  let vMin = Infinity
  let vMax = -Infinity
  let formArea = 0
  let outside = 0
  let missing = 0
  let proud = 0
  let refArea = 0
  let outsideRef = 0
  for (let iv = 0; iv < nv; iv++) {
    p[v] = lo[v]! + (iv + 0.5) * step
    for (let ih = 0; ih < nh; ih++) {
      p[h] = lo[h]! + (ih + 0.5) * step
      const d = sampleDistance(grid, p[0]!, p[1]!, p[2]!)
      const solid = d < 0
      if (solid) {
        stone++
        // The surface is as far beyond an edge sample as that sample is deep.
        const edge = Math.min(step, -d)
        if (p[h]! - edge < hMin) hMin = p[h]! - edge
        if (p[h]! + edge > hMax) hMax = p[h]! + edge
        if (p[v]! - edge < vMin) vMin = p[v]! - edge
        if (p[v]! + edge > vMax) vMax = p[v]! + edge
      }
      if (forms.length > 0) {
        const f = unionDistance(forms, p[0]!, p[1]!, p[2]!)
        if (f < 0) {
          formArea++
          if (!solid) missing++
        } else if (solid) {
          outside++
          if (f > proud) proud = f
        }
      }
      if (opts.outlines) {
        const inside = maskCovers(opts.outlines.front, grid, 'front', p[0]!, p[1]!, p[2]!)
          && maskCovers(opts.outlines.left, grid, 'left', p[0]!, p[1]!, p[2]!)
        if (inside) refArea++
        else if (solid) outsideRef++
      }
    }
  }
  const cell = step * step
  const H = 'xyz'[h]!
  const V = 'xyz'[v]!
  const out: Record<string, number> = { section_area_cm2: round(stone * cell, 1) }
  if (stone > 0) {
    out[`section_${H}_min_cm`] = round(hMin, 1)
    out[`section_${H}_max_cm`] = round(hMax, 1)
    out[`section_${V}_min_cm`] = round(vMin, 1)
    out[`section_${V}_max_cm`] = round(vMax, 1)
  }
  if (forms.length > 0) {
    out.section_form_area_cm2 = round(formArea * cell, 1)
    out.section_stone_outside_form_cm2 = round(outside * cell, 1)
    out.section_proud_max_cm = round(proud, 1)
    out.section_form_without_stone_cm2 = round(missing * cell, 1)
  }
  if (opts.outlines) {
    out.section_reference_area_cm2 = round(refArea * cell, 1)
    out.section_stone_outside_reference_cm2 = round(outsideRef * cell, 1)
  }
  return out
}

export interface MeasureOptions {
  // Names of declared forms to measure against, as one union. Default: every form declared
  // on the grid. Names that are not declared are skipped.
  forms?: string[]
  // Reference outlines by view, in the mask ↔ block mapping at the top of this file.
  outlines?: Partial<Record<SideView, Mask>>
}

function round(value: number, digits: number): number {
  const k = 10 ** digits
  // Adding zero turns -0 into 0, which would otherwise print as "-0".
  return Math.round(value * k) / k + 0
}

const SIDES: SideView[] = ['front', 'left', 'back', 'right']

// Everything a look reports, flat, for a tool result. Form keys appear only when a form is
// declared, silhouette keys only for the views an outline was given for.
export function measureAll(grid: Grid, opts: MeasureOptions = {}): Record<string, number> {
  const out: Record<string, number> = {}
  const volume = stoneVolumeCm3(grid)
  const block = grid.size[0] * grid.size[1] * grid.size[2]
  out.mass_kg = round(stoneMassKg(grid), 1)
  out.volume_cm3 = Math.round(volume)
  out.removed_pct = round(100 * (1 - volume / block), 1)

  const box = stoneBounds(grid)
  out.bbox_x_min_cm = round(box.min[0], 1)
  out.bbox_x_max_cm = round(box.max[0], 1)
  out.bbox_y_min_cm = round(box.min[1], 1)
  out.bbox_y_max_cm = round(box.max[1], 1)
  out.bbox_z_min_cm = round(box.min[2], 1)
  out.bbox_z_max_cm = round(box.max[2], 1)

  const skin = surfaceFinish(grid)
  out.surface_rough_pct = round(100 * skin.rough, 1)
  out.surface_rasped_pct = round(100 * skin.rasped, 1)
  out.surface_polished_pct = round(100 * skin.polished, 1)

  const forms: CompiledForm[] = []
  for (const name of opts.forms ?? grid.forms.keys()) {
    const form = grid.forms.get(name)
    if (form) forms.push(form)
  }
  if (forms.length > 0) {
    const fit = proudOfForm(grid, forms)
    out.form_proud_max_cm = round(fit.proudMaxCm, 1)
    out.form_proud_mean_cm = round(fit.proudMeanCm, 2)
    out.form_stone_outside_cm3 = Math.round(fit.outsideCm3)
    out.form_overcut_max_cm = round(fit.overcutMaxCm, 1)
    out.form_overcut_cm3 = Math.round(fit.overcutCm3)
    out[`form_surface_within_${NEAR_FORM_CM}cm_pct`] = round(100 * fit.nearShare, 1)
  }

  for (const view of SIDES) {
    const outline = opts.outlines?.[view]
    if (!outline) continue
    const fit = silhouetteAgreement(grid, view, outline)
    out[`silhouette_${view}_iou`] = round(fit.iou, 3)
    out[`silhouette_${view}_stone_outside_outline_pct`] = round(100 * fit.stoneOutside, 1)
    out[`silhouette_${view}_outline_not_covered_pct`] = round(100 * fit.outlineOutside, 1)
  }
  return out
}
