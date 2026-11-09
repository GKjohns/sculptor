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

  await assert.rejects(studio.run(call('glue', {})), /no tool called "glue"/)
})

test('the Sprint 3 tools: sketch, close-up, slice, roundel, protected strokes, drill and polish', async () => {
  const studio = fresh(true)
  const untouched = hashGrid(studio.grid)

  // Charcoal: one log entry, no stone moved, and the Studio keeps the line for its looks.
  const line = await studio.run(call('sketch', { view: 'front', path: [{ h: -12, v: 30 }, { h: 0, v: 90 }, { h: 12, v: 30 }], why: 'Marking the profile.' }))
  assert.equal(hashGrid(studio.grid), untouched)
  assert.deepEqual(line.strikes.map(s => s.kind), ['sketch'])
  assert.deepEqual(studio.sketches(), line.strikes)
  assert.ok(line.numbers!.line_on_stone_cm! > 110 && line.numbers!.lines_drawn === 1)
  assert.match(line.summary, /Charcoal from the front view/)
  await assert.rejects(studio.run(call('sketch', { view: 'front', path: [{ h: 40, v: 30 }, { h: 50, v: 90 }], why: 'x' })), /does not lie on the stone/)
  assert.equal(studio.strikes.length, 1)
  // It shows in a look: the same sheet without it is a different picture.
  const withLine = await studio.run(call('look', { views: ['front'], overlay: 'grid' }))
  const bare = createStudio({ grid: studio.grid, encodeImage: encode })
  const without = await bare.run(call('look', { views: ['front'], overlay: 'grid' }))
  assert.notDeepEqual(decodePng(withLine.images![0]!).data, decodePng(without.images![0]!).data)

  await studio.run(call('declare_form', FIGURE))
  await studio.run(call('rough_out', { to: 'figure', margin_cm: 2, tool: 'point', why: 'x' }))

  // A close-up is a look at part of one view: an image, numbers for the window, no strikes.
  const near = await studio.run(call('closeup', { view: 'front', center: { h: 0, v: 70 }, span_cm: 24, overlay: 'form' }))
  assert.equal(near.images!.length, 1)
  assert.equal(near.strikes.length, 0)
  assert.ok(decodePng(near.images![0]!).width > 600)
  assert.ok(near.numbers!.window_stone_pct! > 50 && near.numbers!.relief_cm! > 2 && near.numbers!.surface_z_max_cm! > near.numbers!.surface_z_min_cm!)
  assert.ok('window_proud_max_cm' in near.numbers! && 'window_below_form_max_cm' in near.numbers!)
  assert.match(near.summary, /Close-up of the front view, 24 cm across, centred on \(0, 70\)/)
  // With the reference, the same window of the sheet sits beside it.
  const beside = await studio.run(call('closeup', { view: 'front', center: { h: 0, v: 70 }, span_cm: 24, overlay: 'reference' }))
  assert.ok(decodePng(beside.images![0]!).width > 1.8 * decodePng(near.images![0]!).width)
  await assert.rejects(fresh().run(call('closeup', { view: 'front', center: { h: 0, v: 70 }, span_cm: 24, overlay: 'reference' })), /no reference outlines/)

  // A slice: an image and the section's numbers, against the form and the reference.
  const cut = await studio.run(call('slice', { axis: 'y', at_cm: 45 }))
  assert.equal(cut.images!.length, 1)
  assert.equal(cut.strikes.length, 0)
  // The figure's ellipsoid is 36 cm across at its middle, plus the margin.
  assert.ok(Math.abs(cut.numbers!.section_x_max_cm! - cut.numbers!.section_x_min_cm! - 41) < 4, JSON.stringify(cut.numbers))
  assert.ok(Math.abs(cut.numbers!.section_form_area_cm2! - Math.PI * 18 * 18) < 40)
  assert.ok(cut.numbers!.section_stone_outside_form_cm2! > 100 && 'section_reference_area_cm2' in cut.numbers!)
  assert.match(cut.summary, /Slice at Y 45, seen from above/)
  assert.equal((await studio.run(call('slice', { axis: 'y', at_cm: 99 }))).numbers!.section_area_cm2, 0)
  await assert.rejects(studio.run(call('slice', { axis: 'x', at_cm: 31 })), /the block runs from -30 to 30 on X/)

  // Strokes: a roundel channel, and a stroke that names a form cannot cut into it.
  const logged = studio.strikes.length
  const groove = await studio.run(call('chisel', { tool: 'roundel', view: 'front', path: [{ h: -6, v: 60 }, { h: 6, v: 60 }], depth_cm: 1, width_cm: 2, protect: 'none', why: 'A fold.' }))
  assert.ok(groove.strikes.some(s => s.kind === 'cut' && s.tool === 'roundel'))
  assert.match(groove.summary, /^Roundel from the front view/)
  const guarded = await studio.run(call('chisel', { tool: 'point', view: 'front', path: [{ h: -6, v: 50 }, { h: 6, v: 50 }], depth_cm: 6, width_cm: 4, protect: 'figure', why: 'Clearing down to the form.' }))
  assert.ok(guarded.strikes.filter(s => s.kind === 'cut').every(s => s.kind === 'cut' && s.protect === 'figure'))
  assert.match(guarded.summary, /'figure'/)
  assert.equal((await studio.run(call('look', { views: ['front'], overlay: 'form' }))).numbers!.form_overcut_cm3, studio.measure('form').form_overcut_cm3)
  await assert.rejects(studio.run(call('chisel', { tool: 'flat', view: 'front', path: [{ h: -6, v: 50 }, { h: 6, v: 50 }], depth_cm: 1, width_cm: 2, protect: 'torso', why: 'x' })), /no form named "torso" has been declared; your forms: "figure"\. Pass protect "none"/)

  const hole = await studio.run(call('drill', { view: 'top', at: { h: 0, v: 0 }, diameter_cm: 2, depth_cm: 5, why: 'A socket.' }))
  assert.ok(hole.strikes.some(s => s.kind === 'cut' && s.tool === 'drill'))
  assert.ok(Math.abs(hole.numbers!.depth_reached_cm! - 5) < 1 && hole.numbers!.broke_through === 0 && hole.numbers!.removed_cm3! > 5)
  assert.match(hole.summary, /Drill from the top view at \[0, 0\]: the bit went in at \(x 0\.0, y 8\d\.\d, z 0\.0\)/)

  // Polish: the shape and the mass stay; the finish, and so the numbers, change.
  await studio.run(call('rasp', { view: 'front', path: [{ h: -8, v: 40 }, { h: 8, v: 40 }], width_cm: 8, passes: 2, why: 'x' }))
  const mass = stoneMassKg(studio.grid)
  const dist = studio.grid.dist.slice()
  const shine = await studio.run(call('polish', { view: 'front', path: [{ h: -8, v: 40 }, { h: 8, v: 40 }], width_cm: 8, passes: 4, why: 'Bringing up the chest.' }))
  assert.deepEqual(studio.grid.dist, dist)
  assert.equal(stoneMassKg(studio.grid), mass)
  assert.equal(shine.numbers!.removed_cm3, 0)
  assert.ok(shine.numbers!.finish_after! > shine.numbers!.finish_before! + 40 && shine.numbers!.surface_polished_pct! > 0)
  assert.ok(shine.strikes.every(s => s.kind === 'cut' && s.tool === 'polish'))
  assert.equal((await studio.run(call('look', { views: ['front'], overlay: 'grid' }))).numbers!.surface_polished_pct, shine.numbers!.surface_polished_pct)

  // Every one of them is in the log, the log replays to the same stone, and a Studio
  // resumed from it still has the charcoal.
  assert.ok(studio.strikes.length > logged + 20)
  const saved = JSON.parse(JSON.stringify(studio.log())) as ReturnType<typeof studio.log>
  assert.equal(saved.kernel, KERNEL_VERSION)
  const replayed = replayLog(saved, g => createGrid(g))
  assert.equal(hashGrid(replayed), hashGrid(studio.grid))
  const resumed = createStudio({ grid: replayed, encodeImage: encode, resume: saved })
  assert.deepEqual(resumed.sketches(), JSON.parse(JSON.stringify(studio.sketches())))
  assert.deepEqual(resumed.forms(), ['figure'])
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
