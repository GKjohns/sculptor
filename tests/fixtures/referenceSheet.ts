/**
 * Procedural reference sheets for tests/reference.test.ts: a small "bust" (head with a nose,
 * neck, shoulders, plinth) drawn the way the image model is asked to draw one, plus the exact
 * silhouettes it was drawn from. Not a test file itself.
 *
 * `node tests/fixtures/referenceSheet.ts` rewrites reference_bust.png.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { encodePng } from '../../bench/png.ts'
import { REFERENCE_BLOCK, REFERENCE_QUADRANTS, REF_VIEWS } from '../../shared/agent/reference.ts'
import type { BlockSize, Mask, RefView, Rgba } from '../../shared/agent/reference.ts'

type V3 = [number, number, number]
// c = centre, r = half-sizes, in the block's axes: +Y up, +Z the figure's front, +X to the
// right of someone facing it. Units are arbitrary; the sheet and the block both rescale.
export interface Prim { kind: 'ellipsoid' | 'box', c: V3, r: V3 }

export const BUST: Prim[] = [
  { kind: 'box', c: [0, 4, 0], r: [16, 4, 13] },
  { kind: 'ellipsoid', c: [0, 22, 0], r: [22, 16, 12] },
  { kind: 'ellipsoid', c: [0, 42, -1], r: [6.5, 9, 6.5] },
  { kind: 'ellipsoid', c: [0, 58, 0], r: [10, 13, 11.5] },
  { kind: 'ellipsoid', c: [0, 57, 11.5], r: [1.8, 3, 3] }
]

// For each view: which block axis runs across the image and which way, and which way the
// camera sits along the depth axis. Matches shared/sculpt/views.ts.
const VIEW: Record<RefView, { h: 0 | 2, hs: 1 | -1, d: 0 | 2, ds: 1 | -1 }> = {
  front: { h: 0, hs: 1, d: 2, ds: 1 },
  back: { h: 0, hs: -1, d: 2, ds: -1 },
  left: { h: 2, hs: 1, d: 0, ds: -1 },
  right: { h: 2, hs: -1, d: 0, ds: 1 }
}

const LIGHT: V3 = [-0.36, 0.46, 0.81]

// Brightness 0–1 of the surface nearest the camera at image point (u, y), or -1 for background.
function shade(prims: Prim[], view: RefView, u: number, y: number): number {
  const v = VIEW[view]
  let best = -Infinity
  let lit = -1
  for (const p of prims) {
    const a = (u - v.hs * p.c[v.h]) / p.r[v.h]
    const b = (y - p.c[1]) / p.r[1]
    let depth: number
    let n: V3
    if (p.kind === 'box') {
      if (Math.abs(a) > 1 || Math.abs(b) > 1) continue
      depth = v.ds * p.c[v.d] + p.r[v.d]
      n = [0, 0, 1]
    } else {
      const k = 1 - a * a - b * b
      if (k < 0) continue
      const c = Math.sqrt(k)
      depth = v.ds * p.c[v.d] + p.r[v.d] * c
      const nx = a / p.r[v.h]
      const ny = b / p.r[1]
      const nz = c / p.r[v.d]
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
      n = [nx / len, ny / len, nz / len]
    }
    if (depth > best) {
      best = depth
      lit = 0.55 + 0.45 * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2])
    }
  }
  return lit
}

// The figure's extent in a view's image: u across, y up.
function extent(prims: Prim[], view: RefView) {
  const v = VIEW[view]
  let u0 = Infinity
  let u1 = -Infinity
  let y1 = -Infinity
  for (const p of prims) {
    u0 = Math.min(u0, v.hs * p.c[v.h] - p.r[v.h])
    u1 = Math.max(u1, v.hs * p.c[v.h] + p.r[v.h])
    y1 = Math.max(y1, p.c[1] + p.r[1])
  }
  return { u0, u1, height: y1 }
}

function mulberry(seed: number) {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface SheetOptions {
  size?: number // sheet edge in px
  fill?: number // figure height as a share of the quadrant
  background?: number // grey level of the backdrop
  clay?: number // grey level of fully lit clay
  noise?: number // ± grey levels per pixel
  seed?: number
  skip?: RefView[] // quadrants left empty
  shift?: Partial<Record<RefView, [number, number]>> // px the figure is moved, right and down
  prims?: Prim[]
}

// Grey clay on a nearly black backdrop with a slight gradient and tint, 3 × 3 anti-aliased,
// with per-pixel noise and blocky 8 × 8 noise standing in for JPEG artefacts.
export function renderSheet(opts: SheetOptions = {}): Rgba {
  const { size = 512, fill = 0.8, background = 10, clay = 180, noise = 4, seed = 7, skip = [], shift = {}, prims = BUST } = opts
  const tile = size / 2
  const data = new Uint8Array(size * size * 4)
  const rand = mulberry(seed)
  const pxPerUnit = fill * tile / extent(prims, 'front').height
  for (const view of REF_VIEWS) {
    const q = REFERENCE_QUADRANTS[view]
    const ext = extent(prims, view)
    const [sx, sy] = shift[view] ?? [0, 0]
    const centre = tile / 2 + sx
    const base = tile - (1 - fill) * tile / 2 + sy
    const blocks = new Float32Array(Math.ceil(tile / 8) ** 2)
    for (let i = 0; i < blocks.length; i++) blocks[i] = (rand() - 0.5) * noise
    for (let j = 0; j < tile; j++) {
      for (let i = 0; i < tile; i++) {
        let cover = 0
        let light = 0
        if (!skip.includes(view)) {
          for (let b = 0; b < 3; b++) {
            for (let a = 0; a < 3; a++) {
              const u = (i + (a + 0.5) / 3 - centre) / pxPerUnit + (ext.u0 + ext.u1) / 2
              const y = (base - (j + (b + 0.5) / 3)) / pxPerUnit
              const s = shade(prims, view, u, y)
              if (s >= 0) {
                cover++
                light += s
              }
            }
          }
        }
        const back = background + 8 * (i + tile - j) / (2 * tile)
        const fore = cover ? clay * light / cover : 0
        const grain = (rand() * 2 - 1) * noise + blocks[(j >> 3) * Math.ceil(tile / 8) + (i >> 3)]!
        const grey = back + (fore - back) * cover / 9 + grain
        const at = ((q.row * tile + j) * size + q.col * tile + i) * 4
        data[at] = Math.max(0, Math.min(255, Math.round(grey)))
        data[at + 1] = data[at]!
        data[at + 2] = Math.max(0, Math.min(255, Math.round(grey + (cover ? 0 : 3))))
        data[at + 3] = 255
      }
    }
  }
  return { width: size, height: size, data }
}

interface TruthOptions { block?: BlockSize, cellCm?: number, insetCm?: number, prims?: Prim[] }

const face = (view: RefView, block: BlockSize) => view === 'front' || view === 'back' ? block.width : block.depth

// Block cm per model unit: one factor so every view fits its face of the block inside the inset.
function truthScale(prims: Prim[], block: BlockSize, insetCm: number): number {
  let scale = Infinity
  for (const v of REF_VIEWS) {
    const e = extent(prims, v)
    scale = Math.min(scale, (face(v, block) - 2 * insetCm) / (e.u1 - e.u0), (block.height - insetCm) / e.height)
  }
  return scale
}

// What analyzeReference should make of a view, worked out from the shapes and not from any
// image: the figure at truthScale, standing on the base, its bounding box centred.
export function truthMask(view: RefView, opts: TruthOptions = {}): Mask {
  const { block = REFERENCE_BLOCK, cellCm = 0.4, insetCm = 2, prims = BUST } = opts
  const scale = truthScale(prims, block, insetCm)
  const ext = extent(prims, view)
  const width = Math.round(face(view, block) / cellCm)
  const height = Math.round(block.height / cellCm)
  const data = new Uint8Array(width * height)
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const u = ((col + 0.5) * cellCm - face(view, block) / 2) / scale + (ext.u0 + ext.u1) / 2
      const y = (block.height - (row + 0.5) * cellCm) / scale
      if (shade(prims, view, u, y) >= 0) data[row * width + col] = 1
    }
  }
  return { width, height, data }
}

// The figure's height in block cm under the same fit.
export function truthHeightCm(opts: TruthOptions = {}): number {
  const { block = REFERENCE_BLOCK, insetCm = 2, prims = BUST } = opts
  return extent(prims, 'front').height * truthScale(prims, block, insetCm)
}

export const BUST_PNG = fileURLToPath(new URL('./reference_bust.png', import.meta.url))

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sheet = renderSheet()
  writeFileSync(BUST_PNG, encodePng(sheet.data, sheet.width, sheet.height))
  console.log(`wrote ${BUST_PNG}`)
}
