/**
 * The kernel in a worker: it owns the stone, applies strikes, remeshes the chunks they touched
 * and posts the geometry back as transferables. Messages are typed in #shared/sculpt/protocol.
 *
 * Stones are held by name. Today there is one, the shown stone. Sprint 3 adds the true stone
 * (unmeshed, ahead of the clock) by setting a second entry in init; every handler below already
 * goes through hold().
 *
 * No Nuxt auto-imports in here: a worker is bundled on its own, so everything is imported by name.
 */
import { createGrid, gridInfo, hashGrid, stoneMassKg, stoneVolumeCm3, takeDirty } from '#shared/sculpt/grid'
import { meshChunk } from '#shared/sculpt/mesher'
import type { FromKernel, StoneId, ToKernel } from '#shared/sculpt/protocol'
import { raycast } from '#shared/sculpt/raycast'
import { applyStrike } from '#shared/sculpt/strike'
import type { Grid, Offcut } from '#shared/sculpt/types'
import { KERNEL_VERSION } from '#shared/sculpt/version'

interface Held {
  grid: Grid
  /** Log entries applied since init. */
  rev: number
  /** Whether this copy is drawn: only a meshed stone posts chunks and offcuts. */
  meshed: boolean
  /** Strikes have landed since the last remesh. */
  stale: boolean
  /** Pieces that came off since the last remesh; they go out behind the chunks that show the cut. */
  offcuts: Offcut[]
}

const stones = new Map<StoneId, Held>()
let flushQueued = false

function send(message: FromKernel, transfer: Transferable[] = []) {
  postMessage(message, { transfer })
}

function hold(stone: StoneId, id?: number): Held | null {
  const held = stones.get(stone)
  if (!held) send({ type: 'error', id, message: `the kernel holds no '${stone}' stone` })
  return held ?? null
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
    const chunks = takeDirty(held.grid).map(id => meshChunk(held.grid, id))
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

function handle(msg: ToKernel) {
  switch (msg.type) {
    case 'init': {
      stones.clear()
      const grid = createGrid(msg.options)
      stones.set('shown', { grid, rev: 0, meshed: true, stale: true, offcuts: [] })
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
      try {
        for (const strike of msg.strikes) {
          const result = applyStrike(held.grid, strike)
          removedCm3 += result.removedCm3
          if (held.meshed) held.offcuts.push(...result.offcuts)
          applied++
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
      held.rev += applied
      send({ type: 'struck', id: msg.id, stone: msg.stone, rev: held.rev, applied, removedCm3, error })
      if (held.meshed) {
        held.stale = true
        queueFlush()
      }
      return
    }
    case 'raycast': {
      const held = hold(msg.stone, msg.id)
      if (!held) return
      send({ type: 'rayhit', id: msg.id, stone: msg.stone, hit: raycast(held.grid, msg.origin, msg.dir, msg.maxDistance) })
      return
    }
    case 'stats': {
      const held = hold(msg.stone, msg.id)
      if (!held) return
      send({
        type: 'stats',
        id: msg.id,
        stone: msg.stone,
        rev: held.rev,
        volumeCm3: stoneVolumeCm3(held.grid),
        massKg: stoneMassKg(held.grid),
        hash: msg.hash ? hashGrid(held.grid) : undefined
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
