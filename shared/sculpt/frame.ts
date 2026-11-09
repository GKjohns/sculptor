// The geometry the canon (anatomy.ts, hair.ts, torso.ts) builds with: a part's own frame placed,
// sized and posed in the block, and kernel shapes made in it. Plain arithmetic, rounded to a
// thousandth so a log written on one engine replays on another.

import type { Shape, ShapeKind, Vec3 } from './types.ts'

export type Mat = [number, number, number, number, number, number, number, number, number]

const DEG = Math.PI / 180
export const r3 = (v: number) => Math.round(v * 1000) / 1000

// three.js 'XYZ' Euler to a rotation matrix, row-major.
export function matrixOf(rotation: Vec3): Mat {
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
export function eulerOf(m: Mat): Vec3 {
  const m13 = m[2]
  const y = Math.asin(Math.max(-1, Math.min(1, m13)))
  if (Math.abs(m13) < 0.9999999) {
    return [Math.atan2(-m[5], m[8]) / DEG, y / DEG, Math.atan2(-m[1], m[0]) / DEG]
  }
  return [Math.atan2(m[7], m[4]) / DEG, y / DEG, 0]
}

export function multiply(a: Mat, b: Mat): Mat {
  const out = new Array<number>(9) as Mat
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!
    }
  }
  return out
}

export function apply(m: Mat, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
  ]
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const length = (a: Vec3) => Math.sqrt(dot(a, a))
export function normalize(a: Vec3): Vec3 {
  const l = length(a)
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0]
}

// A part's frame: its centre in the block, the per-axis stretch from the canon's own size to the
// one declared, and its pose.
export interface Frame {
  center: Vec3
  stretch: Vec3
  pose: Mat
}

export function frameOf(center: Vec3, size: Vec3, canon: Vec3, rotation: Vec3): Frame {
  return {
    center,
    stretch: [Math.abs(size[0]) / canon[0], Math.abs(size[1]) / canon[1], Math.abs(size[2]) / canon[2]],
    pose: matrixOf(rotation)
  }
}

// A canon point to block cm.
export function toWorld(f: Frame, p: Vec3): Vec3 {
  return add(f.center, apply(f.pose, [p[0] * f.stretch[0], p[1] * f.stretch[1], p[2] * f.stretch[2]]))
}

// A canon direction to a block direction (a surface direction, so by the inverse stretch).
export function dirToWorld(f: Frame, d: Vec3): Vec3 {
  return normalize(apply(f.pose, [d[0] / f.stretch[0], d[1] / f.stretch[1], d[2] / f.stretch[2]]))
}

// The mean stretch: what a length in the canon becomes, for sizes that have no axis.
export function meanStretch(f: Frame): number {
  return (f.stretch[0] + f.stretch[1] + f.stretch[2]) / 3
}

// A solid laid out in the canon frame: centre, size and rotation there, made a block shape. Its
// size along each of its own axes is stretched by the block axes that axis runs along.
export function partShape(f: Frame, kind: ShapeKind, center: Vec3, size: Vec3, rotation: Vec3 = [0, 0, 0]): Shape {
  const local = matrixOf(rotation)
  const out: Vec3 = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    let s = 0
    let w = 0
    for (let j = 0; j < 3; j++) {
      const weight = Math.abs(local[j * 3 + i]!)
      s += weight * f.stretch[j]!
      w += weight
    }
    out[i] = size[i]! * (w > 0 ? s / w : 1)
  }
  return rounded({ kind, center: toWorld(f, center), size: out, rotation: eulerOf(multiply(f.pose, local)) })
}

// A capsule or cone from a to b in block cm, thickness tx across and tz the other way; `toward`
// says which way the tz side faces (the cross-section's local Z is turned toward it).
export function between(kind: 'capsule' | 'cone' | 'ellipsoid', a: Vec3, b: Vec3, tx: number, tz: number, toward: Vec3 = [0, 0, 1]): Shape {
  const axis = sub(b, a)
  const len = length(axis)
  const y = normalize(axis)
  let z = sub(toward, scale(y, dot(toward, y)))
  if (length(z) < 1e-6) z = Math.abs(y[0]) < 0.9 ? cross([1, 0, 0], y) : cross([0, 0, 1], y)
  z = normalize(z)
  const x = cross(y, z)
  // Columns are the shape's own axes in the block.
  const m: Mat = [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]]
  const along = kind === 'capsule' ? len + tx : len
  return rounded({ kind, center: lerp(a, b, 0.5), size: [tx, Math.max(along, tx * 1.01), tz], rotation: eulerOf(m) })
}

export function rounded(s: Shape): Shape {
  return {
    kind: s.kind,
    center: [r3(s.center[0]), r3(s.center[1]), r3(s.center[2])],
    size: [r3(Math.max(0.2, s.size[0])), r3(Math.max(0.2, s.size[1])), r3(Math.max(0.2, s.size[2]))],
    rotation: [r3(s.rotation[0]), r3(s.rotation[1]), r3(s.rotation[2])]
  }
}

// Euler angles (degrees, 'XYZ') of the frame whose own Z is `z` and whose own Y is as near
// `up` as that allows.
export function eulerFromZ(z: Vec3, up: Vec3 = [0, 1, 0]): Vec3 {
  const zz = normalize(z)
  let y = sub(up, scale(zz, dot(up, zz)))
  if (length(y) < 1e-6) y = Math.abs(zz[0]) < 0.9 ? cross(zz, [1, 0, 0]) : cross(zz, [0, 0, 1])
  y = normalize(y)
  const x = cross(y, zz)
  return eulerOf([x[0], y[0], zz[0], x[1], y[1], zz[1], x[2], y[2], zz[2]])
}

// Euler angles of the frame whose own Y runs along `y`, its own Z as near `z` as that allows.
export function eulerFromY(y: Vec3, z: Vec3 = [0, 0, 1]): Vec3 {
  const yy = normalize(y)
  let zz = sub(z, scale(yy, dot(z, yy)))
  if (length(zz) < 1e-6) zz = Math.abs(yy[0]) < 0.9 ? cross([1, 0, 0], yy) : cross([0, 0, 1], yy)
  zz = normalize(zz)
  const x = cross(yy, zz)
  return eulerOf([x[0], yy[0], zz[0], x[1], yy[1], zz[1], x[2], yy[2], zz[2]])
}
