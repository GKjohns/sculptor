// What playing a saved run back needs besides the kernel: the run as the study routes list it,
// when each log entry lands on the virtual clock, and which pass an entry belongs to.
// The strike log itself is StrikeLog (./studio.ts); the pass record is PassRecord[] (./types.ts).
import type { Strike } from '../sculpt/types.ts'

// One finished run under .data/study/, as GET /api/study lists it.
export interface ReplayRun {
  id: string
  round: string
  subject: string
  model: string
  tools: string
  ref: boolean
  turns: number
  costUsd: number
  strikes: number
  passes: number
  // How the commission ended: 'finish' when the sculptor called it done, otherwise the cap it hit.
  ended: string
  title: string | null
  statement: string | null
  judge: { pick: string, correct: boolean } | null
  // The kernel that wrote the log, and the grid hash of the finished stone. A replay on the
  // same kernel ends on the same hash.
  kernel: number
  hash: string
  finishedAt: string
}

// The part of a pass record that playback reads.
export interface ReplayPass {
  n: number
  tool: string
  why: string
  strikes: number
}

// The virtual time a log entry takes, ms. A cut, a saw cut and a charcoal line take the time
// the hand gave them; a form or an island check takes none.
export function strikeMs(strike: Strike): number {
  return strike.kind === 'cut' || strike.kind === 'saw' || strike.kind === 'sketch' ? strike.ms : 0
}

// Virtual time, ms, at which each log entry lands: the end of its own duration. An entry that
// takes no time lands with the entry before it.
export function strikeEnds(strikes: Strike[]): Float64Array {
  const ends = new Float64Array(strikes.length)
  let t = 0
  for (let i = 0; i < strikes.length; i++) {
    t += strikeMs(strikes[i]!)
    ends[i] = t
  }
  return ends
}

// The log index each pass starts at. A pass's `strikes` counts every entry the hand expanded it
// into, forms and island checks included, so the counts must add up to the log's length; null
// when they do not (a pass record from another run, or one cut short).
export function passStarts(passes: { strikes: number }[], total: number): number[] | null {
  const starts: number[] = []
  let at = 0
  for (const pass of passes) {
    starts.push(at)
    at += pass.strikes
  }
  return at === total ? starts : null
}

// The pass log entry `index` belongs to: the last one that starts at or before it. -1 before
// the first pass or when there are none.
export function passAt(starts: number[], index: number): number {
  let lo = 0
  let hi = starts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid]! <= index) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}
