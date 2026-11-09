/**
 * The figure and animal canon (shared/sculpt/figure.ts): a declared pose becomes kernel
 * primitives that stand on their ground, put the weight, limbs and head where the pose says,
 * and can be roughed out as one mass. And declare_figure, the tool that declares one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { POSES } from '../bench/poses.ts'
import { createStudio } from '../shared/agent/studio.ts'
import { parseCall, toolDefs } from '../shared/agent/toolSchemas.ts'
import { expandAnimal, expandFigure, expandScene } from '../shared/sculpt/figure.ts'
import type { AnimalSpec, FigureSpec } from '../shared/sculpt/figure.ts'
import { createGrid } from '../shared/sculpt/grid.ts'
import { roughOut } from '../shared/sculpt/hand.ts'
import { compileForm, declareForm, formDistance } from '../shared/sculpt/shapes.ts'
import type { Shape } from '../shared/sculpt/types.ts'

const figure = (f: Partial<FigureSpec>): FigureSpec => ({
  body: 'man', build: 'athletic', ground: [0, 6, 0], height: 86, facing: 0, legs: 'stand', weightOn: 'both', twist: 0, lean: 0,
  headTurn: 0, headTilt: 0, leftArm: 'down', rightArm: 'down', drapery: 'none', support: 'none', style: [], ...f
})
const animal = (a: Partial<AnimalSpec>): AnimalSpec => ({
  species: 'horse', pose: 'stand', ground: [0, 6, 0], length: 44, facing: 0, headTurn: 0, headRaise: 0, tail: 'down', lead: 'left', ...a
})

// The lowest stone of a set of shapes, by sampling down the middle of the block.
function lowest(shapes: Shape[]): number {
  const form = compileForm({ shapes, blend: 1 })
  let low = Infinity
  for (let x = -30; x <= 30; x += 1) {
    for (let z = -30; z <= 30; z += 1) {
      for (let y = 0; y < low && y < 40; y += 0.25) {
        if (formDistance(form, x, y, z) < 0) {
          low = y
          break
        }
      }
    }
  }
  return low
}

test('every preset expands to kernel kinds only, rounded, finite, and stands on its ground', () => {
  for (const [id, preset] of Object.entries(POSES)) {
    const scene = expandScene(preset.scene)
    assert.ok(scene.shapes.length > 10, id)
    for (const s of scene.shapes) {
      assert.ok(['ellipsoid', 'box', 'capsule', 'cone'].includes(s.kind), `${id}: ${s.kind}`)
      for (const v of [...s.center, ...s.size, ...s.rotation]) {
        assert.ok(Number.isFinite(v), `${id}: ${v}`)
        assert.equal(v, Math.round(v * 1000) / 1000, `${id}: ${v} not rounded`)
      }
    }
  }
  // Without its base, a figure's feet and an animal's hooves come down to the ground point.
  for (const subject of [figure({ legs: 'stride', weightOn: 'left' }), figure({ legs: 'kneel', weightOn: 'right' })]) {
    const low = lowest(expandFigure(subject).shapes)
    assert.ok(Math.abs(low - 6) < 0.8, `figure ${subject.legs} lowest ${low}`)
  }
  for (const pose of ['stand', 'gallop', 'rear', 'lie'] as const) {
    const low = lowest(expandAnimal(animal({ pose })).shapes)
    assert.ok(Math.abs(low - 6) < 0.8, `horse ${pose} lowest ${low}`)
  }
})

test('contrapposto puts the weight over one leg: that foot under the pelvis, the other forward and out', () => {
  const r = expandFigure(figure({ weightOn: 'right' })).marks.points
  // The figure's right is -X when it faces the viewer.
  assert.ok(r.pelvis![0] < -1, `pelvis shifted to the right: ${r.pelvis![0]}`)
  assert.ok(Math.abs(r.right_foot![0] - r.pelvis![0]) < 4, 'right foot under the pelvis')
  assert.ok(r.left_foot![2] > r.right_foot![2] + 3, 'the free foot forward')
  assert.ok(r.left_foot![0] > r.pelvis![0] + 6, 'the free foot out to the side')
})

test('a lunge and a stride put the weighted foot ahead, and facing turns the whole pose', () => {
  const lunge = expandFigure(figure({ legs: 'lunge', weightOn: 'left' })).marks.points
  assert.ok(lunge.left_foot![2] > 15 && lunge.right_foot![2] < -15, `feet ${lunge.left_foot![2]} ${lunge.right_foot![2]}`)
  assert.ok(lunge.pelvis![1] < expandFigure(figure({})).marks.points.pelvis![1] - 8, 'a lunge is low')
  const turned = expandFigure(figure({ legs: 'lunge', weightOn: 'left', facing: 90 })).marks.points
  // Facing 90 turns the front toward +X.
  assert.ok(turned.left_foot![0] > 15 && Math.abs(turned.left_foot![2]) < 8, `turned front foot ${turned.left_foot}`)
})

test('the arms go where the gestures say', () => {
  const H = 86
  const up = expandFigure(figure({ leftArm: 'overhead', rightArm: 'back' })).marks.points
  assert.ok(up.left_hand![1] > up.head![1] + 5, `overhead hand ${up.left_hand![1]} head ${up.head![1]}`)
  assert.ok(up.right_hand![2] < up.pelvis![2] - 8, `the hand drawn back ${up.right_hand![2]}`)
  const head = expandFigure(figure({ rightArm: 'to_head', leftArm: 'out' })).marks.points
  const dist = Math.hypot(head.right_hand![0] - head.head![0], head.right_hand![1] - head.head![1], head.right_hand![2] - head.head![2])
  assert.ok(dist < 0.13 * H, `hand to head ${dist}`)
  assert.ok(head.left_hand![0] > 30, `the hand out to the side ${head.left_hand![0]}`)
  const down = expandFigure(figure({})).marks.points
  assert.ok(down.left_hand![1] < down.pelvis![1] + 2, 'a hanging hand comes down to the thigh')
})

test('torsion and the head: twist turns the shoulders, head_turn the face, and a figure head of 9 cm or more has the face canon', () => {
  const twisted = expandFigure(figure({ twist: 40, leftArm: 'out', rightArm: 'out' })).marks.points
  // Turning the chest toward the figure's own left (+X) brings the right hand forward.
  assert.ok(twisted.right_hand![2] > twisted.left_hand![2] + 20, `hands ${twisted.right_hand![2]} ${twisted.left_hand![2]}`)
  const big = expandFigure(figure({ height: 86 })).shapes.length
  const small = expandFigure(figure({ height: 50 })).shapes.length
  assert.ok(big > small + 15, `head canon on the big figure: ${big} vs ${small}`)
})

test('animals: a rearing horse holds its head high, a charging bull low, and a lying lion is low to the ground', () => {
  const rear = expandAnimal(animal({ pose: 'rear', headRaise: 10 })).marks
  assert.ok(rear.points.head![1] > rear.points.back![1] + 5, `rearing head ${rear.points.head![1]} back ${rear.points.back![1]}`)
  assert.ok(rear.max[1] - rear.min[1] > 1.3 * (expandAnimal(animal({})).marks.max[1] - 6), 'a rear is taller than a stand')
  const charge = expandAnimal(animal({ species: 'bull', pose: 'charge', headRaise: -20, length: 48 })).marks
  assert.ok(charge.points.head![1] < charge.points.back![1] - 5, `charging head ${charge.points.head![1]} back ${charge.points.back![1]}`)
  const lie = expandAnimal(animal({ species: 'lion', pose: 'lie', length: 50 })).marks
  const stand = expandAnimal(animal({ species: 'lion', pose: 'stand', length: 50 })).marks
  assert.ok(lie.points.back![1] < stand.points.back![1] - 10, `lying back ${lie.points.back![1]} standing ${stand.points.back![1]}`)
  // A bull has horns: two cones standing out wider than its head.
  const horns = expandAnimal(animal({ species: 'bull' })).shapes.filter(s => s.kind === 'cone' && s.size[1] > 10)
  assert.equal(horns.length, 2)
})

test('a rider sits astride the first animal, on its back', () => {
  const scene = expandScene({ figures: [figure({ legs: 'ride', height: 52 })], animals: [animal({ pose: 'stand', length: 44 })], shapes: [] })
  const horse = scene.subjects[0]!.points
  const rider = scene.subjects[1]!.points
  assert.ok(Math.abs(rider.pelvis![1] - horse.back![1]) < 6, `rider ${rider.pelvis![1]} on the back ${horse.back![1]}`)
  assert.ok(Math.abs(rider.pelvis![0] - horse.back![0]) < 2 && Math.abs(rider.pelvis![2] - horse.back![2]) < 4, 'over the back')
  assert.ok(rider.left_foot![0] > horse.back![0] + 5 && rider.right_foot![0] < horse.back![0] - 5, 'a leg down each side')
})

test('the study presets rough out as one mass standing on the base', () => {
  for (const id of ['david', 'rider', 'bull']) {
    const grid = createGrid({ voxel: 0.6 })
    declareForm(grid, 'scene', { shapes: expandScene(POSES[id]!.scene).shapes, blend: POSES[id]!.blend })
    const r = roughOut(grid, { to: 'scene', margin_cm: 3, tool: 'point', max_strikes: 300 })
    assert.equal(r.error, undefined, `${id}: ${r.error}`)
  }
})

test('declare_figure declares one form of kernel solids and says where each subject ended up', async () => {
  const grid = createGrid({ voxel: 1 })
  const studio = createStudio({ grid, encodeImage: () => new Uint8Array() })
  const args = {
    name: 'group',
    figures: [{ body: 'man', build: 'athletic', ground_x: 0, ground_y: 6, ground_z: 0, height_cm: 52, facing_deg: 0, legs: 'ride', weight_on: 'both', twist_deg: 10, lean_deg: 5, head_turn_deg: 20, head_tilt_deg: 0, left_arm: 'forward', right_arm: 'raised', drapery: 'cloak', support: 'none', style: ['short_hair'] }],
    animals: [{ species: 'horse', pose: 'rear', ground_x: 0, ground_y: 6, ground_z: -4, length_cm: 40, facing_deg: 0, head_turn_deg: -20, head_raise_deg: 10, tail: 'down', lead: 'left' }],
    shapes: [{ kind: 'box', center_x: 0, center_y: 3, center_z: 0, size_x: 54, size_y: 6, size_z: 54, rot_x: 0, rot_y: 0, rot_z: 0, style: [] }],
    blend_cm: 1.3,
    why: 'A horse rising, the rider leaning into it.'
  }
  const defs = toolDefs({ toolSet: 'formed', reference: 'none' })
  const parsed = parseCall(defs, { id: 'c1', name: 'declare_figure', args })
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error)
  const r = await studio.run({ id: 'c1', name: 'declare_figure', args: parsed.ok ? parsed.args : args } as never)
  assert.match(r.summary, /Declared form "group" \(2 subjects and 1 shape of yours/)
  assert.match(r.summary, /Subject 1, horse, rear: X .*head \(/)
  assert.match(r.summary, /Subject 2, man, ride: .*left hand \(/)
  const entry = studio.log().strikes.find(s => s.kind === 'form')!
  assert.ok(entry.kind === 'form' && entry.shapes.every(s => ['ellipsoid', 'box', 'capsule', 'cone'].includes(s.kind)))
  assert.ok(r.numbers!.form_solids! > 40)
  // Nothing posed is refused; so is a crowd.
  const none = parseCall(defs, { id: 'c2', name: 'declare_figure', args: { ...args, figures: [], animals: [] } })
  assert.ok(!none.ok && /at least one figure or animal/.test(none.error))
  const crowd = parseCall(defs, { id: 'c3', name: 'declare_figure', args: { ...args, figures: [args.figures[0], args.figures[0], args.figures[0]] } })
  assert.ok(!crowd.ok && /at most 3/.test(crowd.error))
})
