import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { decodePng } from '../bench/png.ts'
import {
  REFERENCE_BRIEF_INSTRUCTIONS,
  REFERENCE_QUADRANTS,
  REF_VIEWS,
  analyzeReference,
  referenceBriefPrompt,
  referenceImagePrompt,
  segmentQuadrant,
  checkQuadrant,
  simplifyOutline,
  splitQuadrants,
  traceOutline
} from '../shared/agent/reference.ts'
import type { Mask, Point2, RefView, ReferenceAnalysis, Rgba } from '../shared/agent/reference.ts'
import { BUST_PNG, renderSheet, truthHeightCm, truthMask } from './fixtures/referenceSheet.ts'

const bust = decodePng(readFileSync(BUST_PNG))
const analysis = analyzeReference(bust)

function iou(a: Mask, b: Mask): number {
  assert.equal(a.data.length, b.data.length)
  let both = 0
  let either = 0
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] && b.data[i]) both++
    if (a.data[i] || b.data[i]) either++
  }
  return both / either
}

// Rows and columns that hold any of the figure, as [first, last].
function span(mask: Mask) {
  let r0 = mask.height
  let r1 = -1
  let c0 = mask.width
  let c1 = -1
  for (let i = 0; i < mask.data.length; i++) {
    if (!mask.data[i]) continue
    const c = i % mask.width
    const r = (i - c) / mask.width
    r0 = Math.min(r0, r)
    r1 = Math.max(r1, r)
    c0 = Math.min(c0, c)
    c1 = Math.max(c1, c)
  }
  return { r0, r1, c0, c1 }
}

function shoelace(points: Point2[]): number {
  let twice = 0
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]!
    const [x1, y1] = points[(i + 1) % points.length]!
    twice += x0 * y1 - x1 * y0
  }
  return Math.abs(twice) / 2
}

function paint(sheet: Rgba, grey: number, inside: (x: number, y: number) => boolean) {
  for (let y = 0; y < sheet.height; y++) {
    for (let x = 0; x < sheet.width; x++) {
      if (inside(x, y)) sheet.data.fill(grey, (y * sheet.width + x) * 4, (y * sheet.width + x) * 4 + 3)
    }
  }
}

const codes = (a: ReferenceAnalysis) => a.reasons.map(r => `${r.view}:${r.code}`)

function assertUnusable(a: ReferenceAnalysis) {
  assert.equal(a.ok, false)
  assert.equal(a.masks, null)
  assert.equal(a.outlines, null)
  assert.equal(a.consistency, null)
  assert.equal(a.scaleCmPerPx, 0)
  // The picture is still there to look at.
  assert.equal(a.tiles.front.width, 256)
}

test('prompts: the image prompt carries the brief and states the layout the code splits by', () => {
  const brief = 'A seated cat, loaf-shaped,\n  facing forward on a low plinth.'
  const prompt = referenceImagePrompt(brief)
  assert.ok(prompt.includes('A seated cat, loaf-shaped, facing forward on a low plinth.'))
  for (const view of REF_VIEWS) {
    const q = REFERENCE_QUADRANTS[view]
    const place = `${q.row ? 'Bottom' : 'Top'}-${q.col ? 'right' : 'left'} quadrant: ${view.toUpperCase()} view`
    assert.ok(prompt.includes(place), place)
  }
  // The app's `left` camera sits on −X looking along +X: the figure's own right side, front to the right.
  assert.match(prompt, /LEFT view\.[^\n]*your own left[^\n]*model's own right-hand side[^\n]*toward the right edge/)
  assert.match(prompt, /RIGHT view\.[^\n]*your own right[^\n]*model's own left-hand side[^\n]*toward the left edge/)
  for (const rule of ['pure black', 'matte', 'Orthographic', 'No perspective', 'same height', 'base', 'No text']) {
    assert.ok(prompt.includes(rule), rule)
  }
  assert.ok(referenceImagePrompt('x'.repeat(5000)).length < prompt.length + 1600)

  assert.ok(referenceBriefPrompt('  a chess pawn ').includes('The commission: a chess pawn\n'))
  assert.match(REFERENCE_BRIEF_INSTRUCTIONS, /60 cm wide, 60 cm deep and 100 cm tall/)
  assert.match(REFERENCE_BRIEF_INSTRUCTIONS, /base/)
})

test('split: four tiles keyed front, left, back, right in reading order', () => {
  const sheet: Rgba = { width: 6, height: 4, data: new Uint8Array(6 * 4 * 4) }
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 6; x++) sheet.data.set([x, y, (y < 2 ? 0 : 2) + (x < 3 ? 0 : 1), 255], (y * 6 + x) * 4)
  }
  const tiles = splitQuadrants(sheet)
  const order: RefView[] = ['front', 'left', 'back', 'right']
  order.forEach((view, k) => {
    const tile = tiles[view]
    assert.deepEqual([tile.width, tile.height, tile.data.length], [3, 2, 24])
    for (let i = 0; i < 6; i++) assert.equal(tile.data[i * 4 + 2], k, view)
  })
  // Pixels keep their place inside the tile.
  assert.deepEqual([...tiles.right.data.subarray(0, 4)], [3, 2, 3, 255])
  assert.deepEqual([...tiles.right.data.subarray(20, 24)], [5, 3, 3, 255])

  // Odd size: the middle row and column are dropped, not smeared into a tile.
  const odd: Rgba = { width: 5, height: 5, data: new Uint8Array(100) }
  for (let i = 0; i < 25; i++) odd.data[i * 4] = i
  const t = splitQuadrants(odd)
  assert.deepEqual([...t.front.data].filter((_, i) => i % 4 === 0), [0, 1, 5, 6])
  assert.deepEqual([...t.right.data].filter((_, i) => i % 4 === 0), [18, 19, 23, 24])
  assert.throws(() => splitQuadrants({ width: 4, height: 4, data: new Uint8Array(8) }))
})

test('fixture: the committed PNG is what the generator draws', () => {
  const drawn = renderSheet()
  assert.equal(bust.width, 512)
  assert.equal(bust.height, 512)
  assert.deepEqual(bust.data, drawn.data)
})

test('bust: every quadrant passes and its mask matches the shape it was drawn from', () => {
  assert.equal(analysis.ok, true)
  assert.deepEqual(analysis.reasons, [])
  for (const view of REF_VIEWS) {
    const q = analysis.quadrants[view]
    assert.equal(q.shapes, 1)
    assert.ok(q.share > 0.999)
    // The backdrop is not zero and neither is the noise; the threshold clears both.
    assert.ok(q.background > 5 && q.background < 25, `${view} background ${q.background}`)
    const mask = analysis.masks![view]
    assert.deepEqual([mask.width, mask.height], [150, 250])
    const agreement = iou(mask, truthMask(view))
    assert.ok(agreement > 0.96, `${view} IoU ${agreement}`)
  }
})

test('bust: one scale for all views, standing on the base, inside the inset', () => {
  const masks = analysis.masks!
  const scale = analysis.scaleCmPerPx
  const front = span(masks.front)
  const left = span(masks.left)
  // Standing on the base: the bottom row of cells holds stone.
  for (const view of REF_VIEWS) assert.equal(span(masks[view]).r1, 249, view)
  // Same factor, so the same height in both.
  assert.ok(Math.abs(front.r0 - left.r0) <= 1)
  const heightCm = (250 - front.r0) * 0.4
  assert.ok(Math.abs(heightCm - truthHeightCm()) < 1, `height ${heightCm} cm`)
  for (const view of REF_VIEWS) {
    const box = analysis.quadrants[view].bbox!
    const s = span(masks[view])
    assert.ok(Math.abs((s.c1 - s.c0 + 1) * 0.4 / (box.x1 - box.x0) - scale) < 0.02 * scale, `${view} width scale`)
    assert.ok(Math.abs((s.r1 - s.r0 + 1) * 0.4 / (box.y1 - box.y0) - scale) < 0.02 * scale, `${view} height scale`)
    assert.ok(Math.abs(analysis.consistency!.heightsCm[view] - (box.y1 - box.y0) * scale) < 1e-9)
    // 2 cm clear at the sides and top (5 cells), centred within a cell.
    assert.ok(s.c0 >= 5 && s.c1 <= 144 && s.r0 >= 5, `${view} inset`)
    assert.ok(Math.abs(s.c0 - (149 - s.c1)) <= 1, `${view} centred`)
  }
  // The bust is wider than it is deep, so its width is what fills the block.
  assert.ok(front.c0 <= 6)
  assert.ok(left.c0 > 20)
})

test('bust: views keep their handedness', () => {
  const masks = analysis.masks!
  // Head rows only. The nose is on the figure's front (+Z): it reaches toward image-right
  // in `left` and image-left in `right`.
  const reach = (mask: Mask) => {
    let c0 = mask.width
    let c1 = -1
    for (let row = 40; row < 90; row++) {
      for (let col = 0; col < mask.width; col++) {
        if (!mask.data[row * mask.width + col]) continue
        c0 = Math.min(c0, col)
        c1 = Math.max(c1, col)
      }
    }
    return c1 - (mask.width - 1) / 2 - ((mask.width - 1) / 2 - c0)
  }
  assert.ok(reach(masks.left) >= 4, `left reaches ${reach(masks.left)}`)
  assert.ok(reach(masks.right) <= -4, `right reaches ${reach(masks.right)}`)
  assert.ok(Math.abs(reach(masks.front)) <= 1 && Math.abs(reach(masks.back)) <= 1)
  // Outlines are in block coordinates, where the nose is at +Z from either side.
  for (const view of ['left', 'right'] as const) {
    const head = analysis.outlines![view].filter(p => p[1] > 60)
    const far = (sign: number) => Math.max(...head.map(p => sign * p[0]))
    assert.ok(far(1) > far(-1) + 1, `${view} outline: +Z ${far(1)}, −Z ${far(-1)}`)
  }
})

test('bust: opposite views agree once mirrored', () => {
  const c = analysis.consistency!
  assert.ok(c.heightSpread < 0.01)
  assert.ok(c.frontBack.iou > 0.97 && c.frontBack.profile > 0.98, JSON.stringify(c.frontBack))
  assert.ok(c.leftRight.iou > 0.95 && c.leftRight.profile > 0.97, JSON.stringify(c.leftRight))
  assert.ok(c.score > 0.95 && c.score <= 1)

  // A sheet whose back view was drawn narrower scores lower but is not rejected.
  const stretched = renderSheet({ noise: 0 })
  const back = REFERENCE_QUADRANTS.back
  const copy = stretched.data.slice()
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const from = Math.round(128 + (x - 128) / 0.75)
      const at = ((back.row * 256 + y) * 512 + back.col * 256 + x) * 4
      const src = ((back.row * 256 + y) * 512 + back.col * 256 + Math.min(255, Math.max(0, from))) * 4
      stretched.data.set(copy.subarray(src, src + 4), at)
    }
  }
  const off = analyzeReference(stretched)
  assert.equal(off.ok, true)
  assert.ok(off.consistency!.frontBack.profile < 0.85, JSON.stringify(off.consistency!.frontBack))
  assert.ok(off.consistency!.leftRight.profile > 0.97)
  assert.ok(off.consistency!.score < 0.85)
})

test('bust: outlines are closed rings around the mask, in block centimetres', () => {
  for (const view of REF_VIEWS) {
    const ring = analysis.outlines![view]
    const mask = analysis.masks![view]
    assert.ok(ring.length > 20 && ring.length < 250, `${view} has ${ring.length} points`)
    assert.notDeepEqual(ring[0], ring[ring.length - 1])
    const cells = mask.data.reduce((n, v) => n + v, 0)
    const area = shoelace(ring)
    assert.ok(Math.abs(area - cells * 0.16) < 0.02 * area, `${view} outline ${area} cm², mask ${cells * 0.16} cm²`)
    const ys = ring.map(p => p[1])
    const hs = ring.map(p => p[0])
    assert.equal(Math.min(...ys), 0)
    assert.ok(Math.max(...ys) <= 98 + 1e-9)
    assert.ok(Math.min(...hs) >= -28 - 1e-9 && Math.max(...hs) <= 28 + 1e-9)
  }
})

test('trace: walks pixel edges, joins diagonal neighbours, simplifies without losing corners', () => {
  const mask = (rows: string[]): Mask => ({
    width: rows[0]!.length,
    height: rows.length,
    data: Uint8Array.from(rows.join(''), ch => ch === '#' ? 1 : 0)
  })
  assert.deepEqual(traceOutline(mask(['....', '.##.', '.##.', '....'])), [[1, 1], [3, 1], [3, 3], [1, 3]])
  const ell = traceOutline(mask(['#.', '##']))
  assert.deepEqual(ell, [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2], [0, 2]])
  const diagonal = traceOutline(mask(['#.', '.#']))
  assert.equal(diagonal.length, 8)
  assert.equal(shoelace(diagonal), 2)
  assert.deepEqual(traceOutline(mask(['..', '..'])), [])

  // A 40 × 20 rectangle with a point every unit along its edges comes back as its four corners.
  const dense: Point2[] = []
  for (let x = 0; x < 40; x++) dense.push([x, 0])
  for (let y = 0; y < 20; y++) dense.push([40, y])
  for (let x = 40; x > 0; x--) dense.push([x, 20])
  for (let y = 20; y > 0; y--) dense.push([0, y])
  const corners = simplifyOutline(dense, 0.1)
  assert.equal(corners.length, 4)
  assert.equal(shoelace(corners), 800)
})

test('bad sheet: an empty quadrant', () => {
  const a = analyzeReference(renderSheet({ skip: ['back'] }))
  assertUnusable(a)
  assert.deepEqual(codes(a), ['back:empty'])
  assert.match(a.reasons[0]!.detail, /back/)
})

test('bad sheet: two separate shapes in a quadrant', () => {
  const sheet = renderSheet()
  // A loose ball beside the head in the left view (top-right quadrant).
  paint(sheet, 150, (x, y) => (x - 300) ** 2 + (y - 60) ** 2 < 18 ** 2)
  const a = analyzeReference(sheet)
  assertUnusable(a)
  assert.deepEqual(codes(a), ['left:several_shapes'])
  assert.equal(a.quadrants.left.shapes, 2)
  assert.ok(a.quadrants.left.share > 0.85 && a.quadrants.left.share < 0.97)
})

test('bad sheet: a figure running off its quadrant', () => {
  const a = analyzeReference(renderSheet({ shift: { front: [-80, 0] } }))
  assertUnusable(a)
  assert.deepEqual(codes(a), ['front:touches_edge'])
  assert.match(a.reasons[0]!.detail, /left edge/)

  const b = analyzeReference(renderSheet({ shift: { right: [0, 40] } }))
  assert.deepEqual(codes(b), ['right:touches_edge'])
  assert.match(b.reasons[0]!.detail, /bottom edge/)
})

test('bad sheet: a white background', () => {
  const a = analyzeReference(renderSheet({ background: 238, clay: 150 }))
  assertUnusable(a)
  assert.deepEqual(codes(a), REF_VIEWS.map(view => `${view}:bright_background`))
})

test('bad sheet: figures that are tiny, fill the quadrant, or are slivers; sheets too small to use', () => {
  assert.deepEqual(codes(analyzeReference(renderSheet({ fill: 0.2 }))), REF_VIEWS.map(view => `${view}:too_small`))

  const tile = (inside: (x: number, y: number) => boolean) => {
    const t: Rgba = { width: 200, height: 200, data: new Uint8Array(200 * 200 * 4).fill(255) }
    paint(t, 6, () => true)
    paint(t, 160, inside)
    return checkQuadrant('front', segmentQuadrant(t)).map(r => r.code)
  }
  // A disc edge to edge: the corners are still black, but nothing is left of the margin.
  assert.deepEqual(tile((x, y) => (x - 99.5) ** 2 + (y - 99.5) ** 2 < 100 ** 2), ['touches_edge', 'fills_quadrant'])
  assert.deepEqual(tile((x, y) => Math.abs(x - 100) < 4 && y > 20 && y < 180), ['sliver'])
  assert.deepEqual(tile((x, y) => Math.abs(x - 100) < 30 && y > 20 && y < 180), [])

  const small = analyzeReference(renderSheet({ size: 64 }))
  assert.deepEqual(codes(small), ['sheet:sheet_too_small'])
})

test('robust: grey backdrop, heavy noise, frame and divider lines', () => {
  const noisy = analyzeReference(renderSheet({ background: 34, noise: 9, seed: 3 }))
  assert.deepEqual(noisy.reasons, [])
  for (const view of REF_VIEWS) {
    const agreement = iou(noisy.masks![view], truthMask(view))
    assert.ok(agreement > 0.95, `${view} IoU ${agreement} on a noisy sheet`)
  }

  const framed = renderSheet()
  paint(framed, 130, (x, y) => x < 3 || y < 3 || x >= 509 || y >= 509 || Math.abs(x - 255.5) < 1.5 || Math.abs(y - 255.5) < 1.5)
  const a = analyzeReference(framed)
  assert.deepEqual(a.reasons, [])
  for (const view of REF_VIEWS) assert.ok(iou(a.masks![view], truthMask(view)) > 0.96, view)

  // Shading dark enough to punch a small hole in the threshold is filled; specks are dropped.
  const pitted = renderSheet()
  paint(pitted, 12, (x, y) => (x - 128) ** 2 + (y - 160) ** 2 < 5 ** 2)
  paint(pitted, 150, (x, y) => (x - 30) ** 2 + (y - 40) ** 2 < 3 ** 2)
  const b = analyzeReference(pitted)
  assert.deepEqual(b.reasons, [])
  assert.ok(iou(b.masks!.front, analysis.masks!.front) > 0.995)
})

test('options: block size, cell size and inset', () => {
  const block = { width: 50, height: 80, depth: 30 }
  const a = analyzeReference(bust, { block, cellCm: 1, insetCm: 5 })
  assert.equal(a.ok, true)
  assert.deepEqual([a.masks!.front.width, a.masks!.front.height], [50, 80])
  assert.deepEqual([a.masks!.left.width, a.masks!.right.width, a.masks!.back.width], [30, 30, 50])
  for (const view of REF_VIEWS) {
    const s = span(a.masks![view])
    const w = a.masks![view].width
    assert.ok(s.c0 >= 5 && s.c1 <= w - 6 && s.r0 >= 5, `${view} inset`)
    assert.equal(s.r1, 79)
    assert.ok(iou(a.masks![view], truthMask(view, { block, cellCm: 1, insetCm: 5 })) > 0.92, view)
  }
  // Depth is the tight side of this block: the left view spans it, the front does not.
  assert.ok(span(a.masks!.left).c0 <= 6)
  assert.ok(span(a.masks!.front).c0 > 6)
})

test('deterministic, and the sheet is left alone', () => {
  const before = bust.data.slice()
  const again = analyzeReference(bust)
  assert.deepEqual(bust.data, before)
  assert.deepEqual(again.masks, analysis.masks)
  assert.deepEqual(again.outlines, analysis.outlines)
  assert.deepEqual(again.consistency, analysis.consistency)
  assert.equal(again.scaleCmPerPx, analysis.scaleCmPerPx)
  // The same pixels as a canvas would hand them over.
  const clamped = analyzeReference({ width: bust.width, height: bust.height, data: new Uint8ClampedArray(bust.data) })
  assert.deepEqual(clamped.masks, analysis.masks)
})

test('views drawn to different heights are brought to one height in the block', () => {
  // The left view redrawn 6% smaller about the middle of its base, as an image model might.
  const sheet = renderSheet({ noise: 0 })
  const q = REFERENCE_QUADRANTS.left
  const copy = sheet.data.slice()
  const k = 0.94
  const base = 256 - 0.1 * 256
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const sx = Math.round(128 + (x - 128) / k)
      const sy = Math.round(base + (y - base) / k)
      const at = ((q.row * 256 + y) * 512 + q.col * 256 + x) * 4
      if (sx < 0 || sx > 255 || sy < 0 || sy > 255) {
        sheet.data.set([10, 10, 10, 255], at)
        continue
      }
      const from = ((q.row * 256 + sy) * 512 + q.col * 256 + sx) * 4
      sheet.data.set(copy.subarray(from, from + 4), at)
    }
  }
  const a = analyzeReference(sheet)
  assert.equal(a.ok, true)
  // The difference is still reported...
  assert.ok(a.consistency!.heightSpread > 0.04 && a.consistency!.heightSpread < 0.08, `spread ${a.consistency!.heightSpread}`)
  assert.ok(a.scales!.left > a.scales!.front * 1.04)
  assert.equal(a.scaleCmPerPx, Math.min(...REF_VIEWS.map(v => a.scales![v])))
  // ...but the masks stand the same height, so front ∩ left does not shave the top.
  const tops = REF_VIEWS.map(v => span(a.masks![v]).r0)
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 1, `top rows ${tops.join(', ')}`)
  for (const v of REF_VIEWS) assert.equal(span(a.masks![v]).r1, 249, v)
  // The tiles a look shows beside the stone are on the block's faces, in step with the masks.
  assert.deepEqual([a.aligned!.left.width, a.aligned!.left.height], [240, 400])
  const lit = (row: number) => {
    for (let col = 0; col < 240; col++) if (a.aligned!.left.data[(row * 240 + col) * 4]! > 80) return true
    return false
  }
  const top = Math.round(tops[1]! * 400 / 250)
  assert.ok(!lit(top - 6) && lit(top + 6), 'the aligned tile\'s figure starts where the mask does')
})
