// The sculptor's loop: look, think, carve, look. It owns the conversation, the notebook, the
// pass record and the budget, and reaches the model and the stone only through the Brain and
// Studio seams, so the same code runs in a browser tab and in the bench.

import { addUsage } from './pricing.ts'
import { buildInstructions } from './prompt.ts'
import { describeCall, parseCall, toolDefs } from './toolSchemas.ts'
import { NUDGE_NO_CALL, budgetStatus, budgetWarning, buildContext, formatNumbers, lookReminder, passLine, resultMessages, toBase64 } from './context.ts'
import type { CallResult, LookSheet } from './context.ts'
import { DEFAULT_CONFIG, LOOK_TOOLS, PASS_TOOLS } from './types.ts'
import type { BrainTurn, BudgetLevel, LookTool, LoopEvent, Message, PassRecord, PassTool, ReferenceMode, RunConfig, RunEnd, RunOptions, RunResult, RunState, StudioResult, ToolCall } from './types.ts'
import type { CloseupArgs, FinishArgs, LookArgs, NoteArgs, SliceArgs } from './toolSchemas.ts'
import { SLICE_VIEW } from '../sculpt/measure.ts'

// The look the loop takes for itself when it rebuilds the context.
const REBUILD_LOOK: LookArgs = { views: ['front', 'right', 'back', 'left', 'top', 'front_right'], overlay: 'grid' }
// Replies in a row with no tool call before the run is stopped rather than left to burn turns.
const MAX_IDLE_TURNS = 3
const LEVELS: BudgetLevel[] = ['ok', 'warn75', 'warn90', 'last']

function named(name: string, message: string): Error {
  const err = new Error(message)
  err.name = name
  return err
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 400)

// Runs `run` under a deadline and the caller's abort signal. Rejects as soon as either fires,
// whether or not `run` honours the signal it is given.
function bounded<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, outer?: AbortSignal): Promise<T> {
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onOuter: (() => void) | undefined
  const stop = new Promise<never>((_, reject) => {
    const fail = (err: Error) => {
      ctrl.abort(err)
      reject(err)
    }
    timer = setTimeout(() => fail(named('TimeoutError', `no answer from the model in ${Math.round(ms / 1000)} s`)), ms)
    onOuter = () => fail(named('AbortError', 'aborted'))
    if (outer?.aborted) onOuter()
    else outer?.addEventListener('abort', onOuter, { once: true })
  })
  return Promise.race([Promise.resolve().then(() => run(ctrl.signal)), stop]).finally(() => {
    clearTimeout(timer)
    if (onOuter) outer?.removeEventListener('abort', onOuter)
  })
}

function hasToolCall(messages: Message[], id: string): boolean {
  return messages.some(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(p => p.type === 'tool-call' && p.toolCallId === id))
}

// The share of a figure or bust commission's turns before finish is accepted (see the guard).
export const FINISH_FLOOR = 0.4

export async function runCommission(opts: RunOptions): Promise<RunResult> {
  const { brain, studio, commission, signal } = opts
  const config: RunConfig = { ...DEFAULT_CONFIG, ...opts.config }
  const emit = (event: LoopEvent) => opts.onEvent?.(event)

  const reference: ReferenceMode = !commission.reference ? 'none' : commission.reference.outlines ? 'outlines' : 'view'
  const defs = toolDefs({ toolSet: config.toolSet, reference })
  const instructions = buildInstructions({ toolSet: config.toolSet, reference, block: config.block, stone: config.stone, maxTurns: config.maxTurns, maxUsd: config.maxUsd, rebuildEvery: config.rebuildEvery })
  // Encoded once, so the reference part is the same bytes in every rebuilt context.
  const referenceB64 = commission.reference ? toBase64(commission.reference.png) : null

  const state: RunState = opts.resume
    ? { turns: opts.resume.turns, passes: opts.resume.passes.slice(), notebook: { ...opts.resume.notebook }, usage: { ...opts.resume.usage }, costUsd: opts.resume.costUsd }
    : { turns: 0, passes: [], notebook: { stage: null, text: '', turn: 0 }, usage: { input: 0, output: 0 }, costUsd: 0 }
  const snapshot = (): RunState => ({ turns: state.turns, passes: state.passes.slice(), notebook: { ...state.notebook }, usage: { ...state.usage }, costUsd: state.costUsd })

  let messages: Message[] = []
  // state.turns when the context was last built; -1 until the first build.
  let builtAt = -1
  // The dearest turn so far: what the loop keeps in hand so the next turn cannot overrun the cap.
  let reserve = state.turns ? state.costUsd / state.turns : 0
  let sinceLook = 0
  let remindAt = config.lookEvery
  let idle = 0
  let finish: RunResult['finish'] = null
  // The finish guard. A figure or a bust (declare_figure, or a head or torso canon) is not
  // accepted as finished before FINISH_FLOOR of the turns, twice at most, while there is money
  // left: models finished at the canon's first form, a third of the way into their budget.
  let refusedFinish = 0
  const figural = (): boolean => state.passes.some(p => p.tool === 'declare_figure'
    || (p.tool === 'declare_form' && Array.isArray(p.args.shapes) && (p.args.shapes as { kind?: string }[]).some(s => s.kind === 'head' || s.kind === 'torso')))
  const finishTooSoon = (turn: number): boolean => config.toolSet === 'formed' && refusedFinish < 2
    && turn < Math.ceil(FINISH_FLOOR * config.maxTurns) && state.costUsd < 0.7 * config.maxUsd && figural()

  const levelNow = (): BudgetLevel => {
    const turnsLeft = config.maxTurns - state.turns
    const usdLeft = config.maxUsd - state.costUsd
    if (turnsLeft <= 1 || usdLeft < 2 * reserve) return 'last'
    const used = Math.max(state.turns / config.maxTurns, state.costUsd / config.maxUsd)
    return used >= 0.9 ? 'warn90' : used >= 0.75 ? 'warn75' : 'ok'
  }
  let level: BudgetLevel = levelNow()

  const end = (ended: RunEnd, error?: string): RunResult => {
    if (error) emit({ type: 'error', turn: state.turns, message: error })
    emit({ type: 'finish', turn: state.turns, ended, title: finish?.title ?? null, statement: finish?.statement ?? null })
    return { ...snapshot(), ended, finish, ...(error ? { error } : {}) }
  }
  const capReached = (): RunEnd => state.turns >= config.maxTurns ? 'turn_cap' : 'cost_cap'

  const rebuild = async () => {
    const reason = builtAt >= 0 ? 'interval' : opts.resume ? 'resume' : 'start'
    const r = await studio.run({ id: `rebuild-${state.turns}`, name: 'look', args: REBUILD_LOOK })
    const images = r.images ?? []
    sinceLook = 0
    remindAt = config.lookEvery
    emit({ type: 'look', turn: state.turns, auto: true, views: REBUILD_LOOK.views, overlay: REBUILD_LOOK.overlay, images, summary: r.summary, numbers: r.numbers })
    messages = buildContext({ commission, referenceB64, state, config, level, reason, look: { summary: r.summary, numbers: r.numbers, images: images.map(toBase64) } })
    builtAt = state.turns
    emit({ type: 'rebuild', turn: state.turns, reason, messages: messages.slice() })
  }

  const ask = async (turn: number): Promise<BrainTurn> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await bounded(
          s => brain.turn({ instructions, messages: messages.slice(), signal: s }, delta => emit({ type: 'text', turn, delta })),
          config.turnTimeoutMs,
          signal
        )
      } catch (err) {
        if (signal?.aborted || attempt >= 1) throw err
        emit({ type: 'turn_retry', turn, error: messageOf(err) })
      }
    }
  }

  while (true) {
    if (signal?.aborted) return end('aborted')
    if (state.turns >= config.maxTurns || state.costUsd >= config.maxUsd) return end(capReached())

    if (builtAt < 0 || state.turns - builtAt >= config.rebuildEvery) {
      try {
        await rebuild()
      } catch (err) {
        return end('error', `could not look at the stone: ${messageOf(err)}`)
      }
      if (signal?.aborted) return end('aborted')
    }

    const turn = state.turns + 1
    const finalTurn = level === 'last'
    emit({ type: 'turn_start', turn })

    let reply: BrainTurn
    try {
      reply = await ask(turn)
      // A turn with no usable price would slip under the spend cap.
      if (!Number.isFinite(reply.costUsd) || reply.costUsd < 0) throw new Error(`the Brain reported a cost of ${reply.costUsd}`)
    } catch (err) {
      if (signal?.aborted) return end('aborted')
      return end('error', messageOf(err))
    }

    state.turns = turn
    state.usage = addUsage(state.usage, reply.usage)
    state.costUsd += reply.costUsd
    reserve = Math.max(reserve, reply.costUsd)

    const said = reply.append.filter(m => m.role === 'assistant')
    if (config.toolResults === 'native') {
      // Every tool result must answer a tool call the provider can see in the history.
      const orphans = reply.calls.filter(c => !hasToolCall(said, c.id))
      if (orphans.length) said.push({ role: 'assistant', content: orphans.map(c => ({ type: 'tool-call' as const, toolCallId: c.id, toolName: c.name, input: c.args })) })
    }
    messages.push(...said)

    const results: CallResult[] = []
    const sheets: LookSheet[] = []
    const notices: string[] = []
    let aborted = false

    for (const call of reply.calls) {
      if (signal?.aborted) {
        aborted = true
        break
      }
      const rawWhy = (call.args as { why?: unknown } | null)?.why
      emit({ type: 'tool_call', turn, call, ...(typeof rawWhy === 'string' ? { why: rawWhy } : {}) })

      const parsed = parseCall(defs, call)
      if (!parsed.ok) {
        results.push({ id: call.id, name: call.name, ok: false, text: parsed.error })
        emit({ type: 'tool_result', turn, call, ok: false, summary: parsed.error, strikes: [], strikeCount: 0 })
        continue
      }
      const valid: ToolCall = { id: call.id, name: parsed.name, args: parsed.args }

      if (parsed.name === 'note') {
        const a = parsed.args as NoteArgs
        state.notebook = { stage: a.stage, text: a.text, turn }
        const summary = `Noted. Stage: ${a.stage}.`
        results.push({ id: call.id, name: call.name, ok: true, text: summary })
        emit({ type: 'note', turn, notebook: { ...state.notebook } })
        emit({ type: 'tool_result', turn, call: valid, ok: true, summary, strikes: [], strikeCount: 0 })
        continue
      }

      if (parsed.name === 'finish' && finishTooSoon(turn)) {
        // The finish guard: a figure or a bust left as the canon first made it is a mannequin.
        refusedFinish++
        const text = `Not finished yet: this is turn ${turn} of ${config.maxTurns}, with $${(config.maxUsd - state.costUsd).toFixed(2)} left. Read the commission again: "${commission.prompt.trim()}". Look from the front, a side and three quarters, close up on the head and the hands, and write in your note what does not yet answer it: the moment and the pose, the face, the hands and feet, the folds of the drapery, the hair, surfaces left raw by the claw. Work on the weakest of those. Call finish again when a look shows nothing left worth a turn.`
        results.push({ id: call.id, name: call.name, ok: false, text })
        emit({ type: 'tool_result', turn, call: valid, ok: false, summary: text, strikes: [], strikeCount: 0 })
        continue
      }

      if (parsed.name === 'finish') {
        const a = parsed.args as FinishArgs
        finish = { title: a.title, statement: a.statement }
        const summary = 'The commission is finished.'
        results.push({ id: call.id, name: call.name, ok: true, text: summary })
        emit({ type: 'tool_result', turn, call: valid, ok: true, summary, strikes: [], strikeCount: 0 })
        // Nothing can be carved after finish; later calls in the same reply are dropped.
        break
      }

      // Not raced against the abort signal: a pass that reached the stone must also reach the
      // record, or a resumed run would rebuild from a record that no longer matches the stone.
      let done: StudioResult
      try {
        done = await studio.run(valid)
      } catch (err) {
        const text = `${describeCall(parsed.name, parsed.args)} was refused: ${messageOf(err)}`
        results.push({ id: call.id, name: call.name, ok: false, text })
        emit({ type: 'tool_result', turn, call: valid, ok: false, summary: text, strikes: [], strikeCount: 0 })
        continue
      }

      const images = done.images ?? []
      let text = [done.summary, formatNumbers(done.numbers)].filter(Boolean).join('\n')
      let pass: PassRecord | undefined

      if (parsed.name === 'look') {
        const a = parsed.args as LookArgs
        sinceLook = 0
        remindAt = config.lookEvery
        if (images.length) {
          text += '\nThe contact sheet is in the next message.'
          sheets.push({ id: call.id, label: `Contact sheet: ${a.views.join(', ')} (${a.overlay} overlay).`, images: images.map(toBase64) })
        }
        emit({ type: 'look', turn, auto: false, views: a.views, overlay: a.overlay, images, summary: done.summary, numbers: done.numbers })
      } else if ((LOOK_TOOLS as readonly string[]).includes(parsed.name)) {
        // A close-up or a slice: an image comes back, but the whole stone has not been seen,
        // so the count of passes since the last look carries on.
        const tool = parsed.name as LookTool
        const view = tool === 'slice' ? SLICE_VIEW[(parsed.args as SliceArgs).axis] : (parsed.args as CloseupArgs).view
        const views = done.views ?? [view]
        const overlay = tool === 'slice' ? 'slice' : tool === 'unfocus' ? 'grid' : (parsed.args as CloseupArgs).overlay
        if (images.length) {
          text += '\nThe image is in the next message.'
          sheets.push({ id: call.id, label: `${describeCall(parsed.name, parsed.args)}.`, images: images.map(toBase64) })
        }
        emit({ type: 'look', turn, auto: false, views, overlay, images, summary: done.summary, numbers: done.numbers, tool, args: parsed.args })
      } else if ((PASS_TOOLS as readonly string[]).includes(parsed.name)) {
        const tool = parsed.name as PassTool
        const n = state.passes.length + 1
        pass = {
          n,
          turn,
          tool,
          args: parsed.args,
          why: typeof parsed.args.why === 'string' ? parsed.args.why : '',
          line: passLine(n, turn, tool, parsed.args, done.summary, done.strikes.length),
          summary: done.summary,
          ...(done.numbers ? { numbers: done.numbers } : {}),
          strikes: done.strikes.length
        }
        state.passes.push(pass)
        // Declaring a form and drawing a line change nothing a look would show differently.
        if (tool !== 'declare_form' && tool !== 'declare_figure' && tool !== 'sketch') sinceLook++
      }

      results.push({ id: call.id, name: call.name, ok: true, text })
      emit({ type: 'tool_result', turn, call: valid, ok: true, summary: done.summary, numbers: done.numbers, strikes: done.strikes, strikeCount: done.strikes.length, ...(pass ? { pass } : {}) })
    }

    emit({ type: 'turn_end', turn, calls: reply.calls.length, usage: reply.usage, costUsd: reply.costUsd, state: snapshot() })

    if (finish) return end('finish')
    if (aborted || signal?.aborted) return end('aborted')

    if (!reply.calls.length) {
      idle++
      notices.push(NUDGE_NO_CALL)
    } else {
      idle = 0
    }

    const before = level
    level = levelNow()
    // Levels only climb: a cheap turn after a warning does not take the warning back.
    if (LEVELS.indexOf(level) < LEVELS.indexOf(before)) level = before
    emit({ type: 'budget', turn, turns: state.turns, maxTurns: config.maxTurns, costUsd: state.costUsd, maxUsd: config.maxUsd, level })

    if (finalTurn || state.turns >= config.maxTurns || state.costUsd >= config.maxUsd) return end(capReached())
    if (idle >= MAX_IDLE_TURNS) return end('stalled')

    if (sinceLook >= remindAt) {
      notices.push(lookReminder(sinceLook))
      remindAt = sinceLook + config.lookEvery
    }
    if (level !== before) notices.push(budgetWarning(level, state, config))

    const status = budgetStatus(state, config)
    const last = results[results.length - 1]
    if (last) last.text += `\n${status}`
    else notices.push(status)

    messages.push(...resultMessages(results, sheets, notices, config.toolResults))
  }
}
