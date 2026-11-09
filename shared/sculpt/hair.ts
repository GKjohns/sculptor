// Hair and beard for the canon head (anatomy.ts), in the head's own frame (cm of the canon head,
// y from the chin). Hair is carved as a carver carves it: separate locks or curls standing
// two centimetres or so off the skull, the valleys between them running down to it, curl
// centres drilled and strands grooved. Nothing here is a cap: a cap reads as a helmet.

import type { HeadKnobs, Part, PartCut } from './anatomy.ts'
import { add, cross, eulerFromY, eulerFromZ, normalize, scale, sub } from './frame.ts'
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

// Curls: round locks standing off the skull, each with its centre drilled. `size` is a curl's
// width, `proud` how far its crown stands off the skull, `count` the lattice's size over the
// whole sphere (the hair keeps those inside the hairline).
function curls(size: number, proud: number, count: number, drill: boolean, below = 0): Hair {
  const parts: Part[] = []
  const cuts: PartCut[] = []
  const depth = 0.62 * size
  for (const [a, e] of spread(count, (a, e) => e >= hairline(a) - below)) {
    const { p, n } = skullAt(a, e)
    // The curl's flat side lies on the skull; it leans down the head, as hair falls.
    const c = add(p, scale(n, proud - depth / 2))
    parts.push({ kind: 'ellipsoid', c, s: [size, size * 0.92, depth], r: eulerFromZ(n, [0, 1, 0]) })
    if (drill) cuts.push({ label: 'curl', tool: 'drill', size: 0.16 * size, depth: 0.32 * size, points: [add(p, scale(n, proud))], dir: scale(n, -1) })
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
      parts.push({ kind: 'capsule', c: mid, s: [thick * 1.25 * taper, len + thick, thick * taper], r: eulerFromY(along, normals[i]!) })
    }
    // A strand groove along the tress, a little to one side of its crest.
    const groove = chain.map((p, i) => {
      const side = normalize(cross(normals[i]!, sub(chain[Math.min(i + 1, n)]!, chain[Math.max(i - 1, 0)]!)))
      return add(add(p, scale(normals[i]!, thick / 2)), scale(side, 0.18 * thick))
    })
    cuts.push({ label: 'strand', tool: 'roundel', size: 0.22 * thick, depth: 0.16 * thick, points: groove, dir: null })
  }
  return { parts, cuts }
}

function beard(k: HeadKnobs): Hair {
  const parts: Part[] = []
  const cuts: PartCut[] = []
  if (k.beard) {
    const centre: Vec3 = [0, 6.0, -1.0]
    const spots: Vec3[] = [
      [6.9, 9.4, -0.6], [6.7, 6.8, 0.6], [6.0, 4.2, 2.4], [4.7, 2.0, 4.2], [2.5, 0.6, 5.6], [0, 0.1, 6.2],
      [5.4, 1.6, 1.4], [3.6, -0.4, 3.4], [1.3, -1.2, 4.6], [5.0, 6.4, 3.6], [3.9, 4.0, 5.1]
    ]
    for (const s of spots) {
      for (const side of s[0] === 0 ? [1] : [1, -1]) {
        const p: Vec3 = [side * s[0], s[1], s[2]]
        const n = normalize(sub(p, centre))
        parts.push({ kind: 'ellipsoid', c: add(p, scale(n, 0.3)), s: [3.0, 2.8, 2.0], r: eulerFromZ(n, [0, 1, 0]) })
        cuts.push({ label: 'beard curl', tool: 'drill', size: 0.5, depth: 0.8, points: [add(p, scale(n, 1.3))], dir: scale(n, -1) })
      }
    }
  }
  if (k.moustache) {
    for (const side of [1, -1]) {
      parts.push({ kind: 'capsule', c: [side * 1.45, 6.75, 8.15], s: [1.0, 2.9, 0.8], r: [0, side * -20, side * 68] })
      parts.push({ kind: 'capsule', c: [side * 2.85, 5.85, 7.0], s: [0.85, 1.9, 0.75], r: [0, side * -40, side * 25] })
    }
  }
  return { parts, cuts }
}

// The hair the style asks for, and the beard.
export function hairParts(k: HeadKnobs): Hair {
  let hair: Hair = { parts: [], cuts: [] }
  switch (k.hair) {
    case 'curls':
      hair = curls(3.6, 1.9, 82, true)
      break
    case 'long':
      hair = curls(3.6, 1.9, 82, true, 14)
      break
    case 'short':
      hair = curls(3.0, 1.0, 118, false)
      break
    case 'waves':
      // Combed forward and down from the crown, as Roman and Baroque portraits wear it.
      hair = locks(20, 2.4, 1.9, a => [a, 70], a => [a, hairline(a) + 3], 7)
      break
    case 'bun': {
      // Drawn back from the hairline over the head into a knot at the back.
      const back = locks(22, 2.2, 1.6, a => [a, hairline(a) + 2], a => [a * 0.35 + (a < 0 ? -180 : 180) * 0.65, 18], 4)
      hair = { parts: [...back.parts, { kind: 'ellipsoid', c: [0, 15.5, -11.6], s: [6.6, 5.8, 4.8] }], cuts: back.cuts }
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
