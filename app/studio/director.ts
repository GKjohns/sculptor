/**
 * The camera director: decides what the camera is looking at while the sculptor works, and hands
 * the framing to the rig (./camera.ts), which does the moving.
 *
 * Shots
 *   wide     the whole block, drifting slowly round its front. Where the film rests.
 *   medium   the part being worked, from the side the tool is on.
 *   macro    an insert on the strike point, close, with the lens wide open.
 *   saw      the cut line while the saw is in it, set to see the slab go.
 *   fall     a big piece coming away: a cut to where it will land, and slow motion from the
 *            moment it is properly falling until just after it hits.
 *   look     the sculptor has stepped back. The timeline walks the rig round the viewpoints; the
 *            director only holds focus on the stone and takes the camera back afterwards.
 *   reveal   the piece is finished: one slow turn all the way round it, then again.
 *   free     the viewer has the camera. Nothing is chosen until it is handed back.
 *
 * Rules
 *   - A shot is held for at least MIN_SHOT_S. Only a falling slab may cut sooner, and not within
 *     MIN_FALL_CUT_S of the last cut.
 *   - A change of shot is a cut; everything inside a shot (following the work, the drift, a
 *     second slab) is a damped move.
 *   - Before a cut to medium or macro, a ray is cast from the camera's new place to the working
 *     point. If stone is in the way the next candidate angle is tried, and if all are blocked
 *     the film stays wide.
 *   - The macro is only taken while the work is staying put and the hand is not racing.
 *   - The camera stays inside the room, level, and on the open side of the banker.
 *   - Depth of field follows the shot through the injected setFocus.
 *
 * Slow motion is `timeScale`: a number the film's clock is multiplied by, which is all it is. The
 * caller applies it to the timeline's tick and to the debris. The camera itself runs on the
 * studio's frame dt, so it keeps moving at its own pace through a slowed fall, and nothing here
 * reads the wall clock.
 */
import * as THREE from 'three/webgpu'
import type { RayHit, Vec3 } from '#shared/sculpt/types'
import { HOME_TARGET, shotPosition } from './camera'
import type { CameraRig, Shot } from './camera'
import type { FallEvent, ImpactEvent } from './debris'
import type { StudioRenderer } from './renderer'
import type { StrikeEvent, UpcomingStrike } from './timeline'

export type ShotKind = 'idle' | 'wide' | 'medium' | 'macro' | 'saw' | 'fall' | 'look' | 'reveal' | 'free'

export interface DirectorOptions {
  /** Depth of field: keep `point` sharp, aperture 0 (deep) to 1 (a macro lens wide open); null for no focus pull. */
  setFocus?: (point: THREE.Vector3 | null, aperture: number) => void
  /** The first stone a ray meets, asked of the kernel worker. Left out, nothing is ever in the way. */
  raycast?: (origin: Vec3, dir: Vec3) => Promise<RayHit | null>
  /** Where the newest big falling piece is, or null (debris.watch). */
  falling?: (out: THREE.Vector3) => THREE.Vector3 | null
  /** How many big pieces are still moving. */
  fallingCount?: () => number
  /** The room the camera has to stay inside: the wall on the window side and the back wall, cm. */
  room?: { minX: number, minZ: number }
  floorY?: number
}

// No cut sooner than this after the last, s; a falling slab may cut after the shorter time.
const MIN_SHOT_S = 3.5
const MIN_FALL_CUT_S = 1
// A slab that falls where the camera cannot see it, while another is being watched, may cut after this long.
const MIN_CHAIN_CUT_S = 2
// How long each shot is held before the next is considered, s (a range; the dice are seeded).
const HOLD: Record<'wide' | 'medium' | 'macro', [number, number]> = { wide: [6, 9], medium: [6, 10], macro: [3.6, 5] }
// The wide shot: how far round the front it drifts and how fast, and the reveal's turn.
const WIDE_ARC: [number, number] = [-0.5, 1.15]
const WIDE_DRIFT = 0.03
const REVEAL_TURN = 0.11
// Closer shots, as shares of the distance that frames the block, and the macro in cm.
const MEDIUM_REACH = 0.56
const SAW_REACH = 0.86
const FALL_REACH = 1.06
const MACRO_CM = 82
// Where the window's light comes from, as an angle round the block: of two ways to look at a face, the one nearer this sees its lit side.
const LIGHT_AZIMUTH = -0.9
// The macro wants the work to stay put: the working point moving slower than this, cm/s, and the
// hand landing fewer blows than this a second.
const MACRO_STILL = 22
const MACRO_BLOWS = 9
// With no blow for this long the sculptor is thinking, and the film goes back to the wide.
const QUIET_S = 2.2
// A piece this big gets slow motion: to SLOW of full speed from when it is dropping at
// FALLING cm/s until SLOW_AFTER_S past its first hit, and never for longer than SLOW_MAX_S.
const SLOW_CM3 = 3500
const SLOW = 0.3
const FALLING = 170
const SLOW_AFTER_S = 0.45
const SLOW_MAX_S = 2.6
const SLOW_REST_S = 3
// Stone this near the working point along the ray is the working point; nearer the camera, it is in the way.
const CLEAR_CM = 6
const WALL_GAP = 34

const wrap = (a: number) => {
  a %= Math.PI * 2
  return a > Math.PI ? a - Math.PI * 2 : a < -Math.PI ? a + Math.PI * 2 : a
}

export class Director {
  /** What the film's clock should be multiplied by right now: below 1 while a slab falls. */
  timeScale = 1
  /** For capture and tests: every clock the director scales is scaled by this as well. */
  bulletTime = 1

  private kind: ShotKind = 'idle'
  private shot: Shot = { target: HOME_TARGET.clone(), azimuth: 0.56, polar: 1.38, distance: 300 }
  private active = false
  private playing = false
  private finished = false
  private clock = 0
  private shotAge = 0
  private sinceCut = 99
  private hold = 7
  private afterInsert = false
  private dice = 1
  private proposal = 0
  private asking = false

  // The work: where the blows are landing, which way that face looks, how fast it is moving.
  private work = new THREE.Vector3(0, 60, 30)
  private workOut = new THREE.Vector3(0, 0, 1)
  private workGoal = new THREE.Vector3(0, 60, 30)
  private workGoalOut = new THREE.Vector3(0, 0, 1)
  private pendingBlows = 0
  private workSpeed = 0
  private blows = 0
  private sinceBlow = 99
  private hasWork = false
  private side = 1

  private wideAzimuth = 0.56
  private wideWay = 1
  private next: UpcomingStrike | null = null
  private rate = 1

  // A fall being covered.
  private fallLand = new THREE.Vector3()
  private fallFrom = new THREE.Vector3()
  private fallSeen = new THREE.Vector3()
  private fallY = 0
  private fallLeft = 0
  private slow: 'off' | 'armed' | 'on' | 'out' = 'off'
  private slowFor = 0
  private slowLeft = 0
  private sinceSlow = 99

  private focus = new THREE.Vector3()
  private focusAt = new THREE.Vector3(1e9, 0, 0)
  private aperture = -1
  private a = new THREE.Vector3()
  private b = new THREE.Vector3()
  private room: { minX: number, minZ: number }
  private floorY: number

  // The moment the viewer (or a look preset) takes the camera, the director's focus pull is let
  // go, there and then: whoever took it may set a focus of their own straight after.
  private onTaken = () => this.pull(null, 0)

  constructor(private studio: StudioRenderer, private rig: CameraRig, private options: DirectorOptions = {}) {
    this.room = options.room ?? { minX: -250, minZ: -390 }
    this.floorY = options.floorY ?? -84
    studio.controls.addEventListener('start', this.onTaken)
  }

  dispose() {
    this.studio.controls.removeEventListener('start', this.onTaken)
  }

  /** What the camera is on, for the HUD and for tests. */
  state() {
    return {
      shot: this.kind,
      age: Math.round(this.shotAge * 10) / 10,
      sinceCut: Math.round(this.sinceCut * 10) / 10,
      timeScale: Math.round(this.timeScale * 100) / 100,
      slow: this.slow,
      blowsPerS: Math.round(this.blows * 10) / 10,
      workSpeed: Math.round(this.workSpeed)
    }
  }

  // ---------- what it is told ----------

  /** A timeline has the stage (true) or has left it (false). */
  begin(on: boolean) {
    this.active = on
    this.finished = false
    this.hasWork = false
    this.blows = 0
    this.sinceBlow = 99
    this.slow = 'off'
    this.timeScale = 1
    this.next = null
    if (!on) {
      this.kind = 'idle'
      this.rig.aim(null)
      this.pull(null, 0)
    } else {
      this.go('wide', false)
    }
  }

  /** The timeline is playing, and whether everything it will ever hold has been shown. */
  status(playing: boolean, done: boolean) {
    // The reveal is for a piece that was watched to its end, not one jumped to.
    if (done && !this.finished && this.playing && this.hasWork) {
      this.finished = true
      this.go('reveal', false)
    } else if (!done && this.finished) {
      this.finished = false
      this.go('wide', false)
    }
    this.playing = playing
  }

  /** The strike the clock is on its way to, every frame. */
  upcoming(next: UpcomingStrike | null) {
    this.next = next
  }

  strikes(events: StrikeEvent[], rate: number) {
    this.rate = rate
    for (const event of events) {
      if (event.kind !== 'cut') continue
      const [x, y, z] = event.at
      if (!this.hasWork) {
        this.work.set(x, y, z)
        this.hasWork = true
      }
      // Kept as a goal; update() eases toward it so a hand that jumps about does not jerk the camera.
      this.a.set(x, y, z)
      const away = Math.hypot(x, z) || 1
      this.b.set(-event.dir[0] + x / away * 0.6, 0, -event.dir[2] + z / away * 0.6)
      if (this.b.lengthSq() > 0.01) this.workGoalOut.copy(this.b.normalize())
      this.workGoal.copy(this.a)
      this.pendingBlows++
    }
    this.sinceBlow = 0
  }

  /** A big piece has come away. */
  fall(event: FallEvent) {
    if (!this.active || this.finished) return
    const chained = this.kind === 'fall' && this.fallLeft > 0
    this.fallFrom.copy(event.at)
    // A slab off the top slides before it drops, and lands further out.
    this.fallLand.copy(event.at).addScaledVector(event.out, event.at.y > 60 ? 85 : 60)
    this.fallLand.y = this.floorY + 8
    this.fallY = event.at.y
    this.fallSeen.copy(event.at)
    this.fallLeft = 5
    if (event.cm3 >= SLOW_CM3 && this.sinceSlow > SLOW_REST_S && this.rate <= 24 && this.slow === 'off') {
      this.slow = 'armed'
      this.slowFor = 0
    }
    if (!this.rig.steering || this.rig.walking) return
    // From the side it falls to, a little round from square on: the nearer of the two such places.
    const out = Math.atan2(event.out.x, event.out.z)
    const here = this.rig.azimuth
    const azimuth = Math.abs(wrap(out + 1.0 - here)) < Math.abs(wrap(out - 1.0 - here)) ? out + 1.0 : out - 1.0
    if (chained && (Math.abs(wrap(azimuth - here)) < 0.8 || this.sinceCut < MIN_CHAIN_CUT_S)) {
      // Another slab while the last is still being watched, and it can be seen from here: no cut,
      // the frame opens to hold both.
      this.shot.distance = Math.max(this.shot.distance, this.studio.homeDistance * 1.1)
      return
    }
    if (this.sinceCut < MIN_FALL_CUT_S && this.kind !== 'saw') return
    this.shot.target.copy(this.fallFrom).lerp(this.fallLand, 0.4)
    this.shot.azimuth = azimuth
    this.shot.polar = 1.42
    this.shot.distance = this.studio.homeDistance * FALL_REACH
    this.fit(this.shot)
    // Already on the cut line from somewhere near: carry on in the same shot, moving.
    if (this.kind === 'saw' && Math.abs(wrap(this.shot.azimuth - here)) < 0.9) {
      this.kind = 'fall'
      this.shotAge = 0
    } else {
      this.go('fall', true)
    }
  }

  impact(event: ImpactEvent) {
    if (this.slow === 'on' && event.cm3 >= SLOW_CM3 * 0.5) {
      this.slow = 'out'
      this.slowLeft = SLOW_AFTER_S
    }
    // A slab shakes the room; less the further off the camera is.
    const weight = Math.min(1, event.cm3 / 15000)
    this.rig.shake(Math.min(3.5, weight * 3.2 * Math.min(1.5, event.speed / 250) + 0.1))
  }

  /** A knock from a tool: 0 to 1. Only felt close in. */
  knock(strength: number) {
    if (this.kind === 'macro') this.rig.shake(strength * 0.5)
    else if (this.kind === 'medium') this.rig.shake(strength * 0.22)
  }

  // ---------- every frame ----------

  /** `dt` is the studio's frame time, s: the camera's own clock. */
  update(dt: number) {
    this.clock += dt
    this.shotAge += dt
    this.sinceCut += dt
    this.sinceBlow += dt
    this.sinceSlow += dt
    this.follow(dt)
    this.slowMotion(dt)
    if (!this.active) return

    if (this.rig.walking) {
      if (this.kind !== 'look') this.take('look')
      this.pull(HOME_TARGET, 0.14)
      return
    }
    if (!this.rig.steering) {
      if (this.kind !== 'free') this.take('free')
      return
    }
    if (this.kind === 'look' || this.kind === 'free') this.go(this.finished ? 'reveal' : 'wide', false)

    if (this.kind === 'fall') {
      this.fallLeft -= dt
      const settled = (this.options.fallingCount?.() ?? 0) === 0
      if (this.fallLeft <= 0 || (settled && this.shotAge > 2.2 && this.slow === 'off')) {
        this.fallLeft = 0
        if (this.sinceCut >= MIN_SHOT_S) this.go('wide', true)
      } else {
        const at = this.options.falling?.(this.a)
        if (at) this.fallSeen.copy(at)
        // Mostly the piece, led a little toward where it is going.
        this.b.copy(this.fallSeen).lerp(this.fallLand, 0.3)
        this.b.y = Math.max(this.floorY + 22, this.b.y - 6)
        this.shot.target.lerp(this.b, 1 - Math.exp(-dt / 0.4))
      }
      this.rig.aim(this.shot, 0.7)
      this.pull(this.fallSeen, 0.42)
      return
    }

    // A saw cut coming up is worth being in place for, if it will be on screen long enough to see.
    const next = this.next
    if (next && next.strike.kind === 'saw' && this.kind !== 'saw' && this.sinceCut >= MIN_SHOT_S && !this.finished) {
      const onScreen = next.inS / Math.max(0.05, 1 - next.progress)
      if (onScreen > 0.9 && next.progress < 0.6) this.sawShot(next.strike.plane.point, next.strike.plane.normal)
    }

    switch (this.kind) {
      case 'wide': {
        this.wideAzimuth += this.wideWay * WIDE_DRIFT * dt
        if (this.wideAzimuth > WIDE_ARC[1]) this.wideWay = -1
        if (this.wideAzimuth < WIDE_ARC[0]) this.wideWay = 1
        this.shot.target.copy(HOME_TARGET)
        this.shot.azimuth = this.wideAzimuth
        this.shot.polar = 1.38
        this.shot.distance = this.studio.homeDistance
        this.rig.aim(this.shot, 1.4)
        this.pull(HOME_TARGET, 0.12)
        if (this.shotAge > this.hold && this.working()) this.propose('medium')
        break
      }
      case 'medium': {
        this.shot.target.lerp(this.work, 1 - Math.exp(-dt / 0.9))
        this.shot.distance = this.studio.homeDistance * MEDIUM_REACH
        this.rig.aim(this.shot, 1.2)
        this.pull(this.work, 0.36)
        if (!this.working() && this.sinceCut >= MIN_SHOT_S) this.go('wide', true)
        // Wide, medium, the insert, medium again, and back out to the wide.
        else if (this.shotAge > this.hold) this.propose(!this.afterInsert && this.macroOk() ? 'macro' : 'wide')
        else if (this.strayed(0.9) && this.sinceCut >= MIN_SHOT_S) this.propose('medium')
        break
      }
      case 'macro': {
        // Aimed a little off the stone, up the chisel, so the mallet's blow is in the frame.
        this.b.copy(this.work).addScaledVector(this.workOut, 9)
        this.shot.target.lerp(this.b, 1 - Math.exp(-dt / 0.45))
        this.rig.aim(this.shot, 0.7)
        this.pull(this.work, 0.9)
        if ((!this.working() || this.shotAge > this.hold || this.strayed(1.2) || this.workSpeed > MACRO_STILL * 2.5) && this.sinceCut >= MIN_SHOT_S) this.propose(this.working() ? 'medium' : 'wide')
        break
      }
      case 'saw': {
        this.rig.aim(this.shot, 1)
        this.pull(this.shot.target, 0.3)
        // The saw has gone and nothing fell.
        if ((!next || next.strike.kind !== 'saw') && this.shotAge > 1.5 && this.sinceCut >= MIN_SHOT_S) this.go('wide', true)
        break
      }
      case 'reveal': {
        this.shot.azimuth += REVEAL_TURN * dt
        this.shot.target.set(0, 46, 0)
        this.shot.polar = 1.36 + Math.sin(this.shotAge * 0.09) * 0.07
        this.shot.distance = this.studio.homeDistance * (0.9 - Math.min(0.1, this.shotAge * 0.004))
        this.fit(this.shot)
        this.rig.aim(this.shot, 1.6)
        this.pull(this.shot.target, 0.3)
        break
      }
      default:
        this.go('wide', false)
    }
  }

  // ---------- inside ----------

  // The working point and the face it is on, eased; how fast it is moving; how fast the blows come.
  private follow(dt: number) {
    if (this.pendingBlows || this.hasWork) {
      const k = 1 - Math.exp(-dt / 0.45)
      const before = this.a.copy(this.work)
      this.work.lerp(this.workGoal, k)
      this.workOut.lerp(this.workGoalOut, k)
      if (this.workOut.lengthSq() > 1e-4) this.workOut.normalize()
      const speed = before.distanceTo(this.work) / Math.max(dt, 1e-4)
      this.workSpeed += (speed - this.workSpeed) * (1 - Math.exp(-dt / 0.6))
    }
    this.blows += (this.pendingBlows / Math.max(dt, 1e-4) - this.blows) * (1 - Math.exp(-dt / 0.8))
    this.pendingBlows = 0
  }

  private slowMotion(dt: number) {
    let goal = 1
    if (this.slow === 'armed') {
      const at = this.options.falling?.(this.a)
      this.slowFor += dt
      if (at) {
        const dropping = (this.fallY - at.y) / Math.max(dt * this.timeScale * this.bulletTime, 1e-4)
        this.fallY = at.y
        if (dropping > FALLING) {
          this.slow = 'on'
          this.slowFor = 0
        }
      }
      // It never got going (it came to rest on the banker, or was cleared away).
      if (this.slow === 'armed' && (this.slowFor > 4 || (!at && this.slowFor > 0.5))) this.slow = 'off'
    } else if (this.slow === 'on') {
      goal = SLOW
      this.slowFor += dt
      if (this.slowFor > SLOW_MAX_S) this.slow = 'off'
    } else if (this.slow === 'out') {
      goal = SLOW
      this.slowLeft -= dt
      if (this.slowLeft <= 0) this.slow = 'off'
    }
    if (goal < 1) this.sinceSlow = 0
    // Into slow motion fast, out of it gently.
    this.timeScale += (goal - this.timeScale) * (1 - Math.exp(-dt / (goal < this.timeScale ? 0.07 : 0.35)))
    if (Math.abs(this.timeScale - goal) < 0.004) this.timeScale = goal
  }

  private working() {
    return this.hasWork && this.sinceBlow < QUIET_S && this.playing
  }

  private macroOk() {
    return this.workSpeed < MACRO_STILL && this.blows < MACRO_BLOWS && this.rate <= 12
  }

  // Whether the work has moved round the block from where this shot was set to see it.
  private strayed(by: number) {
    const facing = Math.atan2(this.workOut.x, this.workOut.z)
    return Math.abs(wrap(facing - this.shot.azimuth)) > by + 0.5
  }

  private roll() {
    // A small seeded sequence: the same film from the same log.
    this.dice = (this.dice * 16807) % 2147483647
    return this.dice / 2147483647
  }

  // Names the shot the camera is on without moving it (a look or the viewer has it).
  private take(kind: ShotKind) {
    this.kind = kind
    this.shotAge = 0
    this.proposal++
  }

  // Changes shot. With `cut` the camera jumps; without, it eases there from where it is.
  private go(kind: 'wide' | 'reveal' | 'fall' | 'saw' | 'medium' | 'macro', cut: boolean) {
    this.proposal++
    const was = this.kind
    this.kind = kind
    this.shotAge = 0
    if (kind === 'wide') {
      // Picked up near where the camera is, so an eased return does not swing right round.
      const here = this.rig.azimuth
      this.wideAzimuth = cut ? Math.max(WIDE_ARC[0], Math.min(WIDE_ARC[1], Math.atan2(this.workOut.x, this.workOut.z) * 0.5 + 0.3)) : Math.max(WIDE_ARC[0], Math.min(WIDE_ARC[1], here))
      this.shot.target.copy(HOME_TARGET)
      this.shot.azimuth = this.wideAzimuth
      this.shot.polar = 1.38
      this.shot.distance = this.studio.homeDistance
      this.hold = HOLD.wide[0] + this.roll() * (HOLD.wide[1] - HOLD.wide[0])
    } else if (kind === 'reveal') {
      this.shot.azimuth = this.rig.azimuth
      this.shot.target.set(0, 46, 0)
    } else if (kind === 'medium' || kind === 'macro') {
      this.hold = HOLD[kind][0] + this.roll() * (HOLD[kind][1] - HOLD[kind][0])
    }
    // A medium that follows the insert goes back out to the wide; any other may go in.
    this.afterInsert = kind === 'medium' && was === 'macro'
    if (cut && this.rig.steering && !this.rig.walking) {
      this.rig.cut(this.shot)
      this.sinceCut = 0
    } else {
      this.rig.aim(this.shot, 1.4)
    }
  }

  private sawShot(point: Vec3, normal: Vec3) {
    const level = Math.hypot(normal[0], normal[2])
    // The way the slab will go: along the normal, or for a cut across the top, the way debris slides it.
    const out = level > 0.3 ? Math.atan2(normal[0], normal[2]) : Math.atan2(-0.45, 0.89)
    const here = this.rig.azimuth
    const azimuth = Math.abs(wrap(out + 0.95 - here)) < Math.abs(wrap(out - 0.95 - here)) ? out + 0.95 : out - 0.95
    this.shot.target.set(point[0] * 0.6, Math.max(30, Math.min(88, point[1])), point[2] * 0.6)
    this.shot.azimuth = azimuth
    this.shot.polar = 1.3
    this.shot.distance = this.studio.homeDistance * SAW_REACH
    this.fit(this.shot)
    this.go('saw', true)
  }

  // Asks for a medium or a macro: candidate angles are tried against the stone, off the frame,
  // and the first with a clear line to the work is cut to. 'wide' needs no asking.
  private propose(kind: 'wide' | 'medium' | 'macro') {
    if (this.asking || this.sinceCut < MIN_SHOT_S) return
    if (kind === 'wide') {
      this.go('wide', true)
      return
    }
    const id = ++this.proposal
    const facing = Math.atan2(this.workOut.x, this.workOut.z)
    // Three-quarter on to the face, from the side the light is on and then the other; then square on; then steeper.
    const first = Math.abs(wrap(facing + 0.5 - LIGHT_AZIMUTH)) < Math.abs(wrap(facing - 0.5 - LIGHT_AZIMUTH)) ? 1 : -1
    const swing = kind === 'macro' ? 0.62 : 0.5
    const polar = kind === 'macro' ? 1.2 + this.roll() * 0.22 : 1.24
    const tries: [number, number][] = [[facing + first * swing, polar], [facing - first * swing, polar], [facing, polar - 0.12], [facing + first * swing, polar - 0.4]]
    const distance = kind === 'macro' ? MACRO_CM : this.studio.homeDistance * MEDIUM_REACH
    const target = this.work.clone()
    this.asking = true
    void (async () => {
      let found: Shot | null = null
      for (const [azimuth, tilt] of tries) {
        const candidate: Shot = { target, azimuth, polar: tilt, distance }
        this.fit(candidate)
        if (await this.clear(candidate, target)) {
          found = candidate
          break
        }
        if (id !== this.proposal) break
      }
      this.asking = false
      // Overtaken while the worker was answering: a slab fell, a look began, the viewer took the camera.
      if (id !== this.proposal || !this.rig.steering || this.rig.walking) return
      if (!found) {
        // The work is hidden from everywhere tried. Stay wide, and wait a while before asking again.
        if (this.kind === 'wide') this.shotAge = this.hold - 3
        else this.go('wide', true)
        return
      }
      this.shot = found
      this.go(kind, true)
    })()
  }

  // Whether the working point can be seen from where a shot puts the camera.
  private async clear(shot: Shot, point: THREE.Vector3) {
    const raycast = this.options.raycast
    if (!raycast) return true
    const from = shotPosition(shot, new THREE.Vector3())
    const to = point.clone().sub(from)
    const far = to.length()
    to.divideScalar(far || 1)
    try {
      const hit = await raycast([from.x, from.y, from.z], [to.x, to.y, to.z])
      return !hit || hit.distance >= far - CLEAR_CM
    } catch {
      return false
    }
  }

  // Pulls a shot's distance in until the camera is inside the room and above the floor.
  private fit(shot: Shot) {
    const sin = Math.sin(shot.polar)
    const dx = sin * Math.sin(shot.azimuth)
    const dz = sin * Math.cos(shot.azimuth)
    const dy = Math.cos(shot.polar)
    let most = shot.distance
    if (dx < 0) most = Math.min(most, (shot.target.x - (this.room.minX + WALL_GAP)) / -dx)
    if (dz < 0) most = Math.min(most, (shot.target.z - (this.room.minZ + WALL_GAP)) / -dz)
    if (dy < 0) most = Math.min(most, (shot.target.y - (this.floorY + 12)) / -dy)
    shot.distance = Math.max(45, most)
  }

  // Focus, sent on only when it has moved.
  private pull(point: THREE.Vector3 | null, aperture: number) {
    const set = this.options.setFocus
    if (!set) return
    if (!point) {
      if (this.aperture !== -1) set(null, 0)
      this.aperture = -1
      return
    }
    this.focus.copy(point)
    if (this.focus.distanceToSquared(this.focusAt) < 0.25 && Math.abs(aperture - this.aperture) < 0.01) return
    this.focusAt.copy(this.focus)
    this.aperture = aperture
    set(this.focus, aperture)
  }
}
