// The HUD's view-model: everything the film-style HUD draws, as plain serialisable data, and
// the events it sends back. `StudioHud` renders one `SculptorView` and nothing else, so the
// live engine, a replay and the mock preview page can all drive the same components.
//
// Who writes what:
// - The loop (applyLoopEvent, appendReasoning): notebook, stages, sketches, finish, error, and
//   stats.turns / maxTurns / costUsd / maxUsd / budget. Those are true the moment the model says them.
// - The timeline (plain assignments, or showPass / stageLook / endLook below): phase, notice,
//   subtitle, eye, transport, and stats.massKg / removedKg / strikes / elapsedVirtualMs / behindMs.
//   Those follow the shown stone, which runs behind the sculptor.
// - The HUD's own state (panel) changes only through setPanel, in answer to its `panel` event.
//
// Every function here is pure and returns a new view that shares whatever it did not change.
// Relative imports with extensions: tests run this file under plain node.

import type { UIMessage } from 'ai'
import { describeCall } from '../../shared/agent/toolSchemas.ts'
import { STAGES, TOOL_NAMES } from '../../shared/agent/types.ts'
import type { Block, BudgetLevel, LoopEvent, PassRecord, RunEnd, Stage, ToolName } from '../../shared/agent/types.ts'

// ---------- the view ----------

// idle: the commission card. preparing: accepted, nothing on the stone yet (block, reference
// sheet, first turn). thinking: the screen has caught up and the sculptor's turn is in flight.
// carving: strikes are playing. looking: a staged look. finished: the piece is done and the
// screen has caught up with it. error: the run stopped and cannot carry on (see `error`).
// Paused is not a phase: it is transport.paused, so a paused look is still a look.
export type SculptorPhase = 'idle' | 'preparing' | 'thinking' | 'carving' | 'looking' | 'finished' | 'error'

export type CameraMode = 'auto' | 'free'
// The one side panel: the notebook or the sculptor's eye, never both.
export type SidePanel = 'notebook' | 'eye'

export interface ModelOption {
  key: string
  label: string
  // Short and plain, e.g. "$4 in · $20 out per 1M tokens".
  priceHint: string
  default?: boolean
}

export interface StoneOption {
  key: string
  label: string
  // e.g. "60 × 100 × 60 cm".
  detail: string
  // False for a preset that is listed but cannot be picked yet.
  available: boolean
}

export interface StageView {
  id: Stage
  label: string
  state: 'done' | 'current' | 'pending'
}

export interface StatsView {
  // Stone standing on the banker now, and what the untouched block weighed.
  massKg: number
  blockKg: number
  removedKg: number
  turns: number
  maxTurns: number
  costUsd: number
  maxUsd: number
  budget: BudgetLevel
  // Strikes the shown stone has taken.
  strikes: number
  // The virtual clock: how long the hand has been at work.
  elapsedVirtualMs: number
  // How much work the sculptor has issued that the screen has not played yet. 0 when caught up.
  behindMs: number
}

export interface SubtitleView {
  // The tool in hand, or null for a line that belongs to no tool.
  tool: ToolName | null
  // The small line over the sentence: "Point chisel · rough out", "Looking", "Sketch".
  label: string
  // The sculptor's own sentence.
  text: string
}

// One line the sculptor drew with `sketch`: points in block centimetres as read off that view's
// rulers (h across, v up; v is depth in the top view).
export interface PinnedSketch {
  id: string
  view: string
  points: { h: number, v: number }[]
  why?: string
}

// What a look sent the model, kept on its notebook row and shown large in the eye panel.
export interface LookView {
  tool: 'look' | 'closeup' | 'slice'
  // True for the loop's own look before a rebuild, which the model did not ask for.
  auto: boolean
  turn: number
  views: string[]
  overlay: string
  // Object URLs or data URLs of the contact sheet(s), exactly as sent. May be empty.
  images: string[]
  summary: string
  numbers: Record<string, number>
}

export interface EyeView extends LookView {
  // The hidden reference sheet. Set only when the person asked to see it (?ref=1).
  referenceImage?: string
  // Where the side panel goes back to when the look ends.
  returnTo: SidePanel | null
}

interface EntryBase {
  id: string
  turn: number
}

export type NotebookEntry
  // The sculptor thinking aloud between tool calls.
  = | (EntryBase & { kind: 'text', text: string, streaming: boolean })
  // The provider's reasoning summary, where it gives one.
    | (EntryBase & { kind: 'reasoning', text: string, streaming: boolean })
    | (EntryBase & {
      kind: 'tool'
      callId: string
      tool: string
      // The call as a short phrase: `rough_out to "bust", margin 2 cm, point`.
      args: string
      why?: string
      state: 'running' | 'done' | 'error'
      // The result as the model read it. An error result is the refusal text.
      result?: string
      numbers?: Record<string, number>
      // Strikes the hand expanded the pass into; absent for tools that cut nothing.
      strikes?: number
      // 1-based position in the pass record, for tools that are recorded.
      pass?: number
      look?: LookView
    })
  // The plan as rewritten by `note`.
    | (EntryBase & { kind: 'note', stage: Stage, text: string })
    | (EntryBase & { kind: 'budget', level: BudgetLevel, text: string })
  // The loop speaking: a rebuild, a retry, a look of its own.
    | (EntryBase & { kind: 'system', text: string, look?: LookView })
    | (EntryBase & { kind: 'error', text: string })

export interface TransportView {
  paused: boolean
  // Multiples of the hand's own pace.
  speed: number
  speeds: number[]
  cameraMode: CameraMode
}

export interface FinishView {
  ended: RunEnd
  // Null when the run ended without the sculptor calling `finish`.
  title: string | null
  statement: string | null
  // ISO date the piece was finished, for the plaque.
  finishedAt: string
}

export interface SculptorView {
  phase: SculptorPhase
  // What the person asked for. Empty while idle.
  commission: string
  // Keys into `models` and `stones`.
  model: string
  stone: string
  block: Block
  // Whether the server has a gateway key. Without one the commission card is disabled.
  gateway: boolean
  models: ModelOption[]
  stones: StoneOption[]
  // Example commissions for the empty state.
  examples: string[]
  stages: StageView[]
  stats: StatsView
  // A quiet status line for moments with no subtitle: "Drawing the reference sheet".
  notice: string | null
  subtitle: SubtitleView | null
  notebook: NotebookEntry[]
  // The last look. Stays after the look ends so the panel can be opened again.
  eye: EyeView | null
  panel: SidePanel | null
  transport: TransportView
  sketches: PinnedSketch[]
  // Set as soon as the loop ends; the plaque shows once phase is 'finished'.
  finish: FinishView | null
  error?: string
}

// ---------- what the HUD sends back ----------

export interface StartRequest {
  commission: string
  model: string
  stone: string
}

// The part of the canvas the HUD's open side panel covers, in CSS pixels from that edge.
export interface HudInset {
  right: number
  bottom: number
}

// The emits of StudioHud. The engine answers each by changing the view it passes back in.
export type HudEvents = {
  start: [request: StartRequest]
  pause: []
  resume: []
  speed: [speed: number]
  camera: [mode: CameraMode]
  // Stop the commission where it stands.
  abort: []
  // Open one side panel or close it (null). Answer with setPanel.
  panel: [panel: SidePanel | null]
  // Clear a finished or failed commission and show the commission card again.
  reset: []
  // Sent on mount and whenever the side panel opens, closes or changes size: keep the stone in
  // what is left of the canvas. Nothing to answer; ignore it and the HUD still works.
  inset: [inset: HudInset]
}

// ---------- labels and numbers ----------

export const STAGE_LABELS: Record<Stage, string> = {
  rough_out: 'Rough out',
  block_in: 'Block in',
  model: 'Model',
  refine: 'Refine',
  polish: 'Polish'
}

const TOOL_LABELS: Record<ToolName, string> = {
  look: 'Looking',
  closeup: 'Looking closely',
  slice: 'Cross-section',
  sketch: 'Sketch',
  declare_form: 'Declaring the form',
  rough_out: 'Roughing out',
  saw: 'Saw',
  chisel: 'Chisel',
  drill: 'Drill',
  rasp: 'Rasp',
  polish: 'Polishing pad',
  note: 'Notebook',
  finish: 'Signing the base'
}

const CHISELS: Record<string, string> = { point: 'Point chisel', claw: 'Claw chisel', flat: 'Flat chisel', roundel: 'Roundel' }

const isTool = (name: string): name is ToolName => (TOOL_NAMES as readonly string[]).includes(name)

// The tool in hand, by name: "Point chisel" for chisel and rough_out with the point, "Saw", "Looking".
export function toolLabel(tool: string, args?: Record<string, unknown>): string {
  if (!isTool(tool)) return tool.replaceAll('_', ' ')
  const which = typeof args?.tool === 'string' ? CHISELS[args.tool] : undefined
  if (tool === 'chisel' && which) return which
  if (tool === 'rough_out' && which) return `${which} · roughing out`
  return TOOL_LABELS[tool]
}

// The subtitle's small line: the tool, then the stage the sculptor says it is in.
export function subtitleLabel(tool: string, args: Record<string, unknown> | undefined, stage: Stage | null): string {
  const name = toolLabel(tool, args)
  // rough_out already says what it is doing, and the looking tools belong to no stage
  if (!stage || tool === 'rough_out' || tool === 'look' || tool === 'closeup' || tool === 'slice' || tool === 'sketch') return name
  return `${name} · ${STAGE_LABELS[stage].toLowerCase()}`
}

export function subtitleForPass(pass: Pick<PassRecord, 'tool' | 'args' | 'why'>, stage: Stage | null): SubtitleView {
  return { tool: pass.tool, label: subtitleLabel(pass.tool, pass.args, stage), text: pass.why }
}

export interface NumberChip {
  key: string
  label: string
  value: string
}

// The numbers worth a glance, in this order, with the words a person would use for them.
const HEADLINES: [key: string, label: string, one?: string][] = [
  ['mass_kg', 'remaining'],
  ['removed_kg', 'removed'],
  ['removed_pct', 'of the block gone'],
  ['form_proud_max_cm', 'proud of form, max'],
  ['form_proud_mean_cm', 'proud of form, mean'],
  ['form_overcut_max_cm', 'cut below form, max'],
  ['outside_margin_max_cm', 'outside margin, max'],
  ['outside_margin_mean_cm', 'outside margin, mean'],
  ['silhouette_front_iou', 'front outline match'],
  ['silhouette_left_iou', 'left outline match'],
  ['surface_polished_pct', 'polished'],
  ['offcuts', 'offcuts', 'offcut'],
  ['saw_cuts', 'saw cuts', 'saw cut'],
  ['chisel_strikes', 'chisel strikes', 'chisel strike'],
  ['points_missed', 'points missed', 'point missed']
]

const UNITS: [suffix: string, unit: string][] = [['_cm3', ' cm³'], ['_cm', ' cm'], ['_kg', ' kg'], ['_pct', '%']]

function trim(n: number, places: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: places })
}

// One measured number as a label and a value with its unit, read off the key's suffix.
export function formatNumber(key: string, n: number, label?: string): NumberChip {
  if (key.endsWith('_iou')) return { key, label: label ?? key.slice(0, -4).replaceAll('_', ' '), value: `${Math.round(n * 100)}%` }
  const unit = UNITS.find(([suffix]) => key.endsWith(suffix))
  const name = unit ? key.slice(0, -unit[0].length) : key
  const places = Math.abs(n) >= 100 || Number.isInteger(n) ? 0 : Math.abs(n) >= 10 ? 1 : 2
  return { key, label: label ?? name.replaceAll('_', ' '), value: `${trim(n, places)}${unit ? unit[1] : ''}` }
}

// Up to `limit` of the numbers a result came with, the telling ones first. Zeros that say
// nothing (no offcuts, no missed points) are left out.
export function headlineNumbers(numbers: Record<string, number> | undefined, limit = 4): NumberChip[] {
  if (!numbers) return []
  const out: NumberChip[] = []
  for (const [key, label, one] of HEADLINES) {
    const n = numbers[key]
    if (n === undefined || (n === 0 && !key.endsWith('_kg') && !key.endsWith('_iou'))) continue
    out.push(formatNumber(key, n, n === 1 && one ? one : label))
    if (out.length >= limit) break
  }
  return out
}

// Every number, in the order the model was given them.
export function allNumbers(numbers: Record<string, number> | undefined): NumberChip[] {
  return Object.entries(numbers ?? {}).map(([key, n]) => formatNumber(key, n))
}

// 372000 → "6:12", 3_723_000 → "1:02:03".
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return h ? `${h}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`
}

export function priceHint(price: { input: number, output: number }): string {
  return `$${trim(price.input, 2)} in · $${trim(price.output, 2)} out per 1M tokens`
}

// GET /api/health's model list as picker options.
export function modelOptions(models: { key: string, label: string, default?: boolean, price: { input: number, output: number } }[]): ModelOption[] {
  return models.map(m => ({ key: m.key, label: m.label, priceHint: priceHint(m.price), ...(m.default ? { default: true } : {}) }))
}

// ---------- building and changing a view ----------

// Marble at 2.71 g/cm³, the kernel's own figure: the default block is 975.6 kg.
const KG_PER_CM3 = 0.00271

export const DEFAULT_STONES: StoneOption[] = [
  { key: 'carrara', label: 'Carrara marble', detail: '60 × 100 × 60 cm', available: true },
  { key: 'nero', label: 'Nero Marquina', detail: 'black marble', available: false }
]

export const EXAMPLE_COMMISSIONS = ['A bust of a Roman senator', 'A sleeping cat', 'A hand holding an apple', 'A chess knight']

export const DEFAULT_SPEEDS = [1, 4, 8, 20, 60]

export function stageViews(current: Stage | null): StageView[] {
  const at = current ? STAGES.indexOf(current) : -1
  return STAGES.map((id, i) => ({ id, label: STAGE_LABELS[id], state: i < at ? 'done' : i === at ? 'current' : 'pending' }))
}

export interface ViewSetup {
  models?: ModelOption[]
  model?: string
  gateway?: boolean
  block?: Block
  maxTurns?: number
  maxUsd?: number
}

// The empty state: a fresh block and the commission card.
export function emptyView(setup: ViewSetup = {}): SculptorView {
  const models = setup.models ?? []
  const block = setup.block ?? { width: 60, height: 100, depth: 60 }
  const blockKg = Math.round(block.width * block.height * block.depth * KG_PER_CM3 * 10) / 10
  return {
    phase: 'idle',
    commission: '',
    model: setup.model ?? models.find(m => m.default)?.key ?? models[0]?.key ?? '',
    stone: 'carrara',
    block,
    gateway: setup.gateway ?? true,
    models,
    stones: DEFAULT_STONES,
    examples: EXAMPLE_COMMISSIONS,
    stages: stageViews(null),
    stats: { massKg: blockKg, blockKg, removedKg: 0, turns: 0, maxTurns: setup.maxTurns ?? 60, costUsd: 0, maxUsd: setup.maxUsd ?? 8, budget: 'ok', strikes: 0, elapsedVirtualMs: 0, behindMs: 0 },
    notice: null,
    subtitle: null,
    notebook: [],
    eye: null,
    panel: null,
    transport: { paused: false, speed: 4, speeds: DEFAULT_SPEEDS, cameraMode: 'auto' },
    sketches: [],
    finish: null
  }
}

// A commission accepted: the card goes away and the run's own state starts clean.
export function beginCommission(view: SculptorView, request: StartRequest, notice = 'Setting up the block'): SculptorView {
  const fresh = emptyView({ models: view.models, gateway: view.gateway, block: view.block, maxTurns: view.stats.maxTurns, maxUsd: view.stats.maxUsd })
  return { ...fresh, phase: 'preparing', commission: request.commission, model: request.model, stone: request.stone, notice, transport: view.transport, panel: view.panel === 'eye' ? null : view.panel }
}

export function setPanel(view: SculptorView, panel: SidePanel | null): SculptorView {
  return view.panel === panel ? view : { ...view, panel }
}

// The pass now playing on the shown stone: its sentence becomes the subtitle.
export function showPass(view: SculptorView, pass: Pick<PassRecord, 'tool' | 'args' | 'why'>): SculptorView {
  return { ...view, phase: 'carving', notice: null, subtitle: subtitleForPass(pass, currentStage(view)) }
}

// A pass has fully played: the stats take the mass the kernel measured after it.
export function landPass(view: SculptorView, pass: Pick<PassRecord, 'numbers'>): SculptorView {
  const mass = pass.numbers?.mass_kg
  if (mass === undefined) return view
  return { ...view, stats: { ...view.stats, massKg: mass, removedKg: Math.max(0, Math.round((view.stats.blockKg - mass) * 10) / 10) } }
}

export function currentStage(view: SculptorView): Stage | null {
  return view.stages.find(s => s.state === 'current')?.id ?? null
}

// A look event as the eye panel shows it. `toUrl` turns the encoded sheet into something an
// <img> can load (an object URL in the browser); without it the look carries no image.
export function lookView(event: Extract<LoopEvent, { type: 'look' }>, toUrl?: (image: Uint8Array) => string): LookView {
  return {
    tool: event.tool ?? 'look',
    auto: event.auto,
    turn: event.turn,
    views: event.views,
    overlay: event.overlay,
    images: toUrl ? event.images.map(toUrl) : [],
    summary: event.summary,
    numbers: event.numbers ?? {}
  }
}

// The clock has reached a look: the hand stops and the eye panel opens on what the model was sent.
export function stageLook(view: SculptorView, look: LookView, referenceImage?: string): SculptorView {
  // a look that follows straight on another keeps the first one's way back
  const returnTo = view.phase === 'looking' && view.eye ? view.eye.returnTo : view.panel
  return {
    ...view,
    phase: 'looking',
    notice: null,
    subtitle: { tool: look.tool, label: toolLabel(look.tool), text: look.auto ? 'Stepping back to take the whole piece in before carrying on.' : lookSentence(look) },
    eye: { ...look, returnTo, ...(referenceImage ? { referenceImage } : {}) },
    panel: 'eye'
  }
}

// The look is over. The side panel goes back to what it was, unless the person changed it meanwhile.
export function endLook(view: SculptorView, next: SculptorPhase = 'carving'): SculptorView {
  if (view.phase !== 'looking') return view
  return { ...view, phase: next, subtitle: null, panel: view.panel === 'eye' && view.eye ? view.eye.returnTo : view.panel }
}

const VIEW_WORDS: Record<string, string> = { front_left: 'front left', front_right: 'front right', back_left: 'back left', back_right: 'back right' }

function lookSentence(look: LookView): string {
  const views = look.views.map(v => VIEW_WORDS[v] ?? v)
  const from = views.length > 1 ? `${views.slice(0, -1).join(', ')} and ${views.at(-1)}` : views[0] ?? 'the front'
  if (look.tool === 'slice') return `Cutting the stone open on paper to see the section, drawn as the ${from} view.`
  if (look.tool === 'closeup') return `Leaning in for a close look from the ${from}.`
  return `Stepping back to look from the ${from}.`
}

// ---------- the loop's events ----------

export interface ApplyOptions {
  // Makes a URL for a look's encoded image. Leave out to keep images off the notebook.
  toUrl?: (image: Uint8Array) => string
  // The finish time, ISO. Defaults to now; tests pass a fixed one.
  now?: string
}

const BUDGET_TEXT: Record<Exclude<BudgetLevel, 'ok'>, string> = {
  warn75: 'Three quarters of the budget is spent.',
  warn90: 'Nine tenths of the budget is spent. Time to land the piece.',
  last: 'The budget is all but gone: the next turn is the last.'
}

const END_TEXT: Record<Exclude<RunEnd, 'finish'>, string> = {
  turn_cap: 'The commission ran out of turns before the sculptor called it finished.',
  cost_cap: 'The commission ran out of budget before the sculptor called it finished.',
  stalled: 'The sculptor stopped working: three turns passed without a tool in hand.',
  aborted: 'The commission was stopped.',
  error: 'The commission stopped on an error.'
}

const asRecord = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {}

function callPhrase(name: string, args: unknown): string {
  if (!isTool(name)) return name
  try {
    return describeCall(name, asRecord(args))
  } catch {
    // arguments that never passed validation have no shape to describe
    return name
  }
}

function push(view: SculptorView, entry: NotebookEntry): SculptorView {
  return { ...view, notebook: [...view.notebook, entry] }
}

function replaceAt(view: SculptorView, index: number, entry: NotebookEntry): SculptorView {
  const notebook = view.notebook.slice()
  notebook[index] = entry
  return { ...view, notebook }
}

const nextId = (view: SculptorView, turn: number, kind: string) => `${turn}-${kind}-${view.notebook.length}`

function appendStream(view: SculptorView, kind: 'text' | 'reasoning', turn: number, delta: string): SculptorView {
  if (!delta) return view
  const i = view.notebook.length - 1
  const last = view.notebook[i]
  if (last && last.kind === kind && last.turn === turn && last.streaming) return replaceAt(view, i, { ...last, text: last.text + delta })
  return push(view, { id: nextId(view, turn, kind), turn, kind, text: delta, streaming: true })
}

// The provider's reasoning summary as it streams (a BrainEvent, not a LoopEvent).
export function appendReasoning(view: SculptorView, turn: number, delta: string): SculptorView {
  return appendStream(view, 'reasoning', turn, delta)
}

function settle(view: SculptorView, turn: number): SculptorView {
  if (!view.notebook.some(e => (e.kind === 'text' || e.kind === 'reasoning') && e.turn === turn && e.streaming)) return view
  return { ...view, notebook: view.notebook.map(e => (e.kind === 'text' || e.kind === 'reasoning') && e.turn === turn && e.streaming ? { ...e, streaming: false } : e) }
}

function lastIndex(view: SculptorView, test: (e: NotebookEntry) => boolean): number {
  for (let i = view.notebook.length - 1; i >= 0; i--) if (test(view.notebook[i]!)) return i
  return -1
}

// Folds one loop event into the view: the notebook rows, the stage list, turns and cost, the
// pinned sketches, the finish and the error. It never touches phase, subtitle, eye or transport;
// those follow the shown stone and belong to the timeline (see the top of this file).
export function applyLoopEvent(view: SculptorView, event: LoopEvent, options: ApplyOptions = {}): SculptorView {
  switch (event.type) {
    case 'turn_start':
      return { ...view, stats: { ...view.stats, turns: Math.max(view.stats.turns, event.turn) } }
    case 'text':
      return appendStream(view, 'text', event.turn, event.delta)
    case 'turn_retry': {
      // the failed attempt's words are discarded, as the loop discards them
      const kept = view.notebook.filter(e => !((e.kind === 'text' || e.kind === 'reasoning') && e.turn === event.turn))
      const cleared = { ...view, notebook: kept }
      return push(cleared, { id: nextId(cleared, event.turn, 'system'), turn: event.turn, kind: 'system', text: `That turn did not come back (${event.error}). Asking again.` })
    }
    case 'tool_call': {
      const settled = settle(view, event.turn)
      return push(settled, {
        id: nextId(settled, event.turn, 'tool'),
        turn: event.turn,
        kind: 'tool',
        callId: event.call.id,
        tool: event.call.name,
        args: callPhrase(event.call.name, event.call.args),
        ...(event.why ? { why: event.why } : {}),
        state: 'running'
      })
    }
    case 'look': {
      const look = lookView(event, options.toUrl)
      if (event.auto) return push(view, { id: nextId(view, event.turn, 'system'), turn: event.turn, kind: 'system', text: 'Took a fresh look at the whole stone before carrying on.', look })
      const i = lastIndex(view, e => e.kind === 'tool' && e.turn === event.turn && e.tool === look.tool && e.state === 'running')
      const row = view.notebook[i]
      return row && row.kind === 'tool' ? replaceAt(view, i, { ...row, look }) : view
    }
    case 'tool_result': {
      const i = lastIndex(view, e => e.kind === 'tool' && e.callId === event.call.id && e.turn === event.turn)
      const row = view.notebook[i]
      let next = view
      if (row && row.kind === 'tool') {
        next = replaceAt(view, i, {
          ...row,
          // the validated call reads better than the raw one (defaults filled, numbers parsed)
          args: event.ok ? callPhrase(event.call.name, event.call.args) : row.args,
          state: event.ok ? 'done' : 'error',
          result: event.summary,
          ...(event.numbers ? { numbers: event.numbers } : {}),
          ...(event.strikeCount ? { strikes: event.strikeCount } : {}),
          ...(event.pass ? { pass: event.pass.n } : {})
        })
      }
      if (event.ok && event.call.name === 'sketch') {
        const args = asRecord(event.call.args)
        const points = Array.isArray(args.path) ? args.path.filter((p): p is { h: number, v: number } => typeof p?.h === 'number' && typeof p?.v === 'number') : []
        if (points.length > 1) next = { ...next, sketches: [...next.sketches, { id: event.call.id, view: String(args.view ?? 'front'), points, ...(typeof args.why === 'string' ? { why: args.why } : {}) }] }
      }
      return next
    }
    case 'note': {
      const stage = event.notebook.stage
      const next = stage ? { ...view, stages: stageViews(stage) } : view
      return stage ? push(next, { id: nextId(next, event.turn, 'note'), turn: event.turn, kind: 'note', stage, text: event.notebook.text }) : next
    }
    case 'rebuild': {
      if (event.reason === 'start') return view
      const text = event.reason === 'resume' ? 'Picked the commission back up from the notebook and the pass record.' : 'Cleared the bench: carrying on from the notebook and the pass record.'
      return push(view, { id: nextId(view, event.turn, 'system'), turn: event.turn, kind: 'system', text })
    }
    case 'budget': {
      const stats = { ...view.stats, turns: event.turns, maxTurns: event.maxTurns, costUsd: event.costUsd, maxUsd: event.maxUsd, budget: event.level }
      const next = { ...view, stats }
      if (event.level === 'ok' || event.level === view.stats.budget) return next
      return push(next, { id: nextId(next, event.turn, 'budget'), turn: event.turn, kind: 'budget', level: event.level, text: BUDGET_TEXT[event.level] })
    }
    case 'turn_end': {
      const settled = settle(view, event.turn)
      return { ...settled, stats: { ...settled.stats, turns: event.state.turns, costUsd: event.state.costUsd } }
    }
    case 'error': {
      const next = push(view, { id: nextId(view, event.turn, 'error'), turn: event.turn, kind: 'error', text: event.message })
      return { ...next, error: event.message }
    }
    case 'finish': {
      const settled = settle(view, event.turn)
      const finish: FinishView = { ended: event.ended, title: event.title, statement: event.statement, finishedAt: options.now ?? new Date().toISOString() }
      const next = { ...settled, finish }
      return event.ended === 'finish' || event.ended === 'error' ? next : push(next, { id: nextId(next, event.turn, 'system'), turn: event.turn, kind: 'system', text: END_TEXT[event.ended] })
    }
  }
}

// What a finish says on the plaque when the sculptor gave the piece no title.
export function finishFallback(ended: RunEnd): string {
  return ended === 'finish' ? '' : END_TEXT[ended]
}

// ---------- the notebook as chat messages ----------

// Notebook rows as the AI SDK's UI messages, so UChatMessages, UChatReasoning and UChatTool can
// draw them: one assistant message per turn, its rows as parts in the order they happened.
// The sculptor's words are text parts, a provider's reasoning a reasoning part, each tool call a
// tool part that moves from input-available to output-available or output-error, and the rows
// that are not the model speaking (the plan, budget warnings, the loop's own remarks, errors)
// are data parts.

export interface NotebookToolInput {
  // The call as a short phrase, and the sculptor's sentence for it.
  phrase: string
  why?: string
}

export interface NotebookToolOutput {
  summary: string
  numbers?: Record<string, number>
  strikes?: number
  pass?: number
  look?: LookView
}

export type NotebookData = {
  note: { stage: Stage, text: string }
  budget: { level: BudgetLevel, text: string }
  system: { text: string, look?: LookView }
  error: { text: string }
}

export type NotebookTools = Record<string, { input: NotebookToolInput, output: NotebookToolOutput }>
// A tool part as notebookMessages makes them: the three states a finished call can be seen in.
export type NotebookToolPart = { type: `tool-${string}`, toolCallId: string, input: NotebookToolInput } & (
  | { state: 'input-available' }
  | { state: 'output-available', output: NotebookToolOutput }
  | { state: 'output-error', errorText: string }
)
export type NotebookMessage = UIMessage<{ turn: number }, NotebookData, NotebookTools>

function notebookPart(entry: NotebookEntry): NotebookMessage['parts'][number] {
  switch (entry.kind) {
    case 'text':
    case 'reasoning':
      return { type: entry.kind, text: entry.text, state: entry.streaming ? 'streaming' : 'done' }
    case 'tool': {
      const call = { type: `tool-${entry.tool}` as const, toolCallId: entry.callId, input: { phrase: entry.args, ...(entry.why ? { why: entry.why } : {}) } }
      if (entry.state === 'running') return { ...call, state: 'input-available' }
      if (entry.state === 'error') return { ...call, state: 'output-error', errorText: entry.result ?? 'The call was refused.' }
      return {
        ...call,
        state: 'output-available',
        output: {
          summary: entry.result ?? '',
          ...(entry.numbers ? { numbers: entry.numbers } : {}),
          ...(entry.strikes ? { strikes: entry.strikes } : {}),
          ...(entry.pass ? { pass: entry.pass } : {}),
          ...(entry.look ? { look: entry.look } : {})
        }
      }
    }
    case 'note':
      return { type: 'data-note', id: entry.id, data: { stage: entry.stage, text: entry.text } }
    case 'budget':
      return { type: 'data-budget', id: entry.id, data: { level: entry.level, text: entry.text } }
    case 'system':
      return { type: 'data-system', id: entry.id, data: { text: entry.text, ...(entry.look ? { look: entry.look } : {}) } }
    case 'error':
      return { type: 'data-error', id: entry.id, data: { text: entry.text } }
  }
}

export function notebookMessages(entries: NotebookEntry[]): NotebookMessage[] {
  const out: NotebookMessage[] = []
  for (const entry of entries) {
    let last = out.at(-1)
    if (!last || last.metadata?.turn !== entry.turn) {
      // rows of one turn can be split by another's (a rebuild's look), so the id carries the position
      last = { id: `turn-${entry.turn}-${out.length}`, role: 'assistant', metadata: { turn: entry.turn }, parts: [] }
      out.push(last)
    }
    last.parts.push(notebookPart(entry))
  }
  return out
}

// ---------- mock views for the preview page and tests ----------

// The storyboard's frames that the Sprint 3 HUD covers.
export type StoryFrame = 1 | 2 | 3 | 4 | 6
export const STORY_FRAMES: { frame: StoryFrame, label: string }[] = [
  { frame: 1, label: 'Commission' },
  { frame: 2, label: 'Sketching' },
  { frame: 3, label: 'Roughing out' },
  { frame: 4, label: 'Looking' },
  { frame: 6, label: 'Finished' }
]

export const MOCK_MODELS: ModelOption[] = modelOptions([
  { key: 'opus', label: 'Opus 5.5', default: true, price: { input: 4, output: 20 } },
  { key: 'sol', label: 'GPT-6 Sol', price: { input: 2, output: 10 } },
  { key: 'fable', label: 'Fable 5.1', price: { input: 10, output: 50 } },
  { key: 'gemini', label: 'Gemini 3.1 Pro', price: { input: 2, output: 12 } }
])

const MOCK_COMMISSION = 'A bust of a Roman senator'

// A stand-in contact sheet: clay-grey silhouettes on a centimetre grid, as an SVG data URL.
function mockSheet(views: string[], outline: boolean): string {
  const cols = views.length > 4 ? 3 : 2
  const rows = Math.ceil(views.length / cols)
  const tiles = views.map((v, i) => {
    const x = (i % cols) * 200
    const y = Math.floor(i / cols) * 240
    const w = [88, 104, 80, 88, 80, 92][i % 6]!
    const grid = [40, 80, 120, 160].map(p => `<path d="M${p} 0V240M0 ${p + 20}H200" stroke="#3a3a40" stroke-width="1"/>`).join('')
    const body = v === 'top'
      ? '<ellipse cx="100" cy="120" rx="68" ry="48" fill="#8c8c90"/><ellipse cx="100" cy="112" rx="32" ry="38" fill="#a9a9ad"/>'
      : `<path d="M${100 - w / 2.6} 44H${100 + w / 2.6}L${100 + w / 2} 80L${100 + w / 2.4} 116L${100 + w / 4} 136L${100 + w / 1.2} 160L${100 + w / 1.1} 208H${100 - w / 1.1}L${100 - w / 1.2} 160L${100 - w / 4} 136L${100 - w / 2.4} 116L${100 - w / 2} 80Z" fill="#8c8c90"/><path d="M100 44H${100 + w / 2.6}L${100 + w / 2} 80L${100 + w / 2.4} 116L${100 + w / 4} 136L100 128Z" fill="#a9a9ad"/>`
    const line = outline && (v === 'front' || v === 'left') ? '<path d="M100 40C124 40 136 64 136 88C136 112 124 128 112 134L114 148C140 156 164 172 168 208H32C36 172 60 156 86 148L88 134C76 128 64 112 64 88C64 64 76 40 100 40Z" fill="none" stroke="#22d3ee" stroke-width="2"/>' : ''
    return `<g transform="translate(${x} ${y})"><rect width="198" height="238" fill="#1b1b1d"/>${grid}${body}${line}<text x="8" y="20" font-size="14" fill="#b9b6af" font-family="ui-monospace,monospace">${v}</text><text x="190" y="230" font-size="11" fill="#77747a" text-anchor="end" font-family="ui-monospace,monospace">10 cm</text></g>`
  }).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cols * 200} ${rows * 240}" width="${cols * 200}" height="${rows * 240}"><rect width="100%" height="100%" fill="#0b0b0c"/>${tiles}</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const FRONT_PROFILE = [[-16, 0], [-16, 13], [-28, 22], [-27, 36], [-18, 44], [-9, 47], [-9, 52], [-12, 58], [-12, 72], [-8, 80], [0, 83], [8, 80], [12, 72], [12, 58], [9, 52], [9, 47], [18, 44], [27, 36], [28, 22], [16, 13], [16, 0]]
const LEFT_PROFILE = [[-16, 0], [-16, 13], [-22, 24], [-20, 40], [-10, 47], [-12, 54], [-16, 66], [-12, 78], [-2, 83], [8, 81], [14, 74], [15, 66], [19, 58], [15, 55], [15, 51], [13, 49], [9, 46], [18, 38], [21, 24], [22, 13], [22, 0]]
const toPoints = (pairs: number[][]) => pairs.map(([h, v]) => ({ h: h!, v: v! }))

const MOCK_SKETCHES: PinnedSketch[] = [
  { id: 'sk1', view: 'front', points: toPoints(FRONT_PROFILE), why: 'Marking the front outline: shoulders wide and low, the head high on a real neck.' },
  { id: 'sk2', view: 'front', points: toPoints([[0, 44], [0, 86]]), why: 'A centre line to keep the face square to the block.' },
  { id: 'sk3', view: 'left', points: toPoints(LEFT_PROFILE), why: 'The profile: skull swelling back over the neck, the nose and chin leading.' }
]

const LOOK_5: LookView = {
  tool: 'look',
  auto: false,
  turn: 5,
  views: ['front', 'left', 'front_right', 'back_left'],
  overlay: 'form',
  images: [mockSheet(['front', 'left', 'front_right', 'back_left'], true)],
  summary: 'Looked from front, left, front_right, back_left with the form overlay.',
  numbers: { mass_kg: 292.9, volume_cm3: 108067, removed_pct: 70, bbox_x_min_cm: -30, bbox_x_max_cm: 30, bbox_y_min_cm: 0, bbox_y_max_cm: 85.7, bbox_z_min_cm: -23.9, bbox_z_max_cm: 24, form_proud_max_cm: 3.3, form_proud_mean_cm: 1.94, form_stone_outside_cm3: 24051, form_overcut_max_cm: 3.4, form_overcut_cm3: 2324, form_surface_within_1cm_pct: 10.4, silhouette_front_iou: 0.805, silhouette_left_iou: 0.774 }
}

// The notebook of a real run (study B, bust, Opus 5.5), as far as each frame has got.
function mockNotebook(frame: StoryFrame): NotebookEntry[] {
  const sketching: NotebookEntry[] = [
    { id: 'm1', turn: 1, kind: 'reasoning', streaming: false, text: 'The block is 60 by 100 by 60. A bust wants the shoulders low and wide and the head in the top third, so most of the waste is above and beside the head.' },
    { id: 'm2', turn: 1, kind: 'tool', callId: 'c1', tool: 'look', args: 'look front, left (grid)', state: 'done', result: 'Looked from front, left with the grid overlay.', numbers: { mass_kg: 975.6, removed_pct: 0 } },
    { id: 'm3', turn: 2, kind: 'tool', callId: 'c2', tool: 'sketch', args: 'sketch front (-16,0)→(-16,13)→(-28,22)→(-27,36)→(-18,44)→(-9,47)→(-9,52)→(-12,58)', why: MOCK_SKETCHES[0]!.why, state: 'done', result: 'Drew a line of 21 points on the front face. Nothing was cut.', strikes: 1, pass: 1 },
    { id: 'm4', turn: 2, kind: 'tool', callId: 'c3', tool: 'sketch', args: 'sketch left (-16,0)→(-16,13)→(-22,24)→(-20,40)→(-10,47)→(-12,54)', why: MOCK_SKETCHES[2]!.why, state: frame === 2 ? 'running' : 'done', ...(frame === 2 ? {} : { result: 'Drew a line of 21 points on the left face. Nothing was cut.', strikes: 1, pass: 2 }) }
  ]
  if (frame === 2) return sketching
  const roughing: NotebookEntry[] = [
    ...sketching,
    { id: 'm5', turn: 3, kind: 'note', stage: 'rough_out', text: 'Bust facing +Z. Head top Y83, head X -12..12, Y 50-83, Z -16..18 (nose ~Z19 at Y58, chin Y50 Z~13). Neck Y45-52 X -9..9. Shoulders/chest Y13-48, X -28..28 (widest Y36). Plinth Y0-13. Plan: saw top above 85, rough out to margin 3, then margin 1.5 claw, then carve features by chisel, rasp finish.' },
    { id: 'm6', turn: 3, kind: 'tool', callId: 'c4', tool: 'saw', args: 'saw front (-30,86)→(30,86), discard above', why: 'Taking the top slab off; the head doesn\'t need it.', state: 'done', result: 'Sawed from [-30, 86] to [30, 86] in the front view, discarding everything above the line: 50,400 cm³ (136.6 kg) fell away in 1 piece, 14% of the stone that was there.', numbers: { removed_cm3: 50400, removed_kg: 136.584, mass_kg: 839, offcuts: 1 }, strikes: 2, pass: 3 },
    { id: 'm7', turn: 3, kind: 'tool', callId: 'c5', tool: 'rough_out', args: 'rough_out to "reference", margin 3 cm, point', why: 'Knocking the big waste off all round to find the bust\'s envelope, leaving a safe skin.', state: frame === 3 ? 'running' : 'done', ...(frame === 3 ? {} : { result: 'Roughed out to \'reference\' with the point chisel, leaving 3 cm: 6 saw cuts took 89,273 cm³ (241.9 kg) off in slabs, 1464 chisel strikes took 81,469 cm³ (220.8 kg) and 136 cm³ fell away loose.', numbers: { removed_cm3: 170878, removed_kg: 463.079, mass_kg: 375.9, offcuts: 18, outside_margin_max_cm: 1.9, outside_margin_mean_cm: 0.44, saw_cuts: 6, chisel_strikes: 1464 }, strikes: 1476, pass: 4 }) }
  ]
  if (frame === 3) return [...roughing, { id: 'm8', turn: 4, kind: 'text', streaming: true, text: 'That corner fell cleanly. The remaining mass still reads as a box from the left, so the form comes next' }]
  const looking: NotebookEntry[] = [
    ...roughing,
    { id: 'm9', turn: 4, kind: 'tool', callId: 'c6', tool: 'declare_form', args: 'declare_form "bust": ellipsoid at 0,67,0 size 23×32×31; ellipsoid at 0,57,6 size 18×17×22; box at 0,59,16 size 4×7×6; ellipsoid at 12,62,-2 size 4×9×5; capsule at 0,47,0 size 17×14×17; blend 3', why: 'Setting down the rounded masses—skull, face, neck, chest and plinth—that the bust should become.', state: 'done', result: 'Declared form "bust" (9 shapes, blend 3 cm). Inside the block it spans X -28 to 28, Y 0 to 82, Z -20 to 22 and holds about 84.7 litres (230 kg). Nothing was cut.', numbers: { form_volume_cm3: 84688, form_y_min_cm: 0, form_y_max_cm: 82 }, strikes: 1, pass: 5 },
    { id: 'm10', turn: 5, kind: 'tool', callId: 'c7', tool: 'rough_out', args: 'rough_out to "bust", margin 2 cm, point', why: 'Rounding the boxy envelope toward skull, neck and shoulders, still leaving a skin to work in.', state: 'done', result: 'Roughed out to \'bust\' with the point chisel, leaving 2 cm: 3 saw cuts took 4,412 cm³ (12.0 kg) off in slabs, 1223 chisel strikes took 26,240 cm³ (71.1 kg) and 3.1 cm³ fell away loose.', numbers: { removed_cm3: 30655, removed_kg: 83.075, mass_kg: 292.9, offcuts: 7, outside_margin_max_cm: 1.3, outside_margin_mean_cm: 0.28, saw_cuts: 3, chisel_strikes: 1223 }, strikes: 1230, pass: 6 },
    { id: 'm11', turn: 5, kind: 'tool', callId: 'c8', tool: 'look', args: 'look front, left, front_right, back_left (form)', state: 'done', result: LOOK_5.summary, numbers: LOOK_5.numbers, look: LOOK_5 }
  ]
  if (frame === 4) return looking
  return [
    ...looking,
    { id: 'm12', turn: 12, kind: 'note', stage: 'model', text: 'Form "bust" declared. Roughed to margin 0.5 claw: masses done. Now: eye sockets Y~63 X±5, throat under chin Y48, mouth Y54, brow, ears; then rasp face, head, shoulders; finish by ~turn 50.' },
    { id: 'm13', turn: 12, kind: 'tool', callId: 'c9', tool: 'chisel', args: 'chisel claw front (-8,63)→(-2.5,63), depth 1.2, width 3, protecting "bust"', why: 'Sinking the right eye socket under the brow.', state: 'done', result: 'Claw chisel from the front view: It ran on the stone from (x -8.0, y 63.0, z 12.1) to (x -2.5, y 63.0, z 19.2). 5 strikes took 28 cm³, 1.2 cm deep and 3 cm wide.', numbers: { removed_cm3: 28, removed_kg: 0.076, mass_kg: 224.5, points_on_stone: 5, points_missed: 0 }, strikes: 6, pass: 9 },
    { id: 'm14', turn: 16, kind: 'tool', callId: 'c10', tool: 'chisel', args: 'chisel point front (40,63)→(44,63), depth 2, width 3', why: 'Opening the ear.', state: 'error', result: 'The stroke missed the stone at every point: from the front view there is nothing at h 40 to 44. Nothing was cut.' },
    { id: 'm15', turn: 22, kind: 'text', streaming: false, text: 'Now smooth the big masses: head, shoulders, chest.' },
    { id: 'm16', turn: 22, kind: 'tool', callId: 'c11', tool: 'rasp', args: 'rasp front (-24,36)→(24,36)→(26,28)→(-26,28)→(-22,21)→(22,21), width 8, 3×', why: 'Smoothing the chest.', state: 'done', result: 'Rasp from the front view: 3 passes, 204 strokes 8 cm wide, wore off 237 cm³ of high spots. 218.0 kg of stone remains.', numbers: { removed_cm3: 237, removed_kg: 0.642, mass_kg: 218 }, strikes: 205, pass: 28 },
    { id: 'm17', turn: 30, kind: 'budget', level: 'warn75', text: BUDGET_TEXT.warn75 },
    { id: 'm18', turn: 35, kind: 'tool', callId: 'c12', tool: 'finish', args: 'finish "Portrait Head"', state: 'done', result: 'The commission is finished.' }
  ]
}

// One storyboard frame as a view, with content from a real run.
export function mockView(frame: StoryFrame): SculptorView {
  const base = emptyView({ models: MOCK_MODELS })
  if (frame === 1) return base
  const running: SculptorView = { ...beginCommission(base, { commission: MOCK_COMMISSION, model: 'opus', stone: 'carrara' }), notice: null, notebook: mockNotebook(frame) }
  if (frame === 2) {
    return {
      ...running,
      phase: 'carving',
      stats: { ...running.stats, turns: 2, costUsd: 0.05, strikes: 2, elapsedVirtualMs: 41_000 },
      subtitle: { tool: 'sketch', label: 'Sketch', text: MOCK_SKETCHES[2]!.why! },
      sketches: MOCK_SKETCHES
    }
  }
  if (frame === 3) {
    return {
      ...running,
      phase: 'carving',
      stages: stageViews('rough_out'),
      stats: { ...running.stats, massKg: 763.4, removedKg: 212.2, turns: 4, costUsd: 0.1, strikes: 1284, elapsedVirtualMs: 372_000, behindMs: 48_000 },
      subtitle: subtitleForPass({ tool: 'rough_out', args: { to: 'reference', margin_cm: 3, tool: 'point' }, why: 'Knocking the big waste off all round to find the bust\'s envelope, leaving a safe skin.' }, 'rough_out'),
      sketches: MOCK_SKETCHES
    }
  }
  if (frame === 4) {
    const at: SculptorView = {
      ...running,
      phase: 'carving',
      stages: stageViews('block_in'),
      stats: { ...running.stats, massKg: 292.9, removedKg: 682.7, turns: 5, costUsd: 0.11, strikes: 2709, elapsedVirtualMs: 754_000 },
      sketches: MOCK_SKETCHES
    }
    return stageLook(at, LOOK_5)
  }
  return {
    ...running,
    phase: 'finished',
    stages: STAGES.map(id => ({ id, label: STAGE_LABELS[id], state: 'done' as const })),
    stats: { ...running.stats, massKg: 212.6, removedKg: 763, turns: 35, costUsd: 1.07, budget: 'ok', strikes: 10218, elapsedVirtualMs: 3_461_000 },
    transport: { ...running.transport, paused: true },
    eye: { ...LOOK_5, returnTo: null },
    sketches: MOCK_SKETCHES,
    finish: {
      ended: 'finish',
      title: 'Portrait Head',
      statement: 'A bust, head and shoulders, cut from one block of Carrara and standing on a square plinth. The face is set back into the skull, and I kept the features plain so the broad shoulders and steady forward gaze give it its presence.',
      finishedAt: '2026-11-09T12:53:42.628Z'
    }
  }
}
