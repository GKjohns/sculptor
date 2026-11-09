/**
 * The camera's hands: it moves the one camera OrbitControls also moves, as an azimuth, a height
 * angle and a distance about a target point, toward whatever framing it has been given.
 *
 * Who gives the framing, in order: a staged look (walk(), called by the timeline: the camera
 * visits the viewpoints the sculptor asked for until release()), then the director's shot (aim()
 * and cut(), see ./director.ts), then, with neither, the three-quarter view the studio opens on.
 * Moves are damped, with no jump in speed at either end; cut() is the one way to jump. A blow can
 * shake it (shake()). The horizon is always level: the camera only ever orbits and looks at its target.
 *
 * Dragging the canvas takes over at once; a few idle seconds later the rig eases back from
 * wherever the camera was left, unless `mode` is 'free'. Time comes in through the studio's frame
 * dt only, so a fixed-step render moves the camera the same way.
 */
import * as THREE from 'three/webgpu'
import { VIEWS } from '#shared/sculpt/views'
import type { ViewId } from '#shared/sculpt/views'
import type { StudioRenderer } from './renderer'

export type CameraMode = 'auto' | 'free'

/** A framing: where the camera looks and where it stands about that point. */
export interface Shot {
  target: THREE.Vector3
  /** Round the vertical axis, radians; 0 is straight in front (+Z), positive toward +X. */
  azimuth: number
  /** Down from straight overhead, radians. */
  polar: number
  /** From the target, cm. */
  distance: number
}

interface Pose {
  azimuth: number
  polar: number
  /** As a multiple of the distance that frames the whole block. */
  reach: number
  /** A macro shot: the point to turn about instead of the block's middle, and the window it frames, cm. */
  macro?: Macro
}

/** The part of the stone a close-up framed: its centre in block cm and the width of the window. */
export interface Macro { target: [number, number, number], span: number }

// A macro shot stands this many window widths from its target, and never closer than this
// share of the distance that frames the whole block.
const MACRO_REACH = 1.5
const MACRO_MIN = 0.18

/** The middle of the default block, which the opening view and every staged look turn about. */
export const HOME_TARGET = new THREE.Vector3(0, 50, 0)
// The three-quarter front view the studio opens on.
const HOME: Pose = { azimuth: 0.56, polar: 1.38, reach: 1 }
// With `sway` on and no director, the opening view drifts this far either side, once over this many seconds.
const SWAY = 0.2
const SWAY_PERIOD_S = 48
// Seconds without a touch before the rig takes the camera back.
const IDLE_S = 4
// How long a move takes to settle: the default, and the first move after the viewer lets go.
const DRIFT_S = 1.1
const HANDBACK_S = 1.6
// Straight overhead is where an orbit turns inside out.
const POLAR_MIN = 0.16
const STEP_BACK = 1.12
const CLOSE_IN = 0.7
// A shake dies away over about this long, and moves the camera this share of its distance at full strength.
const SHAKE_S = 0.16
const SHAKE_REACH = 0.0026

function poseOf(view: string, close: boolean): Pose {
  const def = VIEWS[view as ViewId]
  if (!def) return HOME
  const [x, y, z] = def.look
  // The camera stands opposite the way it looks. An axis view is taken a little from above,
  // which reads better on a real camera than the dead-level view the sculptor is sent.
  const polar = Math.max(POLAR_MIN, Math.acos(Math.max(-1, Math.min(1, -y))) - (y === 0 ? 0.14 : 0))
  return { azimuth: y < -0.99 ? 0 : Math.atan2(-x, -z), polar, reach: close ? CLOSE_IN : STEP_BACK }
}

/** Where a shot puts the camera. */
export function shotPosition(shot: Shot, out = new THREE.Vector3()) {
  const level = Math.sin(shot.polar) * shot.distance
  return out.set(shot.target.x + level * Math.sin(shot.azimuth), shot.target.y + Math.cos(shot.polar) * shot.distance, shot.target.z + level * Math.cos(shot.azimuth))
}

// Critically damped approach: no jump in speed when the goal moves, none when it is reached.
function damp(current: number, goal: number, speed: Float32Array, i: number, time: number, dt: number) {
  const omega = 2 / Math.max(0.0001, time)
  const x = omega * dt
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const change = current - goal
  const temp = (speed[i]! + omega * change) * dt
  speed[i] = (speed[i]! - omega * temp) * decay
  return goal + (change + temp) * decay
}

export class CameraRig {
  /** free: the rig never moves the camera. */
  mode: CameraMode = 'auto'
  /** Let the opening view drift when nothing else has the camera. */
  sway = false

  private stops: Pose[] = []
  private stopSeconds = 0
  private stopLeft = 0
  private walkPose: Pose = HOME
  private walkEase = DRIFT_S
  // The director's framing, how long a move to it takes, and whether to jump there.
  private wanted: Shot | null = null
  private wantedEase = DRIFT_S
  private jump = false
  private handback = 0
  private clock = 0
  // Seconds until the rig may steer again; Infinity while a pointer is down.
  private hands = 0
  private speeds = new Float32Array(6)
  private goalTarget = new THREE.Vector3()
  private offset = new THREE.Vector3()
  private ball = new THREE.Spherical()
  private tremor = new THREE.Vector3()
  private tremble = 0
  private stop: () => void
  private onStart = () => {
    this.hands = Infinity
  }

  private onEnd = () => {
    this.hands = IDLE_S
  }

  constructor(private studio: StudioRenderer) {
    studio.controls.addEventListener('start', this.onStart)
    studio.controls.addEventListener('end', this.onEnd)
    this.stop = studio.onFrame(dt => this.frame(dt))
  }

  /** Whether the viewer has the camera right now. */
  get held() {
    return this.hands > 0
  }

  /** Whether a staged look is being walked. */
  get walking() {
    return this.stops.length > 0
  }

  /** Whether the rig is the one moving the camera: nobody is dragging and the mode is not free. */
  get steering() {
    return this.hands <= 0 && this.mode === 'auto'
  }

  /** The camera's angle round the block right now, radians. */
  get azimuth() {
    const { camera, controls } = this.studio
    return Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z)
  }

  /** Visits the viewpoints in turn, `seconds` on the way to each, and stays on the last until release(). A macro shot turns about the close-up's own centre. */
  walk(views: string[], seconds: number, close = false, macro?: Macro) {
    this.stops = views.map(v => macro ? { ...poseOf(v, close), macro } : poseOf(v, close))
    this.stopSeconds = Math.max(0.05, seconds)
    this.stopLeft = 0
    // Settled by the time the next stop is due.
    this.walkEase = Math.max(0.1, seconds * 0.7)
  }

  /** The staged look is over: back to the director's shot, or the opening view. */
  release() {
    this.stops = []
  }

  /** The framing to move to, over about `ease` seconds; null for the opening view. Call it as often as the framing changes. */
  aim(shot: Shot | null, ease = DRIFT_S) {
    this.wanted = shot
    this.wantedEase = ease
  }

  /** Jumps to a framing on the next frame, if the rig has the camera. */
  cut(shot: Shot) {
    this.wanted = shot
    this.jump = true
  }

  /** A knock: 1 is a heavy mallet blow seen close, several a slab landing. */
  shake(strength: number) {
    this.tremble = Math.min(4, Math.max(this.tremble, strength))
  }

  dispose() {
    this.stop()
    this.studio.controls.removeEventListener('start', this.onStart)
    this.studio.controls.removeEventListener('end', this.onEnd)
  }

  private frame(dt: number) {
    this.clock += dt
    const { camera, controls } = this.studio
    // Last frame's shake is not part of where the camera is.
    camera.position.sub(this.tremor)
    this.tremor.set(0, 0, 0)

    let azimuth: number
    let polar: number
    let distance: number
    let ease: number
    if (this.stops.length) {
      this.stopLeft -= dt
      if (this.stopLeft <= 0) {
        this.walkPose = this.stops.length > 1 ? this.stops.shift()! : this.stops[0]!
        this.stopLeft = this.stopSeconds
      }
      const macro = this.walkPose.macro
      if (macro) this.goalTarget.set(macro.target[0], macro.target[1], macro.target[2])
      else this.goalTarget.copy(HOME_TARGET)
      azimuth = this.walkPose.azimuth
      polar = this.walkPose.polar
      distance = macro ? Math.max(MACRO_MIN * this.studio.homeDistance, MACRO_REACH * macro.span) : this.walkPose.reach * this.studio.homeDistance
      ease = this.walkEase
      this.jump = false
    } else if (this.wanted) {
      this.goalTarget.copy(this.wanted.target)
      azimuth = this.wanted.azimuth
      polar = this.wanted.polar
      distance = this.wanted.distance
      ease = this.wantedEase
    } else {
      this.goalTarget.copy(HOME_TARGET)
      azimuth = HOME.azimuth + (this.sway ? Math.sin(this.clock * 2 * Math.PI / SWAY_PERIOD_S) * SWAY : 0)
      polar = HOME.polar
      distance = HOME.reach * this.studio.homeDistance
      ease = DRIFT_S
      this.jump = false
    }

    if (this.hands > 0 || this.mode === 'free') {
      if (this.hands > 0 && this.hands !== Infinity) this.hands -= dt
      this.speeds.fill(0)
      this.handback = HANDBACK_S
      this.jump = false
      return
    }
    // The first move after the viewer lets go is a slow one, from wherever they left the camera.
    if (this.handback > 0) {
      ease = Math.max(ease, HANDBACK_S)
      this.handback -= dt
    }

    this.offset.copy(camera.position).sub(controls.target)
    this.ball.setFromVector3(this.offset)
    polar = Math.max(POLAR_MIN, Math.min(Math.PI - POLAR_MIN, polar))
    if (this.jump) {
      this.jump = false
      this.speeds.fill(0)
      controls.target.copy(this.goalTarget)
      this.ball.set(distance, polar, azimuth)
    } else {
      const v = this.speeds
      // The short way round.
      let turn = (azimuth - this.ball.theta) % (2 * Math.PI)
      if (turn > Math.PI) turn -= 2 * Math.PI
      if (turn < -Math.PI) turn += 2 * Math.PI
      this.ball.theta = damp(this.ball.theta, this.ball.theta + turn, v, 0, ease, dt)
      this.ball.phi = damp(this.ball.phi, polar, v, 1, ease, dt)
      this.ball.radius = damp(this.ball.radius, distance, v, 2, ease, dt)
      controls.target.set(
        damp(controls.target.x, this.goalTarget.x, v, 3, ease, dt),
        damp(controls.target.y, this.goalTarget.y, v, 4, ease, dt),
        damp(controls.target.z, this.goalTarget.z, v, 5, ease, dt)
      )
    }
    this.ball.makeSafe()
    camera.position.copy(controls.target).add(this.offset.setFromSpherical(this.ball))

    if (this.tremble > 0.01) {
      const reach = this.tremble * this.ball.radius * SHAKE_REACH
      const t = this.clock
      this.tremor.set(Math.sin(t * 83) + Math.sin(t * 127 + 1), Math.sin(t * 97 + 2) + Math.sin(t * 149), Math.sin(t * 71 + 4)).multiplyScalar(reach * 0.5)
      camera.position.add(this.tremor)
      this.tremble *= Math.exp(-dt / SHAKE_S)
    } else {
      this.tremble = 0
    }
  }
}
