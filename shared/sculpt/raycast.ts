import { BAND_VOXELS, Q_MAX } from './grid.ts'
import type { Grid, RayHit, Vec3 } from './types.ts'

// Distance to the surface at any world point, cm, by trilinear interpolation. Never more
// than the band (4 voxels) either way; outside the grid it reads as open air.
export function sampleDistance(grid: Grid, x: number, y: number, z: number): number {
  const { nx, ny, nz, dist } = grid
  const fx = (x - grid.x0) / grid.voxel
  const fy = (y - grid.y0) / grid.voxel
  const fz = (z - grid.z0) / grid.voxel
  const air = BAND_VOXELS * grid.voxel
  if (!(fx >= 0 && fy >= 0 && fz >= 0 && fx < nx - 1 && fy < ny - 1 && fz < nz - 1)) return air
  const ix = Math.floor(fx)
  const iy = Math.floor(fy)
  const iz = Math.floor(fz)
  const tx = fx - ix
  const ty = fy - iy
  const tz = fz - iz
  const i = ix + nx * (iy + ny * iz)
  const j = i + nx * ny
  const a0 = dist[i]! + (dist[i + 1]! - dist[i]!) * tx
  const a1 = dist[i + nx]! + (dist[i + nx + 1]! - dist[i + nx]!) * tx
  const b0 = dist[j]! + (dist[j + 1]! - dist[j]!) * tx
  const b1 = dist[j + nx]! + (dist[j + nx + 1]! - dist[j + nx]!) * tx
  const a = a0 + (a1 - a0) * ty
  const b = b0 + (b1 - b0) * ty
  return (a + (b - a) * tz) * air / Q_MAX
}

// Unit normal of the distance field at a world point, pointing out of the stone.
export function sampleNormal(grid: Grid, x: number, y: number, z: number): Vec3 {
  const h = grid.voxel / 2
  const gx = sampleDistance(grid, x + h, y, z) - sampleDistance(grid, x - h, y, z)
  const gy = sampleDistance(grid, x, y + h, z) - sampleDistance(grid, x, y - h, z)
  const gz = sampleDistance(grid, x, y, z + h) - sampleDistance(grid, x, y, z - h)
  const len = Math.sqrt(gx * gx + gy * gy + gz * gz)
  return len > 0 ? [gx / len, gy / len, gz / len] : [0, 1, 0]
}

// First point where a ray meets the stone, or null. dir need not be unit length; distance is
// in cm along the ray. A ray that starts inside the stone hits at its origin.
export function raycast(grid: Grid, origin: Vec3, dir: Vec3, maxDistance = 1e9): RayHit | null {
  const len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2])
  if (!(len > 0)) return null
  const dx = dir[0] / len
  const dy = dir[1] / len
  const dz = dir[2] / len
  const [ox, oy, oz] = origin

  // Clip the ray to the grid; there is no stone outside it.
  let t = 0
  let end = maxDistance
  const lo = [grid.x0, grid.y0, grid.z0]
  const n = [grid.nx, grid.ny, grid.nz]
  const o = [ox, oy, oz]
  const d = [dx, dy, dz]
  for (let axis = 0; axis < 3; axis++) {
    const min = lo[axis]!
    const max = min + (n[axis]! - 1) * grid.voxel
    if (d[axis] === 0) {
      if (o[axis]! < min || o[axis]! > max) return null
      continue
    }
    const t0 = (min - o[axis]!) / d[axis]!
    const t1 = (max - o[axis]!) / d[axis]!
    if (t0 < t1) {
      if (t0 > t) t = t0
      if (t1 < end) end = t1
    } else {
      if (t1 > t) t = t1
      if (t0 < end) end = t0
    }
  }
  if (t > end) return null

  // Sphere tracing: the stored distance says how far it is safe to step. Tool noise makes
  // the field slightly steeper than a true distance in places, hence stepping a bit short,
  // and no step is shorter than a quarter voxel so grazing rays still make progress.
  const minStep = grid.voxel / 4
  let dist = sampleDistance(grid, ox + dx * t, oy + dy * t, oz + dz * t)
  if (dist >= 0) {
    for (;;) {
      if (t >= end) return null
      const step = dist * 0.8 > minStep ? dist * 0.8 : minStep
      const next = t + step < end ? t + step : end
      const far = sampleDistance(grid, ox + dx * next, oy + dy * next, oz + dz * next)
      if (far < 0) {
        // The surface is between t and next; close in on it.
        let a = t
        let b = next
        for (let k = 0; k < 10; k++) {
          const m = (a + b) / 2
          if (sampleDistance(grid, ox + dx * m, oy + dy * m, oz + dz * m) < 0) b = m
          else a = m
        }
        t = (a + b) / 2
        break
      }
      t = next
      dist = far
    }
  }
  const point: Vec3 = [ox + dx * t, oy + dy * t, oz + dz * t]
  return { point, normal: sampleNormal(grid, point[0], point[1], point[2]), distance: t }
}
