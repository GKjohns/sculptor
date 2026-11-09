// The sculptor's canon: solids the model can declare that stand for a whole anatomical part
// and expand, before anything reaches the kernel, into the kernel's own primitives. A `head`
// is the one that exists so far: a skull with its face already on it, built the way a clay
// head is built up, by adding masses. The eye sockets, the hollows beside the nose and the
// line of the mouth are the gaps between those masses; the form stays a plain smooth union
// and the log never sees a kind the kernel does not know.
//
// The model places, sizes and poses the head (its size is the skull: temple to temple, chin
// to crown, brow to the back of the skull; nose and ears stand outside it) and adds hair,
// a beard or a heavier nose as shapes of its own. Everything here is in a head of the
// reference proportions below and scaled per axis to the one declared.

import type { Shape, ShapeKind, Vec3 } from './types.ts'

export type CanonKind = 'head'
export type DeclaredKind = ShapeKind | CanonKind
export interface DeclaredShape extends Omit<Shape, 'kind'> { kind: DeclaredKind }

// The canon head, cm: width between the temples, chin to crown, brow to the back of the skull.
const HEAD: Vec3 = [15.5, 23, 19.5]
// Where the chin sits in the canon's own frame, whose origin is the centre of the skull box.
const CHIN = -HEAD[1] / 2

// Each part: kind, centre (x, y from the chin, z from the skull's mid-depth), size, rotation.
// Mirrored parts are listed once with a positive x and expanded to both sides.
type Part = [ShapeKind, number, number, number, number, number, number, number, number, number, boolean?]
const HEAD_PARTS: Part[] = [
  // The skull: cranium, the frontal bone standing a little proud of it, the two brow ridges.
  ['ellipsoid', 0, 15.0, -0.8, 15.5, 16.5, 19.0, 0, 0, 0],
  ['ellipsoid', 0, 16.5, 4.8, 14.2, 10.5, 8.6, 0, 0, 0],
  ['ellipsoid', 3.3, 13.0, 7.2, 6.4, 1.5, 2.6, 0, 0, -10, true],
  // The face: one mass from brow to mouth that is the floor of the sockets and the cheeks,
  // the cheekbones on it, the eyes set back under the brow, the muzzle under the nose.
  ['ellipsoid', 0, 9.6, 2.2, 14.2, 11.0, 11.0, 0, 0, 0],
  ['ellipsoid', 5.0, 10.4, 4.6, 6.0, 4.4, 4.8, 0, 0, 0, true],
  ['ellipsoid', 3.1, 11.4, 6.0, 3.6, 1.9, 2.6, 0, 0, 0, true],
  ['ellipsoid', 0, 6.3, 5.2, 8.0, 5.0, 5.6, 0, 0, 0],
  // The nose: a cone from the nasion down and forward to the tip, the tip, the wings.
  ['cone', 0, 10.0, 8.9, 2.6, 5.8, 2.6, -34, 0, 0],
  ['ellipsoid', 0, 8.2, 9.3, 3.2, 2.6, 3.0, 0, 0, 0],
  ['ellipsoid', 1.3, 7.8, 8.6, 1.9, 1.8, 2.3, 0, 0, 0, true],
  // The mouth and chin: upper lip, lower lip, the chin set back from them.
  ['ellipsoid', 0, 6.6, 6.9, 5.6, 2.2, 3.6, 0, 0, 0],
  ['ellipsoid', 0, 4.9, 6.6, 4.8, 1.8, 3.4, 0, 0, 0],
  ['ellipsoid', 0, 2.6, 5.4, 6.4, 4.6, 5.0, 0, 0, 0],
  // The jaw: widest under the ears, narrowing to the chin.
  ['ellipsoid', 0, 4.6, 1.6, 10.6, 8.0, 11.0, 0, 0, 0],
  // Ears, standing off the skull between brow and nose base, tilted back a little.
  ['ellipsoid', 7.5, 10.3, -1.8, 1.4, 5.4, 2.8, -12, 0, 0, true]
]

// How many kernel shapes a head becomes.
export const HEAD_SHAPE_COUNT = HEAD_PARTS.reduce((n, p) => n + (p[10] ? 2 : 1), 0)

const DEG = Math.PI / 180
const r3 = (v: number) => Math.round(v * 1000) / 1000

type Mat = [number, number, number, number, number, number, number, number, number]

// three.js 'XYZ' Euler to a rotation matrix, row-major.
function matrixOf(rotation: Vec3): Mat {
  const a = Math.cos(rotation[0] * DEG)
  const b = Math.sin(rotation[0] * DEG)
  const c = Math.cos(rotation[1] * DEG)
  const d = Math.sin(rotation[1] * DEG)
  const e = Math.cos(rotation[2] * DEG)
  const f = Math.sin(rotation[2] * DEG)
  return [
    c * e, -c * f, d,
    a * f + b * e * d, a * e - b * f * d, -b * c,
    b * f - a * e * d, b * e + a * f * d, a * c
  ]
}

// The matrix back to 'XYZ' Euler angles in degrees (three.js setFromRotationMatrix).
function eulerOf(m: Mat): Vec3 {
  const m13 = m[2]
  const y = Math.asin(Math.max(-1, Math.min(1, m13)))
  if (Math.abs(m13) < 0.9999999) {
    return [Math.atan2(-m[5], m[8]) / DEG, y / DEG, Math.atan2(-m[1], m[0]) / DEG]
  }
  return [Math.atan2(m[7], m[4]) / DEG, y / DEG, 0]
}

function multiply(a: Mat, b: Mat): Mat {
  const out = new Array<number>(9) as Mat
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!
    }
  }
  return out
}

function apply(m: Mat, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
  ]
}

// The canon head placed, sized and posed as declared: a list of kernel shapes.
export function expandHead(head: Omit<Shape, 'kind'>): Shape[] {
  const scale: Vec3 = [Math.abs(head.size[0]) / HEAD[0], Math.abs(head.size[1]) / HEAD[1], Math.abs(head.size[2]) / HEAD[2]]
  const pose = matrixOf(head.rotation)
  const out: Shape[] = []
  for (const part of HEAD_PARTS) {
    const sides = part[10] ? [1, -1] : [1]
    for (const side of sides) {
      const local = matrixOf([part[7], part[8], part[9]])
      // Size along each local axis, scaled by the block axes that local axis runs along.
      const size: Vec3 = [0, 0, 0]
      for (let i = 0; i < 3; i++) {
        let s = 0
        let w = 0
        for (let j = 0; j < 3; j++) {
          const weight = Math.abs(local[j * 3 + i]!)
          s += weight * scale[j]!
          w += weight
        }
        size[i] = (part[4 + i] as number) * (w > 0 ? s / w : 1)
      }
      const centre: Vec3 = [side * part[1] * scale[0], (part[2] + CHIN) * scale[1], part[3] * scale[2]]
      // A mirrored part turns the other way about Y and Z.
      const rotation: Vec3 = [part[7], side * part[8], side * part[9]]
      const world = apply(pose, centre)
      const euler = eulerOf(multiply(pose, matrixOf(rotation)))
      out.push({
        kind: part[0],
        center: [r3(head.center[0] + world[0]), r3(head.center[1] + world[1]), r3(head.center[2] + world[2])],
        size: [r3(size[0]), r3(size[1]), r3(size[2])],
        rotation: [r3(euler[0]), r3(euler[1]), r3(euler[2])]
      })
    }
  }
  return out
}

// Every declared shape as kernel shapes: canon kinds expanded, the rest passed through.
export function expandShapes(shapes: DeclaredShape[]): Shape[] {
  const out: Shape[] = []
  for (const s of shapes) {
    if (s.kind === 'head') out.push(...expandHead(s))
    else out.push({ kind: s.kind, center: s.center, size: s.size, rotation: s.rotation })
  }
  return out
}

export function isCanonKind(kind: string): kind is CanonKind {
  return kind === 'head'
}
