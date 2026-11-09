// The sculptor's canon: solids the model can declare that stand for a whole anatomical part
// and expand, before anything reaches the kernel, into the kernel's own primitives, plus the
// lines and drill points a carver cuts into such a part once it stands (canon cuts).
//
// - `head`: a skull with its face on it, built the way a clay head is built up, by adding
//   masses: eyes as balls under their lids, a nose with bridge, tip and wings, lips, chin, jaw,
//   ears with a rim and a lobe, and hair in locks or curls (hair.ts).
// - `torso`: neck, shoulders, chest and back down to a bust's truncation, with drapery and a
//   socle (torso.ts). A head and a torso declared in the same form are joined by a neck of
//   muscle that follows the head's turn.
//
// Both take `style` tokens (who the sitter is, the expression, the hair, the drapery), so faces
// are not siblings. The form stays a plain smooth union and the log never sees a kind the kernel
// does not know. What a union cannot hold, a hollow, is a canon cut: an iris ringed, a pupil
// drilled, the lips parted, nostrils, the valleys between locks and folds. Cuts ride on the
// form's log entry (the kernel ignores them) and `detail` carves those that lie in its window,
// as ordinary strikes.
//
// The model places, sizes and poses each part; everything here is in a part of the reference
// proportions below, scaled per axis to the one declared.

import { compileForm, formDistance } from './shapes.ts'
import type { CanonCut, CompiledForm, Shape, ShapeKind, Vec3 } from './types.ts'
import { add, dirToWorld, dot, frameOf, length, lerp, meanStretch, normalize, partShape, r3, scale, sub, toWorld } from './frame.ts'
import type { Frame } from './frame.ts'
import { hairParts } from './hair.ts'
import { torsoParts } from './torso.ts'

export type CanonKind = 'head' | 'torso'
export type DeclaredKind = ShapeKind | CanonKind

export const STYLE_TOKENS = [
  // Who: sex, age, build.
  'male', 'female', 'young', 'mature', 'old', 'lean', 'heavy',
  // The face.
  'square_jaw', 'narrow_jaw', 'straight_nose', 'aquiline_nose', 'snub_nose', 'broad_nose',
  // Expression and glance.
  'calm', 'lips_parted', 'smile', 'raised_brow', 'frown', 'gaze_left', 'gaze_right', 'gaze_up', 'gaze_down',
  // Hair and beard.
  'bald', 'short_hair', 'curls', 'waves', 'long_hair', 'bun', 'beard', 'moustache',
  // The torso: drapery and what it stands on.
  'bare', 'mantle', 'collar', 'socle', 'no_socle'
] as const
export type StyleToken = typeof STYLE_TOKENS[number]

export interface DeclaredShape extends Omit<Shape, 'kind'> {
  kind: DeclaredKind
  style?: StyleToken[]
}

export type { CanonCut }

// A cut before it is settled on the surface: rough points, and a direction into the stone
// (null: straight in, along the surface's inward normal).
export interface RoughCut {
  label: string
  tool: 'drill' | 'roundel'
  size: number
  depth: number
  points: Vec3[]
  dir: Vec3 | null
}

// ---------- the head ----------

// The canon head, cm: width between the temples, chin to crown, brow to the back of the skull.
export const HEAD: Vec3 = [15.5, 23, 19.5]
// Where the chin sits in the canon's own frame, whose origin is the centre of the skull box.
export const CHIN = -HEAD[1] / 2

export interface HeadKnobs {
  female: boolean
  // 0 young, 1 mature, 2 old.
  age: number
  // -1 lean, 0, 1 heavy.
  build: number
  // -1 narrow, 0, 1 square.
  jaw: number
  nose: 'straight' | 'aquiline' | 'snub' | 'broad'
  parted: boolean
  smile: boolean
  raised: boolean
  frown: boolean
  // Degrees: toward +X (the viewer's right), and up.
  gaze: [number, number]
  hair: 'bald' | 'short' | 'curls' | 'waves' | 'long' | 'bun'
  beard: boolean
  moustache: boolean
}

export function headKnobs(style: readonly string[] = []): HeadKnobs {
  const has = (t: StyleToken) => style.includes(t)
  const hair = has('bald') ? 'bald' : has('bun') ? 'bun' : has('long_hair') ? 'long' : has('waves') ? 'waves' : has('curls') ? 'curls' : has('short_hair') ? 'short' : 'curls'
  return {
    female: has('female'),
    age: has('young') ? 0 : has('old') ? 2 : 1,
    build: has('lean') ? -1 : has('heavy') ? 1 : 0,
    jaw: has('narrow_jaw') ? -1 : has('square_jaw') ? 1 : 0,
    nose: has('aquiline_nose') ? 'aquiline' : has('snub_nose') ? 'snub' : has('broad_nose') ? 'broad' : 'straight',
    parted: has('lips_parted'),
    smile: has('smile'),
    raised: has('raised_brow'),
    frown: has('frown'),
    gaze: [(has('gaze_right') ? 16 : 0) - (has('gaze_left') ? 16 : 0), (has('gaze_up') ? 10 : 0) - (has('gaze_down') ? 10 : 0)],
    hair,
    beard: has('beard'),
    moustache: has('moustache') || has('beard')
  }
}

// A part in the canon frame: y measured from the chin; mirrored parts listed once at +x.
export interface Part { kind: ShapeKind, c: Vec3, s: Vec3, r?: Vec3, mirror?: boolean }
const P = (kind: ShapeKind, c: Vec3, s: Vec3, r: Vec3 = [0, 0, 0], mirror = false): Part => ({ kind, c, s, r, mirror })
const M = (kind: ShapeKind, c: Vec3, s: Vec3, r: Vec3 = [0, 0, 0]): Part => P(kind, c, s, r, true)

// A cut in the canon frame: points with y from the chin, a direction or null for the normal.
export interface PartCut { label: string, tool: 'drill' | 'roundel', size: number, depth: number, points: Vec3[], dir: Vec3 | null, mirror?: boolean }

// Eye geometry shared by the parts and the cuts.
const EYE = { x: 3.15, y: 11.35, z: 6.25, r: 1.25, inner: 1.6, outer: 1.55, upper: 11.77, lower: 10.8 }

function faceParts(k: HeadKnobs): Part[] {
  const f = k.female ? 1 : 0
  const old = k.age === 2 ? 1 : 0
  const young = k.age === 0 ? 1 : 0
  const brow = k.raised ? 0.5 : k.frown ? -0.3 : 0
  const jawW = 1 + 0.08 * k.jaw - 0.07 * f
  const parted = k.parted ? 0.4 : 0
  const smile = k.smile ? 1 : 0
  const nose = k.nose
  const parts: Part[] = [
    // The skull: cranium, the frontal bone standing a little proud of it.
    P('ellipsoid', [0, 15.0, -0.8], [15.5, 16.5, 19.0]),
    P('ellipsoid', [0, 16.5 + 0.2 * f, 4.8 - 0.2 * old], [14.2 - 0.6 * old, 10.5, 8.6]),
    // Brows: the ridge over each eye, lifted, knitted or plain.
    M('ellipsoid', [3.2 - (k.frown ? 0.3 : 0), 13.1 + brow + 0.2 * f, 6.9 - 0.35 * f], [6.2, 2.4 - 0.4 * f, 3.2], [0, 0, k.raised ? -14 : k.frown ? -2 : -8]),
    // The face: one mass from brow to mouth that is the floor of the sockets.
    P('ellipsoid', [0, 9.6, 2.2], [14.2 - 0.5 * f, 11.0, 11.0]),
    // Cheekbones, high and hard; the soft cheek under them beside the mouth, which meets the
    // muzzle in the fold from nose to mouth.
    M('ellipsoid', [4.6, 10.3 + 0.25 * f + 0.2 * smile, 4.6 + 0.2 * old], [5.0, 3.6, 4.4]),
    M('ellipsoid', [3.7 + 0.2 * k.build, 7.9 + 0.5 * smile - 0.5 * old, 5.0 + 0.3 * smile + 0.2 * young], [3.4 + 0.6 * k.build + 0.3 * young - 0.4 * old, 3.6, 3.4 + 0.4 * k.build - 0.5 * old]),
    // The eyes: a ball, an upper lid over its top and a lower lid under it.
    M('ellipsoid', [EYE.x, EYE.y, EYE.z], [2 * EYE.r, 2 * EYE.r, 2 * EYE.r]),
    M('ellipsoid', [EYE.x, 12.2 + 0.1 * brow, 6.35], [3.5, 1.5, 2.7], [0, 0, -4]),
    M('ellipsoid', [EYE.x, 10.65, 6.2], [3.2, 1.0, 2.5], [0, 0, 3]),
    // The muzzle, the arch of the teeth under the lips.
    P('ellipsoid', [0, 6.3 - 0.5 * parted, 5.2], [8.0 - 0.4 * f, 5.0 + parted, 5.6]),
    // The nose: a cone from the root down and forward to the tip, the tip, the wings.
    P('cone', [0, 10.0 + (nose === 'snub' ? 0.2 : 0), 8.9], [2.6 - 0.2 * f, nose === 'snub' ? 5.2 : 5.8, 2.6], [nose === 'snub' ? -38 : -34, 0, 0]),
    P('ellipsoid', [0, 8.2 + (nose === 'snub' ? 0.35 : nose === 'aquiline' ? -0.25 : 0), 9.3 + (nose === 'snub' ? -0.4 : nose === 'aquiline' ? 0.1 : 0)], nose === 'broad' ? [3.7, 2.8, 3.1] : [3.2 - 0.3 * f, 2.6, 3.0]),
    M('ellipsoid', [nose === 'broad' ? 1.55 : 1.3 - 0.1 * f, 7.8, 8.6], nose === 'broad' ? [2.3, 2.0, 2.4] : [1.9, 1.8, 2.3]),
    // The mouth: an upper lip in two halves that dip where they meet, a lower lip, the chin.
    M('ellipsoid', [1.25, 6.6 + 0.15 * smile, 6.9], [3.3, 2.2 + 0.25 * f, 3.6 + 0.2 * f], [0, 0, smile ? -14 : -9]),
    P('ellipsoid', [0, 4.9 - parted, 6.6 - 0.2 * parted], [4.8, 1.8 + 0.3 * f, 3.4 + 0.25 * f]),
    P('ellipsoid', [0, 2.6 - 0.6 * parted, 5.4 - 0.3 * parted], [6.4 - 0.5 * f + 0.6 * k.jaw, 4.6 - 0.4 * f, 5.0]),
    // The jaw: widest under the ears, narrowing to the chin, with its angles.
    P('ellipsoid', [0, 4.6 - 0.5 * parted, 1.6], [10.6 * jawW, 8.0, 11.0]),
    M('ellipsoid', [5.4 * jawW, 4.4 - 0.3 * old, -1.4], [2.6 + 0.4 * k.jaw, 4.4, 4.6]),
    // Ears: a flat shell with a rim round its top and back, a lobe and the knob before the hole.
    M('ellipsoid', [7.35, 10.4, -1.9], [0.9, 5.6 + 0.4 * old, 3.3], [-12, 0, 0]),
    M('capsule', [7.75, 12.2, -1.9], [0.75, 2.6, 0.75], [-12, 0, 0]),
    M('capsule', [7.85, 12.1, -3.15], [0.75, 4.2, 0.75], [-12, 0, 0]),
    M('ellipsoid', [7.6, 7.85 - 0.3 * old, -2.3], [0.9, 1.6 + 0.3 * old, 1.4]),
    M('ellipsoid', [7.65, 9.9, -0.45], [0.6, 0.9, 0.6])
  ]
  if (nose === 'aquiline') parts.push(P('ellipsoid', [0, 10.4, 9.25], [1.5, 1.6, 1.4]))
  // Age: bags under the eyes, a slack under the jaw.
  if (old) parts.push(M('ellipsoid', [EYE.x, 10.1, 5.85], [3.2, 1.2, 2.2]))
  return parts
}

function faceCuts(k: HeadKnobs): PartCut[] {
  const cuts: PartCut[] = []
  const smile = k.smile ? 1 : 0
  const parted = k.parted ? 0.4 : 0
  // The eye: the iris ringed where the lids leave it open, the pupil drilled in its upper half
  // as a crescent under the lid (a carver's pupil, a bridge of stone left as the highlight),
  // the lid lines and the tear duct.
  const yaw = k.gaze[0] * Math.PI / 180
  const pitch = k.gaze[1] * Math.PI / 180
  const gaze: Vec3 = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]
  const across = normalize([gaze[2], 0, -gaze[0]])
  const up = normalize([-gaze[0] * gaze[1], gaze[0] * gaze[0] + gaze[2] * gaze[2], -gaze[2] * gaze[1]])
  for (const side of [1, -1]) {
    const centre: Vec3 = [side * EYE.x, EYE.y, EYE.z]
    // The gaze is the same for both eyes; the mirror flips only the eye's own position.
    const g: Vec3 = gaze
    const onBall = (angle: number, radius: number): Vec3 => {
      const a = Math.asin(Math.min(0.95, radius / EYE.r))
      const dir = add(scale(g, Math.cos(a)), add(scale(across, Math.sin(a) * Math.cos(angle)), scale(up, Math.sin(a) * Math.sin(angle))))
      return add(centre, scale(dir, EYE.r))
    }
    const ring: Vec3[] = []
    for (let i = 0; i <= 16; i++) {
      const p = onBall(i / 16 * 2 * Math.PI, 0.62)
      if (p[1] < EYE.upper - 0.12 && p[1] > EYE.lower + 0.08) ring.push(p)
      else if (ring.length > 0) {
        cuts.push({ label: 'iris', tool: 'roundel', size: 0.3, depth: 0.2, points: ring.splice(0), dir: null })
      }
    }
    if (ring.length > 0) cuts.push({ label: 'iris', tool: 'roundel', size: 0.3, depth: 0.2, points: ring, dir: null })
    const pupil: Vec3[] = []
    for (const a of [35, 90, 145]) pupil.push(onBall(a * Math.PI / 180, 0.2))
    cuts.push({ label: 'pupil', tool: 'drill', size: 0.42, depth: 0.5, points: pupil, dir: scale(g, -1) })
    // Lid lines from the inner corner to the outer, along the edge of each lid.
    const inner = centre[0] - side * EYE.inner
    const outer = centre[0] + side * EYE.outer
    const lid = (y0: number, sag: number): Vec3[] => {
      const out: Vec3[] = []
      for (let i = 0; i <= 8; i++) {
        const t = i / 8
        const x = inner + (outer - inner) * t
        const y = y0 + sag * Math.sin(Math.PI * Math.pow(t, 0.85)) - 0.15 * t
        out.push([x, y, centre[2] + EYE.r * 0.9])
      }
      return out
    }
    cuts.push({ label: 'upper lid', tool: 'roundel', size: 0.3, depth: 0.22, points: lid(EYE.upper - 0.35, 0.4), dir: null })
    cuts.push({ label: 'lower lid', tool: 'roundel', size: 0.26, depth: 0.14, points: lid(EYE.lower + 0.15, -0.2), dir: null })
    cuts.push({ label: 'tear duct', tool: 'drill', size: 0.32, depth: 0.3, points: [[inner + side * 0.05, EYE.y - 0.1, centre[2] + 0.9]], dir: normalize([side * 0.35, 0, -1]) })
    // Nostril, under the wing, bored up and back.
    cuts.push({ label: 'nostril', tool: 'drill', size: 0.55, depth: 0.75, points: [[side * 0.7, 7.05, 8.9]], dir: normalize([side * 0.15, 0.8, -0.55]) })
    // The fold from the wing of the nose to beside the mouth: deeper with age and a smile.
    const fold = [0.08, 0.16, 0.34][k.age]! + 0.12 * smile
    cuts.push({ label: 'nasolabial', tool: 'roundel', size: 0.5, depth: fold, points: [[side * 2.05, 8.15, 7.3], [side * 2.55, 7.0, 7.0], [side * 2.85, 5.9 + 0.3 * smile, 6.4], [side * 2.95, 4.9 + 0.3 * smile, 5.9]], dir: null })
    // The corner of the mouth, drilled.
    cuts.push({ label: 'mouth corner', tool: 'drill', size: 0.38, depth: 0.45 + parted, points: [[side * 2.55, 5.6 - parted / 2 + 0.3 * smile, 6.8]], dir: normalize([-side * 0.3, 0, -1]) })
    // The ear: the bowl inside the rim, and the hole.
    cuts.push({ label: 'ear', tool: 'roundel', size: 0.4, depth: 0.28, points: [[side * 7.8, 12.0, -1.5], [side * 7.85, 12.0, -2.5], [side * 7.9, 11.0, -3.0], [side * 7.85, 9.8, -2.9]], dir: [-side, 0, 0] })
    cuts.push({ label: 'ear hole', tool: 'drill', size: 0.75, depth: 0.55, points: [[side * 7.75, 10.1, -1.5]], dir: normalize([-side, 0, -0.25]) })
    if (k.frown) cuts.push({ label: 'frown line', tool: 'roundel', size: 0.3, depth: 0.2, points: [[side * 0.55, 12.4, 8.4], [side * 0.7, 13.6, 8.6]], dir: null })
  }
  // The parting of the lips: a dark line, or a slot when they are open.
  const mouth: Vec3[] = []
  for (let i = 0; i <= 10; i++) {
    const x = -2.5 + 5 * i / 10
    const t = x / 2.5
    mouth.push([x, 5.6 - parted / 2 - 0.12 * t * t + 0.45 * smile * t * t + 0.06 * Math.cos(Math.PI * t), 7.6])
  }
  cuts.push({ label: 'mouth', tool: 'roundel', size: k.parted ? 0.55 : 0.32, depth: k.parted ? 0.9 : 0.32, points: mouth, dir: [0, 0, -1] })
  cuts.push({ label: 'philtrum', tool: 'roundel', size: 0.45, depth: 0.12, points: [[0, 7.25, 8.6], [0, 6.5, 8.3]], dir: null })
  cuts.push({ label: 'under the lip', tool: 'roundel', size: 0.45, depth: 0.18, points: [[-1.5, 4.25 - parted, 7.0], [0, 3.95 - parted, 7.3], [1.5, 4.25 - parted, 7.0]], dir: null })
  if (k.raised) {
    for (const y of [15.2, 16.1]) cuts.push({ label: 'brow crease', tool: 'roundel', size: 0.35, depth: 0.12, points: [[-3.4, y - 0.3, 8.2], [-1.2, y, 8.8], [1.2, y, 8.8], [3.4, y - 0.3, 8.2]], dir: null })
  }
  return cuts
}

// ---------- expanding a declared form ----------

export interface Expanded {
  shapes: Shape[]
  cuts: RoughCut[]
}

// A list of canon parts placed in a frame. y in a part is from the canon's chin when `chin` is
// given (the head), or plain canon y.
export function placeParts(f: Frame, parts: Part[], chin = 0): Shape[] {
  const out: Shape[] = []
  for (const p of parts) {
    const sides = p.mirror ? [1, -1] : [1]
    for (const side of sides) {
      const r = p.r ?? [0, 0, 0]
      out.push(partShape(f, p.kind, [side * p.c[0], p.c[1] + chin, p.c[2]], p.s, [r[0], side * r[1], side * r[2]]))
    }
  }
  return out
}

export function placeCuts(f: Frame, cuts: PartCut[], chin = 0): RoughCut[] {
  const k = meanStretch(f)
  const out: RoughCut[] = []
  for (const c of cuts) {
    const sides = c.mirror ? [1, -1] : [1]
    for (const side of sides) {
      const flip = (p: Vec3): Vec3 => [side * p[0], p[1], p[2]]
      out.push({
        label: c.label,
        tool: c.tool,
        size: r3(c.size * k),
        depth: r3(c.depth * k),
        points: c.points.map(p => toWorld(f, flip([p[0], p[1] + chin, p[2]]))),
        dir: c.dir ? dirToWorld(f, flip(c.dir)) : null
      })
    }
  }
  return out
}

export function headFrame(head: Omit<DeclaredShape, 'kind'>): Frame {
  return frameOf(head.center, head.size, HEAD, head.rotation)
}

// The canon head placed, sized and posed as declared, its face and hair as the style says.
export function expandHead(head: Omit<DeclaredShape, 'kind'>): Expanded {
  const k = headKnobs(head.style)
  const f = headFrame(head)
  const hair = hairParts(k)
  return {
    shapes: [...placeParts(f, faceParts(k), CHIN), ...placeParts(f, hair.parts, CHIN)],
    cuts: [...placeCuts(f, faceCuts(k), CHIN), ...placeCuts(f, hair.cuts, CHIN)]
  }
}

// Every declared shape as kernel shapes, with the cuts the canon parts carry: canon kinds
// expanded, the rest passed through. A torso finds the head in the same form to make the neck.
export function expandCanon(shapes: DeclaredShape[]): Expanded {
  const out: Expanded = { shapes: [], cuts: [] }
  const own: Shape[] = []
  const heads = shapes.filter(s => s.kind === 'head')
  for (const s of shapes) {
    if (s.kind === 'head') {
      const e = expandHead(s)
      out.shapes.push(...e.shapes)
      out.cuts.push(...e.cuts)
    } else if (s.kind === 'torso') {
      // The nearest head above it is the one its neck carries.
      const head = heads.filter(h => h.center[1] > s.center[1]).sort((a, b) => length(sub(a.center, s.center)) - length(sub(b.center, s.center)))[0]
      const e = torsoParts(s, head ? { frame: headFrame(head), knobs: headKnobs(head.style) } : null)
      out.shapes.push(...e.shapes)
      out.cuts.push(...e.cuts)
    } else {
      own.push({ kind: s.kind, center: s.center, size: s.size, rotation: s.rotation })
    }
  }
  // Big masses first: formDistance can then pass over the many small parts far from a point
  // as soon as the mass it lies in has been counted, which makes a bust's hundred and more
  // solids cost about what a few dozen did. The model's own shapes follow, as it gave them.
  const volume = (s: Shape) => s.size[0] * s.size[1] * s.size[2]
  out.shapes.sort((a, b) => volume(b) - volume(a))
  out.shapes.push(...own)
  return out
}

export function expandShapes(shapes: DeclaredShape[]): Shape[] {
  return expandCanon(shapes).shapes
}

export function isCanonKind(kind: string): kind is CanonKind {
  return kind === 'head' || kind === 'torso'
}

// ---------- settling cuts on the form ----------

// How far a cut point may sit from where the canon put it once found on the surface; further
// means something else stands over it (a lid over the iris, the model's own hair over an ear),
// and the point is left out.
const SETTLE_TOLERANCE = 0.7

function gradientAt(form: CompiledForm, p: Vec3): Vec3 {
  const e = 0.05
  return normalize([
    formDistance(form, p[0] + e, p[1], p[2]) - formDistance(form, p[0] - e, p[1], p[2]),
    formDistance(form, p[0], p[1] + e, p[2]) - formDistance(form, p[0], p[1] - e, p[2]),
    formDistance(form, p[0], p[1], p[2] + e) - formDistance(form, p[0], p[1], p[2] - e)
  ])
}

// The surface met going along d from a point out in front of p, or null.
function march(form: CompiledForm, p: Vec3, d: Vec3): Vec3 | null {
  const back = 2.5
  let t = 0
  const o = sub(p, scale(d, back))
  if (formDistance(form, o[0], o[1], o[2]) < 0) return null
  for (let i = 0; i < 200 && t < back + 3; i++) {
    const q = add(o, scale(d, t))
    const dist = formDistance(form, q[0], q[1], q[2])
    if (dist < 0.004) return q
    t += Math.max(0.01, Math.min(dist, 0.5))
  }
  return null
}

// Rough cuts made exact on the form they will be carved into: each line resampled to bites
// about half a tool apart, each bite on the surface, with its direction in. Points that land
// far from where the canon meant them are dropped.
export function settleCuts(form: CompiledForm | { shapes: Shape[], blend: number }, cuts: RoughCut[]): CanonCut[] {
  const compiled = 'kinds' in form ? form : compileForm(form)
  const out: CanonCut[] = []
  for (const c of cuts) {
    const step = Math.max(0.15, 0.45 * c.size)
    const dense: Vec3[] = []
    for (let i = 0; i < c.points.length; i++) {
      const a = c.points[i]!
      if (i === 0) dense.push(a)
      if (i + 1 >= c.points.length) break
      const b = c.points[i + 1]!
      const n = Math.max(1, Math.ceil(length(sub(b, a)) / step))
      for (let j = 1; j <= n; j++) dense.push(lerp(a, b, j / n))
    }
    const points: Vec3[] = []
    const dirs: Vec3[] = []
    for (const p of dense) {
      const into = c.dir ?? scale(gradientAt(compiled, p), -1)
      const hit = march(compiled, p, into)
      if (!hit || length(sub(hit, p)) > SETTLE_TOLERANCE * Math.max(1, c.size)) continue
      const d = c.dir ?? scale(gradientAt(compiled, hit), -1)
      // A direction that grazes the surface would plough along it, not into it.
      if (c.dir && dot(d, gradientAt(compiled, hit)) > -0.25) continue
      points.push([r3(hit[0]), r3(hit[1]), r3(hit[2])])
      dirs.push([r3(d[0]), r3(d[1]), r3(d[2])])
    }
    if (points.length > 0) out.push({ label: c.label, tool: c.tool, size: c.size, depth: c.depth, points, dirs })
  }
  return out
}
