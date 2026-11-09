import type { ChunkMesh, GridInfo, GridOptions, Offcut, RayHit, Strike, Vec3 } from './types.ts'

// Messages between the page and the kernel worker (app/workers/kernel.worker.ts).
//
// Every message names the copy of the stone it is about. Today the worker holds one, the
// shown stone: the copy that is meshed and drawn. Sprint 3 adds the true stone beside it,
// which takes each pass's strikes at once and answers looks and measurements, while the
// shown stone gets the same strikes as the timeline's clock reaches them. Nothing here
// changes shape for that: the worker starts answering to 'true' as well.
export type StoneId = 'true' | 'shown'

// rev counts the log entries a stone has applied since init. Two stones at the same rev of
// the same log are the same stone, and a chunk message's rev says how far along the log the
// mesh on screen is.

// Page to worker. Requests carry an id that comes back on the reply.

// Builds the block and starts over. Answered by 'ready', then the whole mesh at rev 0.
export interface InitMessage {
  type: 'init'
  options?: Partial<GridOptions>
}

// Applies log entries in order. Answered by 'struck'; the chunks they made stale follow in
// 'chunks', and anything a saw or an island check took off in 'offcuts'.
export interface StrikesMessage {
  type: 'strikes'
  id: number
  stone: StoneId
  strikes: Strike[]
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

export type ToKernel = InitMessage | StrikesMessage | RaycastMessage | StatsMessage

// Worker to page.

export interface ReadyReply {
  type: 'ready'
  kernelVersion: number
  grid: GridInfo
  stones: StoneId[]
}

// error is set if an entry threw; applied says how many entries before it went in.
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
}

// A request the worker could not serve at all (no such stone, a bad init).
export interface ErrorReply {
  type: 'error'
  id?: number
  message: string
}

export type FromKernel = ReadyReply | StruckReply | ChunksReply | OffcutsReply | RayhitReply | StatsReply | ErrorReply
