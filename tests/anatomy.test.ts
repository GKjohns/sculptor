/**
 * The sculptor's canon: a `head` declared by the model becomes kernel primitives that sit
 * where the head was placed, mirror left to right, follow its pose, and carry a face.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expandCanon, expandHead, expandShapes } from '../shared/sculpt/anatomy.ts'
import type { StyleToken } from '../shared/sculpt/anatomy.ts'
import { compileForm, formDistance } from '../shared/sculpt/shapes.ts'
import type { Shape, Vec3 } from '../shared/sculpt/types.ts'

// Bald unless asked: the face's landmarks are what these tests pin, and hair is its own test.
const head = (center: Vec3, size: Vec3, rotation: Vec3 = [0, 0, 0], style: StyleToken[] = ['bald']) => ({ center, size, rotation, style })

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
  // Ears lie close but still stand off the side of the head.
  assert.ok(surface(form, [40, chin + 0.45 * H, -2], [-1, 0, 0]) < 40 - 12.5, 'ear')
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
  const out = expandShapes([box, { kind: 'head', center: [0, 77, 0], size: [27, 40, 34], rotation: [0, 0, 0], style: ['bald'] }])
  assert.equal(out.length, 1 + expandHead(head([0, 77, 0], [27, 40, 34])).shapes.length)
  assert.deepEqual(out[out.length - 1], box)
})

// Where the surface of a form lies along a ray, for the tests below that compare two heads.
const front = (form: ReturnType<typeof compileForm>, x: number, y: number) => 40 - surface(form, [x, y, 40], [0, 0, -1])

test('the eyes are open: between the lids the ball stands proud, and the lids and lips keep their own crisp blends', () => {
  const shapes = expandHead(head([0, 77, 0], [27, 40, 34])).shapes
  const form = compileForm({ shapes, blend: 1.3 })
  const s = 40 / 23
  const chin = 57
  // Down the middle of the left eye: lid, ball, lid; the ball's front is clear of the lids'
  // shadow line (the gap between them is at least a centimetre).
  const x = 3.15 * 27 / 15.5
  const ball = front(form, x, chin + 11.35 * s)
  const above = front(form, x, chin + 12.9 * s)
  assert.ok(ball > above - 1.2, `ball ${ball} under the upper lid ${above}`)
  // Crisp parts carry their own blend, smaller than the form's.
  const crisp = shapes.filter(p => p.blend !== undefined)
  assert.ok(crisp.length >= 10, `${crisp.length} crisp parts`)
  for (const p of crisp) assert.ok(p.blend! < 1.3 && p.blend! > 0, `blend ${p.blend}`)
})

test('style tokens change the face: a snub nose is shorter than an aquiline one, a woman\'s jaw narrower, age adds folds', () => {
  // The nose's profile down the middle: an aquiline bridge stands out where a snub one dips,
  // and a snub nose's base is drawn up and back.
  const profile = (style: StyleToken[]) => {
    const form = compileForm({ shapes: expandHead(head([0, 77, 0], [27, 40, 34], [0, 0, 0], style)).shapes, blend: 1.3 })
    return (y: number) => front(form, 0, y)
  }
  const aquiline = profile(['bald', 'aquiline_nose'])
  const snub = profile(['bald', 'snub_nose'])
  assert.ok(aquiline(75.5) > snub(75.5) + 0.5, `bridge ${aquiline(75.5)} vs ${snub(75.5)}`)
  assert.ok(aquiline(69) > snub(69) + 1, `base ${aquiline(69)} vs ${snub(69)}`)
  const width = (style: StyleToken[]) => {
    const form = compileForm({ shapes: expandHead(head([0, 77, 0], [27, 40, 34], [0, 0, 0], style)).shapes, blend: 1.3 })
    return 40 - surface(form, [40, 64, 2], [-1, 0, 0])
  }
  assert.ok(width(['bald', 'female']) < width(['bald', 'male', 'square_jaw']) - 0.5, 'a woman\'s jaw is narrower than a square male one')
  const cuts = (style: StyleToken[]) => expandHead(head([0, 77, 0], [27, 40, 34], [0, 0, 0], style)).cuts
  assert.ok(cuts(['bald', 'old']).some(c => c.label === 'nasolabial'), 'the fold from nose to mouth')
  assert.ok(cuts(['bald', 'frown']).some(c => c.label === 'frown line'))
  assert.ok(cuts(['bald']).some(c => c.label === 'iris') && cuts(['bald']).some(c => c.label === 'pupil'), 'the iris is ringed and the pupil drilled')
})

test('hair stands off the skull in separate crisp locks, curls are drilled, and a beard hangs below the chin', () => {
  const bald = compileForm({ shapes: expandHead(head([0, 77, 0], [27, 40, 34])).shapes, blend: 1.3 })
  const curls = expandHead(head([0, 77, 0], [27, 40, 34], [0, 0, 0], ['curls']))
  const form = compileForm({ shapes: curls.shapes, blend: 1.3 })
  const crown = (f: typeof form) => 120 - surface(f, [0, 120, -2], [0, -1, 0])
  assert.ok(crown(form) > crown(bald) + 1.5, `curls ${crown(form)} bald ${crown(bald)}`)
  assert.ok(curls.cuts.filter(c => c.label === 'curl').length >= 5, 'every third curl drilled')
  assert.ok(curls.shapes.filter(s => s.kind === 'capsule' && s.blend !== undefined).length > 20, 'curls are capsules with their own blend')
  // The swept mass (the default): wider than the skull at the sides, a fringe over the brow,
  // a few deep separations and undercuts, not a groove on every lock.
  const swept = expandHead(head([0, 77, 0], [27, 40, 34], [0, 0, 0], ['waves']))
  const sform = compileForm({ shapes: swept.shapes, blend: 1.3 })
  const side = (f: typeof form) => 40 - surface(f, [40, 85, -4], [-1, 0, 0])
  assert.ok(side(sform) > side(bald) + 2, `mass ${side(sform)} skull ${side(bald)}`)
  const seps = swept.cuts.filter(c => c.label === 'lock').length
  assert.ok(seps >= 3 && seps <= 8, `${seps} separations`)
  assert.ok(swept.cuts.filter(c => c.label === 'undercut').length <= 5)
  // Long hair comes down below the chin at the back.
  const long = compileForm({ shapes: expandHead(head([0, 77, 0], [27, 40, 34], [0, 0, 0], ['long_hair'])).shapes, blend: 1.3 })
  assert.ok(surface(long, [0, 64, -40], [0, 0, 1]) < surface(sform, [0, 64, -40], [0, 0, 1]) - 2, 'long hair falls behind the neck')
  const beard = compileForm({ shapes: expandHead(head([0, 77, 0], [27, 40, 34], [0, 0, 0], ['bald', 'beard'])).shapes, blend: 1.3 })
  const low = (f: typeof form) => surface(f, [0, 30, 6], [0, 1, 0])
  assert.ok(low(beard) < low(bald) - 1, 'the beard comes below the chin')
})

test('a torso with a head makes a bust: one mass from socle to crown, the neck carrying the head, the mantle over the shoulder away from the gaze', () => {
  const turned = expandCanon([
    { kind: 'head', center: [0, 83, 1], size: [22, 32, 27], rotation: [0, 20, 0], style: ['male', 'short_hair'] },
    { kind: 'torso', center: [0, 36, -1], size: [60, 46, 30], rotation: [0, 0, 0], style: ['mantle', 'socle'] }
  ])
  const form = compileForm({ shapes: turned.shapes, blend: 1.2 })
  // Stone all the way up the middle: socle, chest, neck, head.
  for (let y = 1; y < 96; y += 2) {
    let inside = false
    for (let z = -12; z <= 12 && !inside; z += 1) inside = formDistance(form, 0, y, z) < 0
    assert.ok(inside, `no stone at the middle at y ${y}`)
  }
  // The socle stands on the base.
  assert.ok(formDistance(form, 0, 0.5, -1) < 0, 'socle on the base')
  // The head turns toward +X, so the mantle's knot is on the other shoulder (-X).
  const proud = (x: number) => 40 - surface(form, [x, 52, 40], [0, 0, -1])
  assert.ok(proud(-17) > proud(17) + 1, `mantle side ${proud(-17)} vs ${proud(17)}`)
})
