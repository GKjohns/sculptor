import { Q_MAX } from './grid.ts'
import { SLICE_VIEW, blockToMask, maskCovers } from './measure.ts'
import type { Mask, SideView, SliceAxis } from './measure.ts'
import { sampleDistance } from './raycast.ts'
import { formDistance } from './shapes.ts'
import { VIEWS, isAxisView } from './views.ts'
import type { AxisView, ViewId } from './views.ts'
import type { CompiledForm, Grid, GridInfo, Vec3 } from './types.ts'

// The sculptor's eye: a software renderer over the grid. It returns RGBA and nothing else;
// PNG encoding lives at the edges. What a look shows is neutral matte clay under a raking
// key light from the upper left of every tile, whatever the stone's finish, because the
// model is judging shape. Axis views carry rulers in block centimetres, so a coordinate
// read off a tile can be handed straight to a carving tool.

export interface Image { width: number, height: number, data: Uint8Array }
export interface ImageLike { width: number, height: number, data: Uint8Array | Uint8ClampedArray }

// grid       clay, rulers and a centimetre grid.
// form       the same, plus the declared form: its outline, stone that stands proud of it
//            tinted yellow to red by how far, and stone missing from it in violet.
// reference  each side view sits beside its reference-sheet quadrant, with the reference
//            outline drawn over the stone the same way.
export type Overlay = 'grid' | 'form' | 'reference'

export interface ReferenceInput {
  // Reference-sheet quadrants by view, drawn beside the matching stone tile. A tile whose
  // aspect ratio matches the block face (within 3%) is taken to be block-aligned, i.e. in
  // the mask ↔ block mapping of measure.ts, and gets the same rulers as the stone and the
  // stone's outline over it. Any other tile is fitted into the face and shown plain.
  tiles?: Partial<Record<SideView, ImageLike>>
  // Reference outlines by view, as masks in the mapping documented in measure.ts.
  outlines?: Partial<Record<SideView, Mask>>
}

// Charcoal lines to draw on the stone: a `sketch` log entry fits. Each stroke is a run of
// points on the surface as it stood when the line was drawn, block cm.
export interface SketchMarks { view: ViewId, strokes: Vec3[][] }

export interface LookOptions {
  overlay?: Overlay
  // Scale of every tile, the same in all of them. 5 gives a six-view sheet of about
  // 1200 px, which is roughly what one look should cost in image tokens.
  pxPerCm?: number
  // Contact sheets only: the scale is lowered until the long side fits. Default 1568.
  maxSide?: number
  // Names of declared forms to draw, as one union. Default: every form on the grid.
  forms?: string[]
  reference?: ReferenceInput
  // Drawn in every view where the stone they were drawn on is still the surface in sight.
  // In the view a line was drawn from, the stretches whose stone has since been cut away
  // stay on as a faint ghost, so a profile outlives the face it was drawn on.
  sketches?: SketchMarks[]
}

export interface TileLayout {
  view: ViewId
  kind: 'stone' | 'reference'
  // The tile and its rendered area, in sheet pixels.
  x: number
  y: number
  width: number
  height: number
  plot: { x: number, y: number, width: number, height: number }
  pxPerCm: number
  // Axis views (and block-aligned reference tiles) only. A ruler value sits at sheet pixel
  // h0 + h * hPerCm across and v0 + v * vPerCm down; the per-cm factors are signed, so
  // hPerCm is negative where the ruler increases to the left.
  ruler?: { hAxis: 'X' | 'Z', vAxis: 'Y' | 'Z', h0: number, hPerCm: number, v0: number, vPerCm: number }
  // Close-ups only: the world point at the centre of the plot. Elsewhere it is the middle
  // of the block.
  origin?: Vec3
}

export interface SheetLayout {
  width: number
  height: number
  pxPerCm: number
  tiles: TileLayout[]
}

// ---------- palette ----------

type RGB = readonly [number, number, number]

const BG: RGB = [15, 17, 21]
const BG_PLOT: RGB = [33, 37, 44]
const CLAY: RGB = [216, 212, 205]
const TEXT: RGB = [236, 239, 244]
const AXIS: Record<string, RGB> = { X: [255, 150, 140], Y: [150, 232, 150], Z: [140, 190, 255] }
const OUTLINE: RGB = [0, 232, 255]
const STONE_LINE: RGB = [255, 226, 60]
const PROUD_NEAR: RGB = [250, 214, 70]
const PROUD_MID: RGB = [246, 138, 34]
const PROUD_FAR: RGB = [214, 44, 44]
const CUT_NEAR: RGB = [96, 122, 255]
const CUT_DEEP: RGB = [176, 72, 255]
const LOST: RGB = [70, 58, 150]
const CHARCOAL: RGB = [44, 42, 46]
const GHOST: RGB = [110, 118, 140]
const SECTION: RGB = [188, 184, 178]
const SECTION_EDGE: RGB = [92, 88, 84]
const HULL: RGB = [255, 120, 220]

// Within a voxel of the form counts as on it.
const ON_FORM_CM = 0.4
const PROUD_MID_CM = 4
const PROUD_FAR_CM = 12

const PAD_CM = 2
const GAP = 6

// ---------- a tiny bitmap font ----------

const GLYPHS: Record<string, string> = {
  '0': '01110 10001 10001 10001 10001 10001 01110',
  '1': '00100 01100 00100 00100 00100 00100 01110',
  '2': '01110 10001 00001 00010 00100 01000 11111',
  '3': '11110 00001 00001 01110 00001 00001 11110',
  '4': '00010 00110 01010 10010 11111 00010 00010',
  '5': '11111 10000 11110 00001 00001 10001 01110',
  '6': '00110 01000 10000 11110 10001 10001 01110',
  '7': '11111 00001 00010 00100 01000 01000 01000',
  '8': '01110 10001 10001 01110 10001 10001 01110',
  '9': '01110 10001 10001 01111 00001 00010 01100',
  'A': '01110 10001 10001 11111 10001 10001 10001',
  'B': '11110 10001 10001 11110 10001 10001 11110',
  'C': '01110 10001 10000 10000 10000 10001 01110',
  'D': '11100 10010 10001 10001 10001 10010 11100',
  'E': '11111 10000 10000 11110 10000 10000 11111',
  'F': '11111 10000 10000 11110 10000 10000 10000',
  'G': '01110 10001 10000 10111 10001 10001 01111',
  'H': '10001 10001 10001 11111 10001 10001 10001',
  'I': '01110 00100 00100 00100 00100 00100 01110',
  'J': '00111 00010 00010 00010 00010 10010 01100',
  'K': '10001 10010 10100 11000 10100 10010 10001',
  'L': '10000 10000 10000 10000 10000 10000 11111',
  'M': '10001 11011 10101 10101 10001 10001 10001',
  'N': '10001 10001 11001 10101 10011 10001 10001',
  'O': '01110 10001 10001 10001 10001 10001 01110',
  'P': '11110 10001 10001 11110 10000 10000 10000',
  'Q': '01110 10001 10001 10001 10101 10010 01101',
  'R': '11110 10001 10001 11110 10100 10010 10001',
  'S': '01111 10000 10000 01110 00001 00001 11110',
  'T': '11111 00100 00100 00100 00100 00100 00100',
  'U': '10001 10001 10001 10001 10001 10001 01110',
  'V': '10001 10001 10001 10001 10001 01010 00100',
  'W': '10001 10001 10001 10101 10101 10101 01010',
  'X': '10001 10001 01010 00100 01010 10001 10001',
  'Y': '10001 10001 01010 00100 00100 00100 00100',
  'Z': '11111 00001 00010 00100 01000 10000 11111',
  '-': '00000 00000 00000 11111 00000 00000 00000',
  '+': '00000 00100 00100 11111 00100 00100 00000',
  '=': '00000 00000 11111 00000 11111 00000 00000',
  '_': '00000 00000 00000 00000 00000 00000 11111',
  '.': '00000 00000 00000 00000 00000 01100 01100',
  ',': '00000 00000 00000 00000 01100 00100 01000',
  ':': '00000 01100 01100 00000 01100 01100 00000',
  '/': '00001 00010 00010 00100 01000 01000 10000',
  '(': '00010 00100 01000 01000 01000 00100 00010',
  ')': '01000 00100 00010 00010 00010 00100 01000',
  '?': '01110 10001 00001 00010 00100 00000 00100'
}

const FONT = new Map<string, number[]>()
for (const [char, rows] of Object.entries(GLYPHS)) {
  FONT.set(char, rows.split(' ').map(row => parseInt(row, 2)))
}

function textWidth(text: string, scale: number): number {
  return text.length === 0 ? 0 : (text.length * 6 - 1) * scale
}

function drawText(img: Image, x: number, y: number, text: string, scale: number, colour: RGB): void {
  for (let n = 0; n < text.length; n++) {
    const char = text[n]!
    if (char === ' ') continue
    const rows = FONT.get(char) ?? FONT.get('?')!
    for (let r = 0; r < 7; r++) {
      const bits = rows[r]!
      for (let c = 0; c < 5; c++) {
        if (bits & (16 >> c)) fill(img, x + (n * 6 + c) * scale, y + r * scale, scale, scale, colour)
      }
    }
  }
}

// ---------- pixels ----------

function blank(width: number, height: number, colour: RGB): Image {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = colour[0]
    data[i + 1] = colour[1]
    data[i + 2] = colour[2]
    data[i + 3] = 255
  }
  return { width, height, data }
}

function fill(img: Image, x: number, y: number, w: number, h: number, colour: RGB): void {
  const ax = Math.max(0, x)
  const ay = Math.max(0, y)
  const bx = Math.min(img.width, x + w)
  const by = Math.min(img.height, y + h)
  for (let py = ay; py < by; py++) {
    let i = (ax + py * img.width) * 4
    for (let px = ax; px < bx; px++, i += 4) {
      img.data[i] = colour[0]
      img.data[i + 1] = colour[1]
      img.data[i + 2] = colour[2]
    }
  }
}

// A grid-line pixel: a dark line over stone, a light one over the background, so one grid
// reads over both. Where no stone flag is given the pixel's own brightness decides.
function etch(img: Image, x: number, y: number, alpha: number, stone: number | undefined): void {
  const i = (x + y * img.width) * 4
  const d = img.data
  const dark = stone === undefined ? d[i]! * 2 + d[i + 1]! * 5 + d[i + 2]! > 8 * 112 : stone === 1
  const target = dark ? 0 : 255
  d[i] = d[i]! + (target - d[i]!) * alpha
  d[i + 1] = d[i + 1]! + (target - d[i + 1]!) * alpha
  d[i + 2] = d[i + 2]! + (target - d[i + 2]!) * alpha
}

// Draws the edge of a region given as one flag per plot pixel: two pixels wide, one either
// side of the boundary.
function outline(img: Image, rect: { x: number, y: number, width: number, height: number }, inside: Uint8Array, colour: RGB): void {
  const { width: w, height: h } = rect
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = x + y * w
      const v = inside[i]!
      if ((x > 0 && inside[i - 1] !== v) || (x < w - 1 && inside[i + 1] !== v)
        || (y > 0 && inside[i - w] !== v) || (y < h - 1 && inside[i + w] !== v)) {
        const o = (rect.x + x + (rect.y + y) * img.width) * 4
        img.data[o] = colour[0]
        img.data[o + 1] = colour[1]
        img.data[o + 2] = colour[2]
      }
    }
  }
}

// Scales an image into a rectangle, averaging the source under each pixel when shrinking.
function drawImage(img: Image, src: ImageLike, dx: number, dy: number, dw: number, dh: number, ground: RGB): void {
  const kx = src.width / dw
  const ky = src.height / dh
  const nx = Math.max(1, Math.round(kx))
  const ny = Math.max(1, Math.round(ky))
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let j = 0; j < ny; j++) {
        const sy = Math.min(src.height - 1, Math.floor((y + (j + 0.5) / ny) * ky))
        for (let i = 0; i < nx; i++) {
          const sx = Math.min(src.width - 1, Math.floor((x + (i + 0.5) / nx) * kx))
          const s = (sx + sy * src.width) * 4
          const a = src.data[s + 3]! / 255
          r += src.data[s]! * a + ground[0] * (1 - a)
          g += src.data[s + 1]! * a + ground[1] * (1 - a)
          b += src.data[s + 2]! * a + ground[2] * (1 - a)
        }
      }
      const o = (dx + x + (dy + y) * img.width) * 4
      const n = nx * ny
      img.data[o] = r / n
      img.data[o + 1] = g / n
      img.data[o + 2] = b / n
    }
  }
}

// ---------- layout ----------

function fontScale(pxPerCm: number): number {
  return pxPerCm >= 4 ? 2 : 1
}

// Extent of the block as a view sees it, cm, with a little air around it.
function extent(grid: GridInfo, view: ViewId): { w: number, h: number } {
  const { right, up } = VIEWS[view]
  const s = grid.size
  return {
    w: Math.abs(right[0]) * s[0] + Math.abs(right[1]) * s[1] + Math.abs(right[2]) * s[2] + 2 * PAD_CM,
    h: Math.abs(up[0]) * s[0] + Math.abs(up[1]) * s[1] + Math.abs(up[2]) * s[2] + 2 * PAD_CM
  }
}

function makeTile(grid: GridInfo, view: ViewId, kind: 'stone' | 'reference', pxPerCm: number, rulers: boolean): TileLayout {
  const f = fontScale(pxPerCm)
  const strip = 7 * f + 8
  const left = rulers ? 18 * f + 8 : 8
  const bottom = rulers ? strip : 8
  const e = extent(grid, view)
  const pw = Math.round(e.w * pxPerCm)
  const ph = Math.round(e.h * pxPerCm)
  const tile: TileLayout = {
    view,
    kind,
    x: 0,
    y: 0,
    width: left + pw + 10,
    height: strip + ph + bottom,
    plot: { x: left, y: strip, width: pw, height: ph },
    pxPerCm
  }
  if (rulers) {
    const def = VIEWS[view]
    const h = def.h!
    const v = def.v!
    const hPerCm = def.right[h] * pxPerCm
    const vPerCm = -def.up[v] * pxPerCm
    const cv = v === 1 ? grid.size[1] / 2 : 0
    tile.ruler = {
      hAxis: h === 0 ? 'X' : 'Z',
      vAxis: v === 1 ? 'Y' : 'Z',
      h0: left + pw / 2,
      hPerCm,
      v0: strip + ph / 2 - cv * vPerCm,
      vPerCm
    }
  }
  return tile
}

function isSide(view: ViewId): view is SideView {
  return view === 'front' || view === 'back' || view === 'left' || view === 'right'
}

function fitsFace(grid: GridInfo, view: SideView, tile: ImageLike): boolean {
  const def = VIEWS[view]
  const want = grid.size[def.h!] / grid.size[def.v!]
  return Math.abs(tile.width / tile.height / want - 1) < 0.03
}

type Token = { text: string } | { swatch: RGB }

const words = (text: string): Token[] => text.split(' ').map(word => ({ text: word }))

// Centimetres between grid lines, and between the ones that carry a number.
function gridStep(pxPerCm: number): number {
  return pxPerCm >= 12 ? 1 : 5 * pxPerCm >= 8 ? 5 : 10
}

function labelStep(pxPerCm: number): number {
  const room = 4 * 6 * fontScale(pxPerCm)
  for (const step of [1, 2, 5, 10]) if (step * pxPerCm >= room) return step
  return 20
}

function legendTokens(overlay: Overlay, targets: boolean, pxPerCm: number, sketched = false): Token[] {
  const out = words(`RULERS: BLOCK CM. GRID EVERY ${gridStep(pxPerCm)} CM.`)
  if (sketched) out.push({ swatch: CHARCOAL }, { swatch: GHOST }, ...words('YOUR CHARCOAL LINES / WHERE THEIR STONE IS GONE.'))
  if (overlay === 'form') {
    if (!targets) return [...out, ...words('NO FORM DECLARED.')]
    out.push({ swatch: PROUD_NEAR }, { swatch: PROUD_MID }, { swatch: PROUD_FAR },
      ...words(`STONE PROUD OF FORM BY 1 / ${PROUD_MID_CM} / ${PROUD_FAR_CM}+ CM: REMOVE.`),
      { swatch: CUT_NEAR }, { swatch: LOST }, ...words('FORM WITH NO STONE: CUT TOO DEEP.'),
      { swatch: OUTLINE }, ...words('FORM OUTLINE.'))
  } else if (overlay === 'reference') {
    if (!targets) return [...out, ...words('NO REFERENCE OUTLINES.')]
    out.push({ swatch: PROUD_MID }, ...words('STONE OUTSIDE REFERENCE OUTLINE: REMOVE.'),
      { swatch: LOST }, ...words('OUTLINE WITH NO STONE.'),
      { swatch: OUTLINE }, ...words('REFERENCE OUTLINE.'),
      { swatch: STONE_LINE }, ...words('STONE OUTLINE ON REFERENCE.'))
  }
  return out
}

interface Placed { token: Token, x: number, y: number }

function flowLegend(tokens: Token[], f: number, width: number): { placed: Placed[], height: number } {
  const line = 7 * f + 6
  const placed: Placed[] = []
  let x = 0
  let y = 0
  let after: Token | null = null
  for (const token of tokens) {
    const swatch = 'swatch' in token
    const w = swatch ? 9 * f : textWidth(token.text, f)
    // A new legend entry starts at a swatch that follows text: give it room.
    const gap = after === null ? 0 : swatch && 'text' in after ? 16 * f : swatch ? 2 * f : 6 * f
    if (x + gap + w > width && x > 0) {
      x = 0
      y += line
    } else {
      x += gap
    }
    placed.push({ token, x, y })
    x += w
    after = token
  }
  return { placed, height: y + line }
}

function targetsFor(grid: GridInfo & { forms?: Grid['forms'] }, views: ViewId[], opts: LookOptions): boolean {
  if (opts.overlay === 'form') return pickForms(grid.forms, opts.forms).length > 0
  if (opts.overlay === 'reference') return views.some(view => isSide(view) && opts.reference?.outlines?.[view])
  return false
}

function sketched(opts: LookOptions): boolean {
  return (opts.sketches?.length ?? 0) > 0
}

function pickForms(forms: Grid['forms'] | undefined, names: string[] | undefined): CompiledForm[] {
  const out: CompiledForm[] = []
  if (!forms) return out
  for (const name of names ?? forms.keys()) {
    const form = forms.get(name)
    if (form) out.push(form)
  }
  return out
}

function arrange(grid: GridInfo, views: ViewId[], opts: LookOptions, pxPerCm: number): SheetLayout & { legendY: number } {
  const units: TileLayout[][] = []
  for (const view of views) {
    const unit = [makeTile(grid, view, 'stone', pxPerCm, isAxisView(view))]
    if (opts.overlay === 'reference' && isSide(view)) {
      const ref = opts.reference?.tiles?.[view]
      if (ref) unit.push(makeTile(grid, view, 'reference', pxPerCm, fitsFace(grid, view, ref)))
    }
    units.push(unit)
  }

  // Rows of k views each: whichever k gives the shortest long side.
  const measure = (k: number): { w: number, h: number } => {
    let w = 0
    let h = 0
    for (let r = 0; r < units.length; r += k) {
      let rw = 0
      let rh = 0
      for (const unit of units.slice(r, r + k)) {
        for (const tile of unit) {
          rw += tile.width + GAP
          if (tile.height > rh) rh = tile.height
        }
      }
      if (rw > w) w = rw
      h += rh + GAP
    }
    return { w: w + GAP, h: h + GAP }
  }
  let per = 1
  let size = measure(1)
  for (let k = 2; k <= units.length; k++) {
    const m = measure(k)
    const a = Math.max(m.w, m.h)
    const b = Math.max(size.w, size.h)
    if (a < b || (a === b && m.w * m.h < size.w * size.h)) {
      per = k
      size = m
    }
  }

  const tiles: TileLayout[] = []
  let y = GAP
  for (let r = 0; r < units.length; r += per) {
    let x = GAP
    let rh = 0
    for (const unit of units.slice(r, r + per)) {
      for (const tile of unit) {
        tile.x = x
        tile.y = y
        tile.plot.x += x
        tile.plot.y += y
        if (tile.ruler) {
          tile.ruler.h0 += x
          tile.ruler.v0 += y
        }
        tiles.push(tile)
        x += tile.width + GAP
        if (tile.height > rh) rh = tile.height
      }
    }
    y += rh + GAP
  }
  const legend = flowLegend(legendTokens(opts.overlay ?? 'grid', targetsFor(grid, views, opts), pxPerCm, sketched(opts)), fontScale(pxPerCm), size.w - 2 * GAP)
  return { width: size.w, height: size.h + legend.height + GAP, pxPerCm, tiles, legendY: size.h }
}

function fitSheet(grid: GridInfo, views: ViewId[], opts: LookOptions): SheetLayout & { legendY: number } {
  if (views.length === 0) throw new Error('a look needs at least one view')
  const maxSide = opts.maxSide ?? 1568
  let pxPerCm = opts.pxPerCm ?? 5
  for (let pass = 0; ; pass++) {
    const layout = arrange(grid, views, opts, pxPerCm)
    const side = Math.max(layout.width, layout.height)
    if (side <= maxSide || pxPerCm <= 1 || pass === 24) return layout
    // Margins do not shrink with the scale, so this closes in over a few passes.
    pxPerCm = Math.max(1, Math.floor(pxPerCm * maxSide / side * 100) / 100 - 0.01)
  }
}

// Where every tile of a contact sheet lands, without rendering it. Pass the grid itself
// when the overlay is 'form', so the legend knows whether a form is declared.
export function layoutContactSheet(grid: GridInfo, views: ViewId[], opts: LookOptions = {}): SheetLayout {
  const { width, height, pxPerCm, tiles } = fitSheet(grid, views, opts)
  return { width, height, pxPerCm, tiles }
}

// A point given in an axis view's two ruler coordinates (cm) as sheet pixels. The pixel
// that holds it is the floor of each.
export function blockToPixel(tile: TileLayout, h: number, v: number): [number, number] {
  if (!tile.ruler) throw new Error(`${tile.view} has no rulers`)
  return [tile.ruler.h0 + h * tile.ruler.hPerCm, tile.ruler.v0 + v * tile.ruler.vPerCm]
}

export function pixelToBlock(tile: TileLayout, px: number, py: number): [number, number] {
  if (!tile.ruler) throw new Error(`${tile.view} has no rulers`)
  return [(px - tile.ruler.h0) / tile.ruler.hPerCm, (py - tile.ruler.v0) / tile.ruler.vPerCm]
}

// ---------- tracing ----------

interface Plot {
  w: number
  h: number
  hit: Uint8Array
  // Distance along the view direction, cm, from an arbitrary plane in front of the stone.
  depth: Float32Array
  // World position of the surface under each pixel.
  pos: Float32Array
  lum: Float32Array
}

const AMBIENT = 0.25
const KEY = 0.7
const FILL = 0.27
const EYE = 0.1

// Key, fill and eye directions in world space for a view. The key rakes in from the upper
// left of the image so relief casts shading; the fill keeps the far side out of the dark.
function lights(view: ViewId): Float64Array {
  const { right, up, look } = VIEWS[view]
  const out = new Float64Array(9)
  const dirs = [[-0.7, 0.6, 0.45], [0.62, -0.25, 0.74], [0, 0, 1]]
  for (let n = 0; n < 3; n++) {
    const [x, y, z] = dirs[n]!
    const len = Math.sqrt(x! * x! + y! * y! + z! * z!)
    for (let c = 0; c < 3; c++) out[n * 3 + c] = (right[c]! * x! + up[c]! * y! - look[c]! * z!) / len
  }
  return out
}

function shade(grid: Grid, x: number, y: number, z: number, l: Float64Array): number {
  const e = grid.voxel * 0.5
  let gx = sampleDistance(grid, x + e, y, z) - sampleDistance(grid, x - e, y, z)
  let gy = sampleDistance(grid, x, y + e, z) - sampleDistance(grid, x, y - e, z)
  let gz = sampleDistance(grid, x, y, z + e) - sampleDistance(grid, x, y, z - e)
  const len = Math.sqrt(gx * gx + gy * gy + gz * gz)
  if (len > 0) {
    gx /= len
    gy /= len
    gz /= len
  } else {
    gx = l[6]!
    gy = l[7]!
    gz = l[8]!
  }
  const key = gx * l[0]! + gy * l[1]! + gz * l[2]!
  const fill = gx * l[3]! + gy * l[4]! + gz * l[5]!
  const eye = gx * l[6]! + gy * l[7]! + gz * l[8]!
  return AMBIENT + (key > 0 ? KEY * key : 0) + (fill > 0 ? FILL * fill : 0) + (eye > 0 ? EYE * eye : 0)
}

const MISS = 32767

// For every column of samples along an axis, how many samples in from the camera's side
// the first stone sample is. Indexed like measure.ts's columnMin.
function firstStone(grid: Grid, axis: number, fromHigh: boolean): Int16Array {
  const { nx, ny, nz, dist } = grid
  if (axis === 2) {
    const layer = nx * ny
    const out = new Int16Array(layer).fill(MISS)
    for (let c = 0; c < nz; c++) {
      let p = layer * (fromHigh ? nz - 1 - c : c)
      for (let m = 0; m < layer; m++, p++) if (dist[p]! < 0 && out[m] === MISS) out[m] = c
    }
    return out
  }
  if (axis === 1) {
    const out = new Int16Array(nx * nz).fill(MISS)
    for (let c = 0; c < ny; c++) {
      const j = fromHigh ? ny - 1 - c : c
      for (let k = 0; k < nz; k++) {
        let p = nx * (j + ny * k)
        for (let m = nx * k, end = m + nx; m < end; m++, p++) if (dist[p]! < 0 && out[m] === MISS) out[m] = c
      }
    }
    return out
  }
  const out = new Int16Array(nz * ny).fill(MISS)
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const row = nx * (j + ny * k)
      for (let c = 0; c < nx; c++) {
        if (dist[row + (fromHigh ? nx - 1 - c : c)]! < 0) {
          out[k + nz * j] = c
          break
        }
      }
    }
  }
  return out
}

function newPlot(w: number, h: number): Plot {
  return { w, h, hit: new Uint8Array(w * h), depth: new Float32Array(w * h), pos: new Float32Array(w * h * 3), lum: new Float32Array(w * h) }
}

// Axis views: the first-stone table says where each column of samples meets stone, and a
// pixel only has to walk the last sample or two between its four nearest columns.
function traceAxis(grid: Grid, view: ViewId, w: number, h: number, pxPerCm: number, origin?: Vec3): Plot {
  const def = VIEWS[view]
  const hA = def.h!
  const vA = def.v!
  const a = 3 - hA - vA
  const fromHigh = def.look[a]! < 0
  const n = [grid.nx, grid.ny, grid.nz]
  const stride = [1, grid.nx, grid.nx * grid.ny]
  const o = [grid.x0, grid.y0, grid.z0]
  const { dist, voxel } = grid
  const first = firstStone(grid, a, fromHigh)
  const nh = n[hA]!
  const nv = n[vA]!
  const na = n[a]!
  const sh = stride[hA]!
  const sv = stride[vA]!
  const step = fromHigh ? -stride[a]! : stride[a]!
  const base = fromHigh ? (na - 1) * stride[a]! : 0
  const ch = origin ? origin[hA]! : 0
  const cv = origin ? origin[vA]! : vA === 1 ? grid.size[1] / 2 : 0
  const rs = def.right[hA]!
  const us = def.up[vA]!
  const l = lights(view)
  const plot = newPlot(w, h)
  const p = [0, 0, 0]
  for (let py = 0; py < h; py++) {
    const wv = cv + us * (h / 2 - py - 0.5) / pxPerCm
    const fv = (wv - o[vA]!) / voxel
    const iv = Math.floor(fv)
    if (iv < 0 || iv >= nv - 1) continue
    const tv = fv - iv
    for (let px = 0; px < w; px++) {
      const wh = ch + rs * (px + 0.5 - w / 2) / pxPerCm
      const fh = (wh - o[hA]!) / voxel
      const ih = Math.floor(fh)
      if (ih < 0 || ih >= nh - 1) continue
      const th = fh - ih
      const m = ih + nh * iv
      let c = first[m]!
      if (first[m + 1]! < c) c = first[m + 1]!
      if (first[m + nh]! < c) c = first[m + nh]!
      if (first[m + nh + 1]! < c) c = first[m + nh + 1]!
      if (c === MISS) continue
      const w00 = (1 - th) * (1 - tv)
      const w10 = th * (1 - tv)
      const w01 = (1 - th) * tv
      const w11 = th * tv
      if (c > 0) c--
      let at = base + ih * sh + iv * sv + c * step
      let prev = dist[at]! * w00 + dist[at + sh]! * w10 + dist[at + sv]! * w01 + dist[at + sv + sh]! * w11
      let found = prev < 0 ? c : -1
      while (found < 0 && ++c < na) {
        at += step
        const cur = dist[at]! * w00 + dist[at + sh]! * w10 + dist[at + sv]! * w01 + dist[at + sv + sh]! * w11
        if (cur < 0) found = c - 1 + prev / (prev - cur)
        prev = cur
      }
      if (found < 0) continue
      p[hA] = wh
      p[vA] = wv
      p[a] = o[a]! + (fromHigh ? na - 1 - found : found) * voxel
      const i = px + py * w
      plot.hit[i] = 1
      plot.depth[i] = found * voxel
      plot.pos[i * 3] = p[0]!
      plot.pos[i * 3 + 1] = p[1]!
      plot.pos[i * 3 + 2] = p[2]!
      plot.lum[i] = shade(grid, p[0]!, p[1]!, p[2]!, l)
    }
  }
  return plot
}

// Three-quarter views: one ray per pixel, stepped through the grid. Open air is crossed on
// single nearest-sample reads; the interpolated field is only consulted near the surface.
function traceRays(grid: Grid, view: ViewId, w: number, h: number, pxPerCm: number): Plot {
  const { right, up, look } = VIEWS[view]
  const { dist, voxel, nx, ny, x0, y0, z0 } = grid
  const inv = 1 / voxel
  const centre: Vec3 = [0, grid.size[1] / 2, 0]
  // Nothing outside the original block can be stone.
  const lo = [-grid.size[0] / 2 - voxel, -voxel, -grid.size[2] / 2 - voxel]
  const hi = [grid.size[0] / 2 + voxel, grid.size[1] + voxel, grid.size[2] / 2 + voxel]
  const reach = Math.sqrt(grid.size[0] ** 2 + grid.size[1] ** 2 + grid.size[2] ** 2) / 2 + voxel
  const stride = 0.9
  const l = lights(view)
  const plot = newPlot(w, h)
  for (let py = 0; py < h; py++) {
    const t = (h / 2 - py - 0.5) / pxPerCm
    for (let px = 0; px < w; px++) {
      const u = (px + 0.5 - w / 2) / pxPerCm
      const ox = centre[0] + right[0] * u + up[0] * t
      const oy = centre[1] + right[1] * u + up[1] * t
      const oz = centre[2] + right[2] * u + up[2] * t
      const o = [ox, oy, oz]
      let near = -reach
      let far = reach
      for (let c = 0; c < 3; c++) {
        if (look[c] === 0) {
          if (o[c]! < lo[c]! || o[c]! > hi[c]!) near = far + 1
          continue
        }
        const a = (lo[c]! - o[c]!) / look[c]!
        const b = (hi[c]! - o[c]!) / look[c]!
        if (a < b) {
          if (a > near) near = a
          if (b < far) far = b
        } else {
          if (b > near) near = b
          if (a < far) far = a
        }
      }
      if (near > far) continue
      let at = near
      let before = near
      let found = Infinity
      while (at <= far) {
        const x = ox + look[0] * at
        const y = oy + look[1] * at
        const z = oz + look[2] * at
        const q = dist[Math.round((x - x0) * inv) + nx * (Math.round((y - y0) * inv) + ny * Math.round((z - z0) * inv))]!
        if (q >= Q_MAX) {
          before = at
          at += stride
          continue
        }
        const d = sampleDistance(grid, x, y, z)
        if (d < 0) {
          let a = before
          let b = at
          for (let k = 0; k < 7; k++) {
            const mid = (a + b) / 2
            if (sampleDistance(grid, ox + look[0] * mid, oy + look[1] * mid, oz + look[2] * mid) < 0) b = mid
            else a = mid
          }
          found = (a + b) / 2
          break
        }
        before = at
        at += d * 0.8 > voxel / 4 ? d * 0.8 : voxel / 4
      }
      if (found === Infinity) continue
      const i = px + py * w
      const x = ox + look[0] * found
      const y = oy + look[1] * found
      const z = oz + look[2] * found
      plot.hit[i] = 1
      plot.depth[i] = found + reach
      plot.pos[i * 3] = x
      plot.pos[i * 3 + 1] = y
      plot.pos[i * 3 + 2] = z
      plot.lum[i] = shade(grid, x, y, z, l)
    }
  }
  return plot
}

// Two cheap depth cues on top of the lighting. Each pixel is compared with the mean depth
// around it at two scales, so cuts and the far side of an overlap darken (a stand-in for
// ambient occlusion), and the whole stone dims a little with distance.
function depthCues(plot: Plot, pxPerCm: number): void {
  const { w, h, hit, depth, lum } = plot
  const W = w + 1
  const sum = new Float64Array(W * (h + 1))
  const cnt = new Int32Array(W * (h + 1))
  let near = Infinity
  let far = -Infinity
  for (let y = 0; y < h; y++) {
    let rowSum = 0
    let rowCnt = 0
    for (let x = 0; x < w; x++) {
      const i = x + y * w
      if (hit[i] === 1) {
        const d = depth[i]!
        rowSum += d
        rowCnt++
        if (d < near) near = d
        if (d > far) far = d
      }
      const o = x + 1 + (y + 1) * W
      sum[o] = sum[o - W]! + rowSum
      cnt[o] = cnt[o - W]! + rowCnt
    }
  }
  const range = Math.max(12, far - near)
  const fine = Math.max(1, Math.round(1.2 * pxPerCm))
  const broad = Math.max(2, Math.round(5 * pxPerCm))
  const mean = (x: number, y: number, r: number): number => {
    const ax = x - r > 0 ? x - r : 0
    const ay = y - r > 0 ? y - r : 0
    const bx = x + r + 1 < w ? x + r + 1 : w
    const by = y + r + 1 < h ? y + r + 1 : h
    const a = ax + ay * W
    const b = bx + ay * W
    const c = ax + by * W
    const d = bx + by * W
    return (sum[d]! - sum[b]! - sum[c]! + sum[a]!) / (cnt[d]! - cnt[b]! - cnt[c]! + cnt[a]!)
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = x + y * w
      if (hit[i] !== 1) continue
      const d = depth[i]!
      let a = (d - mean(x, y, fine)) * 0.3
      a = a < -0.08 ? -0.08 : a > 0.3 ? 0.3 : a
      let b = (d - mean(x, y, broad)) * 0.035
      b = b < -0.05 ? -0.05 : b > 0.25 ? 0.25 : b
      lum[i] = lum[i]! * (1 - a - b) * (1 - 0.2 * (d - near) / range)
    }
  }
}

function unionDistance(forms: CompiledForm[], x: number, y: number, z: number): number {
  let best = formDistance(forms[0]!, x, y, z)
  for (let i = 1; i < forms.length; i++) {
    const d = formDistance(forms[i]!, x, y, z)
    if (d < best) best = d
  }
  return best
}

// The form's silhouette in a view, one flag per plot pixel. The least distance to the form
// along each ray is found on a coarse lattice and interpolated; that field is close to the
// signed distance to the silhouette, so the interpolated edge is smooth.
function formSilhouette(forms: CompiledForm[], grid: Grid, view: ViewId, w: number, h: number, pxPerCm: number, origin?: Vec3): Uint8Array {
  const { right, up, look } = VIEWS[view]
  const centre: Vec3 = origin ?? [0, grid.size[1] / 2, 0]
  const reach = Math.sqrt(grid.size[0] ** 2 + grid.size[1] ** 2 + grid.size[2] ** 2) / 2
  const cell = 4
  const lw = Math.ceil(w / cell) + 1
  const lh = Math.ceil(h / cell) + 1
  const least = new Float32Array(lw * lh)
  for (let b = 0; b < lh; b++) {
    const t = (h / 2 - b * cell) / pxPerCm
    for (let a = 0; a < lw; a++) {
      const u = (a * cell - w / 2) / pxPerCm
      const ox = centre[0] + right[0] * u + up[0] * t
      const oy = centre[1] + right[1] * u + up[1] * t
      const oz = centre[2] + right[2] * u + up[2] * t
      let low = 1e9
      for (let at = -reach; at <= reach;) {
        const d = unionDistance(forms, ox + look[0] * at, oy + look[1] * at, oz + look[2] * at)
        if (d < low) low = d
        // Deep enough inside that the edge is settled by nearer lattice points.
        if (low < -3) break
        const s = (d < 0 ? -d : d) * 0.7
        at += s > 0.4 ? s : 0.4
      }
      least[a + b * lw] = low
    }
  }
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) / cell
    const iy = Math.floor(fy)
    const ty = fy - iy
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) / cell
      const ix = Math.floor(fx)
      const tx = fx - ix
      const m = ix + iy * lw
      const p = least[m]! + (least[m + 1]! - least[m]!) * tx
      const q = least[m + lw]! + (least[m + lw + 1]! - least[m + lw]!) * tx
      if (p + (q - p) * ty < 0) out[x + y * w] = 1
    }
  }
  return out
}

// A reference outline laid over a tile's plot: which plot pixels fall inside the mask.
function maskOnPlot(mask: Mask, grid: GridInfo, tile: TileLayout): Uint8Array {
  const { x, y, width: w, height: h } = tile.plot
  const view = tile.view as SideView
  const a = blockToMask(grid, view, mask.width, mask.height, ...pixelToBlock(tile, x + 0.5, y + 0.5))
  const b = blockToMask(grid, view, mask.width, mask.height, ...pixelToBlock(tile, x + 1.5, y + 1.5))
  const out = new Uint8Array(w * h)
  for (let py = 0; py < h; py++) {
    const row = Math.floor(a[1] + (b[1] - a[1]) * py)
    if (row < 0 || row >= mask.height) continue
    for (let px = 0; px < w; px++) {
      const col = Math.floor(a[0] + (b[0] - a[0]) * px)
      if (col >= 0 && col < mask.width && mask.data[col + row * mask.width]! > 0) out[px + py * w] = 1
    }
  }
  return out
}

// ---------- tiles ----------

function drawTitle(img: Image, tile: TileLayout, text: string): void {
  const f = fontScale(tile.pxPerCm)
  const x = tile.plot.x + Math.max(0, Math.round((tile.plot.width - textWidth(text, f)) / 2))
  drawText(img, x, tile.y + 4, text, f, TEXT)
}

// The centimetre grid over the plot and the two rulers beside it. `stone` is the plot's
// hit flags, when the plot is a render of the stone.
function drawRulers(img: Image, grid: GridInfo, tile: TileLayout, stone?: Uint8Array): void {
  const r = tile.ruler!
  const { plot, pxPerCm } = tile
  const f = fontScale(pxPerCm)
  const minor = gridStep(pxPerCm)
  const labelEvery = labelStep(pxPerCm)
  const span = (axis: string): [number, number] => axis === 'Y'
    ? [0, grid.size[1]]
    : axis === 'X' ? [-grid.size[0] / 2, grid.size[0] / 2] : [-grid.size[2] / 2, grid.size[2] / 2]
  // The block's own edges are drawn strongest: they show how much has come off.
  const strength = (value: number, lo: number, hi: number): number =>
    value === lo || value === hi
      ? 0.5
      : value % 10 === 0 ? 0.3 : minor >= 5 ? 0.14 : value % 5 === 0 ? 0.2 : 0.08
  // A close-up shows part of the block: lines are drawn only for what is in the plot.
  const a = pixelToBlock(tile, plot.x, plot.y)
  const b = pixelToBlock(tile, plot.x + plot.width, plot.y + plot.height)

  const [hLo, hHi] = span(r.hAxis)
  for (let value = Math.ceil(Math.max(hLo, Math.min(a[0], b[0])) / minor) * minor; value <= Math.min(hHi, Math.max(a[0], b[0])); value += minor) {
    const x = Math.min(plot.x + plot.width - 1, Math.max(plot.x, Math.floor(r.h0 + value * r.hPerCm)))
    const alpha = strength(value, hLo, hHi)
    for (let y = plot.y; y < plot.y + plot.height; y++) etch(img, x, y, alpha, stone?.[x - plot.x + (y - plot.y) * plot.width])
    if (value % labelEvery !== 0) continue
    const text = String(value)
    drawText(img, x - Math.round(textWidth(text, f) / 2), plot.y + plot.height + 4, text, f, AXIS[r.hAxis]!)
  }
  const [vLo, vHi] = span(r.vAxis)
  for (let value = Math.ceil(Math.max(vLo, Math.min(a[1], b[1])) / minor) * minor; value <= Math.min(vHi, Math.max(a[1], b[1])); value += minor) {
    const y = Math.min(plot.y + plot.height - 1, Math.max(plot.y, Math.floor(r.v0 + value * r.vPerCm)))
    const alpha = strength(value, vLo, vHi)
    for (let x = plot.x; x < plot.x + plot.width; x++) etch(img, x, y, alpha, stone?.[x - plot.x + (y - plot.y) * plot.width])
    if (value % labelEvery !== 0) continue
    const text = String(value)
    drawText(img, plot.x - 5 - textWidth(text, f), y - Math.floor(7 * f / 2), text, f, AXIS[r.vAxis]!)
  }
  drawText(img, tile.x + 4, tile.y + 4, r.vAxis, f, AXIS[r.vAxis]!)
  drawText(img, tile.x + 4, plot.y + plot.height + 4, r.hAxis, f, AXIS[r.hAxis]!)
}

interface Job {
  overlay: Overlay
  forms: CompiledForm[]
  reference?: ReferenceInput
  sketches?: SketchMarks[]
}

// Charcoal. A mark shows dark where the stone it was drawn on is still the surface this
// view sees at that spot. In the view the line was drawn from, the rest of it stays as a
// pale ghost at the same ruler coordinates.
function drawSketches(img: Image, grid: Grid, tile: TileLayout, plot: Plot, sketches: SketchMarks[]): void {
  const { right, up } = VIEWS[tile.view]
  const { x: px0, y: py0, width: w, height: h } = tile.plot
  const o = tile.origin ?? [0, grid.size[1] / 2, 0]
  const k = tile.pxPerCm
  // 1 dark, 2 ghost: a pixel is inked once however many marks cross it, dark over ghost.
  const ink = new Uint8Array(w * h)
  for (const sketch of sketches) {
    const own = sketch.view === tile.view
    for (const stroke of sketch.strokes) {
      for (let n = 1; n < stroke.length; n++) {
        const p = stroke[n - 1]!
        const q = stroke[n]!
        const steps = Math.max(1, Math.ceil(k * Math.sqrt((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2)))
        for (let s = 0; s <= steps; s++) {
          const t = s / steps
          const x = p[0] + (q[0] - p[0]) * t
          const y = p[1] + (q[1] - p[1]) * t
          const z = p[2] + (q[2] - p[2]) * t
          const u = (x - o[0]) * right[0] + (y - o[1]) * right[1] + (z - o[2]) * right[2]
          const v = (x - o[0]) * up[0] + (y - o[1]) * up[1] + (z - o[2]) * up[2]
          const px = Math.floor(w / 2 + u * k)
          const py = Math.floor(h / 2 - v * k)
          if (px < 0 || py < 0 || px >= w - 1 || py >= h - 1) continue
          const i = px + py * w
          const ex = plot.pos[i * 3]! - x
          const ey = plot.pos[i * 3 + 1]! - y
          const ez = plot.pos[i * 3 + 2]! - z
          const on = plot.hit[i] === 1 && ex * ex + ey * ey + ez * ez < 0.8
          if (!on && !own) continue
          const mark = on ? 1 : 2
          for (let c = 0; c < 4; c++) {
            const j = i + (c & 1) + (c >> 1) * w
            if (ink[j] === 0 || mark < ink[j]!) ink[j] = mark
          }
        }
      }
    }
  }
  for (let y = 0; y < h; y++) {
    let at = (px0 + (py0 + y) * img.width) * 4
    for (let x = 0; x < w; x++, at += 4) {
      const mark = ink[x + y * w]!
      if (mark === 0) continue
      const colour = mark === 1 ? CHARCOAL : GHOST
      const alpha = mark === 1 ? 0.85 : 0.6
      img.data[at] = img.data[at]! + (colour[0] - img.data[at]!) * alpha
      img.data[at + 1] = img.data[at + 1]! + (colour[1] - img.data[at + 1]!) * alpha
      img.data[at + 2] = img.data[at + 2]! + (colour[2] - img.data[at + 2]!) * alpha
    }
  }
}

function drawStone(img: Image, grid: Grid, tile: TileLayout, job: Job): Plot {
  const { view, plot: rect, pxPerCm } = tile
  const { width: w, height: h } = rect
  const plot = isAxisView(view) ? traceAxis(grid, view, w, h, pxPerCm, tile.origin) : traceRays(grid, view, w, h, pxPerCm)
  depthCues(plot, pxPerCm)

  // Where the target expects stone: the form's silhouette, or the reference outline.
  const useForm = job.overlay === 'form' && job.forms.length > 0
  const mask = job.overlay === 'reference' && isSide(view) ? job.reference?.outlines?.[view] : undefined
  const wanted = useForm
    ? formSilhouette(job.forms, grid, view, w, h, pxPerCm, tile.origin)
    : mask ? maskOnPlot(mask, grid, tile) : null

  const { hit, lum, pos } = plot
  for (let y = 0; y < h; y++) {
    let o = (rect.x + (rect.y + y) * img.width) * 4
    for (let x = 0; x < w; x++, o += 4) {
      const i = x + y * w
      if (hit[i] !== 1) {
        const ground = wanted !== null && wanted[i] === 1 ? LOST : BG_PLOT
        img.data[o] = ground[0]
        img.data[o + 1] = ground[1]
        img.data[o + 2] = ground[2]
        continue
      }
      let r: number = CLAY[0]
      let g: number = CLAY[1]
      let b: number = CLAY[2]
      let from: RGB | null = null
      let to: RGB = PROUD_MID
      let mix = 0
      let alpha = 0
      if (useForm) {
        const f = unionDistance(job.forms, pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!)
        if (f > ON_FORM_CM) {
          const t = f - ON_FORM_CM
          from = t < PROUD_MID_CM ? PROUD_NEAR : PROUD_MID
          to = t < PROUD_MID_CM ? PROUD_MID : PROUD_FAR
          mix = t < PROUD_MID_CM ? t / PROUD_MID_CM : Math.min(1, (t - PROUD_MID_CM) / (PROUD_FAR_CM - PROUD_MID_CM))
          alpha = 0.45 + 0.25 * Math.min(1, t / 2)
        } else if (f < -ON_FORM_CM) {
          from = CUT_NEAR
          to = CUT_DEEP
          mix = Math.min(1, (-f - ON_FORM_CM) / 3)
          alpha = 0.8
        }
      } else if (wanted !== null && wanted[i] !== 1) {
        from = PROUD_MID
        alpha = 0.7
      }
      if (from !== null) {
        r += (from[0] + (to[0] - from[0]) * mix - r) * alpha
        g += (from[1] + (to[1] - from[1]) * mix - g) * alpha
        b += (from[2] + (to[2] - from[2]) * mix - b) * alpha
      }
      const l = lum[i]!
      img.data[o] = r * l > 255 ? 255 : r * l
      img.data[o + 1] = g * l > 255 ? 255 : g * l
      img.data[o + 2] = b * l > 255 ? 255 : b * l
    }
  }
  if (tile.ruler) drawRulers(img, grid, tile, hit)
  if (wanted !== null) outline(img, rect, wanted, OUTLINE)
  if (job.sketches && job.sketches.length > 0) drawSketches(img, grid, tile, plot, job.sketches)
  drawTitle(img, tile, tile.origin ? `${view.toUpperCase()} CLOSE-UP` : view.toUpperCase())
  return plot
}

function drawReference(img: Image, grid: Grid, tile: TileLayout, src: ImageLike, stone: Plot): void {
  const { plot, pxPerCm } = tile
  fill(img, plot.x, plot.y, plot.width, plot.height, BG_PLOT)
  const def = VIEWS[tile.view]
  const fw = Math.round(grid.size[def.h!] * pxPerCm)
  const fh = Math.round(grid.size[def.v!] * pxPerCm)
  const fx = plot.x + Math.round((plot.width - fw) / 2)
  const fy = plot.y + Math.round((plot.height - fh) / 2)
  if (tile.ruler) {
    drawImage(img, src, fx, fy, fw, fh, BG_PLOT)
    drawRulers(img, grid, tile)
    outline(img, plot, stone.hit, STONE_LINE)
  } else {
    const k = Math.min(fw / src.width, fh / src.height)
    const dw = Math.max(1, Math.round(src.width * k))
    const dh = Math.max(1, Math.round(src.height * k))
    drawImage(img, src, fx + Math.round((fw - dw) / 2), fy + Math.round((fh - dh) / 2), dw, dh, BG_PLOT)
  }
  drawTitle(img, tile, `REF ${tile.view.toUpperCase()}`)
}

function drawTiles(img: Image, grid: Grid, tiles: TileLayout[], opts: LookOptions): void {
  const job: Job = { overlay: opts.overlay ?? 'grid', forms: pickForms(grid.forms, opts.forms), reference: opts.reference, sketches: opts.sketches }
  let stone: Plot | null = null
  for (const tile of tiles) {
    if (tile.kind === 'stone') stone = drawStone(img, grid, tile, job)
    else drawReference(img, grid, tile, opts.reference!.tiles![tile.view as SideView]!, stone!)
  }
}

// One view on its own: the tile exactly as it appears in a contact sheet, without a legend
// and without a reference tile beside it.
export function renderView(grid: Grid, view: ViewId, opts: LookOptions = {}): Image {
  const pxPerCm = opts.pxPerCm ?? 5
  const tile = makeTile(grid, view, 'stone', pxPerCm, isAxisView(view))
  const img = blank(tile.width, tile.height, BG)
  drawTiles(img, grid, [tile], opts)
  return img
}

// Up to six views (more are laid out too, at a smaller scale) tiled into one image at one
// scale, with a legend along the bottom. This is what a look sends the model.
export function renderContactSheet(grid: Grid, views: ViewId[], opts: LookOptions = {}): Image {
  const layout = fitSheet(grid, views, opts)
  const img = blank(layout.width, layout.height, BG)
  drawTiles(img, grid, layout.tiles, opts)
  const f = fontScale(layout.pxPerCm)
  const overlay = opts.overlay ?? 'grid'
  drawLegend(img, legendTokens(overlay, targetsFor(grid, views, opts), layout.pxPerCm, sketched(opts)), f, layout.legendY)
  return img
}

function drawLegend(img: Image, tokens: Token[], f: number, top: number): void {
  const legend = flowLegend(tokens, f, img.width - 2 * GAP)
  for (const { token, x, y } of legend.placed) {
    if ('swatch' in token) fill(img, GAP + x, top + y, 9 * f, 7 * f, token.swatch)
    else drawText(img, GAP + x, top + y, token.text, f, TEXT)
  }
}

function shift(tile: TileLayout, x: number, y: number): TileLayout {
  tile.x += x
  tile.y += y
  tile.plot.x += x
  tile.plot.y += y
  if (tile.ruler) {
    tile.ruler.h0 += x
    tile.ruler.v0 += y
  }
  return tile
}

// ---------- close-ups ----------

function windowTile(grid: GridInfo, view: AxisView, kind: 'stone' | 'reference', centre: [number, number], spanCm: number, pxPerCm: number): TileLayout {
  const f = fontScale(pxPerCm)
  const strip = 7 * f + 8
  const left = 18 * f + 8
  const side = Math.round(spanCm * pxPerCm)
  const def = VIEWS[view]
  const h = def.h!
  const v = def.v!
  const hPerCm = def.right[h] * pxPerCm
  const vPerCm = -def.up[v] * pxPerCm
  const origin: Vec3 = [0, grid.size[1] / 2, 0]
  origin[h] = centre[0]
  origin[v] = centre[1]
  return {
    view,
    kind,
    x: 0,
    y: 0,
    width: left + side + 10,
    height: strip + side + strip,
    plot: { x: left, y: strip, width: side, height: side },
    pxPerCm,
    ruler: {
      hAxis: h === 0 ? 'X' : 'Z',
      vAxis: v === 1 ? 'Y' : 'Z',
      h0: left + side / 2 - centre[0] * hPerCm,
      hPerCm,
      v0: strip + side / 2 - centre[1] * vPerCm,
      vPerCm
    },
    origin
  }
}

// The part of a block-aligned reference tile that a close-up's window covers, under the
// same rulers, with the stone's outline over it.
function drawReferenceWindow(img: Image, grid: Grid, tile: TileLayout, src: ImageLike, stone: Plot): void {
  const { plot } = tile
  const view = tile.view as SideView
  fill(img, plot.x, plot.y, plot.width, plot.height, BG_PLOT)
  for (let y = 0; y < plot.height; y++) {
    for (let x = 0; x < plot.width; x++) {
      const [col, row] = blockToMask(grid, view, src.width, src.height, ...pixelToBlock(tile, plot.x + x + 0.5, plot.y + y + 0.5))
      if (col < 0 || row < 0 || col >= src.width || row >= src.height) continue
      // The window is an enlargement, so blend the four source pixels round the point.
      const fx = Math.min(src.width - 1, Math.max(0, col - 0.5))
      const fy = Math.min(src.height - 1, Math.max(0, row - 0.5))
      const sx = Math.min(src.width - 2, Math.floor(fx))
      const sy = Math.min(src.height - 2, Math.floor(fy))
      const tx = fx - sx
      const ty = fy - sy
      const o = (plot.x + x + (plot.y + y) * img.width) * 4
      for (let c = 0; c < 3; c++) {
        let sum = 0
        for (let k = 0; k < 4; k++) {
          const s = (sx + (k & 1) + (sy + (k >> 1)) * src.width) * 4
          const alpha = src.data[s + 3]! / 255
          sum += (src.data[s + c]! * alpha + BG_PLOT[c]! * (1 - alpha)) * ((k & 1) === 1 ? tx : 1 - tx) * (k >> 1 === 1 ? ty : 1 - ty)
        }
        img.data[o + c] = sum
      }
    }
  }
  drawRulers(img, grid, tile)
  outline(img, plot, stone.hit, STONE_LINE)
  drawTitle(img, tile, `REF ${tile.view.toUpperCase()} CLOSE-UP`)
}

export interface Closeup {
  image: Image
  // Where the stone's window sits in the image, with its ruler mapping (blockToPixel works).
  tile: TileLayout
  pxPerCm: number
  // Share of the window that shows stone, 0 to 1.
  stoneShare: number
  // The block axis the view looks along, and the least and greatest coordinate on it of the
  // surface in the window, cm: how far the nearest and the deepest stone in sight are apart.
  axis: 'x' | 'y' | 'z'
  surfaceMin: number
  surfaceMax: number
  // With the form overlay and a form declared: the furthest the surface in the window stands
  // outside the form, and the furthest it has been cut below it, cm.
  proudMax?: number
  belowMax?: number
  // The surface's coordinate on that axis along the window's horizontal and vertical centre
  // lines, at PROFILE_SAMPLES evenly spaced points from the ruler's low end to its high end
  // (left to right as the ruler runs, bottom to top); NaN where the line meets no stone.
  profileH: number[]
  profileV: number[]
}

export const PROFILE_SAMPLES = 9

// One axis view enlarged: a square window `spanCm` across centred on a ruler point, with a
// one-centimetre grid, so a face or a paw can be read and strokes placed on it. Takes the
// same overlays and sketches as a look. With the reference overlay the same window of the
// reference sheet sits beside it (side views with a block-aligned tile only).
export function renderCloseup(grid: Grid, view: AxisView, centre: [number, number], spanCm: number, opts: LookOptions = {}): Closeup {
  const pxPerCm = opts.pxPerCm ?? Math.round(100 * Math.min(60, 760 / spanCm)) / 100
  const overlay = opts.overlay ?? 'grid'
  const tiles = [shift(windowTile(grid, view, 'stone', centre, spanCm, pxPerCm), GAP, GAP)]
  const side = isSide(view) ? view : null
  const ref = overlay === 'reference' && side ? opts.reference?.tiles?.[side] : undefined
  if (ref && side && fitsFace(grid, side, ref)) tiles.push(shift(windowTile(grid, view, 'reference', centre, spanCm, pxPerCm), tiles[0]!.width + 2 * GAP, GAP))
  const last = tiles[tiles.length - 1]!
  const width = last.x + last.width + GAP
  const f = fontScale(pxPerCm)
  const targets = overlay === 'form' ? pickForms(grid.forms, opts.forms).length > 0 : overlay === 'reference' && !!side && !!opts.reference?.outlines?.[side]
  const tokens = legendTokens(overlay, targets, pxPerCm, sketched(opts))
  const top = last.y + last.height + GAP
  const img = blank(width, top + flowLegend(tokens, f, width - 2 * GAP).height + GAP, BG)
  const job: Job = { overlay, forms: pickForms(grid.forms, opts.forms), reference: opts.reference, sketches: opts.sketches }
  const plot = drawStone(img, grid, tiles[0]!, job)
  if (tiles.length > 1) drawReferenceWindow(img, grid, tiles[1]!, ref!, plot)
  drawLegend(img, tokens, f, top)

  const def = VIEWS[view]
  const a = 3 - def.h! - def.v!
  let hits = 0
  let lo = Infinity
  let hi = -Infinity
  let proud = 0
  let below = 0
  const measure = overlay === 'form' && job.forms.length > 0
  for (let i = 0; i < plot.hit.length; i++) {
    if (plot.hit[i] !== 1) continue
    hits++
    const c = plot.pos[i * 3 + a]!
    if (c < lo) lo = c
    if (c > hi) hi = c
    // Every ninth pixel is plenty to find the worst of it.
    if (measure && i % 9 === 0) {
      const d = unionDistance(job.forms, plot.pos[i * 3]!, plot.pos[i * 3 + 1]!, plot.pos[i * 3 + 2]!)
      if (d > proud) proud = d
      if (-d > below) below = -d
    }
  }
  // Relief along the two centre lines, read off the plot in ruler order.
  const tile = tiles[0]!
  const ruler = tile.ruler!
  const sample = (px: number, py: number): number => {
    const x = Math.round(px) - tile.plot.x
    const y = Math.round(py) - tile.plot.y
    if (x < 0 || y < 0 || x >= plot.w || y >= plot.h) return NaN
    const i = y * plot.w + x
    return plot.hit[i] === 1 ? Math.round(plot.pos[i * 3 + a]! * 10) / 10 : NaN
  }
  const profileH: number[] = []
  const profileV: number[] = []
  const hMid = tile.plot.x + tile.plot.width / 2
  const vMid = tile.plot.y + tile.plot.height / 2
  for (let k = 0; k < PROFILE_SAMPLES; k++) {
    const t = (k + 0.5) / PROFILE_SAMPLES - 0.5
    const h = centre[0] + t * spanCm
    const v = centre[1] + t * spanCm
    profileH.push(sample(ruler.h0 + h * ruler.hPerCm, vMid))
    profileV.push(sample(hMid, ruler.v0 + v * ruler.vPerCm))
  }
  return {
    image: img,
    tile,
    pxPerCm,
    stoneShare: plot.hit.length > 0 ? hits / plot.hit.length : 0,
    profileH,
    profileV,
    axis: (['x', 'y', 'z'] as const)[a]!,
    surfaceMin: hits > 0 ? lo : 0,
    surfaceMax: hits > 0 ? hi : 0,
    ...(measure ? { proudMax: proud, belowMax: below } : {})
  }
}

// ---------- slices ----------

export interface SliceOptions {
  pxPerCm?: number
  // Names of declared forms whose section is drawn in the same plane. Default: all of them.
  forms?: string[]
  // The reference's front and left outlines; the section of the volume inside both is drawn.
  outlines?: { front: Mask, left: Mask }
}

// The stone cut through by the plane <axis> = at (block cm) and seen square on, drawn under
// the rulers of the axis view it matches (SLICE_VIEW): what a look cannot show, such as how
// thick a neck really is or how far a nose stands off a face. The declared form's section is
// drawn in the same plane, with the stone outside it and the form missing stone tinted as in
// a look; the reference's two outlines pushed through the block give a third line.
export function renderSlice(grid: Grid, axis: SliceAxis, at: number, opts: SliceOptions = {}): Image {
  const view = SLICE_VIEW[axis]
  const pxPerCm = opts.pxPerCm ?? 8
  const tile = shift(makeTile(grid, view, 'stone', pxPerCm, true), GAP, GAP)
  const forms = pickForms(grid.forms, opts.forms)
  const f = fontScale(pxPerCm)
  const tokens: Token[] = [...words(`RULERS: BLOCK CM. GRID EVERY ${gridStep(pxPerCm)} CM.`), { swatch: SECTION }, ...words('STONE IN THIS PLANE.')]
  if (forms.length > 0) {
    tokens.push({ swatch: PROUD_NEAR }, { swatch: PROUD_MID }, { swatch: PROUD_FAR },
      ...words(`STONE OUTSIDE YOUR FORM BY 1 / ${PROUD_MID_CM} / ${PROUD_FAR_CM}+ CM.`),
      { swatch: LOST }, ...words('FORM WITH NO STONE.'), { swatch: OUTLINE }, ...words('FORM OUTLINE.'))
  }
  if (opts.outlines) tokens.push({ swatch: HULL }, ...words('REFERENCE OUTLINES PUSHED THROUGH THE BLOCK.'))
  const width = tile.width + 2 * GAP
  const top = tile.y + tile.height + GAP
  const img = blank(width, top + flowLegend(tokens, f, width - 2 * GAP).height + GAP, BG)

  const def = VIEWS[view]
  const hA = def.h!
  const vA = def.v!
  const { x: px0, y: py0, width: w, height: h } = tile.plot
  const stone = new Uint8Array(w * h)
  const wanted = forms.length > 0 ? new Uint8Array(w * h) : null
  const hull = opts.outlines ? new Uint8Array(w * h) : null
  const p = [0, 0, 0]
  p[3 - hA - vA] = at
  for (let y = 0; y < h; y++) {
    let o = (px0 + (py0 + y) * img.width) * 4
    for (let x = 0; x < w; x++, o += 4) {
      const i = x + y * w
      const [bh, bv] = pixelToBlock(tile, px0 + x + 0.5, py0 + y + 0.5)
      p[hA] = bh
      p[vA] = bv
      const solid = sampleDistance(grid, p[0]!, p[1]!, p[2]!) < 0
      if (solid) stone[i] = 1
      let r: number = solid ? SECTION[0] : BG_PLOT[0]
      let g: number = solid ? SECTION[1] : BG_PLOT[1]
      let b: number = solid ? SECTION[2] : BG_PLOT[2]
      if (wanted !== null) {
        const d = unionDistance(forms, p[0]!, p[1]!, p[2]!)
        if (d < 0) wanted[i] = 1
        if (solid && d > ON_FORM_CM) {
          const t = d - ON_FORM_CM
          const from = t < PROUD_MID_CM ? PROUD_NEAR : PROUD_MID
          const to = t < PROUD_MID_CM ? PROUD_MID : PROUD_FAR
          const mix = t < PROUD_MID_CM ? t / PROUD_MID_CM : Math.min(1, (t - PROUD_MID_CM) / (PROUD_FAR_CM - PROUD_MID_CM))
          r += (from[0] + (to[0] - from[0]) * mix - r) * 0.65
          g += (from[1] + (to[1] - from[1]) * mix - g) * 0.65
          b += (from[2] + (to[2] - from[2]) * mix - b) * 0.65
        } else if (!solid && d < -ON_FORM_CM) {
          r = LOST[0]
          g = LOST[1]
          b = LOST[2]
        }
      }
      if (hull !== null && maskCovers(opts.outlines!.front, grid, 'front', p[0]!, p[1]!, p[2]!)
        && maskCovers(opts.outlines!.left, grid, 'left', p[0]!, p[1]!, p[2]!)) hull[i] = 1
      img.data[o] = r
      img.data[o + 1] = g
      img.data[o + 2] = b
    }
  }
  drawRulers(img, grid, tile, stone)
  outline(img, tile.plot, stone, SECTION_EDGE)
  if (hull !== null) outline(img, tile.plot, hull, HULL)
  if (wanted !== null) outline(img, tile.plot, wanted, OUTLINE)
  const seen = axis === 'y' ? 'FROM ABOVE' : axis === 'z' ? 'FROM THE FRONT' : 'FROM THE LEFT'
  drawTitle(img, tile, `SLICE AT ${axis.toUpperCase()}=${Math.round(at * 10) / 10} SEEN ${seen}`)
  drawLegend(img, tokens, f, top)
  return img
}
