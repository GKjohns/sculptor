import type { StudioResult, ToolCall } from '../agent/types.ts'
import type { ChunkMesh, GridInfo, GridOptions, Offcut, RayHit, Strike, Vec3 } from './types.ts'

// Messages between the page and the kernel worker (app/workers/kernel.worker.ts).
//
// Every message names the copy of the stone it is about. There are two. The true stone takes
// each pass's strikes the instant the pass is issued: the Studio (shared/agent/studio.ts) runs
// in the worker against it, so the hand, looks and measurements all read it. The shown stone
// gets the same strikes as the timeline's clock reaches them, and is the only one that is
// meshed and drawn. One worker can hold both; the page gives each its own (see `stones` on
// 'init'), so a rough-out being worked out on the true stone never holds up the one on screen.
export type StoneId = 'true' | 'shown'

// rev counts the log entries a stone has applied since init. Two stones at the same rev of
// the same log are the same stone, and a chunk message's rev says how far along the log the
// mesh on screen is.

// Page to worker. Requests carry an id that comes back on the reply.

// Builds the block and starts over: both stones fresh, no Studio, no reference sheet.
// Answered by 'ready', then the shown stone's whole mesh at rev 0.
// `stones` says which copies this worker is to hold; both if left out.
// With `only`, just that stone is rebuilt (to play the log onto the shown stone again while
// the true stone stays where the sculptor left it), on the block the worker already has.
export interface InitMessage {
  type: 'init'
  options?: Partial<GridOptions>
  stones?: StoneId[]
  only?: StoneId
}

// Applies log entries in order. Answered by 'struck'; the chunks they made stale follow in
// 'chunks', and anything a saw or an island check took off in 'offcuts'.
export interface StrikesMessage {
  type: 'strikes'
  id: number
  stone: StoneId
  strikes: Strike[]
  // Stop after the entry that uses up this many milliseconds of work. 'struck' says how many
  // went in (at least one); the sender offers the rest again. Keeps a costly stretch of a log
  // (saw cuts, island checks) from holding the next remesh back.
  budgetMs?: number
  // Apply without showing it: no remesh, and whatever comes off is not posted as an offcut.
  // The chunks stay stale until the next batch sent without this. For skipping ahead in a log.
  silent?: boolean
  // Shown stone only: after the batch, look for stone that these strikes cut free and drop it
  // now, on screen, without waiting for the log's own island check at the end of the pass.
  // The stone the log describes is not touched by this (see shared/sculpt/display.ts).
  settle?: boolean
}

export interface RaycastMessage {
  type: 'raycast'
  id: number
  stone: StoneId
  origin: Vec3
  dir: Vec3
  maxDistance?: number
}

// hash walks both channels of the grid (a few milliseconds), so it is asked for by name.
export interface StatsMessage {
  type: 'stats'
  id: number
  stone: StoneId
  hash: boolean
}

// The commission's reference sheet as the image file the server sent, or null for none.
// The worker decodes it, cuts it to 1024 px on its long side if it is larger, traces the
// outlines and keeps the analysis for the Studio. Answered by 'referenced'.
export interface ReferenceMessage {
  type: 'reference'
  id: number
  image: Uint8Array | null
}

// One validated tool call for the Studio, run against the true stone. Answered by 'ran'.
export interface RunMessage {
  type: 'run'
  id: number
  call: ToolCall
}

// A copy of a stone kept in the worker under `key` (save), or the stone put back to one (load),
// so scrubbing back through a long log starts from the nearest copy instead of a fresh block.
// Answered by 'struck' with nothing applied and the rev the stone now stands at. A full init
// forgets every copy; the worker keeps the last SNAPSHOTS_KEPT and a load of one it has let go is an error.
export interface SnapshotMessage {
  type: 'snapshot'
  id: number
  stone: StoneId
  key: string
  action: 'save' | 'load'
}

export const SNAPSHOTS_KEPT = 10

export type ToKernel = InitMessage | StrikesMessage | RaycastMessage | StatsMessage | ReferenceMessage | RunMessage | SnapshotMessage

// Worker to page.

export interface ReadyReply {
  type: 'ready'
  kernelVersion: number
  grid: GridInfo
  stones: StoneId[]
}

// error is set if an entry threw; applied says how many entries before it went in. Without an
// error, applied is short of the batch only when budgetMs ran out.
export interface StruckReply {
  type: 'struck'
  id: number
  stone: StoneId
  rev: number
  applied: number
  removedCm3: number
  error?: string
}

// Every chunk whose mesh changed since the last such message, complete as of rev: applying
// all of them leaves a seamless mesh. A chunk with no triangles has no surface any more.
// The typed arrays arrive as transferables.
export interface ChunksReply {
  type: 'chunks'
  stone: StoneId
  rev: number
  chunks: ChunkMesh[]
}

// Sent right behind the 'chunks' message that shows the cut. Transferables too.
export interface OffcutsReply {
  type: 'offcuts'
  stone: StoneId
  rev: number
  offcuts: Offcut[]
}

export interface RayhitReply {
  type: 'rayhit'
  id: number
  stone: StoneId
  hit: RayHit | null
}

export interface StatsReply {
  type: 'stats'
  id: number
  stone: StoneId
  rev: number
  volumeCm3: number
  massKg: number
  hash?: string
  // The shown stone's early island checks so far: how many ran, what they cost the worker,
  // how many found a loose piece, and whether a copy is being drawn right now.
  settles?: { checks: number, ms: number, maxMs: number, found: number, split: boolean }
}

// ok: the outlines could be traced. If not, `reasons` says why in the words the image model's
// brief can be rewritten from, and the sheet is kept for the sculptor's eyes only.
// png is the sheet as it was analysed and as the sculptor is to be shown it; null if the
// image could not be decoded (then nothing is kept).
export interface ReferencedReply {
  type: 'referenced'
  id: number
  ok: boolean
  reasons: string[]
  png: Uint8Array | null
  width: number
  height: number
}

// The Studio's answer. A refused call (it throws) comes back as `error` with the stone
// untouched. rev is the true stone's, after the call.
export interface RanReply {
  type: 'ran'
  id: number
  rev: number
  result?: StudioResult
  error?: string
}

// A request the worker could not serve at all (no such stone, a bad init).
export interface ErrorReply {
  type: 'error'
  id?: number
  message: string
}

export type FromKernel = ReadyReply | StruckReply | ChunksReply | OffcutsReply | RayhitReply | StatsReply | ReferencedReply | RanReply | ErrorReply
