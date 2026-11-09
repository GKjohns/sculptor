/**
 * The sculptor's loop, driven by a scripted Brain against a fake Studio: endings, budget caps
 * and warnings, the context's shape between and across rebuilds, error results, abort. Also the
 * price table and the tool schemas the loop depends on. No model is called.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toBase64 } from '../shared/agent/context.ts'
import { runCommission } from '../shared/agent/loop.ts'
import { MODELS, costUsd, resolveModel } from '../shared/agent/pricing.ts'
import { buildInstructions } from '../shared/agent/prompt.ts'
import { jsonTools, parseCall, sdkTools, toolDefs } from '../shared/agent/toolSchemas.ts'
import type { Brain, LoopEvent, Message, RunConfig, Studio, StudioResult, ToolCall } from '../shared/agent/types.ts'

const CHISEL = { tool: 'flat', view: 'front', path: [{ h: -10, v: 60 }, { h: 10, v: 62 }], depth_cm: 1, width_cm: 3, protect: 'none', why: 'Flattening the brow.' }
const SAW = { view: 'front', from: { h: -30, v: 80 }, to: { h: -10, v: 100 }, discard: 'above', why: 'Taking the corner off above the shoulder.' }
const LOOK = { views: ['front', 'right'], overlay: 'grid' }
const NOTE = { stage: 'rough_out', text: 'A cat lying like a loaf. Head centred at X0 Y78 Z4.' }
const FINISH = { title: 'Loaf', statement: 'A cat at rest.' }

const chisel = { name: 'chisel', args: CHISEL }
const look = { name: 'look', args: LOOK }

const SHEET = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5])
const REFERENCE = new Uint8Array([137, 80, 78, 71, 9, 8, 7])

interface Step { text?: string, calls?: { name: string, args: unknown }[], costUsd?: number }
type Script = (turn: number) => Step | Promise<Step>

// Answers each turn from a script, with a proper assistant message, and keeps what it was sent.
function scriptedBrain(script: Script) {
  const seen: Message[][] = []
  const brain: Brain = {
    async turn(input, onText) {
      seen.push(input.messages)
      const turn = seen.length
      const step = await script(turn)
      const calls: ToolCall[] = (step.calls ?? []).map((c, i) => ({ id: `t${turn}c${i}`, name: c.name, args: c.args }))
      if (step.text) onText(step.text)
      const content = [
        ...(step.text ? [{ type: 'text' as const, text: step.text }] : []),
        ...calls.map(c => ({ type: 'tool-call' as const, toolCallId: c.id, toolName: c.name, input: c.args }))
      ]
      return { calls, append: [{ role: 'assistant', content }], usage: { input: 1000, output: 100, cacheRead: 800 }, costUsd: step.costUsd ?? 0.01 }
    }
  }
  return { brain, seen }
}

function fakeStudio() {
  const calls: ToolCall[] = []
  const studio: Studio = {
    async run(call): Promise<StudioResult> {
      calls.push(call)
      if (call.name === 'look') return { summary: 'The stone from the views asked for.', numbers: { mass_kg: 900.5 }, images: [SHEET], strikes: [] }
      if (call.name === 'closeup' || call.name === 'slice') return { summary: `A ${call.name}.`, numbers: { relief_cm: 3 }, images: [SHEET], strikes: [] }
      if (call.name === 'sketch') return { summary: 'Drew a line.', strikes: [{ kind: 'sketch', view: 'front', points: [[0, 0], [1, 1]], strokes: [], ms: 600 }] }
      if (call.name === 'rough_out' && (call.args as { to: string }).to === 'missing') throw new Error('no form named "missing"')
      return { summary: 'Removed 120 cm³. Hit the stone at (0, 61, 30).', numbers: { removed_cm3: 120 }, strikes: [{ kind: 'detach' }, { kind: 'detach' }] }
    }
  }
  return { studio, calls }
}

function run(script: Script, config: Partial<RunConfig> = {}, extra: Partial<Parameters<typeof runCommission>[0]> = {}) {
  const { brain, seen } = scriptedBrain(script)
  const { studio, calls } = fakeStudio()
  const events: LoopEvent[] = []
  const done = runCommission({ brain, studio, commission: { prompt: 'A cat, loafing.' }, config, onEvent: e => events.push(e), ...extra })
  return { done, seen, calls, events }
}

// Every piece of text the model would read in these messages.
function textOf(messages: Message[]): string {
  const out: string[] = []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push(m.content)
      continue
    }
    for (const p of m.content) {
      if (p.type === 'text') out.push(p.text)
      else if (p.type === 'tool-result' && 'value' in p.output && typeof p.output.value === 'string') out.push(p.output.value)
    }
  }
  return out.join('\n')
}

function parts(m: Message | undefined) {
  assert.ok(m && Array.isArray(m.content))
  return m.content as { type: string, [k: string]: unknown }[]
}

const types = (events: LoopEvent[]) => events.map(e => e.type)

test('a normal run ends in finish with the pass record, notebook and totals', async () => {
  const { done, seen, calls, events } = run((turn) => {
    if (turn === 1) return { text: 'I see a loaf.', calls: [{ name: 'note', args: NOTE }] }
    if (turn === 2) return { calls: [look] }
    if (turn === 3) return { calls: [{ name: 'saw', args: SAW }] }
    if (turn === 4) return { calls: [chisel, look] }
    return { calls: [{ name: 'finish', args: FINISH }] }
  })
  const r = await done

  assert.equal(r.ended, 'finish')
  assert.deepEqual(r.finish, FINISH)
  assert.equal(r.turns, 5)
  assert.ok(Math.abs(r.costUsd - 0.05) < 1e-9)
  assert.deepEqual(r.usage, { input: 5000, output: 500, cacheRead: 4000, cacheWrite: 0, reasoning: 0 })
  assert.deepEqual(r.notebook, { stage: 'rough_out', text: NOTE.text, turn: 1 })

  assert.equal(r.passes.length, 2)
  const [saw, cut] = r.passes
  assert.deepEqual([saw!.n, saw!.turn, saw!.tool, saw!.strikes], [1, 3, 'saw', 2])
  assert.equal(saw!.why, SAW.why)
  assert.deepEqual(saw!.args, SAW)
  assert.equal(saw!.line, '1. turn 3: saw front (-30,80)→(-10,100), discard above — "Taking the corner off above the shoulder." → Removed 120 cm³. Hit the stone at (0, 61, 30). (2 strikes)')
  assert.deepEqual([cut!.n, cut!.turn, cut!.tool], [2, 4, 'chisel'])

  // The Studio sees the stone tools only, in order; note and finish stay in the loop. The first
  // look is the loop's own, for the opening context.
  assert.deepEqual(calls.map(c => c.name), ['look', 'look', 'saw', 'chisel', 'look'])
  assert.equal(calls[0]!.id, 'rebuild-0')
  assert.equal(seen.length, 5)

  const t = types(events)
  assert.equal(t.at(-1), 'finish')
  assert.equal(t.filter(x => x === 'turn_start').length, 5)
  assert.equal(t.filter(x => x === 'turn_end').length, 5)
  assert.deepEqual(events.filter(e => e.type === 'text').map(e => e.type === 'text' && e.delta), ['I see a loaf.'])
  assert.equal(events.filter(e => e.type === 'look' && !e.auto).length, 2)
  assert.equal(events.filter(e => e.type === 'look' && e.auto).length, 1)
  assert.equal(events.filter(e => e.type === 'note').length, 1)
  const sawResult = events.find(e => e.type === 'tool_result' && e.call.name === 'saw')
  assert.ok(sawResult && sawResult.type === 'tool_result')
  assert.equal(sawResult.strikeCount, 2)
  assert.equal(sawResult.strikes.length, 2)
  assert.deepEqual(sawResult.numbers, { removed_cm3: 120 })
  assert.equal(sawResult.pass?.n, 1)
  const sawCall = events.find(e => e.type === 'tool_call' && e.call.name === 'saw')
  assert.ok(sawCall && sawCall.type === 'tool_call')
  assert.equal(sawCall.why, SAW.why)
  const last = events.at(-1)
  assert.ok(last && last.type === 'finish')
  assert.deepEqual([last.ended, last.title, last.statement], ['finish', 'Loaf', 'A cat at rest.'])

  // The state on the last turn_end is what a session would save.
  const saved = events.filter(e => e.type === 'turn_end').at(-1)
  assert.ok(saved && saved.type === 'turn_end')
  assert.equal(saved.state.passes.length, 2)
  assert.equal(saved.state.turns, 5)
})

test('several calls in one turn run in order and are answered in one tool message', async () => {
  const { done, seen, calls } = run((turn) => {
    if (turn === 1) return { calls: [chisel, look, { name: 'saw', args: SAW }] }
    return { calls: [{ name: 'finish', args: FINISH }, chisel] }
  })
  const r = await done
  // The chisel sent after finish is dropped.
  assert.deepEqual(calls.map(c => c.name), ['look', 'chisel', 'look', 'saw'])
  assert.equal(r.passes.length, 2)
  const second = seen[1]!
  const tool = second.find(m => m.role === 'tool')
  assert.deepEqual(parts(tool).map(p => p.toolCallId), ['t1c0', 't1c1', 't1c2'])
})

test('the turn cap forces a clean end, after telling the model its last turn has come', async () => {
  const { done, seen, events } = run(() => ({ calls: [chisel] }), { maxTurns: 6, lookEvery: 99 })
  const r = await done
  assert.equal(r.ended, 'turn_cap')
  assert.equal(r.turns, 6)
  assert.equal(r.finish, null)
  assert.equal(r.passes.length, 6)
  assert.equal(seen.length, 6)
  assert.ok(!textOf(seen[4]!).includes('FINAL TURN'))
  assert.match(textOf(seen[5]!), /FINAL TURN.*Call finish now/s)
  const last = events.at(-1)
  assert.ok(last && last.type === 'finish')
  assert.deepEqual([last.ended, last.title], ['turn_cap', null])
})

test('the dollar cap stops the run without overspending', async () => {
  const { done, seen, events } = run(() => ({ calls: [chisel], costUsd: 1 }), { maxUsd: 5, lookEvery: 99 })
  const r = await done
  assert.equal(r.ended, 'cost_cap')
  assert.equal(r.turns, 5)
  assert.ok(r.costUsd <= 5)
  assert.match(textOf(seen[4]!), /FINAL TURN/)
  assert.ok(!textOf(seen[3]!).includes('FINAL TURN'))
  const levels = events.filter(e => e.type === 'budget').map(e => e.type === 'budget' && e.level)
  assert.deepEqual(levels, ['ok', 'ok', 'ok', 'last', 'last'])
})

test('a turn that overshoots the dollar cap is the last', async () => {
  const { done } = run(() => ({ calls: [chisel], costUsd: 3 }), { maxUsd: 2 })
  const r = await done
  assert.equal(r.ended, 'cost_cap')
  assert.equal(r.turns, 1)
})

test('budget warnings appear in the context at 75% and 90%, once each', async () => {
  const { done, seen } = run(() => ({ calls: [chisel] }), { maxTurns: 20, lookEvery: 99 })
  const r = await done
  assert.equal(r.ended, 'turn_cap')
  const said = (turn: number) => textOf(seen[turn - 1]!)
  assert.ok(!said(15).includes('BUDGET WARNING'))
  assert.match(said(16), /three quarters of your budget is gone \(15 of 20 turns used/)
  assert.ok(!said(18).includes('nine tenths'))
  assert.match(said(19), /nine tenths of your budget is gone/)
  assert.match(said(20), /FINAL TURN/)
  assert.equal(said(20).match(/three quarters/g)?.length, 1)
  assert.equal(said(20).match(/nine tenths/g)?.length, 1)
  // Every result carries the running totals.
  assert.match(said(2), /\[1 of 20 turns used, \$0\.01 of \$8\.00 spent\]/)
})

test('a rebuild keeps the current budget warning', async () => {
  const { done, seen } = run(() => ({ calls: [chisel] }), { maxTurns: 24, lookEvery: 99 })
  await done
  assert.equal(seen[20]!.length, 1)
  assert.match(textOf(seen[20]!), /three quarters of your budget is gone/)
})

test('the context is append-only for 20 turns, then rebuilt from notebook, record and a fresh look', async () => {
  const { done, seen, calls, events } = run((turn) => {
    if (turn === 1) return { calls: [{ name: 'note', args: NOTE }] }
    if (turn === 23) return { calls: [{ name: 'finish', args: FINISH }] }
    return { calls: turn % 4 === 0 ? [look] : [chisel] }
  }, { maxTurns: 50 }, { commission: { prompt: 'A cat, loafing.', reference: { png: REFERENCE, outlines: true } } })
  const r = await done
  assert.equal(r.ended, 'finish')

  // Turn 1: the opening context is one user message.
  assert.equal(seen[0]!.length, 1)
  // Turns 2 to 20: each context starts with the whole of the one before.
  for (let i = 1; i < 20; i++) {
    assert.ok(seen[i]!.length > seen[i - 1]!.length)
    assert.deepEqual(seen[i]!.slice(0, seen[i - 1]!.length), seen[i - 1])
  }
  assert.ok(seen[19]!.length >= 39)

  // Turn 21: rebuilt.
  const rebuilt = seen[20]!
  assert.equal(rebuilt.length, 1)
  assert.equal(rebuilt[0]!.role, 'user')
  const p = parts(rebuilt[0])
  assert.deepEqual(p.map(x => x.type), ['text', 'text', 'file', 'text', 'file', 'text'])
  assert.match(p[0]!.text as string, /^COMMISSION\nA cat, loafing\.$/)
  assert.match(p[1]!.text as string, /^REFERENCE SHEET/)
  assert.deepEqual(p[2], { type: 'file', mediaType: 'image/png', data: { type: 'data', data: Buffer.from(REFERENCE).toString('base64') } })
  assert.deepEqual(p[4], { type: 'file', mediaType: 'image/png', data: { type: 'data', data: Buffer.from(SHEET).toString('base64') } })
  assert.match(p[5]!.text as string, /earlier messages have been cleared/)

  const body = p[3]!.text as string
  const order = ['NOTEBOOK', 'PASSES SO FAR', 'BUDGET', 'THE STONE NOW'].map(h => body.indexOf(h))
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!)))
  assert.ok(body.includes(`Stage: rough_out\n${NOTE.text}`))
  // Turns 2 to 20 held 5 looks and 14 chisel passes; every pass is one line in the record.
  const madeBy20 = r.passes.filter(x => x.turn <= 20)
  assert.equal(madeBy20.length, 14)
  assert.ok(body.includes('PASSES SO FAR (14)'))
  for (const pass of madeBy20) assert.ok(body.includes(pass.line))
  assert.ok(body.includes('[20 of 50 turns used'))
  assert.ok(body.includes('mass_kg 900.5'))

  // The parts before the notebook are identical in the opening and the rebuilt context, so the
  // cached prefix (instructions, commission, reference) survives the rebuild.
  assert.deepEqual(p.slice(0, 3), parts(seen[0]![0]).slice(0, 3))

  // The rebuild took its own six-view look, and the history grows again afterwards.
  const own = calls.find(c => c.id === 'rebuild-20')
  assert.deepEqual(own?.args, { views: ['front', 'right', 'back', 'left', 'top', 'front_right'], overlay: 'grid' })
  assert.deepEqual(seen[21]!.slice(0, 1), rebuilt)
  assert.ok(seen[21]!.length > 1)
  assert.deepEqual(events.filter(e => e.type === 'rebuild').map(e => e.type === 'rebuild' && [e.turn, e.reason]), [[0, 'start'], [20, 'interval']])
  assert.equal(r.passes.length, 16)
  assert.equal(r.notebook.text, NOTE.text)
})

test('a look\'s image arrives as a user message after the tool result, never inside it', async () => {
  const { done, seen } = run(turn => turn === 1 ? { calls: [look] } : { calls: [{ name: 'finish', args: FINISH }] })
  await done
  const ctx = seen[1]!
  assert.deepEqual(ctx.map(m => m.role), ['user', 'assistant', 'tool', 'user'])
  const result = parts(ctx[2])
  assert.equal(result.length, 1)
  const output = result[0]!.output as { type: string, value: string }
  assert.equal(output.type, 'text')
  assert.match(output.value, /The stone from the views asked for\.\nNumbers: mass_kg 900\.5\.\nThe contact sheet is in the next message\./)
  const after = parts(ctx[3])
  assert.deepEqual(after.map(x => x.type), ['text', 'file'])
  assert.equal(after[0]!.text, 'Contact sheet: front, right (grid overlay).')
  assert.deepEqual(after[1], { type: 'file', mediaType: 'image/png', data: { type: 'data', data: Buffer.from(SHEET).toString('base64') } })
  // JSON-safe, so the browser can post it to the brain route.
  assert.deepEqual(JSON.parse(JSON.stringify(ctx)), ctx)
})

test('invalid arguments come back as an error result and nothing is cut', async () => {
  const { done, seen, calls, events } = run((turn) => {
    if (turn === 1) return { calls: [{ name: 'chisel', args: { ...CHISEL, view: 'front_left', path: [{ h: 1 }] } }] }
    if (turn === 2) return { calls: [{ name: 'glue', args: {} }, { name: 'rough_out', args: { to: 'missing', margin_cm: 3, tool: 'point', why: 'Roughing.' } }] }
    return { calls: [{ name: 'finish', args: FINISH }] }
  })
  const r = await done

  const first = parts(seen[1]!.at(-1))[0]!.output as { type: string, value: string }
  assert.equal(first.type, 'error-text')
  assert.match(first.value, /^Invalid arguments for chisel: view: .*path\.0\.v: .*Nothing was done/s)

  const second = parts(seen[2]!.at(-1))
  const [unknown, refused] = second.map(x => x.output as { type: string, value: string })
  assert.equal(unknown!.type, 'error-text')
  assert.match(unknown!.value, /no tool called "glue".*Your tools: look, closeup, slice, focus, unfocus, sketch, declare_form, rough_out, detail, saw, chisel, drill, rasp, polish, note, finish/)
  // The Studio's own refusal reaches the model the same way.
  assert.equal(refused!.type, 'error-text')
  assert.match(refused!.value, /rough_out to "missing".* was refused: no form named "missing"/)

  assert.deepEqual(calls.map(c => c.name), ['look', 'rough_out'])
  assert.equal(r.passes.length, 0)
  assert.equal(events.filter(e => e.type === 'tool_result' && !e.ok).length, 3)
  assert.equal(r.ended, 'finish')
})

test('the direct tool set refuses the formed tools', async () => {
  const { done, seen, calls } = run((turn) => {
    if (turn === 1) return { calls: [{ name: 'rough_out', args: { to: 'cat', margin_cm: 3, tool: 'point', why: 'Roughing.' } }, { name: 'look', args: { views: ['front'], overlay: 'form' } }] }
    return { calls: [{ name: 'finish', args: FINISH }] }
  }, { toolSet: 'direct' })
  await done
  const [a, b] = parts(seen[1]!.find(m => m.role === 'tool')).map(x => x.output as { type: string, value: string })
  assert.match(a!.value, /Your tools: look, saw, chisel, note, finish/)
  assert.match(b!.value, /Invalid arguments for look: overlay/)
  assert.deepEqual(calls.map(c => c.name), ['look'])
})

test('a reply with no tool call is nudged, and three in a row stop the run', async () => {
  const nudged = run(turn => turn === 1 ? { text: 'Let me think.' } : { calls: [{ name: 'finish', args: FINISH }] })
  const r = await nudged.done
  assert.equal(r.ended, 'finish')
  assert.equal(r.turns, 2)
  const ctx = nudged.seen[1]!
  assert.deepEqual(ctx.map(m => m.role), ['user', 'assistant', 'user'])
  assert.match(textOf(ctx.slice(2)), /called no tool.*\[1 of 60 turns used/s)

  const stalled = run(() => ({ text: 'Hm.' }))
  const s = await stalled.done
  assert.equal(s.ended, 'stalled')
  assert.equal(s.turns, 3)
})

test('the model is reminded to look after several passes without one', async () => {
  const { done, seen } = run(turn => turn === 4 ? { calls: [{ name: 'finish', args: FINISH }] } : { calls: [chisel, chisel] }, { lookEvery: 4 })
  await done
  assert.ok(!textOf(seen[1]!).includes('since you last looked'))
  assert.match(textOf(seen[2]!), /You have made 4 passes since you last looked/)
})

test('a close-up or a slice sends its image back but does not count as a look; a sketch is recorded and is not a cut', async () => {
  const CLOSEUP = { view: 'front', center: { h: 0, v: 60 }, span_cm: 20, overlay: 'grid' }
  const SKETCH = { view: 'front', path: [{ h: -5, v: 50 }, { h: 5, v: 50 }], why: 'Marking the brow line.' }
  const { done, seen, calls, events } = run((turn) => {
    if (turn === 1) return { calls: [{ name: 'sketch', args: SKETCH }, chisel, chisel, { name: 'closeup', args: CLOSEUP }, { name: 'slice', args: { axis: 'x', at_cm: 0 } }] }
    if (turn === 2) return { calls: [chisel, chisel] }
    return { calls: [{ name: 'finish', args: FINISH }] }
  }, { lookEvery: 4 })
  const r = await done
  assert.deepEqual(calls.map(c => c.name), ['look', 'sketch', 'chisel', 'chisel', 'closeup', 'slice', 'chisel', 'chisel'])

  // Both images follow the results in one user message, each under its own label.
  const after = parts(seen[1]!.at(-1))
  assert.deepEqual(after.map(x => x.type), ['text', 'file', 'text', 'file'])
  assert.equal(after[0]!.text, 'closeup front at (0,60), 20 cm across (grid).')
  assert.equal(after[2]!.text, 'slice at X 0.')
  assert.match(textOf(seen[1]!), /A closeup\.\nNumbers: relief_cm 3\.\nThe image is in the next message\./)
  const looks = events.filter(e => e.type === 'look' && !e.auto)
  assert.deepEqual(looks.map(e => e.type === 'look' && [e.tool, e.views, e.overlay]), [['closeup', ['front'], 'grid'], ['slice', ['left'], 'slice']])
  assert.ok(looks.every(e => e.type === 'look' && e.images.length === 1))
  assert.deepEqual(looks.map(e => e.type === 'look' && e.args), [CLOSEUP, { axis: 'x', at_cm: 0 }])

  // Neither is a look at the whole stone, and the sketch is not a cut: four cuts, then the reminder.
  assert.ok(!textOf(seen[1]!).includes('since you last looked'))
  assert.match(textOf(seen[2]!), /You have made 4 passes since you last looked/)
  // The sketch is in the pass record, so a rebuilt context still knows of the line.
  assert.deepEqual(r.passes.map(p => p.tool), ['sketch', 'chisel', 'chisel', 'chisel', 'chisel'])
  assert.match(r.passes[0]!.line, /^1\. turn 1: sketch front \(-5,50\)→\(5,50\) — "Marking the brow line\." → Drew a line\. \(1 strikes\)$/)
})

test('a failed turn is retried once, and a second failure is surfaced with the state intact', async () => {
  let fails = 1
  const once = run((turn) => {
    if (turn === 2 && fails-- > 0) throw new Error('gateway 503')
    return { calls: turn >= 3 ? [{ name: 'finish', args: FINISH }] : [chisel] }
  })
  const r = await once.done
  assert.equal(r.ended, 'finish')
  assert.deepEqual(once.events.filter(e => e.type === 'turn_retry').map(e => e.type === 'turn_retry' && [e.turn, e.error]), [[2, 'gateway 503']])

  const twice = run((turn) => {
    if (turn >= 2) throw new Error('gateway 503')
    return { calls: [chisel] }
  })
  const f = await twice.done
  assert.equal(f.ended, 'error')
  assert.equal(f.error, 'gateway 503')
  assert.equal(f.turns, 1)
  assert.equal(f.passes.length, 1)
  assert.equal(twice.seen.length, 3)
  assert.deepEqual(types(twice.events).slice(-2), ['error', 'finish'])
})

test('a turn that misses its deadline is retried', async () => {
  let hung = false
  const { done, events } = run((turn) => {
    if (turn === 1 && !hung) {
      hung = true
      return new Promise<Step>(() => {})
    }
    return { calls: [{ name: 'finish', args: FINISH }] }
  }, { turnTimeoutMs: 30 })
  const r = await done
  assert.equal(r.ended, 'finish')
  const retry = events.find(e => e.type === 'turn_retry')
  assert.ok(retry && retry.type === 'turn_retry')
  assert.match(retry.error, /no answer from the model/)
})

test('abort stops promptly, even when the Brain ignores its signal', async () => {
  const ctrl = new AbortController()
  const started = Date.now()
  const { done, seen } = run(turn => turn === 1 ? { calls: [chisel] } : new Promise<Step>(() => {}), {}, { signal: ctrl.signal })
  setTimeout(() => ctrl.abort(), 20)
  const r = await done
  assert.equal(r.ended, 'aborted')
  assert.ok(Date.now() - started < 1000)
  assert.equal(seen.length, 2)
  // What was carved before the stop is kept.
  assert.equal(r.turns, 1)
  assert.equal(r.passes.length, 1)
})

test('abort between tool calls keeps the pass that reached the stone and runs no more', async () => {
  const ctrl = new AbortController()
  const { brain, seen } = scriptedBrain(() => ({ calls: [chisel, chisel, chisel] }))
  const { studio, calls } = fakeStudio()
  const r = await runCommission({
    brain,
    studio,
    commission: { prompt: 'A cat.' },
    signal: ctrl.signal,
    onEvent: (e) => {
      if (e.type === 'tool_result') ctrl.abort()
    }
  })
  assert.equal(r.ended, 'aborted')
  assert.equal(r.passes.length, 1)
  assert.deepEqual(calls.map(c => c.name), ['look', 'chisel'])
  assert.equal(seen.length, 1)
})

test('a resumed run rebuilds its context from the saved state and carries the totals on', async () => {
  const first = run(turn => turn === 1 ? { calls: [{ name: 'note', args: NOTE }] } : { calls: [chisel] }, { maxTurns: 3 })
  const saved = await first.done
  assert.equal(saved.ended, 'turn_cap')

  const second = run(turn => turn === 1 ? { calls: [chisel] } : { calls: [{ name: 'finish', args: FINISH }] }, {}, { resume: saved })
  const r = await second.done
  assert.equal(r.ended, 'finish')
  assert.equal(r.turns, 5)
  assert.equal(r.passes.length, 3)
  assert.deepEqual(r.passes.map(p => [p.n, p.turn]), [[1, 2], [2, 3], [3, 4]])
  assert.ok(Math.abs(r.costUsd - 0.05) < 1e-9)
  // The saved state was not touched.
  assert.equal(saved.passes.length, 2)

  const ctx = second.seen[0]!
  assert.equal(ctx.length, 1)
  const said = textOf(ctx)
  assert.ok(said.includes(NOTE.text))
  assert.ok(said.includes(saved.passes[0]!.line) && said.includes(saved.passes[1]!.line))
  assert.match(said, /earlier messages have been cleared/)
  assert.deepEqual(second.events.filter(e => e.type === 'turn_start').map(e => e.turn), [4, 5])
  assert.deepEqual(second.events.filter(e => e.type === 'rebuild').map(e => e.type === 'rebuild' && e.reason), ['resume'])
})

test('text-mode results go back as plain user text for a JSON-lines Brain', async () => {
  const seen: Message[][] = []
  const brain: Brain = {
    async turn(input) {
      seen.push(input.messages)
      const calls = seen.length === 1 ? [{ id: 'a', name: 'chisel', args: CHISEL }] : [{ id: 'b', name: 'finish', args: FINISH }]
      return { calls, append: [{ role: 'assistant', content: '[{"tool": "..."}]' }], usage: { input: 1, output: 1 }, costUsd: 0 }
    }
  }
  const r = await runCommission({ brain, studio: fakeStudio().studio, commission: { prompt: 'A cat.' }, config: { toolResults: 'text' } })
  assert.equal(r.ended, 'finish')
  assert.deepEqual(seen[1]!.map(m => m.role), ['user', 'assistant', 'user'])
  assert.match(textOf(seen[1]!.slice(2)), /^RESULTS\nchisel: Removed 120 cm³/)
})

test('a Brain that returns calls without their assistant message still leaves a valid history', async () => {
  const seen: Message[][] = []
  const brain: Brain = {
    async turn(input) {
      seen.push(input.messages)
      const calls = seen.length === 1 ? [{ id: 'a', name: 'chisel', args: CHISEL }] : [{ id: 'b', name: 'finish', args: FINISH }]
      // A tool message from the SDK for a call it could not parse must not be answered twice.
      return { calls, append: [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'chisel', output: { type: 'error-text', value: 'x' } }] }], usage: { input: 1, output: 1 }, costUsd: 0 }
    }
  }
  await runCommission({ brain, studio: fakeStudio().studio, commission: { prompt: 'A cat.' } })
  const ctx = seen[1]!
  assert.deepEqual(ctx.map(m => m.role), ['user', 'assistant', 'tool'])
  assert.equal(parts(ctx[1])[0]!.toolCallId, 'a')
  assert.equal((parts(ctx[2])[0]!.output as { type: string }).type, 'text')
})

test('a Brain that reports no cost cannot slip under the spend cap', async () => {
  const brain: Brain = { turn: async () => ({ calls: [], append: [], usage: { input: 1, output: 1 }, costUsd: Number.NaN }) }
  const r = await runCommission({ brain, studio: fakeStudio().studio, commission: { prompt: 'A cat.' } })
  assert.equal(r.ended, 'error')
  assert.match(r.error!, /cost of NaN/)
})

test('prices: cached input, reasoning, images, and an unknown model throws', () => {
  assert.equal(costUsd('opus', { input: 1_000_000, output: 0 }), 4)
  assert.equal(costUsd(MODELS.opus, { input: 1_000_000, output: 100_000 }), 6)
  // 100k plain at $4, 800k read at $0.20, 100k written at $5.
  assert.ok(Math.abs(costUsd('opus', { input: 1_000_000, output: 0, cacheRead: 800_000, cacheWrite: 100_000 }) - 1.06) < 1e-9)
  // Gemini lists no cache-write price: written tokens are plain input.
  assert.ok(Math.abs(costUsd('gemini', { input: 1_000_000, output: 0, cacheWrite: 500_000 }) - 2) < 1e-9)
  // Reasoning inside output is not charged twice; reasoning reported apart is charged.
  assert.equal(costUsd('sol', { input: 0, output: 1_000_000, reasoning: 400_000 }), 10)
  assert.equal(costUsd('sol', { input: 0, output: 100_000, reasoning: 400_000 }), 5)
  assert.ok(Math.abs(costUsd('image', { input: 1000, output: 0 }, 1) - 0.0341) < 1e-9)

  assert.throws(() => costUsd('openai/gpt-6-astra', { input: 1, output: 1 }), /no price for model/)
  assert.throws(() => costUsd('toString', { input: 1, output: 1 }), /no price for model/)
  assert.throws(() => resolveModel('mystery'), /no price for model/)
  assert.equal(resolveModel('fable'), 'anthropic/claude-fable-5.1')
  for (const id of Object.values(MODELS)) assert.ok(costUsd(id, { input: 1000, output: 1000 }) > 0)
})

test('tool schemas are flat: no unions, nothing optional, and the right tools per set', () => {
  const direct = jsonTools({ toolSet: 'direct', reference: 'none' })
  const formed = jsonTools({ toolSet: 'formed', reference: 'outlines' })
  assert.deepEqual(direct.map(t => t.name), ['look', 'saw', 'chisel', 'note', 'finish'])
  assert.deepEqual(formed.map(t => t.name), ['look', 'closeup', 'slice', 'focus', 'unfocus', 'sketch', 'declare_form', 'rough_out', 'detail', 'saw', 'chisel', 'drill', 'rasp', 'polish', 'note', 'finish'])

  const walk = (node: unknown, at: string) => {
    if (!node || typeof node !== 'object') return
    const o = node as Record<string, unknown>
    for (const banned of ['anyOf', 'oneOf', 'allOf', '$ref', '$defs', '$schema']) assert.ok(!(banned in o), `${at} has ${banned}`)
    if (o.type === 'object') {
      const props = Object.keys(o.properties as object)
      assert.deepEqual([...(o.required as string[])].sort(), [...props].sort(), `${at} has optional fields`)
      for (const k of props) walk((o.properties as Record<string, unknown>)[k], `${at}.${k}`)
    }
    if (o.type === 'array') walk(o.items, `${at}[]`)
  }
  for (const t of formed) walk(t.parameters, t.name)

  const overlay = (tools: typeof direct) => ((tools[0]!.parameters.properties as Record<string, { enum: string[] }>).overlay!).enum
  assert.deepEqual(overlay(direct), ['grid'])
  assert.deepEqual(overlay(formed), ['grid', 'form', 'reference'])
  assert.deepEqual(overlay(jsonTools({ toolSet: 'formed', reference: 'view' })), ['grid', 'form'])

  // Every carving tool asks for a why; points are {h, v}; only axis views can be carved from.
  for (const name of ['sketch', 'declare_form', 'rough_out', 'detail', 'saw', 'chisel', 'drill', 'rasp', 'polish']) {
    const t = formed.find(x => x.name === name)!
    assert.ok((t.parameters.required as string[]).includes('why'), name)
  }
  const sawProps = formed.find(t => t.name === 'saw')!.parameters.properties as Record<string, { enum?: string[], required?: string[] }>
  assert.deepEqual(sawProps.view!.enum, ['front', 'back', 'right', 'left', 'top'])
  assert.deepEqual(sawProps.from!.required, ['h', 'v'])

  const sdk = sdkTools({ toolSet: 'direct', reference: 'none' })
  assert.deepEqual(Object.keys(sdk), ['look', 'saw', 'chisel', 'note', 'finish'])
  for (const t of Object.values(sdk)) assert.ok(t.description && t.inputSchema && !('execute' in t))
})

test('parseCall rejects a saw line with no such side, a reserved form name, and reads string arguments', () => {
  const defs = toolDefs({ toolSet: 'formed', reference: 'none' })
  const saw = (over: object) => parseCall(defs, { id: 'x', name: 'saw', args: { ...SAW, ...over } })
  assert.ok(saw({}).ok)
  const level = saw({ from: { h: -30, v: 80 }, to: { h: 30, v: 80 }, discard: 'left' })
  assert.ok(!level.ok && /horizontal line has no left or right/.test(level.error))
  const plumb = saw({ from: { h: 5, v: 0 }, to: { h: 5, v: 100 }, discard: 'above' })
  assert.ok(!plumb.ok && /vertical line has no above or below/.test(plumb.error))
  const same = saw({ to: SAW.from })
  assert.ok(!same.ok && /same point/.test(same.error))

  const shape = { kind: 'ellipsoid', center_x: 0, center_y: 50, center_z: 0, size_x: 30, size_y: 40, size_z: 30, rot_x: 0, rot_y: 0, rot_z: 0, style: [] }
  const form = (name: string) => parseCall(defs, { id: 'x', name: 'declare_form', args: { name, shapes: [shape], blend_cm: 2, why: 'The body.' } })
  assert.ok(form('cat').ok)
  const reserved = form('reference')
  assert.ok(!reserved.ok && /reserved/.test(reserved.error))

  const fromString = parseCall(defs, { id: 'x', name: 'chisel', args: JSON.stringify(CHISEL) })
  assert.ok(fromString.ok)
  assert.deepEqual(fromString.args, CHISEL)
})

test('the prompt is tight and follows the tool set and the reference', () => {
  const base = { block: { width: 60, height: 100, depth: 60 }, stone: 'Carrara marble', maxTurns: 60, maxUsd: 8, rebuildEvery: 20 }
  const words = (s: string) => s.split(/\s+/).length
  const full = buildInstructions({ ...base, toolSet: 'formed', reference: 'outlines' })
  const direct = buildInstructions({ ...base, toolSet: 'direct', reference: 'none' })
  // The head canon, `detail` and detail mode added about 450 words in the skill pass.
  assert.ok(words(full) < 1950, `${words(full)} words`)
  assert.ok(words(direct) < 1000, `${words(direct)} words`)
  assert.ok(words(buildInstructions({ ...base, toolSet: 'formed', reference: 'none' })) < 1800)
  // The tool set's own tools are named, and only they are.
  for (const tool of ['closeup', 'slice', 'sketch', 'drill', 'polish', 'protect', 'roundel']) {
    assert.ok(full.includes(`\`${tool}\``) || full.includes(tool), tool)
    assert.ok(!direct.includes(`\`${tool}\``), `${tool} in the stroke-only prompt`)
  }
  // Pacing and the finish check are in both.
  for (const text of [full, direct]) {
    assert.match(text, /Use the budget/)
    assert.match(text, /more than half your turns unspent/)
    assert.match(text, /Before `finish`, look from all sides/)
    assert.match(text, /within 5 cm of the top of the block/)
  }
  assert.match(full, /60 wide \(X\), 100 tall \(Y\), 60 deep \(Z\)/)
  assert.match(full, /X runs from -30 to 30/)
  assert.match(full, /60 turns and \$8/)
  assert.match(full, /REFERENCE SHEET/)
  assert.match(full, /rough_out/)
  assert.ok(!/declare_form|rough_out|rasp|REFERENCE SHEET|Proud of form|Silhouette/.test(direct))
  const viewOnly = buildInstructions({ ...base, toolSet: 'formed', reference: 'view' })
  assert.match(viewOnly, /could not be traced/)
  assert.ok(!/Silhouette agreement/.test(viewOnly))
})

test('toBase64 matches Node for every tail length', () => {
  for (let n = 0; n < 9; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 67 + 250) & 255)
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'))
  }
  const big = Uint8Array.from({ length: 50_001 }, (_, i) => (i * 31) & 255)
  assert.equal(toBase64(big), Buffer.from(big).toString('base64'))
})
