/**
 * Film export: a replay rendered offline, frame by frame, into an MP4 in the browser (mediabunny's
 * CanvasSource over the studio's own canvas, H.264 through WebCodecs).
 *
 * The studio's frame loop is stopped and the film is stepped at a fixed dt instead (StudioRenderer
 * .hold/step). Nothing in the studio reads the wall clock, so one step is one frame of film however
 * long it takes to draw, and no frame is dropped or doubled. What the next frame depends on that
 * is answered by the worker is waited for before it is drawn: the batch of strikes it has, that
 * batch's mesh, a shot the director is asking about (a raycast), where the signature goes. So an
 * async answer always lands on the frame after it was asked for, never "whenever it came back".
 * The worker's own batch budget still splits batches by time, which can move a strike by a frame;
 * the film is deterministic to that, not bit for bit.
 *
 * The length is fixed: `seconds` of film, the last `tail` of them the reveal. The replay's speed is
 * steered every frame so that the carving, looks included, ends where the tail begins: a time-lapse
 * of whatever length the commission was. Over the reveal the title plaque is set into the picture
 * (the HUD is not in the canvas, so each frame is copied onto a 2D canvas that the title is drawn
 * on). Sound is not exported.
 */
import { BufferTarget, CanvasSource, canEncodeVideo, Mp4OutputFormat, Output, QUALITY_HIGH } from 'mediabunny'
import type { Cinema } from './cinema'
import type { ReplayPlayer } from './replay'
import type { StudioRenderer } from './renderer'
import type { Stone } from './stone'

export interface FilmOptions {
  /** Film length, s. */
  seconds?: number
  fps?: number
  width?: number
  height?: number
  /** Seconds at the end for the reveal. */
  tail?: number
  /** The plaque set into the reveal: the piece's title, and who carved it from what and when. */
  title?: { title: string, meta: string }
  /** Called after every frame. */
  onProgress?: (frame: number, frames: number) => void
  signal?: AbortSignal
}

export interface FilmResult {
  blob: Blob
  frames: number
  seconds: number
  fps: number
  width: number
  height: number
  bytes: number
  /** Wall time the render took, ms. */
  renderMs: number
  /** The film second the carving ended on, and the replay speeds the steering used. */
  carvedS: number
  speed: { min: number, max: number }
}

export const FILM_LENGTHS = [30, 60, 120]

// Looks are shortened in a time-lapse: at a hundred times speed a full walk round reads as dawdling.
const LOOK_SCALE = 0.6
// Worker time a batch may take, ms: nobody is waiting on the frame.
const BUDGET_MS = 150
const SPEED_MIN = 0.5
const SPEED_MAX = 5000
// A mesh that has not come back after this long is not coming (the worker drew nothing): carry on.
const WAIT_MS = 4000

// The plaque comes up this long into the reveal, over this long.
const TITLE_AT_S = 3.2
const TITLE_IN_S = 1.2

// The title plaque, low and centred, over a soft dark band so it reads on any frame.
function drawTitle(g: CanvasRenderingContext2D, title: { title: string, meta: string }, alpha: number) {
  const { width: w, height: h } = g.canvas
  g.save()
  g.globalAlpha = alpha
  const band = g.createLinearGradient(0, h * 0.68, 0, h)
  band.addColorStop(0, 'rgba(8,7,6,0)')
  band.addColorStop(1, 'rgba(8,7,6,0.72)')
  g.fillStyle = band
  g.fillRect(0, h * 0.68, w, h * 0.32)
  g.textAlign = 'center'
  g.textBaseline = 'alphabetic'
  g.fillStyle = '#f3efe7'
  g.font = `500 ${Math.round(h * 0.062)}px "Cormorant Garamond", "Iowan Old Style", Georgia, serif`
  g.fillText(title.title, w / 2, h * 0.875, w * 0.9)
  g.fillStyle = 'rgba(243,239,231,0.72)'
  g.font = `400 ${Math.round(h * 0.021)}px ui-sans-serif, system-ui, -apple-system, sans-serif`
  g.fillText(title.meta, w / 2, h * 0.92, w * 0.9)
  g.restore()
}

const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<void>(done => setTimeout(done, ms))])

/** Renders `player`'s replay from a fresh block to an MP4. The page's own frame loop is stopped meanwhile and restored after. */
export async function exportFilm(studio: StudioRenderer, stone: Stone, player: ReplayPlayer, cinema: Cinema | null, options: FilmOptions = {}): Promise<FilmResult> {
  const seconds = options.seconds ?? 60
  const fps = options.fps ?? 30
  // Even sizes: H.264 wants them.
  const width = Math.round((options.width ?? 1920) / 2) * 2
  const height = Math.round((options.height ?? 1080) / 2) * 2
  const tail = Math.min(seconds * 0.4, options.tail ?? 9)
  const frames = Math.round(seconds * fps)
  const dt = 1 / fps
  const bitrate = QUALITY_HIGH
  if (typeof VideoEncoder === 'undefined' || !(await canEncodeVideo('avc', { width, height, bitrate }))) {
    throw new Error('This browser cannot encode H.264 video (WebCodecs). Chrome, Edge and Safari can.')
  }

  const timeline = player.timeline
  const budget = timeline.budgetMs
  const t0 = performance.now()
  const muted = cinema?.sound.muted ?? true
  cinema?.sound.setMuted(true)
  player.pause()
  await player.restart()
  timeline.budgetMs = BUDGET_MS
  timeline.lookScale = LOOK_SCALE
  const release = studio.hold(width, height)
  // Each frame is copied here off the studio's canvas, and the title drawn over it.
  const frame = document.createElement('canvas')
  frame.width = width
  frame.height = height
  const g = frame.getContext('2d', { alpha: false })
  if (!g) throw new Error('no 2D canvas to compose the film on')
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() })
  const source = new CanvasSource(frame, { codec: 'avc', bitrate, keyFrameInterval: 2 })
  output.addVideoTrack(source, { frameRate: fps })
  const speed = { min: Infinity, max: 0 }
  let carvedS = seconds
  try {
    await output.start()
    let current = steer(player, seconds - tail, 0, 1)
    player.setSpeed(current)
    player.play()
    for (let i = 0; i < frames; i++) {
      if (options.signal?.aborted) throw new DOMException('The film was cancelled.', 'AbortError')
      const t = i * dt
      const s = player.state()
      if (!s.done) {
        const next = steer(player, seconds - tail, t, current)
        // Only a real change: every setSpeed is a state change the HUD hears.
        if (Math.abs(next - current) > current * 0.03) {
          current = next
          player.setSpeed(current)
        }
        speed.min = Math.min(speed.min, current)
        speed.max = Math.max(speed.max, current)
      } else if (carvedS === seconds) {
        carvedS = t
      }
      // Everything this frame depends on is back from the worker before it is drawn.
      await timeline.pending()
      await within(stone.arrived(timeline.rev), WAIT_MS)
      await cinema?.pending()
      studio.step(dt)
      // Copied off the studio's canvas straight after the draw, before anything else can draw on it.
      g.drawImage(studio.canvas, 0, 0, width, height)
      const shown = (t - (seconds - tail) - TITLE_AT_S) / TITLE_IN_S
      if (options.title && shown > 0) drawTitle(g, options.title, Math.min(1, shown))
      await source.add(t, dt)
      options.onProgress?.(i + 1, frames)
    }
    await output.finalize()
  } catch (e) {
    await output.cancel().catch(() => {})
    throw e
  } finally {
    timeline.budgetMs = budget
    timeline.lookScale = 1
    release()
    cinema?.sound.setMuted(muted)
  }
  const buffer = (output.target as BufferTarget).buffer
  if (!buffer) throw new Error('The film came out empty.')
  const blob = new Blob([buffer], { type: 'video/mp4' })
  return { blob, frames, seconds, fps, width, height, bytes: blob.size, renderMs: Math.round(performance.now() - t0), carvedS: Math.round(carvedS * 10) / 10, speed: { min: Math.round(speed.min * 10) / 10, max: Math.round(speed.max * 10) / 10 } }
}

// The replay speed that ends the carving, looks included, at film second `end`, from film second
// `t` at the speed `now` is playing. Looks take screen time whatever the speed, so they come off
// the time left before the strikes share it out.
function steer(player: ReplayPlayer, end: number, t: number, now: number) {
  const s = player.timeline.state()
  const work = Math.max(0, s.totalMs - s.clockMs) / 1000
  const looks = Math.max(0, s.behindS - work / Math.max(now, 0.01))
  const left = Math.max(0.25, end - t - looks)
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, work / left))
}

/** Hands the browser a file to save. */
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
