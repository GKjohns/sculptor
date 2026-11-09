// Seeded randomness for the kernel and the hand. Nothing here (or anywhere in shared/sculpt)
// may call Math.random, and the arithmetic sticks to operations every JS engine rounds the
// same way, so a strike log replays bit for bit in any browser and in Node.

export interface Rng {
  // Uniform in [0, 1).
  next: () => number
  range: (lo: number, hi: number) => number
  // Uniform integer in [0, n).
  int: (n: number) => number
}

// mulberry32
export function createRng(seed: number): Rng {
  let s = seed | 0
  const next = () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: n => Math.floor(next() * n)
  }
}

// Folds integers into one 32-bit seed, e.g. hashSeed(passSeed, strikeIndex).
export function hashSeed(...parts: number[]): number {
  let h = 0x9e3779b9 | 0
  for (let i = 0; i < parts.length; i++) {
    h = Math.imul(h ^ (parts[i]! | 0), 0x85ebca6b)
    h ^= h >>> 13
    h = Math.imul(h, 0xc2b2ae35)
    h ^= h >>> 16
  }
  return h >>> 0
}

// Lattice value in [-1, 1).
function lattice(ix: number, iy: number, iz: number, seed: number): number {
  let h = seed ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(iz, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 2147483648 - 1
}

// Smooth value noise in [-1, 1] with features about one unit across.
export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = x - ix
  const fy = y - iy
  const fz = z - iz
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const uz = fz * fz * (3 - 2 * fz)
  const a00 = lattice(ix, iy, iz, seed)
  const a10 = lattice(ix + 1, iy, iz, seed)
  const a01 = lattice(ix, iy + 1, iz, seed)
  const a11 = lattice(ix + 1, iy + 1, iz, seed)
  const b00 = lattice(ix, iy, iz + 1, seed)
  const b10 = lattice(ix + 1, iy, iz + 1, seed)
  const b01 = lattice(ix, iy + 1, iz + 1, seed)
  const b11 = lattice(ix + 1, iy + 1, iz + 1, seed)
  const a0 = a00 + (a10 - a00) * ux
  const a1 = a01 + (a11 - a01) * ux
  const b0 = b00 + (b10 - b00) * ux
  const b1 = b01 + (b11 - b01) * ux
  const a = a0 + (a1 - a0) * uy
  const b = b0 + (b1 - b0) * uy
  return a + (b - a) * uz
}
