import { BAND_VOXELS, FINISH } from './grid.ts'
import { valueNoise3 } from './rng.ts'
import type { CutStrike, ToolId } from './types.ts'

// How strike.ts applies a tool:
//   plane   one cut through the whole stone (the saw; issued as a 'saw' strike)
//   bite    removes a tool-shaped solid of revolution driven in along the strike direction
//   abrade  wears down high spots inside a pad, never deeper than the surface around them
//   burnish raises the finish of the surface inside a pad and moves no stone
export type ToolMode = 'plane' | 'bite' | 'abrade' | 'burnish'

// One row per tool. A bite's solid is a short shank of diameter `size` behind the contact
// point, tapering over `depth` to a flat tip of diameter `size * tip`.
export interface ToolSpec {
  id: ToolId
  mode: ToolMode
  // Finish value written to the surface the tool leaves.
  finish: number
  // Tip diameter as a fraction of size: near 0 is a point, 1 is a straight-sided plug.
  tip: number
  // Shank length behind the contact point as a fraction of size. It clears stone standing
  // proud around the contact point.
  shank: number
  // Seeded roughness of the cut face: amplitude and feature size as fractions of size.
  noise: number
  grain: number
  // Toothed tools: depth of the grooves the teeth leave and the spacing between teeth, as
  // fractions of size. 0 teeth is a plain edge.
  teeth: number
  pitch: number
  // A rounded end in place of the taper and flat tip: the bite is a straight shank closed by
  // a ball, and a row of them along a stroke leaves a concave channel.
  round?: boolean
}

export const TOOLS: Record<ToolId, ToolSpec> = {
  saw: { id: 'saw', mode: 'plane', finish: FINISH.sawn, tip: 1, shank: 0, noise: 0, grain: 1, teeth: 0, pitch: 1 },
  point: { id: 'point', mode: 'bite', finish: FINISH.point, tip: 0.1, shank: 0.5, noise: 0.12, grain: 0.4, teeth: 0, pitch: 1 },
  claw: { id: 'claw', mode: 'bite', finish: FINISH.claw, tip: 0.7, shank: 0.5, noise: 0.04, grain: 0.5, teeth: 0.06, pitch: 0.25 },
  flat: { id: 'flat', mode: 'bite', finish: FINISH.flat, tip: 0.8, shank: 0.5, noise: 0.03, grain: 0.5, teeth: 0, pitch: 1 },
  roundel: { id: 'roundel', mode: 'bite', finish: FINISH.roundel, tip: 1, shank: 0.5, noise: 0.02, grain: 0.5, teeth: 0, pitch: 1, round: true },
  // A straight bore: the bit is a plug as wide at its tip as at its mouth.
  drill: { id: 'drill', mode: 'bite', finish: FINISH.drill, tip: 1, shank: 0.5, noise: 0.05, grain: 0.5, teeth: 0, pitch: 1 },
  rasp: { id: 'rasp', mode: 'abrade', finish: FINISH.rasp, tip: 1, shank: 0, noise: 0, grain: 1, teeth: 0, pitch: 1 },
  polish: { id: 'polish', mode: 'burnish', finish: FINISH.polished, tip: 1, shank: 0, noise: 0, grain: 1, teeth: 0, pitch: 1 }
}

export function toolSpec(id: ToolId): ToolSpec {
  const spec = TOOLS[id]
  // A log may name anything.
  if (!spec) throw new Error(`no such tool: ${String(id)}`)
  return spec
}

// Stone a bite takes out of a flat face struck square on, before noise: the volume of the
// tapered part. The hand uses it to budget strikes.
export function nominalBiteCm3(spec: ToolSpec, size: number, depth: number): number {
  const r = size / 2
  const rt = r * spec.tip
  return Math.PI * depth * (r * r + r * rt + rt * rt) / 3
}

// A bite strike resolved to plain numbers, so the per-voxel loop allocates nothing.
export interface PreparedTool {
  ax: number
  ay: number
  az: number
  dx: number
  dy: number
  dz: number
  radius: number
  tipRadius: number
  depth: number
  back: number
  amp: number
  // Noise lattice cells per cm.
  freq: number
  seed: number
  // Teeth: unit vector they are spaced along (at right angles to the strike direction),
  // groove depth in cm (0 for a plain edge) and teeth per cm.
  ux: number
  uy: number
  uz: number
  teeth: number
  teethFreq: number
  // Beyond this distance from the tool's surface the stored value is clamped whatever the
  // noise and teeth say, so both are skipped. Also the padding of the strike's bounding box.
  reach: number
  // Rounded tools: the ball that closes the end, as its radius and where its centre sits along
  // the strike direction from the contact point, and how far along the straight side runs
  // before the ball takes over. A cut shallower than half its width is a cap of a wider ball,
  // so the channel is still as wide as asked.
  round: boolean
  ballRadius: number
  ballAt: number
  sideEnd: number
}

export function prepareTool(spec: ToolSpec, strike: CutStrike, voxel: number): PreparedTool {
  const [dx, dy, dz] = strike.dir
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (!(len > 0)) throw new Error('strike direction has no length')
  const size = Math.max(strike.size, voxel)
  const amp = spec.noise * size
  // Features finer than a couple of voxels would alias on the grid.
  const feature = Math.max(spec.grain * size, 2.5 * voxel)
  const nx = dx / len
  const ny = dy / len
  const nz = dz / len
  // The teeth run across the stroke. Whatever was asked for is squared up against the strike
  // direction; with nothing usable, across is the horizontal at right angles to it, or X for
  // a strike going straight up or down.
  let ux = 0
  let uy = 0
  let uz = 0
  const teeth = spec.teeth * size
  if (teeth > 0) {
    const tries: (readonly number[])[] = [[nz, 0, -nx], [1, 0, 0]]
    if (strike.across) tries.unshift(strike.across)
    for (const [cx, cy, cz] of tries) {
      const along = cx! * nx + cy! * ny + cz! * nz
      ux = cx! - along * nx
      uy = cy! - along * ny
      uz = cz! - along * nz
      const ul = Math.sqrt(ux * ux + uy * uy + uz * uz)
      if (ul > 0.05) {
        ux /= ul
        uy /= ul
        uz /= ul
        break
      }
    }
  }
  const depth = Math.max(strike.depth, voxel / 8)
  const radius = size / 2
  const ballRadius = depth < radius ? (radius * radius + depth * depth) / (2 * depth) : radius
  return {
    ax: strike.at[0],
    ay: strike.at[1],
    az: strike.at[2],
    dx: nx,
    dy: ny,
    dz: nz,
    radius,
    tipRadius: size / 2 * spec.tip,
    depth,
    back: spec.shank * size,
    amp,
    freq: 1 / feature,
    seed: strike.seed | 0,
    ux,
    uy,
    uz,
    teeth,
    // Grooves narrower than three voxels would alias on the grid.
    teethFreq: 1 / Math.max(spec.pitch * size, 3 * voxel),
    reach: BAND_VOXELS * voxel + amp + teeth,
    round: spec.round === true,
    ballRadius,
    ballAt: depth - ballRadius,
    sideEnd: Math.max(0, depth - ballRadius)
  }
}

// Exact distance to the bite solid's profile in the (radial, along-axis) half plane, which is
// also the 3D distance to the solid of revolution. w runs along the strike direction from the
// contact point.
function profileDistance(r: number, w: number, t: PreparedTool): number {
  const R = t.radius
  const rt = t.tipRadius
  const depth = t.depth
  const back = t.back
  // Back cap.
  let dr = r > R ? r - R : 0
  let dw = w + back
  let best = dr * dr + dw * dw
  // Shank.
  dr = r - R
  dw = w < -back ? w + back : w > 0 ? w : 0
  let d2 = dr * dr + dw * dw
  if (d2 < best) best = d2
  // Taper, from the mouth (R, 0) to the tip rim (rt, depth).
  const ex = rt - R
  let s = ((r - R) * ex + w * depth) / (ex * ex + depth * depth)
  s = s < 0 ? 0 : s > 1 ? 1 : s
  dr = r - R - ex * s
  dw = w - depth * s
  d2 = dr * dr + dw * dw
  if (d2 < best) best = d2
  // Tip face.
  dr = r > rt ? r - rt : 0
  dw = w - depth
  d2 = dr * dr + dw * dw
  if (d2 < best) best = d2
  const d = Math.sqrt(best)
  const inside = w > -back && w < depth && r < (w <= 0 ? R : R + ex * w / depth)
  return inside ? -d : d
}

// The same for a rounded tool: a back cap, a straight side, and the arc of the ball from the
// end of the side round to the axis.
function roundDistance(r: number, w: number, t: PreparedTool): number {
  const R = t.radius
  const back = t.back
  const end = t.sideEnd
  // Back cap.
  let dr = r > R ? r - R : 0
  let dw = w + back
  let best = dr * dr + dw * dw
  // Side.
  dr = r - R
  dw = w < -back ? w + back : w > end ? w - end : 0
  let d2 = dr * dr + dw * dw
  if (d2 < best) best = d2
  // Ball. Outside the arc's own sweep its nearest point is where it meets the side, which
  // the side has already counted.
  const vw = w - t.ballAt
  const d2c = r * r + vw * vw
  const len = Math.sqrt(d2c)
  if (vw * t.ballRadius >= (end - t.ballAt) * len) {
    d2 = (len - t.ballRadius) * (len - t.ballRadius)
    if (d2 < best) best = d2
  }
  const d = Math.sqrt(best)
  const inside = w > -back && (w <= end ? r < R : d2c < t.ballRadius * t.ballRadius)
  return inside ? -d : d
}

// Distance from a world point to the tool solid, cm, negative inside it, roughened by the
// strike's seeded noise.
export function toolDistance(t: PreparedTool, x: number, y: number, z: number): number {
  const px = x - t.ax
  const py = y - t.ay
  const pz = z - t.az
  const w = px * t.dx + py * t.dy + pz * t.dz
  const r2 = px * px + py * py + pz * pz - w * w
  const r = r2 > 0 ? Math.sqrt(r2) : 0
  let d = t.round ? roundDistance(r, w, t) : profileDistance(r, w, t)
  if (t.amp > 0 && d < t.reach && d > -t.reach) {
    d -= t.amp * valueNoise3(px * t.freq, py * t.freq, pz * t.freq, t.seed)
  }
  if (t.teeth > 0 && d < t.reach && d > -t.reach) {
    // A triangle wave across the stroke, placed in block coordinates (not relative to the
    // contact point) so the grooves of one bite carry on into the next.
    const u = (x * t.ux + y * t.uy + z * t.uz) * t.teethFreq
    const f = u - Math.floor(u)
    d -= t.teeth * (4 * (f < 0.5 ? 0.5 - f : f - 0.5) - 1)
  }
  return d
}
