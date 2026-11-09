/**
 * The sculptor's canon: a `head` declared by the model becomes kernel primitives that sit
 * where the head was placed, mirror left to right, follow its pose, and carry a face.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expandHead, expandShapes } from '../shared/sculpt/anatomy.ts'
import { compileForm, formDistance } from '../shared/sculpt/shapes.ts'
import type { Shape, Vec3 } from '../shared/sculpt/types.ts'

const head = (center: Vec3, size: Vec3, rotation: Vec3 = [0, 0, 0]) => ({ center, size, rotation })

// Where the surface of a form lies along a ray from a point in a direction, cm from the point.
function surface(form: ReturnType<typeof compileForm>, from: Vec3, dir: Vec3): number {
  let t = 0
  for (let i = 0; i < 400; i++) {
    const d = formDistance(form, from[0] + dir[0] * t, from[1] + dir[1] * t, from[2] + dir[2] * t)
    if (d < 0.01) return t
    t += Math.max(d, 0.02)
    if (t > 80) break
  }
  return Infinity
}

test('a head expands to the kernel kinds only, as many as the canon says, mirrored about its own centre', () => {
  const shapes = expandHead(head([0, 77, -2], [27, 40, 34])).shapes
  assert.ok(shapes.length > 20, `${shapes.length} shapes`)
  for (const s of shapes) assert.ok(['ellipsoid', 'box', 'capsule', 'cone'].includes(s.kind), s.kind)
  // Every shape off the centre line has a twin at -x with the same size.
  for (const s of shapes) {
    if (Math.abs(s.center[0]) < 1e-6) continue
    const twin = shapes.find(t => t !== s && Math.abs(t.center[0] + s.center[0]) < 1e-6 && Math.abs(t.center[1] - s.center[1]) < 1e-6)
    assert.ok(twin, `no twin for ${s.kind} at ${s.center.join(',')}`)
    assert.deepEqual(twin!.size, s.size)
  }
  // Numbers are rounded so a log written on one engine replays on another.
  for (const s of shapes) for (const v of [...s.center, ...s.size, ...s.rotation]) assert.equal(v, Math.round(v * 1000) / 1000)
})

test('the head fills about the skull box it was given and carries a face: brow, sockets, nose and chin in the right order', () => {
  const H = 40
  const form = compileForm({ shapes: expandHead(head([0, 77, 0], [27, H, 34])).shapes, blend: 1.3 })
  // Crown and chin near the top and bottom of the box; the skull's back near its back.
  assert.ok(Math.abs(surface(form, [0, 120, 0], [0, -1, 0]) - (120 - 97)) < 1.5, 'crown')
  assert.ok(Math.abs(surface(form, [0, 30, 4], [0, 1, 0]) - (57 - 30)) < 2, 'chin')
  assert.ok(Math.abs(surface(form, [0, 77, -40], [0, 0, 1]) - (40 - 17)) < 1.5, 'back of the skull')
  // Along the centre line from the front: the nose tip stands furthest forward, then the brow
  // and lips, and the eye line between brow and nose is set back from both.
  const z = (y: number, x = 0) => 40 - surface(form, [x, y, 40], [0, 0, -1])
  const chin = 57
  const brow = z(chin + 0.565 * H, 0.2 * 27)
  const eye = z(chin + 0.5 * H, 0.2 * 27)
  const noseTip = z(chin + 0.36 * H)
  const lips = z(chin + 0.27 * H)
  const chinFront = z(chin + 0.1 * H)
  assert.ok(noseTip > brow + 2, `nose ${noseTip} brow ${brow}`)
  assert.ok(brow > eye + 1, `brow ${brow} eye ${eye}`)
  assert.ok(noseTip > lips + 2 && lips > chinFront - 1, `nose ${noseTip} lips ${lips} chin ${chinFront}`)
  // The ears stand outside the skull box, the nose in front of it.
  assert.ok(surface(form, [40, chin + 0.45 * H, -2], [-1, 0, 0]) < 40 - 13.5, 'ear')
  assert.ok(noseTip > 17, `nose tip ${noseTip} is in front of the skull box`)
})

test('turning the head turns its face: the nose moves to the side the rotation says, and the pose composes with each part', () => {
  const straight = compileForm({ shapes: expandHead(head([0, 77, 0], [27, 40, 34])).shapes, blend: 1.3 })
  const turned = compileForm({ shapes: expandHead(head([0, 77, 0], [27, 40, 34], [0, 20, 0])).shapes, blend: 1.3 })
  const tip = (form: typeof straight) => {
    let best: Vec3 = [0, 0, -Infinity]
    for (let x = -15; x <= 15; x += 0.5) {
      for (let y = 66; y <= 76; y += 0.5) {
        const t = surface(form, [x, y, 40], [0, 0, -1])
        if (t < Infinity && 40 - t > best[2]) best = [x, y, 40 - t]
      }
    }
    return best
  }
  const a = tip(straight)
  const b = tip(turned)
  assert.ok(Math.abs(a[0]) < 1, `straight nose at x ${a[0]}`)
  // Positive rot_y turns the face toward +X, the viewer's right.
  assert.ok(b[0] > 4, `turned nose at x ${b[0]}`)
  assert.ok(b[2] < a[2], 'a turned nose stands less far forward')
  // The parts keep their own rotations under the pose: the ears (tilted back about X) also take the turn.
  const ears = expandHead(head([0, 77, 0], [27, 40, 34], [0, 20, 0])).shapes.filter(s => s.size[0] < 4 && s.size[1] > 8)
  assert.equal(ears.length, 2)
  for (const e of ears) assert.ok(Math.abs(e.rotation[1]) > 10, `ear rotation ${e.rotation.join(',')}`)
})

test('expandShapes passes the kernel kinds through unchanged and expands heads in place', () => {
  const box: Shape = { kind: 'box', center: [0, 3, 0], size: [50, 6, 40], rotation: [0, 0, 0] }
  const out = expandShapes([box, { kind: 'head', center: [0, 77, 0], size: [27, 40, 34], rotation: [0, 0, 0] }])
  assert.equal(out.length, 1 + expandHead({ center: [0, 77, 0], size: [27, 40, 34], rotation: [0, 0, 0] }).shapes.length)
  assert.deepEqual(out[out.length - 1], box)
})
