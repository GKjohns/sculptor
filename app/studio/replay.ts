/**
 * Plays a saved strike log onto the shown stone. A replay is the timeline with its queue filled
 * before the first tick and its pacing fixed: the clock runs at exactly the speed asked for
 * (see ./timeline for the clock, the batches and the backpressure).
 */
import type { ReplayPass } from '#shared/agent/replay'
import type { StrikeLog } from '#shared/agent/studio'
import { KERNEL_VERSION } from '#shared/sculpt/version'
import type { CameraRig } from './camera'
import type { KernelClient } from './kernel'
import type { Stone } from './stone'
import { Timeline } from './timeline'
import type { Speed } from './timeline'

/** Virtual seconds per second of tick time, or 'max': as fast as the worker takes strikes while still drawing them. */
export type ReplaySpeed = Speed
export const REPLAY_SPEEDS: ReplaySpeed[] = [1, 8, 30, 120, 'max']

export interface ReplayState {
  playing: boolean
  speed: ReplaySpeed
  /** Log entries the stone has taken, of `total`. */
  applied: number
  total: number
  /** 0-based index of the pass being worked, of `passes`; -1 if the pass record does not fit the log. */
  pass: number
  passes: number
  /** Every entry is in. */
  done: boolean
  /** Rebuilding the block or skipping to the end: the controls wait. */
  busy: boolean
  error: string
}

/** Why this log cannot be played here, or null if it can. A log only replays on the kernel that wrote it. */
export function replayBlocker(kernel: number): string | null {
  if (kernel === KERNEL_VERSION) return null
  return `This run was carved on kernel ${kernel}. The studio is on kernel ${KERNEL_VERSION}, where the same strikes would give a different stone, so it will not be replayed.`
}

export class ReplayPlayer {
  /** Called whenever the state changes (at most once per batch, not once per frame). */
  onChange: (state: ReplayState) => void = () => {}

  readonly timeline: Timeline<ReplayPass>
  // False when the pass record does not add up to the log (another run's, or one cut short).
  private fits: boolean

  constructor(kernel: KernelClient, stone: Stone, log: StrikeLog, passes: ReplayPass[], speed: ReplaySpeed = 30, camera: CameraRig | null = null) {
    const blocker = replayBlocker(log.kernel)
    if (blocker) throw new Error(blocker)
    this.timeline = new Timeline<ReplayPass>(kernel, stone, { speed, camera, rebuild: () => kernel.init(log.grid) })
    this.fits = passes.reduce((n, p) => n + p.strikes, 0) === log.strikes.length
    if (this.fits) {
      let at = 0
      for (const pass of passes) {
        this.timeline.push(log.strikes.slice(at, at + pass.strikes), pass)
        at += pass.strikes
      }
    } else {
      this.timeline.push(log.strikes)
    }
    this.timeline.onChange = () => this.onChange(this.state())
  }

  /** The shown stone's rev after the last batch the worker confirmed. */
  get rev() {
    return this.timeline.rev
  }

  get total() {
    return this.timeline.total
  }

  /** The virtual clock, ms, and where it ends. */
  get clockMs() {
    return this.timeline.clockMs
  }

  get totalMs() {
    return this.timeline.totalMs
  }

  state(): ReplayState {
    const s = this.timeline.state()
    return {
      playing: s.playing,
      speed: s.speed,
      applied: s.applied,
      total: s.total,
      pass: this.fits ? Math.max(0, s.pass) : -1,
      passes: this.fits ? s.passes : 0,
      done: s.applied >= s.total,
      busy: s.busy,
      error: s.error
    }
  }

  play() {
    const s = this.timeline.state()
    if (s.playing || s.error) return
    if (s.applied >= s.total) {
      // Play on a finished piece means watch it again.
      void this.restart().then(() => this.timeline.play())
      return
    }
    this.timeline.play()
  }

  pause() {
    this.timeline.pause()
  }

  setSpeed(speed: ReplaySpeed) {
    this.timeline.setSpeed(speed)
  }

  /** Advances the clock by dt seconds at the current speed and hands the worker what has come due. */
  tick(dt: number) {
    this.timeline.tick(dt)
    // The last entry in means the replay is over.
    const s = this.timeline.state()
    if (s.playing && s.applied >= s.total && !s.busy) this.timeline.pause()
  }

  /** A fresh block and the clock back at zero. Resolves once the worker has rebuilt it; playing or paused carries over. */
  restart() {
    return this.timeline.restart()
  }

  /**
   * Applies everything left as fast as the worker can, without drawing the steps or dropping the
   * offcuts, then shows the result. Resolves once the finished stone's mesh has reached the scene.
   */
  end() {
    return this.timeline.seek()
  }

  /** The stone as it stood when pass `index` (0-based) had just been finished. */
  toPass(index: number) {
    return this.timeline.seekPass(index)
  }

  dispose() {
    this.timeline.dispose()
    this.onChange = () => {}
  }
}
