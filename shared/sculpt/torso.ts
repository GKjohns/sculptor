// The torso of a bust for the canon (anatomy.ts): neck, shoulders, chest and back down to the
// truncation, the drapery the style asks for, and the socle it stands on. Its frame is the
// declared box: centre, size (shoulder to shoulder, truncation to shoulder top, chest to back)
// and pose. With a head in the same form the neck is muscle between the two: the column, the
// two sternomastoids from behind the ears to the pit of the neck, the trapezius behind, so a
// turned head turns its neck.

import type { DeclaredShape, Expanded, HeadKnobs, RoughCut } from './anatomy.ts'
import { CHIN } from './anatomy.ts'
import { add, between, dirToWorld, frameOf, lerp, meanStretch, normalize, partShape, r3, rounded, scale, sub, toWorld } from './frame.ts'
import type { Frame } from './frame.ts'
import type { Shape, ShapeKind, Vec3 } from './types.ts'

// The canon torso, cm: shoulder to shoulder, truncation to the top of the shoulders, chest to back.
export const TORSO: Vec3 = [60, 46, 30]

interface Ell { c: Vec3, r: Vec3 }

export interface TorsoStyle {
  female: boolean
  build: number
  drape: 'bare' | 'mantle' | 'collar'
  socle: boolean
}

export function torsoStyle(style: readonly string[] = [], head: HeadKnobs | null): TorsoStyle {
  const has = (t: string) => style.includes(t)
  return {
    female: has('female') || (!has('male') && !!head?.female),
    build: has('lean') ? -1 : has('heavy') ? 1 : head?.build ?? 0,
    drape: has('mantle') ? 'mantle' : has('collar') ? 'collar' : 'bare',
    socle: !has('no_socle')
  }
}

// The masses of the trunk in the canon frame; the drapery is laid on their front. Few and
// broad: a chest, a yoke across the shoulders whose rounded ends are the shoulders, the arms
// cut off under them, the slope of the trapezius, and a little anatomy on the front.
function trunk(s: TorsoStyle): { kind: ShapeKind, e: Ell, r?: Vec3, mirror?: boolean }[] {
  const b = s.build
  const f = s.female ? 1 : 0
  const list: { kind: ShapeKind, e: Ell, r?: Vec3, mirror?: boolean }[] = [
    { kind: 'ellipsoid', e: { c: [0, 2, -0.5], r: [22.5 + b - 1.5 * f, 21, 13.5 + 0.5 * b] } },
    { kind: 'ellipsoid', e: { c: [0, -10, 0.5], r: [21.5 + b - 1.5 * f, 13.5, 12.5 + 0.5 * b] } },
    { kind: 'ellipsoid', e: { c: [0, 15.5, -1.5], r: [29 - 2 * f, 7, 11] } },
    { kind: 'ellipsoid', e: { c: [24 - 2 * f, 5, -0.5], r: [6, 11, 7] }, r: [0, 0, 5], mirror: true },
    { kind: 'ellipsoid', e: { c: [9, 20.5, -3.5], r: [10, 3.2, 6.5] }, r: [0, 0, -14], mirror: true }
  ]
  if (f) list.push({ kind: 'ellipsoid', e: { c: [8, 3, 10], r: [6, 5.5, 4.5] }, mirror: true })
  else list.push({ kind: 'ellipsoid', e: { c: [9.5, 9, 9.5], r: [8.5, 5.5, 3 + 0.5 * b] }, r: [0, 0, -10], mirror: true })
  return list
}

// The front surface of the trunk at (x, y), canon cm: the furthest forward of its masses there.
function frontZ(masses: Ell[], x: number, y: number, back = false): number {
  let best = back ? Infinity : -Infinity
  for (const { c, r } of masses) {
    // Past a mass's outline, its surface is taken to fall away behind it, so the answer is
    // always a number and the furthest forward mass still wins.
    const u = 1 - ((x - c[0]) / r[0]) ** 2 - ((y - c[1]) / r[1]) ** 2
    const h = u > 0 ? r[2] * Math.sqrt(u) : -r[2] * Math.sqrt(-u)
    const z = back ? c[2] - h : c[2] + h
    if (back ? z < best : z > best) best = z
  }
  return best
}

function surfaceAt(masses: Ell[], x: number, y: number, back = false): { p: Vec3, n: Vec3 } {
  const z = frontZ(masses, x, y, back)
  const e = 0.5
  const zx = (frontZ(masses, x + e, y, back) - frontZ(masses, x - e, y, back)) / (2 * e)
  const zy = (frontZ(masses, x, y + e, back) - frontZ(masses, x, y - e, back)) / (2 * e)
  const n = back ? normalize([zx, zy, -1]) : normalize([-zx, -zy, 1])
  return { p: [x, y, z], n: Number.isFinite(n[0]) ? n : [0, 0, back ? -1 : 1] }
}

// A fold: a ridge of cloth along a path of (x, y) on the chest, its crest `proud` off the chest
// in the middle and sinking toward its ends into the cloth under it, as a chain of flattened
// tubes, broadest in the middle.
function fold(f: Frame, masses: Ell[], path: [number, number][], thick: number, proud: number, back = false): Shape[] {
  const out: Shape[] = []
  const pts = path.map(([x, y], i) => {
    const s = surfaceAt(masses, x, y, back)
    const swell = Math.sin(Math.PI * (i + 0.5) / path.length)
    return { p: add(s.p, scale(s.n, proud * (0.6 + 0.4 * swell) - thick / 2)), n: s.n, t: thick * (0.75 + 0.25 * swell) }
  })
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    const t = (a.t + b.t) / 2
    out.push(between('capsule', toWorld(f, a.p), toWorld(f, b.p), t * 1.4 * meanStretch(f), t * meanStretch(f), dirToWorld(f, normalize(add(a.n, b.n)))))
  }
  return out
}

// The body of a length of cloth lying on the chest along a path: overlapping flat masses
// `wide` across and `thick` through, standing `proud` off the chest.
function cloth(f: Frame, masses: Ell[], path: [number, number][], wide: number, thick: number, proud: number, back = false): Shape[] {
  const out: Shape[] = []
  for (let i = 0; i < path.length; i++) {
    const [x, y] = path[i]!
    const a = path[Math.max(0, i - 1)]!
    const b = path[Math.min(path.length - 1, i + 1)]!
    const s = surfaceAt(masses, x, y, back)
    const along: Vec3 = normalize([b[0] - a[0], b[1] - a[1], 0])
    const step = Math.hypot(b[0] - a[0], b[1] - a[1]) / (i > 0 && i < path.length - 1 ? 2 : 1)
    const c = add(s.p, scale(s.n, proud - thick / 2))
    out.push(rounded({ ...between('ellipsoid', toWorld(f, sub(c, scale(along, step * 0.8))), toWorld(f, add(c, scale(along, step * 0.8))), wide * meanStretch(f), thick * meanStretch(f), dirToWorld(f, s.n)) }))
  }
  return out
}

// A path of (x, y) on the chest offset sideways from a spine path by `off` cm.
function offsetPath(spine: [number, number][], off: number): [number, number][] {
  return spine.map((p, i) => {
    const a = spine[Math.max(0, i - 1)]!
    const b = spine[Math.min(spine.length - 1, i + 1)]!
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l = Math.hypot(dx, dy) || 1
    return [p[0] - dy / l * off, p[1] + dx / l * off] as [number, number]
  })
}

function onSurface(masses: Ell[], path: [number, number][], lift: number, back = false): Vec3[] {
  return path.map(([x, y]) => {
    const s = surfaceAt(masses, x, y, back)
    return add(s.p, scale(s.n, lift))
  })
}

export function torsoParts(t: DeclaredShape, head: { frame: Frame, knobs: HeadKnobs } | null): Expanded {
  const s = torsoStyle(t.style, head?.knobs ?? null)
  const f = frameOf(t.center, t.size, TORSO, t.rotation)
  const k = meanStretch(f)
  const shapes: Shape[] = []
  const cuts: RoughCut[] = []
  const masses = trunk(s)
  const ells: Ell[] = []
  for (const m of masses) {
    for (const side of m.mirror ? [1, -1] : [1]) {
      const r = m.r ?? [0, 0, 0]
      const c: Vec3 = [side * m.e.c[0], m.e.c[1], m.e.c[2]]
      shapes.push(partShape(f, m.kind, c, scale(m.e.r, 2), [r[0], side * r[1], side * r[2]]))
      ells.push({ c, r: m.e.r })
    }
  }
  const cut = (label: string, tool: 'drill' | 'roundel', size: number, depth: number, points: Vec3[], dir: Vec3 | null = null) => {
    cuts.push({ label, tool, size: r3(size * k), depth: r3(depth * k), points: points.map(p => toWorld(f, p)), dir: dir ? dirToWorld(f, dir) : null })
  }
  const W = (p: Vec3) => toWorld(f, p)

  // The neck: from the trunk up into the head it carries, or a stump with no head.
  const notch: Vec3 = [0, 19.8, 8.4]
  if (head) {
    const h = head.frame
    const hw = 15.5 * h.stretch[0]
    const H = (p: Vec3) => toWorld(h, [p[0], p[1] + CHIN, p[2]])
    const thin = head.knobs.female ? 0.86 : 1
    const thick = (1 + 0.08 * s.build) * thin
    const base = W([0, 21, 0])
    const top = H([0, 7.5, -2.4])
    const forward = normalize(add(dirToWorld(h, [0, 0, 1]), dirToWorld(f, [0, 0, 1])))
    shapes.push(between('capsule', base, top, 0.64 * hw * thick, 0.7 * hw * thick, forward))
    for (const side of [1, -1]) {
      // Sternomastoid: from behind the ear to the top of the breastbone, the neck's front edge.
      shapes.push(between('capsule', W([side * 1.4, 19.8, 7.6]), H([side * 5.2, 8.8, -2.2]), 0.22 * hw * thick, 0.16 * hw * thick, forward))
      // Trapezius: from the back of the skull out to the shoulder.
      shapes.push(between('ellipsoid', H([side * 2.4, 9.6, -6.8]), W([side * 9, 22.5, -5.5]), 0.3 * hw * thick, 0.22 * hw * thick, normalize(sub(W([side * 9, 22, -5.5]), W([0, 22, -1.5])))))
    }
    if (!head.knobs.female) {
      const throat = lerp(W(notch), H([0, 1.0, 2.6]), 0.6)
      shapes.push(rounded({ kind: 'ellipsoid', center: add(throat, scale(forward, -0.05 * hw)), size: [0.13 * hw, 0.16 * hw, 0.12 * hw], rotation: [0, 0, 0] }))
    }
  } else {
    shapes.push(partShape(f, 'capsule', [0, 24, -1], [13, 14, 12]))
  }
  // The pit of the neck between the collarbones.
  if (s.drape !== 'collar') cut('pit of the neck', 'drill', 1.4, 0.7, [notch], [0, -0.3, -1])

  if (s.drape === 'bare' || s.drape === 'mantle') {
    // Collarbones, standing over the hollows above them.
    for (const side of [1, -1]) {
      const a = surfaceAt(ells, side * 2.4, 19.2)
      const b = surfaceAt(ells, side * 18.5, 19.6)
      shapes.push(between('capsule', W(add(a.p, scale(a.n, 0.3))), W(add(b.p, scale(b.n, 0.3))), 2.2 * k, 1.8 * k, dirToWorld(f, [0, 0.3, 1])))
      cut('collarbone', 'roundel', 1.0, 0.45, onSurface(ells, [[side * 4, 21.2], [side * 10, 21.6], [side * 16, 21.6]], 0))
    }
    if (!s.female) {
      cut('breastbone', 'roundel', 1.0, 0.35, onSurface(ells, [[0, 18], [0, 12], [0, 5.5]], 0))
      for (const side of [1, -1]) cut('pectoral', 'roundel', 1.0, 0.3, onSurface(ells, [[side * 2, 4.2], [side * 8, 3.2], [side * 14, 4.6], [side * 17.5, 8]], 0))
    }
  }
  // The spine down the back.
  cut('spine', 'roundel', 1.2, 0.35, onSurface(ells, [[0, 19], [0, 8], [0, -6], [0, -16]], 0, true))

  if (s.drape === 'mantle') {
    // A mantle over one shoulder, knotted there, falling across the chest to the other side of
    // the truncation and down the back: a thick length of cloth with three broad folds on it and
    // deep valleys between them. The shoulder is the one the head turns away from.
    const gaze: Vec3 = head ? dirToWorld(head.frame, [0, 0, 1]) : [0, 0, 1]
    const side = gaze[0] > 0.02 ? -1 : 1
    const spine: [number, number][] = [[side * 20, 16], [side * 13, 9], [side * 5, 0], [-side * 4, -8], [-side * 12, -14.5], [-side * 19, -19]]
    shapes.push(...cloth(f, ells, spine, 19, 5, 3.4))
    const offsets = [-4.6, 0.4, 5.2]
    offsets.forEach((o, i) => shapes.push(...fold(f, ells, offsetPath(spine.slice(1, 6), side * o), 4.2 + 0.6 * (i % 2), 5.6 - 0.5 * i)))
    for (const mid of [-2.1, 2.8]) cut('fold', 'roundel', 1.5, 2.0, onSurface(ells, offsetPath(spine.slice(1, 6), side * mid), 4.4))
    // The upper edge of the cloth, undercut so it stands off the chest in shadow.
    cut('hem', 'roundel', 1.2, 1.6, onSurface(ells, offsetPath(spine.slice(1), side * -9.2), 1.2), [0, -0.5, -0.86])
    // Over the shoulder and down the back.
    const backSpine: [number, number][] = [[side * 21, 17], [side * 17, 8], [side * 12, -3], [side * 8, -14]]
    shapes.push(...cloth(f, ells, backSpine, 17, 4.6, 3.2, true))
    for (const o of [-3.8, 2.6]) shapes.push(...fold(f, ells, offsetPath(backSpine, side * o), 4, 5, true))
    cut('fold', 'roundel', 1.4, 1.8, onSurface(ells, offsetPath(backSpine, side * -0.6), 4, true))
    // The knot on the shoulder.
    const knot = surfaceAt(ells, side * 18, 16.5)
    shapes.push(partShape(f, 'ellipsoid', add(knot.p, scale(knot.n, 3.4)), [8, 7, 6]))
    cut('knot', 'roundel', 1.0, 0.9, [add(add(knot.p, scale(knot.n, 6.2)), [-side * 1.8, 1.6, 0]), add(add(knot.p, scale(knot.n, 6.0)), [side * 1.2, -2.0, 0])])
  } else if (s.drape === 'collar') {
    // A buttoned coat with a collar round the neck and a falling band over it.
    for (let y = 14; y >= -16; y -= 5.5) {
      const b = surfaceAt(ells, 0, y)
      shapes.push(partShape(f, 'ellipsoid', add(b.p, scale(b.n, 0.4)), [2.4, 2.4, 1.6]))
    }
    for (const side of [1, -1]) cut('placket', 'roundel', 0.9, 0.6, onSurface(ells, [[side * 2.2, 17], [side * 2.4, 4], [side * 2.4, -18]], 0))
    const ring: Vec3[] = []
    for (let a = 0; a <= 360; a += 45) {
      const r = a * Math.PI / 180
      ring.push([Math.sin(r) * 9, 22 + 0.8 * Math.cos(r), -1.5 + Math.cos(r) * 8.5])
    }
    for (let i = 0; i + 1 < ring.length; i++) shapes.push(between('capsule', W(ring[i]!), W(ring[i + 1]!), 2.6 * k, 2.6 * k, dirToWorld(f, [0, 1, 0])))
    for (const side of [1, -1]) {
      const tab = surfaceAt(ells, side * 3, 15.5)
      shapes.push(partShape(f, 'box', add(tab.p, scale(tab.n, 0.9)), [5.4, 8, 1.2], [-10, 0, side * 5]))
    }
    cut('band', 'roundel', 0.8, 0.8, onSurface(ells, [[0, 20], [0, 11.5]], 1.4))
  }

  // The socle: a turned stem under the truncation, a moulding at each end and a square plinth,
  // upright and square to the block whatever the pose of the bust above it.
  if (s.socle) {
    const lowest = Math.min(...shapes.map(sh => sh.center[1] - Math.max(...sh.size) / 2))
    const bottom = Math.max(lowest, toWorld(f, [0, -23, 0])[1])
    const cx = t.center[0]
    const cz = t.center[2]
    const W2 = t.size[0]
    const D2 = t.size[2]
    const plinth = Math.min(5, Math.max(2.5, bottom * 0.25))
    shapes.push(rounded({ kind: 'box', center: [cx, plinth / 2, cz], size: [0.56 * W2, plinth, Math.min(0.56 * W2, 1.2 * D2)], rotation: [0, 0, 0] }))
    if (bottom - plinth > 3) {
      // A cone whose point is buried in the chest: wide at the plinth, narrowing up the stem.
      const tall = 2.4 * (bottom - plinth)
      shapes.push(rounded({ kind: 'cone', center: [cx, plinth + tall / 2, cz], size: [0.4 * W2, tall, 0.4 * W2], rotation: [0, 0, 0] }))
      shapes.push(rounded({ kind: 'ellipsoid', center: [cx, plinth + 1.2, cz], size: [0.46 * W2, 2.6, 0.46 * W2], rotation: [0, 0, 0] }))
    }
    shapes.push(rounded({ kind: 'ellipsoid', center: [cx, bottom + 0.4, cz], size: [0.36 * W2, 2.6, 0.36 * W2], rotation: [0, 0, 0] }))
  }
  return { shapes, cuts }
}
