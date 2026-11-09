// Hair and beard for the canon head (anatomy.ts), in the head's own frame (cm of the canon head,
// y from the chin). Hair is carved as a carver carves it: separate locks or curls standing
// two centimetres or so off the skull, the valleys between them running down to it, curl
// centres drilled and strands grooved. Nothing here is a cap: a cap reads as a helmet.

import type { HeadKnobs, Part, PartCut } from './anatomy.ts'
import { add, cross, eulerFromY, normalize, scale, sub } from './frame.ts'
import type { Vec3 } from './types.ts'

// The skull the hair lies on: cranium and frontal bone, as in anatomy.ts's face parts.
const CRANIUM = { c: [0, 15.0, -0.8] as Vec3, r: [7.75, 8.25, 9.5] as Vec3 }
const FRONTAL = { c: [0, 16.5, 4.8] as Vec3, r: [7.1, 5.25, 4.3] as Vec3 }
const ORIGIN: Vec3 = [0, 15.0, -0.8]

const DEG = Math.PI / 180

// Where a ray from the skull's centre leaves an ellipsoid, or -1.
function leave(c: Vec3, r: Vec3, d: Vec3): number {
  const o = sub(ORIGIN, c)
  const ox = o[0] / r[0]
  const oy = o[1] / r[1]
  const oz = o[2] / r[2]
  const dx = d[0] / r[0]
  const dy = d[1] / r[1]
  const dz = d[2] / r[2]
  const a = dx * dx + dy * dy + dz * dz
  const b = 2 * (ox * dx + oy * dy + oz * dz)
  const cc = ox * ox + oy * oy + oz * oz - 1
  const disc = b * b - 4 * a * cc
  if (disc < 0) return -1
  return (-b + Math.sqrt(disc)) / (2 * a)
}

// The skull's surface in the direction (azimuth a from the face toward +X, elevation e above the
// skull's middle), degrees: the point and the outward normal there.
export function skullAt(a: number, e: number): { p: Vec3, n: Vec3 } {
  const d: Vec3 = [Math.cos(e * DEG) * Math.sin(a * DEG), Math.sin(e * DEG), Math.cos(e * DEG) * Math.cos(a * DEG)]
  const t1 = leave(CRANIUM.c, CRANIUM.r, d)
  const t2 = leave(FRONTAL.c, FRONTAL.r, d)
  const use = t2 > t1 ? FRONTAL : CRANIUM
  const p = add(ORIGIN, scale(d, Math.max(t1, t2)))
  const q = sub(p, use.c)
  return { p, n: normalize([q[0] / (use.r[0] * use.r[0]), q[1] / (use.r[1] * use.r[1]), q[2] / (use.r[2] * use.r[2])]) }
}

// The lowest elevation the hair comes to at each azimuth: the hairline over the forehead, the
// temples, above the ear, behind it and down to the nape.
const HAIRLINE: [number, number][] = [[0, 24], [30, 20], [55, 8], [75, -6], [95, -13], [120, -30], [150, -46], [180, -52]]
export function hairline(a: number): number {
  const x = Math.abs(((a + 540) % 360) - 180)
  for (let i = 1; i < HAIRLINE.length; i++) {
    const [a1, e1] = HAIRLINE[i]!
    if (x <= a1) {
      const [a0, e0] = HAIRLINE[i - 1]!
      return e0 + (e1 - e0) * (x - a0) / (a1 - a0)
    }
  }
  return HAIRLINE[HAIRLINE.length - 1]![1]
}

// Points spread evenly over the sphere of directions (a Fibonacci lattice), as azimuth and
// elevation in degrees, kept where `keep` says.
function spread(count: number, keep: (a: number, e: number) => boolean): [number, number][] {
  const out: [number, number][] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = 1 - 2 * (i + 0.5) / count
    const phi = i * golden
    const rad = Math.sqrt(1 - y * y)
    const a = Math.atan2(rad * Math.cos(phi), rad * Math.sin(phi)) / DEG
    const e = Math.asin(y) / DEG
    if (keep(a, e)) out.push([a, e])
  }
  return out
}

interface Hair { parts: Part[], cuts: PartCut[] }

// Each lock stays crisp against its neighbours and the mass under it, so the valleys between
// locks read whatever blend the form has (canon cm).
const LOCK_K = 0.22

// The way hair falls at a point of the skull: away from the whorl on the crown and down, laid
// flat on the skull (a unit vector in its tangent plane).
const WHORL = skullAt(180, 52).p
function flow(p: Vec3, n: Vec3): Vec3 {
  const away = sub(p, WHORL)
  const raw = add(normalize(away), [0, -0.55, 0.15])
  const t = sub(raw, scale(n, raw[0] * n[0] + raw[1] * n[1] + raw[2] * n[2]))
  return normalize(t)
}

// The mass the locks lie on: the skull grown by `proud` over the top and back, kept off the
// forehead and the ears by being smaller than the hairline there would need.
function cap(proud: number): Part[] {
  return [
    { kind: 'ellipsoid', c: [0, 16.2, -1.5], s: [15.5 + 2 * proud, 15.2 + proud, 18.6 + 2 * proud] },
    { kind: 'ellipsoid', c: [0, 18.2, 2.4], s: [13.6 + 2 * proud, 9.0 + proud, 10.4 + proud] }
  ]
}

// Locks: tresses lying on the skull from each point of a lattice down the way the hair falls,
// each in two pieces whose tip turns aside by `hook` degrees (a curl, when the turn is large),
// alternately left and right. `width` across, `thick` through, the crest `proud` off the skull,
// `length` for the first piece (the tip is six tenths of it). With `drill`, the eye of each curl
// is drilled, as Roman and Baroque carvers drilled theirs. `below` lets the locks come further
// down than the hairline (long hair).
function hooks(count: number, width: number, thick: number, proud: number, length: number, hook: number, drill: boolean, below = 0): Hair {
  const parts: Part[] = []
  const cuts: PartCut[] = []
  let n = 0
  for (const [a, e] of spread(count, (a, e) => e >= hairline(a) - below + 4)) {
    const s = skullAt(a, e)
    const f = flow(s.p, s.n)
    const side = normalize(cross(s.n, f))
    const turn = (n++ % 2 === 0 ? 1 : -1) * (a > 0 ? 1 : -1)
    const c0 = add(s.p, scale(s.n, proud - thick / 2))
    const c1 = add(c0, scale(f, length))
    const tipDir = normalize(add(scale(f, Math.cos(hook * DEG)), scale(side, turn * Math.sin(hook * DEG))))
    const c2 = add(add(c1, scale(tipDir, 0.6 * length)), scale(s.n, -0.25 * thick))
    parts.push({ kind: 'capsule', c: scale(add(c0, c1), 0.5), s: [width, length + width, thick], r: eulerFromY(sub(c1, c0), s.n), k: LOCK_K })
    parts.push({ kind: 'capsule', c: scale(add(c1, c2), 0.5), s: [0.8 * width, 0.6 * length + 0.8 * width, 0.85 * thick], r: eulerFromY(sub(c2, c1), s.n), k: LOCK_K })
    if (drill) {
      const eye = add(add(c1, scale(side, -turn * 0.45 * width)), scale(s.n, 0.3 * thick))
      cuts.push({ label: 'curl', tool: 'drill', size: 0.32 * width, depth: 0.6 * thick, points: [eye], dir: scale(s.n, -1) })
    }
  }
  return { parts, cuts }
}

// Locks: tresses that run from `from` to the hairline (or to `to` when given), each a chain of
// tubes with a groove along it. Azimuths every `step` degrees.
function locks(step: number, thick: number, proud: number, start: (a: number) => [number, number], end: (a: number) => [number, number], wave: number): Hair {
  const parts: Part[] = []
  const cuts: PartCut[] = []
  for (let a = -180 + step / 2; a < 180; a += step) {
    const [a0, e0] = start(a)
    const [a1, e1] = end(a)
    const chain: Vec3[] = []
    const normals: Vec3[] = []
    const n = 4
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const s = skullAt(a0 + (a1 - a0) * t + wave * Math.sin(Math.PI * 2 * t + a * DEG), e0 + (e1 - e0) * t)
      chain.push(add(s.p, scale(s.n, proud - thick / 2)))
      normals.push(s.n)
    }
    for (let i = 0; i < n; i++) {
      const p = chain[i]!
      const q = chain[i + 1]!
      const mid = scale(add(p, q), 0.5)
      const along = sub(q, p)
      const len = Math.sqrt(along[0] * along[0] + along[1] * along[1] + along[2] * along[2])
      // A tress is wider than it is thick, and thins toward its end.
      const taper = 1 - 0.18 * i / n
      parts.push({ kind: 'capsule', c: mid, s: [thick * 1.25 * taper, len + thick, thick * taper], r: eulerFromY(along, normals[i]!), k: LOCK_K })
    }
    // A strand groove along the tress, a little to one side of its crest.
    const groove = chain.map((p, i) => {
      const side = normalize(cross(normals[i]!, sub(chain[Math.min(i + 1, n)]!, chain[Math.max(i - 1, 0)]!)))
      return add(add(p, scale(normals[i]!, thick / 2)), scale(side, 0.18 * thick))
    })
    cuts.push({ label: 'strand', tool: 'roundel', size: Math.max(0.3, 0.22 * thick), depth: 0.16 * thick, points: groove, dir: null })
  }
  return { parts, cuts }
}

function beard(k: HeadKnobs): Hair {
  const parts: Part[] = []
  const cuts: PartCut[] = []
  if (k.beard) {
    // Short locks over the jaw and chin, falling down and curling at their tips, on a mass that
    // follows the jaw.
    const centre: Vec3 = [0, 6.0, -1.0]
    parts.push({ kind: 'ellipsoid', c: [0, 2.6, 2.6], s: [12.4, 6.4, 10.4] })
    const spots: Vec3[] = [
      [6.9, 9.4, -0.6], [6.7, 6.8, 0.6], [6.0, 4.2, 2.4], [4.7, 2.0, 4.2], [2.5, 0.6, 5.6], [0, 0.1, 6.2],
      [5.4, 1.6, 1.4], [3.6, -0.4, 3.4], [1.3, -1.2, 4.6]
    ]
    let i = 0
    for (const s of spots) {
      for (const side of s[0] === 0 ? [1] : [1, -1]) {
        const p: Vec3 = [side * s[0], s[1], s[2]]
        const n = normalize(sub(p, centre))
        const down = normalize(sub([0, -1, 0.15], scale(n, -n[1] + 0.15 * n[2])))
        const sideways = normalize(cross(n, down))
        const turn = (i++ % 2 === 0 ? 1 : -1) * side
        const c0 = add(p, scale(n, 0.6))
        const c1 = add(c0, scale(down, 2.2))
        const c2 = add(c1, scale(normalize(add(scale(down, 0.3), scale(sideways, turn))), 1.3))
        parts.push({ kind: 'capsule', c: scale(add(c0, c1), 0.5), s: [2.4, 4.6, 1.4], r: eulerFromY(sub(c1, c0), n), k: LOCK_K })
        parts.push({ kind: 'capsule', c: scale(add(c1, c2), 0.5), s: [1.8, 3.1, 1.2], r: eulerFromY(sub(c2, c1), n), k: LOCK_K })
        cuts.push({ label: 'beard curl', tool: 'drill', size: 0.5, depth: 0.7, points: [add(add(c1, scale(sideways, -turn * 0.9)), scale(n, 0.5))], dir: scale(n, -1) })
      }
    }
  }
  if (k.moustache) {
    for (const side of [1, -1]) {
      parts.push({ kind: 'capsule', c: [side * 1.45, 6.75, 8.15], s: [1.0, 2.9, 0.8], r: [0, side * -20, side * 68], k: LOCK_K })
      parts.push({ kind: 'capsule', c: [side * 2.85, 5.85, 7.0], s: [0.85, 1.9, 0.75], r: [0, side * -40, side * 25], k: LOCK_K })
    }
  }
  return { parts, cuts }
}

// The hair the style asks for, and the beard.
export function hairParts(k: HeadKnobs): Hair {
  let hair: Hair = { parts: [], cuts: [] }
  switch (k.hair) {
    case 'curls': {
      const h = hooks(84, 3.0, 1.5, 2.3, 2.5, 90, true)
      hair = { parts: [...cap(0.8), ...h.parts], cuts: h.cuts }
      break
    }
    case 'long': {
      const h = hooks(70, 3.0, 1.5, 2.2, 3.4, 40, false, 16)
      hair = { parts: [...cap(0.9), ...h.parts], cuts: h.cuts }
      break
    }
    case 'short': {
      const h = hooks(110, 2.3, 1.0, 1.7, 1.9, 25, false)
      hair = { parts: [...cap(0.3), ...h.parts], cuts: h.cuts }
      break
    }
    case 'waves': {
      // Combed forward and down from the crown, as Roman and Baroque portraits wear it.
      const w = locks(24, 2.6, 1.9, a => [a, 70], a => [a, hairline(a) + 3], 7)
      hair = { parts: [...cap(0.8), ...w.parts], cuts: w.cuts }
      break
    }
    case 'bun': {
      // Drawn back from the hairline over the head into a knot at the back.
      const back = locks(20, 2.3, 2.0, a => [a, hairline(a) + 2], a => [a * 0.35 + (a < 0 ? -180 : 180) * 0.65, 18], 4)
      hair = { parts: [...cap(0.4), ...back.parts, { kind: 'ellipsoid', c: [0, 15.5, -11.6], s: [6.6, 5.8, 4.8], k: LOCK_K }], cuts: back.cuts }
      for (const [r, y] of [[2.6, 16.6], [2.4, 14.4]] as [number, number][]) {
        hair.cuts.push({ label: 'bun', tool: 'roundel', size: 0.6, depth: 0.5, points: [[-r, y, -13.2], [-r / 2, y + 0.4, -13.8], [r / 2, y - 0.4, -13.8], [r, y, -13.2]], dir: null })
      }
      break
    }
    case 'bald':
      break
  }
  const b = beard(k)
  return { parts: [...hair.parts, ...b.parts], cuts: [...hair.cuts, ...b.cuts] }
}
