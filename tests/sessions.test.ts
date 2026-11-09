/**
 * The session store against a temp folder: what a commission saves as it runs, what a reload
 * gets back, and that a log is never written twice or with a hole in it.
 */
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MODELS } from '../shared/agent/pricing.ts'
import type { StrikeLog } from '../shared/agent/studio.ts'
import { DEFAULT_CONFIG } from '../shared/agent/types.ts'
import type { PassRecord, RunState } from '../shared/agent/types.ts'
import type { SessionCreate } from '../shared/agent/wire.ts'
import { KERNEL_VERSION } from '../shared/sculpt/version.ts'
import type { Strike } from '../shared/sculpt/types.ts'
import { SessionError, createSessionStore } from '../server/utils/sessionStore.ts'

const GRID = { width: 60, height: 100, depth: 60, voxel: 0.4, chunk: 32 }
const CREATE: SessionCreate = { commission: 'A loaf-shaped cat, please!', model: 'opus', ref: true, run: DEFAULT_CONFIG, grid: GRID, kernel: KERNEL_VERSION, settings: { speed: 2 } }

const cut = (seed: number): Strike => ({ kind: 'cut', tool: 'point', at: [0.5, 50, 30], dir: [0, 0, -1], size: 3, depth: 1, seed, ms: 200 })
const DETACH: Strike = { kind: 'detach' }
const pass = (n: number, strikes: number): PassRecord => ({ n, turn: n, tool: 'chisel', args: { why: 'because' }, why: 'because', line: `${n}. chisel`, summary: 'removed 3 cm³', strikes })
const state = (turns: number, passes: PassRecord[], costUsd: number): RunState => ({ turns, passes, notebook: { stage: 'rough_out', text: 'the plan', turn: 1 }, usage: { input: 100 * turns, output: 10 * turns, cacheRead: 50 }, costUsd })

function temp(): { root: string, done: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'sculptor-sessions-'))
  return { root: join(root, 'sessions'), done: () => rmSync(root, { recursive: true, force: true }) }
}

const refused = (status: number) => (err: unknown) => err instanceof SessionError && err.status === status

test('a commission saved turn by turn reads back whole', () => {
  const { root, done } = temp()
  try {
    const store = createSessionStore(root, { kernel: KERNEL_VERSION, models: MODELS })
    assert.deepEqual(store.list(), [])

    const made = store.create(CREATE)
    assert.match(made.id, /^\d{14}-a-loaf-shaped-cat-please-[0-9a-f]{3}$/)
    assert.equal(made.status, 'running')
    assert.equal(made.kernel, KERNEL_VERSION)
    assert.equal(made.config.modelId, MODELS.opus)
    assert.equal(made.config.tools, 'formed')
    assert.deepEqual(made.config.settings, { speed: 2 })
    assert.equal(made.state, null)

    // Turn 1: a pass of three entries. Turn 2: a pass of two.
    const first = [cut(1), cut(2), DETACH]
    const second = [cut(3), DETACH]
    let saved = store.save(made.id, { strikes: { from: 0, items: first }, events: { from: 0, items: [{ type: 'turn_end', turn: 1 }] }, state: state(1, [pass(1, 3)], 0.04) })
    assert.deepEqual([saved.strikes, saved.events, saved.status], [3, 1, 'running'])
    saved = store.save(made.id, { strikes: { from: 3, items: second }, events: { from: 1, items: [{ type: 'turn_end', turn: 2 }, 'text\nwith a newline'] }, state: state(2, [pass(1, 3), pass(2, 2)], 0.09), settings: { camera: 'auto' } })
    assert.deepEqual([saved.strikes, saved.events], [5, 3])

    store.saveReference(made.id, { pngBase64: Buffer.from([137, 80, 78, 71, 1, 2, 3]).toString('base64'), outlines: true, brief: 'A cat.', costUsd: 0.05, usage: { input: 400, output: 200 } })

    const mid = store.get(made.id)
    assert.equal(mid.status, 'running')
    assert.deepEqual(mid.state, state(2, [pass(1, 3), pass(2, 2)], 0.09))
    assert.deepEqual([mid.strikes, mid.passes, mid.events], [5, 2, 3])
    assert.deepEqual(mid.cost, { totalUsd: 0.14, sculptorUsd: 0.09, referenceUsd: 0.05 })
    assert.deepEqual(mid.config.settings, { speed: 2, camera: 'auto' })
    assert.deepEqual(mid.reference, { outlines: true, brief: 'A cat.', file: 'reference.png', costUsd: 0.05, usage: { input: 400, output: 200 } })
    assert.deepEqual([...store.referencePng(made.id)!], [137, 80, 78, 71, 1, 2, 3])

    const log = JSON.parse(store.strikeLogText(made.id)) as StrikeLog
    assert.deepEqual(log, { kernel: KERNEL_VERSION, grid: GRID, strikes: [...first, ...second] })
    assert.deepEqual(store.passes(made.id), [pass(1, 3), pass(2, 2)])
    assert.deepEqual(JSON.parse(store.eventsText(made.id)), [{ type: 'turn_end', turn: 1 }, { type: 'turn_end', turn: 2 }, 'text\nwith a newline'])

    saved = store.save(made.id, { result: { ended: 'finish', finish: { title: 'Loaf', statement: 'A cat at rest.' } }, final: { hash: 'abc123', numbers: { mass_kg: 310.5 } } })
    assert.equal(saved.status, 'done')
    const end = store.get(made.id)
    assert.deepEqual(end.result, { ended: 'finish', finish: { title: 'Loaf', statement: 'A cat at rest.' }, turns: 2, passes: 2, strikes: 5 })
    assert.ok(end.finishedAt)

    assert.deepEqual(store.list().map(s => ({ ...s, startedAt: '', updatedAt: '', finishedAt: '' })), [{
      id: made.id, commission: 'A loaf-shaped cat, please!', model: 'opus', tools: 'formed', ref: true, status: 'done', turns: 2, costUsd: 0.14, strikes: 5, passes: 2,
      ended: 'finish', title: 'Loaf', statement: 'A cat at rest.', kernel: KERNEL_VERSION, hash: 'abc123', startedAt: '', updatedAt: '', finishedAt: ''
    }])

    // The files a person or the replay path would open.
    assert.deepEqual(readdirSync(join(root, made.id)).sort(), ['events.ndjson', 'passes.json', 'reference.png', 'run.json', 'strikes.ndjson'])
    const onDisk = JSON.parse(readFileSync(join(root, made.id, 'run.json'), 'utf8'))
    assert.equal(onDisk.state.passes, undefined, 'the pass record is in passes.json only')
    assert.equal(readFileSync(join(root, made.id, 'strikes.ndjson'), 'utf8').split('\n').length, 7)
  } finally {
    done()
  }
})

test('an append is safe to send twice, overlaps are trimmed, and a gap is refused', () => {
  const { root, done } = temp()
  try {
    const store = createSessionStore(root, { kernel: KERNEL_VERSION, models: MODELS })
    const { id } = store.create(CREATE)
    const all = [cut(1), cut(2), cut(3), cut(4), cut(5)]
    assert.equal(store.save(id, { strikes: { from: 0, items: all.slice(0, 3) } }).strikes, 3)
    assert.equal(store.save(id, { strikes: { from: 0, items: all.slice(0, 3) } }).strikes, 3, 'the same save again')
    assert.equal(store.save(id, { strikes: { from: 1, items: all.slice(1, 5) } }).strikes, 5, 'overlapping the tail')
    assert.equal(store.save(id, { strikes: { from: 5, items: [] } }).strikes, 5)
    assert.deepEqual((JSON.parse(store.strikeLogText(id)) as StrikeLog).strikes, all)

    assert.throws(() => store.save(id, { strikes: { from: 7, items: [cut(8)] } }), (err: unknown) => refused(409)(err) && (err as SessionError).data !== undefined && ((err as SessionError).data as { have: number }).have === 5)
    assert.throws(() => store.save(id, { events: { from: 1, items: ['x'] } }), refused(409))
    assert.equal(store.get(id).strikes, 5, 'a refused save writes nothing')
  } finally {
    done()
  }
})

test('a second store on the same folder counts the logs from disk, and repairs a line cut short', () => {
  const { root, done } = temp()
  try {
    const first = createSessionStore(root, { kernel: KERNEL_VERSION, models: MODELS })
    const { id } = first.create(CREATE)
    first.save(id, { strikes: { from: 0, items: [cut(1), cut(2)] }, state: state(1, [pass(1, 2)], 0.01) })
    // The server died mid-write: half a line, no newline.
    appendFileSync(join(root, id, 'strikes.ndjson'), '{"kind":"cut","tool":"po')

    const second = createSessionStore(root, { kernel: KERNEL_VERSION, models: MODELS })
    assert.equal(second.get(id).strikes, 2)
    assert.equal(second.save(id, { strikes: { from: 2, items: [cut(3)] } }).strikes, 3)
    assert.deepEqual((JSON.parse(second.strikeLogText(id)) as StrikeLog).strikes, [cut(1), cut(2), cut(3)])
    // The first store sees the file changed under it and counts again.
    assert.equal(first.save(id, { strikes: { from: 3, items: [cut(4)] } }).strikes, 4)
  } finally {
    done()
  }
})

test('a finished session that is carried on is running again', () => {
  const { root, done } = temp()
  try {
    const store = createSessionStore(root, { kernel: KERNEL_VERSION, models: MODELS })
    const { id } = store.create(CREATE)
    store.save(id, { strikes: { from: 0, items: [cut(1)] }, state: state(1, [pass(1, 1)], 0.01), result: { ended: 'aborted', finish: null } })
    assert.equal(store.get(id).status, 'done')
    store.save(id, { settings: { speed: 4 } })
    assert.equal(store.get(id).status, 'done', 'a settings change does not reopen it')
    store.save(id, { strikes: { from: 1, items: [cut(2)] }, state: state(2, [pass(1, 1), pass(2, 1)], 0.02) })
    const again = store.get(id)
    assert.deepEqual([again.status, again.result, again.finishedAt], ['running', null, null])
  } finally {
    done()
  }
})

test('ids are matched against the folder, never used as paths', () => {
  const { root, done } = temp()
  try {
    const store = createSessionStore(root, { kernel: KERNEL_VERSION, models: MODELS })
    const { id } = store.create(CREATE)
    // Something worth reaching for, one level up.
    writeFileSync(join(root, '..', 'run.json'), '{"id":"outside"}')
    for (const bad of ['..', '.', '', `${id}/..`, `../sessions/${id}`, `${id}/`, 'nope', '../..']) {
      assert.throws(() => store.get(bad), refused(404), bad)
      assert.throws(() => store.save(bad, {}), refused(404), bad)
      assert.throws(() => store.strikeLogText(bad), refused(404), bad)
      assert.throws(() => store.saveReference(bad, { pngBase64: null, outlines: false, brief: '', costUsd: 0 }), refused(404), bad)
    }
    assert.equal(existsSync(join(root, '..', 'reference.png')), false)
    assert.equal(store.get(id).id, id)
  } finally {
    done()
  }
})

test('newest first, and folders that are not sessions are skipped', async () => {
  const { root, done } = temp()
  try {
    const store = createSessionStore(root, { kernel: KERNEL_VERSION, models: MODELS })
    const a = store.create({ ...CREATE, commission: 'first' })
    await new Promise(r => setTimeout(r, 5))
    const b = store.create({ ...CREATE, commission: 'second' })
    mkdirSync(join(root, 'not-a-session'))
    mkdirSync(join(root, 'broken'))
    writeFileSync(join(root, 'broken', 'run.json'), '{ nope')
    writeFileSync(join(root, 'stray.txt'), 'x')
    assert.deepEqual(store.list().map(s => s.id), [b.id, a.id])
    assert.notEqual(a.id, b.id)
  } finally {
    done()
  }
})

test('another kernel is refused: at create, and on every later save', () => {
  const { root, done } = temp()
  try {
    const store = createSessionStore(root, { kernel: KERNEL_VERSION, models: MODELS })
    assert.throws(() => store.create({ ...CREATE, kernel: KERNEL_VERSION + 1 }), refused(409))
    const { id } = store.create(CREATE)
    const newer = createSessionStore(root, { kernel: KERNEL_VERSION + 1, models: MODELS })
    assert.throws(() => newer.save(id, { strikes: { from: 0, items: [cut(1)] } }), refused(409))
    // It can still be read (the replay page says which kernel it needs).
    assert.equal(newer.get(id).kernel, KERNEL_VERSION)
    assert.equal(newer.list().length, 1)
  } finally {
    done()
  }
})

test('a reference that could not be made is recorded without a file', () => {
  const { root, done } = temp()
  try {
    const store = createSessionStore(root, { kernel: KERNEL_VERSION, models: MODELS })
    const { id } = store.create(CREATE)
    store.saveReference(id, { pngBase64: null, outlines: false, brief: 'A cat.', costUsd: 0.01, error: 'the image model returned no image' })
    const s = store.get(id)
    assert.deepEqual(s.reference, { outlines: false, brief: 'A cat.', file: null, costUsd: 0.01, error: 'the image model returned no image' })
    assert.equal(store.referencePng(id), null)
    assert.equal(s.cost.totalUsd, 0.01)
  } finally {
    done()
  }
})
