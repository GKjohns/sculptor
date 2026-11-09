// The sculptor's canon for whole figures, animals and groups. A posed human figure or a
// quadruped is declared by its pose (where it stands, how tall, which way it faces, where its
// weight is, how its torso turns, what each arm and leg is doing, what it wears and what holds
// it up) and expands here, before anything is logged, into the kernel's own primitives: the
// log never sees a kind the kernel does not know, so KERNEL_VERSION stays 2.
//
// Limbs are placed by reaching from the hip or shoulder toward a target with a two-bone reach
// (the knee or elbow bends toward a pole), so a pose stays anatomically jointed however it is
// turned. Everything is built in the subject's own frame (origin on the ground under it,
// facing +Z, its own left at +X), then turned by `facing`, set on its ground point, and
// dropped so its lowest point stands there.
//
// Left and right are always the subject's own. Facing the viewer (facing 0), a figure's left
// is the viewer's right (+X). Positive turns (facing, twist, head turn) turn the front toward
// +X, as the head canon's rot_y does.

import { expandHead } from './anatomy.ts'
import type { RoughCut, StyleToken } from './anatomy.ts'
import { add, apply, cross, dot, eulerOf, length, lerp, matrixOf, multiply, normalize, r3, scale, sub } from './frame.ts'
import type { Mat } from './frame.ts'
import type { Shape, ShapeKind, Vec3 } from './types.ts'

export const FIGURE_BODIES = ['man', 'woman', 'youth', 'child'] as const
export const FIGURE_BUILDS = ['slender', 'athletic', 'heavy'] as const
export const LEG_ACTIONS = ['stand', 'stride', 'lunge', 'kneel', 'sit', 'recline', 'crouch', 'ride'] as const
export const WEIGHT_SIDES = ['left', 'right', 'both'] as const
export const ARM_GESTURES = ['down', 'akimbo', 'across', 'forward', 'raised', 'overhead', 'back', 'out', 'to_head'] as const
export const DRAPERIES = ['none', 'loincloth', 'collar', 'mantle', 'cloak', 'robe'] as const
export const SUPPORTS = ['none', 'stump', 'rock'] as const
export const SPECIES = ['horse', 'bull', 'lion', 'dog', 'cat'] as const
export const ANIMAL_POSES = ['stand', 'walk', 'trot', 'gallop', 'rear', 'charge', 'lie', 'sit'] as const
export const TAILS = ['down', 'out', 'raised', 'curled'] as const
export const LEADS = ['left', 'right'] as const

export type FigureBody = typeof FIGURE_BODIES[number]
export type FigureBuild = typeof FIGURE_BUILDS[number]
export type LegAction = typeof LEG_ACTIONS[number]
export type WeightSide = typeof WEIGHT_SIDES[number]
export type ArmGesture = typeof ARM_GESTURES[number]
export type Drapery = typeof DRAPERIES[number]
export type Support = typeof SUPPORTS[number]
export type Species = typeof SPECIES[number]
export type AnimalPose = typeof ANIMAL_POSES[number]
export type Tail = typeof TAILS[number]
export type Lead = typeof LEADS[number]

export interface FigureSpec {
  body: FigureBody
  build: FigureBuild
  // The point on the ground the figure stands on (between its feet), block cm.
  ground: Vec3
  // Standing height, sole to crown, as if it stood upright: a kneeling figure is shorter.
  height: number
  facing: number
  legs: LegAction
  // The leg that carries the weight: contrapposto when standing; the front leg of a stride or
  // lunge; the planted foot of a kneel.
  weightOn: WeightSide
  // Shoulders turned against the hips, and the torso bent forward (+) or back (-) at the waist.
  twist: number
  lean: number
  headTurn: number
  // Positive nods the face down; negative throws the head back.
  headTilt: number
  leftArm: ArmGesture
  rightArm: ArmGesture
  drapery: Drapery
  support: Support
  // Head canon tokens (anatomy.ts STYLE_TOKENS): hair, beard, expression, nose, age.
  style: StyleToken[]
}

export interface AnimalSpec {
  species: Species
  pose: AnimalPose
  // The point on the ground under the middle of the body, block cm.
  ground: Vec3
  // Body length, point of the chest to point of the rump, cm.
  length: number
  facing: number
  headTurn: number
  // Positive raises the head, negative lowers it.
  headRaise: number
  tail: Tail
  // The foreleg that reaches first in a walk, trot, gallop or charge.
  lead: Lead
}

export interface SceneSpec {
  figures: FigureSpec[]
  animals: AnimalSpec[]
  // Extra kernel shapes (a base, a rock, a branch), already expanded.
  shapes: Shape[]
}

// What the sculptor is told about each subject once it is placed: where it ended up, so its
// own shapes (a sling, hair, a branch, a base) can be laid on it.
export interface Landmarks {
  label: string
  shapes: number
  min: Vec3
  max: Vec3
  points: Record<string, Vec3>
}

export interface SceneResult {
  shapes: Shape[]
  cuts: RoughCut[]
  subjects: Landmarks[]
}

// ---------- 3D helpers (row-major 3x3 matrices, local to world; frame.ts) ----------

type V = Vec3
type M = Mat

const DEG = Math.PI / 180
const clamp = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v
const mul = scale
const len = length
const mix = lerp
const norm = normalize
const ap = apply

const ID: M = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const rotX = (deg: number): M => matrixOf([deg, 0, 0])
const rotY = (deg: number): M => matrixOf([0, deg, 0])
const rotZ = (deg: number): M => matrixOf([0, 0, deg])

function mm(...ms: M[]): M {
  let out = ID
  for (const b of ms) out = multiply(out, b)
  return out
}

const cols = (x: V, y: V, z: V): M => [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]]

// A frame whose local Y runs along dir, with local Z as close to hint as it can be.
function alongY(dir: V, hint: V): M {
  const y = norm(dir)
  let z = sub(hint, mul(y, dot(hint, y)))
  if (len(z) < 1e-6) z = Math.abs(y[2]) < 0.9 ? sub([0, 0, 1], mul(y, y[2])) : sub([1, 0, 0], mul(y, y[0]))
  z = norm(z)
  return cols(cross(y, z), y, z)
}

// A frame whose local Z runs along dir, with local Y as close to up as it can be.
function alongZ(dir: V, up: V): M {
  const z = norm(dir)
  let y = sub(up, mul(z, dot(up, z)))
  if (len(y) < 1e-6) y = Math.abs(z[1]) < 0.9 ? sub([0, 1, 0], mul(z, z[1])) : sub([1, 0, 0], mul(z, z[0]))
  y = norm(y)
  return cols(cross(y, z), y, z)
}

// Two-bone reach: from root toward target with segment lengths a and b, the middle joint bent
// toward pole. Returns the middle joint and where the end actually lands (on the target when
// it is within reach, short of it along the same line when not).
function reach(root: V, target: V, a: number, b: number, pole: V): { mid: V, end: V } {
  const span = sub(target, root)
  const d = clamp(len(span), Math.abs(a - b) + 1e-3, a + b - 1e-3)
  const n = norm(span)
  const x = (a * a - b * b + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, a * a - x * x))
  let q = sub(pole, mul(n, dot(pole, n)))
  if (len(q) < 1e-6) q = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  q = norm(q)
  return { mid: add(add(root, mul(n, x)), mul(q, h)), end: add(root, mul(n, d)) }
}

// A shape in the subject's own frame, before facing and placing.
interface Part { kind: ShapeKind, c: V, size: V, m: M }

function part(kind: ShapeKind, c: V, size: V, m: M = ID): Part {
  return { kind, c, size, m }
}

// A solid running from a to b: an ellipsoid long enough (stretch) to overlap both joints, or a
// capsule whose round ends sit on them. hint orients its thickness (local Z).
function limb(kind: 'ellipsoid' | 'capsule', a: V, b: V, width: number, depth: number, hint: V, stretch = 1.2): Part {
  const l = len(sub(b, a))
  const size: V = kind === 'capsule' ? [width, l + width, depth] : [width, l * stretch, depth]
  return part(kind, mix(a, b, 0.5), size, alongY(sub(b, a), hint))
}

// How far below its centre a part reaches: enough to stand the subject on the ground.
function bottom(p: Part): number {
  const h: V = [p.size[0] / 2, p.size[1] / 2, p.size[2] / 2]
  const m = p.m
  if (p.kind === 'ellipsoid') return Math.sqrt((m[3] * h[0]) ** 2 + (m[4] * h[1]) ** 2 + (m[5] * h[2]) ** 2)
  if (p.kind === 'capsule') {
    const r = Math.max(h[0], h[2])
    return Math.abs(m[4]) * Math.max(0, h[1] - r) + r
  }
  if (p.kind === 'cone') {
    // The apex, or the lowest point of the base's rim.
    const rim = Math.sqrt((m[3] * h[0]) ** 2 + (m[5] * h[2]) ** 2)
    return Math.max(-m[4] * h[1], m[4] * h[1] + rim)
  }
  return Math.abs(m[3]) * h[0] + Math.abs(m[4]) * h[1] + Math.abs(m[5]) * h[2]
}

// Places a subject: turn by facing about Y, drop so its lowest point is at the ground's Y
// (unless it rides), move to the ground point, and write kernel shapes rounded to 0.001 so a
// log written on one engine replays on another.
interface Placed { shapes: Shape[], toWorld: (p: V) => V, min: V, max: V }

function place(parts: Part[], ground: V, facing: number, drop: boolean, centre = false): Placed {
  let low = Infinity
  if (drop) for (const p of parts) low = Math.min(low, p.c[1] - bottom(p))
  const lift = drop ? -low : 0
  // An animal is centred on its ground point by the middle of its footprint.
  let cx = 0
  let cz = 0
  if (centre) {
    let x0 = Infinity
    let x1 = -Infinity
    let z0 = Infinity
    let z1 = -Infinity
    for (const p of parts) {
      const r = Math.max(p.size[0], p.size[1], p.size[2]) / 2
      x0 = Math.min(x0, p.c[0] - r)
      x1 = Math.max(x1, p.c[0] + r)
      z0 = Math.min(z0, p.c[2] - r)
      z1 = Math.max(z1, p.c[2] + r)
    }
    cx = (x0 + x1) / 2
    cz = (z0 + z1) / 2
  }
  const turn = rotY(facing)
  const toWorld = (p: V): V => add(ground, ap(turn, [p[0] - cx, p[1] + lift, p[2] - cz]))
  const shapes: Shape[] = []
  const min: V = [Infinity, Infinity, Infinity]
  const max: V = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) {
    const c = toWorld(p.c)
    const m = mm(turn, p.m)
    const e = eulerOf(m)
    shapes.push({ kind: p.kind, center: [r3(c[0]), r3(c[1]), r3(c[2])], size: [r3(Math.max(0.5, p.size[0])), r3(Math.max(0.5, p.size[1])), r3(Math.max(0.5, p.size[2]))], rotation: [r3(e[0]), r3(e[1]), r3(e[2])] })
    // A box round each part, for the extent the sculptor is told.
    const h: V = [p.size[0] / 2, p.size[1] / 2, p.size[2] / 2]
    for (let i = 0; i < 3; i++) {
      const ext = Math.abs(m[i * 3]!) * h[0] + Math.abs(m[i * 3 + 1]!) * h[1] + Math.abs(m[i * 3 + 2]!) * h[2]
      min[i] = Math.min(min[i]!, c[i]! - ext)
      max[i] = Math.max(max[i]!, c[i]! + ext)
    }
  }
  return { shapes, toWorld, min, max }
}

const round3 = (p: V): V => [r3(p[0]), r3(p[1]), r3(p[2])]

// ---------- the human figure ----------

interface Vertical {
  hip: number
  knee: number
  ankle: number
  waist: number
  chest: number
  shoulder: number
  neck: number
  upper: number
  fore: number
  hand: number
}

const ADULT: Vertical = { hip: 0.52, knee: 0.285, ankle: 0.04, waist: 0.6, chest: 0.71, shoulder: 0.81, neck: 0.83, upper: 0.19, fore: 0.155, hand: 0.105 }
const CHILD: Vertical = { hip: 0.45, knee: 0.24, ankle: 0.035, waist: 0.55, chest: 0.645, shoulder: 0.755, neck: 0.77, upper: 0.165, fore: 0.13, hand: 0.085 }

interface BodyDef {
  heads: number
  // Half the span between the shoulder joints, and between the hip joints.
  shoulder: number
  hip: number
  pelvis: number
  chest: number
  chestDepth: number
  waist: number
  neck: number
  limb: number
  breasts: boolean
  v: Vertical
}

// Fractions of the standing height.
const BODIES: Record<FigureBody, BodyDef> = {
  man: { heads: 7.5, shoulder: 0.112, hip: 0.05, pelvis: 0.185, chest: 0.2, chestDepth: 0.13, waist: 0.15, neck: 0.062, limb: 1, breasts: false, v: ADULT },
  woman: { heads: 7.25, shoulder: 0.1, hip: 0.056, pelvis: 0.21, chest: 0.178, chestDepth: 0.118, waist: 0.128, neck: 0.053, limb: 0.9, breasts: true, v: ADULT },
  youth: { heads: 7, shoulder: 0.104, hip: 0.05, pelvis: 0.175, chest: 0.185, chestDepth: 0.12, waist: 0.14, neck: 0.058, limb: 0.9, breasts: false, v: ADULT },
  child: { heads: 5, shoulder: 0.1, hip: 0.05, pelvis: 0.19, chest: 0.2, chestDepth: 0.15, waist: 0.18, neck: 0.07, limb: 1.05, breasts: false, v: CHILD }
}

const GIRTH: Record<FigureBuild, number> = { slender: 0.88, athletic: 1, heavy: 1.2 }

// A head this tall (chin to crown, cm) or more gets the full head canon with its face; a
// smaller one is three solids, since a face under about 9 cm cannot be cut in 0.4 cm cells.
export const FACE_MIN_CM = 9

interface Foot { at: V, heel: number, pole: V }
interface LegPlan {
  pelvis: V
  tilt: number
  pitch: number
  // Lean added at the waist by the action (a crouch bends forward, a recline lies back).
  lean: number
  feet: [Foot, Foot]
  // Seat under the pelvis (sit), and the side whose arm props a reclining figure.
  seat: boolean
  prop: number
}

// Where the feet go and how the pelvis sits, for each leg action, in units of the height.
// side: +1 when the weight is on the left (the figure's own left, +X), -1 on the right.
function legPlan(f: FigureSpec, b: BodyDef, side: number): LegPlan {
  const v = b.v
  const thigh = v.hip - v.knee
  const shin = v.knee - v.ankle
  const reachLeg = thigh + shin
  const fwd: V = [0, 0, 1]
  const foot = (x: number, y: number, z: number, heel = 0, pole: V = fwd): Foot => ({ at: [x, y + 0.09 * Math.sin(heel * DEG), z], heel, pole })
  // The pelvis height that leaves the given leg straight to the factor k.
  const straight = (px: number, pz: number, tilt: number, legSide: number, ft: Foot, k: number): number => {
    const c = ap(mm(rotZ(tilt)), [legSide * b.hip, 0, 0])
    const dx = px + c[0] - ft.at[0]
    const dz = pz + c[2] - ft.at[2]
    const L = k * reachLeg
    return ft.at[1] - c[1] + Math.sqrt(Math.max(0.01, L * L - dx * dx - dz * dz))
  }
  const plan = (pelvis: V, tilt: number, feet: [Foot, Foot], extra: Partial<LegPlan> = {}): LegPlan => ({ pelvis, tilt, pitch: 0, lean: 0, feet, seat: false, prop: 0, ...extra })
  // feet[0] is the left foot (+X), feet[1] the right.
  const pair = (weighted: Foot, free: Foot): [Foot, Foot] => side > 0 ? [weighted, free] : [free, weighted]
  const s = side === 0 ? 1 : side
  switch (f.legs) {
    case 'stride': {
      const front = foot(s * 0.055, v.ankle, 0.17)
      const back = foot(-s * 0.055, v.ankle, -0.15, 35)
      const px = s * 0.01
      const y = Math.min(straight(px, 0, 0, s, front, 0.985), straight(px, 0, 0, -s, back, 0.99))
      return plan([px, y, 0], 0, pair(front, back))
    }
    case 'lunge': {
      const front = foot(s * 0.075, v.ankle, 0.28)
      const back = foot(-s * 0.075, v.ankle, -0.3, 25)
      const px = s * 0.015
      const pz = 0.07
      const y = straight(px, pz, 0, -s, back, 0.99)
      return plan([px, y, pz], 0, pair(front, back), { lean: 14 })
    }
    case 'kneel': {
      // The weighted leg's foot is planted ahead, knee up; the other knee is on the ground.
      const planted = foot(s * 0.07, v.ankle, 0.21)
      const kneeling = foot(-s * 0.06, 0.1, -0.22, 75)
      return plan([0, 0.035 + 0.97 * thigh, -0.02], 0, pair(planted, kneeling))
    }
    case 'sit': {
      const drawn = foot(s * 0.08, v.ankle, 0.15)
      const out = foot(-s * 0.09, v.ankle, 0.3)
      return plan([0, v.knee - 0.015, -0.03], 0, pair(drawn, out), { seat: true })
    }
    case 'crouch': {
      const flat = foot(s * 0.085, v.ankle, 0.08)
      const toes = foot(-s * 0.08, v.ankle, -0.07, 40)
      return plan([s * 0.02, 0.6 * v.hip, -0.07], 0, pair(flat, toes), { lean: 26 })
    }
    case 'recline': {
      // Half lying, legs out along the ground ahead, the torso propped back on the elbow of
      // the weighted side; the other knee drawn up.
      const out = foot(s * 0.05, 0.035, 0.46, -10)
      const drawn = foot(-s * 0.075, v.ankle, 0.27)
      return plan([0, 0.075, 0], 0, pair(out, drawn), { pitch: -25, lean: -32, prop: s })
    }
    case 'ride':
      // Replaced by the seat on the animal (see expandFigure); this is the plan with no animal.
      return legPlan({ ...f, legs: 'sit' }, b, side)
    default: {
      if (side === 0) {
        const l = foot(0.058, v.ankle, 0)
        const r = foot(-0.058, v.ankle, 0)
        const y = Math.min(straight(0, 0, 0, 1, l, 0.995), straight(0, 0, 0, -1, r, 0.995))
        return plan([0, y, 0], 0, [l, r])
      }
      // Contrapposto: weight over one straight leg, that hip up and out, the free leg bent
      // with its foot forward and to the side, heel lifted. On a rock, the free foot is up on it.
      const tilt = side * 6
      const weighted = foot(side * 0.02, v.ankle, -0.01)
      const onRock = f.support === 'rock'
      const free = onRock ? foot(-side * 0.09, v.ankle + 0.12, 0.1) : foot(-side * 0.095, v.ankle, 0.08, 18)
      const px = side * 0.035
      const y = straight(px, 0, tilt, side, weighted, 0.995)
      return plan([px, y, 0], tilt, pair(weighted, free))
    }
  }
}

// Where a hand goes for each gesture. Directions are in the frame that has the torso's turn
// but not its lean ("world-ish": a hanging arm hangs); akimbo, across and to_head are placed on
// the body itself.
interface Gesture { dir?: V, k?: number, pole: V, body?: 'hip' | 'chest' | 'head' }
function gesture(g: ArmGesture, s: number): Gesture {
  switch (g) {
    case 'down': return { dir: [s * 0.12, -0.985, 0.08], k: 0.975, pole: [0, 0, -1] }
    case 'forward': return { dir: [-s * 0.08, -0.12, 0.99], k: 0.96, pole: [s * 0.3, -1, 0] }
    case 'raised': return { dir: [s * 0.35, 0.66, 0.66], k: 0.96, pole: [s * 0.6, -0.8, -0.2] }
    case 'overhead': return { dir: [s * 0.18, 0.98, 0.06], k: 0.965, pole: [s, 0, -0.2] }
    case 'back': return { dir: [s * 0.32, -0.55, -0.77], k: 0.95, pole: [s, 0.2, 0.3] }
    case 'out': return { dir: [s * 0.97, -0.1, 0.18], k: 0.965, pole: [0, -0.4, -1] }
    case 'akimbo': return { body: 'hip', pole: [s, 0, -0.35] }
    case 'across': return { body: 'chest', pole: [s * 0.7, -1, -0.1] }
    case 'to_head': return { body: 'head', pole: [s, -0.5, 0.25] }
  }
}

interface Seat { at: V, turn: M, halfWidth: number, pitch: number }

// Cloth is never thinner than this in the stone (2.4 cm), in units of the figure being built.
let clothFloor = 0

// A length of cloth lying along a path: overlapping flat masses, each widths[i] across and
// thick through, its thin side facing the way normal() says at that point.
function cloth(path: V[], widths: number[], thick: number, normal: (p: V) => V): Part[] {
  const out: Part[] = []
  thick = Math.max(thick, clothFloor)
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!
    const b = path[i + 1]!
    const c = mix(a, b, 0.5)
    out.push(part('ellipsoid', c, [widths[i] ?? widths[widths.length - 1]!, len(sub(b, a)) * 1.35, thick], alongY(sub(b, a), normal(c))))
  }
  return out
}

// A path with a point added between each pair, on a Catmull-Rom curve through them.
function smooth(path: V[]): V[] {
  const out: V[] = []
  for (let i = 0; i + 1 < path.length; i++) {
    const p0 = path[Math.max(0, i - 1)]!
    const p1 = path[i]!
    const p2 = path[i + 1]!
    const p3 = path[Math.min(path.length - 1, i + 2)]!
    out.push(p1)
    out.push([0, 1, 2].map(k => 0.5625 * (p1[k]! + p2[k]!) - 0.0625 * (p0[k]! + p3[k]!)) as V)
  }
  out.push(path[path.length - 1]!)
  return out
}

// A rock: an ellipsoid core with two boxes turned through it, so it has faces and edges.
function rock(c: V, size: V, hand: number): Part[] {
  return [
    part('ellipsoid', c, size, rotY(hand * 15)),
    part('box', add(c, [hand * 0.02 * size[0] / 0.2, 0.1 * size[1], -0.05 * size[2]]), mul(size, 0.62), mm(rotY(hand * 35), rotX(18), rotZ(hand * 12))),
    part('box', add(c, [-hand * 0.25 * size[0], -0.15 * size[1], 0.15 * size[2]]), mul(size, 0.5), mm(rotY(-hand * 20), rotX(-14), rotZ(-hand * 22)))
  ]
}

// The head canon's tokens for a figure: its sex and age from the body, then the model's own.
function headStyle(f: FigureSpec): StyleToken[] {
  const out: StyleToken[] = [f.body === 'woman' ? 'female' : 'male']
  if (f.body === 'youth' || f.body === 'child') out.push('young')
  if (f.build === 'slender') out.push('lean')
  if (f.build === 'heavy') out.push('heavy')
  for (const t of f.style ?? []) if (!out.includes(t)) out.push(t)
  return out
}

export function expandFigure(f: FigureSpec, seat?: Seat): { shapes: Shape[], cuts: RoughCut[], marks: Landmarks } {
  const b = BODIES[f.body] ?? BODIES.man
  const v = b.v
  const H = Math.max(10, Math.abs(f.height))
  const g = GIRTH[f.build] ?? 1
  const u = 1 / b.heads
  const side = f.weightOn === 'left' ? 1 : f.weightOn === 'right' ? -1 : 0
  const riding = f.legs === 'ride' && seat !== undefined
  const lp = legPlan(f, b, side)
  const parts: Part[] = []
  clothFloor = 2.4 / H
  // Everything below is in units of H until `scale`, in the figure's own frame.
  let P: V = lp.pelvis
  let pelvisTurn = mm(rotZ(lp.tilt), rotX(lp.pitch))
  let feet = lp.feet
  if (riding) {
    // Astride: the pelvis on the animal's back, thighs round the barrel, shins hanging.
    const w = seat.halfWidth / H
    P = [0, 0.06, 0]
    pelvisTurn = ID
    const ft = (s: number): Foot => ({ at: [s * (w + 0.035), -0.34, 0.07], heel: -10, pole: [s * 0.8, 0, 1] })
    feet = [ft(1), ft(-1)]
  }
  const thigh = v.hip - v.knee
  const shin = v.knee - v.ankle
  const fwd: V = [0, 0, 1]

  // --- torso ---
  const W = add(P, ap(pelvisTurn, [0, v.waist - v.hip, 0]))
  const chestTilt = -1.7 * lp.tilt
  const lean = f.lean + lp.lean - (riding ? 0.3 * seat.pitch : 0)
  const chestTurn = mm(pelvisTurn, rotY(f.twist), rotZ(chestTilt), rotX(lean))
  const atChest = (p: V): V => add(W, ap(chestTurn, p))
  const atPelvis = (p: V): V => add(P, ap(pelvisTurn, p))
  // The turn of the torso without its lean or tilt: hanging arms hang.
  const yawOnly = rotY(f.twist)
  parts.push(part('ellipsoid', atPelvis([0, 0.01, -0.005]), [b.pelvis * g, 0.13, 0.12 * g], pelvisTurn))
  for (const s of [1, -1]) parts.push(part('ellipsoid', atPelvis([s * 0.04, -0.03, -0.03]), [0.085 * g, 0.095, 0.075 * g], pelvisTurn))
  // The abdomen and flanks, long enough to run from the ribs into the pelvis.
  parts.push(part('ellipsoid', atChest([0, -0.005, 0.004]), [b.waist * g, 0.2, b.chestDepth * 0.86 * g], chestTurn))
  const chestC = v.chest - v.waist
  parts.push(part('ellipsoid', atChest([0, chestC - 0.005, -0.004]), [b.chest * g, 0.22, b.chestDepth * g], chestTurn))
  if (b.breasts) {
    for (const s of [1, -1]) parts.push(part('ellipsoid', atChest([s * 0.043, chestC + 0.005, b.chestDepth * 0.42 * g]), [0.07 * g, 0.068 * g, 0.068 * g], chestTurn))
  } else {
    // Pectorals: broad flat plates, not mounds.
    for (const s of [1, -1]) parts.push(part('ellipsoid', atChest([s * 0.047, chestC + 0.03, b.chestDepth * 0.33 * g]), [0.11 * g, 0.058, 0.032 * g], mm(chestTurn, rotZ(-s * 12), rotY(s * 14))))
  }
  const shY = v.shoulder - v.waist
  // The shoulder girdle: a level top from shoulder to shoulder, clavicles in front.
  parts.push(part('ellipsoid', atChest([0, shY - 0.012, -0.012]), [2 * b.shoulder + 0.04 * g, 0.055, 0.1 * g], chestTurn))

  // --- neck and head ---
  const headH = u
  const chin = 1 - u
  const pivot = atChest([0, chin - v.waist, -0.012])
  const headTurn = mm(chestTurn, rotY(f.headTurn), rotX(f.headTilt - (lp.lean > 0 ? 0.6 * lp.lean : 0) + (riding ? 0.3 * seat.pitch : 0)))
  const headC = add(pivot, ap(headTurn, [0, headH / 2, 0.1 * headH]))
  const neckBase = atChest([0, v.neck - v.waist - 0.02, -0.012])
  parts.push(limb('capsule', neckBase, add(pivot, ap(headTurn, [0, 0.25 * headH, -0.05 * headH])), b.neck * g, b.neck * g, ap(chestTurn, fwd)))
  const fullFace = headH * H >= FACE_MIN_CM

  // --- arms ---
  const upper = v.upper
  const fore = v.fore
  const hands: V[] = []
  for (const s of [1, -1]) {
    const shoulder = atChest([s * b.shoulder, shY, -0.01])
    const gs = gesture(s > 0 ? f.leftArm : f.rightArm, s)
    let target: V
    let pole = ap(chestTurn, gs.pole)
    if (lp.prop === s && !riding) {
      // The propping arm: elbow and forearm on the ground beside the hip.
      target = [P[0] + s * 0.2, 0.03, P[2] + 0.05]
      pole = [s * 0.2, 0, -1]
    } else if (gs.body === 'hip') {
      target = atPelvis([s * (b.pelvis * g / 2 + 0.012), 0.065, 0.015])
    } else if (gs.body === 'chest') {
      target = atChest([-s * 0.05, chestC - 0.03, b.chestDepth * g / 2 + 0.045])
    } else if (gs.body === 'head') {
      target = add(headC, ap(headTurn, [s * 0.42 * headH, 0.05 * headH, 0.22 * headH]))
    } else {
      target = add(shoulder, mul(ap(yawOnly, ap(pelvisTurn, norm(gs.dir!))), (upper + fore) * gs.k!))
      pole = ap(yawOnly, ap(pelvisTurn, gs.pole))
    }
    const { mid: elbow, end: wrist } = reach(shoulder, target, upper, fore, pole)
    parts.push(limb('ellipsoid', shoulder, elbow, 0.062 * g * b.limb, 0.066 * g * b.limb, pole, 1.22))
    parts.push(part('ellipsoid', add(shoulder, mul(norm(sub(elbow, shoulder)), 0.02)), [0.075 * g, 0.095, 0.078 * g], alongY(sub(elbow, shoulder), pole)))
    parts.push(limb('ellipsoid', elbow, wrist, 0.052 * g * b.limb, 0.047 * g * b.limb, pole, 1.18))
    let handDir = norm(sub(wrist, elbow))
    if (gs.body === 'hip' && lp.prop !== s) handDir = norm(ap(chestTurn, [-s * 0.35, -0.4, 0.85]))
    parts.push(part('ellipsoid', add(wrist, mul(handDir, 0.42 * v.hand)), [0.044, v.hand * 0.95, 0.026], alongY(handDir, pole)))
    hands.push(add(wrist, mul(handDir, 0.6 * v.hand)))
  }

  // --- legs ---
  const ankles: V[] = []
  const knees: V[] = []
  for (const [i, s] of [[0, 1], [1, -1]] as const) {
    const ft = feet[i]!
    const hipJoint = atPelvis([s * b.hip, -0.01, 0])
    const kneePole = riding ? ft.pole : ap(rotY(0), ft.pole)
    const { mid: knee, end: ankle } = reach(hipJoint, ft.at, thigh, shin, kneePole)
    knees.push(knee)
    ankles.push(ankle)
    const thighW = 0.092 * g * b.limb
    parts.push(limb('ellipsoid', hipJoint, knee, thighW, thighW * 1.03, kneePole, 1.24))
    parts.push(limb('capsule', knee, ankle, 0.045 * g * b.limb, 0.045 * g * b.limb, kneePole))
    // The calf, on the back of the shin.
    const along = norm(sub(ankle, knee))
    const back = norm(sub(mul(along, dot(kneePole, along)), kneePole))
    parts.push(part('ellipsoid', add(add(knee, mul(sub(ankle, knee), 0.3)), mul(back, 0.012)), [0.06 * g * b.limb, 0.55 * shin, 0.066 * g * b.limb], alongY(along, kneePole)))
    const footTurn = riding ? mm(rotX(ft.heel)) : mm(rotY(s * 8), rotX(ft.heel))
    parts.push(part('ellipsoid', add(ankle, ap(footTurn, [0, -0.022, 0.045])), [0.048, 0.036, 0.14], footTurn))
  }

  // --- what holds it up ---
  const free = side >= 0 ? 1 : 0
  const weighted = 1 - free
  if (lp.seat && !riding) {
    const seatTop = P[1] - 0.075
    if (f.support === 'stump') {
      parts.push(part('capsule', [0, seatTop / 2, P[2] - 0.05], [0.24, seatTop + 0.05, 0.22]))
    } else if (f.support === 'rock') {
      parts.push(...rock([0.01, seatTop * 0.5, P[2] - 0.06], [0.3, seatTop, 0.26], 1))
    } else {
      parts.push(part('box', [0, seatTop / 2, P[2] - 0.05], [0.28, seatTop, 0.24]))
    }
  } else if (f.support === 'stump' && !riding) {
    // A tree stump against the outside of the weighted leg, behind it: the antique strut.
    const sx = (side === 0 ? -1 : side) * 0.11
    const ax = ankles[weighted]!
    parts.push(part('capsule', [ax[0] + sx * 0.7, 0.19, ax[2] - 0.06], [0.075, 0.4, 0.075], rotZ(-sx * 25)))
    parts.push(part('ellipsoid', [ax[0] + sx * 0.75, 0.03, ax[2] - 0.06], [0.13, 0.07, 0.12]))
  } else if (f.support === 'rock' && !riding) {
    if ((f.legs === 'stand') && side !== 0) {
      const fa = ankles[free]!
      parts.push(...rock([fa[0], 0.055, fa[2] + 0.01], [0.18, 0.11, 0.17], side))
    } else {
      const mid = mix(ankles[0]!, ankles[1]!, 0.5)
      parts.push(...rock([mid[0], 0.07, mid[2] - 0.1], [0.24, 0.14, 0.17], side || 1))
    }
  }

  // --- drapery ---
  const pelvisW = b.pelvis * g
  const drape = f.drapery
  // Outward from the body's own axis at a point: the way cloth lying on it faces.
  const axis = (p: V): V => {
    const t = clamp((p[1] - P[1]) / 0.35, -1.5, 1)
    const c = add(P, mul(sub(W, P), Math.max(0, t) * 2.9))
    const o = sub(p, [c[0], p[1], c[2]])
    return len(o) < 1e-6 ? ap(chestTurn, [0, 0, 1]) : norm(o)
  }
  if (drape === 'loincloth') {
    parts.push(part('ellipsoid', atPelvis([0, -0.01, 0.003]), [pelvisW * 1.12, 0.1, 0.135 * g], pelvisTurn))
    parts.push(part('ellipsoid', atPelvis([0, -0.075, 0.052 * g]), [0.08, 0.13, 0.03], pelvisTurn))
  } else if (drape === 'collar' || drape === 'cloak') {
    parts.push(part('ellipsoid', atChest([0, shY - 0.005, -0.01]), [2 * b.shoulder + 0.07 * g, 0.06, b.chestDepth * g + 0.05], chestTurn))
  }
  if (drape === 'mantle') {
    // A himation: over one shoulder (the left, unless that arm is lifted), across the chest in
    // a sash to the other hip, wrapped round the hips, and a long fold hanging from the shoulder.
    const m = f.leftArm === 'raised' || f.leftArm === 'overhead' || f.leftArm === 'out' ? -1 : 1
    const d = b.chestDepth * g
    const sash = [
      atChest([m * (b.shoulder - 0.02), shY + 0.005, -0.01]),
      atChest([m * 0.06, chestC + 0.02, d * 0.45]),
      atChest([-m * 0.03, 0.02, d * 0.42]),
      atPelvis([-m * 0.08, 0.0, 0.05 * g]),
      atPelvis([-m * 0.1, -0.01, -0.03])
    ]
    parts.push(...cloth(smooth(sash), [0.08, 0.09, 0.095, 0.095], 0.034, axis))
    parts.push(part('ellipsoid', atPelvis([0, -0.005, 0]), [pelvisW * 1.18, 0.085, 0.15 * g], mm(pelvisTurn, rotZ(-m * 10))))
    // Over the shoulder and down the back to the thigh.
    const hang = [
      atChest([m * (b.shoulder - 0.01), shY + 0.005, -d * 0.1]),
      atChest([m * (b.shoulder - 0.03), chestC, -d * 0.5]),
      atChest([m * 0.08, -0.05, -d * 0.48]),
      atPelvis([m * 0.085, -0.13, -0.05]),
      atPelvis([m * 0.08, -0.26, -0.03])
    ]
    parts.push(...cloth(smooth(hang), [0.09, 0.1, 0.11, 0.1], 0.04, axis))
  } else if (drape === 'cloak') {
    // Caught at the shoulders, down the back, then flying out to the free side and behind with
    // its end on the ground (unless the figure rides): a Baroque sail that is also a strut.
    const fs = side === 0 ? -1 : -side
    const d = b.chestDepth * g
    const flying = riding || f.legs === 'recline'
    const path: V[] = [
      atChest([0, shY - 0.01, -d / 2 - 0.02]),
      atChest([fs * 0.02, chestC - 0.06, -d / 2 - 0.05]),
      add(atChest([fs * 0.05, -0.08, -d / 2 - 0.08]), [fs * 0.04, 0, -0.03]),
      flying ? add(atChest([fs * 0.12, -0.2, -d / 2 - 0.14]), [fs * 0.08, 0.04, -0.12]) : [P[0] + fs * 0.16, Math.max(0.12, 0.45 * P[1]), P[2] - 0.2],
      flying ? add(atChest([fs * 0.2, -0.26, -d / 2 - 0.2]), [fs * 0.14, 0.08, -0.22]) : [P[0] + fs * 0.2, 0.025, P[2] - 0.25]
    ]
    const sheet = smooth(path)
    const facing = (p: V) => norm(add(axis(p), [0, 0.15, 0]))
    parts.push(...cloth(sheet, [0.2, 0.24, 0.27, 0.29, 0.3, 0.29, 0.27, 0.25], 0.035, facing))
    // Two folds running down it, so it reads as cloth and not a board.
    for (const o of [-0.07, 0.06]) {
      const ridge = sheet.slice(1).map((p, i) => add(p, mul(norm(cross(sub(sheet[Math.min(i + 2, sheet.length - 1)]!, sheet[i]!), facing(p))), o * (0.6 + 0.1 * i))))
      parts.push(...cloth(ridge.map(p => add(p, mul(facing(p), 0.02))), [0.035], 0.035, facing))
    }
    if (!flying) parts.push(part('ellipsoid', [P[0] + fs * 0.2, 0.02, P[2] - 0.25], [0.24, 0.05, 0.18], rotY(fs * 20)))
  } else if (drape === 'robe') {
    const midFeet = mix(ankles[0]!, ankles[1]!, 0.5)
    const standing = f.legs === 'stand' || f.legs === 'stride' || f.legs === 'lunge'
    if (standing && !riding) {
      const apex = atChest([0, 0.06, 0])
      const base: V = [midFeet[0], 0, midFeet[2] + 0.01]
      const spread = Math.max(len(sub(ankles[0]!, ankles[1]!)) / 2 + 0.1, 0.17)
      const L = len(sub(apex, base))
      const cone = alongY(sub(apex, base), [0, 0, 1])
      parts.push(part('cone', mix(base, apex, 0.5), [2 * spread, L, 1.6 * spread], cone))
      // Folds falling from the hips to the hem.
      for (const k of [-0.6, -0.15, 0.35, 0.75]) {
        const at = add(base, ap(cone, [k * spread, 0.02, 0.78 * spread * Math.sqrt(1 - k * k * 0.6)]))
        parts.push(limb('capsule', at, mix(at, apex, 0.62), 0.03, 0.03, [0, 0, 1]))
      }
    } else {
      // Over the legs: a sleeve of cloth on each thigh and shin, and a sheet between the knees.
      for (let i = 0; i < 2; i++) {
        const hipJoint = atPelvis([(i === 0 ? 1 : -1) * b.hip, -0.01, 0])
        parts.push(limb('ellipsoid', hipJoint, knees[i]!, 0.13 * g, 0.13 * g, [0, 1, 0], 1.3))
        parts.push(limb('ellipsoid', knees[i]!, ankles[i]!, 0.1 * g, 0.1 * g, [0, 1, 0], 1.25))
      }
      parts.push(...cloth([P, mix(knees[0]!, knees[1]!, 0.5), mix(ankles[0]!, ankles[1]!, 0.5)], [0.2, 0.18], 0.06, () => [0, 1, 0.3]))
    }
    parts.push(part('ellipsoid', atChest([0, chestC - 0.01, 0.003]), [b.chest * g * 1.06, 0.22, b.chestDepth * g * 1.1], chestTurn))
  }

  // --- scale to cm, place ---
  const scale = (p: V): V => mul(p, H)
  const cm = parts.map(p => ({ ...p, c: scale(p.c), size: mul(p.size, H) }))
  let origin: V = f.ground
  let turn = f.facing
  if (riding) {
    // The rider's frame is the saddle's: no drop, facing taken from the animal.
    origin = seat.at
    turn = 0
  }
  const headSize: V = [0.68 * headH * H, headH * H, 0.85 * headH * H]
  const placed = place(riding ? cm.map(p => ({ ...p, c: ap(seat.turn, p.c), m: mm(seat.turn, p.m) })) : cm, riding ? origin : f.ground, riding ? 0 : turn, !riding)
  const toWorld = riding ? (p: V) => add(origin, ap(seat.turn, p)) : placed.toWorld
  const world = (p: V) => toWorld(scale(p))
  const hm = mm(riding ? seat.turn : rotY(turn), headTurn)
  const centre = world(headC)
  const cuts: RoughCut[] = []
  if (fullFace) {
    // The head canon itself, with the sitter's tokens: sex and age from the body unless given.
    const head = expandHead({ center: round3(centre), size: round3(headSize), rotation: round3(eulerOf(hm)), style: headStyle(f) }, headH * H < 18)
    placed.shapes.push(...head.shapes)
    // Lines narrower than about a cell and a half cannot be cut at figure scale.
    cuts.push(...head.cuts.filter(c => c.size >= 0.55))
  } else {
    // A small head: cranium, the face below it, the nose.
    const at = (p: V) => round3(add(centre, ap(hm, mul(p, headH * H))))
    const rot = round3(eulerOf(hm))
    placed.shapes.push(
      { kind: 'ellipsoid', center: at([0, 0.08, -0.04]), size: round3(mul([0.7, 0.8, 0.86], headH * H)), rotation: rot },
      { kind: 'ellipsoid', center: at([0, -0.17, 0.12]), size: round3(mul([0.56, 0.62, 0.62], headH * H)), rotation: rot },
      { kind: 'ellipsoid', center: at([0, -0.06, 0.43]), size: round3(mul([0.16, 0.26, 0.18], headH * H)), rotation: rot }
    )
  }
  const label = `${f.body}, ${f.legs}${riding ? '' : f.weightOn === 'both' ? '' : `, weight on the ${f.weightOn}`}`
  // The head's extent, which place() did not see.
  const hc = world(headC)
  const hr = 0.6 * headH * H
  const min: V = [Math.min(placed.min[0], hc[0] - hr), Math.min(placed.min[1], hc[1] - hr), Math.min(placed.min[2], hc[2] - hr)]
  const max: V = [Math.max(placed.max[0], hc[0] + hr), Math.max(placed.max[1], hc[1] + hr), Math.max(placed.max[2], hc[2] + hr)]
  return {
    shapes: placed.shapes,
    cuts,
    marks: {
      label,
      shapes: placed.shapes.length,
      min,
      max,
      points: {
        head: round3(hc),
        left_hand: round3(world(hands[0]!)),
        right_hand: round3(world(hands[1]!)),
        pelvis: round3(world(P)),
        left_foot: round3(world(ankles[0]!)),
        right_foot: round3(world(ankles[1]!))
      }
    }
  }
}

// ---------- quadrupeds ----------

interface Leg {
  // Upper joint (elbow or stifle) in body units: x out from the middle, y up, z forward.
  root: V
  seg: [number, number, number]
  width: [number, number, number]
  // Hoof or paw: width, height, length.
  foot: V
  // The muscle mass over the upper joint: forearm or gaskin top.
  upper: V
}

interface SpeciesDef {
  // Barrel centre height, size (width, height, length); chest and haunch masses (y, z, size).
  barrel: [number, V]
  chest: [number, number, V]
  haunch: [number, number, V]
  fore: Leg
  hind: Leg
  hindRake: number
  // Neck: root (y, z), length, width, depth, angle above horizontal when standing.
  neck: { y: number, z: number, length: number, width: number, depth: number, angle: number }
  // Head: length from poll to muzzle tip, skull and muzzle sizes, its angle below horizontal.
  head: { length: number, skull: V, muzzle: V, droop: number }
  ears: { size: V, spread: number, rake: number }
  horns?: { length: number, base: number }
  mane?: 'crest' | 'ruff'
  hump?: V
  tail: { y: number, z: number, length: number, width: number, tuft: number }
  paws: boolean
}

// Body units: 1 is the body length, point of the chest to point of the rump.
const SPECIES_DEFS: Record<Species, SpeciesDef> = {
  horse: {
    barrel: [0.79, [0.34, 0.42, 0.86]],
    chest: [0.79, 0.34, [0.32, 0.42, 0.3]],
    haunch: [0.82, -0.34, [0.36, 0.42, 0.36]],
    fore: { root: [0.1, 0.57, 0.34], seg: [0.27, 0.2, 0.1], width: [0.12, 0.072, 0.075], foot: [0.1, 0.08, 0.11], upper: [0.15, 0.22, 0.17] },
    hind: { root: [0.11, 0.6, -0.33], seg: [0.29, 0.22, 0.1], width: [0.12, 0.075, 0.075], foot: [0.1, 0.08, 0.11], upper: [0.16, 0.28, 0.22] },
    hindRake: -22,
    neck: { y: 0.9, z: 0.36, length: 0.48, width: 0.17, depth: 0.3, angle: 52 },
    head: { length: 0.44, skull: [0.17, 0.2, 0.22], muzzle: [0.13, 0.15, 0.24], droop: 58 },
    ears: { size: [0.05, 0.11, 0.04], spread: 0.05, rake: -15 },
    mane: 'crest',
    tail: { y: 0.94, z: -0.5, length: 0.6, width: 0.11, tuft: 0 },
    paws: false
  },
  bull: {
    barrel: [0.66, [0.5, 0.54, 0.9]],
    chest: [0.64, 0.34, [0.48, 0.6, 0.4]],
    haunch: [0.68, -0.34, [0.44, 0.5, 0.38]],
    fore: { root: [0.13, 0.41, 0.34], seg: [0.2, 0.13, 0.08], width: [0.15, 0.09, 0.095], foot: [0.11, 0.08, 0.12], upper: [0.19, 0.24, 0.2] },
    hind: { root: [0.14, 0.44, -0.33], seg: [0.22, 0.15, 0.08], width: [0.14, 0.09, 0.095], foot: [0.11, 0.08, 0.12], upper: [0.2, 0.3, 0.24] },
    hindRake: -20,
    neck: { y: 0.76, z: 0.4, length: 0.22, width: 0.36, depth: 0.46, angle: 12 },
    head: { length: 0.38, skull: [0.27, 0.26, 0.24], muzzle: [0.23, 0.19, 0.19], droop: 62 },
    ears: { size: [0.1, 0.045, 0.04], spread: 0.15, rake: 0 },
    horns: { length: 0.32, base: 0.085 },
    hump: [0.38, 0.24, 0.36],
    tail: { y: 0.88, z: -0.52, length: 0.55, width: 0.045, tuft: 0.08 },
    paws: false
  },
  lion: {
    barrel: [0.56, [0.32, 0.36, 0.86]],
    chest: [0.56, 0.32, [0.32, 0.38, 0.3]],
    haunch: [0.58, -0.34, [0.32, 0.36, 0.3]],
    fore: { root: [0.1, 0.38, 0.33], seg: [0.22, 0.12, 0.05], width: [0.1, 0.075, 0.07], foot: [0.11, 0.065, 0.13], upper: [0.14, 0.2, 0.15] },
    hind: { root: [0.1, 0.42, -0.32], seg: [0.24, 0.15, 0.05], width: [0.1, 0.065, 0.065], foot: [0.1, 0.06, 0.13], upper: [0.15, 0.26, 0.2] },
    hindRake: -28,
    neck: { y: 0.66, z: 0.36, length: 0.2, width: 0.22, depth: 0.26, angle: 30 },
    head: { length: 0.32, skull: [0.27, 0.26, 0.25], muzzle: [0.17, 0.15, 0.16], droop: 18 },
    ears: { size: [0.06, 0.06, 0.03], spread: 0.08, rake: -10 },
    mane: 'ruff',
    tail: { y: 0.66, z: -0.48, length: 0.7, width: 0.04, tuft: 0.07 },
    paws: true
  },
  dog: {
    barrel: [0.62, [0.26, 0.32, 0.82]],
    chest: [0.6, 0.32, [0.26, 0.36, 0.28]],
    haunch: [0.63, -0.33, [0.26, 0.3, 0.28]],
    fore: { root: [0.08, 0.44, 0.32], seg: [0.24, 0.15, 0.05], width: [0.08, 0.055, 0.055], foot: [0.08, 0.05, 0.1], upper: [0.11, 0.2, 0.13] },
    hind: { root: [0.08, 0.47, -0.31], seg: [0.27, 0.17, 0.05], width: [0.08, 0.05, 0.05], foot: [0.075, 0.05, 0.1], upper: [0.12, 0.26, 0.18] },
    hindRake: -30,
    neck: { y: 0.72, z: 0.34, length: 0.22, width: 0.16, depth: 0.2, angle: 42 },
    head: { length: 0.38, skull: [0.21, 0.2, 0.22], muzzle: [0.12, 0.12, 0.21], droop: 12 },
    ears: { size: [0.05, 0.1, 0.03], spread: 0.06, rake: -8 },
    tail: { y: 0.72, z: -0.46, length: 0.42, width: 0.05, tuft: 0 },
    paws: true
  },
  cat: {
    barrel: [0.47, [0.28, 0.29, 0.84]],
    chest: [0.46, 0.32, [0.26, 0.3, 0.26]],
    haunch: [0.5, -0.33, [0.3, 0.32, 0.3]],
    fore: { root: [0.08, 0.32, 0.32], seg: [0.18, 0.11, 0.04], width: [0.075, 0.055, 0.055], foot: [0.07, 0.045, 0.08], upper: [0.1, 0.16, 0.12] },
    hind: { root: [0.08, 0.37, -0.31], seg: [0.22, 0.14, 0.04], width: [0.075, 0.05, 0.05], foot: [0.065, 0.045, 0.09], upper: [0.13, 0.24, 0.2] },
    hindRake: -34,
    neck: { y: 0.58, z: 0.34, length: 0.18, width: 0.14, depth: 0.16, angle: 42 },
    head: { length: 0.26, skull: [0.25, 0.22, 0.22], muzzle: [0.12, 0.09, 0.08], droop: 8 },
    ears: { size: [0.08, 0.1, 0.03], spread: 0.08, rake: 6 },
    tail: { y: 0.55, z: -0.47, length: 0.75, width: 0.05, tuft: 0 },
    paws: true
  }
}

// Joint angles per pose, degrees from straight down in the world's side plane (whatever the
// body's pitch), positive swung forward: [upper segment, middle relative to upper, foot segment
// relative to middle]; a hind leg's upper segment is raked back by the species' hindRake on top,
// and its middle segment brought upright again. Legs are lead fore, trailing fore, lead hind,
// trailing hind. Body pitch is nose up negative.
// rake: false where the hind legs fold (lie, sit) and are given as they lie.
interface Gait { fore: [V, V], hind: [V, V], pitch: number, neck: number, head: number, rake?: false }
const GAITS: Record<AnimalPose, Gait> = {
  stand: { fore: [[4, 0, 0], [-2, 0, 0]], hind: [[0, 22, 0], [-6, 22, 0]], pitch: 0, neck: 0, head: 0 },
  walk: { fore: [[22, -6, 0], [-12, -55, -25]], hind: [[8, 18, 0], [-30, 30, 8]], pitch: 0, neck: -6, head: 0 },
  trot: { fore: [[38, -75, -20], [-14, 0, 0]], hind: [[-8, 20, 0], [12, 50, -40]], pitch: 0, neck: 4, head: 4 },
  gallop: { fore: [[62, -12, 0], [26, -100, -30]], hind: [[16, 30, 0], [-52, 28, 12]], pitch: 0, neck: -12, head: -10 },
  rear: { fore: [[62, -125, -15], [44, -115, -10]], hind: [[6, 4, 0], [-4, 10, 0]], pitch: -48, neck: -8, head: -8 },
  charge: { fore: [[34, -6, 0], [-22, -60, -10]], hind: [[-18, 34, 0], [-52, 30, 12]], pitch: 7, neck: -30, head: -14 },
  lie: { fore: [[92, -176, 0], [90, -174, 0]], hind: [[88, -178, 0], [86, -176, 0]], pitch: 0, neck: 8, head: 0, rake: false },
  sit: { fore: [[-4, 0, 0], [-2, 0, 0]], hind: [[-70, 155, 0], [-68, 152, 0]], pitch: -36, neck: 10, head: 0, rake: false }
}
// Felines and dogs lie as a sphinx, forelegs out in front.
const SPHINX: [V, V] = [[88, 0, 4], [90, 0, 4]]

export function expandAnimal(a: AnimalSpec): { shapes: Shape[], marks: Landmarks, seat: Seat } {
  const sp = SPECIES_DEFS[a.species] ?? SPECIES_DEFS.horse
  const gait = GAITS[a.pose] ?? GAITS.stand
  const B = Math.max(10, Math.abs(a.length))
  const lead = a.lead === 'right' ? -1 : 1
  const parts: Part[] = []
  // The body frame pitches about the hindquarters (a rear or a sit) or the middle.
  const pitchAt: V = a.pose === 'rear' || a.pose === 'sit' ? [0, sp.hind.root[1], sp.hind.root[2]] : [0, sp.barrel[0], 0]
  const body = rotX(gait.pitch)
  const bodyAt = (p: V): V => add(pitchAt, ap(body, sub(p, pitchAt)))
  const [by, bs] = sp.barrel
  parts.push(part('ellipsoid', bodyAt([0, by, 0]), bs, body))
  parts.push(part('ellipsoid', bodyAt([0, sp.chest[0], sp.chest[1]]), sp.chest[2], body))
  parts.push(part('ellipsoid', bodyAt([0, sp.haunch[0], sp.haunch[1]]), sp.haunch[2], body))
  if (sp.hump) parts.push(part('ellipsoid', bodyAt([0, by + bs[1] / 2 - 0.02, 0.28]), sp.hump, body))

  // --- legs ---
  const lowest: V[] = []
  const legAt = (leg: Leg, s: number, ang: V, hind: boolean): void => {
    const root = bodyAt([s * leg.root[0], leg.root[1], leg.root[2]])
    const rake = hind && gait.rake !== false ? sp.hindRake : 0
    const a1 = ang[0] + rake
    const a2 = a1 + ang[1] - rake
    const a3 = a2 + ang[2]
    // Angles are in the world's side plane, whatever the body's pitch: a leg that stands is 0.
    const dir = (deg: number): V => [0, -Math.cos(deg * DEG), Math.sin(deg * DEG)]
    const j1 = add(root, mul(dir(a1), leg.seg[0]))
    const j2 = add(j1, mul(dir(a2), leg.seg[1]))
    const j3 = add(j2, mul(dir(a3), leg.seg[2]))
    const side: V = [1, 0, 0]
    parts.push(part('ellipsoid', add(root, mul(dir(a1), 0.2 * leg.seg[0])), leg.upper, alongY(dir(a1), [0, 0, 1])))
    parts.push(limb('ellipsoid', root, j1, leg.width[0], leg.width[0] * 1.15, side, 1.15))
    parts.push(limb('capsule', j1, j2, leg.width[1], leg.width[1] * 1.1, side))
    parts.push(limb('capsule', j2, j3, leg.width[2], leg.width[2], side))
    // Hoof or paw: flat on the ground when the leg stands, along the foot when it does not.
    const standing = Math.abs(a3) < 30
    const footTurn = standing ? rotX(0) : alongZ(dir(a3 + 90), [0, 1, 0])
    const along = sp.paws ? 0.35 * leg.foot[2] : 0.1 * leg.foot[2]
    const fc = add(j3, ap(footTurn, [0, -0.3 * leg.foot[1], along]))
    parts.push(part(sp.paws ? 'ellipsoid' : 'cone', fc, sp.paws ? leg.foot : [leg.foot[0], leg.foot[1] * 1.4, leg.foot[2]], sp.paws ? footTurn : mm(footTurn, rotX(0))))
    lowest.push(fc)
  }
  const foreAng = a.pose === 'lie' && sp.paws ? SPHINX : gait.fore
  legAt(sp.fore, lead, foreAng[0], false)
  legAt(sp.fore, -lead, foreAng[1], false)
  legAt(sp.hind, lead, gait.hind[0], true)
  legAt(sp.hind, -lead, gait.hind[1], true)

  // --- neck and head ---
  const neckRoot = bodyAt([0, sp.neck.y, sp.neck.z])
  const turn = rotY(0.5 * a.headTurn)
  const neckAngle = sp.neck.angle + gait.neck + 0.6 * a.headRaise - 0.5 * gait.pitch
  const neckDir = ap(turn, [0, Math.sin(neckAngle * DEG), Math.cos(neckAngle * DEG)])
  const poll = add(neckRoot, mul(neckDir, sp.neck.length))
  parts.push(part('ellipsoid', add(neckRoot, mul(neckDir, 0.45 * sp.neck.length)), [sp.neck.width, sp.neck.length * 1.35, sp.neck.depth], alongY(neckDir, [0, -1, 0.3])))
  if (sp.mane === 'crest') {
    parts.push(part('ellipsoid', add(add(neckRoot, mul(neckDir, 0.55 * sp.neck.length)), mul(ap(alongY(neckDir, [0, 1, 0]), [0, 0, 1]), 0.09)), [0.06, sp.neck.length * 1.1, 0.08], alongY(neckDir, [0, 1, 0])))
  }
  const headTurn = rotY(a.headTurn)
  const headAngle = -sp.head.droop + gait.head + 0.4 * a.headRaise - gait.pitch * 0.4
  const headDir = ap(headTurn, [0, Math.sin(headAngle * DEG), Math.cos(headAngle * DEG)])
  const hf = alongZ(headDir, [0, 1, 0])
  const hl = sp.head.length
  const skullC = add(poll, ap(hf, [0, 0, 0.22 * hl]))
  const muzzleC = add(poll, ap(hf, [0, -0.03 * hl, hl - sp.head.muzzle[2] / 2]))
  parts.push(part('ellipsoid', skullC, sp.head.skull, hf))
  parts.push(part('ellipsoid', muzzleC, sp.head.muzzle, hf))
  if (sp.mane === 'ruff') {
    // A lion's mane: one great mass round the neck and the back of the head, the face in front of it.
    parts.push(part('ellipsoid', add(neckRoot, mul(neckDir, 0.8 * sp.neck.length)), [0.48, 0.56, 0.46], alongY(neckDir, [0, 0, 1])))
  }
  for (const s of [1, -1]) {
    const e = sp.ears
    const base = add(skullC, ap(hf, [s * e.spread, sp.head.skull[1] * 0.42, -0.25 * sp.head.skull[2]]))
    parts.push(part('cone', add(base, ap(hf, [0, e.size[1] * 0.35, 0])), e.size, mm(hf, rotX(e.rake), rotZ(-s * 12))))
    if (sp.horns) {
      const hb = add(skullC, ap(hf, [s * sp.head.skull[0] * 0.45, sp.head.skull[1] * 0.35, -0.1 * sp.head.skull[2]]))
      const hd = ap(hf, norm([s * 0.85, 0.45, 0.35]))
      parts.push(part('cone', add(hb, mul(hd, sp.horns.length / 2)), [sp.horns.base, sp.horns.length, sp.horns.base], alongY(hd, [0, 1, 0])))
    }
  }

  // --- tail ---
  // A chain of three tapering segments, each turned further along the carriage the tail has.
  const tailRoot = bodyAt([0, sp.tail.y, sp.tail.z])
  const strut = a.pose === 'rear'
  const bends: Record<Tail, V[]> = {
    down: [[0, -0.35, -1], [0, -1, -0.35], [0, -1, -0.05]],
    out: [[0, 0.2, -1], [0, 0.02, -1], [0.1, -0.15, -1]],
    raised: [[0, 0.7, -1], [0, 1, -0.15], [0, 0.6, 0.8]],
    curled: [[0.15, 0.7, -0.8], [0.3, 1, 0.25], [0.45, 0.15, 0.9]]
  }
  // A rearing animal stands on its hind legs and its tail, which reaches the ground.
  // Lying or sitting, a hanging tail lies along the ground and curls round instead.
  const resting = (a.pose === 'lie' || a.pose === 'sit') && a.tail === 'down'
  const chain = strut ? [[0, -0.4, -1], [0, -1, -0.3], [0, -1, 0]] as V[] : resting ? [[0, -0.7, -0.7], [0.45, -0.08, -0.9], [0.9, 0, -0.1]] as V[] : bends[a.tail] ?? bends.down
  const share = [0.3, 0.38, 0.32]
  let at = tailRoot
  let tailEnd = tailRoot
  for (let i = 0; i < 3; i++) {
    const d = strut ? norm(chain[i]!) : ap(body, norm(chain[i]!))
    let l = sp.tail.length * share[i]!
    if (strut && i === 2) l = Math.max(0.02, at[1] - 0.02)
    const next = add(at, mul(d, l))
    const w = sp.tail.width * (1 - 0.15 * i) * (strut ? 1.4 : 1)
    parts.push(limb('capsule', at, next, w, w, [1, 0, 0]))
    at = next
    tailEnd = next
  }
  if (sp.tail.tuft > 0) parts.push(part('ellipsoid', tailEnd, [sp.tail.tuft, sp.tail.tuft * 1.6, sp.tail.tuft]))
  if (strut) parts.push(part('ellipsoid', [tailEnd[0], 0.02, tailEnd[2] - 0.03], [0.14, 0.05, 0.16]))

  // --- scale, place ---
  const cm = parts.map(p => ({ ...p, c: mul(p.c, B), size: mul(p.size, B) }))
  const placed = place(cm, a.ground, a.facing, true, true)
  const world = (p: V) => placed.toWorld(mul(p, B))
  // The saddle: on the back just behind the withers, in the body's pitch.
  const saddle = bodyAt([0, by + bs[1] / 2, 0.12])
  const turnM = rotY(a.facing)
  return {
    shapes: placed.shapes,
    marks: {
      label: `${a.species}, ${a.pose}`,
      shapes: placed.shapes.length,
      min: placed.min,
      max: placed.max,
      points: {
        head: round3(world(add(skullC, mul(sub(muzzleC, skullC), 0.5)))),
        muzzle: round3(world(add(muzzleC, mul(headDir, sp.head.muzzle[2] / 2)))),
        back: round3(world(saddle)),
        tail_tip: round3(world(tailEnd))
      }
    },
    seat: { at: world(saddle), turn: turnM, halfWidth: 0.5 * bs[0] * B, pitch: gait.pitch }
  }
}

// One form's subjects, in order: animals first, so riders can sit on them. A figure that
// rides sits on the first animal (a second rider on the second, and so on); with no animal it
// sits on a seat of its own.
export function expandScene(scene: SceneSpec): SceneResult {
  const shapes: Shape[] = []
  const cuts: RoughCut[] = []
  const subjects: Landmarks[] = []
  const seats: Seat[] = []
  for (const a of scene.animals) {
    const r = expandAnimal(a)
    shapes.push(...r.shapes)
    subjects.push(r.marks)
    seats.push(r.seat)
  }
  let riders = 0
  for (const f of scene.figures) {
    const seat = f.legs === 'ride' && seats.length > 0 ? seats[riders++ % seats.length] : undefined
    const r = expandFigure(f, seat)
    shapes.push(...r.shapes)
    cuts.push(...r.cuts)
    subjects.push(r.marks)
  }
  shapes.push(...scene.shapes)
  return { shapes, cuts, subjects }
}
