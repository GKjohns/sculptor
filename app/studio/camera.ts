/**
 * The camera's own moves, as far as Sprint 3 needs them: a gentle default framing, and the walk
 * round the stone when a look is staged. The shot director (cuts, inserts, focus) is Sprint 4.
 *
 * The rig steers the same camera OrbitControls does, as an azimuth, a height angle and a distance
 * about the controls' target, eased toward a goal every frame. Dragging the canvas takes over at
 * once; a few idle seconds later the rig eases back from wherever the camera was left. Time comes
 * in through the studio's frame dt only, so a fixed-step render moves the camera the same way.
 */
import * as THREE from 'three/webgpu'
import { VIEWS } from '#shared/sculpt/views'
import type { ViewId } from '#shared/sculpt/views'
import type { StudioRenderer } from './renderer'

export type CameraMode = 'auto' | 'free'

interface Pose {
  /** Round the vertical axis, radians; 0 is straight in front (+Z), positive toward +X. */
  azimuth: number
  /** Down from straight overhead, radians. */
  polar: number
  /** As a multiple of the distance that frames the whole block. */
  reach: number
}

// The three-quarter front view the studio opens on.
const HOME: Pose = { azimuth: 0.56, polar: 1.38, reach: 1 }
// The default framing drifts this far either side of home, once over this many seconds.
const SWAY = 0.2
const SWAY_PERIOD_S = 48
// Seconds without a touch before the rig takes the camera back.
const IDLE_S = 4
// How quickly a pose is eased to: the default framing, and a walk between viewpoints.
const DRIFT_S = 1.1
// Straight overhead is where an orbit turns inside out.
const POLAR_MIN = 0.16
const STEP_BACK = 1.12
const CLOSE_IN = 0.7

function poseOf(view: string, close: boolean): Pose {
  const def = VIEWS[view as ViewId]
  if (!def) return HOME
  const [x, y, z] = def.look
  // The camera stands opposite the way it looks. An axis view is taken a little from above,
  // which reads better on a real camera than the dead-level view the sculptor is sent.
  const polar = Math.max(POLAR_MIN, Math.acos(Math.max(-1, Math.min(1, -y))) - (y === 0 ? 0.14 : 0))
  return { azimuth: y < -0.99 ? 0 : Math.atan2(-x, -z), polar, reach: close ? CLOSE_IN : STEP_BACK }
}

export class CameraRig {
  /** free: the rig never moves the camera. */
  mode: CameraMode = 'auto'
  /** Let the default framing drift. Off, the rig holds the camera still at home. */
  sway = false

  private goal: Pose = HOME
  private stops: Pose[] = []
  private stopSeconds = 0
  private stopLeft = 0
  private ease = DRIFT_S
  private clock = 0
  // Seconds until the rig may steer again; Infinity while a pointer is down.
  private hands = 0
  private offset = new THREE.Vector3()
  private ball = new THREE.Spherical()
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

  /** Visits the viewpoints in turn, `seconds` on the way to each, and stays on the last until release(). */
  walk(views: string[], seconds: number, close = false) {
    this.stops = views.map(v => poseOf(v, close))
    this.stopSeconds = Math.max(0.05, seconds)
    this.stopLeft = 0
    // Most of the way there by the time the next stop is due.
    this.ease = Math.max(0.08, seconds / 3.2)
  }

  /** Back to the default framing. */
  release() {
    this.stops = []
    this.ease = DRIFT_S
  }

  dispose() {
    this.stop()
    this.studio.controls.removeEventListener('start', this.onStart)
    this.studio.controls.removeEventListener('end', this.onEnd)
  }

  private frame(dt: number) {
    this.clock += dt
    if (this.stops.length) {
      this.stopLeft -= dt
      if (this.stopLeft <= 0) {
        this.goal = this.stops.length > 1 ? this.stops.shift()! : this.stops[0]!
        this.stopLeft = this.stopSeconds
      }
    } else {
      const drift = this.sway ? Math.sin(this.clock * 2 * Math.PI / SWAY_PERIOD_S) * SWAY : 0
      this.goal = { azimuth: HOME.azimuth + drift, polar: HOME.polar, reach: HOME.reach }
    }
    if (this.hands > 0) {
      if (this.hands !== Infinity) this.hands -= dt
      return
    }
    if (this.mode === 'free') return

    const { camera, controls } = this.studio
    this.offset.copy(camera.position).sub(controls.target)
    this.ball.setFromVector3(this.offset)
    const k = 1 - Math.exp(-dt / this.ease)
    // The short way round.
    let turn = (this.goal.azimuth - this.ball.theta) % (2 * Math.PI)
    if (turn > Math.PI) turn -= 2 * Math.PI
    if (turn < -Math.PI) turn += 2 * Math.PI
    this.ball.theta += turn * k
    this.ball.phi += (this.goal.polar - this.ball.phi) * k
    this.ball.radius += (this.goal.reach * this.studio.homeDistance - this.ball.radius) * k
    this.ball.makeSafe()
    camera.position.copy(controls.target).add(this.offset.setFromSpherical(this.ball))
  }
}
