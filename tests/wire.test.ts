/**
 * The browser-server contract: the NDJSON event codec, body validation, and the request the
 * bench and /api/brain both build.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brainCall, cacheWarning, referenceBriefCall, turnOutcome } from '../shared/agent/brainRequest.ts'
import { MODELS, PRICING, SCULPTORS, TEXT_MODELS } from '../shared/agent/pricing.ts'
import { toolDefs } from '../shared/agent/toolSchemas.ts'
import { DEFAULT_CONFIG } from '../shared/agent/types.ts'
import type { Message } from '../shared/agent/types.ts'
import { encodeEvent, ndjsonDecoder, readBrainEvents } from '../shared/agent/wire.ts'
import type { BrainEvent } from '../shared/agent/wire.ts'
import { parseBrainRequest, parseReferenceRequest, parseSessionCreate, parseSessionReference, parseSessionSave } from '../shared/agent/wireSchemas.ts'
import { pngSize, sniffImageType } from '../server/utils/sheetPng.ts'

const DONE: BrainEvent = {
  t: 'done',
  calls: [{ id: 'c1', name: 'look', args: { views: ['front'], overlay: 'grid' } }],
  append: [{ role: 'assistant', content: [{ type: 'text', text: 'line one\nline two — “quoted”' }] }],
  usage: { input: 10, output: 5 },
  costUsd: 0.001,
  pricedUsd: 0.001,
  reportedUsd: null,
  finishReason: 'tool-calls',
  ms: 12
}

function streamOf(text: string, chunk: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let at = 0
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close()
      controller.enqueue(bytes.subarray(at, at + chunk))
      at += chunk
    }
  })
}

async function collect(status: number, text: string, chunk = 7): Promise<BrainEvent[]> {
  const out: BrainEvent[] = []
  for await (const e of readBrainEvents({ status, body: streamOf(text, chunk) })) out.push(e)
  return out
}

test('ndjson: an event is one line, and events survive being cut anywhere', () => {
  const events: BrainEvent[] = [{ t: 'start', model: 'm' }, { t: 'text', delta: 'a\nb' }, { t: 'call', call: { id: '1', name: 'saw', args: { n: 1 } } }, DONE]
  const text = events.map(encodeEvent).join('')
  assert.equal(text.split('\n').length, events.length + 1)
  for (const size of [1, 3, 17, text.length]) {
    const d = ndjsonDecoder<BrainEvent>()
    const got: BrainEvent[] = []
    for (let i = 0; i < text.length; i += size) got.push(...d.push(text.slice(i, i + size)))
    got.push(...d.end())
    assert.deepEqual(got, events)
  }
  const d = ndjsonDecoder()
  assert.deepEqual(d.push('{"a":1}\n\n  \n{"b":'), [{ a: 1 }])
  assert.deepEqual(d.end(), [], 'a cut-off last line is not an event')
})

test('ndjson: a line that is not JSON throws', () => {
  const d = ndjsonDecoder()
  assert.throws(() => d.push('<html>\n'))
})

test('readBrainEvents: multi-byte text split across chunks, and nothing after the terminal event', async () => {
  const text = [{ t: 'start', model: 'm' }, { t: 'text', delta: 'marbré — 石' }, DONE, { t: 'text', delta: 'late' }].map(encodeEvent).join('')
  for (const chunk of [1, 2, 5, 4096]) {
    const got = await collect(200, text, chunk)
    assert.deepEqual(got.map(e => e.t), ['start', 'text', 'done'])
    assert.deepEqual(got[1], { t: 'text', delta: 'marbré — 石' })
    assert.deepEqual(got[2], DONE)
  }
})

test('readBrainEvents: always ends in done or error', async () => {
  const cut = await collect(200, encodeEvent({ t: 'start', model: 'm' }) + encodeEvent({ t: 'text', delta: 'half' }))
  assert.equal(cut.at(-1)?.t, 'error')
  assert.equal((cut.at(-1) as { retryable: boolean }).retryable, true)

  const refused = await collect(503, encodeEvent({ t: 'error', code: 'no_key', message: 'No gateway key.', status: 503, retryable: false }))
  assert.deepEqual(refused, [{ t: 'error', code: 'no_key', message: 'No gateway key.', status: 503, retryable: false }])

  // The server's own error page: one JSON object with no `t`.
  const page = await collect(413, JSON.stringify({ error: true, statusCode: 413, statusMessage: 'Payload Too Large', message: 'the request is 30 MB; the limit is 24 MB' }))
  assert.deepEqual(page, [{ t: 'error', code: 'too_large', message: 'the request is 30 MB; the limit is 24 MB', status: 413, retryable: false }])

  const html = await collect(502, '<html>bad gateway</html>')
  assert.equal(html.length, 1)
  assert.equal(html[0]!.t, 'error')
  assert.equal((html[0] as { status?: number }).status, 502)

  const empty: BrainEvent[] = []
  for await (const e of readBrainEvents({ status: 500, body: null })) empty.push(e)
  assert.equal(empty[0]?.t, 'error')
})

const BRAIN = {
  model: 'opus',
  instructions: 'You are a sculptor.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'COMMISSION\na pawn' }] }],
  toolSet: 'formed',
  reference: 'none',
  toolResults: 'native'
}

test('brain body: accepted as sent, unknown models and bad shapes refused', () => {
  const ok = parseBrainRequest({ ...BRAIN, turn: 3, block: DEFAULT_CONFIG.block, stone: 'Carrara marble' })
  assert.equal(ok.ok, true)
  for (const key of TEXT_MODELS) assert.equal(parseBrainRequest({ ...BRAIN, model: key }).ok, true)

  const unknown = parseBrainRequest({ ...BRAIN, model: 'gpt-2' })
  assert.equal(unknown.ok, false)
  assert.match((unknown as { error: string }).error, /model: unknown model "gpt-2"/)
  // A gateway id is not a key, and the image model takes no turns.
  assert.equal(parseBrainRequest({ ...BRAIN, model: MODELS.opus }).ok, false)
  assert.equal(parseBrainRequest({ ...BRAIN, model: 'image' }).ok, false)

  assert.equal(parseBrainRequest({ ...BRAIN, messages: [] }).ok, false)
  assert.equal(parseBrainRequest({ ...BRAIN, messages: [{ role: 'robot', content: 'x' }] }).ok, false)
  assert.equal(parseBrainRequest({ ...BRAIN, messages: [{ role: 'user', content: 5 }] }).ok, false)
  assert.equal(parseBrainRequest({ ...BRAIN, instructions: '' }).ok, false)
  assert.equal(parseBrainRequest({ ...BRAIN, toolSet: 'everything' }).ok, false)
  assert.equal(parseBrainRequest({ ...BRAIN, toolResults: 'xml' }).ok, false)
  assert.equal(parseBrainRequest(null).ok, false)
  assert.equal(parseBrainRequest('{}').ok, false)
})

test('brain body: a provider\'s reasoning block is not stripped by validation', () => {
  const assistant = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'thinking', providerOptions: { anthropic: { signature: 'sig==' } }, somethingNew: [1, 2] },
      { type: 'tool-call', toolCallId: 't1', toolName: 'look', input: { views: ['front'], overlay: 'grid' } }
    ],
    providerOptions: { anthropic: { x: 1 } }
  }
  const r = parseBrainRequest({ ...BRAIN, messages: [...BRAIN.messages, assistant] })
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual(r.value.messages[1], assistant)
})

test('reference body', () => {
  assert.equal(parseReferenceRequest({ commission: '  a loaf-shaped cat ', model: 'opus' }).ok, true)
  const trimmed = parseReferenceRequest({ commission: '  a cat ', model: 'sol', retry: { reasons: ['front: two shapes'], brief: 'A cat.' } })
  assert.equal(trimmed.ok && trimmed.value.commission, 'a cat')
  assert.equal(parseReferenceRequest({ commission: '   ', model: 'opus' }).ok, false)
  assert.equal(parseReferenceRequest({ commission: 'a cat', model: 'nobody' }).ok, false)
  assert.equal(parseReferenceRequest({ commission: 'a cat', model: 'opus', retry: { reasons: 'bad' } }).ok, false)
})

test('session bodies', () => {
  const create = { commission: 'a chess pawn', model: 'opus', ref: true, run: DEFAULT_CONFIG, grid: { width: 60, height: 100, depth: 60, voxel: 0.4, chunk: 32 }, kernel: 2 }
  assert.equal(parseSessionCreate(create).ok, true)
  assert.equal(parseSessionCreate({ ...create, grid: { ...create.grid, voxel: 0 } }).ok, false)
  assert.equal(parseSessionCreate({ ...create, run: { ...DEFAULT_CONFIG, toolSet: 'x' } }).ok, false)
  // A field the loop's config gains later is kept.
  const wider = parseSessionCreate({ ...create, run: { ...DEFAULT_CONFIG, pace: 2 } })
  assert.equal(wider.ok && (wider.value.run as unknown as { pace: number }).pace, 2)

  assert.equal(parseSessionSave({}).ok, true)
  const strike = { kind: 'cut', tool: 'point', at: [0, 50, 30], dir: [0, 0, -1], size: 3, depth: 1, seed: 1, ms: 200 }
  const save = parseSessionSave({ strikes: { from: 0, items: [strike, { kind: 'detach' }] }, result: { ended: 'finish', finish: { title: 'Pawn', statement: 'A pawn.' } } })
  assert.equal(save.ok, true)
  if (save.ok) assert.deepEqual(save.value.strikes!.items[0], strike)
  assert.equal(parseSessionSave({ strikes: { from: -1, items: [] } }).ok, false)
  assert.equal(parseSessionSave({ strikes: { from: 0, items: [{ tool: 'point' }] } }).ok, false)
  assert.equal(parseSessionSave({ result: { ended: 'bored', finish: null } }).ok, false)
  assert.equal(parseSessionSave({ state: { turns: 1 } }).ok, false)

  assert.equal(parseSessionReference({ pngBase64: 'iVBORw0KGgo=', outlines: true, brief: 'A cat.', costUsd: 0.04 }).ok, true)
  assert.equal(parseSessionReference({ pngBase64: null, outlines: false, brief: '', costUsd: 0, error: 'no image' }).ok, true)
  assert.equal(parseSessionReference({ pngBase64: '../../etc/passwd', outlines: false, brief: '', costUsd: 0 }).ok, false)
})

test('one request for bench and server: tools from the tool set, never named here', () => {
  const messages: Message[] = [{ role: 'user', content: 'begin' }]
  for (const toolSet of ['direct', 'formed'] as const) {
    const s = brainCall({ model: MODELS.opus, tools: { toolSet, reference: 'none' } })({ instructions: 'I', messages })
    assert.deepEqual(Object.keys(s.tools ?? {}), toolDefs({ toolSet, reference: 'none' }).map(d => d.name))
    for (const tool of Object.values(s.tools ?? {})) assert.equal('execute' in tool && tool.execute !== undefined, false, 'the loop runs every call itself')
    assert.equal(s.maxRetries, 0)
    assert.equal(s.reasoning, 'medium')
    assert.deepEqual(s.providerOptions, { gateway: { caching: 'auto', order: ['anthropic'] } })
    assert.equal(s.instructions, 'I')
    assert.equal(s.messages, messages)
  }
  const sol = brainCall({ model: MODELS.sol, tools: { toolSet: 'formed', reference: 'outlines' } })({ instructions: 'I', messages })
  assert.deepEqual(sol.providerOptions, { gateway: { caching: 'auto' } })

  const jsonl = brainCall({ model: MODELS.opus, tools: { toolSet: 'formed', reference: 'none' }, mode: 'jsonl' })({ instructions: 'I', messages })
  assert.equal(jsonl.tools, undefined)
  assert.match(jsonl.instructions, /^I\n\nCALLING TOOLS/)
})

test('a turn\'s outcome: native calls keep their ids, JSON-lines calls get one, and there is always an assistant message', () => {
  const said = [{ role: 'assistant', content: [{ type: 'reasoning', text: 'r', providerOptions: { anthropic: { signature: 's' } } }] }]
  const native = turnOutcome({ mode: 'native', turn: 4, text: '', toolCalls: [{ toolCallId: 'toolu_1', toolName: 'look', input: { views: ['top'] } }], responseMessages: said })
  assert.deepEqual(native.calls, [{ id: 'toolu_1', name: 'look', args: { views: ['top'] } }])
  assert.equal(native.append, said, 'verbatim')

  const text = 'I will look.\n[{"tool":"look","args":{"views":["front"],"overlay":"grid"}},{"tool":"note","args":{"stage":"model","text":"x"}}]'
  const jsonl = turnOutcome({ mode: 'jsonl', turn: 4, text, toolCalls: [], responseMessages: [] })
  assert.deepEqual(jsonl.calls.map(c => [c.id, c.name]), [['jl-4-1', 'look'], ['jl-4-2', 'note']])
  assert.deepEqual(jsonl.append, [{ role: 'assistant', content: text }])
  assert.deepEqual(turnOutcome({ mode: 'native', turn: 1, text: '', toolCalls: [], responseMessages: [] }).append, [{ role: 'assistant', content: '(no reply)' }])
})

test('cache warning and the retry nudge', () => {
  assert.equal(cacheWarning(1, { input: 9000, output: 1 }, 'm'), null)
  assert.match(cacheWarning(2, { input: 9000, output: 1 }, 'm') ?? '', /read nothing from the prompt cache/)
  assert.equal(cacheWarning(2, { input: 9000, output: 1, cacheRead: 8000 }, 'm'), null)

  const first = referenceBriefCall(MODELS.opus, 'a loaf-shaped cat')
  const again = referenceBriefCall(MODELS.opus, 'a loaf-shaped cat', { reasons: ['front: 2 separate shapes'], brief: 'A cat with a raised tail.' })
  assert.ok(again.prompt.startsWith(first.prompt))
  assert.match(again.prompt, /front: 2 separate shapes/)
  assert.match(again.prompt, /A cat with a raised tail\./)
  assert.equal(first.instructions, again.instructions)
})

test('every sculptor in the picker is priced and can take a turn', () => {
  for (const key of SCULPTORS) {
    assert.ok(PRICING[MODELS[key]], key)
    assert.ok((TEXT_MODELS as readonly string[]).includes(key))
  }
})

test('image sniffing and PNG size', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0, 0, 0, 3, 0, 8, 2, 0, 0, 0])
  assert.equal(sniffImageType(png), 'image/png')
  assert.deepEqual(pngSize(png), { width: 1024, height: 768 })
  // A view into a larger buffer reads from its own start.
  const padded = new Uint8Array(png.length + 5)
  padded.set(png, 5)
  assert.deepEqual(pngSize(padded.subarray(5)), { width: 1024, height: 768 })
  assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffImageType(new TextEncoder().encode('RIFF1234WEBPVP8 ')), 'image/webp')
  assert.equal(pngSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), null)
})
