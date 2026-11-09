/**
 * Measurements: mass and bounds, the mask ↔ block mapping, silhouettes and their agreement
 * with an outline, and the stone against a declared form.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGrid } from '../shared/sculpt/grid.ts'
import { polish, rasp } from '../shared/sculpt/hand.ts'
import {
  blockToMask, maskCovers, maskToBlock, measureAll, measureSlice, proudOfForm, silhouetteAgreement, stoneBounds, stoneSilhouette, surfaceFinish
} from '../shared/sculpt/measure.ts'
import type { Mask } from '../shared/sculpt/measure.ts'
import { compileForm } from '../shared/sculpt/shapes.ts'
import { applyStrike } from '../shared/sculpt/strike.ts'
import { AXIS_VIEWS } from '../shared/sculpt/views.ts'
import type { AxisView } from '../shared/sculpt/views.ts'
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

// A mask of the given size with the pixels whose centres pass the test set.
function maskWhere(grid: Grid, view: AxisView, width: number, height: number, inside: (h: number, v: number) => boolean): Mask {
  const data = new Uint8Array(width * height)
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const [h, v] = maskToBlock(grid, view, width, height, col, row)
      if (inside(h, v)) data[col + row * width] = 1
    }
  }
  return { width, height, data }
}

function centroid(mask: Mask): { col: number, row: number, count: number } {
  let col = 0
  let row = 0
  let count = 0
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] !== 1) continue
    col += i % mask.width
    row += Math.floor(i / mask.width)
    count++
  }
  return { col: col / count, row: row / count, count }
}

const sphere = (radius: number, center: Vec3 = [0, 50, 0]) => compileForm({
  shapes: [{ kind: 'ellipsoid', center, size: [2 * radius, 2 * radius, 2 * radius], rotation: [0, 0, 0] }],
  blend: 0
})

test('the untouched block weighs about 975 kg and fills its box exactly', () => {
  const grid = createGrid()
  const m = measureAll(grid)
  assert.ok(Math.abs(m.mass_kg! - 975.6) < 0.11, `mass ${m.mass_kg}`)
  assert.equal(m.volume_cm3, 360000)
  assert.equal(m.removed_pct, 0)
  assert.deepEqual(
    [m.bbox_x_min_cm, m.bbox_x_max_cm, m.bbox_y_min_cm, m.bbox_y_max_cm, m.bbox_z_min_cm, m.bbox_z_max_cm],
    [-30, 30, 0, 100, -30, 30]
  )
  // Nothing declared and no outlines given: no form or silhouette keys.
  assert.deepEqual(Object.keys(m).filter(key => key.startsWith('form_') || key.startsWith('silhouette_')), [])
})

test('the bounding box follows the stone to a fraction of a voxel', () => {
  const grid = post()
  const box = stoneBounds(grid)
  assert.equal(box.empty, false)
  const want = [10, 0, 6, 20, 80, 14]
  const got = [...box.min, ...box.max]
  for (let n = 0; n < 6; n++) assert.ok(Math.abs(got[n]! - want[n]!) < 0.1, `side ${n}: ${got[n]} vs ${want[n]}`)
  const m = measureAll(grid)
  assert.ok(Math.abs(m.volume_cm3! - 6400) < 64, `volume ${m.volume_cm3}`)
  assert.ok(Math.abs(m.mass_kg! - 17.3) < 0.2, `mass ${m.mass_kg}`)
  // A plane at an odd height, off the voxel lattice.
  saw(grid, [0, 41.13, 0], [0, 1, 0])
  assert.ok(Math.abs(stoneBounds(grid).max[1] - 41.13) < 0.1, `top ${stoneBounds(grid).max[1]}`)
})

test('mask pixels map to block coordinates as each view shows them', () => {
  const grid = createGrid()
  // Top-left pixel of a 150 × 250 mask (0.4 cm pixels) in every view.
  assert.deepEqual(maskToBlock(grid, 'front', 150, 250, 0, 0).map(v => +v.toFixed(6)), [-29.8, 99.8])
  assert.deepEqual(maskToBlock(grid, 'back', 150, 250, 0, 0).map(v => +v.toFixed(6)), [29.8, 99.8])
  assert.deepEqual(maskToBlock(grid, 'left', 150, 250, 0, 0).map(v => +v.toFixed(6)), [-29.8, 99.8])
  assert.deepEqual(maskToBlock(grid, 'right', 150, 250, 0, 0).map(v => +v.toFixed(6)), [29.8, 99.8])
  assert.deepEqual(maskToBlock(grid, 'top', 150, 150, 0, 0).map(v => +v.toFixed(6)), [-29.8, -29.8])
  // Bottom-right pixel: the base, and the far end of the horizontal ruler.
  assert.deepEqual(maskToBlock(grid, 'back', 150, 250, 149, 249).map(v => +v.toFixed(6)), [-29.8, 0.2])
  for (const view of AXIS_VIEWS) {
    for (const [col, row] of [[0, 0], [37, 201], [59, 99]] as const) {
      const [h, v] = maskToBlock(grid, view, 60, 100, col, row)
      const back = blockToMask(grid, view, 60, 100, h, v)
      assert.ok(Math.abs(back[0] - col - 0.5) < 1e-9 && Math.abs(back[1] - row - 0.5) < 1e-9, `${view} ${col},${row}`)
    }
  }
  // A mask pushed through the block: the front mask ignores z, the left mask ignores x.
  const front = maskWhere(grid, 'front', 60, 100, (x, y) => x > 10 && y > 70)
  assert.equal(maskCovers(front, grid, 'front', 15, 75, -22), true)
  assert.equal(maskCovers(front, grid, 'front', 15, 75, 22), true)
  assert.equal(maskCovers(front, grid, 'front', -15, 75, 0), false)
  assert.equal(maskCovers(front, grid, 'front', 15, 65, 0), false)
  assert.equal(maskCovers(front, grid, 'front', 31, 75, 0), false)
  const left = maskWhere(grid, 'left', 60, 100, (z, y) => z > 10 && y > 70)
  assert.equal(maskCovers(left, grid, 'left', -20, 75, 15), true)
  assert.equal(maskCovers(left, grid, 'left', 20, 75, -15), false)
  // The same solid described from the other side.
  const right = maskWhere(grid, 'right', 60, 100, (z, y) => z > 10 && y > 70)
  assert.equal(maskCovers(right, grid, 'right', 0, 75, 15), true)
  assert.equal(right.data[0], 1, 'right: +Z is on the left of the image')
  assert.equal(left.data[0], 0, 'left: -Z is on the left of the image')
})

test('the untouched block fills every silhouette', () => {
  const grid = createGrid()
  for (const view of AXIS_VIEWS) {
    const mask = stoneSilhouette(grid, view, 150, view === 'top' ? 150 : 250)
    assert.equal(centroid(mask).count, mask.width * mask.height, view)
  }
})

test('an off-centre post lands on the correct side of every silhouette', () => {
  const grid = post()
  const front = stoneSilhouette(grid, 'front', 150, 250)
  // x 10..20 is columns 100..124, y 0..80 is rows 50..249, at 0.4 cm a pixel.
  const want = maskWhere(grid, 'front', 150, 250, (x, y) => x > 10 && x < 20 && y < 80)
  assert.deepEqual(front.data, want.data)
  assert.equal(centroid(front).count, 25 * 200)

  const c = (view: AxisView) => centroid(stoneSilhouette(grid, view, 150, view === 'top' ? 150 : 250))
  assert.ok(Math.abs(c('front').col - 112) < 0.01, 'front: X = 15 is right of centre')
  assert.ok(Math.abs(c('back').col - 37) < 0.01, 'back: X = 15 is left of centre')
  assert.ok(Math.abs(c('left').col - 99.5) < 0.01, 'left: Z = 10 is right of centre')
  assert.ok(Math.abs(c('right').col - 49.5) < 0.01, 'right: Z = 10 is left of centre')
  const top = c('top')
  assert.ok(Math.abs(top.col - 112) < 0.01, 'top: X = 15 is right of centre')
  assert.ok(Math.abs(top.row - 99.5) < 0.01, 'top: Z = 10 is below centre')
  for (const view of ['front', 'back', 'left', 'right'] as const) {
    assert.ok(Math.abs(c(view).row - 149.5) < 0.01, `${view}: the top of the post is at Y = 80`)
  }
  // Any resolution, square pixels or not.
  const coarse = stoneSilhouette(grid, 'front', 30, 20)
  assert.equal(centroid(coarse).count, 5 * 16)
})

test('silhouette agreement is intersection over union with the outline', () => {
  const grid = post()
  // The outline is the post itself.
  const same = silhouetteAgreement(grid, 'front', maskWhere(grid, 'front', 150, 250, (x, y) => x > 10 && x < 20 && y < 80))
  assert.equal(same.iou, 1)
  assert.equal(same.stoneOutside, 0)
  assert.equal(same.outlineOutside, 0)
  assert.ok(Math.abs(same.stoneAreaCm2 - 800) < 1e-6)

  // A taller outline: all the stone is inside it, a fifth of it has no stone.
  const tall = silhouetteAgreement(grid, 'front', maskWhere(grid, 'front', 150, 250, x => x > 10 && x < 20))
  assert.ok(Math.abs(tall.iou - 0.8) < 1e-9)
  assert.equal(tall.stoneOutside, 0)
  assert.ok(Math.abs(tall.outlineOutside - 0.2) < 1e-9)
  assert.ok(Math.abs(tall.outlineAreaCm2 - 1000) < 1e-6)

  // The same outline shifted 4 cm: 3000 px shared, 2000 px each way.
  const shifted = silhouetteAgreement(grid, 'front', maskWhere(grid, 'front', 150, 250, (x, y) => x > 14 && x < 24 && y < 80))
  assert.ok(Math.abs(shifted.iou - 3 / 7) < 1e-9)
  assert.ok(Math.abs(shifted.stoneOutside - 0.4) < 1e-9)
  assert.ok(Math.abs(shifted.outlineOutside - 0.4) < 1e-9)

  // The back view of the same outline is its mirror image, and scores the same.
  const back = silhouetteAgreement(grid, 'back', maskWhere(grid, 'back', 150, 250, (x, y) => x > 14 && x < 24 && y < 80))
  assert.ok(Math.abs(back.iou - 3 / 7) < 1e-9)

  // No stone and no outline agree; stone against an empty outline does not.
  const empty: Mask = { width: 150, height: 250, data: new Uint8Array(150 * 250) }
  assert.equal(silhouetteAgreement(grid, 'front', empty).iou, 0)
  assert.equal(silhouetteAgreement(grid, 'front', empty).stoneOutside, 1)
})

test('a block stands proud of a small sphere by the analytic amounts', () => {
  const grid = createGrid()
  const fit = proudOfForm(grid, sphere(10))
  // Furthest point: a bottom or top corner, sqrt(30² + 50² + 30²) from the centre.
  const corner = Math.sqrt(900 + 2500 + 900) - 10
  assert.ok(Math.abs(fit.proudMaxCm - corner) < 0.4, `max ${fit.proudMaxCm} vs ${corner}`)

  // Mean over the four sides and the top, by the midpoint rule.
  let sum = 0
  let area = 0
  const add = (x: number, y: number, z: number): void => {
    sum += Math.sqrt(x * x + (y - 50) * (y - 50) + z * z) - 10
    area++
  }
  for (let a = -29.5; a < 30; a++) {
    for (let y = 0.5; y < 100; y++) {
      add(a, y, 30)
      add(a, y, -30)
      add(30, y, a)
      add(-30, y, a)
    }
    for (let b = -29.5; b < 30; b++) add(a, 100, b)
  }
  assert.ok(Math.abs(fit.proudMeanCm - sum / area) < 0.4, `mean ${fit.proudMeanCm} vs ${sum / area}`)

  const ball = 4 / 3 * Math.PI * 1000
  assert.ok(Math.abs(fit.outsideCm3 - (360000 - ball)) < 0.01 * ball, `outside ${fit.outsideCm3}`)
  assert.equal(fit.overcutCm3, 0)
  assert.equal(fit.overcutMaxCm, 0)
  assert.equal(fit.nearShare, 0)
})

test('cutting into the form is reported as depth and volume lost', () => {
  const grid = createGrid()
  const form = sphere(10)
  // Saw the block off at y = 55: the top 5 cm of the sphere goes with it.
  saw(grid, [0, 55, 0], [0, 1, 0])
  const fit = proudOfForm(grid, form)
  const cap = Math.PI * 25 * (30 - 5) / 3
  assert.ok(Math.abs(fit.overcutMaxCm - 5) < 0.4, `depth ${fit.overcutMaxCm}`)
  assert.ok(Math.abs(fit.overcutCm3 - cap) < 0.03 * cap, `lost ${fit.overcutCm3} vs ${cap}`)
  const left = 60 * 55 * 60 - (4 / 3 * Math.PI * 1000 - cap)
  assert.ok(Math.abs(fit.outsideCm3 - left) < 40, `outside ${fit.outsideCm3} vs ${left}`)
  assert.ok(Math.abs(fit.proudMaxCm - (Math.sqrt(900 + 2500 + 900) - 10)) < 0.4)

  // Sawn clear through the middle, the deepest loss is the sphere's own centre.
  saw(grid, [0, 45, 0], [0, 1, 0])
  const through = proudOfForm(grid, form)
  assert.ok(Math.abs(through.overcutMaxCm - 10) < 0.4, `depth ${through.overcutMaxCm}`)
})

test('a stone that matches its form scores zero both ways', () => {
  const grid = createGrid()
  // The form is the block itself.
  const self = compileForm({ shapes: [{ kind: 'box', center: [0, 50, 0], size: [60, 100, 60], rotation: [0, 0, 0] }], blend: 0 })
  const fit = proudOfForm(grid, self)
  assert.ok(fit.proudMaxCm < 0.05, `max ${fit.proudMaxCm}`)
  assert.ok(fit.outsideCm3 < 1 && fit.overcutCm3 < 1, `${fit.outsideCm3} / ${fit.overcutCm3}`)
  assert.equal(fit.nearShare, 1)

  // A form that pokes out of the block: the part outside was never stone, so it is not
  // an overcut.
  const wide = compileForm({ shapes: [{ kind: 'box', center: [0, 50, 0], size: [80, 100, 60], rotation: [0, 0, 0] }], blend: 0 })
  assert.ok(proudOfForm(grid, wide).overcutCm3 < 1)
  assert.equal(proudOfForm(grid, wide).overcutMaxCm, 0)

  // Two forms measure as their union: the same block in two overlapping parts.
  const part = (x: number) => compileForm({ shapes: [{ kind: 'box', center: [x, 50, 0], size: [40, 100, 60], rotation: [0, 0, 0] }], blend: 0 })
  assert.ok(proudOfForm(grid, [part(-10), part(10)]).outsideCm3 < 1)
  assert.ok(Math.abs(proudOfForm(grid, part(10)).outsideCm3 - 120000) < 200)
})

test('measureAll reports forms and outlines only when they exist, rounded', () => {
  const grid = createGrid()
  applyStrike(grid, {
    kind: 'form', name: 'ball', blend: 0,
    shapes: [{ kind: 'ellipsoid', center: [0, 50, 0], size: [20, 20, 20], rotation: [0, 0, 0] }]
  })
  const outline = maskWhere(grid, 'left', 60, 100, z => z < 0)
  const m = measureAll(grid, { outlines: { left: outline } })
  assert.ok(Math.abs(m.form_proud_max_cm! - 55.57) < 0.4, `max ${m.form_proud_max_cm}`)
  assert.ok(m.form_proud_mean_cm! > 20 && m.form_proud_mean_cm! < m.form_proud_max_cm!)
  assert.equal(m.form_overcut_cm3, 0)
  assert.equal(m.form_overcut_max_cm, 0)
  assert.equal(m.form_surface_within_1cm_pct, 0)
  assert.ok(Math.abs(m.form_stone_outside_cm3! - 355811) < 42)
  assert.equal(m.silhouette_left_iou, 0.5)
  assert.equal(m.silhouette_left_stone_outside_outline_pct, 50)
  assert.equal(m.silhouette_left_outline_not_covered_pct, 0)
  assert.equal('silhouette_front_iou' in m, false)
  for (const [key, value] of Object.entries(m)) {
    assert.ok(Number.isFinite(value), key)
    assert.ok(Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6, `${key} is rounded: ${value}`)
  }
  // Naming forms picks among them; names that are not declared are skipped.
  assert.equal('form_proud_max_cm' in measureAll(grid, { forms: [] }), false)
  assert.equal('form_proud_max_cm' in measureAll(grid, { forms: ['nope'] }), false)
  assert.equal(measureAll(grid, { forms: ['ball', 'nope'] }).form_proud_max_cm, m.form_proud_max_cm)
  // Same stone, same numbers.
  assert.deepEqual(measureAll(grid, { outlines: { left: outline } }), m)
})

test('the surface is counted by finish, so a polish shows in the numbers', () => {
  const grid = createGrid({ width: 20, height: 20, depth: 20 })
  // A fresh block is sawn on every face: neither rough, rasped nor polished.
  assert.deepEqual(surfaceFinish(grid), { rough: 0, tooled: 1, rasped: 0, polished: 0, mean: 90 })
  const fresh = measureAll(grid)
  assert.deepEqual([fresh.surface_rough_pct, fresh.surface_rasped_pct, fresh.surface_polished_pct], [0, 0, 0])

  // Point work on the front, the rasp over the top, polish over half of that.
  for (let x = -8; x <= 8; x += 2) {
    for (let y = 2; y <= 18; y += 2) applyStrike(grid, { kind: 'cut', tool: 'point', at: [x, y, 10], dir: [0, 0, -1], size: 3, depth: 1, seed: x * 31 + y, ms: 1 })
  }
  for (let z = -8; z <= 8; z += 4) rasp(grid, { view: 'top', path: [[-8, z], [8, z]], width_cm: 5, passes: 1 })
  const worked = surfaceFinish(grid)
  // Five faces of 400 cm² can be carved; one is rough and one rasped.
  assert.ok(Math.abs(worked.rough - 0.2) < 0.05 && Math.abs(worked.rasped - 0.2) < 0.05 && worked.polished === 0, JSON.stringify(worked))
  for (let z = -8; z <= 0; z += 2) polish(grid, { view: 'top', path: [[-8, z], [8, z]], width_cm: 5, passes: 4 })
  const shone = surfaceFinish(grid)
  assert.ok(shone.polished > 0.07 && shone.polished < 0.15 && shone.rasped < worked.rasped && shone.mean > worked.mean, JSON.stringify(shone))
  assert.ok(Math.abs(shone.rough + shone.tooled + shone.rasped + shone.polished - 1) < 1e-9)
  assert.equal(shone.rough, worked.rough)
  const m = measureAll(grid)
  assert.ok(Math.abs(m.surface_polished_pct! - 100 * shone.polished) < 0.06 && m.surface_rough_pct! > 15)
})

test('a slice measures the section of the stone, its form and the reference in one plane', () => {
  const grid = post()
  // Level, through the post: 10 × 8 cm, where the top view's rulers say it is.
  const level = measureSlice(grid, 'y', 40)
  assert.ok(Math.abs(level.section_area_cm2! - 80) < 1.5, `area ${level.section_area_cm2}`)
  assert.deepEqual([level.section_x_min_cm, level.section_x_max_cm, level.section_z_min_cm, level.section_z_max_cm], [10, 20, 6, 14])
  // Above the post, and beside it, the plane meets nothing and reports no extent.
  assert.deepEqual(measureSlice(grid, 'y', 90), { section_area_cm2: 0 })
  assert.deepEqual(measureSlice(grid, 'x', 0), { section_area_cm2: 0 })
  // Upright through it: front to back is Z across and Y up, facing the viewer is X across.
  const profile = measureSlice(grid, 'x', 15)
  assert.ok(Math.abs(profile.section_area_cm2! - 640) < 8)
  assert.deepEqual([profile.section_z_min_cm, profile.section_z_max_cm, profile.section_y_min_cm, profile.section_y_max_cm], [6, 14, 0, 80])
  const facing = measureSlice(grid, 'z', 10)
  assert.ok(Math.abs(facing.section_area_cm2! - 800) < 8)
  assert.deepEqual([facing.section_x_min_cm, facing.section_x_max_cm, facing.section_y_min_cm, facing.section_y_max_cm], [10, 20, 0, 80])

  // Against a ball of radius 6 at the post's middle: its section is a disc, the post covers
  // all of it at the centre plane, and the corners of the post stand outside.
  applyStrike(grid, { kind: 'form', name: 'ball', shapes: [{ kind: 'ellipsoid', center: [15, 40, 10], size: [12, 12, 12], rotation: [0, 0, 0] }], blend: 0 })
  const fit = measureSlice(grid, 'y', 40)
  // The post is 10 × 8 cm, so the 12 cm disc loses a segment on each of its four sides:
  // about 12.4 cm² front and back, 4.5 cm² left and right.
  assert.ok(Math.abs(fit.section_form_area_cm2! - Math.PI * 36) < 2, `form ${fit.section_form_area_cm2}`)
  assert.ok(Math.abs(fit.section_form_without_stone_cm2! - 33.8) < 3, `missing ${fit.section_form_without_stone_cm2}`)
  assert.ok(Math.abs(fit.section_stone_outside_form_cm2! - (80 - (Math.PI * 36 - fit.section_form_without_stone_cm2!))) < 2)
  assert.ok(fit.section_proud_max_cm! > 0.2 && fit.section_proud_max_cm! < 1)
  assert.equal('section_form_area_cm2' in measureSlice(grid, 'y', 40, { forms: [] }), false)

  // The reference is its two outlines pushed through the block: here X > 12 and Z < 10.
  const outlines = {
    front: maskWhere(grid, 'front', 150, 250, h => h > 12),
    left: maskWhere(grid, 'left', 150, 250, h => h < 10)
  }
  const ref = measureSlice(grid, 'y', 40, { outlines, forms: [] })
  assert.ok(Math.abs(ref.section_reference_area_cm2! - 18 * 40) < 12, `reference ${ref.section_reference_area_cm2}`)
  // Of the post's 80 cm², the part with X 12..20 and Z 6..10 is inside: 32.
  assert.ok(Math.abs(ref.section_stone_outside_reference_cm2! - 48) < 3, `outside ${ref.section_stone_outside_reference_cm2}`)
})
