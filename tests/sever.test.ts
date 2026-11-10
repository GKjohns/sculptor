/**
 * The sever guard and the bust canon's footing. No pass may cut the piece free of its base:
 * run S-bust-opus-formed-ref-pass3-20261110010342-bf4 lost its whole bust at turn 4 when a
 * `detail` from the top shaved through the socle's stem and 152 kg fell. The guard refuses such
 * a pass; the torso canon now stands on a stem no finishing pass can shave through; and the
 * bench marks a run whose stone fell as lost.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isLost } from '../bench/sculpt.ts'
import { createStudio } from '../shared/agent/studio.ts'
import { DEFAULT_CONFIG } from '../shared/agent/types.ts'
import { bustProportions, expandCanon } from '../shared/sculpt/anatomy.ts'
import { createGrid, hashGrid, stoneMassKg } from '../shared/sculpt/grid.ts'
import { compileForm, formDistance } from '../shared/sculpt/shapes.ts'

const shape = (kind: string, c: number[], s: number[]) => ({ kind, center_x: c[0], center_y: c[1], center_z: c[2], size_x: s[0], size_y: s[1], size_z: s[2], rot_x: 0, rot_y: 0, rot_z: 0, style: [] })
const call = (name: string, args: Record<string, unknown>) => ({ id: name, name, args } as never)

test('a pass that would cut the piece free of its base is refused, and the stone is left as it was', async () => {
  const grid = createGrid({ voxel: 0.8 })
  const studio = createStudio({ grid, encodeImage: () => new Uint8Array() })
  // bf4 in small: a body over a plinth with a 1.5 cm gap between them that only the roughing
  // margin bridges. Brought down to the form from the top, the bridge goes and the body falls.
  await studio.run(call('declare_form', { name: 'piece', shapes: [shape('box', [0, 1.25, 0], [30, 2.5, 30]), shape('ellipsoid', [0, 24, 0], [30, 40, 26])], blend_cm: 0, why: 'x' }))
  await studio.run(call('rough_out', { to: 'piece', margin_cm: 2.5, tool: 'point', why: 'x' }))
  const before = hashGrid(grid)
  const mass = stoneMassKg(grid)
  await assert.rejects(
    studio.run(call('detail', { to: 'piece', view: 'top', center: { h: 0, v: 0 }, span_cm: 50, why: 'x' })),
    /this detail would cut the piece free of its base: about \d+ kg of "piece"[\s\S]*Nothing was cut/
  )
  assert.equal(hashGrid(grid), before, 'the stone is unchanged')
  assert.equal(stoneMassKg(grid), mass)
  // A saw across the body is refused the same way; one through waste is not.
  await assert.rejects(studio.run(call('saw', { view: 'front', from: { h: -30, v: 30 }, to: { h: 30, v: 30 }, discard: 'above', why: 'x' })), /this saw would cut the piece free/)
  await studio.run(call('saw', { view: 'front', from: { h: -30, v: 60 }, to: { h: 30, v: 60 }, discard: 'above', why: 'x' }))
  // A detail that does not reach the stem is carried out.
  const r = await studio.run(call('detail', { to: 'piece', view: 'front', center: { h: 0, v: 30 }, span_cm: 30, why: 'x' }))
  assert.match(r.summary, /Brought the stone in the window down/)
})

const BF4 = join(import.meta.dirname, '..', '.data', 'study', 'S-bust-opus-formed-ref-pass3-20261110010342-bf4')

test('run bf4\'s first four turns, replayed through today\'s Studio, leave the bust standing', { skip: existsSync(BF4) ? false : 'run bf4 is not in .data/study' }, async () => {
  const grid = createGrid({})
  const studio = createStudio({ grid, encodeImage: () => new Uint8Array() })
  for (const line of readFileSync(join(BF4, 'events.ndjson'), 'utf8').split('\n')) {
    if (!line) continue
    const e = JSON.parse(line) as { type: string, turn: number, ok?: boolean, call?: { id: string, name: string, args: Record<string, unknown> } }
    if (e.type !== 'tool_result' || !e.ok || !e.call || e.turn > 4) continue
    if (!['declare_form', 'rough_out', 'detail'].includes(e.call.name)) continue
    await studio.run({ id: e.call.id, name: e.call.name, args: e.call.args } as never)
  }
  // The run itself ended its turn 4 with 6 kg: the plinth alone.
  assert.ok(stoneMassKg(grid) > 120, `${stoneMassKg(grid).toFixed(1)} kg left`)
})

test('the bust canon stands on a stem at least 10 cm thick, and keeps a bust\'s proportions to its head', () => {
  const head = { kind: 'head' as const, center: [0, 76, 2] as [number, number, number], size: [27, 40, 34] as [number, number, number], rotation: [5, 15, 0] as [number, number, number], style: ['female' as const, 'bun' as const] }
  // bf4's torso: its cut at 5 cm, almost on the plinth.
  const form = compileForm({ shapes: expandCanon([head, { kind: 'torso', center: [0, 28, 0], size: [55, 46, 28], rotation: [0, -8, 0], style: ['mantle', 'socle'] }]).shapes, blend: 1.4 })
  for (let y = 1; y < 10; y += 0.5) {
    let w = 0
    for (let x = -20; x <= 20; x += 0.25) if (formDistance(form, x, y, 0) < 0) w += 0.25
    assert.ok(w >= 10, `the stem is ${w} cm across at y ${y}`)
  }
  // 662's torso: a short trunk well below the chin, the head on a post.
  const fit = bustProportions({ center: [0, 38, -2], size: [54, 28, 28], rotation: [0, -8, 0] }, { center: [0, 72.5, 2], size: [27, 40, 34], rotation: [4, 14, -2] })
  assert.ok(fit.torso.size[0] >= 2.2 * 27 - 0.01, 'shoulders 2.2 head widths')
  assert.ok(fit.torso.size[2] >= 0.8 * 34 - 0.01, 'chest 0.8 of the head\'s depth')
  assert.ok(fit.torso.size[1] >= 40 - 0.01, 'the trunk as tall as the head')
  const top = fit.torso.center[1] + fit.torso.size[1] / 2
  assert.ok(top >= 52.5 - 40 / 3 - 0.01 && top <= 52.5 + 2 + 0.01, `shoulders at ${top}, the chin at 52.5`)
  assert.ok(fit.notes.length >= 2, fit.notes.join('; '))
  // A well-made torso is left alone.
  assert.deepEqual(bustProportions({ center: [0, 36, -1], size: [60, 46, 30], rotation: [0, 0, 0] }, { center: [0, 80, 1.5], size: [24, 35, 29.5], rotation: [0, 0, 0] }).notes, [])
})

test('a run whose stone fell is lost: under 5% of the block remains', () => {
  assert.ok(isLost(6.4, DEFAULT_CONFIG.block))
  assert.ok(!isLost(86, DEFAULT_CONFIG.block))
})
