/**
 * The kernel in a worker. Messages are typed in #shared/sculpt/protocol.
 *
 * There are two copies of the stone. The true stone is the sculptor's: the Studio runs here
 * against it, so a pass's strikes land on it the instant the pass is issued and every look and
 * measurement reads it. It is never meshed. The shown stone gets the same strikes when the
 * timeline's clock reaches them; its chunks are remeshed and posted back as transferables.
 * A worker holds whichever of the two 'init' asks for. The page starts this script twice, once
 * for each, so the seconds a rough-out takes to work out never freeze the hand on screen.
 * The shown stone is a DisplayStone, which can drop a loose piece on screen ahead of the log's
 * own island check without the log's stone knowing (see #shared/sculpt/display).
 *
 * Images are encoded and decoded here too (OffscreenCanvas), so a look never costs the page a frame.
 *
 * No Nuxt auto-imports in here: a worker is bundled on its own, so everything is imported by name.
 */
import { analyzeReference } from '#shared/agent/reference'
import type { ReferenceAnalysis } from '#shared/agent/reference'
import { createStudio } from '#shared/agent/studio'
import type { KernelStudio } from '#shared/agent/studio'
import { createDisplayStone } from '#shared/sculpt/display'
import type { DisplayStone } from '#shared/sculpt/display'
import { cloneGrid, createGrid, gridInfo, hashGrid, stoneMassKg, stoneVolumeCm3, takeDirty } from '#shared/sculpt/grid'
import { meshChunk } from '#shared/sculpt/mesher'
import type { Image } from '#shared/sculpt/observer'
import type { FromKernel, ReferenceMessage, RunMessage, StoneId, ToKernel } from '#shared/sculpt/protocol'
import { raycast } from '#shared/sculpt/raycast'
import type { Grid, GridOptions, Offcut, Strike } from '#shared/sculpt/types'
import { KERNEL_VERSION } from '#shared/sculpt/version'

interface Held {
  stone: DisplayStone
  /** Log entries applied since init. */
  rev: number
  /** Whether this copy is drawn: only a meshed stone posts chunks and offcuts. */
  meshed: boolean
  /** Strikes have landed since the last remesh. */
  stale: boolean
  /** Pieces that came off since the last remesh; they go out behind the chunks that show the cut. */
  offcuts: Offcut[]
}

// The reference sheet is cut to this on its long side before anything reads it, as in the bench.
const SHEET_MAX_SIDE = 1024

const stones = new Map<StoneId, Held>()
let options: Partial<GridOptions> | undefined
let flushQueued = false
// Every entry the true stone has taken, in order. Once there is a Studio this is its own list.
let trueLog: Strike[] = []
let studio: KernelStudio | null = null
let reference: ReferenceAnalysis | null = null
const settles = { checks: 0, ms: 0, maxMs: 0, found: 0 }

function send(message: FromKernel, transfer: Transferable[] = []) {
  postMessage(message, { transfer })
}

function hold(stone: StoneId, id?: number): Held | null {
  const held = stones.get(stone)
  if (!held) send({ type: 'error', id, message: `the kernel holds no '${stone}' stone` })
  return held ?? null
}

function keep(stone: StoneId, grid: Grid, rev = 0) {
  stones.set(stone, { stone: createDisplayStone(grid), rev, meshed: stone === 'shown', stale: true, offcuts: [] })
}

// Remeshing waits for the end of the current task, so strikes that arrive together (one pass,
// or everything a busy frame sent) cost one remesh of each chunk they touched, not one per strike.
function queueFlush() {
  if (flushQueued) return
  flushQueued = true
  setTimeout(flush, 0)
}

function flush() {
  flushQueued = false
  for (const [stone, held] of stones) {
    if (!held.meshed || !held.stale) continue
    held.stale = false
    const drawn = held.stone.drawn()
    const chunks = takeDirty(drawn).map(id => meshChunk(drawn, id))
    const buffers: Transferable[] = []
    for (const c of chunks) buffers.push(c.positions.buffer, c.normals.buffer, c.finish.buffer, c.indices.buffer)
    // Sent even when nothing changed, so the page can follow rev.
    send({ type: 'chunks', stone, rev: held.rev, chunks }, buffers)
    if (held.offcuts.length) {
      const offcuts = held.offcuts
      held.offcuts = []
      const pieces: Transferable[] = []
      for (const o of offcuts) pieces.push(o.positions.buffer, o.normals.buffer, o.indices.buffer)
      send({ type: 'offcuts', stone, rev: held.rev, offcuts }, pieces)
    }
  }
}

// PNG, to match what the study's sculptors were shown.
async function encodePng(image: Image): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2D canvas in the worker to encode a look with')
  ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47

// The Studio over the true stone as it stands. Made on the first call, so the reference sheet
// and any saved log played onto the true stone are already in place.
function theStudio(held: Held): KernelStudio {
  if (studio) return studio
  const grid = held.stone.grid
  studio = createStudio({
    grid,
    encodeImage: encodePng,
    reference,
    resume: { kernel: KERNEL_VERSION, grid: { width: grid.size[0], height: grid.size[1], depth: grid.size[2], voxel: grid.voxel, chunk: grid.chunk }, strikes: trueLog }
  })
  trueLog = studio.strikes
  return studio
}

async function run(msg: RunMessage) {
  const held = hold('true', msg.id)
  if (!held) return
  try {
    const result = await theStudio(held).run(msg.call)
    held.rev = trueLog.length
    const images = result.images ?? []
    send({ type: 'ran', id: msg.id, rev: held.rev, result }, images.map(i => i.buffer))
  } catch (e) {
    // A refusal: the stone is as it was, and the sculptor is told why.
    send({ type: 'ran', id: msg.id, rev: held.rev, error: e instanceof Error ? e.message : String(e) })
  }
}

async function takeReference(msg: ReferenceMessage) {
  // A Studio made before this would not know the sheet.
  studio = null
  reference = null
  if (!msg.image) {
    send({ type: 'referenced', id: msg.id, ok: false, reasons: [], png: null, width: 0, height: 0 })
    return
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([new Uint8Array(msg.image)]))
  } catch {
    send({ type: 'referenced', id: msg.id, ok: false, reasons: ['the image could not be decoded'], png: null, width: 0, height: 0 })
    return
  }
  const k = Math.max(1, Math.max(bitmap.width, bitmap.height) / SHEET_MAX_SIDE)
  const width = Math.max(1, Math.round(bitmap.width / k))
  const height = Math.max(1, Math.round(bitmap.height / k))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('no 2D canvas in the worker to read the reference sheet with')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const pixels = ctx.getImageData(0, 0, width, height)
  // The file that is kept is the one whose pixels were traced, so a resume traces the same ones.
  const png = k === 1 && isPng(msg.image) ? new Uint8Array(msg.image) : new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
  const analysis = analyzeReference({ width, height, data: pixels.data })
  reference = analysis
  send({ type: 'referenced', id: msg.id, ok: analysis.ok, reasons: analysis.reasons.map(r => r.detail), png, width, height }, [png.buffer])
}

function handle(msg: ToKernel) {
  switch (msg.type) {
    case 'init': {
      if (msg.only) {
        const fresh = createGrid(options)
        keep(msg.only, fresh)
        if (msg.only === 'true') {
          trueLog = []
          studio = null
        }
        send({ type: 'ready', kernelVersion: KERNEL_VERSION, grid: gridInfo(fresh), stones: [...stones.keys()] })
        queueFlush()
        return
      }
      stones.clear()
      options = msg.options
      trueLog = []
      studio = null
      reference = null
      settles.checks = settles.ms = settles.maxMs = settles.found = 0
      const grid = createGrid(options)
      const which = msg.stones ?? ['shown', 'true']
      if (which.includes('shown')) keep('shown', grid)
      if (which.includes('true')) keep('true', which.includes('shown') ? cloneGrid(grid) : grid)
      send({ type: 'ready', kernelVersion: KERNEL_VERSION, grid: gridInfo(grid), stones: [...stones.keys()] })
      queueFlush()
      return
    }
    case 'strikes': {
      const held = hold(msg.stone, msg.id)
      if (!held) return
      let applied = 0
      let removedCm3 = 0
      let error: string | undefined
      const shown = held.meshed && !msg.silent
      // Skipping ahead draws nothing until it is done, so there is nothing to keep a copy for.
      if (msg.silent) held.stone.rejoin()
      // The budget only decides where a batch is split, never what a strike does.
      const until = msg.budgetMs === undefined ? Infinity : performance.now() + msg.budgetMs
      try {
        for (const strike of msg.strikes) {
          const result = held.stone.apply(strike)
          removedCm3 += result.removedCm3
          if (shown) held.offcuts.push(...result.offcuts)
          applied++
          if (performance.now() >= until) break
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
      if (msg.stone === 'true') {
        // Played straight onto the sculptor's stone (a saved log). A Studio made before this
        // would not know these entries, so the next call makes a new one.
        for (let i = 0; i < applied; i++) trueLog.push(msg.strikes[i]!)
        studio = null
      }
      held.rev += applied
      if (shown && msg.settle) {
        const t0 = performance.now()
        const loose = held.stone.settle()
        const ms = performance.now() - t0
        settles.checks++
        settles.ms += ms
        if (ms > settles.maxMs) settles.maxMs = ms
        if (loose.length) settles.found++
        held.offcuts.push(...loose)
      }
      send({ type: 'struck', id: msg.id, stone: msg.stone, rev: held.rev, applied, removedCm3, error })
      if (shown) {
        held.stale = true
        queueFlush()
      }
      return
    }
    case 'reference': {
      void takeReference(msg).catch(e => send({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) }))
      return
    }
    case 'run': {
      void run(msg)
      return
    }
    case 'raycast': {
      const held = hold(msg.stone, msg.id)
      if (!held) return
      send({ type: 'rayhit', id: msg.id, stone: msg.stone, hit: raycast(held.stone.grid, msg.origin, msg.dir, msg.maxDistance) })
      return
    }
    case 'stats': {
      const held = hold(msg.stone, msg.id)
      if (!held) return
      const grid = held.stone.grid
      send({
        type: 'stats',
        id: msg.id,
        stone: msg.stone,
        rev: held.rev,
        volumeCm3: stoneVolumeCm3(grid),
        massKg: stoneMassKg(grid),
        hash: msg.hash ? hashGrid(grid) : undefined,
        ...(held.meshed ? { settles: { ...settles, split: held.stone.split() } } : {})
      })
    }
  }
}

addEventListener('message', (event: MessageEvent<ToKernel>) => {
  try {
    handle(event.data)
  } catch (e) {
    const id = 'id' in event.data ? event.data.id : undefined
    send({ type: 'error', id, message: e instanceof Error ? e.message : String(e) })
  }
})
