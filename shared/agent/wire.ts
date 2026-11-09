// The contract between the browser and the server routes: what each route takes and returns,
// and the NDJSON events /api/brain streams. Types and a small codec only, so the browser can
// import it without pulling in the AI SDK. Bodies are validated by ./wireSchemas.ts.

import type { ReferenceRetry } from './brainRequest.ts'
import type { ModelKey, TextModelKey } from './pricing.ts'
import type { StrikeLog } from './studio.ts'
import type { Block, BrainTurn, Message, PassRecord, ReferenceMode, RunConfig, RunEnd, RunState, ToolCall, ToolSetId, Usage } from './types.ts'
import type { Strike } from '../sculpt/types.ts'

// Request bodies are refused above these sizes with a 413.
// A context holds every look since the last rebuild as base64: a 1,200 px contact sheet is
// about 0.5 MB as PNG (0.7 MB encoded), and a model that looks on all 20 turns between
// rebuilds, plus the rebuild's own look and the reference sheet, comes to about 16 MB.
// 24 MB leaves room over that and stays under the 32 MB a provider accepts in one request.
export const BRAIN_BODY_LIMIT = 24 * 1024 * 1024
// One turn's strikes (a full rough-out is about 1,500, some 300 kB) or one reference sheet.
export const SESSION_BODY_LIMIT = 8 * 1024 * 1024
export const REFERENCE_BODY_LIMIT = 64 * 1024

// ---------- GET /api/health ----------

export interface ModelInfo {
  key: ModelKey
  // The gateway id, e.g. 'anthropic/claude-opus-5.5'.
  id: string
  label: string
  default: boolean
  // USD per 1M tokens.
  price: { input: number, output: number, cacheRead?: number, cacheWrite?: number }
}

export interface HealthResponse {
  ok: true
  // Whether the server has a gateway key. Without one, commissions cannot run.
  gateway: boolean
  kernel: number
  // The sculptors for the picker, in order.
  models: ModelInfo[]
  defaultModel: ModelKey
  // What one reference sheet costs to draw, before the brief's tokens.
  image: { id: string, label: string, perImageUsd: number }
  limits: { brainBodyBytes: number, sessionBodyBytes: number }
}

// ---------- POST /api/brain ----------

export interface BrainRequest {
  // A short key from the price table.
  model: TextModelKey
  instructions: string
  // The whole context for this turn. Assistant messages go back exactly as they came.
  messages: Message[]
  // What the tool schemas are built from; the same values the loop built its own from.
  toolSet: ToolSetId
  reference: ReferenceMode
  block?: Block
  stone?: string
  // native: the provider's tool calls. text: the JSON-lines fallback, for a loop running with
  // RunConfig.toolResults 'text'; no tool schemas are sent and the calls are read from the reply.
  toolResults: RunConfig['toolResults']
  // The loop's turn number. Used for the ids of JSON-lines calls and the cache check.
  turn?: number
}

export type BrainErrorCode
  // The server has no AI_GATEWAY_API_KEY.
  = | 'no_key'
  // The body failed validation; `message` says where.
    | 'bad_request'
    | 'too_large'
  // The upstream call was cancelled because the client went away or the server's own limit passed.
    | 'aborted'
    | 'timeout'
  // The gateway or the provider refused or failed; `status` is theirs when they gave one.
    | 'upstream'

export interface BrainDone extends BrainTurn {
  t: 'done'
  // costUsd is the larger of these two: our price table's figure and the gateway's own.
  pricedUsd: number
  reportedUsd: number | null
  finishReason: string
  ms: number
}

export interface BrainError {
  t: 'error'
  code: BrainErrorCode
  // Short and plain enough to show in a toast.
  message: string
  status?: number
  // Whether asking again could work (a rate limit, a dropped connection) or cannot (no key, a bad body).
  retryable: boolean
}

// One line of the response. `start` is first; then text, reasoning and call events in the
// order the model produced them; then exactly one `done` or `error`, which is always last.
export type BrainEvent
  = | { t: 'start', model: string }
    | { t: 'text', delta: string }
  // The provider's reasoning summary, where it gives one. For show; never sent back.
    | { t: 'reasoning', delta: string }
  // A tool call the moment it is complete. `done.calls` repeats them all and is the list to act on.
    | { t: 'call', call: ToolCall }
    | BrainDone
    | BrainError

export function encodeEvent(event: unknown): string {
  return `${JSON.stringify(event)}\n`
}

// Feed it text as it arrives; it hands back each complete line, parsed. A whole line that is
// not JSON throws, since a stream that has lost its framing cannot be trusted further.
export function ndjsonDecoder<T = unknown>(): { push(chunk: string): T[], end(): T[] } {
  let rest = ''
  const take = (lines: string[]): T[] => lines.map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l) as T)
  return {
    push(chunk) {
      const lines = (rest + chunk).split('\n')
      rest = lines.pop() ?? ''
      return take(lines)
    },
    end() {
      const last = rest
      rest = ''
      try {
        return take([last])
      } catch {
        // a last line cut off mid-way is not an event
        return []
      }
    }
  }
}

const isTerminal = (e: BrainEvent): e is BrainDone | BrainError => e.t === 'done' || e.t === 'error'

function brokenStream(message: string, status?: number): BrainError {
  return { t: 'error', code: 'upstream', message, ...(status ? { status } : {}), retryable: status === undefined || status >= 500 || status === 429 }
}

// The events of one /api/brain response, whatever its status: a refused request carries a
// single error event too. Always ends with exactly one `done` or `error`, made up here if the
// stream stopped short. A fetch that is aborted or loses the network still throws.
export async function* readBrainEvents(res: { status: number, body: ReadableStream<Uint8Array> | null }): AsyncGenerator<BrainEvent> {
  if (!res.body) {
    yield brokenStream(`the server sent no body (HTTP ${res.status})`, res.status)
    return
  }
  const decoder = ndjsonDecoder<Record<string, unknown>>()
  const utf8 = new TextDecoder()
  const reader = res.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      let lines: Record<string, unknown>[]
      try {
        lines = done ? decoder.end() : decoder.push(utf8.decode(value, { stream: true }))
      } catch {
        yield brokenStream(`the server sent something that is not an event (HTTP ${res.status})`, res.status)
        return
      }
      for (const line of lines) {
        // An error page from the server itself (a 413 or a crash) is one JSON object with no `t`.
        if (typeof line.t !== 'string') {
          const message = typeof line.message === 'string' && line.message ? line.message : typeof line.statusMessage === 'string' ? line.statusMessage : `HTTP ${res.status}`
          yield { t: 'error', code: res.status === 413 ? 'too_large' : 'upstream', message, status: res.status, retryable: res.status >= 500 }
          return
        }
        const event = line as unknown as BrainEvent
        yield event
        if (isTerminal(event)) return
      }
      if (done) break
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  yield res.status >= 400 ? brokenStream(`the server answered HTTP ${res.status}`, res.status) : brokenStream('the reply stopped before it was finished')
}

// ---------- POST /api/reference ----------

export interface ReferenceRequest {
  // What the person asked for.
  commission: string
  // The sculptor, who writes the brief.
  model: TextModelKey
  // Set when a sheet was drawn and failed the client's checks: the brief is written again, plainer.
  retry?: ReferenceRetry
}

export interface ReferenceCost {
  what: 'reference_brief' | 'reference_image'
  // A gateway id.
  model: string
  usage: Usage
  usd: number
}

export interface ReferenceResponse {
  // The sheet, long side at most 1024 px. Null if the image model returned no image.
  pngBase64: string | null
  // 'image/png' unless the server had no converter for what the image model sent, in which
  // case this is the format the bytes are really in and the browser must decode it itself.
  mediaType: string
  width: number | null
  height: number | null
  brief: string
  // Both calls together, and each on its own.
  costUsd: number
  usage: Usage
  costs: ReferenceCost[]
  // Set, with pngBase64 null, when a call failed after money may have been spent.
  error?: string
}

// ---------- /api/sessions ----------

export type SessionStatus = 'running' | 'done'

// POST /api/sessions
export interface SessionCreate {
  commission: string
  model: TextModelKey
  // Whether a reference sheet is being made for it.
  ref: boolean
  // The loop's config, saved whole so a resume runs under the same rules.
  run: RunConfig
  grid: StrikeLog['grid']
  // The browser's KERNEL_VERSION. A tab on another kernel than the server is refused.
  kernel: number
  // Anything else the studio wants back on a resume (speed, camera mode). Saved as given.
  settings?: Record<string, unknown>
}

// run.json. Field names follow the study's run.json (bench/sculpt.ts RunFile) where both have
// the thing, so one replay path can read either.
export interface SessionFile {
  id: string
  status: SessionStatus
  startedAt: string
  updatedAt: string
  finishedAt: string | null
  // The kernel that wrote the strike log. It only replays on that kernel.
  kernel: number
  grid: StrikeLog['grid']
  config: {
    commission: string
    model: string
    modelId: string
    tools: ToolSetId
    ref: boolean
    maxTurns: number
    maxUsd: number
    voxel: number
    run: RunConfig
    settings: Record<string, unknown>
  }
  reference: null | {
    outlines: boolean
    brief: string
    // 'reference.png' once the sheet is saved; null if none could be made.
    file: string | null
    costUsd: number
    usage?: Usage
    error?: string
  }
  // Null until the commission ends.
  result: null | {
    ended: RunEnd
    finish: { title: string, statement: string } | null
    error?: string
    turns: number
    passes: number
    strikes: number
  }
  usage: Usage
  cost: { totalUsd: number, sculptorUsd: number, referenceUsd: number }
  // The loop's state after the last saved turn; a resume carries on from it.
  state: RunState | null
  final: null | { hash: string, numbers?: Record<string, number> }
  // Entries in the strike log and the event log so far: the `from` of the next append.
  strikes: number
  events: number
  // Rows in the pass record.
  passes: number
}

// An append to one of a session's logs. `from` is how many entries the sender believes the
// server already holds, which makes a save safe to send twice: entries the server has are
// skipped, and a gap is refused with a 409 whose data gives the server's count.
export interface LogAppend<T> {
  from: number
  items: T[]
}

// PATCH /api/sessions/:id, after every turn. Every field is optional; send what changed.
export interface SessionSave {
  strikes?: LogAppend<Strike>
  // Whatever the studio wants to show again after a reload (loop events without their images).
  events?: LogAppend<unknown>
  state?: RunState
  // Sent once, when the commission ends. Marks the session done.
  result?: { ended: RunEnd, finish: { title: string, statement: string } | null, error?: string }
  final?: { hash: string, numbers?: Record<string, number> }
  settings?: Record<string, unknown>
}

export interface SessionSaved {
  id: string
  status: SessionStatus
  updatedAt: string
  strikes: number
  events: number
}

// PUT /api/sessions/:id/reference, once, when the sheet has been made and checked.
export interface SessionReferenceSave {
  // Null when no sheet could be made; the brief, cost and error are still recorded.
  pngBase64: string | null
  outlines: boolean
  brief: string
  costUsd: number
  usage?: Usage
  error?: string
}

// One row of GET /api/sessions, newest first.
export interface SessionSummary {
  id: string
  commission: string
  model: string
  tools: ToolSetId
  ref: boolean
  status: SessionStatus
  turns: number
  costUsd: number
  strikes: number
  passes: number
  // How it ended, or null while it can still be resumed.
  ended: RunEnd | null
  title: string | null
  statement: string | null
  kernel: number
  hash: string | null
  startedAt: string
  updatedAt: string
  finishedAt: string | null
}

// GET /api/sessions/:id returns SessionFile with state.passes filled in.
// GET /api/sessions/:id/strikes returns a StrikeLog, /passes a PassRecord[], /events an array,
// /reference the PNG itself.
export type SessionPasses = PassRecord[]
