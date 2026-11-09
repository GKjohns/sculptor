/**
 * What comes off the stone, at three scales. All of it is for show: nothing here reads or writes
 * a grid, and a restored session gets a pile that is only roughly the one it would have had.
 *
 * Offcuts. A saw cut or an island check hands over real meshes of the stone that came away.
 * Each becomes a rigid body in Rapier with a convex collider wrapped round it, shoved off the
 * block, and left to fall onto the banker and the floor. A big one breaks once, where it first
 * lands hard: its mesh is cleaved along a plane or two and the parts go their own ways. A piece
 * that has stopped is frozen where it lies and stays a thing later pieces can land on. Past a
 * budget of pieces and triangles the oldest are cleared away.
 *
 * Chips. Instanced shards thrown from each chisel blow along the reflected strike direction and
 * sized by the bite. Up to CHIP_LIVE fly at once, on ballistic paths with a bounce off the floor,
 * the banker and the stone's own boxes. One in a dozen or so stays where it lands, and those are
 * the pile: static instances that build up through the commission (a whole one leaves about as
 * many as the pile holds). The others lie a second or two and are gone, as if lost among the
 * rest. When blows come faster than chips can be thrown (a fast replay), the pile's share is
 * put straight where it would have come to rest.
 *
 * Dust is ./dust.ts; this file decides when it puffs.
 *
 * The stone, for anything that has to bounce off it, is a box per chunk fitted to that chunk's
 * mesh as it arrives from the worker: coarse, never stale, and nearly free.
 *
 * Time comes in through update(dt) only. The timeline's speed never speeds the physics up (a slab
 * falling at 60× would be a blink): it thins the chips out instead, by way of budgets that
 * refill in screen time. Slow motion is the caller handing in a smaller dt.
 */
import * as THREE from 'three/webgpu'
import { createRng } from '#shared/sculpt/rng'
import type { Rng } from '#shared/sculpt/rng'
import { nominalBiteCm3, TOOLS } from '#shared/sculpt/tools'
import type { ChunkMesh, GridInfo, Offcut, Strike } from '#shared/sculpt/types'
import type { Dust } from './dust'
import type { StudioRenderer } from './renderer'
import { boundsOf, cleave, extremes, thin, volumeOf } from './rubble'
import type { Bounds, Shell } from './rubble'
import type { Stone } from './stone'
import type { StrikeEvent } from './timeline'

type Rapier = typeof import('@dimforge/rapier3d-compat')
type World = InstanceType<Rapier['World']>
type RigidBody = InstanceType<Rapier['RigidBody']>
type Collider = InstanceType<Rapier['Collider']>

/** Something debris lands on: an axis-aligned box, centre and half extents, cm. */
export interface Solid {
  center: [number, number, number]
  half: [number, number, number]
}

export interface DebrisOptions {
  /** The floor is the plane y = floorY. */
  floorY?: number
  /** The banker, as boxes. */
  solids?: Solid[]
  offcutMaterial?: THREE.Material
  chipMaterial?: THREE.Material
  /** The vertex attribute the offcut material reads a piece's place in the block from, if it wants one. */
  coords?: string
  dust?: Dust | null
}

/** A piece big enough for the room to notice has come away. */
export interface FallEvent {
  cm3: number
  /** Where it hangs, and the way it is about to go (level, unit length). */
  at: THREE.Vector3
  out: THREE.Vector3
}

export interface ImpactEvent {
  cm3: number
  at: THREE.Vector3
  /** How hard, cm/s of velocity lost in the hit. */
  speed: number
  broke: boolean
}

// ---- budgets (reported by stats()) ----
/** Chip instances in all, the most in the air at once, and the most lying about on their way out. */
export const CHIP_MAX = 6000
export const CHIP_LIVE = 400
export const CHIP_FADING = 900
/** The share of thrown chips that stay in the pile. */
const KEEP = 0.075
/** How long one that does not stay lies there, s, and how long it takes to go. */
const LINGER_S: [number, number] = [1.2, 3.2]
const FADE_S = 0.4
/** A chip still in the air after this long is given up on, s. */
const STRAY_S = 7
/** Chips launched and chips put straight down, per second of screen time. */
const LAUNCH_PER_S = 260
const REST_PER_S = 60
const PUFFS_PER_S = 28
/** Rigid bodies still moving, pieces on the floor in all, and their triangles. */
export const MAX_MOVING = 24
export const MAX_PIECES = 56
export const MAX_TRIS = 450_000
/** A piece that will not come off the sculpture is shrunk away over this long, s, after this many pushes. */
const VANISH_S = 0.6
const NUDGES = 2
/** A restored pile is at most this many chips. */
const RESTORED_CHIPS = 4600

// ---- the physics ----
const GRAVITY = 981
const KG_PER_CM3 = 0.00271
/** Below this an offcut is a chip. Above BREAK it breaks on landing; above FALL the room is told. */
const CRUMB_CM3 = 40
const BREAK_CM3 = 2500
const FALL_CM3 = 1500
/** Velocity lost in one step that counts as a hit, and as a hit hard enough to break on, cm/s. */
const HIT = 60
const BREAK_HIT = 130
/** Physics steps are no longer than this, s; a frame takes as many as it needs, up to MAX_STEPS. */
const STEP = 1 / 90
const MAX_STEPS = 4
/** Slices of mesh thinning run per frame (see rubble.ts). */
const THIN_SLICES = 3
const THIN_OVER_TRIS = 3000
const G_STATIC = 1
const G_STONE = 2
const G_PIECE = 4
const groups = (member: number, filter: number) => (member << 16) | filter

// ---- the pile ----
const PILE_CELL = 4
const PILE_HALF = 200
const PILE_N = (PILE_HALF * 2) / PILE_CELL
const PILE_MAX_CM = 3.5

interface Piece {
  mesh: THREE.Mesh
  body: RigidBody
  cm3: number
  /** Where the piece's own origin was in the block, for the material's veins. */
  origin: [number, number, number]
  /** The mesh as it is drawn, and thinned (the same object for a small piece). */
  shell: Shell
  low: Shell | null
  tris: number
  age: number
  quiet: number
  /** Seconds left of not touching the stone it was cut from. */
  grace: number
  breakable: boolean
  wantsBreak: boolean
  big: boolean
  fixed: boolean
  vx: number
  vy: number
  vz: number
  sinceHit: number
  /** Times it has come to rest on the stone and been pushed off again. */
  nudges: number
}

// How many chips a bite of this much stone throws.
const chipsFor = (cm3: number) => Math.max(2, Math.min(14, Math.round(1.5 + Math.pow(cm3, 0.55) * 1.6)))

function shardGeometry(): THREE.BufferGeometry {
  // A flake of stone: an icosahedron knocked out of true and flattened. One unit across.
  const g = new THREE.IcosahedronGeometry(0.5, 0)
  const p = g.getAttribute('position') as THREE.BufferAttribute
  const rng = createRng(31)
  const moved = new Map<string, [number, number, number]>()
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`
    let to = moved.get(key)
    if (!to) {
      const k = rng.range(0.62, 1.25)
      to = [p.getX(i) * k * 1.15, p.getY(i) * k * 0.5, p.getZ(i) * k * 0.85]
      moved.set(key, to)
    }
    p.setXYZ(i, to[0], to[1], to[2])
  }
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

export class Debris {
  /** A piece of FALL_CM3 or more has come away. */
  onFall: (event: FallEvent) => void = () => {}
  /** A piece has hit something. */
  onImpact: (event: ImpactEvent) => void = () => {}

  readonly dust: Dust | null

  private R: Rapier | null = null
  private world: World | null = null
  private failed = false
  private floorY: number
  private solids: Solid[]
  private offcutMaterial: THREE.Material
  private chipMaterial: THREE.Material
  private ownMaterials: THREE.Material[] = []
  private coords: string | undefined
  private rng: Rng = createRng(4401)

  // Offcuts.
  private loose: { rev: number, offcut: Offcut }[] = []
  private pieces: Piece[] = []
  private jobs: { piece: Piece, work: Generator<void, Shell> }[] = []
  private saws: { point: [number, number, number], normal: [number, number, number] }[] = []
  private moving = 0
  private tris = 0
  private stepMs = 0
  // Pieces that came to rest on the sculpture and would not slide off, shrinking out of sight.
  private vanishing: { mesh: THREE.Mesh, left: number, scale: number }[] = []

  // The stone as boxes: min xyz and max xyz per chunk, and the colliders made from them.
  private grid: GridInfo
  private boxes = new Float32Array(0)
  private has = new Uint8Array(0)
  private stoneColliders: (Collider | null)[] = []
  private stoneDirty = new Set<number>()

  // Chips.
  private chips: THREE.InstancedMesh
  private used = 0
  private head = 0
  private live = new Int32Array(CHIP_LIVE)
  private liveCount = 0
  private fading = new Int32Array(CHIP_FADING)
  private fadingCount = 0
  private free = new Int32Array(CHIP_MAX)
  private freeCount = 0
  // 1 in the air, 2 lying there on its way out, 0 at rest in the pile (or never used).
  private flying = new Uint8Array(CHIP_MAX)
  private stays = new Uint8Array(CHIP_MAX)
  private cp = new Float32Array(CHIP_MAX * 3)
  private cv = new Float32Array(CHIP_MAX * 3)
  private cq = new Float32Array(CHIP_MAX * 4)
  private cw = new Float32Array(CHIP_MAX * 3)
  private cs = new Float32Array(CHIP_MAX * 3)
  private cage = new Float32Array(CHIP_MAX)
  private pile = new Float32Array(PILE_N * PILE_N)
  private launchTokens = 40
  private restTokens = 20
  private puffTokens = 6
  private chipsDirty = false

  private speck: THREE.Mesh | null = null
  private m = new THREE.Matrix4()
  private v = new THREE.Vector3()
  private q = new THREE.Quaternion()
  private s = new THREE.Vector3()
  private e = new THREE.Euler()
  private tint = new THREE.Color()
  private box = new THREE.Box3()

  constructor(private studio: StudioRenderer, private stone: Stone, options: DebrisOptions = {}) {
    this.floorY = options.floorY ?? -84
    this.solids = options.solids ?? [{ center: [0, -3.5, 0], half: [47, 3.5, 47] }]
    this.coords = options.coords
    this.dust = options.dust ?? null
    if (options.offcutMaterial) {
      this.offcutMaterial = options.offcutMaterial
    } else {
      this.offcutMaterial = new THREE.MeshPhysicalNodeMaterial({ color: 0xe9e4da, roughness: 0.7 })
      this.ownMaterials.push(this.offcutMaterial)
    }
    if (options.chipMaterial) {
      this.chipMaterial = options.chipMaterial
    } else {
      this.chipMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xece7de, roughness: 0.92 })
      this.ownMaterials.push(this.chipMaterial)
    }
    this.grid = stone.grid
    this.fitGrid(stone.grid)

    this.chips = new THREE.InstancedMesh(shardGeometry(), this.chipMaterial, CHIP_MAX)
    this.chips.name = 'chips'
    this.chips.count = 0
    this.chips.frustumCulled = false
    this.chips.castShadow = true
    this.chips.receiveShadow = true
    this.chips.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // Allocated up front, so the first chip does not rebuild the pipeline.
    this.chips.setColorAt(0, this.tint.setScalar(1))
    studio.stage.add(this.chips)
    this.warm()

    void this.start()
  }

  // The first offcut and the first chip would each stall a frame while their pipelines are built
  // (the marble material is a long shader, and there is a shadow pass as well). So one of each is
  // drawn from the start, where nobody can see it: a speck of offcut under the floor, and one
  // chip of no size, which the first real chip takes over.
  private warm() {
    const shell: Shell = { positions: new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0, 0.01]), normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) }
    const speck = new THREE.Mesh(this.geometryOf(shell, [0, 0, 0], { min: [0, 0, 0], max: [0.01, 0, 0.01] }), this.offcutMaterial)
    speck.name = 'offcut-warm'
    speck.position.set(0, this.floorY - 2, 0)
    speck.castShadow = true
    speck.receiveShadow = true
    speck.frustumCulled = false
    this.studio.stage.add(speck)
    this.speck = speck
    this.chips.setMatrixAt(0, this.m.makeScale(0, 0, 0))
    this.chips.count = 1
  }

  /** Big pieces still on their way down. */
  get falling() {
    let n = 0
    for (const piece of this.pieces) if (piece.big && !piece.fixed) n++
    return n
  }

  /** Anything at all still moving: pieces, chips, offcuts waiting for their cut to show. */
  get airborne() {
    return this.moving + this.liveCount + this.loose.length
  }

  /** Where the newest big piece still moving is, or null. */
  watch(out: THREE.Vector3): THREE.Vector3 | null {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const piece = this.pieces[i]!
      if (piece.big && !piece.fixed) return out.copy(piece.mesh.position)
    }
    return null
  }

  stats() {
    return {
      physics: this.failed ? 'failed' : this.world ? 'rapier' : 'starting',
      chips: this.used - this.freeCount,
      chipsLive: this.liveCount,
      chipsFading: this.fadingCount,
      pieces: this.pieces.length,
      moving: this.moving,
      falling: this.falling,
      tris: this.tris,
      thinning: this.jobs.length,
      stoneBoxes: this.stoneColliders.reduce((n, c) => n + (c ? 1 : 0), 0),
      stepMs: Math.round(this.stepMs * 100) / 100,
      dust: this.dust?.stats() ?? null,
      caps: { chips: CHIP_MAX, chipsLive: CHIP_LIVE, chipsFading: CHIP_FADING, moving: MAX_MOVING, pieces: MAX_PIECES, tris: MAX_TRIS }
    }
  }

  // ---------- what the stone tells it ----------

  /** A remesh from the worker: refits the box of every chunk in it. A whole block at rev 0 is a fresh block. */
  chunks(rev: number, chunks: ChunkMesh[]) {
    if (rev === 0 && chunks.length > 0) this.reset()
    for (const chunk of chunks) {
      const id = chunk.chunk
      if (id >= this.has.length) continue
      const p = chunk.positions
      if (chunk.indices.length === 0 || p.length === 0) {
        this.has[id] = 0
      } else {
        const b = boundsOf(p)
        this.boxes.set(b.min, id * 6)
        this.boxes.set(b.max, id * 6 + 3)
        this.has[id] = 1
      }
      this.stoneDirty.add(id)
    }
  }

  /** Pieces that came off. They appear with the chunks that show the cut (the stone's rev reaching `rev`). */
  shed(rev: number, offcuts: Offcut[]) {
    for (const offcut of offcuts) this.loose.push({ rev, offcut })
  }

  /** Cuts and saw cuts as they land: chips and dust for the cuts, and the saw's plane kept for the slab that follows. */
  strikes(events: StrikeEvent[]) {
    for (const event of events) {
      if (event.kind === 'saw') {
        this.saws.push({ point: event.at, normal: event.dir })
        if (this.saws.length > 4) this.saws.shift()
        continue
      }
      if (event.tool === 'polish') continue
      this.dust?.raise(event.removedCm3)
      const [ax, ay, az] = event.at
      const [dx, dy, dz] = event.dir
      // The face the tool met, as near as can be told without asking: it faces back along the
      // blow, leaning away from the block's axis and a little up.
      const away = Math.hypot(ax, az) || 1
      let nx = -dx + ax / away * 0.35
      let ny = -dy + 0.25
      let nz = -dz + az / away * 0.35
      const nl = Math.hypot(nx, ny, nz) || 1
      nx /= nl
      ny /= nl
      nz /= nl
      if (event.tool === 'rasp') {
        if (this.puffTokens >= 1) {
          this.puffTokens--
          this.dust?.puff(ax + nx * 0.5, ay + ny * 0.5, az + nz * 0.5, nx * 0.4, ny * 0.4 - 0.3, nz * 0.4, 0.3, 16)
        }
        continue
      }
      // Along the blow, bounced off that face.
      const into = dx * nx + dy * ny + dz * nz
      const rx = dx - 2 * into * nx
      const ry = dy - 2 * into * ny
      const rz = dz - 2 * into * nz
      const want = chipsFor(event.removedCm3)
      const force = Math.max(0.6, Math.min(1.6, 0.6 + event.depth * 0.25))
      const rng = this.rng
      for (let i = 0; i < want; i++) {
        const size = Math.max(0.35, Math.min(3.2, event.size * (0.06 + rng.next() ** 2 * 0.22)))
        if (this.launchTokens >= 1 && this.liveCount < CHIP_LIVE) {
          this.launchTokens--
          let vx = rx * 0.6 + nx * 0.4 + rng.range(-0.55, 0.55)
          let vy = ry * 0.6 + ny * 0.4 + rng.range(-0.35, 0.65)
          let vz = rz * 0.6 + nz * 0.4 + rng.range(-0.55, 0.55)
          const vl = Math.hypot(vx, vy, vz) || 1
          const speed = rng.range(70, 230) * force
          vx *= speed / vl
          vy *= speed / vl
          vz *= speed / vl
          const off = rng.range(0.4, 1.2)
          const jitter = event.size * 0.3
          this.launch(ax + nx * off + rng.range(-jitter, jitter), ay + ny * off + rng.range(-jitter, jitter), az + nz * off + rng.range(-jitter, jitter), vx, vy, vz, size, rng, rng.next() < KEEP)
        } else if (rng.next() < KEEP && this.restTokens >= 1) {
          // Too many in the air to throw this one: if it was one for the pile, it is put there.
          this.restTokens--
          this.rest(ax, ay, az, nx, nz, size, rng)
        }
      }
      if (this.puffTokens >= 1) {
        this.puffTokens--
        const amount = Math.max(0.2, Math.min(1.8, Math.sqrt(event.removedCm3) / 5))
        this.dust?.puff(ax + nx * 0.6, ay + ny * 0.6, az + nz * 0.6, rx * 0.5 + nx * 0.5, ry * 0.5 + ny * 0.5 + 0.2, rz * 0.5 + nz * 0.5, amount, 55 * force)
      }
    }
  }

  // ---------- time ----------

  /** Advances everything by dt seconds of film time; 0 holds it still. */
  update(dt: number) {
    if (this.loose.length && (this.world || this.failed)) {
      const shown = this.stone.shownRev
      this.loose = this.loose.filter((l) => {
        if (l.rev > shown) return true
        this.release(l.offcut)
        return false
      })
    }
    this.work()
    if (dt <= 0) return
    dt = Math.min(dt, 0.05)
    this.launchTokens = Math.min(60, this.launchTokens + LAUNCH_PER_S * dt)
    this.restTokens = Math.min(30, this.restTokens + REST_PER_S * dt)
    this.puffTokens = Math.min(8, this.puffTokens + PUFFS_PER_S * dt)
    this.simulate(dt)
    this.shrink(dt)
    this.fly(dt)
    if (this.chipsDirty) {
      this.chipsDirty = false
      this.chips.count = Math.max(1, this.used)
      this.chips.instanceMatrix.needsUpdate = true
      if (this.chips.instanceColor) this.chips.instanceColor.needsUpdate = true
    }
    this.dust?.update(dt)
  }

  /** A fresh block: the floor is swept, the air clears. */
  reset() {
    this.clearVanishing()
    for (const piece of this.pieces) this.discard(piece)
    this.pieces = []
    this.jobs = []
    this.loose = []
    this.saws = []
    this.moving = 0
    this.tris = 0
    this.clearChips()
    this.dust?.reset()
    this.rng = createRng(4401)
    if (this.world) for (let i = 0; i < this.stoneColliders.length; i++) this.dropStone(i)
    this.fitGrid(this.stone.grid)
  }

  /**
   * The pile roughly as the first `applied` entries of a log would have left it, without playing
   * them: a share of the chisel blows each put a chip or three where theirs would have landed,
   * every saw cut leaves a few lumps of its slab, and the dust lies as thick as that much work
   * raises. The same log gives the same pile.
   */
  settle(log: readonly Strike[], applied: number) {
    this.clearVanishing()
    for (const piece of this.pieces) this.discard(piece)
    this.pieces = []
    this.jobs = []
    this.loose = []
    this.moving = 0
    this.tris = 0
    this.clearChips()
    const to = Math.min(applied, log.length)
    // What each blow would have left in the pile, on average: its chips times the share that stay.
    const left = (strike: Strike) => {
      if (strike.kind !== 'cut') return 0
      const spec = TOOLS[strike.tool]
      return !spec || spec.mode !== 'bite' ? 0 : chipsFor(nominalBiteCm3(spec, strike.size, strike.depth) * 0.6) * KEEP
    }
    let expected = 0
    for (let i = 0; i < to; i++) expected += left(log[i]!)
    const share = Math.min(1, RESTORED_CHIPS / Math.max(1, expected))
    const rng = createRng(977)
    // Stone off the block so far, near enough: a saw's slab is not in the log, so each counts as a middling one.
    let off = 0
    for (let i = 0; i < to; i++) {
      const strike = log[i]!
      if (strike.kind === 'saw') {
        const [nx, , nz] = strike.plane.normal
        const level = Math.hypot(nx, nz)
        const ox = level > 0.3 ? nx / level : -0.45
        const oz = level > 0.3 ? nz / level : 0.89
        const lumps = 4 + rng.int(4)
        for (let j = 0; j < lumps; j++) {
          const reach = 38 + rng.range(0, 55)
          const side = rng.range(-28, 28)
          this.put(ox * reach - oz * side, oz * reach + ox * side, rng.range(3.5, 9), rng)
        }
        off += 4000
      } else if (strike.kind === 'cut' && strike.tool !== 'polish' && strike.tool !== 'rasp') {
        off += strike.size * strike.size * strike.depth * 0.17
        const some = left(strike) * share
        const count = Math.floor(some) + (rng.next() < some % 1 ? 1 : 0)
        const [ax, ay, az] = strike.at
        const away = Math.hypot(ax, az) || 1
        for (let j = 0; j < count; j++) this.rest(ax, ay, az, -strike.dir[0] + ax / away * 0.35, -strike.dir[2] + az / away * 0.35, Math.max(0.35, Math.min(3.2, strike.size * (0.06 + rng.next() ** 2 * 0.22))), rng)
      }
    }
    this.dust?.settle(off)
    this.chipsDirty = true
    this.chips.count = Math.max(1, this.used)
    this.chips.instanceMatrix.needsUpdate = true
    if (this.chips.instanceColor) this.chips.instanceColor.needsUpdate = true
  }

  dispose() {
    this.clearVanishing()
    for (const piece of this.pieces) this.discard(piece)
    this.pieces = []
    this.jobs = []
    this.speck?.removeFromParent()
    this.speck?.geometry.dispose()
    this.chips.removeFromParent()
    this.chips.geometry.dispose()
    this.chips.dispose()
    for (const material of this.ownMaterials) material.dispose()
    this.dust?.dispose()
    this.world?.free()
    this.world = null
  }

  // ---------- offcuts ----------

  private async start() {
    try {
      const R = await import('@dimforge/rapier3d-compat')
      await R.init()
      const world = new R.World({ x: 0, y: -GRAVITY, z: 0 })
      // The scene is in centimetres; Rapier's tolerances are told so.
      world.lengthUnit = 100
      const fixed = (hx: number, hy: number, hz: number, x: number, y: number, z: number) =>
        world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(0.7).setRestitution(0.05).setCollisionGroups(groups(G_STATIC, G_PIECE)))
      fixed(3000, 50, 3000, 0, this.floorY - 50, 0)
      for (const solid of this.solids) fixed(...solid.half, ...solid.center)
      this.R = R
      this.world = world
      this.rehearse()
    } catch (e) {
      // No physics: pieces that come away are dropped as chips, and nothing else changes.
      this.failed = true
      console.warn('[debris] physics did not start; offcuts will fall as chips', e)
    }
  }

  // The first slab would otherwise pay for everything being done for the first time (the wasm's
  // hull builder and solver, the mesh thinning and cleaving): a small stand-in slab is put
  // through all of it once, while the page is still loading and nobody is watching.
  private rehearse() {
    const world = this.world!
    const n = 14
    const positions: number[] = []
    const normals: number[] = []
    const indices: number[] = []
    // A closed box of n × n quads a face.
    for (let face = 0; face < 6; face++) {
      const axis = face >> 1
      const sign = face & 1 ? 1 : -1
      const base = positions.length / 3
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n; j++) {
          const p = [0, 0, 0]
          p[axis] = sign * 4
          p[(axis + 1) % 3] = (i / n - 0.5) * 30
          p[(axis + 2) % 3] = (j / n - 0.5) * 20
          positions.push(p[0]!, p[1]!, p[2]!)
          normals.push(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0)
        }
      }
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const a = base + i * (n + 1) + j
          const b = a + n + 1
          if (sign > 0) indices.push(a, b, a + 1, a + 1, b, b + 1)
          else indices.push(a, a + 1, b, a + 1, b + 1, b)
        }
      }
    }
    const shell: Shell = { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) }
    const work = thin(shell, 1.2, 400)
    let step = work.next()
    while (!step.done) step = work.next()
    const halves = cleave(step.value, [1, 0.2, 0.1], 0)
    const bodies = (halves ?? [shell]).map((half, i) => this.embody(half, boundsOf(half.positions), volumeOf(half), 400 + i * 40, this.floorY + 30, 400, null, false))
    for (let i = 0; i < 20; i++) world.step()
    for (const body of bodies) world.removeRigidBody(body)
  }

  private fitGrid(grid: GridInfo) {
    this.grid = grid
    const n = grid.ncx * grid.ncy * grid.ncz
    if (this.has.length !== n) {
      this.boxes = new Float32Array(n * 6)
      this.has = new Uint8Array(n)
      this.stoneColliders = new Array<Collider | null>(n).fill(null)
    } else {
      this.has.fill(0)
    }
    this.stoneDirty.clear()
  }

  private dropStone(id: number) {
    const old = this.stoneColliders[id]
    if (old && this.world) this.world.removeCollider(old, true)
    this.stoneColliders[id] = null
  }

  // Brings the stone's colliders up to date with its boxes. Only while something could hit them.
  // A piece at rest against a chunk that has just been cut is set loose again: the stone it was
  // leaning on may not be there any more.
  private fitStone() {
    const { R, world } = this
    if (!R || !world || !this.stoneDirty.size) return
    for (const id of this.stoneDirty) {
      this.dropStone(id)
      const b = this.boxes
      const o = id * 6
      // The chunk's place in the grid says near enough where its stone is, or was.
      const span = this.grid.chunk * this.grid.voxel
      const cx = this.grid.x0 + (id % this.grid.ncx + 0.5) * span
      const cy = this.grid.y0 + (Math.floor(id / this.grid.ncx) % this.grid.ncy + 0.5) * span
      const cz = this.grid.z0 + (Math.floor(id / (this.grid.ncx * this.grid.ncy)) + 0.5) * span
      for (const piece of this.pieces) {
        const ball = piece.mesh.geometry.boundingSphere
        if (!piece.fixed || !ball) continue
        const reach = ball.radius + 2 + span / 2
        const { x, y, z } = this.v.copy(ball.center).applyQuaternion(piece.mesh.quaternion).add(piece.mesh.position)
        if (Math.abs(x - cx) < reach && Math.abs(y - cy) < reach && Math.abs(z - cz) < reach && this.leans(piece)) this.loosen(piece)
      }
      if (!this.has[id]) continue
      const hx = Math.max(0.2, (b[o + 3]! - b[o]!) / 2)
      const hy = Math.max(0.2, (b[o + 4]! - b[o + 1]!) / 2)
      const hz = Math.max(0.2, (b[o + 5]! - b[o + 2]!) / 2)
      // Slippery, so a slab cut from the top slides off under the shove it is given.
      this.stoneColliders[id] = world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation((b[o]! + b[o + 3]!) / 2, (b[o + 1]! + b[o + 4]!) / 2, (b[o + 2]! + b[o + 5]!) / 2)
        .setFriction(0.1)
        .setFrictionCombineRule(R.CoefficientCombineRule.Min)
        .setRestitution(0.02)
        .setCollisionGroups(groups(G_STONE, G_PIECE)))
    }
    this.stoneDirty.clear()
  }

  private geometryOf(shell: Shell, origin: [number, number, number], bounds: Bounds) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(shell.positions, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(shell.normals, 3))
    if (this.coords) {
      const where = new Float32Array(shell.positions.length)
      for (let i = 0; i < where.length; i += 3) {
        where[i] = shell.positions[i]! + origin[0]
        where[i + 1] = shell.positions[i + 1]! + origin[1]
        where[i + 2] = shell.positions[i + 2]! + origin[2]
      }
      g.setAttribute(this.coords, new THREE.BufferAttribute(where, 3))
    }
    g.setIndex(new THREE.BufferAttribute(shell.indices, 1))
    g.boundingBox = new THREE.Box3(new THREE.Vector3(...bounds.min), new THREE.Vector3(...bounds.max))
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere())
    return g
  }

  // A rigid body with a convex collider wrapped round the shell; a box if the points will not make a hull.
  private embody(shell: Shell, bounds: Bounds, cm3: number, x: number, y: number, z: number, rotation: { x: number, y: number, z: number, w: number } | null, touchesStone: boolean) {
    const R = this.R!
    const world = this.world!
    const desc = R.RigidBodyDesc.dynamic().setTranslation(x, y, z).setLinearDamping(0.03).setAngularDamping(0.25).setCanSleep(true)
    if (rotation) desc.setRotation(rotation)
    const body = world.createRigidBody(desc)
    const { min, max } = bounds
    const shape = R.ColliderDesc.convexHull(extremes(shell.positions))
      ?? R.ColliderDesc.cuboid(Math.max(0.3, (max[0] - min[0]) / 2), Math.max(0.3, (max[1] - min[1]) / 2), Math.max(0.3, (max[2] - min[2]) / 2))
        .setTranslation((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
    shape.setMass(Math.max(0.05, cm3 * KG_PER_CM3)).setFriction(0.6).setRestitution(0.06)
      .setCollisionGroups(groups(G_PIECE, touchesStone ? G_STATIC | G_STONE | G_PIECE : G_STATIC | G_PIECE))
    world.createCollider(shape, body)
    return body
  }

  private add(shell: Shell, low: Shell | null, cm3: number, origin: [number, number, number], body: RigidBody, bounds: Bounds, grace: number, breakable: boolean, big: boolean): Piece {
    const mesh = new THREE.Mesh(this.geometryOf(shell, origin, bounds), this.offcutMaterial)
    mesh.name = 'offcut'
    mesh.castShadow = true
    mesh.receiveShadow = true
    const t = body.translation()
    const r = body.rotation()
    mesh.position.set(t.x, t.y, t.z)
    mesh.quaternion.set(r.x, r.y, r.z, r.w)
    this.studio.stage.add(mesh)
    const v = body.linvel()
    const piece: Piece = {
      mesh, body, cm3, origin, shell, low,
      tris: shell.indices.length / 3,
      age: 0, quiet: 0, grace, breakable, wantsBreak: false, big, fixed: false,
      vx: v.x, vy: v.y, vz: v.z, sinceHit: 0, nudges: 0
    }
    this.pieces.push(piece)
    this.moving++
    this.tris += piece.tris
    return piece
  }

  // An offcut leaves the block: a chip if it is a crumb, otherwise a body shoved the way it should go.
  private release(offcut: Offcut) {
    const [cx, cy, cz] = offcut.centroid
    const rng = this.rng
    if (!this.world || offcut.cm3 < CRUMB_CM3 || offcut.indices.length < 36) {
      const away = Math.hypot(cx, cz) || 1
      const size = Math.max(0.5, Math.min(4, Math.cbrt(offcut.cm3)))
      const crumbs = this.world ? 1 : Math.max(1, Math.min(12, Math.round(offcut.cm3 / 400)))
      for (let i = 0; i < crumbs; i++) {
        if (!this.launch(cx + rng.range(-1, 1) * (crumbs - 1), cy + rng.range(-1, 1) * (crumbs - 1), cz + rng.range(-1, 1) * (crumbs - 1), cx / away * rng.range(10, 45), rng.range(-5, 25), cz / away * rng.range(10, 45), size * rng.range(0.7, 1.2), rng, true)) break
      }
      return
    }
    const positions = offcut.positions
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = positions[i]! - cx
      positions[i + 1] = positions[i + 1]! - cy
      positions[i + 2] = positions[i + 2]! - cz
    }
    const shell: Shell = { positions, normals: offcut.normals, indices: offcut.indices }
    const bounds = boundsOf(positions)

    // Which way it goes. A sawn piece leaves along its saw's normal; an island, away from the
    // block's axis. A slab sawn off the top has nowhere level to go, so it is slid off toward
    // the window side of the front, where the light is.
    let saw: { point: [number, number, number], normal: [number, number, number] } | null = null
    for (let i = this.saws.length - 1; i >= 0 && !saw; i--) {
      const s = this.saws[i]!
      if ((cx - s.point[0]) * s.normal[0] + (cy - s.point[1]) * s.normal[1] + (cz - s.point[2]) * s.normal[2] > 0) saw = s
    }
    let ox = saw ? saw.normal[0] : cx
    let oz = saw ? saw.normal[2] : cz
    const level = Math.hypot(ox, oz)
    const onTop = saw !== null && saw.normal[1] > 0.7
    if (level < (saw ? 0.3 : 3)) {
      ox = -0.45
      oz = 0.89
    } else {
      ox /= level
      oz /= level
    }
    const big = offcut.cm3 >= FALL_CM3
    const body = this.embody(shell, bounds, offcut.cm3, cx, cy, cz, null, onTop)
    if (onTop) {
      // Sitting on the stone it was sawn from: a hard shove along the cut.
      const shove = rng.range(105, 125)
      body.setLinvel({ x: ox * shove, y: 0, z: oz * shove }, true)
      body.setAngvel({ x: 0, y: rng.range(-0.25, 0.25), z: 0 }, true)
    } else {
      // Standing beside it: it leans out from the top and goes over.
      const push = big ? rng.range(22, 34) : rng.range(30, 70)
      const tip = big ? rng.range(0.9, 1.3) : rng.range(0.6, 2.4)
      body.setLinvel({ x: ox * push, y: big ? 0 : rng.range(0, 20), z: oz * push }, true)
      body.setAngvel({ x: oz * tip, y: rng.range(-0.3, 0.3), z: -ox * tip }, true)
    }
    const small = offcut.indices.length / 3 <= THIN_OVER_TRIS
    const piece = this.add(shell, small ? shell : null, offcut.cm3, [cx, cy, cz], body, bounds, onTop ? 0 : 0.45, offcut.cm3 >= BREAK_CM3, big)
    if (!small) {
      const cell = Math.max(0.8, Math.min(1.6, Math.cbrt(offcut.cm3) / 28))
      this.jobs.push({ piece, work: thin(shell, cell) })
    }
    if (big) this.onFall({ cm3: offcut.cm3, at: new THREE.Vector3(cx, cy, cz), out: new THREE.Vector3(ox, 0, oz) })
    this.trim()
  }

  // Mesh thinning, a few slices a frame; and whatever was waiting on it.
  private work() {
    for (let n = 0; n < THIN_SLICES && this.jobs.length; n++) {
      const job = this.jobs[0]!
      const step = job.work.next()
      if (!step.done) continue
      this.jobs.shift()
      const piece = job.piece
      if (!this.pieces.includes(piece)) continue
      piece.low = step.value
      if (piece.fixed) this.lighten(piece)
    }
    for (const piece of this.pieces.slice()) {
      if (piece.wantsBreak && piece.low && !piece.fixed) this.shatter(piece)
    }
  }

  // Swaps a piece's mesh for its thinned one.
  private lighten(piece: Piece) {
    if (!piece.low || piece.low === piece.shell) return
    piece.mesh.geometry.dispose()
    piece.mesh.geometry = this.geometryOf(piece.low, piece.origin, boundsOf(piece.low.positions))
    this.tris += piece.low.indices.length / 3 - piece.tris
    piece.tris = piece.low.indices.length / 3
    piece.shell = piece.low
  }

  private simulate(dt: number) {
    const world = this.world
    if (!world) return
    if (this.pieces.length) this.fitStone()
    if (this.moving === 0) return
    const steps = Math.min(MAX_STEPS, Math.max(1, Math.ceil(dt / STEP)))
    const h = dt / steps
    world.timestep = h
    const t0 = performance.now()
    for (let i = 0; i < steps; i++) {
      world.step()
      this.afterStep(h)
    }
    // For stats() only: what a frame's physics costs.
    this.stepMs += (performance.now() - t0 - this.stepMs) * 0.1

    for (const piece of this.pieces.slice()) {
      if (piece.fixed) continue
      const body = piece.body
      const t = body.translation()
      const r = body.rotation()
      piece.mesh.position.set(t.x, t.y, t.z)
      piece.mesh.quaternion.set(r.x, r.y, r.z, r.w)
      piece.age += dt
      if (piece.grace > 0) {
        piece.grace -= dt
        if (piece.grace <= 0) body.collider(0).setCollisionGroups(groups(G_PIECE, G_STATIC | G_STONE | G_PIECE))
      }
      if (t.y < this.floorY - 120) {
        this.remove(piece)
        continue
      }
      const w = body.angvel()
      const still = Math.hypot(piece.vx, piece.vy, piece.vz) < 4 && Math.hypot(w.x, w.y, w.z) < 0.3
      piece.quiet = still ? piece.quiet + dt : 0
      if (body.isSleeping() || piece.quiet > 0.7 || piece.age > 14) this.fix(piece)
    }
    if (this.moving > MAX_MOVING) {
      const oldest = this.pieces.find(p => !p.fixed)
      if (oldest) this.fix(oldest)
    }
  }

  // After each physics step: who hit something, and how hard.
  private afterStep(h: number) {
    for (const piece of this.pieces) {
      if (piece.fixed) continue
      const v = piece.body.linvel()
      const lost = Math.hypot(v.x - piece.vx, v.y - (piece.vy - GRAVITY * h), v.z - piece.vz)
      piece.vx = v.x
      piece.vy = v.y
      piece.vz = v.z
      piece.sinceHit += h
      if (lost < HIT || piece.sinceHit < 0.1 || piece.age < 0.05) continue
      piece.sinceHit = 0
      const breaks = piece.breakable && lost >= BREAK_HIT
      if (breaks) {
        piece.breakable = false
        piece.wantsBreak = true
      }
      const t = piece.body.translation()
      // The hit is under the piece, near enough.
      const y = Math.max(this.ground(t.x, t.z, t.y) + 1, t.y - 6)
      const weight = Math.min(1, piece.cm3 / 20000)
      this.dust?.raise(piece.cm3 * 0.04)
      // Slow and low, so the cloud stays round where the piece came down long enough to be seen.
      this.dust?.puff(t.x, y, t.z, 0, 0.6, 0, Math.min(60, (1.5 + weight * 36) * Math.min(1.5, lost / 160)), 55 + weight * 70)
      const burst = Math.round(Math.min(breaks ? 36 : 12, (2 + weight * 40) * lost / 250))
      const size = Math.cbrt(piece.cm3)
      for (let i = 0; i < burst; i++) {
        const a = this.rng.range(0, Math.PI * 2)
        const out = this.rng.range(40, 190)
        if (!this.launch(t.x + Math.cos(a) * this.rng.range(0, size * 0.4), y + this.rng.range(0, 3), t.z + Math.sin(a) * this.rng.range(0, size * 0.4), Math.cos(a) * out, this.rng.range(40, 230), Math.sin(a) * out, this.rng.range(0.5, 2.6), this.rng, this.rng.next() < 0.4)) break
      }
      this.onImpact({ cm3: piece.cm3, at: new THREE.Vector3(t.x, y, t.z), speed: lost, broke: breaks })
    }
  }

  // The one break: the thinned mesh is cleaved along its length, the larger part perhaps again,
  // and each part carries on from where the whole was with a kick of its own.
  private shatter(piece: Piece) {
    piece.wantsBreak = false
    const parts: { shell: Shell, cm3: number }[] = [{ shell: piece.low!, cm3: piece.cm3 }]
    const want = piece.cm3 > 12000 ? 4 : piece.cm3 > 5000 ? 3 : 2
    const rng = this.rng
    for (let tries = 0; parts.length < want && tries < 6; tries++) {
      parts.sort((a, b) => b.cm3 - a.cm3)
      const whole = parts[0]!
      const { min, max } = boundsOf(whole.shell.positions)
      const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
      // Across its longest way, or on a second try its next longest, off square and off centre.
      const order = [0, 1, 2].sort((a, b) => size[b]! - size[a]!)
      const axis = order[tries < 3 ? 0 : 1]!
      const n: [number, number, number] = [rng.range(-0.4, 0.4), rng.range(-0.4, 0.4), rng.range(-0.4, 0.4)]
      n[axis] = 1
      const nl = Math.hypot(n[0], n[1], n[2])
      n[0] /= nl
      n[1] /= nl
      n[2] /= nl
      const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
      c[axis] = c[axis]! + size[axis]! * rng.range(-0.14, 0.14)
      const halves = cleave(whole.shell, n, n[0] * c[0]! + n[1] * c[1]! + n[2] * c[2]!)
      if (!halves) continue
      parts.splice(0, 1, { shell: halves[0], cm3: volumeOf(halves[0]) }, { shell: halves[1], cm3: volumeOf(halves[1]) })
    }
    if (parts.length < 2) return

    const body = piece.body
    const t = body.translation()
    const r = body.rotation()
    const v = body.linvel()
    const w = body.angvel()
    this.remove(piece)
    this.q.set(r.x, r.y, r.z, r.w)
    for (const part of parts) {
      const bounds = boundsOf(part.shell.positions)
      // Where the part's middle is, out from the whole's.
      this.v.set((bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2).applyQuaternion(this.q)
      const apart = Math.hypot(this.v.x, this.v.z) || 1
      const kick = rng.range(25, 70)
      const made = this.embody(part.shell, bounds, part.cm3, t.x, t.y, t.z, r, true)
      made.setLinvel({
        x: v.x * 0.7 + (w.y * this.v.z - w.z * this.v.y) + this.v.x / apart * kick,
        y: Math.max(v.y, 0) * 0.5 + rng.range(25, 90),
        z: v.z * 0.7 + (w.x * this.v.y - w.y * this.v.x) + this.v.z / apart * kick
      }, true)
      made.setAngvel({ x: w.x + rng.range(-3, 3), y: w.y + rng.range(-2, 2), z: w.z + rng.range(-3, 3) }, true)
      this.add(part.shell, part.shell, part.cm3, piece.origin, made, bounds, 0, false, part.cm3 >= FALL_CM3)
    }
    this.trim()
  }

  // Whether a piece at rest is resting on the stone and not on the banker or the floor: its
  // middle stands higher above whatever is under it than a piece lying flat would.
  private leans(piece: Piece) {
    const box = piece.mesh.geometry.boundingBox
    const ball = piece.mesh.geometry.boundingSphere
    if (!box || !ball) return false
    const { x, y, z } = this.v.copy(ball.center).applyQuaternion(piece.mesh.quaternion).add(piece.mesh.position)
    const least = Math.min(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
    return y - this.ground(x, z, y) > least * 0.5 + 3
  }

  // A frozen piece set moving again.
  private loosen(piece: Piece) {
    if (!piece.fixed || this.moving >= MAX_MOVING) return
    piece.fixed = false
    piece.quiet = 0
    piece.age = 0
    this.moving++
    piece.body.setBodyType(this.R!.RigidBodyType.Dynamic, true)
    piece.mesh.matrixAutoUpdate = true
  }

  // A piece that has stopped: frozen where it lies, still something to land on. Except on the
  // sculpture: nothing is left lodged on the piece being carved. It is pushed off, outward and a
  // little up, and one that still comes to rest there is shrunk away.
  private fix(piece: Piece) {
    if (piece.fixed) return
    if (this.onStone(piece)) {
      if (piece.nudges < NUDGES && piece.age < 12) {
        piece.nudges++
        piece.quiet = 0
        const { x, z } = piece.mesh.position
        const away = Math.hypot(x, z) || 1
        piece.body.setLinvel({ x: x / away * 70, y: 35, z: z / away * 70 }, true)
        piece.body.setAngvel({ x: this.rng.range(-2, 2), y: 0, z: this.rng.range(-2, 2) }, true)
        return
      }
      this.vanish(piece)
      return
    }
    piece.fixed = true
    piece.wantsBreak = false
    this.moving--
    piece.body.setBodyType(this.R!.RigidBodyType.Fixed, false)
    piece.mesh.updateMatrix()
    piece.mesh.matrixAutoUpdate = false
    this.lighten(piece)
    this.trim()
  }

  // Resting on the sculpture rather than on the banker, the floor or the pile: within the block's
  // footprint, and either higher above what is under it than a piece lying flat, or touching the
  // stone and standing up off the flat (a slab leaning on the plinth).
  private onStone(piece: Piece) {
    const leans = this.leans(piece)
    // leans() leaves the piece's middle in this.v.
    const { x, z } = this.v
    const g = this.grid
    const span = g.chunk * g.voxel
    if (!(x > g.x0 - 4 && x < g.x0 + g.ncx * span + 4 && z > g.z0 - 4 && z < g.z0 + g.ncz * span + 4)) return false
    if (leans) return true
    const box = piece.mesh.geometry.boundingBox
    if (!box || !this.touchesStone(piece)) return false
    const least = Math.min(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
    this.m.compose(piece.mesh.position, piece.mesh.quaternion, this.s.set(1, 1, 1))
    const tall = this.box.copy(box).applyMatrix4(this.m)
    return tall.max.y - tall.min.y > least * 1.6 + 2
  }

  // Whether the piece's collider has a contact point on any of the stone's boxes.
  private touchesStone(piece: Piece) {
    const world = this.world
    if (!world) return false
    const mine = piece.body.collider(0)
    let touching = false
    world.contactPairsWith(mine, (other) => {
      if (touching || !this.stoneColliders.includes(other)) return
      world.contactPair(mine, other, (manifold) => {
        if (manifold.numContacts() > 0) touching = true
      })
    })
    return touching
  }

  private vanish(piece: Piece) {
    const at = this.pieces.indexOf(piece)
    if (at >= 0) this.pieces.splice(at, 1)
    if (!piece.fixed) this.moving--
    this.tris -= piece.tris
    this.world?.removeRigidBody(piece.body)
    piece.mesh.matrixAutoUpdate = true
    this.vanishing.push({ mesh: piece.mesh, left: VANISH_S, scale: piece.mesh.scale.x })
  }

  private shrink(dt: number) {
    for (let i = this.vanishing.length - 1; i >= 0; i--) {
      const v = this.vanishing[i]!
      v.left -= dt
      const k = Math.max(0, v.left / VANISH_S)
      // About its own middle: an offcut's mesh is centred on its centroid.
      v.mesh.scale.setScalar(v.scale * k * k * (3 - 2 * k))
      if (v.left > 0) continue
      v.mesh.removeFromParent()
      v.mesh.geometry.dispose()
      this.vanishing.splice(i, 1)
    }
  }

  private clearVanishing() {
    for (const v of this.vanishing) {
      v.mesh.removeFromParent()
      v.mesh.geometry.dispose()
    }
    this.vanishing = []
  }

  // Past the budget, the oldest pieces at rest are cleared away.
  private trim() {
    while (this.pieces.length > MAX_PIECES || this.tris > MAX_TRIS) {
      const oldest = this.pieces.find(p => p.fixed)
      if (!oldest) return
      this.remove(oldest)
    }
  }

  private remove(piece: Piece) {
    const at = this.pieces.indexOf(piece)
    if (at >= 0) this.pieces.splice(at, 1)
    if (!piece.fixed) this.moving--
    this.tris -= piece.tris
    this.discard(piece)
  }

  private discard(piece: Piece) {
    this.world?.removeRigidBody(piece.body)
    piece.mesh.removeFromParent()
    piece.mesh.geometry.dispose()
  }

  // ---------- chips ----------

  private clearChips() {
    this.used = this.head = this.liveCount = this.fadingCount = this.freeCount = 0
    this.flying.fill(0)
    this.pile.fill(0)
    this.chips.setMatrixAt(0, this.m.makeScale(0, 0, 0))
    this.chips.instanceMatrix.needsUpdate = true
    this.chips.count = 1
    this.launchTokens = 40
    this.restTokens = 20
    this.puffTokens = 6
  }

  // A slot for a new chip: one a faded chip gave back, else one never used, else the oldest in the pile.
  private slot() {
    if (this.freeCount > 0) return this.free[--this.freeCount]!
    if (this.used < CHIP_MAX) return this.used++
    let s = this.head
    for (let tries = 0; tries < CHIP_MAX && this.flying[s]; tries++) s = (s + 1) % CHIP_MAX
    this.head = (s + 1) % CHIP_MAX
    return s
  }

  private pileAt(x: number, z: number) {
    const i = Math.floor((x + PILE_HALF) / PILE_CELL)
    const k = Math.floor((z + PILE_HALF) / PILE_CELL)
    return i < 0 || k < 0 || i >= PILE_N || k >= PILE_N ? -1 : i + k * PILE_N
  }

  // What a thing coming down at (x, z) from height y lands on: the floor or a solid's top, plus the pile already there.
  private ground(x: number, z: number, y: number) {
    let top = this.floorY
    for (const solid of this.solids) {
      const [cx, cy, cz] = solid.center
      const [hx, hy, hz] = solid.half
      if (Math.abs(x - cx) <= hx && Math.abs(z - cz) <= hz && cy + hy > top && cy + hy <= y + 2) top = cy + hy
    }
    const cell = this.pileAt(x, z)
    return cell < 0 ? top : top + this.pile[cell]!
  }

  private inStone(x: number, y: number, z: number) {
    const g = this.grid
    const span = g.chunk * g.voxel
    const cx = Math.floor((x - g.x0) / span)
    const cy = Math.floor((y - g.y0) / span)
    const cz = Math.floor((z - g.z0) / span)
    if (cx < 0 || cy < 0 || cz < 0 || cx >= g.ncx || cy >= g.ncy || cz >= g.ncz) return -1
    const id = cx + g.ncx * (cy + g.ncy * cz)
    if (!this.has[id]) return -1
    const b = this.boxes
    const o = id * 6
    return x > b[o]! && x < b[o + 3]! && y > b[o + 1]! && y < b[o + 4]! && z > b[o + 2]! && z < b[o + 5]! ? id : -1
  }

  private write(s: number, colour: boolean, rng: Rng | null) {
    const { cp, cq, cs } = this
    this.v.set(cp[s * 3]!, cp[s * 3 + 1]!, cp[s * 3 + 2]!)
    this.q.set(cq[s * 4]!, cq[s * 4 + 1]!, cq[s * 4 + 2]!, cq[s * 4 + 3]!)
    this.s.set(cs[s * 3]!, cs[s * 3 + 1]!, cs[s * 3 + 2]!)
    this.chips.setMatrixAt(s, this.m.compose(this.v, this.q, this.s))
    if (colour && rng) this.chips.setColorAt(s, this.tint.setScalar(rng.range(0.8, 1)))
    this.chipsDirty = true
  }

  /** A chip into the air; `stays` if it is one for the pile. False when no more can fly. */
  private launch(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, rng: Rng, stays: boolean) {
    if (this.liveCount >= CHIP_LIVE) return false
    const s = this.slot()
    this.flying[s] = 1
    // With no room for another on its way out, it stays.
    this.stays[s] = stays || this.fadingCount >= CHIP_FADING - CHIP_LIVE ? 1 : 0
    this.live[this.liveCount++] = s
    this.cp.set([x, y, z], s * 3)
    this.cv.set([vx, vy, vz], s * 3)
    this.q.setFromEuler(this.e.set(rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28)))
    this.cq.set([this.q.x, this.q.y, this.q.z, this.q.w], s * 4)
    this.cw.set([rng.range(-22, 22), rng.range(-22, 22), rng.range(-22, 22)], s * 3)
    this.cs.set([size * rng.range(0.8, 1.3), size * rng.range(0.7, 1.1), size * rng.range(0.8, 1.2)], s * 3)
    this.cage[s] = 0
    this.write(s, true, rng)
    return true
  }

  /** A chip put straight where one thrown from (x, y, z) would have come to rest. `ox, oz` lean the way it was thrown. */
  private rest(x: number, y: number, z: number, ox: number, oz: number, size: number, rng: Rng) {
    const level = Math.hypot(ox, oz) || 1
    // Further for a blow higher up the block; most land close.
    const reach = (5 + Math.sqrt(Math.max(0, y - this.floorY)) * rng.range(0.6, 5.5)) * rng.range(0.5, 1.2)
    const side = rng.range(-0.6, 0.6)
    const px = x + (ox / level - oz / level * side) * reach
    const pz = z + (oz / level + ox / level * side) * reach
    this.put(px, pz, size, rng)
  }

  // A shard lying at (x, z) on whatever is under it, pushed clear of the stone's foot first.
  private put(x: number, z: number, size: number, rng: Rng) {
    const away = Math.hypot(x, z) || 1
    for (let tries = 0; tries < 6 && this.inStone(x, 1.5, z) >= 0; tries++) {
      x += x / away * 6
      z += z / away * 6
    }
    const s = this.slot()
    this.flying[s] = 0
    this.cs.set([size * rng.range(0.8, 1.3), size * rng.range(0.7, 1.1), size * rng.range(0.8, 1.2)], s * 3)
    this.cp.set([x, this.ground(x, z, 1e6), z], s * 3)
    this.lay(s, rng.range(0, 6.28), rng.range(-0.3, 0.3), rng.range(-0.3, 0.3))
    this.chips.setColorAt(s, this.tint.setScalar(rng.range(0.8, 1)))
  }

  // Lays chip `s` down flat where it is and, if it is staying, adds it to the pile's height.
  private lay(s: number, yaw: number, tiltX: number, tiltZ: number, stays = true) {
    const thick = this.cs[s * 3 + 1]! * 0.25
    this.cp[s * 3 + 1] = this.cp[s * 3 + 1]! + thick * 0.6
    this.q.setFromEuler(this.e.set(tiltX, yaw, tiltZ))
    this.cq.set([this.q.x, this.q.y, this.q.z, this.q.w], s * 4)
    const cell = stays ? this.pileAt(this.cp[s * 3]!, this.cp[s * 3 + 2]!) : -1
    if (cell >= 0) {
      const volume = this.cs[s * 3]! * this.cs[s * 3 + 1]! * this.cs[s * 3 + 2]! * 0.3
      this.pile[cell] = Math.min(PILE_MAX_CM, this.pile[cell]! + volume / (PILE_CELL * PILE_CELL) * 1.8)
    }
    this.write(s, false, null)
  }

  // The chips in the air: gravity, a bounce off whatever is under them or the stone, and rest.
  private fly(dt: number) {
    const { cp, cv, cq, cw, cs, cage, live } = this
    for (let k = 0; k < this.liveCount; k++) {
      const s = live[k]!
      const p = s * 3
      cage[s] = cage[s]! + dt
      // One that has found nowhere to land in all this time (caught in a hollow of the stone) is let go of.
      if (cage[s]! > STRAY_S && this.fadingCount < CHIP_FADING) {
        live[k] = live[--this.liveCount]!
        k--
        this.flying[s] = 2
        cage[s] = -FADE_S
        this.fading[this.fadingCount++] = s
        continue
      }
      cv[p + 1] = cv[p + 1]! - GRAVITY * dt
      const fromY = cp[p + 1]!
      cp[p] = cp[p]! + cv[p]! * dt
      cp[p + 1] = fromY + cv[p + 1]! * dt
      cp[p + 2] = cp[p + 2]! + cv[p + 2]! * dt
      // A turn of the quaternion by the spin: q += ½ ω q dt.
      const o = s * 4
      const wx = cw[p]! * dt * 0.5
      const wy = cw[p + 1]! * dt * 0.5
      const wz = cw[p + 2]! * dt * 0.5
      const qx = cq[o]!
      const qy = cq[o + 1]!
      const qz = cq[o + 2]!
      const qw = cq[o + 3]!
      let rx = qx + wx * qw + wy * qz - wz * qy
      let ry = qy + wy * qw + wz * qx - wx * qz
      let rz = qz + wz * qw + wx * qy - wy * qx
      let rw = qw - wx * qx - wy * qy - wz * qz
      const rl = Math.hypot(rx, ry, rz, rw) || 1
      rx /= rl
      ry /= rl
      rz /= rl
      rw /= rl
      cq[o] = rx
      cq[o + 1] = ry
      cq[o + 2] = rz
      cq[o + 3] = rw

      let landed = false
      const x = cp[p]!
      const z = cp[p + 2]!
      const half = cs[p + 1]! * 0.3
      const ground = this.ground(x, z, fromY)
      if (cp[p + 1]! - half <= ground && cv[p + 1]! < 0) {
        cp[p + 1] = ground + half
        if (cv[p + 1]! < -55 && cage[s]! < 6) {
          cv[p + 1] = -cv[p + 1]! * 0.28
          cv[p] = cv[p]! * 0.55
          cv[p + 2] = cv[p + 2]! * 0.55
          cw[p] = cw[p]! * 0.5
          cw[p + 1] = cw[p + 1]! * 0.5
          cw[p + 2] = cw[p + 2]! * 0.5
        } else {
          landed = true
        }
      } else if (cage[s]! > 0.12) {
        // Off the stone: out through the nearest face of the box it has flown into.
        const id = this.inStone(x, cp[p + 1]!, z)
        if (id >= 0) {
          const b = this.boxes
          const q6 = id * 6
          let best = Infinity
          let axis = 0
          let sign = 1
          for (let a = 0; a < 3; a++) {
            const lo = cp[p + a]! - b[q6 + a]!
            const hi = b[q6 + 3 + a]! - cp[p + a]!
            if (lo < best) {
              best = lo
              axis = a
              sign = -1
            }
            if (hi < best) {
              best = hi
              axis = a
              sign = 1
            }
          }
          cp[p + axis] = sign > 0 ? b[q6 + 3 + axis]! : b[q6 + axis]!
          if (cv[p + axis]! * sign < 0) cv[p + axis] = -cv[p + axis]! * 0.35
          // Nothing comes to rest on the stone: it would be left hanging when the stone under it is cut.
          if (axis === 1 && sign > 0) {
            const away = Math.hypot(x, z) || 1
            cv[p] = cv[p]! + x / away * 45
            cv[p + 2] = cv[p + 2]! + z / away * 45
            cv[p + 1] = cv[p + 1]! + 25
          }
        }
      }
      if (landed) {
        live[k] = live[--this.liveCount]!
        k--
        cp[p + 1] = ground
        const stays = this.stays[s] === 1
        // Flat, facing whichever way it was turned.
        this.lay(s, Math.atan2(2 * (rw * ry + rx * rz), 1 - 2 * (ry * ry + rx * rx)), (rx % 0.3), (rz % 0.3), stays)
        if (stays) {
          this.flying[s] = 0
        } else {
          // Counts down through zero: lying there, then going.
          this.flying[s] = 2
          cage[s] = -(LINGER_S[0] + ((s * 7919) % 1000) / 1000 * (LINGER_S[1] - LINGER_S[0]))
          this.fading[this.fadingCount++] = s
        }
      } else {
        this.write(s, false, null)
      }
    }

    // The ones that are not staying: gone after their while, the slot handed back.
    const fading = this.fading
    for (let k = 0; k < this.fadingCount; k++) {
      const s = fading[k]!
      cage[s] = cage[s]! + dt
      if (cage[s]! < -FADE_S) continue
      const left = Math.max(0, -cage[s]! / FADE_S)
      const p = s * 3
      this.v.set(cp[p]!, cp[p + 1]! - cs[p + 1]! * 0.2 * (1 - left), cp[p + 2]!)
      this.q.set(cq[s * 4]!, cq[s * 4 + 1]!, cq[s * 4 + 2]!, cq[s * 4 + 3]!)
      this.s.set(cs[p]! * left, cs[p + 1]! * left, cs[p + 2]! * left)
      this.chips.setMatrixAt(s, this.m.compose(this.v, this.q, this.s))
      this.chipsDirty = true
      if (left <= 0) {
        this.flying[s] = 0
        this.free[this.freeCount++] = s
        fading[k] = fading[--this.fadingCount]!
        k--
      }
    }
  }
}
