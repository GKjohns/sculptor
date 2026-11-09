// The reference sheet: what the sculptor asks an image model to draw before the first cut,
// and the code that turns that picture into outlines the hand can cut to. Pure functions over
// RGBA. Nobody but the model sees the sheet, so everything here is built for use.
//
// Sheet layout (fixed, stated in the image prompt): one square image in four quadrants,
//   top-left  front    top-right    left
//   bottom-left back   bottom-right right
// Views are named for the side the VIEWER stands on, exactly like the app's views: `left` is the
// camera on the −X side looking along +X, so it shows the figure's own right-hand side and the
// figure's front (+Z) points to the right edge of that quadrant.

export interface Rgba { width: number, height: number, data: Uint8Array | Uint8ClampedArray }

// data[row * width + col], 1 = inside. Block-aligned masks run from the top of the block
// (row 0) down to its base, and columns follow the view's image from left to right:
// front col 0 = X −w/2, left col 0 = Z −d/2, back col 0 = X +w/2, right col 0 = Z +d/2.
export interface Mask { width: number, height: number, data: Uint8Array }

export type RefView = 'front' | 'left' | 'back' | 'right'
export type Point2 = [number, number]

export const REF_VIEWS: readonly RefView[] = ['front', 'left', 'back', 'right']

export const REFERENCE_QUADRANTS: Record<RefView, { col: 0 | 1, row: 0 | 1 }> = {
  front: { col: 0, row: 0 },
  left: { col: 1, row: 0 },
  back: { col: 0, row: 1 },
  right: { col: 1, row: 1 }
}

export interface BlockSize { width: number, height: number, depth: number }

export const REFERENCE_BLOCK: BlockSize = { width: 60, height: 100, depth: 60 }

export interface ReferenceOptions {
  block?: BlockSize // cm
  cellCm?: number // size of one mask cell, default 0.4 (150 × 250 cells for the default block)
  insetCm?: number // air kept between the figure and the block's sides and top, default 2
  simplifyCm?: number // how far an outline may stray from the traced boundary, default 0.15 (never under 0.75 px)
}

export type ReasonCode
  = | 'sheet_too_small'
    | 'bright_background'
    | 'empty'
    | 'several_shapes'
    | 'fragmented'
    | 'touches_edge'
    | 'fills_quadrant'
    | 'too_small'
    | 'sliver'

export interface ReferenceReason { view: RefView | 'sheet', code: ReasonCode, detail: string }

// Pixel bounds of the figure in its quadrant; x1 and y1 are exclusive.
export interface PixelBox { x0: number, y0: number, x1: number, y1: number }

export interface QuadrantSegment {
  mask: Mask // quadrant pixels: the largest shape only, small holes filled
  background: number // luma 0–255 of the quadrant's border
  threshold: number // luma above which a pixel counts as figure
  bbox: PixelBox | null
  area: number // pixels in mask
  shapes: number // connected shapes left once specks and frame lines are dropped
  share: number // the largest shape's part of all foreground, 0–1
}

export interface PairAgreement {
  iou: number // overlap of the two block masks with the second mirrored, 0–1
  profile: number // agreement of their width at each height, 0–1; ignores sideways drift
}

export interface ReferenceConsistency {
  // Each figure's height as it was drawn, at the tallest view's scale. The masks do not keep
  // these differences: every view is scaled on its own so all four stand the same height.
  heightsCm: Record<RefView, number>
  heightSpread: number // (tallest − shortest) / tallest, as drawn
  frontBack: PairAgreement
  leftRight: PairAgreement
  score: number // the weakest of the above, 0–1
}

export interface ReferenceAnalysis {
  // false: keep the image for viewing only and skip the outlines
  ok: boolean
  reasons: ReferenceReason[]
  tiles: Record<RefView, Rgba>
  // The same quadrants resampled onto the block's faces, in step with the masks, so a look can
  // set one beside the stone under the same rulers. Null when not ok.
  aligned: Record<RefView, Rgba> | null
  quadrants: Record<RefView, QuadrantSegment>
  masks: Record<RefView, Mask> | null
  // Closed outer boundary per view, first point not repeated. Each point is [h, y] in block cm:
  // h is block X for front and back, block Z for left and right; y is height above the base.
  outlines: Record<RefView, Point2[]> | null
  // cm per pixel of the tallest view; 0 when not ok. The other views differ from it by their
  // share of heightSpread (see scales).
  scaleCmPerPx: number
  // cm per pixel for each view, uniform in both directions. A generated sheet rarely draws all
  // four views to exactly the same height, and one shared factor would leave the shorter ones
  // short in block cm too: a front ∩ left rough-out would then shave the top off the piece.
  scales: Record<RefView, number> | null
  consistency: ReferenceConsistency | null
}

// ---------- prompts ----------

const B = REFERENCE_BLOCK

// System instructions for the sculptor model when it writes the brief. The design stays the
// sculptor's; material, lighting and layout are fixed by referenceImagePrompt.
export const REFERENCE_BRIEF_INSTRUCTIONS = `Before you touch the stone you may have a small clay model made to work from. An image model will draw it for you as a four-view reference sheet (front, left, back, right). Only you will ever see it. Write the brief for that image model. The design is yours.

The block is ${B.width} cm wide, ${B.depth} cm deep and ${B.height} cm tall, and the piece has to come out of it in one piece. Design something stone can hold:
- One compact, solid mass that rises from a simple base. The base is part of the piece. Keep it low, about a tenth of the height: height spent on a pedestal is height the subject loses.
- Nothing floating or separate. No thin unsupported parts: no outstretched arms, free-standing thin legs, raised tails, fingers, strands or wires. Keep limbs against the body and close gaps with stone.
- No holes through the piece.
- Bold, simplified forms that read from their outline. Detail smaller than about 2 cm will not survive, so make the part that matters most as large as the block allows: in a portrait, a head at least a third of the height.
- It must fit the block's proportions. A piece that stands tall and fills the block uses the stone best.

Write three to six plain sentences covering:
- what the piece is, its pose, and which side is its front
- its overall proportions: how tall against how wide and how deep, and where it is widest
- the main masses from the base upward
- what makes its outline recognisable from the front and from the side

Describe shape only. Leave out material, colour, lighting, background, camera and page layout, which are fixed and added for you, and leave out story and mood. Reply with the brief and nothing else.`

// The user turn that goes with REFERENCE_BRIEF_INSTRUCTIONS.
export function referenceBriefPrompt(commission: string): string {
  return `The commission: ${commission.trim()}\n\nWrite the brief for the reference sheet.`
}

const BRIEF_MAX = 1500

// What the image model receives: the sculptor's brief inside the fixed rules for the sheet.
// A long brief is cut so it cannot drown the layout rules.
export function referenceImagePrompt(brief: string): string {
  const subject = brief.replace(/\s+/g, ' ').trim().slice(0, BRIEF_MAX)
  return `A sculptor's reference sheet: a four-view orthographic turnaround of one small clay model, made as the study for a stone carving.

The model: ${subject}

Layout. One square image split into four equal quadrants, two across and two down. Each quadrant shows the same model at the same size from a different side:
- Top-left quadrant: FRONT view. The model seen straight on from the front.
- Top-right quadrant: LEFT view. Stand in front of the model, then walk a quarter turn around it to your own left and look at it side-on. This shows the model's own right-hand side, and the model's front points toward the right edge of this quadrant.
- Bottom-left quadrant: BACK view. The model seen straight on from behind.
- Bottom-right quadrant: RIGHT view. From in front, walk a quarter turn around it to your own right and look at it side-on. This shows the model's own left-hand side, and the model's front points toward the left edge of this quadrant.

Rules for every quadrant:
- Orthographic projection: a flat, straight-on elevation. No perspective, no foreshortening, no tilt, no three-quarter angle.
- The model stands upright and centred in its quadrant, the same height in all four, about four fifths of the quadrant's height, with empty background on every side. It never touches or crosses the edge of its quadrant.
- Exactly the same object in all four views: same proportions, same pose, same base.
- Material: plain matte mid-grey clay in one uniform colour. No gloss, no texture, no pattern.
- Lighting: soft and even from the front. No dramatic shadows. Every part of the model is clearly lighter than the background.
- Background: flat pure black (#000000) with nothing on it. No floor, no ground line, no cast shadow, no gradient, no glow.
- The model is one compact solid mass standing on a simple base that is part of it. No floating or separate parts, no thin unsupported limbs or strands, no holes through it: nothing a single block of stone could not hold.
- No text, letters, numbers, labels, arrows, rulers, borders, frames or dividing lines anywhere in the image.`
}

// ---------- quadrant split ----------

function crop(src: Rgba, x0: number, y0: number, width: number, height: number): Rgba {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const from = ((y0 + y) * src.width + x0) * 4
    data.set(src.data.subarray(from, from + width * 4), y * width * 4)
  }
  return { width, height, data }
}

// Four equal tiles. On an odd-sized sheet the middle row or column belongs to no tile.
export function splitQuadrants(sheet: Rgba): Record<RefView, Rgba> {
  if (sheet.data.length < sheet.width * sheet.height * 4) throw new Error('reference sheet: data is shorter than width × height × 4')
  const w = Math.floor(sheet.width / 2)
  const h = Math.floor(sheet.height / 2)
  const tile = (view: RefView) => {
    const q = REFERENCE_QUADRANTS[view]
    return crop(sheet, q.col * (sheet.width - w), q.row * (sheet.height - h), w, h)
  }
  return { front: tile('front'), left: tile('left'), back: tile('back'), right: tile('right') }
}

// ---------- background threshold ----------

const MIN_TILE = 48 // px; below this a quadrant cannot carry an outline worth cutting to
const BRIGHT_BACKGROUND = 80 // luma; the sheet is meant to be black
const MIN_CONTRAST = 30 // luma between background and the brightest clay
const MIN_STEP = 14 // the threshold sits at least this far above the background
const CONTRAST_SHARE = 0.2 // ...and at least this far up from background to clay
const NOISE_SIGMAS = 5
const SPECK_SHARE = 0.005 // of the largest shape: smaller pieces are noise, dropped silently
const HOLE_SHARE = 0.02 // of the figure: smaller enclosed gaps are shading, filled
const MIN_SHARE = 0.97

// Luma over black, softened by a 3 × 3 box so sensor-style noise and JPEG blocks do not
// speckle the threshold. Integer arithmetic only.
function softLuma(tile: Rgba): Uint8Array {
  const { width: w, height: h, data } = tile
  const luma = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const y = (data[i * 4]! * 77 + data[i * 4 + 1]! * 150 + data[i * 4 + 2]! * 29) >> 8
    luma[i] = (y * data[i * 4 + 3]! + 127) / 255 | 0
  }
  const rows = new Uint16Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      rows[i] = luma[x > 0 ? i - 1 : i]! + luma[i]! + luma[x < w - 1 ? i + 1 : i]!
    }
  }
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const sum = rows[y > 0 ? i - w : i]! + rows[i]! + rows[y < h - 1 ? i + w : i]!
      out[i] = (sum + 4) / 9 | 0
    }
  }
  return out
}

function percentile(hist: Uint32Array, total: number, p: number): number {
  const target = total * p
  let seen = 0
  for (let v = 0; v < hist.length; v++) {
    seen += hist[v]!
    if (seen > target) return v
  }
  return hist.length - 1
}

// Out-of-bounds neighbours count as set, so a figure cut off by the quadrant's edge keeps
// touching it and is reported for that.
function erode(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let keep = 1
      for (let dy = -1; dy <= 1 && keep; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx >= 0 && xx < w && !src[yy * w + xx]) {
            keep = 0
            break
          }
        }
      }
      out[y * w + x] = keep
    }
  }
  return out
}

function dilate(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!src[y * w + x]) continue
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) out[yy * w + xx] = 1
      }
    }
  }
  return out
}

interface Components { labels: Int32Array, areas: number[] }

// Labels the cells where `cells[i] === value`, from 1. Figures join across diagonals
// (eight neighbours); background does not (four), so the two never both leak through a corner.
function label(cells: Uint8Array, w: number, h: number, value: number, diagonals: boolean): Components {
  const labels = new Int32Array(w * h)
  const areas = [0]
  const stack = new Int32Array(w * h)
  for (let start = 0; start < w * h; start++) {
    if (cells[start] !== value || labels[start]) continue
    const id = areas.length
    let area = 0
    let top = 0
    stack[top++] = start
    labels[start] = id
    while (top > 0) {
      const i = stack[--top]!
      area++
      const x = i % w
      const y = (i - x) / w
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w || (!diagonals && dx !== 0 && dy !== 0)) continue
          const j = yy * w + xx
          if (cells[j] === value && !labels[j]) {
            labels[j] = id
            stack[top++] = j
          }
        }
      }
    }
    areas.push(area)
  }
  return { labels, areas }
}

function emptySegment(w: number, h: number, background: number, threshold: number): QuadrantSegment {
  return { mask: { width: w, height: h, data: new Uint8Array(w * h) }, background, threshold, bbox: null, area: 0, shapes: 0, share: 0 }
}

// One quadrant → the figure's mask in quadrant pixels. Tolerates a background that is only
// nearly black, mild gradients and noise, anti-aliased edges, and thin frame or divider lines.
export function segmentQuadrant(tile: Rgba): QuadrantSegment {
  const { width: w, height: h } = tile
  if (w < 3 || h < 3) return emptySegment(w, h, 0, 0)
  const luma = softLuma(tile)

  // The background is whatever the quadrant's border mostly is. The median survives a figure
  // that wrongly runs off the edge, which a high percentile would not.
  const ring = Math.max(2, Math.round(Math.min(w, h) * 0.03))
  const edge = new Uint32Array(256)
  const all = new Uint32Array(256)
  let edgeCount = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = luma[y * w + x]!
      all[v]!++
      if (x < ring || y < ring || x >= w - ring || y >= h - ring) {
        edge[v]!++
        edgeCount++
      }
    }
  }
  const background = percentile(edge, edgeCount, 0.5)
  const spread = new Uint32Array(256)
  for (let v = 0; v < 256; v++) spread[Math.abs(v - background)]! += edge[v]!
  const sigma = 1.4826 * percentile(spread, edgeCount, 0.5)
  const contrast = percentile(all, w * h, 0.99) - background
  const threshold = Math.round(background + Math.max(MIN_STEP, NOISE_SIGMAS * sigma, CONTRAST_SHARE * contrast))
  if (contrast < MIN_CONTRAST) return emptySegment(w, h, background, threshold)

  const raw = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) raw[i] = luma[i]! > threshold ? 1 : 0
  // Opening: removes anything under three pixels across (stray lines, noise) and puts the
  // rest back as it was.
  const open = dilate(erode(raw, w, h), w, h)

  const { labels, areas } = label(open, w, h, 1, true)
  // A shape with no pixel inside the border band is a frame or divider line, not a figure.
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.02))
  const inner = new Uint8Array(areas.length)
  for (let y = band; y < h - band; y++) {
    for (let x = band; x < w - band; x++) inner[labels[y * w + x]!] = 1
  }
  let best = 0
  for (let id = 1; id < areas.length; id++) {
    if (inner[id] && (best === 0 || areas[id]! > areas[best]!)) best = id
  }
  if (best === 0) return emptySegment(w, h, background, threshold)
  const largest = areas[best]!
  let total = 0
  let shapes = 0
  for (let id = 1; id < areas.length; id++) {
    if (!inner[id]) continue
    total += areas[id]!
    if (areas[id]! >= Math.max(4, largest * SPECK_SHARE)) shapes++
  }

  const figure = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) figure[i] = labels[i] === best ? 1 : 0
  // Enclosed gaps: background regions that never reach the quadrant's edge.
  const gaps = label(figure, w, h, 0, false)
  const reachesEdge = new Uint8Array(gaps.areas.length)
  for (let x = 0; x < w; x++) {
    reachesEdge[gaps.labels[x]!] = 1
    reachesEdge[gaps.labels[(h - 1) * w + x]!] = 1
  }
  for (let y = 0; y < h; y++) {
    reachesEdge[gaps.labels[y * w]!] = 1
    reachesEdge[gaps.labels[y * w + w - 1]!] = 1
  }
  let area = 0
  const bbox: PixelBox = { x0: w, y0: h, x1: 0, y1: 0 }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const gap = gaps.labels[i]!
      if (gap && !reachesEdge[gap] && gaps.areas[gap]! <= largest * HOLE_SHARE) figure[i] = 1
      if (!figure[i]) continue
      area++
      if (x < bbox.x0) bbox.x0 = x
      if (y < bbox.y0) bbox.y0 = y
      if (x + 1 > bbox.x1) bbox.x1 = x + 1
      if (y + 1 > bbox.y1) bbox.y1 = y + 1
    }
  }
  return { mask: { width: w, height: h, data: figure }, background, threshold, bbox, area, shapes, share: largest / total }
}

// ---------- validity ----------

const pct = (n: number) => `${Math.round(n * 100)}%`

// Why a quadrant cannot be trusted for an outline; empty when it can.
export function checkQuadrant(view: RefView, seg: QuadrantSegment): ReferenceReason[] {
  const { width: w, height: h } = seg.mask
  const reasons: ReferenceReason[] = []
  const fail = (code: ReasonCode, detail: string) => reasons.push({ view, code, detail })
  if (w < MIN_TILE || h < MIN_TILE) {
    fail('sheet_too_small', `the ${view} quadrant is ${w} × ${h} px; it needs at least ${MIN_TILE}`)
    return reasons
  }
  if (seg.background > BRIGHT_BACKGROUND) {
    fail('bright_background', `the ${view} quadrant's background is not dark (luma ${seg.background} of 255)`)
    return reasons
  }
  if (!seg.bbox) {
    fail('empty', `nothing stands out from the background in the ${view} quadrant`)
    return reasons
  }
  if (seg.shapes > 1) {
    fail('several_shapes', `${seg.shapes} separate shapes in the ${view} quadrant; the largest holds ${pct(seg.share)} of the foreground`)
  } else if (seg.share < MIN_SHARE) {
    fail('fragmented', `the ${view} figure holds only ${pct(seg.share)} of the foreground; the rest is scattered specks`)
  }
  const { x0, y0, x1, y1 } = seg.bbox
  const bw = x1 - x0
  const bh = y1 - y0
  const near = Math.max(1, Math.round(Math.min(w, h) * 0.004))
  const edges = [x0 < near && 'left', x1 > w - near && 'right', y0 < near && 'top', y1 > h - near && 'bottom'].filter(Boolean)
  if (edges.length) fail('touches_edge', `the ${view} figure runs into the ${edges.join(', ')} edge of its quadrant`)
  if (seg.area > 0.9 * w * h || (bw >= 0.98 * w && bh >= 0.98 * h)) {
    fail('fills_quadrant', `the ${view} figure covers ${pct(seg.area / (w * h))} of its quadrant`)
  } else if (Math.max(bw / w, bh / h) < 0.3 || seg.area < 0.015 * w * h) {
    fail('too_small', `the ${view} figure is ${bw} × ${bh} px in a ${w} × ${h} quadrant`)
  } else if (Math.min(bw, bh) < 0.08 * Math.max(bw, bh) || seg.area < 0.1 * bw * bh) {
    fail('sliver', `the ${view} figure is a sliver: ${bw} × ${bh} px with ${pct(seg.area / (bw * bh))} of that box filled`)
  }
  return reasons
}

// ---------- outline tracing ----------

// The outer boundary of the first shape met in reading order, walked along pixel edges with
// the shape on the right. Points are pixel corners (x to the right, y down), one per turn,
// closed, first point not repeated. Pixels touching only at a corner count as joined.
export function traceOutline(mask: Mask): Point2[] {
  const { width: w, height: h, data } = mask
  const start = data.indexOf(1)
  if (start < 0) return []
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] === 1
  const sx = start % w
  const sy = (start - sx) / w
  // 0 east, 1 south, 2 west, 3 north
  const DX = [1, 0, -1, 0]
  const DY = [0, 1, 0, -1]
  const points: Point2[] = [[sx, sy]]
  let x = sx
  let y = sy
  let dir = 0
  for (let guard = 4 * (w + 1) * (h + 1); guard > 0; guard--) {
    x += DX[dir]!
    y += DY[dir]!
    if (x === sx && y === sy) break
    // The two pixels ahead of this corner, to the left and right of the heading.
    const lx = dir === 0 || dir === 1 ? x : x - 1
    const ly = dir === 1 || dir === 2 ? y : y - 1
    const rx = dir === 0 || dir === 3 ? x : x - 1
    const ry = dir === 0 || dir === 1 ? y : y - 1
    const next = at(lx, ly) ? (dir + 3) % 4 : at(rx, ry) ? dir : (dir + 1) % 4
    if (next !== dir) points.push([x, y])
    dir = next
  }
  return points
}

function farthest(points: Point2[], from: number): number {
  let best = from
  let bestD = -1
  for (let i = 0; i < points.length; i++) {
    const dx = points[i]![0] - points[from]![0]
    const dy = points[i]![1] - points[from]![1]
    if (dx * dx + dy * dy > bestD) {
      bestD = dx * dx + dy * dy
      best = i
    }
  }
  return best
}

// Douglas–Peucker on a closed ring: drops points that sit within `tolerance` of the line
// between the points kept either side of them.
export function simplifyOutline(points: Point2[], tolerance: number): Point2[] {
  const n = points.length
  if (n < 4 || tolerance <= 0) return points.slice()
  const a = farthest(points, 0)
  const b = farthest(points, a)
  const keep = new Uint8Array(n)
  keep[a] = 1
  keep[b] = 1
  // Spans are index ranges walked forward around the ring; `to` may run past n.
  const spans: [number, number][] = a < b ? [[a, b], [b, a + n]] : [[b, a], [a, b + n]]
  while (spans.length) {
    const [from, to] = spans.pop()!
    const p = points[from % n]!
    const q = points[to % n]!
    const ux = q[0] - p[0]
    const uy = q[1] - p[1]
    const len = Math.sqrt(ux * ux + uy * uy)
    let worst = -1
    let worstD = tolerance
    for (let i = from + 1; i < to; i++) {
      const r = points[i % n]!
      const d = len > 0
        ? Math.abs(ux * (r[1] - p[1]) - uy * (r[0] - p[0])) / len
        : Math.sqrt((r[0] - p[0]) ** 2 + (r[1] - p[1]) ** 2)
      if (d > worstD) {
        worstD = d
        worst = i
      }
    }
    if (worst < 0) continue
    keep[worst % n] = 1
    spans.push([from, worst], [worst, to])
  }
  return points.filter((_, i) => keep[i])
}

// ---------- scaling to the block ----------

function faceWidth(view: RefView, block: BlockSize): number {
  return view === 'front' || view === 'back' ? block.width : block.depth
}

// Views whose image runs against their block axis: +X is on the left of `back`, +Z on the
// left of `right`.
const MIRRORED: Record<RefView, boolean> = { front: false, left: false, back: true, right: true }

// One cm-per-pixel factor per view, chosen so every figure stands the same height in block cm:
// the tallest height at which each view's figure still fits its face of the block with the
// inset kept clear at the sides and top.
export function fitScales(boxes: PixelBox[], views: RefView[], block: BlockSize, insetCm: number): number[] {
  let height = block.height - insetCm
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!
    height = Math.min(height, (faceWidth(views[i]!, block) - 2 * insetCm) * (b.y1 - b.y0) / (b.x1 - b.x0))
  }
  return boxes.map(b => height / (b.y1 - b.y0))
}

// A quadrant's figure as a block-aligned mask: standing on the base, bounding box centred.
export function blockMask(seg: QuadrantSegment, view: RefView, scaleCmPerPx: number, opts: ReferenceOptions = {}): Mask {
  const block = opts.block ?? REFERENCE_BLOCK
  const cell = opts.cellCm ?? 0.4
  const face = faceWidth(view, block)
  const width = Math.round(face / cell)
  const height = Math.round(block.height / cell)
  const data = new Uint8Array(width * height)
  const box = seg.bbox
  if (!box) return { width, height, data }
  const src = seg.mask
  const centre = (box.x0 + box.x1) / 2
  for (let row = 0; row < height; row++) {
    const py = Math.floor(box.y1 - (block.height - (row + 0.5) * cell) / scaleCmPerPx)
    if (py < box.y0 || py >= box.y1) continue
    for (let col = 0; col < width; col++) {
      const px = Math.floor(centre + ((col + 0.5) * cell - face / 2) / scaleCmPerPx)
      if (px >= box.x0 && px < box.x1) data[row * width + col] = src.data[py * src.width + px]!
    }
  }
  return { width, height, data }
}

// A quadrant's picture on the same footing as its block mask: the whole face of the block,
// `pxPerCm` pixels to the centimetre, the figure standing on the base with its bounding box
// centred. Nearest-pixel sampling; whatever falls outside the quadrant is black.
export function blockTile(tile: Rgba, seg: QuadrantSegment, view: RefView, scaleCmPerPx: number, opts: ReferenceOptions = {}, pxPerCm = 4): Rgba {
  const block = opts.block ?? REFERENCE_BLOCK
  const face = faceWidth(view, block)
  const width = Math.round(face * pxPerCm)
  const height = Math.round(block.height * pxPerCm)
  const data = new Uint8Array(width * height * 4)
  for (let i = 3; i < data.length; i += 4) data[i] = 255
  const box = seg.bbox
  if (!box) return { width, height, data }
  const centre = (box.x0 + box.x1) / 2
  for (let row = 0; row < height; row++) {
    const py = Math.floor(box.y1 - (block.height - (row + 0.5) / pxPerCm) / scaleCmPerPx)
    if (py < 0 || py >= tile.height) continue
    for (let col = 0; col < width; col++) {
      const px = Math.floor(centre + ((col + 0.5) / pxPerCm - face / 2) / scaleCmPerPx)
      if (px < 0 || px >= tile.width) continue
      const from = (py * tile.width + px) * 4
      const to = (row * width + col) * 4
      data[to] = tile.data[from]!
      data[to + 1] = tile.data[from + 1]!
      data[to + 2] = tile.data[from + 2]!
    }
  }
  return { width, height, data }
}

function blockOutline(seg: QuadrantSegment, view: RefView, scaleCmPerPx: number, tolerance: number): Point2[] {
  const box = seg.bbox
  if (!box) return []
  const centre = (box.x0 + box.x1) / 2
  const sign = MIRRORED[view] ? -1 : 1
  const cm = traceOutline(seg.mask).map(([x, y]): Point2 => [sign * (x - centre) * scaleCmPerPx, (box.y1 - y) * scaleCmPerPx])
  return simplifyOutline(cm, tolerance)
}

// ---------- consistency ----------

function rowWidths(mask: Mask): Uint32Array {
  const widths = new Uint32Array(mask.height)
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i]) widths[(i - i % mask.width) / mask.width]!++
  }
  return widths
}

// How well two opposite views agree once the second is mirrored. They are the same silhouette
// seen from either side, so a perfect sheet scores 1 on both numbers.
export function pairAgreement(a: Mask, b: Mask): PairAgreement {
  if (a.width !== b.width || a.height !== b.height) return { iou: 0, profile: 0 }
  let both = 0
  let either = 0
  for (let row = 0; row < a.height; row++) {
    for (let col = 0; col < a.width; col++) {
      const p = a.data[row * a.width + col]!
      const q = b.data[row * a.width + a.width - 1 - col]!
      if (p && q) both++
      if (p || q) either++
    }
  }
  const wa = rowWidths(a)
  const wb = rowWidths(b)
  let differ = 0
  let widest = 0
  for (let row = 0; row < a.height; row++) {
    differ += Math.abs(wa[row]! - wb[row]!)
    widest += Math.max(wa[row]!, wb[row]!)
  }
  return { iou: either ? both / either : 0, profile: widest ? 1 - differ / widest : 0 }
}

// ---------- the one call ----------

function byView<T>(make: (view: RefView) => T): Record<RefView, T> {
  return { front: make('front'), left: make('left'), back: make('back'), right: make('right') }
}

export function analyzeReference(sheet: Rgba, opts: ReferenceOptions = {}): ReferenceAnalysis {
  const block = opts.block ?? REFERENCE_BLOCK
  const inset = opts.insetCm ?? 2
  const tiles = splitQuadrants(sheet)
  const quadrants = byView(view => segmentQuadrant(tiles[view]))
  const reasons: ReferenceReason[] = []
  const tile = tiles.front
  if (tile.width < MIN_TILE || tile.height < MIN_TILE) {
    reasons.push({ view: 'sheet', code: 'sheet_too_small', detail: `the sheet is ${sheet.width} × ${sheet.height} px; each quadrant needs at least ${MIN_TILE} px a side` })
  } else {
    for (const view of REF_VIEWS) reasons.push(...checkQuadrant(view, quadrants[view]))
  }
  if (reasons.length) {
    return { ok: false, reasons, tiles, aligned: null, quadrants, masks: null, outlines: null, scaleCmPerPx: 0, scales: null, consistency: null }
  }

  const views = REF_VIEWS.slice()
  const fitted = fitScales(views.map(view => quadrants[view].bbox!), views, block, inset)
  const scales = byView(view => fitted[views.indexOf(view)]!)
  const scaleCmPerPx = Math.min(...fitted)
  const masks = byView(view => blockMask(quadrants[view], view, scales[view], opts))
  const aligned = byView(view => blockTile(tiles[view], quadrants[view], view, scales[view], opts))
  // A one-pixel staircase strays 0.71 px from the slope it stands for; the tolerance has to
  // clear that or every stair survives.
  const outlines = byView(view => blockOutline(quadrants[view], view, scales[view], Math.max(opts.simplifyCm ?? 0.15, 0.75 * scales[view])))

  const heightsCm = byView((view) => {
    const box = quadrants[view].bbox!
    return (box.y1 - box.y0) * scaleCmPerPx
  })
  const heights = REF_VIEWS.map(view => heightsCm[view])
  const heightSpread = 1 - Math.min(...heights) / Math.max(...heights)
  const frontBack = pairAgreement(masks.front, masks.back)
  const leftRight = pairAgreement(masks.left, masks.right)
  const score = Math.min(1 - heightSpread, frontBack.iou, frontBack.profile, leftRight.iou, leftRight.profile)
  return { ok: true, reasons, tiles, aligned, quadrants, masks, outlines, scaleCmPerPx, scales, consistency: { heightsCm, heightSpread, frontBack, leftRight, score } }
}
