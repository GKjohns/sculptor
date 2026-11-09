/**
 * What window.__sculptor runs for verification: a fixed demo carving for screenshots, a burst of
 * strikes for frame timing, and a timed replay. All deterministic; none is part of the product.
 */
import { createRng } from '#shared/sculpt/rng'
import type { Strike, ToolId, Vec3 } from '#shared/sculpt/types'
import type { KernelClient } from './kernel'
import type { StudioRenderer } from './renderer'
import type { ReplayPlayer, ReplaySpeed } from './replay'
import type { Stone } from './stone'

export interface FrameStats {
  frames: number
  meanMs: number
  p95Ms: number
  maxMs: number
  /** Frames that took longer than 60 fps allows, with a millisecond of grace for timer jitter. */
  over16: number
  /** Frames a person would see as a hitch: longer than two 60 fps frames. */
  over33: number
}

function frameStats(times: number[]): FrameStats {
  const sorted = times.slice().sort((a, b) => a - b)
  const round = (ms: number) => Math.round(ms * 100) / 100
  return {
    frames: times.length,
    meanMs: round(times.reduce((sum, ms) => sum + ms, 0) / Math.max(1, times.length)),
    p95Ms: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    over16: times.filter(ms => ms > 17.7).length,
    over33: times.filter(ms => ms > 34).length
  }
}

/** Times every frame from now until stop() is called, e.g. across a stretch of live carving. */
export function frameMeter(studio: StudioRenderer): { stop: () => FrameStats & { slow: { atS: number, ms: number }[] } } {
  const times: number[] = []
  // The frames a person would notice, and when they came (seconds since the meter started).
  const slow: { atS: number, ms: number }[] = []
  let first = 0
  let last = 0
  const unhook = studio.onFrame((_dt, now) => {
    if (last) {
      times.push(now - last)
      if (now - last > 34 && slow.length < 40) slow.push({ atS: Math.round((now - first) / 100) / 10, ms: Math.round(now - last) })
    } else {
      first = now
    }
    last = now
  })
  return {
    stop: () => {
      unhook()
      return { ...frameStats(times), slow }
    }
  }
}

// Point-chisel strikes over a rectangle of the front face, on a jittered lattice.
function roughen(out: Strike[], rng: ReturnType<typeof createRng>, z: number, x0: number, x1: number, y0: number, y1: number) {
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      out.push({
        kind: 'cut',
        tool: 'point',
        at: [x + rng.range(-0.7, 0.7), y + rng.range(-0.7, 0.7), z],
        dir: [rng.range(-0.25, 0.25), rng.range(-0.25, 0.25), -1],
        size: rng.range(2.8, 4),
        depth: rng.range(1.2, 2.2),
        seed: rng.int(1 << 30),
        ms: 200
      })
    }
  }
}

/**
 * One corner sawn off, and three patches down the front face: left rough from the point chisel,
 * worked with the flat chisel, and roughed then rasped smooth. `size` is the block, cm.
 */
export function demoStrikes(size: Vec3): Strike[] {
  const [w, h, d] = size
  const rng = createRng(1508)
  const z = d / 2
  const x0 = -w / 2 + 9
  const x1 = w / 2 - 22
  const strikes: Strike[] = [
    { kind: 'saw', plane: { point: [w / 2 - 11, h - 11, d / 2 - 11], normal: [1, 1, 1] }, ms: 1500 }
  ]

  // Top patch: rough.
  roughen(strikes, rng, z, x0, x1, h - 30, h - 10)

  // Middle patch: rows of the flat chisel driven downward at a shallow angle.
  for (let y = h - 42; y >= h - 62; y -= 2.5) {
    for (let x = x0; x <= x1; x += 3) {
      strikes.push({ kind: 'cut', tool: 'flat', at: [x + rng.range(-0.4, 0.4), y, z], dir: [0, -0.45, -1], size: 5, depth: 1, seed: rng.int(1 << 30), ms: 200 })
    }
  }

  // Bottom patch: roughed the same way, then rasped back and forth until the marks are gone.
  roughen(strikes, rng, z, x0, x1, h - 90, h - 70)
  for (let pass = 0; pass < 14; pass++) {
    for (let y = h - 91; y <= h - 69; y += 3) {
      for (let x = x0 - 1; x <= x1 + 1; x += 3) {
        strikes.push({ kind: 'cut', tool: 'rasp', at: [x + rng.range(-1, 1), y + rng.range(-1, 1), z - 1.5], dir: [0, 0, -1], size: 9, depth: 0.6, seed: 0, ms: 120 })
      }
    }
  }
  strikes.push({ kind: 'detach' })
  return strikes
}

/** Carves the demo and resolves once it is on screen and the sawn corner has dropped out of frame. */
export async function demo(studio: StudioRenderer, kernel: KernelClient, stone: Stone) {
  const { rev } = await kernel.strike(demoStrikes(stone.grid.size))
  await stone.whenShown(rev)
  await studio.rendered(2)
  while (stone.airborne > 0) await studio.rendered(1)
}

/**
 * Fires `n` strikes at the five open faces, `perFrame` each frame, and times every frame from the
 * first strike until the mesh on screen has caught up with the last. `onStrikes` is told each batch.
 */
export async function burst(studio: StudioRenderer, kernel: KernelClient, stone: Stone, n = 200, perFrame = 2, onStrikes: (strikes: Strike[]) => void = () => {}): Promise<FrameStats> {
  const [w, h, d] = stone.grid.size
  const rng = createRng(200)
  const tools: ToolId[] = ['point', 'flat', 'point', 'rasp']
  const one = (k: number): Strike => {
    const face = rng.int(5)
    const u = rng.range(-0.45, 0.45)
    const y = rng.range(0.08, 0.95) * h
    const v = rng.range(-0.45, 0.45)
    const sign = face % 2 === 0 ? 1 : -1
    const at: Vec3 = face < 2 ? [u * w, y, sign * d / 2] : face < 4 ? [sign * w / 2, y, u * d] : [u * w, h, v * d]
    const into: Vec3 = face < 2 ? [0, 0, -sign] : face < 4 ? [-sign, 0, 0] : [0, -1, 0]
    return { kind: 'cut', tool: tools[k % tools.length]!, at, dir: into, size: rng.range(2.5, 6), depth: rng.range(0.6, 2.5), seed: rng.int(1 << 30), ms: 200 }
  }

  const times: number[] = []
  let last = 0
  let sent = 0
  let lastReply = Promise.resolve({ rev: stone.shownRev })
  const allSent = new Promise<void>((resolve) => {
    const stop = studio.onFrame(() => {
      if (sent >= n) {
        stop()
        resolve()
        return
      }
      const batch: Strike[] = []
      for (let i = 0; i < perFrame && sent < n; i++) batch.push(one(sent++))
      // The film hears them as hand carving does: chips, tools and sound are part of what is timed.
      onStrikes(batch)
      lastReply = kernel.strike(batch)
    })
  })
  const stopTiming = studio.onFrame((_dt, now) => {
    if (last) times.push(now - last)
    last = now
  })
  await allSent
  const { rev } = await lastReply
  await stone.whenShown(rev)
  await studio.rendered(2)
  stopTiming()

  const stats = frameStats(times)
  console.log(`[sculptor] burst(${n}) on ${studio.backend}:`, JSON.stringify(stats))
  return stats
}

/**
 * Restarts the loaded replay at `speed` and times every frame until the finished stone is on
 * screen, or for the first `seconds` of it. `strikes` is how many log entries went in meanwhile.
 */
export async function timeReplay(studio: StudioRenderer, player: ReplayPlayer, stone: Stone, speed: ReplaySpeed, seconds = Infinity): Promise<FrameStats & { strikes: number, seconds: number }> {
  player.pause()
  await player.restart()
  await stone.whenShown(0)
  player.setSpeed(speed)
  const times: number[] = []
  let first = 0
  let last = 0
  const stopTiming = studio.onFrame((_dt, now) => {
    if (last) times.push(now - last)
    else first = now
    last = now
  })
  player.play()
  while (!player.state().done && last - first < seconds * 1000) await studio.rendered(1)
  const strikes = player.state().applied
  if (player.state().done) await stone.whenShown(player.rev)
  else player.pause()
  await studio.rendered(2)
  stopTiming()
  const stats = { ...frameStats(times), strikes, seconds: Math.round(last - first) / 1000 }
  console.log(`[sculptor] replay at ${speed} on ${studio.backend}:`, JSON.stringify(stats))
  return stats
}
