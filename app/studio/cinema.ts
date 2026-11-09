/**
 * The film around the stone, in one place: debris, tools, sound and the camera director, wired to
 * each other, to the room the look is built in (atelier, marble, the post stack's focus), and to
 * whichever timeline has the stage.
 *
 * Whoever makes a timeline calls bind(timeline). From then on the timeline's listener hooks drive
 * everything: `strikes` throws chips and dust, swings the mallet, sounds the blow and tells the
 * director where the work is; `look`/`lookEnd` put the tools down; `reset` sweeps the floor; `jump`
 * lays the pile a skipped stretch of log would have left; `change` says paused or done.
 * upcoming() is read every frame for the mallet's beat and the saw's travel. Strikes made with
 * no timeline (hand carving) come in through struck().
 *
 * One clock for the film: each frame the director says how fast it runs (`timeScale`, below 1
 * while a slab falls), and that scale is put on the timeline's tick and on the dt handed to
 * debris, tools and sound. A paused timeline holds them still. Only the camera keeps real frame time.
 */
import * as THREE from 'three/webgpu'
import { nominalBiteCm3, TOOLS } from '#shared/sculpt/tools'
import type { ChunkMesh, Offcut, Strike } from '#shared/sculpt/types'
import { ATELIER_SOLIDS, BACK_Z, BANKER_HALF, BANKER_TOP_Y, FLOOR_Y, WALL_X } from './atelier'
import type { CameraRig } from './camera'
import { Debris } from './debris'
import { Director } from './director'
import { Dust } from './dust'
import type { KernelClient } from './kernel'
import { createChipMarble, STONE_COORDS } from './materials/marble'
import type { StudioRenderer } from './renderer'
import { Sound } from './sound'
import type { Stone } from './stone'
import type { StrikeEvent, TimelineListener, TimelineState, UpcomingStrike } from './timeline'
import { Tools } from './tools'

/** What the film needs of a timeline. */
export interface FilmTimeline {
  timeScale: number
  listen: (listener: TimelineListener) => () => void
  upcoming: () => UpcomingStrike | null
  state: () => TimelineState
}

type DustNode = Parameters<NonNullable<ConstructorParameters<typeof Dust>[1]['shaft']>>[0]

export class Cinema {
  readonly debris: Debris
  readonly tools: Tools
  readonly sound: Sound
  readonly director: Director

  private timeline: FilmTimeline | null = null
  private unlisten = () => {}
  private state: TimelineState | null = null
  private stop: () => void
  private chipMaterial: THREE.Material
  private seen = new THREE.Vector3()
  private handIndex = 0
  // For stats() only: what the film's own work costs a frame, and the frames that ran long.
  private cost = { frames: 0, sumMs: 0, maxMs: 0 }
  private hitches: { atS: number, frameMs: number, filmMs: number, shot: string, moving: number, chipsLive: number }[] = []
  private clock = 0

  constructor(private studio: StudioRenderer, stone: Stone, kernel: KernelClient, private rig: CameraRig) {
    const dust = new Dust(studio, {
      floorY: FLOOR_Y,
      bankerY: BANKER_TOP_Y,
      bankerHalf: BANKER_HALF,
      compute: studio.backend === 'webgpu',
      shaft: position => studio.atelier.keyLightAt(position as unknown as Parameters<typeof studio.atelier.keyLightAt>[0]) as unknown as DustNode
    })
    this.chipMaterial = createChipMarble(stone.preset)
    this.debris = new Debris(studio, stone, {
      floorY: FLOOR_Y,
      solids: ATELIER_SOLIDS,
      offcutMaterial: stone.offcutMaterial,
      chipMaterial: this.chipMaterial,
      coords: STONE_COORDS,
      dust
    })
    this.tools = new Tools(studio, { bankerY: BANKER_TOP_Y, bankerHalf: BANKER_HALF, block: stone.grid.size })
    this.sound = new Sound({
      place: (x, y, z) => {
        const far = studio.camera.position.distanceTo(this.seen.set(x, y, z))
        this.seen.project(studio.camera)
        return { pan: Math.max(-0.8, Math.min(0.8, this.seen.x * 0.65)), gain: Math.max(0.55, Math.min(1.4, Math.sqrt(studio.homeDistance / Math.max(30, far)))) }
      }
    })
    this.director = new Director(studio, rig, {
      setFocus: (point, aperture) => studio.setFocus(point, aperture),
      raycast: (origin, dir) => kernel.raycast(origin, dir, 'shown'),
      falling: out => this.debris.watch(out),
      fallingCount: () => this.debris.falling,
      room: { minX: WALL_X, minZ: BACK_Z },
      floorY: FLOOR_Y
    })

    this.debris.onFall = event => this.director.fall(event)
    this.debris.onImpact = (event) => {
      this.director.impact(event)
      this.sound.impact(event.cm3, event.speed, event.at.x, event.at.y, event.at.z, event.broke, this.director.timeScale)
    }
    this.tools.onKnock = strength => this.director.knock(strength)
    this.tools.onDust = (x, y, z, dx, dy, dz, amount) => dust.puff(x, y, z, dx, dy, dz, amount, 30)
    this.sound.arm()
    this.stop = studio.onFrame(dt => this.frame(dt))
  }

  /** Takes a timeline as the one the film follows, until it ends or another is bound. */
  bind(timeline: FilmTimeline) {
    this.unbind()
    this.timeline = timeline
    this.state = timeline.state()
    this.tools.reset()
    this.director.begin(true)
    const off = timeline.listen({
      strikes: (events, rate) => this.heard(events, rate),
      look: () => this.tools.look(true),
      lookEnd: () => this.tools.look(false),
      reset: () => {
        this.debris.reset()
        this.tools.reset()
      },
      jump: (log, applied) => {
        this.debris.settle(log, applied)
        this.tools.reset()
      },
      change: (state) => {
        this.state = state
        this.director.status(state.playing, state.done)
      },
      end: () => {
        if (this.timeline === timeline) this.unbind()
      }
    })
    this.unlisten = () => {
      off()
      timeline.timeScale = 1
    }
  }

  unbind() {
    this.unlisten()
    this.unlisten = () => {}
    if (!this.timeline) return
    this.timeline = null
    this.state = null
    this.tools.look(false)
    this.tools.reset()
    this.sound.saw(false)
    this.director.begin(false)
  }

  /** A remesh from the worker, for the debris's idea of where the stone is. */
  chunks(rev: number, chunks: ChunkMesh[]) {
    this.debris.chunks(rev, chunks)
  }

  /** Pieces that came off the shown stone. */
  offcuts(rev: number, offcuts: Offcut[]) {
    this.debris.shed(rev, offcuts)
  }

  /** Strikes sent to the stone with no timeline behind them (hand carving, the burst test). */
  struck(strikes: readonly Strike[]) {
    const events: StrikeEvent[] = []
    for (const strike of strikes) {
      const index = this.handIndex++
      if (strike.kind === 'saw') {
        events.push({ kind: 'saw', tool: 'saw', at: strike.plane.point, dir: strike.plane.normal, size: 0, depth: 0, removedCm3: 0, seed: index, ms: strike.ms, atMs: 0, index })
      } else if (strike.kind === 'cut') {
        const spec = TOOLS[strike.tool]
        const bite = !spec || spec.mode === 'burnish' ? 0 : spec.mode === 'abrade' ? strike.size * strike.size * strike.depth * 0.02 : nominalBiteCm3(spec, strike.size, strike.depth) * 0.6
        events.push({ kind: 'cut', tool: strike.tool, at: strike.at, dir: strike.dir, size: strike.size, depth: strike.depth, removedCm3: bite, seed: strike.seed, ms: strike.ms, atMs: 0, index })
      }
    }
    if (events.length) this.heard(events, 1)
  }

  /** Runs the whole film at `factor` of its speed, on top of the director's own slow motion: a capture aid. */
  slow(factor: number) {
    this.director.bulletTime = Math.max(0.01, factor)
  }

  /** Resolves once nothing that came off the stone is still moving. */
  async settled(frames = 900) {
    for (let i = 0; i < frames && this.debris.airborne > 0; i++) await this.studio.rendered(1)
  }

  /** What each part is doing and its budgets; `film` is the main-thread time the film's own update took per frame since the last call. */
  stats() {
    const { frames, sumMs, maxMs } = this.cost
    const film = { frames, meanMs: Math.round(sumMs / Math.max(1, frames) * 100) / 100, maxMs: Math.round(maxMs * 100) / 100, hitches: this.hitches.slice() }
    this.cost = { frames: 0, sumMs: 0, maxMs: 0 }
    this.hitches = []
    return { debris: this.debris.stats(), director: this.director.state(), tools: this.tools.state(), sound: this.sound.stats(), film }
  }

  dispose() {
    this.stop()
    this.unbind()
    this.debris.dispose()
    this.director.dispose()
    this.tools.dispose()
    this.sound.dispose()
    this.chipMaterial.dispose()
    this.studio.setFocus(null)
  }

  private heard(events: StrikeEvent[], rate: number) {
    this.debris.strikes(events)
    this.tools.strikes(events, rate)
    this.sound.strikes(events)
    this.director.strikes(events, rate)
  }

  private frame(dt: number) {
    const t0 = performance.now()
    this.clock += dt
    const timeline = this.timeline
    const state = this.state
    const next = timeline?.upcoming() ?? null
    this.director.upcoming(next)
    this.tools.upcoming(next)
    this.director.update(dt)
    const scale = this.director.timeScale * this.director.bulletTime
    if (timeline) timeline.timeScale = scale
    // Paused part-way through: everything holds. A timeline that has finished lets what is in the air land.
    const held = state !== null && !state.playing && !state.done && !state.busy && state.applied > 0 && state.applied < state.total
    const film = held ? 0 : dt * scale
    if (next?.strike.kind === 'saw' && !held) this.sound.saw(true, ...next.strike.plane.point)
    else this.sound.saw(false)
    this.sound.setPaused(held)
    this.debris.update(film)
    this.tools.update(film)
    this.sound.update(film)

    const ms = performance.now() - t0
    this.cost.frames++
    this.cost.sumMs += ms
    if (ms > this.cost.maxMs) this.cost.maxMs = ms
    // dt is the frame that has just been shown: long ones are noted with what was going on.
    if (dt > 0.034 && this.hitches.length < 40) {
      const d = this.debris.stats()
      this.hitches.push({ atS: Math.round(this.clock * 10) / 10, frameMs: Math.round(dt * 1000), filmMs: Math.round(ms * 10) / 10, shot: this.director.state().shot, moving: d.moving, chipsLive: d.chipsLive })
    }
  }
}
