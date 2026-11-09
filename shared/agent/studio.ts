// The kernel Studio: one validated tool call in, the true stone changed, a result the model can
// read out. The bench runs it in-process and the browser worker runs the same code, so nothing
// here touches the DOM or Node; PNG encoding is handed in.

import { DENSITY, stoneMassKg } from '../sculpt/grid.ts'
import { chisel, rasp, roughOut, saw, silhouetteForm } from '../sculpt/hand.ts'
import type { PassResult, RulerPoint } from '../sculpt/hand.ts'
import { measureAll } from '../sculpt/measure.ts'
import type { Mask, SideView } from '../sculpt/measure.ts'
import { renderContactSheet } from '../sculpt/observer.ts'
import type { Image, ImageLike, Overlay } from '../sculpt/observer.ts'
import { compileForm, declareForm, formDistance } from '../sculpt/shapes.ts'
import { applyStrike } from '../sculpt/strike.ts'
import { KERNEL_VERSION } from '../sculpt/version.ts'
import type { ViewId } from '../sculpt/views.ts'
import type { Form, FormStrike, Grid, Shape, Strike } from '../sculpt/types.ts'
import { REFERENCE_TARGET } from './toolSchemas.ts'
import type { ChiselArgs, DeclareFormArgs, LookArgs, RaspArgs, RoughOutArgs, SawArgs, ShapeArgs, StudioCall, ViewPoint } from './toolSchemas.ts'
import type { Studio, StudioResult, ToolCall } from './types.ts'

type Sides<T> = Partial<Record<SideView, T>>

// What the Studio needs of an analysed reference sheet (analyzeReference's result fits).
export interface StudioReference {
  ok: boolean
  // Block-aligned masks; front and left are what rough_out cuts to.
  masks: Sides<Mask> | null
  // The quadrants as drawn, and resampled onto the block's faces when they could be traced.
  tiles: Sides<ImageLike>
  aligned?: Sides<ImageLike> | null
}

export interface StudioOptions {
  grid: Grid
  encodeImage: (image: Image) => Uint8Array | Promise<Uint8Array>
  reference?: StudioReference | null
  // Roughly how many chisel strikes one rough_out may take.
  maxRoughStrikes?: number
  // A resumed commission: the log so far, already played onto `grid` (see replayLog).
  resume?: StrikeLog
}

export interface StrikeLog {
  // A log only replays on the kernel that wrote it.
  kernel: number
  grid: { width: number, height: number, depth: number, voxel: number, chunk: number }
  strikes: Strike[]
}

export interface KernelStudio extends Studio {
  grid: Grid
  // Every strike since the Studio was made, in order.
  strikes: Strike[]
  log(): StrikeLog
  // The forms the model declared, by name, in the order it first declared them.
  forms(): string[]
  // The numbers a look reports, without rendering anything.
  measure(overlay?: Overlay): Record<string, number>
  // A contact sheet outside the conversation (the judge's, the report's).
  render(views: ViewId[], overlay?: Overlay): Image
}

const r1 = (v: number) => Math.round(v * 10) / 10
const pt = (p: ViewPoint): RulerPoint => [p.h, p.v]

function kernelShape(s: ShapeArgs): Shape {
  return { kind: s.kind, center: [s.center_x, s.center_y, s.center_z], size: [s.size_x, s.size_y, s.size_z], rotation: [s.rot_x, s.rot_y, s.rot_z] }
}

// The same mask seen from the opposite side.
function mirrored(mask: Mask): Mask {
  const { width, height, data } = mask
  const out = new Uint8Array(width * height)
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) out[row * width + col] = data[row * width + width - 1 - col]!
  }
  return { width, height, data: out }
}

const LEGEND: Record<Overlay, string> = {
  grid: '',
  form: ' Colours: cyan line = outline of your forms; stone tinted yellow, orange, red = standing proud of the form by about 1, 4, 12+ cm (still to remove); blue to violet = cut below the form (cannot be put back).',
  reference: ' Colours: cyan line = reference outline; orange stone = outside the outline (still to remove); dark violet = outline with no stone behind it (lost); the yellow line on each REF tile is the stone\'s own outline.'
}

interface FormExtent { cm3: number, outsidePct: number, min: [number, number, number], max: [number, number, number], empty: boolean }

// Where a form sits against the block, by sampling: how much of it the block can hold, and its
// extent inside the block. Coarse on purpose; it is said to the model, not cut to.
function formExtent(grid: Grid, form: Form): FormExtent {
  const compiled = compileForm(form)
  const step = 2
  const reach = 20
  const [w, h, d] = grid.size
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  let inside = 0
  let outside = 0
  for (let z = -d / 2 - reach + step / 2; z < d / 2 + reach; z += step) {
    for (let y = -reach + step / 2; y < h + reach; y += step) {
      for (let x = -w / 2 - reach + step / 2; x < w / 2 + reach; x += step) {
        if (formDistance(compiled, x, y, z) >= 0) continue
        if (x < -w / 2 || x > w / 2 || y < 0 || y > h || z < -d / 2 || z > d / 2) {
          outside++
          continue
        }
        inside++
        if (x < min[0]) min[0] = x
        if (y < min[1]) min[1] = y
        if (z < min[2]) min[2] = z
        if (x > max[0]) max[0] = x
        if (y > max[1]) max[1] = y
        if (z > max[2]) max[2] = z
      }
    }
  }
  const half = step / 2
  return {
    cm3: inside * step * step * step,
    outsidePct: inside + outside === 0 ? 0 : 100 * outside / (inside + outside),
    min: [min[0] - half, min[1] - half, min[2] - half],
    max: [max[0] + half, max[1] + half, max[2] + half],
    empty: inside === 0
  }
}

export function createStudio(opts: StudioOptions): KernelStudio {
  const { grid } = opts
  const strikes: Strike[] = opts.resume ? opts.resume.strikes.slice() : []
  // Only what the model declared. rough_out to the reference declares a form of its own, and
  // that one must not show up in the model's form overlay or its numbers.
  const declared: string[] = []
  for (const s of strikes) {
    if (s.kind === 'form' && s.name !== REFERENCE_TARGET && !declared.includes(s.name)) declared.push(s.name)
  }
  const ref = opts.reference ?? null
  const front = ref?.ok ? ref.masks?.front : undefined
  const left = ref?.ok ? ref.masks?.left : undefined
  // The target is one solid, front ∩ left pushed through the block, so the back and right
  // outlines drawn and measured are those two seen from behind, not the sheet's own back and
  // right, which never agree with them exactly.
  const outlines: Sides<Mask> | null = front && left ? { front, left, back: mirrored(front), right: mirrored(left) } : null
  const tiles: Sides<ImageLike> | undefined = ref ? (ref.ok && ref.aligned ? ref.aligned : ref.tiles) : undefined
  let referenceDeclared = grid.forms.has(REFERENCE_TARGET)

  const measure = (overlay: Overlay = 'grid'): Record<string, number> => measureAll(grid, {
    forms: declared,
    ...(overlay === 'reference' && outlines ? { outlines: { front: outlines.front, left: outlines.left } } : {})
  })

  const render = (views: ViewId[], overlay: Overlay = 'grid'): Image => renderContactSheet(grid, views, {
    overlay,
    forms: declared,
    ...(overlay === 'reference' && outlines ? { reference: { tiles, outlines } } : {})
  })

  // Closes a pass: refusals throw (nothing was cut), everything else is logged and described.
  const settle = (pass: PassResult, extra: Record<string, number> = {}): StudioResult => {
    if (pass.error) throw new Error(pass.error)
    for (const s of pass.strikes) strikes.push(s)
    let summary = pass.summary
    if (pass.removedCm3 > 0) summary += ` In all ${pass.removedCm3 < 100 ? r1(pass.removedCm3) : Math.round(pass.removedCm3)} cm³ (${(pass.removedCm3 * DENSITY / 1000).toFixed(pass.removedCm3 < 1000 ? 2 : 1)} kg) came off.`
    if (pass.offcuts.length > 0) {
      const largest = Math.max(...pass.offcuts.map(o => o.cm3))
      summary += ` ${pass.offcuts.length} offcut${pass.offcuts.length === 1 ? '' : 's'} fell to the floor (largest ${Math.round(largest)} cm³).`
    }
    summary += ` ${stoneMassKg(grid).toFixed(1)} kg of stone remains.`
    return {
      summary,
      numbers: {
        removed_cm3: Math.round(pass.removedCm3),
        removed_kg: Math.round(pass.removedCm3 * DENSITY) / 1000,
        mass_kg: r1(stoneMassKg(grid)),
        offcuts: pass.offcuts.length,
        ...extra
      },
      strikes: pass.strikes
    }
  }

  const look = async (a: LookArgs): Promise<StudioResult> => {
    if (a.overlay === 'reference' && !outlines) throw new Error('there are no reference outlines in this commission; look with the grid overlay')
    const image = render(a.views, a.overlay)
    const png = await opts.encodeImage(image)
    const note = a.overlay === 'form' && declared.length === 0
      ? ' No form is declared yet, so the form overlay shows the plain stone.'
      : LEGEND[a.overlay]
    return {
      summary: `Looked from ${a.views.join(', ')} with the ${a.overlay} overlay.${note}`,
      numbers: measure(a.overlay),
      images: [png],
      strikes: []
    }
  }

  const declare = (a: DeclareFormArgs): StudioResult => {
    const form: Form = { shapes: a.shapes.map(kernelShape), blend: a.blend_cm }
    const extent = formExtent(grid, form)
    if (extent.empty) throw new Error(`no part of "${a.name}" lies inside the block (X ${-grid.size[0] / 2} to ${grid.size[0] / 2}, Y 0 to ${grid.size[1]}, Z ${-grid.size[2] / 2} to ${grid.size[2] / 2}); check the centres and sizes`)
    const strike: FormStrike = { kind: 'form', name: a.name, shapes: form.shapes, blend: form.blend }
    applyStrike(grid, strike)
    strikes.push(strike)
    const again = declared.includes(a.name)
    if (!again) declared.push(a.name)
    const { min, max } = extent
    let summary = `${again ? 'Replaced' : 'Declared'} form "${a.name}" (${a.shapes.length} shape${a.shapes.length === 1 ? '' : 's'}, blend ${r1(a.blend_cm)} cm). Inside the block it spans X ${r1(min[0])} to ${r1(max[0])}, Y ${r1(min[1])} to ${r1(max[1])}, Z ${r1(min[2])} to ${r1(max[2])} and holds about ${Math.round(extent.cm3 / 100) / 10} litres (${(extent.cm3 * DENSITY / 1000).toFixed(0)} kg). Nothing was cut.`
    if (extent.outsidePct > 2) summary += ` ${Math.round(extent.outsidePct)}% of the form lies outside the block, where there is no stone to make it from.`
    if (min[1] > 1.5) summary += ` It does not reach the base (it starts ${r1(min[1])} cm up): rough_out will refuse it until something in the form stands on the base.`
    if (declared.length > 1) summary += ` Looks and numbers measure the stone against all your forms together: ${declared.map(n => `"${n}"`).join(', ')}.`
    return {
      summary,
      numbers: { form_volume_cm3: Math.round(extent.cm3), form_y_min_cm: r1(min[1]), form_y_max_cm: r1(max[1]), form_outside_block_pct: r1(extent.outsidePct) },
      strikes: [strike]
    }
  }

  const rough = (a: RoughOutArgs): StudioResult => {
    const limit = opts.maxRoughStrikes === undefined ? {} : { max_strikes: opts.maxRoughStrikes }
    let pass: PassResult
    if (a.to === REFERENCE_TARGET) {
      if (!outlines) throw new Error(ref ? 'the reference sheet\'s outlines could not be traced, so there is nothing to rough out to; declare a form and rough out to that' : 'this commission has no reference sheet; declare a form and rough out to that')
      if (!referenceDeclared) {
        // Declared on the grid under the reserved name, so the pass's own log entry (and the
        // protection its strikes name) is "reference" and never collides with a model's form.
        declareForm(grid, REFERENCE_TARGET, silhouetteForm(outlines.front!, outlines.left!, { width: grid.size[0], height: grid.size[1], depth: grid.size[2] }))
        referenceDeclared = true
      }
      pass = roughOut(grid, { to: REFERENCE_TARGET, margin_cm: a.margin_cm, tool: a.tool, ...limit })
    } else {
      if (!declared.includes(a.to)) throw new Error(`no form named "${a.to}" has been declared${declared.length ? `; your forms: ${declared.map(n => `"${n}"`).join(', ')}` : '; declare one with declare_form first'}`)
      pass = roughOut(grid, { to: a.to, margin_cm: a.margin_cm, tool: a.tool, ...limit })
    }
    return settle(pass, pass.stats ? { outside_margin_max_cm: r1(pass.stats.proudMaxCm), outside_margin_mean_cm: Math.round(pass.stats.proudMeanCm * 100) / 100, saw_cuts: pass.stats.saws, chisel_strikes: pass.stats.chiselStrikes } : {})
  }

  const landed = (pass: PassResult): Record<string, number> => {
    const hit = pass.hits.filter(h => h.point !== null).length
    return { points_on_stone: hit, points_missed: pass.hits.length - hit }
  }

  const run = async (raw: ToolCall): Promise<StudioResult> => {
    const call = raw as StudioCall
    switch (call.name) {
      case 'look': return look(call.args)
      case 'declare_form': return declare(call.args)
      case 'rough_out': return rough(call.args)
      case 'saw': {
        const a: SawArgs = call.args
        return settle(saw(grid, { view: a.view, from: pt(a.from), to: pt(a.to), discard: a.discard }))
      }
      case 'chisel': {
        const a: ChiselArgs = call.args
        const pass = chisel(grid, { tool: a.tool, view: a.view, path: a.path.map(pt), depth_cm: a.depth_cm, width_cm: a.width_cm })
        return settle(pass, landed(pass))
      }
      case 'rasp': {
        const a: RaspArgs = call.args
        const pass = rasp(grid, { view: a.view, path: a.path.map(pt), width_cm: a.width_cm, passes: a.passes })
        return settle(pass, landed(pass))
      }
      default:
        throw new Error(`the studio has no tool called "${(raw as ToolCall).name}"`)
    }
  }

  return {
    grid,
    strikes,
    run,
    log: () => ({
      kernel: KERNEL_VERSION,
      grid: { width: grid.size[0], height: grid.size[1], depth: grid.size[2], voxel: grid.voxel, chunk: grid.chunk },
      strikes
    }),
    forms: () => declared.slice(),
    measure,
    render
  }
}

// Plays a log onto a fresh grid made by `make` and returns it. Throws on a kernel mismatch:
// a log replayed on another kernel would give a different stone without saying so.
export function replayLog(log: StrikeLog, make: (options: StrikeLog['grid']) => Grid): Grid {
  if (log.kernel !== KERNEL_VERSION) throw new Error(`this log was written by kernel ${log.kernel}; this is kernel ${KERNEL_VERSION}`)
  const grid = make(log.grid)
  for (const strike of log.strikes) applyStrike(grid, strike)
  return grid
}
