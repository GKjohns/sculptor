import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendReasoning, applyLoopEvent, beginCommission, emptyView, endLook, formatClock, headlineNumbers, landPass, lookView, mockView, MOCK_MODELS, notebookMessages, setPanel, showPass, stageLook, STORY_FRAMES, subtitleLabel } from '../app/studio/viewState.ts'
import type { SculptorView } from '../app/studio/viewState.ts'
import type { LoopEvent, PassRecord, RunState } from '../shared/agent/types.ts'

const NOW = '2026-11-09T12:00:00.000Z'

function run(view: SculptorView, events: LoopEvent[], toUrl?: (image: Uint8Array) => string): SculptorView {
  return events.reduce((v, e) => applyLoopEvent(v, e, { now: NOW, toUrl }), view)
}

function started(): SculptorView {
  return beginCommission(emptyView({ models: MOCK_MODELS }), { commission: 'A sleeping cat', model: 'opus', stone: 'carrara' })
}

const roughArgs = { to: 'bust', margin_cm: 2, tool: 'point', why: 'Rounding the boxy envelope toward skull, neck and shoulders.' }
const roughPass: PassRecord = { n: 1, turn: 2, tool: 'rough_out', args: roughArgs, why: roughArgs.why, line: '1. rough_out', summary: 'Roughed out.', numbers: { mass_kg: 292.9, removed_kg: 83.1 }, strikes: 1230 }
const state = (turns: number, costUsd: number): RunState => ({ turns, passes: [], notebook: { stage: null, text: '', turn: 0 }, usage: { input: 0, output: 0 }, costUsd })

test('an empty view picks the default model and weighs the block', () => {
  const view = emptyView({ models: MOCK_MODELS })
  assert.equal(view.phase, 'idle')
  assert.equal(view.model, 'opus')
  assert.equal(view.stats.blockKg, 975.6)
  assert.deepEqual(view.stages.map(s => s.state), ['pending', 'pending', 'pending', 'pending', 'pending'])
})

test('a turn becomes notebook rows: streamed text, a call that runs, then its result', () => {
  const call = { id: 'c1', name: 'rough_out', args: roughArgs }
  let view = run(started(), [
    { type: 'turn_start', turn: 2 },
    { type: 'text', turn: 2, delta: 'The corners ' },
    { type: 'text', turn: 2, delta: 'come off first.' },
    { type: 'tool_call', turn: 2, call, why: roughArgs.why }
  ])
  assert.equal(view.stats.turns, 2)
  assert.equal(view.notebook.length, 2)
  const [said, tool] = view.notebook
  assert.ok(said?.kind === 'text' && said.text === 'The corners come off first.' && !said.streaming, 'text is joined and settled once a call follows')
  assert.ok(tool?.kind === 'tool' && tool.state === 'running' && tool.why === roughArgs.why)
  assert.equal(tool.args, 'rough_out to "bust", margin 2 cm, point')

  view = run(view, [
    { type: 'tool_result', turn: 2, call, ok: true, summary: 'Roughed out.', numbers: roughPass.numbers, strikes: [], strikeCount: 1230, pass: roughPass },
    { type: 'turn_end', turn: 2, calls: 1, usage: { input: 1, output: 1 }, costUsd: 0.03, state: state(2, 0.05) }
  ])
  const done = view.notebook[1]
  assert.ok(done?.kind === 'tool' && done.state === 'done' && done.strikes === 1230 && done.pass === 1 && done.result === 'Roughed out.')
  assert.equal(view.stats.costUsd, 0.05)
  // the loop's events never move what the timeline owns
  assert.equal(view.phase, 'preparing')
  assert.equal(view.subtitle, null)
  assert.equal(view.stats.massKg, 975.6)
})

test('a refused call is an error row, and a call that is not a tool does not throw', () => {
  const bad = { id: 'c1', name: 'chisel', args: '{not json' }
  const view = run(started(), [
    { type: 'tool_call', turn: 1, call: bad },
    { type: 'tool_result', turn: 1, call: bad, ok: false, summary: 'Invalid arguments for chisel: not valid JSON.', strikes: [], strikeCount: 0 },
    { type: 'tool_call', turn: 1, call: { id: 'c2', name: 'carve_everything', args: {} } }
  ])
  const [row, unknown] = view.notebook
  assert.ok(row?.kind === 'tool' && row.state === 'error' && row.args === 'chisel' && row.result?.startsWith('Invalid arguments'))
  assert.ok(unknown?.kind === 'tool' && unknown.args === 'carve_everything')
})

test('a retry discards the failed attempt\'s words', () => {
  let view = run(started(), [{ type: 'text', turn: 3, delta: 'Half a thought' }])
  view = appendReasoning(view, 3, 'thinking')
  view = run(view, [{ type: 'turn_retry', turn: 3, error: 'timed out' }])
  assert.deepEqual(view.notebook.map(e => e.kind), ['system'])
})

test('reasoning streams into its own row and settles at the end of the turn', () => {
  let view = appendReasoning(appendReasoning(started(), 1, 'The block '), 1, 'is tall.')
  assert.ok(view.notebook[0]?.kind === 'reasoning' && view.notebook[0].streaming && view.notebook[0].text === 'The block is tall.')
  view = run(view, [{ type: 'turn_end', turn: 1, calls: 0, usage: { input: 0, output: 0 }, costUsd: 0, state: state(1, 0.01) }])
  assert.ok(view.notebook[0]?.kind === 'reasoning' && !view.notebook[0].streaming)
})

test('a note moves the stage list and a sketch is pinned', () => {
  const sketch = { id: 's1', name: 'sketch', args: { view: 'front', path: [{ h: -10, v: 0 }, { h: 0, v: 80 }, { h: 10, v: 0 }], why: 'The outline.' } }
  const view = run(started(), [
    { type: 'note', turn: 2, notebook: { stage: 'block_in', text: 'Masses next.', turn: 2 } },
    { type: 'tool_call', turn: 2, call: sketch, why: 'The outline.' },
    { type: 'tool_result', turn: 2, call: sketch, ok: true, summary: 'Drew a line.', strikes: [], strikeCount: 1 }
  ])
  assert.deepEqual(view.stages.map(s => s.state), ['done', 'current', 'pending', 'pending', 'pending'])
  assert.ok(view.notebook[0]?.kind === 'note' && view.notebook[0].stage === 'block_in')
  assert.deepEqual(view.sketches, [{ id: 's1', view: 'front', points: sketch.args.path, why: 'The outline.' }])
})

test('a look lands on its own call\'s row; the loop\'s own look is a system row', () => {
  const call = { id: 'l1', name: 'look', args: { views: ['front', 'left'], overlay: 'grid' } }
  const look: LoopEvent = { type: 'look', turn: 4, auto: false, views: ['front', 'left'], overlay: 'grid', images: [new Uint8Array([1, 2])], summary: 'Looked.', numbers: { mass_kg: 300 } }
  const view = run(started(), [
    { type: 'tool_call', turn: 4, call },
    look,
    { type: 'tool_result', turn: 4, call, ok: true, summary: 'Looked.', numbers: { mass_kg: 300 }, strikes: [], strikeCount: 0 },
    { ...look, auto: true, turn: 20 }
  ], bytes => `blob:${bytes.length}`)
  const [row, auto] = view.notebook
  assert.ok(row?.kind === 'tool' && row.state === 'done' && row.look?.images[0] === 'blob:2' && row.strikes === undefined)
  assert.ok(auto?.kind === 'system' && auto.look?.auto === true)
  assert.equal(view.eye, null, 'the eye panel is the timeline\'s to open')
  assert.deepEqual(lookView(look as Extract<LoopEvent, { type: 'look' }>).images, [], 'no URL maker, no images')
})

test('budget events update the stats and warn once per level', () => {
  const budget = (turn: number, level: 'ok' | 'warn75' | 'warn90' | 'last'): LoopEvent => ({ type: 'budget', turn, turns: turn, maxTurns: 60, costUsd: turn / 10, maxUsd: 7.87, level })
  const view = run(started(), [budget(10, 'ok'), budget(45, 'warn75'), budget(46, 'warn75'), budget(54, 'warn90')])
  assert.deepEqual(view.notebook.map(e => e.kind === 'budget' ? e.level : e.kind), ['warn75', 'warn90'])
  assert.equal(view.stats.turns, 54)
  assert.equal(view.stats.maxUsd, 7.87)
  assert.equal(view.stats.budget, 'warn90')
})

test('finish records the plaque but leaves the phase to the timeline', () => {
  const view = run(started(), [{ type: 'finish', turn: 35, ended: 'finish', title: 'Portrait Head', statement: 'A bust.' }])
  assert.deepEqual(view.finish, { ended: 'finish', title: 'Portrait Head', statement: 'A bust.', finishedAt: NOW })
  assert.equal(view.phase, 'preparing')
  const capped = run(started(), [{ type: 'finish', turn: 60, ended: 'turn_cap', title: null, statement: null }])
  assert.equal(capped.finish?.title, null)
  assert.ok(capped.notebook.at(-1)?.kind === 'system')
  const failed = run(started(), [{ type: 'error', turn: 3, message: 'The gateway refused the call.' }, { type: 'finish', turn: 3, ended: 'error', title: null, statement: null }])
  assert.equal(failed.error, 'The gateway refused the call.')
  assert.deepEqual(failed.notebook.map(e => e.kind), ['error'])
})

test('a reduced view shares what it did not change and survives JSON', () => {
  const before = run(started(), [{ type: 'text', turn: 1, delta: 'One.' }])
  const after = run(before, [{ type: 'turn_start', turn: 2 }])
  assert.equal(after.notebook, before.notebook)
  assert.notEqual(after.stats, before.stats)
  for (const { frame } of STORY_FRAMES) assert.deepEqual(JSON.parse(JSON.stringify(mockView(frame))), mockView(frame))
})

test('the timeline helpers: a pass on screen, a staged look and the way back', () => {
  let view = setPanel(showPass(started(), roughPass), 'notebook')
  assert.equal(view.phase, 'carving')
  assert.deepEqual(view.subtitle, { tool: 'rough_out', label: 'Point chisel · roughing out', text: roughArgs.why })
  view = landPass(view, roughPass)
  assert.equal(view.stats.massKg, 292.9)
  assert.equal(view.stats.removedKg, 682.7)

  const look = mockView(4).eye!
  view = stageLook(view, look, 'data:ref')
  assert.equal(view.phase, 'looking')
  assert.equal(view.panel, 'eye')
  assert.equal(view.eye?.returnTo, 'notebook')
  assert.equal(view.eye?.referenceImage, 'data:ref')
  assert.equal(view.subtitle?.label, 'Looking')
  // a second look straight after keeps the first one's way back
  view = stageLook(view, look)
  assert.equal(view.eye?.returnTo, 'notebook')
  assert.equal(endLook(view).panel, 'notebook')
  assert.equal(endLook(view).phase, 'carving')
  // closed by hand during the look: it stays closed
  assert.equal(endLook(setPanel(view, null)).panel, null)
  assert.equal(endLook(started()).phase, 'preparing', 'not looking, nothing to end')
})

test('labels and numbers read the way a person would say them', () => {
  assert.equal(subtitleLabel('chisel', { tool: 'flat' }, 'refine'), 'Flat chisel · refine')
  assert.equal(subtitleLabel('rasp', {}, null), 'Rasp')
  assert.equal(subtitleLabel('look', {}, 'model'), 'Looking')
  assert.deepEqual(headlineNumbers({ mass_kg: 292.9, removed_pct: 70, form_proud_max_cm: 3.3, offcuts: 0, silhouette_front_iou: 0.805 }, 3).map(c => `${c.value} ${c.label}`), ['293 kg remaining', '70% of the block gone', '3.3 cm proud of form, max'])
  assert.deepEqual(headlineNumbers({ offcuts: 1, saw_cuts: 6 }).map(c => `${c.value} ${c.label}`), ['1 offcut', '6 saw cuts'])
  assert.equal(formatClock(372_000), '6:12')
  assert.equal(formatClock(3_723_000), '1:02:03')
})

test('every storyboard frame has a view in the right phase', () => {
  assert.deepEqual(STORY_FRAMES.map(f => mockView(f.frame).phase), ['idle', 'carving', 'carving', 'looking', 'finished'])
  assert.equal(mockView(4).panel, 'eye')
  assert.equal(mockView(2).sketches.length, 3)
  assert.equal(mockView(6).finish?.title, 'Portrait Head')
})

test('the notebook becomes one chat message per turn, its rows as UI-message parts', () => {
  const messages = notebookMessages(mockView(6).notebook)
  assert.deepEqual(messages.map(m => m.metadata?.turn), [1, 2, 3, 4, 5, 12, 16, 22, 30, 35])
  assert.ok(messages.every(m => m.role === 'assistant'))
  assert.equal(new Set(messages.map(m => m.id)).size, messages.length)
  assert.deepEqual(messages[0]!.parts.map(p => p.type), ['reasoning', 'tool-look'])
  assert.deepEqual(messages[2]!.parts.map(p => p.type), ['data-note', 'tool-saw', 'tool-rough_out'])
  const saw = messages[2]!.parts[1]!
  assert.ok(saw.type === 'tool-saw' && saw.state === 'output-available' && saw.output.strikes === 2 && saw.input.why?.startsWith('Taking the top slab off'))
  const refused = messages[6]!.parts[0]!
  assert.ok(refused.type === 'tool-chisel' && refused.state === 'output-error' && refused.errorText.includes('missed the stone'))
  assert.deepEqual(messages[8]!.parts, [{ type: 'data-budget', id: 'm17', data: { level: 'warn75', text: 'Three quarters of the budget is spent.' } }])
  // a call still in the hand and words still arriving
  const live = notebookMessages(mockView(3).notebook)
  const running = live[2]!.parts.at(-1)!
  assert.ok(running.type === 'tool-rough_out' && running.state === 'input-available')
  assert.deepEqual(live.at(-1)!.parts.map(p => p.type === 'text' && p.state), ['streaming'])
})
