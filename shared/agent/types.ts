// The two seams the sculptor's loop runs over, and everything the loop says about itself.
// Brain is one model turn; Studio executes one tool call against the true stone. The same loop
// runs in the browser (Brain = POST /api/brain, Studio = the kernel worker) and in the bench.

import type { ModelMessage } from 'ai'
import type { ViewId } from '../sculpt/views.ts'
import type { Strike } from '../sculpt/types.ts'

// Passed back to the next turn verbatim: some providers require their own reasoning blocks to
// be returned unchanged. Images inside are base64 strings, so a context survives JSON.
export type Message = ModelMessage

export interface ToolCall {
  id: string
  name: string
  args: unknown
}

// Token counts for one turn or a whole run. `input` is every input token, cached ones included;
// `output` is every output token, reasoning included. `reasoning` is the reasoning share of
// `output`, kept for the report.
export interface Usage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

export interface BrainTurn {
  calls: ToolCall[]
  // The assistant message(s) for this turn. The loop answers every call itself, so any tool
  // messages in here (the AI SDK adds one for a call it could not parse) are dropped.
  append: Message[]
  usage: Usage
  costUsd: number
}

export interface Brain {
  // One model turn. Streams text as it arrives; resolves with the tool calls and the messages
  // to append. The tool set is fixed when the Brain is built and must match RunConfig.toolSet.
  // Must honour `signal`: the loop aborts it at the turn deadline and when the run is stopped.
  turn(
    input: { instructions: string, messages: Message[], signal?: AbortSignal },
    onText: (delta: string) => void
  ): Promise<BrainTurn>
}

export interface StudioResult {
  // What happened, in a sentence or two the model reads: stone removed, the 3D point a stroke
  // hit or that it missed.
  summary: string
  numbers?: Record<string, number>
  // Encoded image files (a look's contact sheet): PNG, or WebP or JPEG where the Studio's
  // encoder makes those. The loop sends them to the model as a user message after the tool
  // result, never inside it.
  images?: Uint8Array[]
  // A look-like result that shows other views than its arguments name (unfocus shows the
  // whole stone again): the views the image holds, for the record and the camera.
  views?: ViewId[]
  strikes: Strike[]
}

export interface Studio {
  // Executes one tool call against the true stone. The loop sends the looking tools (LOOK_TOOLS)
  // and the pass tools (PASS_TOOLS), with `args` already validated against the schema (cast
  // the call to StudioCall from toolSchemas.ts). `note` and `finish` never arrive here.
  // Throw to refuse a call ("no form named torso"): the message goes back to the model as an
  // error result and the pass is not recorded, so a throw must leave the stone untouched.
  run(call: ToolCall): Promise<StudioResult>
}

// direct: saw and chisel only. formed: every core tool.
export type ToolSetId = 'direct' | 'formed'

// none: no reference sheet. view: a sheet the model can see but code could not trace.
// outlines: a sheet whose front and left outlines `look` and `rough_out` can use.
export type ReferenceMode = 'none' | 'view' | 'outlines'

export const STAGES = ['rough_out', 'block_in', 'model', 'refine', 'polish'] as const
export type Stage = typeof STAGES[number]

// Tools whose calls go in the pass record. `declare_form` and `sketch` cut nothing but are in
// the record, because after a rebuild it is the only trace of which forms and lines exist.
export const PASS_TOOLS = ['sketch', 'declare_form', 'rough_out', 'detail', 'saw', 'chisel', 'drill', 'rasp', 'polish'] as const
export type PassTool = typeof PASS_TOOLS[number]

// Tools that answer with an image. Only `look` shows the whole stone, so only `look` counts
// as having looked.
export const LOOK_TOOLS = ['look', 'closeup', 'slice', 'focus', 'unfocus'] as const
export type LookTool = typeof LOOK_TOOLS[number]

export const TOOL_NAMES = ['look', 'closeup', 'slice', 'focus', 'unfocus', 'sketch', 'declare_form', 'rough_out', 'detail', 'saw', 'chisel', 'drill', 'rasp', 'polish', 'note', 'finish'] as const
export type ToolName = typeof TOOL_NAMES[number]

export interface Block {
  width: number
  height: number
  depth: number
}

export interface Commission {
  // What the person asked for.
  prompt: string
  // The hidden reference sheet: an encoded PNG, and whether its outlines could be traced.
  reference?: { png: Uint8Array, outlines: boolean }
}

export interface RunConfig {
  toolSet: ToolSetId
  block: Block
  stone: string
  maxTurns: number
  maxUsd: number
  // Turns between context rebuilds.
  rebuildEvery: number
  // Deadline for one Brain turn. A turn that misses it is retried once.
  turnTimeoutMs: number
  // Passes without a look before the loop reminds the model to look.
  lookEvery: number
  // native: results go back as tool messages. text: as plain user text, for a Brain using the
  // JSON-lines fallback, whose assistant messages carry no tool-call parts to answer.
  toolResults: 'native' | 'text'
}

export const DEFAULT_CONFIG: RunConfig = {
  toolSet: 'formed',
  block: { width: 60, height: 100, depth: 60 },
  stone: 'Carrara marble',
  maxTurns: 60,
  maxUsd: 8,
  rebuildEvery: 20,
  turnTimeoutMs: 90_000,
  lookEvery: 4,
  toolResults: 'native'
}

export interface Notebook {
  stage: Stage | null
  // The plan as last written by `note`. Each note replaces the one before.
  text: string
  // Turn of the last note, 0 if none.
  turn: number
}

export interface PassRecord {
  // 1-based position in the record.
  n: number
  turn: number
  tool: PassTool
  // The validated arguments, `why` included.
  args: Record<string, unknown>
  why: string
  // The one-line form that goes into a rebuilt context.
  line: string
  summary: string
  numbers?: Record<string, number>
  // How many strikes the hand expanded the pass into.
  strikes: number
}

// Everything a run needs to carry on after a reload. It is also what a rebuild is made from.
export interface RunState {
  turns: number
  passes: PassRecord[]
  notebook: Notebook
  usage: Usage
  costUsd: number
}

export type RunEnd = 'finish' | 'turn_cap' | 'cost_cap' | 'stalled' | 'aborted' | 'error'

export interface RunResult extends RunState {
  ended: RunEnd
  // Null unless the model called `finish`.
  finish: { title: string, statement: string } | null
  // Set when ended is 'error'.
  error?: string
}

// ok → warn75 → warn90 → last. `last` means the next turn is the final one.
export type BudgetLevel = 'ok' | 'warn75' | 'warn90' | 'last'

export type LoopEvent
  = | { type: 'turn_start', turn: number }
    | { type: 'text', turn: number, delta: string }
  // A Brain turn failed or timed out and is being asked again; discard its text deltas.
    | { type: 'turn_retry', turn: number, error: string }
    | { type: 'tool_call', turn: number, call: ToolCall, why?: string }
    | { type: 'tool_result', turn: number, call: ToolCall, ok: boolean, summary: string, numbers?: Record<string, number>, strikes: Strike[], strikeCount: number, pass?: PassRecord }
  // auto: the loop's own look for a rebuild, not one the model asked for. turn is then the last turn taken.
  // tool is absent for a plain look. A closeup names its one view; a slice names the axis view
  // it is drawn as (top, front or left) and has overlay 'slice'. args are the call's own.
    | { type: 'look', turn: number, auto: boolean, views: string[], overlay: string, images: Uint8Array[], summary: string, numbers?: Record<string, number>, tool?: LookTool, args?: Record<string, unknown> }
    | { type: 'note', turn: number, notebook: Notebook }
  // The context was rebuilt from the notebook and pass record. reason says why.
    | { type: 'rebuild', turn: number, reason: 'start' | 'resume' | 'interval', messages: Message[] }
    | { type: 'budget', turn: number, turns: number, maxTurns: number, costUsd: number, maxUsd: number, level: BudgetLevel }
  // usage and costUsd are this turn's; state holds the running totals and is safe to save.
    | { type: 'turn_end', turn: number, calls: number, usage: Usage, costUsd: number, state: RunState }
    | { type: 'error', turn: number, message: string }
  // Always the last event. title and statement are null when the run ended without `finish`.
    | { type: 'finish', turn: number, ended: RunEnd, title: string | null, statement: string | null }

export interface RunOptions {
  brain: Brain
  studio: Studio
  commission: Commission
  config?: Partial<RunConfig>
  onEvent?: (event: LoopEvent) => void
  signal?: AbortSignal
  // A saved RunState (from a turn_end event or a RunResult) to carry on from.
  resume?: RunState
}
