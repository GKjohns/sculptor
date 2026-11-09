import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseArgs } from '../bench/args.ts'
import { newMeter, parseJsonLines, reportedCost, settleCost } from '../bench/brain.ts'
import { shuffledLabels } from '../bench/judge.ts'
import { Ledger } from '../bench/ledger.ts'
import { shrink } from '../bench/reference.ts'
import { JUDGE_LABELS, SUBJECTS, tidySentence } from '../bench/subjects.ts'
import { imageMediaType } from '../shared/agent/context.ts'
import { costUsd } from '../shared/agent/pricing.ts'

test('ledger: per-run files sum, a live run holds its cap, and the study cap refuses a start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sculptor-ledger-'))
  try {
    const ledger = new Ledger(dir)
    assert.deepEqual(ledger.reserve('a', 8, 20), { ok: true })
    assert.deepEqual(ledger.reserve('b', 8, 20), { ok: true })
    // 16 of 20 is spoken for by two live runs that have spent nothing yet.
    const third = ledger.reserve('c', 8, 20)
    assert.ok(!third.ok && /study cap \$20\.00/.test(third.reason) && /\$16\.00 reserved by 2 live runs/.test(third.reason), JSON.stringify(third))
    assert.equal(ledger.entries().length, 2)

    assert.equal(ledger.record('a', 3.5, 8, 'running'), 3.5)
    assert.equal(ledger.record('b', 1.25, 8, 'done'), 4.75)
    // b is finished, so only what it spent counts: 3.5 + 1.25 spent, 4.5 still held by a.
    assert.deepEqual(ledger.totals(), { spentUsd: 4.75, reservedUsd: 4.5, runs: 2, live: 1 })
    assert.deepEqual(ledger.reserve('c', 8, 20), { ok: true })
    assert.ok(!ledger.reserve('d', 8, 20).ok)

    // A run whose process died holds nothing, but what it spent stays spent.
    writeFileSync(join(dir, 'ledger', 'dead.json'), JSON.stringify({ runId: 'dead', usd: 2, capUsd: 8, state: 'running', pid: 2 ** 22 + 12345, updatedAt: '2026-01-01T00:00:00.000Z' }))
    assert.equal(ledger.totals().spentUsd, 6.75)
    assert.equal(ledger.totals().live, 2)

    // A resumed run is not charged twice for what it had already spent.
    ledger.record('a', 3.5, 8, 'done')
    ledger.record('c', 0, 8, 'done')
    assert.deepEqual(ledger.reserve('a', 8, 12), { ok: true })
    assert.equal(ledger.entries().find(e => e.runId === 'a')!.usd, 3.5)

    const summary = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')) as { spentUsd: number, runs: { runId: string, state: string }[] }
    assert.equal(summary.spentUsd, 6.75)
    assert.equal(summary.runs.find(r => r.runId === 'dead')!.state, 'died')

    writeFileSync(join(dir, 'ledger', 'broken.json'), '{ "runId": ')
    assert.throws(() => ledger.totals(), /cannot be read/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('json-lines fallback: calls are read from the array that ends the reply', () => {
  const reply = 'I will look first, then cut.\n[\n{"tool": "look", "args": {"views": ["front", "right"], "overlay": "grid"}},\n{"tool": "saw", "args": {"view": "front", "from": {"h": -30, "v": 80}, "to": {"h": 30, "v": 80}, "discard": "above", "why": "Top off [roughly]."}}\n]'
  const calls = parseJsonLines(reply)
  assert.deepEqual(calls.map(c => c.tool), ['look', 'saw'])
  assert.deepEqual((calls[0]!.args as { views: string[] }).views, ['front', 'right'])
  // Brackets in the prose before the array, and one call per line with no array at all.
  assert.deepEqual(parseJsonLines('The block [60 wide] first.\n[{"tool":"note","args":{"stage":"model","text":"x"}}]').map(c => c.tool), ['note'])
  assert.deepEqual(parseJsonLines('{"tool": "finish", "args": {"title": "t", "statement": "s"}},\nthat is all').map(c => c.tool), ['finish'])
  assert.deepEqual(parseJsonLines('Nothing to call here [yet].'), [])
})

test('cost: the larger of our price and the gateway\'s is charged, and an unpriced model throws', () => {
  const usage = { input: 10_000, output: 1_000, cacheRead: 8_000, cacheWrite: 0, reasoning: 0 }
  const priced = costUsd('anthropic/claude-opus-5.5', usage)
  assert.ok(Math.abs(priced - (2000 * 4 + 8000 * 0.2 + 1000 * 20) / 1e6) < 1e-12)
  assert.equal(reportedCost({ gateway: { cost: '0.0412' } }), 0.0412)
  assert.equal(reportedCost({ gateway: { cost: 0.05 } }), 0.05)
  assert.equal(reportedCost({ anthropic: {} }), null)
  assert.equal(reportedCost(undefined), null)

  const meter = newMeter()
  const notes: string[] = []
  assert.equal(settleCost('anthropic/claude-opus-5.5', usage, undefined, meter), priced)
  assert.equal(settleCost('anthropic/claude-opus-5.5', usage, { gateway: { cost: '0.09' } }, meter, l => notes.push(l)), 0.09)
  assert.equal(settleCost('anthropic/claude-opus-5.5', usage, { gateway: { cost: String(priced) } }, meter, l => notes.push(l)), priced)
  assert.equal(notes.length, 1)
  assert.match(notes[0]!, /price table \$0\.0296, gateway \$0\.0900/)
  assert.deepEqual({ calls: meter.calls, reportedCalls: meter.reportedCalls }, { calls: 3, reportedCalls: 2 })
  assert.throws(() => settleCost('nobody/unknown', usage, undefined, meter), /no price for model/)
})

test('judge labels: twelve, the three subjects among them, shuffled the same way for the same run', () => {
  assert.equal(JUDGE_LABELS.length, 12)
  assert.equal(new Set(JUDGE_LABELS).size, 12)
  for (const s of Object.values(SUBJECTS)) assert.ok(JUDGE_LABELS.includes(s.label))
  const a = shuffledLabels('A-cat-opus-formed-noref-1')
  assert.deepEqual(a, shuffledLabels('A-cat-opus-formed-noref-1'))
  assert.deepEqual(a.slice().sort(), JUDGE_LABELS.slice().sort())
  assert.notDeepEqual(a, shuffledLabels('A-cat-opus-direct-noref-1'))
  assert.notDeepEqual(a, JUDGE_LABELS)
})

test('small things: flags, image types and the shrink', () => {
  const args = parseArgs(['--subject', 'cat', '--max-usd=4.5', '--dry', '--typo', 'x'])
  assert.equal(args.oneOf('subject', ['pawn', 'cat'] as const, 'pawn'), 'cat')
  assert.equal(args.num('max-usd', 8), 4.5)
  assert.equal(args.num('max-turns', 60), 60)
  assert.equal(args.has('dry'), true)
  assert.deepEqual(args.unknown(), ['--typo'])
  assert.throws(() => parseArgs(['--subject', 'dog']).oneOf('subject', ['pawn', 'cat'] as const, 'pawn'), /must be one of pawn, cat/)
  assert.throws(() => parseArgs(['pawn']), /unexpected argument/)

  assert.equal(imageMediaType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')), 'image/png')
  assert.equal(imageMediaType(Buffer.from('RIFF\x10\x00\x00\x00WEBP', 'latin1').toString('base64')), 'image/webp')
  assert.equal(imageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64')), 'image/jpeg')

  const big = { width: 400, height: 200, data: new Uint8Array(400 * 200 * 4).fill(200) }
  const small = shrink(big, 100)
  assert.deepEqual([small.width, small.height], [100, 50])
  assert.ok(small.data.every(v => v === 200))
  assert.equal(shrink(big, 400), big)
})

test('a judge sentence loses stray JSON closers and nothing else', () => {
  assert.equal(tidySentence('No ears or face that would suggest an animal or bust.}'), 'No ears or face that would suggest an animal or bust.')
  assert.equal(tidySentence('Reads as a pawn."}\n'), 'Reads as a pawn.')
  assert.equal(tidySentence('It has the profile of a "pawn"'), 'It has the profile of a "pawn"')
  assert.equal(tidySentence('Stepped base {two tiers} and a collar [narrow]'), 'Stepped base {two tiers} and a collar [narrow]')
  assert.equal(tidySentence('  Plain sentence.  '), 'Plain sentence.')
})
