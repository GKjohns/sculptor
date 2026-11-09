import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodePng, encodePng } from '../bench/png.ts'
import { dryReference } from '../bench/reference.ts'
import { scriptedBrain } from '../bench/script.ts'
import { runCommission } from '../shared/agent/loop.ts'
import { createStudio, replayLog } from '../shared/agent/studio.ts'
import type { KernelStudio } from '../shared/agent/studio.ts'
import type { LoopEvent, ToolCall } from '../shared/agent/types.ts'
import { createGrid, hashGrid, stoneMassKg } from '../shared/sculpt/grid.ts'
import type { Image } from '../shared/sculpt/observer.ts'
import { KERNEL_VERSION } from '../shared/sculpt/version.ts'

// A coarse stone keeps the suite quick: same block, 1 cm voxels.
const VOXEL = 1
const encode = (image: Image) => encodePng(image.data, image.width, image.height)
const reference = dryReference('bust').analysis!

function fresh(withReference = false): KernelStudio {
  return createStudio({ grid: createGrid({ voxel: VOXEL }), encodeImage: encode, reference: withReference ? reference : null, maxRoughStrikes: 600 })
}

let ids = 0
const call = (name: string, args: unknown): ToolCall => ({ id: `t${++ids}`, name, args })

const shape = (kind: string, c: number[], s: number[]) => ({ kind, center_x: c[0], center_y: c[1], center_z: c[2], size_x: s[0], size_y: s[1], size_z: s[2], rot_x: 0, rot_y: 0, rot_z: 0 })
const FIGURE = { name: 'figure', shapes: [shape('box', [0, 5, 0], [40, 10, 40]), shape('ellipsoid', [0, 45, 0], [36, 80, 36])], blend_cm: 2, why: 'Setting out the mass.' }

test('declare_form moves no stone, logs a form entry and says where the form sits', async () => {
  const studio = fresh()
  const before = hashGrid(studio.grid)
  const r = await studio.run(call('declare_form', FIGURE))
  assert.equal(hashGrid(studio.grid), before)
  assert.equal(r.strikes.length, 1)
  assert.deepEqual(r.strikes[0], {
    kind: 'form',
    name: 'figure',
    shapes: [
      { kind: 'box', center: [0, 5, 0], size: [40, 10, 40], rotation: [0, 0, 0] },
      { kind: 'ellipsoid', center: [0, 45, 0], size: [36, 80, 36], rotation: [0, 0, 0] }
    ],
    blend: 2
  })
  assert.deepEqual(studio.strikes, r.strikes)
  assert.deepEqual(studio.forms(), ['figure'])
  assert.match(r.summary, /Declared form "figure" \(2 shapes/)
  assert.match(r.summary, /Nothing was cut/)
  assert.ok(Math.abs(r.numbers!.form_y_max_cm! - 85) <= 2, `top ${r.numbers!.form_y_max_cm}`)
  assert.ok(!/does not reach the base/.test(r.summary))

  // Declaring the name again replaces it and does not list it twice.
  const again = await studio.run(call('declare_form', { ...FIGURE, shapes: [shape('ellipsoid', [0, 60, 0], [30, 30, 30])] }))
  assert.match(again.summary, /Replaced form "figure"/)
  assert.match(again.summary, /does not reach the base/)
  assert.deepEqual(studio.forms(), ['figure'])

  // A form with nothing inside the block is refused before it reaches the log.
  const logged = studio.strikes.length
  await assert.rejects(studio.run(call('declare_form', { ...FIGURE, name: 'lost', shapes: [shape('box', [200, 50, 0], [10, 10, 10])] })), /no part of "lost" lies inside the block/)
  assert.equal(studio.strikes.length, logged)
  assert.deepEqual(studio.forms(), ['figure'])
})

test('rough_out cuts to a declared form, and a refused pass throws and leaves the stone alone', async () => {
  const studio = fresh()
  const untouched = hashGrid(studio.grid)
  await assert.rejects(studio.run(call('rough_out', { to: 'figure', margin_cm: 4, tool: 'point', why: 'x' })), /no form named "figure" has been declared; declare one with declare_form first/)
  assert.equal(hashGrid(studio.grid), untouched)
  assert.equal(studio.strikes.length, 0)

  await studio.run(call('declare_form', FIGURE))
  // The hand's own refusal (a form that floats) comes back as a throw too.
  await studio.run(call('declare_form', { ...FIGURE, name: 'floating', shapes: [shape('ellipsoid', [0, 70, 0], [20, 20, 20])] }))
  const logged = studio.strikes.length
  await assert.rejects(studio.run(call('rough_out', { to: 'floating', margin_cm: 2, tool: 'point', why: 'x' })), /does not reach the bottom of the stone/)
  assert.equal(hashGrid(studio.grid), untouched)
  assert.equal(studio.strikes.length, logged)

  const before = stoneMassKg(studio.grid)
  const r = await studio.run(call('rough_out', { to: 'figure', margin_cm: 4, tool: 'point', why: 'Taking the waste off.' }))
  assert.ok(r.strikes.length > 50)
  assert.deepEqual(studio.strikes.slice(logged), r.strikes)
  assert.equal(r.strikes[0]!.kind, 'form')
  const after = stoneMassKg(studio.grid)
  assert.ok(after < 0.6 * before, `${before} → ${after} kg`)
  assert.ok(Math.abs(r.numbers!.mass_kg! - after) < 0.06)
  assert.ok(Math.abs(r.numbers!.removed_kg! - (before - after)) < 0.01)
  assert.ok(r.numbers!.chisel_strikes! > 0)
  assert.match(r.summary, /Roughed out to 'figure' with the point chisel, leaving 4 cm/)
  assert.match(r.summary, /kg of stone remains\.$/)
})

test('saw, chisel and rasp take {h, v} points and report where they landed', async () => {
  const studio = fresh()
  const full = stoneMassKg(studio.grid)
  const sawn = await studio.run(call('saw', { view: 'front', from: { h: -30, v: 80 }, to: { h: 30, v: 80 }, discard: 'above', why: 'Taking the top off.' }))
  assert.ok(Math.abs(stoneMassKg(studio.grid) / full - 0.8) < 0.01)
  assert.equal(sawn.numbers!.offcuts, 1)
  assert.match(sawn.summary, /Sawed from \[-30, 80\] to \[30, 80\] in the front view/)
  assert.match(sawn.summary, /1 offcut fell to the floor/)
  assert.deepEqual(sawn.strikes.map(s => s.kind), ['saw', 'detach'])

  // h is Z and v is Y from the left: the stroke lands on the -X face.
  const cut = await studio.run(call('chisel', { tool: 'point', view: 'left', path: [{ h: -10, v: 40 }, { h: 10, v: 40 }], depth_cm: 2, width_cm: 4, why: 'A groove.' }))
  assert.match(cut.summary, /Point chisel from the left view: It ran on the stone from \(x -30\.0, y 40\.0, z -10\.0\) to \(x -30\.0, y 40\.0, z 10\.0\)/)
  assert.ok(cut.numbers!.removed_cm3! > 20)
  assert.equal(cut.numbers!.points_missed, 0)
  assert.ok(cut.strikes.some(s => s.kind === 'cut' && s.tool === 'point'))

  // Above the sawn top there is nothing to hit: said plainly, not thrown.
  const miss = await studio.run(call('chisel', { tool: 'flat', view: 'front', path: [{ h: -5, v: 90 }, { h: 5, v: 90 }], depth_cm: 1, width_cm: 2, why: 'Too high.' }))
  assert.match(miss.summary, /None of the \d+ points along the path met the stone/)
  assert.equal(miss.numbers!.points_on_stone, 0)
  assert.equal(miss.numbers!.removed_cm3, 0)

  const smooth = await studio.run(call('rasp', { view: 'top', path: [{ h: -10, v: 0 }, { h: 10, v: 0 }], width_cm: 6, passes: 2, why: 'Smoothing the top.' }))
  assert.match(smooth.summary, /Rasp from the top view/)
  assert.ok(smooth.strikes.some(s => s.kind === 'cut' && s.tool === 'rasp'))

  await assert.rejects(studio.run(call('polish', {})), /no tool called "polish"/)
})

test('look returns one PNG and numbers, measured against the model\'s own forms only', async () => {
  const studio = fresh(true)
  const plain = await studio.run(call('look', { views: ['front', 'left', 'front_left'], overlay: 'grid' }))
  assert.equal(plain.images!.length, 1)
  assert.equal(plain.strikes.length, 0)
  const png = decodePng(plain.images![0]!)
  assert.ok(png.width > 300 && png.height > 200)
  assert.equal(plain.numbers!.mass_kg, 975.6)
  assert.equal(plain.numbers!.bbox_y_max_cm, 100)
  assert.ok(!('form_proud_max_cm' in plain.numbers!))
  assert.ok(!('silhouette_front_iou' in plain.numbers!))

  // rough_out to the reference declares a form of its own on the grid. It must not turn up
  // as one of the model's.
  const rough = await studio.run(call('rough_out', { to: 'reference', margin_cm: 3, tool: 'point', why: 'Down to the drawing.' }))
  assert.ok(rough.strikes.length > 50)
  assert.equal(rough.strikes[0]!.kind === 'form' && rough.strikes[0]!.name, 'reference')
  assert.ok(studio.grid.forms.has('reference'))
  assert.deepEqual(studio.forms(), [])
  const noForm = await studio.run(call('look', { views: ['front'], overlay: 'form' }))
  assert.ok(!('form_proud_max_cm' in noForm.numbers!))
  assert.match(noForm.summary, /No form is declared yet/)

  await studio.run(call('declare_form', FIGURE))
  const formed = await studio.run(call('look', { views: ['front', 'top'], overlay: 'form' }))
  assert.ok(formed.numbers!.form_proud_max_cm! > 0)
  assert.ok('form_overcut_cm3' in formed.numbers!)
  assert.match(formed.summary, /cyan line = outline of your forms/)
  assert.deepEqual(studio.measure('form'), formed.numbers)

  const beside = await studio.run(call('look', { views: ['front', 'left', 'back'], overlay: 'reference' }))
  assert.ok(beside.numbers!.silhouette_front_iou! > 0.6, `front IoU ${beside.numbers!.silhouette_front_iou}`)
  assert.ok(beside.numbers!.silhouette_left_iou! > 0.6)
  assert.ok(!('silhouette_back_iou' in beside.numbers!))
  // Each side view sits beside its reference tile, so the sheet is wider than the plain one.
  assert.ok(decodePng(beside.images![0]!).width > decodePng((await studio.run(call('look', { views: ['front', 'left', 'back'], overlay: 'grid' }))).images![0]!).width)
})

test('without a traced reference, the reference target and overlay are refused', async () => {
  const studio = fresh()
  await assert.rejects(studio.run(call('rough_out', { to: 'reference', margin_cm: 3, tool: 'point', why: 'x' })), /no reference sheet/)
  await assert.rejects(studio.run(call('look', { views: ['front'], overlay: 'reference' })), /no reference outlines/)
  const viewOnly = createStudio({ grid: createGrid({ voxel: VOXEL }), encodeImage: encode, reference: { ok: false, masks: null, tiles: reference.tiles } })
  await assert.rejects(viewOnly.run(call('rough_out', { to: 'reference', margin_cm: 3, tool: 'point', why: 'x' })), /could not be traced/)
  assert.equal(viewOnly.strikes.length, 0)
})

test('the log is stamped with the kernel version and replays to the same stone', async () => {
  const studio = fresh()
  await studio.run(call('declare_form', FIGURE))
  await studio.run(call('rough_out', { to: 'figure', margin_cm: 3, tool: 'claw', why: 'x' }))
  await studio.run(call('saw', { view: 'right', from: { h: -30, v: 95 }, to: { h: 30, v: 95 }, discard: 'above', why: 'x' }))
  await studio.run(call('chisel', { tool: 'flat', view: 'front', path: [{ h: -4, v: 50 }, { h: 4, v: 50 }], depth_cm: 0.8, width_cm: 3, why: 'x' }))
  const log = studio.log()
  assert.equal(log.kernel, KERNEL_VERSION)
  assert.deepEqual(log.grid, { width: 60, height: 100, depth: 60, voxel: VOXEL, chunk: 32 })
  // Through JSON, as the bench saves it.
  const saved = JSON.parse(JSON.stringify(log)) as typeof log
  const replayed = replayLog(saved, g => createGrid(g))
  assert.equal(hashGrid(replayed), hashGrid(studio.grid))
  assert.throws(() => replayLog({ ...saved, kernel: KERNEL_VERSION + 1 }, g => createGrid(g)), /written by kernel/)

  // A resumed Studio knows the forms and carries the log on.
  const resumed = createStudio({ grid: replayed, encodeImage: encode, resume: saved })
  assert.deepEqual(resumed.forms(), ['figure'])
  assert.equal(resumed.strikes.length, saved.strikes.length)
  const more = { tool: 'point', view: 'back', path: [{ h: -4, v: 30 }, { h: 4, v: 30 }], depth_cm: 2, width_cm: 4, why: 'x' }
  await resumed.run(call('chisel', more))
  await studio.run(call('chisel', more))
  assert.equal(hashGrid(resumed.grid), hashGrid(studio.grid))
  assert.deepEqual(resumed.strikes, JSON.parse(JSON.stringify(studio.strikes)))
})

for (const arm of [{ toolSet: 'formed', withReference: true }, { toolSet: 'formed', withReference: false }, { toolSet: 'direct', withReference: false }] as const) {
  test(`dry run end to end: scripted Brain, real loop, real Studio (${arm.toolSet}${arm.withReference ? ', reference' : ''})`, async () => {
    const sheet = dryReference('bust')
    assert.equal(sheet.outlines, true, sheet.attempts[0]?.reasons.join('; ') ?? '')
    const studio = createStudio({ grid: createGrid({ voxel: VOXEL }), encodeImage: encode, reference: arm.withReference ? sheet.analysis : null, maxRoughStrikes: 600 })
    const events: LoopEvent[] = []
    const result = await runCommission({
      brain: scriptedBrain({ subject: 'bust', toolSet: arm.toolSet, reference: arm.withReference ? 'outlines' : 'none' }),
      studio,
      commission: { prompt: 'A bust.', ...(arm.withReference ? { reference: { png: sheet.png!, outlines: true } } : {}) },
      config: { toolSet: arm.toolSet, maxTurns: 20, maxUsd: 1 },
      onEvent: e => events.push(e)
    })
    assert.equal(result.ended, 'finish', result.error ?? '')
    assert.ok(result.finish!.title.startsWith('Dry bust'))
    assert.ok(result.notebook.text.length > 0)

    const used = new Set(result.passes.map(p => p.tool))
    const expected = arm.toolSet === 'formed' ? ['declare_form', 'rough_out', 'saw', 'chisel', 'rasp'] : ['saw', 'chisel']
    assert.deepEqual([...used].sort(), expected.slice().sort())
    assert.ok(result.passes.every(p => p.why.length > 0))

    const results = events.filter(e => e.type === 'tool_result')
    const refused = results.filter(e => !e.ok).map(e => e.summary)
    if (arm.toolSet === 'formed') {
      assert.ok(refused.some(s => /was refused: no form named "nope"/.test(s)), refused.join(' | '))
      assert.ok(refused.some(s => /Invalid arguments for chisel/.test(s)), refused.join(' | '))
      if (arm.withReference) assert.ok(result.passes.some(p => p.tool === 'rough_out' && p.args.to === 'reference'))
    } else {
      assert.ok(refused.some(s => /no tool called "rasp"/.test(s)), refused.join(' | '))
    }
    // Refused calls reach neither the record nor the log.
    assert.equal(refused.length, arm.toolSet === 'formed' ? 2 : 1)
    assert.equal(result.passes.reduce((n, p) => n + p.strikes, 0), studio.strikes.length)

    const looks = events.filter(e => e.type === 'look')
    assert.ok(looks.length >= 2 && looks.every(e => e.images.length === 1))
    assert.ok(looks.some(e => !e.auto))
    if (arm.withReference) assert.ok(looks.some(e => e.overlay === 'reference' && e.numbers!.silhouette_front_iou! > 0.7))

    assert.ok(stoneMassKg(studio.grid) < 975)
    assert.equal(hashGrid(replayLog(JSON.parse(JSON.stringify(studio.log())), g => createGrid(g))), hashGrid(studio.grid))
  })
}
