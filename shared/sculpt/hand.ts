import { DENSITY, Q_PER_VOXEL, stoneVolumeCm3 } from './grid.ts'
import { raycast, sampleDistance } from './raycast.ts'
import { createRng, hashSeed } from './rng.ts'
import { compileForm, formDistance } from './shapes.ts'
import { applyStrike } from './strike.ts'
import { toolSpec } from './tools.ts'
import { VIEWS, isAxisView, viewRay } from './views.ts'
import type { AxisView } from './views.ts'
import type { CompiledForm, CutStrike, Form, FormStrike, Grid, Offcut, RayHit, SawStrike, SketchStrike, Strike, Vec3 } from './types.ts'

export { silhouetteForm } from './silhouette.ts'
export type { BlockSize, Mask } from './silhouette.ts'

// The hand. The model issues a pass; the hand reads the true stone and turns the pass into
// the individual strikes seen on screen. Each strike is applied to the grid as it is made
// (later strikes depend on the stone earlier ones left) and the whole list is returned, so
// the caller can log it and play it again on a second copy of the stone. Same grid plus same
// pass gives the same strikes, and those strikes replayed give the same stone, bit for bit:
// nothing here may use Math.random, trigonometry or the clock.

// A point read off an axis view's rulers, in block cm: [horizontal, vertical]. That is
// [x, y] in front and back, [z, y] in left and right, [x, z] in top.
export type RulerPoint = [number, number]

export interface PassHit {
  ruler: RulerPoint
  // Where the ray from that ruler point first met the stone; null if it met none.
  point: Vec3 | null
}

export interface RoughOutStats {
  // The form every chisel strike names as protected, and the margin each one carries.
  protect: string
  marginCm: number
  saws: number
  slabCm3: number
  chiselStrikes: number
  chiselCm3: number
  // Loose pieces the island checks dropped.
  looseCm3: number
  // One row per layer worked, outermost first: the tip level above the margin, bite size.
  levels: { floorCm: number, sizeCm: number, strikes: number }[]
  // Extra blows at crumbs left standing after the last layer.
  tidyStrikes: number
  // Stone still standing outside target + margin, measured over the surface.
  proudMaxCm: number
  proudMeanCm: number
}

export interface PassResult {
  // Everything to append to the strike log, in order, ending with a 'detach' (a polish and a
  // sketch move no stone and have none). Already applied to the grid that was passed in.
  // Empty when the pass was refused.
  strikes: Strike[]
  removedCm3: number
  hits: PassHit[]
  offcuts: Offcut[]
  // Virtual time the strikes take on the timeline.
  ms: number
  // One or two sentences for the model: what came off and where the tool landed.
  summary: string
  // Set when the pass could not be carried out as asked; nothing was cut.
  error?: string
  stats?: RoughOutStats
  // Drill only: where the bit went in, how deep the hole is, and whether it came out into air.
  bore?: { entry: Vec3, depthCm: number, through: boolean }
  // Polish only: the mean finish (0 rough to 255 polished) under the path before and after.
  sheen?: { before: number, after: number }
  // Sketch only: how much of the line landed on the stone, cm, and how much fell off it.
  line?: { drawnCm: number, missedCm: number }
}

export type Discard = 'above' | 'below' | 'left' | 'right'

export interface SawPass {
  view: string
  from: RulerPoint
  to: RulerPoint
  // The side of the cut line that falls away, as seen in that view's image.
  discard: Discard
}

export interface ChiselPass {
  tool: 'point' | 'claw' | 'flat' | 'roundel'
  view: string
  path: RulerPoint[]
  depth_cm: number
  width_cm: number
  // A declared form the stroke may not cut into. Left out, the stroke cuts whatever it meets.
  protect?: string
}

export interface RaspPass {
  view: string
  path: RulerPoint[]
  width_cm: number
  passes: number
}

export interface DrillPass {
  view: string
  at: RulerPoint
  diameter_cm: number
  depth_cm: number
}

export interface PolishPass {
  view: string
  path: RulerPoint[]
  width_cm: number
  passes: number
}

export interface SketchPass {
  view: string
  path: RulerPoint[]
}

export interface RoughOutPass {
  // A form already declared on the grid, by name, or the form itself (primitives, or a
  // silhouette from silhouetteForm). It has to be data, not a callback: the protection it
  // gives is written to the log as a `form` entry so a replay clips the same strikes.
  to: string | Form
  margin_cm: number
  tool: 'point' | 'claw'
  // Roughly how many chisel strikes the pass may take; bites get wider to stay near it.
  max_strikes?: number
}

// ---------- shared plumbing ----------

interface Run {
  grid: Grid
  strikes: Strike[]
  removedCm3: number
  offcuts: Offcut[]
  ms: number
  // Virtual time worked since the last island check.
  unchecked: number
}

function begin(grid: Grid): Run {
  return { grid, strikes: [], removedCm3: 0, offcuts: [], ms: 0, unchecked: 0 }
}

function emit(run: Run, strike: Strike): number {
  const result = applyStrike(run.grid, strike)
  run.strikes.push(strike)
  run.removedCm3 += result.removedCm3
  for (let i = 0; i < result.offcuts.length; i++) run.offcuts.push(result.offcuts[i]!)
  if (strike.kind === 'cut' || strike.kind === 'saw' || strike.kind === 'sketch') run.ms += strike.ms
  if (strike.kind === 'cut' || strike.kind === 'saw') run.unchecked += strike.ms
  else if (strike.kind === 'detach') run.unchecked = 0
  return result.removedCm3
}

// Stone cut free must not hang in the air while the hand works on around it. The island
// check only runs where the log says so, so a pass puts one in whenever this much virtual
// time has gone by since the last: a freed piece then falls within about two seconds of
// work, whatever the length of the pass. Each check costs a few milliseconds on a full block.
export const DETACH_EVERY_MS = 2000

// Call after a strike. Returns the stone that fell, cm³.
function dropLoose(run: Run): number {
  return run.unchecked >= DETACH_EVERY_MS ? emit(run, { kind: 'detach' }) : 0
}

function done(run: Run, hits: PassHit[], summary: string): PassResult {
  return { strikes: run.strikes, removedCm3: run.removedCm3, hits, offcuts: run.offcuts, ms: run.ms, summary }
}

function refuse(message: string): PassResult {
  return { strikes: [], removedCm3: 0, hits: [], offcuts: [], ms: 0, summary: message, error: message }
}

const cents = (v: number) => Math.round(v * 100) / 100
const r3 = (v: number) => Math.round(v * 1000) / 1000
const r5 = (v: number) => Math.round(v * 1e5) / 1e5
const clamp = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v
const kg = (cm3: number) => cm3 * DENSITY / 1000

function isPoint(p: unknown): p is RulerPoint {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
}

function show(p: Vec3): string {
  return `(x ${p[0].toFixed(1)}, y ${p[1].toFixed(1)}, z ${p[2].toFixed(1)})`
}

function showRuler(p: RulerPoint): string {
  return `[${r3(p[0])}, ${r3(p[1])}]`
}

function amount(cm3: number): string {
  if (cm3 < 1000) return `${cm3.toFixed(cm3 < 10 ? 1 : 0)} cm³`
  const whole = String(Math.round(cm3))
  const head = whole.length % 3 || 3
  let grouped = whole.slice(0, head)
  for (let i = head; i < whole.length; i += 3) grouped += `,${whole.slice(i, i + 3)}`
  return `${grouped} cm³ (${kg(cm3).toFixed(1)} kg)`
}

function hashText(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

// One seed per pass from what the pass says; each strike then mixes in its own index.
function passSeed(label: string, numbers: number[]): number {
  let h = hashText(label)
  for (let i = 0; i < numbers.length; i++) h = hashSeed(h, Math.round(numbers[i]! * 1000))
  return h
}

function castView(grid: Grid, view: AxisView, p: RulerPoint): RayHit | null {
  const ray = viewRay(view, p[0], p[1])
  return raycast(grid, ray.origin, ray.dir)
}

function rulerToWorld(view: AxisView, h: number, v: number): Vec3 {
  const def = VIEWS[view]
  const w: Vec3 = [0, 0, 0]
  w[def.h!] = h
  w[def.v!] = v
  return w
}

const CARVE_VIEWS = 'front, back, left, right or top'

// Mallet rhythm: a heavier bite takes longer to land.
function blowMs(base: number, size: number): number {
  return Math.round(clamp(base + 30 * size, 250, 600))
}

// ---------- saw ----------

// A straight cut through the whole block, square to the view. The line through `from` and
// `to` is the cut; `discard` says which side of it, in the view's image, comes away. In
// `back` and `right` the horizontal ruler runs right to left, so image-left there is +X / +Z.
export function saw(grid: Grid, pass: SawPass): PassResult {
  if (!isAxisView(pass.view)) return refuse(`The saw cuts from ${CARVE_VIEWS}, not '${pass.view}'.`)
  if (!isPoint(pass.from) || !isPoint(pass.to)) return refuse('The saw needs two ruler points, from and to.')
  const def = VIEWS[pass.view]
  const a = rulerToWorld(pass.view, pass.from[0], pass.from[1])
  const b = rulerToWorld(pass.view, pass.to[0], pass.to[1])
  const t: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const tl = Math.sqrt(t[0] * t[0] + t[1] * t[1] + t[2] * t[2])
  if (!(tl > 1e-6)) return refuse('The saw line has no length: from and to are the same point.')
  // The plane holds the cut line and the view direction.
  const l = def.look
  let n: Vec3 = [(l[1] * t[2] - l[2] * t[1]) / tl, (l[2] * t[0] - l[0] * t[2]) / tl, (l[0] * t[1] - l[1] * t[0]) / tl]
  const side = pass.discard === 'above' || pass.discard === 'below' ? def.up : def.right
  const sign = pass.discard === 'above' || pass.discard === 'right' ? 1 : pass.discard === 'below' || pass.discard === 'left' ? -1 : 0
  if (sign === 0) return refuse(`discard must be above, below, left or right, not '${String(pass.discard)}'.`)
  const facing = (n[0] * side[0] + n[1] * side[1] + n[2] * side[2]) * sign
  if (Math.abs(facing) < 0.02) {
    const upright = pass.discard === 'above' || pass.discard === 'below'
    return refuse(`That cut line runs straight ${upright ? 'up and down' : 'across'}, so it has no '${pass.discard}' side. Use ${upright ? 'left or right' : 'above or below'}.`)
  }
  if (facing < 0) n = [-n[0], -n[1], -n[2]]

  const run = begin(grid)
  const view = pass.view
  const hits = [pass.from, pass.to].map((p): PassHit => {
    const hit = castView(grid, view, p)
    return { ruler: [p[0], p[1]], point: hit ? hit.point : null }
  })
  const strike: SawStrike = {
    kind: 'saw',
    plane: { point: [r3(a[0]), r3(a[1]), r3(a[2])], normal: [r5(n[0]), r5(n[1]), r5(n[2])] },
    ms: 3000
  }
  const before = grid.solidUnits
  const cut = emit(run, strike)
  strike.ms = sawMs(cut)
  run.ms = strike.ms
  const loose = emit(run, { kind: 'detach' })
  const sideWords = { above: 'above', below: 'below', left: 'left of', right: 'right of' }[pass.discard]
  const where = `Sawed from ${showRuler(pass.from)} to ${showRuler(pass.to)} in the ${pass.view} view, discarding everything ${sideWords} the line`
  let summary: string
  if (before === grid.solidUnits) {
    summary = `${where}: the cut met no stone on that side. Nothing came off.`
  } else {
    const share = Math.round(100 * run.removedCm3 / (run.removedCm3 + stoneVolumeCm3(grid)))
    summary = `${where}: ${amount(run.removedCm3)} fell away in ${run.offcuts.length} piece${run.offcuts.length === 1 ? '' : 's'}, ${share}% of the stone that was there.`
    if (loose > 0) summary += ` ${amount(loose)} of that was stone the cut left unattached.`
  }
  return done(run, hits, summary)
}

function sawMs(cm3: number): number {
  return Math.round(clamp(1800 + 12 * Math.sqrt(cm3), 1800, 6000))
}

// ---------- strokes along a path ----------

interface Walk {
  points: RulerPoint[]
  // Unit direction of travel at each point, in ruler coordinates. [0, 0] for a single point.
  tangents: RulerPoint[]
  length: number
  // Samples left out because the path was longer than the cap allows.
  truncated: boolean
}

// Evenly spaced points along a polyline, both ends included.
function walkPath(path: RulerPoint[], step: number, cap: number): Walk {
  const lengths: number[] = []
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const dh = path[i]![0] - path[i - 1]![0]
    const dv = path[i]![1] - path[i - 1]![1]
    const d = Math.sqrt(dh * dh + dv * dv)
    lengths.push(d)
    total += d
  }
  if (!(total > 1e-6)) return { points: [[path[0]![0], path[0]![1]]], tangents: [[0, 0]], length: 0, truncated: false }
  let n = Math.max(1, Math.ceil(total / step))
  const truncated = n + 1 > cap
  if (truncated) n = cap - 1
  const spacing = truncated ? step : total / n
  const points: RulerPoint[] = []
  const tangents: RulerPoint[] = []
  let seg = 0
  let segStart = 0
  for (let i = 0; i <= n; i++) {
    const s = Math.min(total, i * spacing)
    while (seg < lengths.length - 1 && s > segStart + lengths[seg]!) {
      segStart += lengths[seg]!
      seg++
    }
    const p = path[seg]!
    const q = path[seg + 1]!
    const len = lengths[seg]!
    const f = len > 0 ? clamp((s - segStart) / len, 0, 1) : 0
    points.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f])
    tangents.push(len > 0 ? [(q[0] - p[0]) / len, (q[1] - p[1]) / len] : [0, 0])
  }
  return { points, tangents, length: total, truncated }
}

function validPath(path: unknown): path is RulerPoint[] {
  return Array.isArray(path) && path.length > 0 && path.every(isPoint)
}

// The surface normal a sculptor would read at a point: the field's own normal there, evened
// out with its neighbours a little way off in the view, so one pit from earlier roughing does
// not send the tool off sideways.
function strokeNormal(grid: Grid, view: AxisView, p: RulerPoint, hit: RayHit, spread: number): Vec3 {
  let nx = hit.normal[0]
  let ny = hit.normal[1]
  let nz = hit.normal[2]
  for (let k = 0; k < 4; k++) {
    const dh = k === 0 ? spread : k === 1 ? -spread : 0
    const dv = k === 2 ? spread : k === 3 ? -spread : 0
    const near = castView(grid, view, [p[0] + dh, p[1] + dv])
    // A neighbour on some other surface far behind (past an edge) says nothing about this one.
    if (!near || Math.abs(near.distance - hit.distance) > 2.5 * spread) continue
    nx += near.normal[0]
    ny += near.normal[1]
    nz += near.normal[2]
  }
  const look = VIEWS[view].look
  // Facing away from the viewer can only be noise: fall back to striking straight in.
  if (nx * look[0] + ny * look[1] + nz * look[2] > -0.05) return [-look[0], -look[1], -look[2]]
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
  return [nx / len, ny / len, nz / len]
}

// How much of its own width each chisel sinks in one blow, how far apart blows land along a
// stroke (both as fractions of the width) and the base of its rhythm in ms.
const CHISELS = {
  point: { bite: 0.7, step: 0.4, ms: 290 },
  claw: { bite: 0.4, step: 0.5, ms: 250 },
  flat: { bite: 0.3, step: 0.6, ms: 220 },
  roundel: { bite: 1, step: 0.35, ms: 240 }
} as const

// A roundel channel deeper than this many widths is a slot, which is the drill's work.
const ROUNDEL_DEEPEST = 1.5

const MAX_LAYERS = 8
const MAX_PATH_SAMPLES = 160

interface Landing {
  ruler: RulerPoint
  point: Vec3
  normal: Vec3
  across: Vec3 | null
}

function hitSummary(landings: (Landing | null)[], points: RulerPoint[]): string {
  const landed = landings.filter(l => l !== null)
  if (landed.length === 0) return `None of the ${points.length} point${points.length === 1 ? '' : 's'} along the path met the stone (first tried ${showRuler(points[0]!)}): nothing was cut.`
  const first = landed[0]!
  const last = landed[landed.length - 1]!
  let text = landed.length === 1
    ? `It landed at ${show(first.point)}.`
    : `It ran on the stone from ${show(first.point)} to ${show(last.point)}.`
  const missed = points.length - landed.length
  if (missed > 0) {
    const at = points[landings.findIndex(l => l === null)]!
    text += ` ${missed} of ${points.length} points along the path missed the stone (first miss at ${showRuler(at)}).`
  }
  return text
}

// Casts every sample of a stroke at the stone as it stands before the stroke starts.
function land(grid: Grid, view: AxisView, walk: Walk, spread: number): (Landing | null)[] {
  return walk.points.map((ruler, i) => {
    const hit = castView(grid, view, ruler)
    if (!hit) return null
    const normal = strokeNormal(grid, view, ruler, hit, spread)
    // Teeth sit across the direction of travel: travel × normal.
    const t = walk.tangents[i]!
    const travel = rulerToWorld(view, t[0], t[1])
    const ax = travel[1] * normal[2] - travel[2] * normal[1]
    const ay = travel[2] * normal[0] - travel[0] * normal[2]
    const az = travel[0] * normal[1] - travel[1] * normal[0]
    const al = Math.sqrt(ax * ax + ay * ay + az * az)
    const across: Vec3 | null = al > 0.2 ? [r5(ax / al), r5(ay / al), r5(az / al)] : null
    return { ruler, point: hit.point, normal, across }
  })
}

// A stroke along a line on the surface. Bites overlap along the path, each one driven in
// along the surface normal where it lands, in as many layers as it takes to reach depth_cm
// below the surface the stroke started on.
export function chisel(grid: Grid, pass: ChiselPass): PassResult {
  const kind = CHISELS[pass.tool]
  if (!kind) return refuse(`The chisel is point, claw, flat or roundel, not '${String(pass.tool)}'.`)
  if (!isAxisView(pass.view)) return refuse(`Chisel strokes are placed from ${CARVE_VIEWS}, not '${pass.view}'.`)
  if (!validPath(pass.path)) return refuse('The chisel needs a path of at least one ruler point.')
  if (!(pass.depth_cm > 0) || !(pass.width_cm > 0)) return refuse('depth_cm and width_cm must be above zero.')
  if (pass.protect !== undefined && !grid.forms.has(pass.protect)) return refuse(`No form named '${pass.protect}' has been declared, so the stroke cannot be kept out of it.`)
  const view = pass.view
  const round = pass.tool === 'roundel'
  const width = clamp(pass.width_cm, round ? 2 * grid.voxel : grid.voxel, 12)
  const depth = clamp(pass.depth_cm, 0.05, round ? ROUNDEL_DEEPEST * width : 25)
  const layers = Math.min(MAX_LAYERS, Math.max(1, Math.ceil(depth / (kind.bite * width) - 1e-9)))
  const bite = depth / layers
  const walk = walkPath(pass.path, kind.step * width, MAX_PATH_SAMPLES)
  const landings = land(grid, view, walk, Math.max(0.35 * width, grid.voxel))
  const hits: PassHit[] = landings.map((l, i) => ({ ruler: walk.points[i]!, point: l ? l.point : null }))

  const run = begin(grid)
  const seed = passSeed(`chisel:${pass.tool}:${view}`, [depth, width, ...pass.path.flat()])
  const ms = blowMs(kind.ms, width)
  const lift = 0.3 * grid.voxel
  let blows = 0
  // What the blows themselves took; the rest of the pass's total fell away loose.
  let cut = 0
  for (let layer = 0; layer < layers; layer++) {
    const target = bite * (layer + 1)
    for (let i = 0; i < landings.length; i++) {
      const l = landings[i]
      if (!l) continue
      const [nx, ny, nz] = l.normal
      let sunk = 0
      if (!round) {
        // Where the surface is now on this sample's own line: overlapping bites, and the
        // layers before this one, have already taken some of it down.
        const from: Vec3 = [l.point[0] + nx * lift, l.point[1] + ny * lift, l.point[2] + nz * lift]
        const now = raycast(grid, from, [-nx, -ny, -nz], depth + lift + 1)
        if (!now) continue
        sunk = Math.max(0, now.distance - lift)
        if (sunk > target - 0.15 * bite) continue
      }
      // The roundel's ball is what shapes its channel, so every bite is the whole tool sunk
      // from the surface the stroke started on: begun from where its neighbours left off, a
      // bite would square the channel's walls.
      const strike: CutStrike = {
        kind: 'cut',
        tool: pass.tool,
        at: [r3(l.point[0] - nx * sunk), r3(l.point[1] - ny * sunk), r3(l.point[2] - nz * sunk)],
        dir: [r5(-nx), r5(-ny), r5(-nz)],
        size: r3(width),
        depth: r3(target - sunk),
        seed: hashSeed(seed, layer, i),
        ms
      }
      if (pass.tool === 'claw' && l.across) strike.across = l.across
      if (pass.protect !== undefined) strike.protect = pass.protect
      cut += emit(run, strike)
      blows++
      dropLoose(run)
    }
  }
  emit(run, { kind: 'detach' })

  const name = pass.tool === 'point' ? 'Point chisel' : pass.tool === 'claw' ? 'Claw chisel' : pass.tool === 'flat' ? 'Flat chisel' : 'Roundel'
  let summary = `${name} from the ${view} view: ${hitSummary(landings, walk.points)}`
  if (blows > 0) {
    summary += ` ${blows} strike${blows === 1 ? '' : 's'}${layers > 1 ? ` in ${layers} layers` : ''} took ${amount(cut)}, ${r3(depth)} cm deep and ${r3(width)} cm wide.`
    if (run.removedCm3 - cut > 0.5) summary += ` ${amount(run.removedCm3 - cut)} more fell away loose.`
    if (pass.protect !== undefined) {
      summary += cut < 0.5
        ? ` The stone there is already down to '${pass.protect}', which the stroke may not cut into, so almost nothing came off.`
        : ` Nothing inside '${pass.protect}' was cut.`
    }
  }
  if (width !== pass.width_cm) summary += ` (Width was limited to ${r3(width)} cm.)`
  if (round && depth < pass.depth_cm) summary += ` (Depth was limited to ${r3(depth)} cm: a roundel channel is at most ${ROUNDEL_DEEPEST} times as deep as it is wide. Use the drill for a deep hole.)`
  if (walk.truncated) summary += ` The path was too long for one stroke: it stopped after ${r3((walk.points.length - 1) * kind.step * width)} of ${r3(walk.length)} cm.`
  return done(run, hits, summary)
}

// How far one pass of the rasp takes the highest stone under it down, cm. Fresh point-chisel
// roughing stands about a centimetre from pit floor to ridge, so four to six passes bring it
// to an even skin; after that the rasp finds nothing standing proud and all but stops.
const RASP_BITE = 0.12

// Takes the ridges under the path down toward the floors of the pits between them, a little
// each pass, and leaves the rasp's finish. Each pass goes back the way the last one came.
export function rasp(grid: Grid, pass: RaspPass): PassResult {
  if (!isAxisView(pass.view)) return refuse(`The rasp works from ${CARVE_VIEWS}, not '${pass.view}'.`)
  if (!validPath(pass.path)) return refuse('The rasp needs a path of at least one ruler point.')
  if (!(pass.width_cm > 0)) return refuse('width_cm must be above zero.')
  const view = pass.view
  const width = clamp(pass.width_cm, 3 * grid.voxel, 14)
  const passes = Math.round(clamp(Number.isFinite(pass.passes) ? pass.passes : 1, 1, 12))
  const walk = walkPath(pass.path, 0.3 * width, MAX_PATH_SAMPLES)
  const run = begin(grid)
  const seed = passSeed(`rasp:${view}`, [width, passes, ...pass.path.flat()])
  const first: (Vec3 | null)[] = walk.points.map(() => null)
  let strokes = 0
  let landed = 0
  for (let n = 0; n < passes; n++) {
    for (let k = 0; k < walk.points.length; k++) {
      const i = n % 2 === 0 ? k : walk.points.length - 1 - k
      const hit = castView(grid, view, walk.points[i]!)
      if (!hit) continue
      if (n === 0) {
        first[i] = hit.point
        landed++
      }
      const [nx, ny, nz] = hit.normal
      emit(run, {
        kind: 'cut',
        tool: 'rasp',
        at: [r3(hit.point[0]), r3(hit.point[1]), r3(hit.point[2])],
        dir: [r5(-nx), r5(-ny), r5(-nz)],
        size: r3(width),
        // How far one pass takes the ridges down.
        depth: RASP_BITE,
        seed: hashSeed(seed, n, i),
        ms: 160
      })
      strokes++
    }
  }
  emit(run, { kind: 'detach' })
  const hits: PassHit[] = walk.points.map((ruler, i) => ({ ruler, point: first[i] ?? null }))
  const on = hits.filter(h => h.point !== null)
  let summary: string
  if (on.length === 0) {
    summary = `Rasp from the ${view} view: none of the ${hits.length} points along the path met the stone (first tried ${showRuler(walk.points[0]!)}). Nothing was smoothed.`
  } else {
    summary = `Rasp from the ${view} view: ${passes} pass${passes === 1 ? '' : 'es'}, ${strokes} strokes ${r3(width)} cm wide, from ${show(on[0]!.point!)} to ${show(on[on.length - 1]!.point!)}, wore off ${amount(run.removedCm3)} of high spots.`
    if (landed < hits.length) summary += ` ${hits.length - landed} of ${hits.length} points along the path missed the stone.`
  }
  if (walk.truncated) summary += ` The path was too long for one stroke: it stopped after ${r3((walk.points.length - 1) * 0.3 * width)} of ${r3(walk.length)} cm.`
  return done(run, hits, summary)
}

// ---------- drill ----------

const DRILL_MS = 420

// A hole straight along the view direction from the first surface the point meets: one
// diameter deeper with every peck. If the bit comes out into open air on the way (the far
// side of a thin part, a gap already cut), it stops there instead of going on into whatever
// stands behind.
export function drill(grid: Grid, pass: DrillPass): PassResult {
  if (!isAxisView(pass.view)) return refuse(`The drill bores along the view direction from ${CARVE_VIEWS}, not '${pass.view}'.`)
  if (!isPoint(pass.at)) return refuse('The drill needs one ruler point, at.')
  if (!(pass.diameter_cm > 0) || !(pass.depth_cm > 0)) return refuse('diameter_cm and depth_cm must be above zero.')
  const view = pass.view
  const { voxel } = grid
  const size = clamp(pass.diameter_cm, 2 * voxel, 8)
  const asked = clamp(pass.depth_cm, voxel, 40)
  const ruler: RulerPoint = [pass.at[0], pass.at[1]]
  const run = begin(grid)
  const hit = castView(grid, view, ruler)
  if (!hit) return done(run, [{ ruler, point: null }], `Drill from the ${view} view: the point ${showRuler(ruler)} missed the stone. Nothing was cut.`)
  const look = VIEWS[view].look
  const entry = hit.point
  const along = (t: number): Vec3 => [entry[0] + look[0] * t, entry[1] + look[1] * t, entry[2] + look[2] * t]

  let depth = asked
  let through = false
  for (let t = voxel; t <= asked; t += voxel / 2) {
    const p = along(t)
    if (sampleDistance(grid, p[0], p[1], p[2]) > 0) {
      // A little further, so the bit clears the far wall and leaves a clean exit.
      depth = Math.min(asked, t + 0.25 * size)
      through = true
      break
    }
  }
  const pecks = Math.max(1, Math.ceil(depth / size - 1e-9))
  const peck = depth / pecks
  const seed = passSeed(`drill:${view}`, [size, asked, ruler[0], ruler[1]])
  let cut = 0
  for (let k = 0; k < pecks; k++) {
    const at = along(k * peck)
    cut += emit(run, {
      kind: 'cut',
      tool: 'drill',
      at: [r3(at[0]), r3(at[1]), r3(at[2])],
      dir: [look[0], look[1], look[2]],
      size: r3(size),
      depth: r3(peck),
      seed: hashSeed(seed, k),
      ms: DRILL_MS
    })
    dropLoose(run)
  }
  emit(run, { kind: 'detach' })

  // The hole as bored: how far down its own line the stone now starts.
  const lift = 0.3 * voxel
  const floor = raycast(grid, along(-lift), look, depth + lift + 2 * voxel)
  const reached = through || !floor ? depth : clamp(floor.distance - lift, 0, depth + voxel)
  let summary = `Drill from the ${view} view at ${showRuler(ruler)}: the bit went in at ${show(entry)} and bored a hole ${r3(size)} cm across, ${reached.toFixed(1)} cm deep, taking ${amount(cut)}.`
  if (through) summary += ` It came out into open air ${reached.toFixed(1)} cm in and stopped there.`
  else summary += ` The hole ends at ${show(along(reached))}.`
  if (run.removedCm3 - cut > 0.5) summary += ` ${amount(run.removedCm3 - cut)} more fell away loose.`
  if (size !== pass.diameter_cm) summary += ` (Diameter was limited to ${r3(size)} cm.)`
  const result = done(run, [{ ruler, point: entry }], summary)
  result.bore = { entry, depthCm: r3(reached), through }
  return result
}

// ---------- polish ----------

// The share of the way to a full polish one stroke takes the stone under it. Strokes overlap
// about three deep along a path, so one pass closes rather more than half the gap at the
// middle of the band and less toward its edges.
const POLISH_SHARE = 0.25

// The finish of the stone just under each point where the path met it, averaged.
function finishUnder(grid: Grid, landings: (RayHit | null)[]): number {
  const { nx, ny, nz, voxel } = grid
  let sum = 0
  let count = 0
  for (const hit of landings) {
    if (!hit) continue
    const x = Math.round((hit.point[0] - hit.normal[0] * 0.6 * voxel - grid.x0) / voxel)
    const y = Math.round((hit.point[1] - hit.normal[1] * 0.6 * voxel - grid.y0) / voxel)
    const z = Math.round((hit.point[2] - hit.normal[2] * 0.6 * voxel - grid.z0) / voxel)
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue
    sum += grid.finish[x + nx * (y + ny * z)]!
    count++
  }
  return count > 0 ? sum / count : 0
}

// Rubs the surface along the path toward a polish. No stone moves and the shape does not
// change: only the finish of the skin rises, a little with every pass.
export function polish(grid: Grid, pass: PolishPass): PassResult {
  if (!isAxisView(pass.view)) return refuse(`The polish works from ${CARVE_VIEWS}, not '${pass.view}'.`)
  if (!validPath(pass.path)) return refuse('The polish needs a path of at least one ruler point.')
  if (!(pass.width_cm > 0)) return refuse('width_cm must be above zero.')
  const view = pass.view
  const width = clamp(pass.width_cm, 3 * grid.voxel, 14)
  const passes = Math.round(clamp(Number.isFinite(pass.passes) ? pass.passes : 1, 1, 8))
  const walk = walkPath(pass.path, 0.3 * width, MAX_PATH_SAMPLES)
  const run = begin(grid)
  const seed = passSeed(`polish:${view}`, [width, passes, ...pass.path.flat()])
  // The surface does not move, so the path is cast once.
  const landings = walk.points.map(p => castView(grid, view, p))
  const hits: PassHit[] = walk.points.map((ruler, i) => ({ ruler, point: landings[i] ? landings[i]!.point : null }))
  const on = hits.filter(h => h.point !== null)
  const before = finishUnder(grid, landings)
  let strokes = 0
  for (let n = 0; n < passes; n++) {
    for (let k = 0; k < landings.length; k++) {
      const i = n % 2 === 0 ? k : landings.length - 1 - k
      const hit = landings[i]
      if (!hit) continue
      emit(run, {
        kind: 'cut',
        tool: 'polish',
        at: [r3(hit.point[0]), r3(hit.point[1]), r3(hit.point[2])],
        dir: [r5(-hit.normal[0]), r5(-hit.normal[1]), r5(-hit.normal[2])],
        size: r3(width),
        depth: POLISH_SHARE,
        seed: hashSeed(seed, n, i),
        ms: 150
      })
      strokes++
    }
  }
  const after = finishUnder(grid, landings)
  let summary: string
  if (on.length === 0) {
    summary = `Polish from the ${view} view: none of the ${hits.length} points along the path met the stone (first tried ${showRuler(walk.points[0]!)}). Nothing was polished.`
  } else {
    summary = `Polish from the ${view} view: ${passes} pass${passes === 1 ? '' : 'es'}, ${strokes} strokes ${r3(width)} cm wide, from ${show(on[0]!.point!)} to ${show(on[on.length - 1]!.point!)}. The finish under the path went from ${Math.round(before)} to ${Math.round(after)} (0 is raw chisel work, 255 a full polish). No stone was removed and the shape is unchanged.`
    if (on.length < hits.length) summary += ` ${hits.length - on.length} of ${hits.length} points along the path missed the stone.`
  }
  if (walk.truncated) summary += ` The path was too long for one stroke: it stopped after ${r3((walk.points.length - 1) * 0.3 * width)} of ${r3(walk.length)} cm.`
  const result = done(run, hits, summary)
  result.sheen = { before: Math.round(before), after: Math.round(after) }
  return result
}

// ---------- sketch ----------

// Charcoal marks are this far apart along the line, cm.
const SKETCH_STEP = 1
const MAX_SKETCH_SAMPLES = 600

// A charcoal line on the stone, drawn from an axis view: the polyline is laid on the first
// surface it meets, as a row of points for whoever shows the stone to join up. It cuts
// nothing and no tool reads it; its one log entry is there so a replay draws the same line.
export function sketch(grid: Grid, pass: SketchPass): PassResult {
  if (!isAxisView(pass.view)) return refuse(`A sketch is drawn from ${CARVE_VIEWS}, not '${pass.view}'.`)
  if (!validPath(pass.path) || pass.path.length < 2) return refuse('A sketch needs a line of at least two ruler points.')
  const view = pass.view
  const walk = walkPath(pass.path, SKETCH_STEP, MAX_SKETCH_SAMPLES)
  if (!(walk.length > 0)) return refuse('The sketch line has no length: all its points are the same.')
  const spacing = walk.length / Math.max(1, walk.points.length - 1)
  const strokes: Vec3[][] = []
  const hits: PassHit[] = []
  let stroke: Vec3[] = []
  let marks = 0
  const close = (): void => {
    // One mark on its own is a dot nobody could see.
    if (stroke.length > 1) {
      strokes.push(stroke)
      marks += stroke.length - 1
    }
    stroke = []
  }
  for (const ruler of walk.points) {
    const hit = castView(grid, view, ruler)
    hits.push({ ruler, point: hit ? hit.point : null })
    if (!hit) {
      close()
      continue
    }
    const p: Vec3 = [cents(hit.point[0]), cents(hit.point[1]), cents(hit.point[2])]
    const last = stroke[stroke.length - 1]
    // A jump in depth: the line ran off one surface onto another behind it.
    if (last && (p[0] - last[0]) ** 2 + (p[1] - last[1]) ** 2 + (p[2] - last[2]) ** 2 > 16 * spacing * spacing) close()
    stroke.push(p)
  }
  close()
  const first = pass.path[0]!
  const end = pass.path[pass.path.length - 1]!
  if (strokes.length === 0) return refuse(`The line from ${showRuler(first)} to ${showRuler(end)} in the ${view} view does not lie on the stone, so there was nothing to draw on.`)
  const drawn = marks * spacing
  const missed = Math.max(0, walk.length - drawn)
  const run = begin(grid)
  const strike: SketchStrike = {
    kind: 'sketch',
    view,
    points: pass.path.map((p): [number, number] => [r3(p[0]), r3(p[1])]),
    strokes,
    ms: Math.round(clamp(60 * drawn, 600, 5000))
  }
  emit(run, strike)
  const a = strokes[0]![0]!
  const lastStroke = strokes[strokes.length - 1]!
  const b = lastStroke[lastStroke.length - 1]!
  let summary = `Charcoal from the ${view} view: drew ${drawn.toFixed(0)} cm of line on the stone, from ${show(a)} to ${show(b)}.`
  if (missed > 1) summary += ` ${missed.toFixed(0)} cm of the line fell off the stone or across an edge and was not drawn.`
  if (walk.truncated) summary += ` The line was too long: it stopped after ${MAX_SKETCH_SAMPLES - 1} cm.`
  summary += ' It shows in your looks from now on, fainter where the stone under it has since been cut away. No stone was cut.'
  const result = done(run, hits, summary)
  result.line = { drawnCm: cents(drawn), missedCm: cents(missed) }
  return result
}

// ---------- rough-out ----------

type Field = (x: number, y: number, z: number) => number

export interface Proud { maxCm: number, meanCm: number, surfaceVoxels: number }

// How far the stone stands outside a form, measured over the stone's surface (the base it
// stands on left out): for each surface voxel, the form's distance at the surface above it.
export function standingProud(grid: Grid, form: CompiledForm): Proud {
  return scanSurface(grid, form, Infinity, [])
}

// The same, also collecting the index of every surface voxel that stands more than `over`.
function scanSurface(grid: Grid, form: CompiledForm, over: number, high: number[]): Proud {
  const { nx, ny, nz, dist, voxel, x0, y0, z0, qPerCm } = grid
  const nxy = nx * ny
  let max = 0
  let sum = 0
  let count = 0
  for (let z = 1; z < nz - 1; z++) {
    for (let y = 1; y < ny - 1; y++) {
      let i = 1 + nx * (y + ny * z)
      for (let x = 1; x < nx - 1; x++, i++) {
        const d = dist[i]!
        if (d >= 0 || d < -1.5 * Q_PER_VOXEL) continue
        if (dist[i - 1]! < 0 && dist[i + 1]! < 0 && dist[i + nx]! < 0 && dist[i - nxy]! < 0 && dist[i + nxy]! < 0) continue
        const h = formDistance(form, x0 + x * voxel, y0 + y * voxel, z0 + z * voxel) - d / qPerCm
        count++
        if (h > 0) {
          sum += h
          if (h > max) max = h
          if (h > over) high.push(i)
        }
      }
    }
  }
  return { maxCm: max, meanCm: count > 0 ? sum / count : 0, surfaceVoxels: count }
}

// Saw directions: every whole-number direction with components up to 2 that does not point
// downward. The saw never undercuts; the chisels do that.
function sawDirections(): Vec3[] {
  const out: Vec3[] = []
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b)
  for (let y = 2; y >= 0; y--) {
    for (let z = -2; z <= 2; z++) {
      for (let x = -2; x <= 2; x++) {
        if (x === 0 && y === 0 && z === 0) continue
        if (gcd(gcd(Math.abs(x), Math.abs(y)), Math.abs(z)) !== 1) continue
        const len = Math.sqrt(x * x + y * y + z * z)
        out.push([x / len, y / len, z / len])
      }
    }
  }
  return out
}

const SAW_DIRECTIONS = sawDirections()

// Air left between a saw cut and target + margin on top of the sampling slack. Together they
// leave the chisels a skin of stone, a centimetre or so, to work everywhere.
const SAW_CLEARANCE = 0.3
const MAX_SAWS = 24
// A slab is worth the saw from about this share of the block; less is quicker to chisel.
const MIN_SLAB = 0.003

// Largest bite the roughing layers use, cm.
const MAX_BITE = 10

interface Level {
  // Tip level: bites stop at this distance outside target + margin.
  floor: number
  size: number
  // How far above its tip a bite's mouth sits; the ridges it leaves are no higher.
  depth: number
  // A bite lands only where stone stands above this level.
  trigger: number
  strikes: number
}

interface Box { x0: number, y0: number, z0: number, x1: number, y1: number, z1: number }

interface Spots {
  n: number
  // x, y, z, then the unit outward normal: six numbers per spot.
  data: Float64Array
  order: Int32Array
}

function gradient(phi: Field, x: number, y: number, z: number, out: Float64Array): number {
  const e = 0.2
  const gx = phi(x + e, y, z) - phi(x - e, y, z)
  const gy = phi(x, y + e, z) - phi(x, y - e, z)
  const gz = phi(x, y, z + e) - phi(x, y, z - e)
  out[0] = gx / (2 * e)
  out[1] = gy / (2 * e)
  out[2] = gz / (2 * e)
  return Math.sqrt(out[0]! * out[0]! + out[1]! * out[1]! + out[2]! * out[2]!)
}

// Position going round the block seen from above, 0 to 4, starting at the front. Stands in
// for an angle without trigonometry.
function turn(x: number, z: number): number {
  const s = Math.abs(x) + Math.abs(z)
  if (s === 0) return 0
  const p = x / s
  return z >= 0 ? (x >= 0 ? p : 4 + p) : 2 - p
}

// Points spread over the level surface phi = floor inside the box, closer together than
// `radius`, each with its outward normal. They come back in working order: rings from the
// top of the block down, alternate rings going round the other way.
function levelSpots(phi: Field, box: Box, floor: number, radius: number): Spots {
  const h = 0.55 * radius
  const cx = Math.max(1, Math.ceil((box.x1 - box.x0) / h))
  const cy = Math.max(1, Math.ceil((box.y1 - box.y0) / h))
  const cz = Math.max(1, Math.ceil((box.z1 - box.z0) / h))
  const out: number[] = []
  const keys: number[] = []
  const g = new Float64Array(3)
  const ring = 1.7 * radius
  const slack = 0.5 * h
  for (let j = cy - 1; j >= 0; j--) {
    const y0 = box.y0 + (j + 0.5) * h
    for (let k = 0; k < cz; k++) {
      const z0 = box.z0 + (k + 0.5) * h
      for (let i = 0; i < cx; i++) {
        const x0 = box.x0 + (i + 0.5) * h
        let f = phi(x0, y0, z0) - floor
        if (f > 0.9 * h || f < -0.9 * h) continue
        // Slide the cell's centre onto the level along the gradient.
        let x = x0
        let y = y0
        let z = z0
        let ok = true
        for (let step = 0; step < 2; step++) {
          const len = gradient(phi, x, y, z, g)
          if (len < 0.3) {
            ok = false
            break
          }
          const s = f / (len * len)
          x -= g[0]! * s
          y -= g[1]! * s
          z -= g[2]! * s
          f = phi(x, y, z) - floor
        }
        if (!ok || f > 0.15 || f < -0.15) continue
        if ((x - x0) * (x - x0) + (y - y0) * (y - y0) + (z - z0) * (z - z0) > 1.7 * h * h) continue
        if (x < box.x0 - slack || x > box.x1 + slack || y < box.y0 || y > box.y1 + slack || z < box.z0 - slack || z > box.z1 + slack) continue
        const len = gradient(phi, x, y, z, g)
        if (len < 0.3) continue
        out.push(x, y, z, g[0]! / len, g[1]! / len, g[2]! / len)
        const down = (box.y1 - y) / ring
        const row = Math.floor(down)
        const bin = Math.min(47, Math.floor(turn(x, z) * 12))
        keys.push(row * 64 + (row % 2 === 0 ? bin : 47 - bin) + 0.9 * (down - row))
      }
    }
  }
  const n = keys.length
  const order = new Int32Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  order.sort((a, b) => keys[a]! - keys[b]! || a - b)
  return { n, data: new Float64Array(out), order }
}

// Keeps strike points apart: a hash of the points taken so far, asked "is there one within r?"
interface Taken {
  cell: number
  box: Box
  nx: number
  ny: number
  nz: number
  heads: Int32Array
  next: number[]
  points: number[]
}

function takenSet(box: Box, cell: number): Taken {
  const nx = Math.ceil((box.x1 - box.x0) / cell) + 3
  const ny = Math.ceil((box.y1 - box.y0) / cell) + 3
  const nz = Math.ceil((box.z1 - box.z0) / cell) + 3
  return { cell, box, nx, ny, nz, heads: new Int32Array(nx * ny * nz).fill(-1), next: [], points: [] }
}

function cellOf(t: Taken, v: number, lo: number, n: number): number {
  return clamp(Math.floor((v - lo) / t.cell) + 1, 0, n - 1)
}

function take(t: Taken, x: number, y: number, z: number): void {
  const c = cellOf(t, x, t.box.x0, t.nx) + t.nx * (cellOf(t, y, t.box.y0, t.ny) + t.ny * cellOf(t, z, t.box.z0, t.nz))
  t.next.push(t.heads[c]!)
  t.heads[c] = t.points.length / 3
  t.points.push(x, y, z)
}

// r must not exceed the set's cell size.
function isTaken(t: Taken, x: number, y: number, z: number, r: number): boolean {
  const ci = cellOf(t, x, t.box.x0, t.nx)
  const cj = cellOf(t, y, t.box.y0, t.ny)
  const ck = cellOf(t, z, t.box.z0, t.nz)
  const r2 = r * r
  for (let k = Math.max(0, ck - 1); k <= Math.min(t.nz - 1, ck + 1); k++) {
    for (let j = Math.max(0, cj - 1); j <= Math.min(t.ny - 1, cj + 1); j++) {
      for (let i = Math.max(0, ci - 1); i <= Math.min(t.nx - 1, ci + 1); i++) {
        for (let p = t.heads[i + t.nx * (j + t.ny * k)]!; p >= 0; p = t.next[p]!) {
          const dx = t.points[3 * p]! - x
          const dy = t.points[3 * p + 1]! - y
          const dz = t.points[3 * p + 2]! - z
          if (dx * dx + dy * dy + dz * dz < r2) return true
        }
      }
    }
  }
  return false
}

// The highest level (phi) of any stone on the line from a point out along its normal, from
// `reach` above it to `sag` below. Stops looking once it has found stone at `enough`.
function stoneAbove(
  grid: Grid, phi: Field, x: number, y: number, z: number, nx: number, ny: number, nz: number,
  reach: number, sag: number, enough: number
): number {
  const step = grid.voxel
  let best = -1e9
  let inAir = true
  for (let t = reach; t >= -sag; t -= step) {
    const px = x + nx * t
    const py = y + ny * t
    const pz = z + nz * t
    const d = sampleDistance(grid, px, py, pz)
    if (d >= 0) {
      inAir = true
      continue
    }
    // Coming in from air, the surface is a little above this sample: by about its depth.
    const level = phi(px, py, pz) + (inAir ? Math.min(-d, step) : 0)
    inAir = false
    if (level > best) {
      best = level
      if (best >= enough) break
    }
  }
  return best
}

function layerHasStone(grid: Grid, y: number): boolean {
  const { nx, ny, nz, dist } = grid
  for (let z = 0; z < nz; z++) {
    const row = nx * (y + ny * z)
    for (let x = 0; x < nx; x++) {
      if (dist[row + x]! < 0) return true
    }
  }
  return false
}

function mark(core: Uint8Array, stack: number[], f: number): number {
  core[f] = 2
  stack.push(f)
  return 1
}

// The same, over the footprint of a bite: its centre line and six more around it.
const RING = [1, 0, 0.5, 0.8660254037844386, -0.5, 0.8660254037844386, -1, 0, -0.5, -0.8660254037844386, 0.5, -0.8660254037844386]

function stoneUnderBite(
  grid: Grid, phi: Field, spot: Float64Array, o: number, radius: number, reach: number, enough: number
): number {
  const x = spot[o]!
  const y = spot[o + 1]!
  const z = spot[o + 2]!
  const nx = spot[o + 3]!
  const ny = spot[o + 4]!
  const nz = spot[o + 5]!
  const sag = 0.3 * radius
  let best = stoneAbove(grid, phi, x, y, z, nx, ny, nz, reach, sag, enough)
  if (best >= enough) return best
  // Two directions across the normal.
  let ux = ny
  let uy = -nx
  let uz = 0
  if (Math.abs(nz) > 0.9) {
    ux = 0
    uy = nz
    uz = -ny
  }
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz)
  ux /= ul
  uy /= ul
  uz /= ul
  const vx = ny * uz - nz * uy
  const vy = nz * ux - nx * uz
  const vz = nx * uy - ny * ux
  const rr = 0.62 * radius
  for (let k = 0; k < 6; k++) {
    const a = RING[2 * k]! * rr
    const b = RING[2 * k + 1]! * rr
    const level = stoneAbove(grid, phi, x + ux * a + vx * b, y + uy * a + vy * b, z + uz * a + vz * b, nx, ny, nz, reach, sag, enough)
    if (level > best) {
      best = level
      if (best >= enough) break
    }
  }
  return best
}

// Removes the stone outside target + margin, and never any inside it: every chisel strike
// names the target (declared again by a `form` entry at the head of the list, so the list
// replays on its own) and carries the margin, and the kernel clips it by both; the saw is
// only ever placed clear of it. Slabs come off first, largest first; then the waste is worked
// down in layers from the outside in, wide bites far from the target and finer ones for the
// last layer, which leaves a pitted skin just outside the margin.
export function roughOut(grid: Grid, pass: RoughOutPass): PassResult {
  if (pass.tool !== 'point' && pass.tool !== 'claw') return refuse(`Roughing out is done with the point or the claw, not '${String(pass.tool)}'.`)
  let source: Form
  let name: string
  if (typeof pass.to === 'string') {
    const known = grid.forms.get(pass.to)
    if (!known) return refuse(`No form named '${pass.to}' has been declared.`)
    source = known.source
    name = pass.to
  } else {
    // Declared under this name by the `form` entry at the head of the strike list.
    source = pass.to
    name = 'rough_out'
  }
  if (!source || (!source.silhouette && !(source.shapes && source.shapes.length > 0))) return refuse('The form to rough out to has no shapes.')
  const margin = r3(clamp(Number.isFinite(pass.margin_cm) ? pass.margin_cm : 0, 0, 40))
  const budget = clamp(Number.isFinite(pass.max_strikes) ? pass.max_strikes! : 1500, 200, 20000)
  const spec = toolSpec(pass.tool)

  const run = begin(grid)
  const entry: FormStrike = { kind: 'form', name, shapes: source.shapes, blend: source.blend }
  if (source.inflate !== undefined) entry.inflate = source.inflate
  if (source.silhouette) entry.silhouette = source.silhouette
  // Target + margin, exactly as the kernel will build it for each strike.
  const declared = compileForm(entry)
  const form: CompiledForm = { ...declared, inflate: declared.inflate + margin }
  const phi: Field = (x, y, z) => formDistance(form, x, y, z)

  const { voxel, nx, ny } = grid
  const box: Box = { x0: -grid.size[0] / 2, y0: 0, z0: -grid.size[2] / 2, x1: grid.size[0] / 2, y1: grid.size[1], z1: grid.size[2] / 2 }
  const blockCm3 = grid.size[0] * grid.size[1] * grid.size[2]

  // Every other voxel sample inside the block, with the target's distance there.
  const lat = 2 * voxel
  // One sample beyond the block each way, so every bit of stone has a sample within reach.
  const li0 = Math.max(0, Math.ceil((box.x0 - grid.x0) / lat) - 1)
  const li1 = Math.min((nx >> 1) - 1, Math.floor((box.x1 - grid.x0) / lat) + 1)
  const lj0 = Math.max(0, Math.ceil((box.y0 - grid.y0) / lat) - 1)
  const lj1 = Math.min((ny >> 1) - 1, Math.floor((box.y1 - grid.y0) / lat) + 1)
  const lk0 = Math.max(0, Math.ceil((box.z0 - grid.z0) / lat) - 1)
  const lk1 = Math.min((grid.nz >> 1) - 1, Math.floor((box.z1 - grid.z0) / lat) + 1)
  const lx = li1 - li0 + 1
  const ly = lj1 - lj0 + 1
  const lz = lk1 - lk0 + 1
  if (lx < 1 || ly < 1 || lz < 1) return refuse('The block is too small to rough out.')
  const field = new Float32Array(lx * ly * lz)
  // Sample points that may be inside target + margin, or near enough that stone between
  // samples could be: what a saw cut has to stay clear of.
  const guard = 0.87 * lat
  const keep: number[] = []
  const stoneAt = (i: number, j: number, k: number) => grid.dist[2 * (li0 + i) + nx * (2 * (lj0 + j) + ny * 2 * (lk0 + k))]! < 0
  // 1 where a sample is stone inside target + margin: the stone this pass must leave standing.
  const core = new Uint8Array(lx * ly * lz)
  let coreCount = 0
  for (let k = 0, f = 0; k < lz; k++) {
    const z = grid.z0 + (lk0 + k) * lat
    for (let j = 0; j < ly; j++) {
      const y = grid.y0 + (lj0 + j) * lat
      for (let i = 0; i < lx; i++, f++) {
        const x = grid.x0 + (li0 + i) * lat
        const d = phi(x, y, z)
        field[f] = d
        if (d < 0 && stoneAt(i, j, k)) {
          core[f] = 1
          coreCount++
        }
        // The furthest point of a set along any direction is on its skin, or on the edge
        // of the samples.
        const edge = i === 0 || j === 0 || k === 0 || i === lx - 1 || j === ly - 1 || k === lz - 1
        if (d < guard && (d > -2 * lat || edge)) keep.push(x, y, z)
      }
    }
  }
  const what = typeof pass.to === 'string' ? `'${pass.to}'` : 'the form'
  if (coreCount === 0) return refuse(`There is no stone inside ${what}, so roughing out to it would leave nothing. Check the form's position.`)

  // The island check keeps what is joined to the lowest stone. Everything this pass protects
  // has to be joined to that through protected stone, or it would be cut loose and fall as
  // soon as the waste around it had gone. Flood the protected samples from the bottom.
  let low = 0
  while (low < grid.ny - 1 && !layerHasStone(grid, low)) low++
  const yLow = grid.y0 + low * voxel
  const stack: number[] = []
  const lxy = lx * ly
  for (let k = 0; k < lz; k++) {
    for (let j = 0; j < ly; j++) {
      const y = grid.y0 + (lj0 + j) * lat
      if (y > yLow + 1.5 * lat) break
      for (let i = 0; i < lx; i++) {
        const f = i + lx * (j + ly * k)
        if (core[f] === 1 && phi(grid.x0 + (li0 + i) * lat, yLow, grid.z0 + (lk0 + k) * lat) < 0) {
          core[f] = 2
          stack.push(f)
        }
      }
    }
  }
  const standing = stack.length > 0
  let joined = stack.length
  while (stack.length > 0) {
    const f = stack.pop()!
    const i = f % lx
    const j = ((f - i) / lx) % ly
    const k = (f - i - lx * j) / lxy
    if (i > 0 && core[f - 1] === 1) joined += mark(core, stack, f - 1)
    if (i < lx - 1 && core[f + 1] === 1) joined += mark(core, stack, f + 1)
    if (j > 0 && core[f - lx] === 1) joined += mark(core, stack, f - lx)
    if (j < ly - 1 && core[f + lx] === 1) joined += mark(core, stack, f + lx)
    if (k > 0 && core[f - lxy] === 1) joined += mark(core, stack, f - lxy)
    if (k < lz - 1 && core[f + lxy] === 1) joined += mark(core, stack, f + lxy)
  }
  if (joined < coreCount) {
    // The lowest sample that was not reached.
    let f = core.indexOf(1)
    for (let g = f; g >= 0; g = core.indexOf(1, g + 1)) {
      if (((g - g % lx) / lx) % ly < ((f - f % lx) / lx) % ly) f = g
    }
    const i = f % lx
    const j = ((f - i) / lx) % ly
    const k = (f - i - lx * j) / lxy
    const at: Vec3 = [grid.x0 + (li0 + i) * lat, grid.y0 + (lj0 + j) * lat, grid.z0 + (lk0 + k) * lat]
    return refuse(standing
      ? `Part of ${what} (around ${show(at)}) is not joined to the part that stands on the base, so it would fall away once the stone between them was removed. Join the shapes up, or add what holds that part, and rough out again.`
      : `${typeof pass.to === 'string' ? what : 'The form'} does not reach the bottom of the stone (it starts about ${Math.max(0, at[1] - yLow).toFixed(0)} cm up), so it would be left with nothing to stand on. Add what it stands on to the form (a base, a plinth, the body under a head) and rough out again.`)
  }
  emit(run, entry)

  const seed = passSeed(`rough:${pass.tool}`, [margin, budget, grid.solidUnits % 1000003])
  const rng = createRng(seed)

  // --- slabs ---
  const offsets = new Float64Array(SAW_DIRECTIONS.length)
  for (let d = 0; d < SAW_DIRECTIONS.length; d++) {
    const [dx, dy, dz] = SAW_DIRECTIONS[d]!
    let far = -1e9
    for (let p = 0; p < keep.length; p += 3) {
      const s = keep[p]! * dx + keep[p + 1]! * dy + keep[p + 2]! * dz
      if (s > far) far = s
    }
    // Protected stone can sit up to `guard` from the nearest sample that was kept.
    offsets[d] = far + guard + SAW_CLEARANCE
  }
  // Waste is counted on every fourth voxel sample: plenty to rank slabs by.
  let waste: number[] = []
  for (let k = 0; k < lz; k += 2) {
    for (let j = 0; j < ly; j += 2) {
      for (let i = 0; i < lx; i += 2) {
        if (stoneAt(i, j, k)) waste.push(grid.x0 + (li0 + i) * lat, grid.y0 + (lj0 + j) * lat, grid.z0 + (lk0 + k) * lat)
      }
    }
  }
  const wasteCell = 8 * lat * lat * lat
  const minSlab = Math.max(MIN_SLAB * blockCm3, 40 * wasteCell)
  let saws = 0
  let slabCm3 = 0
  // Loose stone the island checks dropped, while sawing and then while chiselling.
  let slabLoose = 0
  let looseCm3 = 0
  while (saws < MAX_SAWS) {
    let best = -1
    let bestCount = 0
    for (let d = 0; d < SAW_DIRECTIONS.length; d++) {
      const [dx, dy, dz] = SAW_DIRECTIONS[d]!
      const o = offsets[d]!
      let count = 0
      for (let p = 0; p < waste.length; p += 3) {
        if (waste[p]! * dx + waste[p + 1]! * dy + waste[p + 2]! * dz > o) count++
      }
      if (count > bestCount) {
        bestCount = count
        best = d
      }
    }
    if (best < 0 || bestCount * wasteCell < minSlab) break
    const [dx, dy, dz] = SAW_DIRECTIONS[best]!
    const o = offsets[best]!
    // A point of the plane near the middle of the block.
    const mid = o - (box.y1 / 2) * dy
    const strike: Strike = {
      kind: 'saw',
      plane: { point: [r3(dx * mid), r3(box.y1 / 2 + dy * mid), r3(dz * mid)], normal: [r5(dx), r5(dy), r5(dz)] },
      ms: sawMs(bestCount * wasteCell)
    }
    slabCm3 += emit(run, strike)
    // A slab can take the support from under stone the cut itself did not reach.
    slabLoose += emit(run, { kind: 'detach' })
    saws++
    const left: number[] = []
    for (let p = 0; p < waste.length; p += 3) {
      if (waste[p]! * dx + waste[p + 1]! * dy + waste[p + 2]! * dz <= o) left.push(waste[p]!, waste[p + 1]!, waste[p + 2]!)
    }
    waste = left
  }

  // --- layers ---
  // How far the highest waste stands above the margin now.
  let top = 0
  for (let k = 0, f = 0; k < lz; k++) {
    for (let j = 0; j < ly; j++) {
      for (let i = 0; i < lx; i++, f++) {
        if (field[f]! > top && stoneAt(i, j, k)) top = field[f]!
      }
    }
  }

  const shank = spec.shank
  // The last layer. Its bites are about as wide as the margin is deep, shallow, and stop a
  // little short of the margin, so tool noise roughens the skin without being clipped flat.
  const lastDepth = pass.tool === 'point' ? clamp(0.3 * margin, 0.6, 1.1) : clamp(0.25 * margin, 0.5, 1)
  const lastFloor = (size: number) => 0.05 + (0.25 * spec.noise + 0.9 * spec.teeth) * size
  let lastSize = clamp(1.3 * margin, 8 * voxel, 6)
  const spacing = 0.46
  const lastTrigger = 0.3

  const sweep = (level: Level, repair: boolean, dry: boolean, taken: Taken, spots: Spots): number => {
    const { floor, size, depth } = level
    const radius = size / 2
    const reach = depth + shank * size
    const apart = (repair ? 0.5 : 1) * spacing * size
    const trigger = repair && level.trigger < floor + depth ? floor + depth + 0.3 : level.trigger
    const enough = Math.max(trigger, floor + depth) + 0.01
    const ms = blowMs(spec.id === 'point' ? 250 : 220, size)
    let count = 0
    for (let s = 0; s < spots.n; s++) {
      const o = spots.order[s]! * 6
      const d = spots.data
      const x = d[o]!
      const y = d[o + 1]!
      const z = d[o + 2]!
      if (isTaken(taken, x, y, z, apart)) continue
      const stands = stoneUnderBite(grid, phi, d, o, repair ? 0.5 * radius : radius, reach, enough)
      if (stands <= trigger) continue
      take(taken, x, y, z)
      count++
      if (dry) continue
      // The mouth of the bite sits at the stone's surface where the stone is thin, and
      // `depth` above the tip where it is thick: the shank clears what stands above that.
      const a = clamp(stands - floor, 0.25 * depth, depth)
      const nxn = d[o + 3]!
      const nyn = d[o + 4]!
      const nzn = d[o + 5]!
      // Tips land a little unevenly.
      const lift = rng.range(0, 0.1 * depth)
      emit(run, {
        kind: 'cut',
        tool: pass.tool,
        at: [r3(x + nxn * (a + lift)), r3(y + nyn * (a + lift)), r3(z + nzn * (a + lift))],
        dir: [r5(-nxn), r5(-nyn), r5(-nzn)],
        size: r3(size),
        depth: r3(a),
        seed: hashSeed(seed, run.strikes.length),
        protect: name,
        margin,
        ms
      })
      looseCm3 += dropLoose(run)
    }
    return count
  }

  const lastLevel = (): Level => ({ floor: lastFloor(lastSize), size: lastSize, depth: lastDepth, trigger: lastFloor(lastSize) + lastTrigger, strikes: 0 })
  // Widens the last layer's bites until a dry run over the stone as it stands fits `limit`.
  const fitLast = (limit: number): void => {
    for (let attempt = 0; attempt < 2 && lastSize < MAX_BITE; attempt++) {
      const level = lastLevel()
      const would = sweep(level, false, true, takenSet(box, spacing * lastSize), levelSpots(phi, box, level.floor, spacing * lastSize))
      if (would <= limit) break
      lastSize = Math.min(MAX_BITE, lastSize * Math.sqrt(would / limit) * 1.03)
    }
  }
  if (top > lastFloor(lastSize) + lastTrigger) fitLast(0.7 * budget)

  // Build the ladder from the last layer outward: each layer above reaches as far up as it
  // can while leaving nothing the layer below cannot clear.
  const levels: Level[] = [lastLevel()]
  for (let i = 0; i < 40; i++) {
    const below = levels[levels.length - 1]!
    const cleared = below.floor + 0.85 * (below.depth + shank * below.size)
    if (cleared >= top) break
    const size = Math.min(MAX_BITE, Math.max(below.size * 1.5, 6))
    const depth = 0.3 * size
    levels.push({ floor: Math.max(below.floor + 0.5, cleared - depth), size, depth, trigger: cleared, strikes: 0 })
  }

  const before = run.removedCm3
  let chiselStrikes = 0
  for (let l = levels.length - 1; l >= 0; l--) {
    if (l === 0 && chiselStrikes > 0.3 * budget) {
      // The layers above took more than their share: the last one makes do with wider
      // bites. Wider only ever reaches further up, so the ladder above still holds.
      fitLast(Math.max(0.45 * budget, 0.95 * (budget - chiselStrikes)))
      levels[0] = lastLevel()
    }
    const level = levels[l]!
    if (top <= level.trigger) continue
    const spots = levelSpots(phi, box, level.floor, spacing * level.size)
    const taken = takenSet(box, spacing * level.size)
    level.strikes = sweep(level, false, false, taken, spots)
    level.strikes += sweep(level, true, false, taken, spots)
    chiselStrikes += level.strikes
    if (level.strikes > 0 && l > 0) looseCm3 += emit(run, { kind: 'detach' })
  }
  looseCm3 += emit(run, { kind: 'detach' })

  // Tidying up. Crumbs the layers left standing well above the last layer's ridges (stone
  // between bites, chips resting on the base) each get a blow of their own.
  const last = levels[0]!
  const ridge = last.floor + 1.2 * last.depth + spec.noise * last.size + 0.3
  const g = new Float64Array(3)
  let tidied = 0
  let proud: Proud = { maxCm: 0, meanCm: 0, surfaceVoxels: 0 }
  for (let round = 0; round < 4; round++) {
    const high: number[] = []
    proud = scanSurface(grid, form, ridge, high)
    if (high.length === 0 || round === 3 || tidied >= 0.1 * budget) break
    const ms = blowMs(spec.id === 'point' ? 250 : 220, last.size)
    let blows = 0
    for (let h = 0; h < high.length && tidied < 0.1 * budget; h++) {
      const i = high[h]!
      if (grid.dist[i]! >= 0) continue
      const vx = i % nx
      const rest = (i - vx) / nx
      const vy = rest % ny
      const x = grid.x0 + vx * voxel
      const y = grid.y0 + vy * voxel
      const z = grid.z0 + (rest - vy) / ny * voxel
      const len = gradient(phi, x, y, z, g)
      if (len < 0.3) continue
      const nxn = g[0]! / len
      const nyn = g[1]! / len
      const nzn = g[2]! / len
      // From just above the crumb down to the last layer's level, or a bite's worth of it.
      const depth = clamp(phi(x, y, z) - last.floor, 0.5 * last.depth, 0.6 * MAX_BITE)
      emit(run, {
        kind: 'cut',
        tool: pass.tool,
        at: [r3(x + nxn * voxel), r3(y + nyn * voxel), r3(z + nzn * voxel)],
        dir: [r5(-nxn), r5(-nyn), r5(-nzn)],
        size: r3(last.size),
        depth: r3(depth + voxel),
        seed: hashSeed(seed, run.strikes.length),
        protect: name,
        margin,
        ms
      })
      blows++
      tidied++
      looseCm3 += dropLoose(run)
    }
    if (blows === 0) break
    looseCm3 += emit(run, { kind: 'detach' })
  }
  chiselStrikes += tidied
  const chiselCm3 = run.removedCm3 - before - looseCm3
  looseCm3 += slabLoose
  const stats: RoughOutStats = {
    protect: name,
    marginCm: margin,
    saws,
    slabCm3,
    chiselStrikes,
    chiselCm3,
    looseCm3,
    levels: levels.filter(l => l.strikes > 0).reverse().map(l => ({ floorCm: r3(l.floor), sizeCm: r3(l.size), strikes: l.strikes })),
    tidyStrikes: tidied,
    proudMaxCm: r3(proud.maxCm),
    proudMeanCm: r3(proud.meanCm)
  }
  let summary = `Roughed out to ${what} with the ${pass.tool} chisel, leaving ${r3(margin)} cm:`
  if (saws + chiselStrikes === 0) {
    summary += ' there was nothing left outside the margin to remove.'
  } else {
    if (saws > 0) summary += ` ${saws} saw cut${saws === 1 ? '' : 's'} took ${amount(slabCm3)} off in slabs,`
    summary += ` ${chiselStrikes} chisel strikes took ${amount(chiselCm3)}`
    summary += looseCm3 > 0.5 ? ` and ${amount(looseCm3)} fell away loose.` : '.'
    summary += ` Outside the margin the stone now stands ${proud.meanCm.toFixed(1)} cm proud on average and ${proud.maxCm.toFixed(1)} cm at most.`
  }
  const result = done(run, [], summary)
  result.stats = stats
  return result
}
