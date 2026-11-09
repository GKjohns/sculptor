/**
 * The observer: which way every ruler runs, where stone lands in each view, the overlays,
 * the contact sheet's layout, and determinism.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodePng, encodePng } from '../bench/png.ts'
import { cloneGrid, createGrid } from '../shared/sculpt/grid.ts'
import { maskToBlock } from '../shared/sculpt/measure.ts'
import type { Mask } from '../shared/sculpt/measure.ts'
import { blockToPixel, layoutContactSheet, pixelToBlock, renderContactSheet, renderView } from '../shared/sculpt/observer.ts'
import type { Image, TileLayout } from '../shared/sculpt/observer.ts'
import { applyStrike } from '../shared/sculpt/strike.ts'
import { AXIS_VIEWS, VIEW_IDS } from '../shared/sculpt/views.ts'
import type { AxisView, ViewId } from '../shared/sculpt/views.ts'
import type { Grid, Vec3 } from '../shared/sculpt/types.ts'

function saw(grid: Grid, point: Vec3, normal: Vec3): void {
  applyStrike(grid, { kind: 'saw', plane: { point, normal }, ms: 500 })
}

// The default block sawn down to a post: x 10..20, z 6..14, y 0..80. Off-centre on every
// axis, so each view has to put it on the correct side. Its faces fall between samples.
function post(): Grid {
  const grid = createGrid()
  saw(grid, [20, 0, 0], [1, 0, 0])
  saw(grid, [10, 0, 0], [-1, 0, 0])
  saw(grid, [0, 0, 14], [0, 0, 1])
  saw(grid, [0, 0, 6], [0, 0, -1])
  saw(grid, [0, 80, 0], [0, 1, 0])
  return grid
}

function rgb(img: Image, x: number, y: number): [number, number, number] {
  const i = (Math.floor(x) + Math.floor(y) * img.width) * 4
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!]
}

// Clay is light and slightly warm; the background and its grid lines are cool.
function isClay(img: Image, x: number, y: number): boolean {
  const [r, g, b] = rgb(img, x, y)
  return r > 100 && r >= b && Math.abs(r - g) < 12
}

function one(grid: Grid, view: ViewId, opts = {}): { img: Image, tile: TileLayout } {
  const img = renderContactSheet(grid, [view], opts)
  const tile = layoutContactSheet(grid, [view], opts).tiles[0]!
  return { img, tile }
}

// Centre of the clay pixels inside a tile's plot.
function clayCentre(img: Image, tile: TileLayout): { x: number, y: number, count: number } {
  let sx = 0
  let sy = 0
  let count = 0
  for (let y = tile.plot.y; y < tile.plot.y + tile.plot.height; y++) {
    for (let x = tile.plot.x; x < tile.plot.x + tile.plot.width; x++) {
      if (!isClay(img, x, y)) continue
      sx += x + 0.5
      sy += y + 0.5
      count++
    }
  }
  return { x: sx / count, y: sy / count, count }
}

// The post's centre in each axis view's two ruler coordinates.
const POST: Record<AxisView, [number, number]> = { front: [15, 40], back: [15, 40], right: [10, 40], left: [10, 40], top: [15, 10] }

test('every axis view puts an off-centre post on the side its ruler says', () => {
  const grid = post()
  // Which side of the plot's centre the post must fall on: +1 right or below, -1 left or above.
  const side: Record<AxisView, [number, number]> = { front: [1, 1], back: [-1, 1], right: [-1, 1], left: [1, 1], top: [1, 1] }
  for (const view of AXIS_VIEWS) {
    const { img, tile } = one(grid, view)
    const c = clayCentre(img, tile)
    assert.ok(c.count > 500, `${view}: the post is drawn`)
    const mx = tile.plot.x + tile.plot.width / 2
    const my = tile.plot.y + tile.plot.height / 2
    assert.ok((c.x - mx) * side[view][0] > 20, `${view}: horizontal side (${c.x - mx})`)
    assert.ok((c.y - my) * side[view][1] > 20, `${view}: vertical side (${c.y - my})`)
    // And the rulers agree with the picture: the post's centre in ruler coordinates maps
    // onto the centre of the pixels that were drawn.
    const [px, py] = blockToPixel(tile, ...POST[view])
    assert.ok(Math.abs(px - c.x) < 1.5 && Math.abs(py - c.y) < 1.5, `${view}: ruler ${px},${py} vs drawn ${c.x},${c.y}`)
    // Its mirror image across the centre line is empty.
    const [h, v] = POST[view]
    assert.equal(isClay(img, ...blockToPixel(tile, h + 1.3, v + 1.3)), true, `${view}: stone at the post`)
    assert.equal(isClay(img, ...blockToPixel(tile, -h - 1.3, v + 1.3)), false, `${view}: none at its mirror`)
  }
})

test('rulers run the way the view table says, in block coordinates', () => {
  const grid = createGrid()
  const tile = (view: ViewId) => layoutContactSheet(grid, [view]).tiles[0]!
  const dir = (view: ViewId) => {
    const r = tile(view).ruler!
    return [r.hAxis, Math.sign(r.hPerCm), r.vAxis, Math.sign(r.vPerCm)]
  }
  // +1 across: increasing to the right. -1 down: increasing upward.
  assert.deepEqual(dir('front'), ['X', 1, 'Y', -1])
  assert.deepEqual(dir('back'), ['X', -1, 'Y', -1])
  assert.deepEqual(dir('right'), ['Z', -1, 'Y', -1])
  assert.deepEqual(dir('left'), ['Z', 1, 'Y', -1])
  assert.deepEqual(dir('top'), ['X', 1, 'Z', 1])
  for (const view of AXIS_VIEWS) {
    const t = tile(view)
    // Every ruler value on the block falls inside the plot, and the mapping inverts.
    for (const [h, v] of [[-30, view === 'top' ? -30 : 0], [30, view === 'top' ? 30 : 100], [12.5, 7.5]] as const) {
      const [px, py] = blockToPixel(t, h, v)
      assert.ok(px >= t.plot.x && px <= t.plot.x + t.plot.width && py >= t.plot.y && py <= t.plot.y + t.plot.height, `${view} ${h},${v}`)
      const back = pixelToBlock(t, px, py)
      assert.ok(Math.abs(back[0] - h) < 1e-9 && Math.abs(back[1] - v) < 1e-9)
    }
  }
  // Three-quarter views are for looking only.
  for (const view of VIEW_IDS.filter(id => !(AXIS_VIEWS as string[]).includes(id))) {
    assert.equal(tile(view).ruler, undefined)
    assert.throws(() => blockToPixel(tile(view), 0, 0), /no rulers/)
  }
})

test('a chisel mark on the front face shows at its ruler position, and only in front', () => {
  const before = createGrid()
  const after = createGrid()
  applyStrike(after, { kind: 'cut', tool: 'flat', at: [20, 80, 30], dir: [0, 0, -1], size: 5, depth: 3, seed: 7, ms: 100 })
  const views: ViewId[] = ['front', 'back']
  const a = renderContactSheet(before, views)
  const b = renderContactSheet(after, views)
  const [front, back] = layoutContactSheet(before, views).tiles as [TileLayout, TileLayout]
  let sx = 0
  let sy = 0
  let count = 0
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (x + y * a.width) * 4
      if (a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2]) continue
      assert.ok(x < back.x, `only the front tile changes (pixel ${x},${y})`)
      sx += x + 0.5
      sy += y + 0.5
      count++
    }
  }
  assert.ok(count > 100, 'the mark is visible')
  const [h, v] = pixelToBlock(front, sx / count, sy / count)
  assert.ok(Math.abs(h - 20) < 1 && Math.abs(v - 80) < 1, `mark at X ${h}, Y ${v}`)
  // In the back view the same block X sits on the other side of the tile.
  assert.ok(blockToPixel(front, 20, 80)[0] > front.plot.x + front.plot.width / 2)
  assert.ok(blockToPixel(back, 20, 80)[0] < back.plot.x + back.plot.width / 2)
})

test('three-quarter views show the stone, lit from one side', () => {
  const grid = createGrid()
  for (const view of ['front_left', 'front_right', 'back_left', 'back_right'] as const) {
    const { img, tile } = one(grid, view)
    const cx = tile.plot.x + tile.plot.width / 2
    const cy = tile.plot.y + tile.plot.height / 2
    // The block's near vertical edge runs down the middle: the face to its left takes
    // the key light, the one to its right only the fill, and neither is black.
    const lit = rgb(img, cx - 60, cy)[0]
    const shaded = rgb(img, cx + 60, cy)[0]
    assert.ok(lit > shaded + 40, `${view}: ${lit} vs ${shaded}`)
    assert.ok(shaded > 60, `${view}: the shaded face is still readable (${shaded})`)
    assert.equal(isClay(img, tile.plot.x + 3, tile.plot.y + 3), false, `${view}: background in the corner`)
  }
})

test('a six-view sheet is one image of about 1500 px at one scale', () => {
  const grid = createGrid()
  const views: ViewId[] = ['front', 'back', 'right', 'left', 'top', 'front_left']
  const layout = layoutContactSheet(grid, views)
  const img = renderContactSheet(grid, views)
  assert.equal(img.width, layout.width)
  assert.equal(img.height, layout.height)
  assert.equal(img.data.length, img.width * img.height * 4)
  const long = Math.max(img.width, img.height)
  assert.ok(long >= 1000 && long <= 1568, `long side ${long}`)
  assert.equal(layout.tiles.length, 6)
  assert.deepEqual(layout.tiles.map(t => t.view), views)
  for (const t of layout.tiles) {
    assert.equal(t.pxPerCm, layout.pxPerCm)
    assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.width <= img.width && t.y + t.height <= img.height, `${t.view} fits`)
    if (t.ruler) assert.equal(Math.abs(t.ruler.hPerCm), layout.pxPerCm)
    for (const u of layout.tiles) {
      if (u === t) continue
      const apart = t.x + t.width <= u.x || u.x + u.width <= t.x || t.y + t.height <= u.y || u.y + u.height <= t.y
      assert.ok(apart, `${t.view} and ${u.view} do not overlap`)
    }
  }
  // Every pixel is opaque, and the PNG edge round-trips it.
  for (let i = 3; i < img.data.length; i += 4) assert.equal(img.data[i], 255)
  assert.deepEqual(decodePng(encodePng(img.data, img.width, img.height)).data, img.data)
  // Scale is a parameter, and a long side over the limit is scaled down to it.
  assert.equal(layoutContactSheet(grid, views, { pxPerCm: 3 }).pxPerCm, 3)
  const tight = layoutContactSheet(grid, views, { maxSide: 800 })
  assert.ok(Math.max(tight.width, tight.height) <= 800 && tight.pxPerCm < 5)
  assert.throws(() => renderContactSheet(grid, []), /at least one view/)
})

test('the same stone renders to the same bytes, whatever its finish', () => {
  const grid = post()
  applyStrike(grid, {
    kind: 'form', name: 'ball', blend: 0,
    shapes: [{ kind: 'ellipsoid', center: [15, 40, 10], size: [8, 60, 8], rotation: [0, 0, 0] }]
  })
  const views: ViewId[] = ['front', 'top', 'back_left']
  for (const overlay of ['grid', 'form'] as const) {
    const a = renderContactSheet(grid, views, { overlay })
    const b = renderContactSheet(grid, views, { overlay })
    assert.deepEqual(a.data, b.data, overlay)
    const copy = cloneGrid(grid)
    // Clay shading ignores the finish channel.
    copy.finish.fill(255)
    assert.deepEqual(renderContactSheet(copy, views, { overlay }).data, a.data, `${overlay}, polished copy`)
  }
  // A single view is the same tile the sheet shows.
  const tile = renderView(grid, 'front')
  const sheet = renderContactSheet(grid, ['front'])
  const at = layoutContactSheet(grid, ['front']).tiles[0]!
  assert.equal(tile.width, at.width)
  assert.equal(tile.height, at.height)
  for (const [x, y] of [[at.plot.width / 2 + 60, 200], [100, 300], [10, 10]] as const) {
    assert.deepEqual(rgb(tile, x, y), rgb(sheet, x + at.x, y + at.y))
  }
})

test('the form overlay tints stone to remove, marks stone that is gone, and draws the outline', () => {
  const grid = createGrid()
  applyStrike(grid, {
    kind: 'form', name: 'ball', blend: 0,
    shapes: [{ kind: 'ellipsoid', center: [0, 50, 0], size: [40, 40, 40], rotation: [0, 0, 0] }]
  })
  const outlineAt = (img: Image, tile: TileLayout, h: number, v: number): boolean => {
    const [px, py] = blockToPixel(tile, h, v)
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const [r, g, b] = rgb(img, px + dx, py + dy)
        if (r === 0 && g === 232 && b === 255) return true
      }
    }
    return false
  }
  const whole = one(grid, 'front', { overlay: 'form' })
  // The whole front face is 10 cm or more proud of the ball: red, not clay.
  const [r, , b] = rgb(whole.img, ...blockToPixel(whole.tile, 1.3, 51.3))
  assert.ok(r > 1.6 * b, `proud stone is tinted (${r}, ${b})`)
  assert.equal(isClay(whole.img, ...blockToPixel(whole.tile, 1.3, 51.3)), false)
  // The outline is the ball's silhouette: radius 20 about (0, 50).
  const k = 20 * Math.SQRT1_2
  assert.equal(outlineAt(whole.img, whole.tile, k, 50 + k), true)
  assert.equal(outlineAt(whole.img, whole.tile, -k, 50 - k), true)
  assert.equal(outlineAt(whole.img, whole.tile, 1.3, 51.3), false)
  assert.equal(outlineAt(whole.img, whole.tile, 26.3, 51.3), false)
  // Without the overlay the same face is plain clay.
  const plain = one(grid, 'front')
  assert.equal(isClay(plain.img, ...blockToPixel(plain.tile, 1.3, 51.3)), true)

  // Saw the block off at y = 55. Above the cut, inside the outline, the form has no stone.
  saw(grid, [0, 55, 0], [0, 1, 0])
  const cut = one(grid, 'front', { overlay: 'form' })
  const gone = rgb(cut.img, ...blockToPixel(cut.tile, 1.3, 61.3))
  const air = rgb(cut.img, ...blockToPixel(cut.tile, 26.3, 61.3))
  assert.ok(gone[2] > 100 && gone[2] > 1.5 * gone[0], `lost form is violet (${gone})`)
  assert.ok(air[2] < 80, `plain background outside the outline (${air})`)
  // From above, the sawn face cuts through the ball: stone inside the form reads blue.
  const top = one(grid, 'top', { overlay: 'form' })
  const inside = rgb(top.img, ...blockToPixel(top.tile, 1.3, 1.3))
  assert.ok(inside[2] > inside[0] + 40, `cut into the form (${inside})`)
  // Naming a form that is not declared leaves plain clay.
  const none = one(grid, 'top', { overlay: 'form', forms: ['nope'] })
  assert.equal(isClay(none.img, ...blockToPixel(none.tile, 1.3, 1.3)), true)
})

test('the reference overlay pairs side views with their tiles and outlines', () => {
  const grid = createGrid()
  const mask = (view: 'front' | 'left', inside: (h: number, v: number) => boolean): Mask => {
    const data = new Uint8Array(60 * 100)
    for (let i = 0; i < data.length; i++) {
      const [h, v] = maskToBlock(grid, view, 60, 100, i % 60, Math.floor(i / 60))
      if (inside(h, v)) data[i] = 1
    }
    return { width: 60, height: 100, data }
  }
  const picture = (width: number, height: number, grey: number) => {
    const data = new Uint8Array(width * height * 4).fill(grey)
    for (let i = 3; i < data.length; i += 4) data[i] = 255
    return { width, height, data }
  }
  const reference = {
    // front is block-aligned (3:5); left is a square quadrant.
    tiles: { front: picture(120, 200, 90), left: picture(128, 128, 90) },
    outlines: { front: mask('front', h => h < 0), left: mask('left', h => h > 10) }
  }
  const views: ViewId[] = ['front', 'left', 'top']
  const opts = { overlay: 'reference' as const, reference }
  const layout = layoutContactSheet(grid, views, opts)
  const img = renderContactSheet(grid, views, opts)
  assert.deepEqual(layout.tiles.map(t => `${t.kind} ${t.view}`), ['stone front', 'reference front', 'stone left', 'reference left', 'stone top'])
  const [front, refFront, left, refLeft] = layout.tiles as [TileLayout, TileLayout, TileLayout, TileLayout]
  // A reference tile sits beside its view, at the same scale.
  assert.equal(refFront.y, front.y)
  assert.ok(refFront.x >= front.x + front.width)
  assert.equal(refFront.plot.width, front.plot.width)
  // Only the block-aligned tile gets rulers, and they are the stone tile's rulers.
  assert.equal(refFront.ruler!.hPerCm, front.ruler!.hPerCm)
  assert.equal(refLeft.ruler, undefined)
  // The picture is drawn where the block face is.
  assert.deepEqual(rgb(img, ...blockToPixel(refFront, 11.3, 51.3)), [90, 90, 90])
  // Stone outside the outline is tinted; inside it is clay. Front: X < 0 is inside.
  assert.equal(isClay(img, ...blockToPixel(front, -11.3, 51.3)), true)
  const out = rgb(img, ...blockToPixel(front, 11.3, 51.3))
  assert.ok(out[0] > out[2] + 60, `outside the outline is orange (${out})`)
  // Left: Z > 10 is inside, and Z increases to the right in that view.
  assert.equal(isClay(img, ...blockToPixel(left, 21.3, 51.3)), true)
  assert.equal(isClay(img, ...blockToPixel(left, -1.3, 51.3)), false)
  assert.ok(blockToPixel(left, 21.3, 51.3)[0] > blockToPixel(left, -1.3, 51.3)[0])
  // Without tiles the outlines still draw, and the sheet has no reference tiles.
  const bare = layoutContactSheet(grid, views, { overlay: 'reference', reference: { outlines: reference.outlines } })
  assert.equal(bare.tiles.length, 3)
  // The same inputs in grid mode are ignored.
  assert.equal(layoutContactSheet(grid, views, { overlay: 'grid', reference }).tiles.length, 3)
})
