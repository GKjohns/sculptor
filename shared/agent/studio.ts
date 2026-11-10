// The kernel Studio: one validated tool call in, the true stone changed, a result the model can
// read out. The bench runs it in-process and the browser worker runs the same code, so nothing
// here touches the DOM or Node; PNG encoding is handed in.

import { DENSITY, cloneGrid, stoneMassKg } from '../sculpt/grid.ts'
import { chisel, drill, incise, polish, rasp, roughOut, saw, silhouetteForm, sketch } from '../sculpt/hand.ts'
import type { PassResult, RulerPoint } from '../sculpt/hand.ts'
import { SLICE_VIEW, measureAll, measureSlice, surfaceFinish } from '../sculpt/measure.ts'
import type { Mask, SideView } from '../sculpt/measure.ts'
import { PROFILE_SAMPLES, renderCloseup, renderContactSheet, renderSlice } from '../sculpt/observer.ts'
import type { Image, ImageLike, Overlay } from '../sculpt/observer.ts'
import { compileForm, declareForm, formDistance } from '../sculpt/shapes.ts'
import { applyStrike } from '../sculpt/strike.ts'
import { KERNEL_VERSION } from '../sculpt/version.ts'
import type { AxisView, ViewId } from '../sculpt/views.ts'
import { expandCanon, settleCuts } from '../sculpt/anatomy.ts'
import type { DeclaredShape, RoughCut } from '../sculpt/anatomy.ts'
import { GROUND_CAP_SHARE, capGround, expandScene } from '../sculpt/figure.ts'
import type { AnimalSpec, FigureSpec } from '../sculpt/figure.ts'
import { VIEWS } from '../sculpt/views.ts'
import type { CanonCut, Form, FormStrike, Grid, Shape, SketchStrike, Strike, Vec3 } from '../sculpt/types.ts'
import { FOCUS_STROKE_SHARE, NO_PROTECT, REFERENCE_TARGET } from './toolSchemas.ts'
import type { AnimalArgs, ChiselArgs, CloseupArgs, DeclareFigureArgs, DeclareFormArgs, FigureArgs, DetailArgs, DrillArgs, FocusArgs, LookArgs, PolishArgs, RaspArgs, RoughOutArgs, SawArgs, ShapeArgs, SketchArgs, SliceArgs, StudioCall, UnfocusArgs, ViewPoint } from './toolSchemas.ts'
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
  // The charcoal lines drawn so far, oldest first: the log's own `sketch` entries.
  sketches(): SketchStrike[]
  // Detail mode: the window the sculptor is focused on, or null.
  focus(): Focus | null
  // The numbers a look reports, without rendering anything.
  measure(overlay?: Overlay): Record<string, number>
  // A contact sheet outside the conversation (the judge's, the report's).
  render(views: ViewId[], overlay?: Overlay): Image
}

export interface Focus { view: AxisView, center: ViewPoint, span: number }

const r1 = (v: number) => Math.round(v * 10) / 10

// The sever guard's threshold: about a kilo of a declared form in one falling piece.
export const SEVER_CM3 = 370
const pt = (p: ViewPoint): RulerPoint => [p.h, p.v]

export function figureSpec(f: FigureArgs): FigureSpec {
  return {
    body: f.body, build: f.build, ground: [f.ground_x, f.ground_y, f.ground_z], height: f.height_cm, facing: f.facing_deg,
    legs: f.legs, weightOn: f.weight_on, twist: f.twist_deg, lean: f.lean_deg, headTurn: f.head_turn_deg, headTilt: f.head_tilt_deg,
    leftArm: f.left_arm, rightArm: f.right_arm, drapery: f.drapery, support: f.support, style: f.style
  }
}

export function animalSpec(n: AnimalArgs): AnimalSpec {
  return {
    species: n.species, pose: n.pose, ground: [n.ground_x, n.ground_y, n.ground_z], length: n.length_cm, facing: n.facing_deg,
    headTurn: n.head_turn_deg, headRaise: n.head_raise_deg, tail: n.tail, lead: n.lead
  }
}

function declaredShape(s: ShapeArgs): DeclaredShape {
  return { kind: s.kind, center: [s.center_x, s.center_y, s.center_z], size: [s.size_x, s.size_y, s.size_z], rotation: [s.rot_x, s.rot_y, s.rot_z], ...(s.style && s.style.length > 0 ? { style: s.style } : {}) }
}

// Two passes of one call as one result.
function joined(a: PassResult, b: PassResult): PassResult {
  return {
    ...a,
    strikes: [...a.strikes, ...b.strikes],
    removedCm3: a.removedCm3 + b.removedCm3,
    hits: [...a.hits, ...b.hits],
    offcuts: [...a.offcuts, ...b.offcuts],
    ms: a.ms + b.ms,
    summary: b.summary ? `${a.summary} ${b.summary}` : a.summary
  }
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
  const drawn: SketchStrike[] = strikes.filter(s => s.kind === 'sketch')
  // The canon's hollows on each declared form, from its latest declaration.
  const cutsOf = new Map<string, CanonCut[]>()
  for (const s of strikes) if (s.kind === 'form' && s.name !== REFERENCE_TARGET) cutsOf.set(s.name, s.cuts ?? [])
  const ref = opts.reference ?? null
  const front = ref?.ok ? ref.masks?.front : undefined
  const left = ref?.ok ? ref.masks?.left : undefined
  // The target is one solid, front ∩ left pushed through the block, so the back and right
  // outlines drawn and measured are those two seen from behind, not the sheet's own back and
  // right, which never agree with them exactly.
  const outlines: Sides<Mask> | null = front && left ? { front, left, back: mirrored(front), right: mirrored(left) } : null
  const tiles: Sides<ImageLike> | undefined = ref ? (ref.ok && ref.aligned ? ref.aligned : ref.tiles) : undefined
  let referenceDeclared = grid.forms.has(REFERENCE_TARGET)
  // The form the stone was last cut to, which the rasp then keeps off: a rasp that could wear
  // a declared nose down would undo the pass that brought it out.
  let focus: Focus | null = null
  let guarded: string | undefined
  for (const s of strikes) {
    if (s.kind === 'cut' && s.protect !== undefined && s.protect !== REFERENCE_TARGET && s.margin !== undefined) guarded = s.protect
  }

  const measure = (overlay: Overlay = 'grid'): Record<string, number> => measureAll(grid, {
    forms: declared,
    ...(overlay === 'reference' && outlines ? { outlines: { front: outlines.front, left: outlines.left } } : {})
  })

  const lookOptions = (overlay: Overlay) => ({
    overlay,
    forms: declared,
    sketches: drawn,
    ...(overlay === 'reference' && outlines ? { reference: { tiles, outlines } } : {})
  })

  const render = (views: ViewId[], overlay: Overlay = 'grid'): Image => renderContactSheet(grid, views, lookOptions(overlay))

  // Closes a pass: refusals throw (nothing was cut), everything else is logged and described.
  // ---------- the sever guard ----------
  // No pass may cut the piece free of its base. A pass that can (rough_out, detail, saw) is
  // carried out on a copy of the stone first; if a piece it drops holds more than about a kilo
  // of a declared form (the bust that fell when a detail from the top shaved through its stem),
  // the pass is refused and the stone is left as it was. Waste never counts: what is inside a
  // piece is told by stepping a centimetre in from its surface and asking the forms.
  const severed = (pass: PassResult, on: Grid): { cm3: number, at: Vec3, form: string } | null => {
    const forms = declared.map(n => [n, on.forms.get(n)] as const).filter((f): f is readonly [string, NonNullable<typeof f[1]>] => f[1] !== undefined)
    if (forms.length === 0) return null
    for (const o of pass.offcuts) {
      if (o.cm3 < SEVER_CM3) continue
      const verts = o.positions.length / 3
      const step = Math.max(1, Math.floor(verts / 400))
      let tested = 0
      const inside = new Map<string, number>()
      for (let v = 0; v < verts; v += step) {
        const p: Vec3 = [o.positions[3 * v]! - o.normals[3 * v]!, o.positions[3 * v + 1]! - o.normals[3 * v + 1]!, o.positions[3 * v + 2]! - o.normals[3 * v + 2]!]
        tested++
        for (const [n, f] of forms) if (formDistance(f, p[0], p[1], p[2]) < -0.2) inside.set(n, (inside.get(n) ?? 0) + 1)
      }
      for (const [n, count] of inside) {
        const cm3 = count / tested * o.cm3
        if (cm3 >= SEVER_CM3) return { cm3, at: o.centroid, form: n }
      }
    }
    return null
  }
  const guardedPass = (tool: string, run: (on: Grid) => PassResult): PassResult => {
    const copy = cloneGrid(grid)
    const pass = run(copy)
    if (pass.error) return pass
    const cut = severed(pass, copy)
    if (cut) {
      const kg = (cut.cm3 * DENSITY / 1000).toFixed(cut.cm3 < 3000 ? 1 : 0)
      throw new Error(`this ${tool} would cut the piece free of its base: about ${kg} kg of "${cut.form}" around (${r1(cut.at[0])}, ${r1(cut.at[1])}, ${r1(cut.at[2])}) would fall, because nothing left would join it to the stone below. Nothing was cut. Leave more stone where it joins the base (a larger margin, a window that stops short of the join, a ${tool === 'saw' ? 'cut that does not cross the piece' : 'thicker join in the form'})`)
    }
    grid.dist.set(copy.dist)
    grid.finish.set(copy.finish)
    for (let i = 0; i < grid.dirty.length; i++) grid.dirty[i] = grid.dirty[i]! | copy.dirty[i]!
    grid.solidUnits = copy.solidUnits
    for (const [n, f] of copy.forms) grid.forms.set(n, f)
    return pass
  }

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
    if (focus) {
      const f = focus
      const r = await closeup({ view: f.view, center: f.center, span_cm: f.span, overlay: a.overlay }, `You are focused on the ${f.view} view, ${r1(f.span)} cm round (${r1(f.center.h)}, ${r1(f.center.v)}), so this look is that window (unfocus to see the whole stone), with the ${a.overlay} overlay and a grid line every centimetre.`)
      return { ...r, views: [f.view] }
    }
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

  const closeup = async (a: CloseupArgs, lead?: string): Promise<StudioResult> => {
    if (a.overlay === 'reference' && !outlines) throw new Error('there are no reference outlines in this commission; use the grid overlay')
    const shot = renderCloseup(grid, a.view, [a.center.h, a.center.v], a.span_cm, lookOptions(a.overlay))
    const png = await opts.encodeImage(shot.image)
    const axis = shot.axis.toUpperCase()
    const numbers: Record<string, number> = { window_stone_pct: r1(100 * shot.stoneShare) }
    let summary = lead ?? `Close-up of the ${a.view} view, ${r1(a.span_cm)} cm across, centred on (${r1(a.center.h)}, ${r1(a.center.v)}), with the ${a.overlay} overlay and a grid line every centimetre.`
    if (shot.stoneShare === 0) {
      summary += ' There is no stone in that window.'
    } else {
      numbers[`surface_${shot.axis}_min_cm`] = r1(shot.surfaceMin)
      numbers[`surface_${shot.axis}_max_cm`] = r1(shot.surfaceMax)
      numbers.relief_cm = r1(shot.surfaceMax - shot.surfaceMin)
      summary += ` The surface in the window lies between ${axis} ${r1(shot.surfaceMin)} and ${axis} ${r1(shot.surfaceMax)}.`
      // The relief along the centre lines, so a profile can be read without guessing from shading.
      const step = r1(a.span_cm / PROFILE_SAMPLES)
      const line = (p: number[]) => p.map(v => Number.isNaN(v) ? 'none' : String(v)).join(', ')
      const def = VIEWS[a.view]
      const hAxis = def.h === 0 ? 'X' : 'Z'
      const vAxis = def.v === 1 ? 'Y' : 'Z'
      summary += ` ${axis} of the surface every ${step} cm along the window's horizontal centre line (${hAxis} from ${r1(a.center.h - a.span_cm / 2)} up): ${line(shot.profileH)}; along its vertical centre line (${vAxis} from ${r1(a.center.v - a.span_cm / 2)} up): ${line(shot.profileV)}.`
    }
    if (shot.proudMax !== undefined && shot.belowMax !== undefined) {
      numbers.window_proud_max_cm = r1(shot.proudMax)
      numbers.window_below_form_max_cm = r1(shot.belowMax)
    }
    const note = a.overlay === 'form' && declared.length === 0 ? ' No form is declared yet, so the form overlay shows the plain stone.' : LEGEND[a.overlay]
    return { summary: summary + note, numbers, images: [png], strikes: [] }
  }

  const slice = async (a: SliceArgs): Promise<StudioResult> => {
    const [w, h, d] = grid.size
    const span = a.axis === 'y' ? [0, h] : a.axis === 'x' ? [-w / 2, w / 2] : [-d / 2, d / 2]
    if (a.at_cm < span[0]! || a.at_cm > span[1]!) throw new Error(`the block runs from ${span[0]} to ${span[1]} on ${a.axis.toUpperCase()}; ${a.at_cm} is outside it`)
    const both = outlines ? { outlines: { front: outlines.front!, left: outlines.left! } } : {}
    const numbers = measureSlice(grid, a.axis, a.at_cm, { forms: declared, ...both })
    const png = await opts.encodeImage(renderSlice(grid, a.axis, a.at_cm, { forms: declared, ...both }))
    const seen = a.axis === 'y'
      ? 'from above (X across, Z down the image, the front at the bottom)'
      : a.axis === 'x' ? 'from the left (Z across with the front on the right, Y up)' : 'from the front (X across, Y up)'
    let summary = `Slice at ${a.axis.toUpperCase()} ${r1(a.at_cm)}, seen ${seen}, under the ${SLICE_VIEW[a.axis]} view's rulers.`
    summary += numbers.section_area_cm2 === 0
      ? ' The plane meets no stone there.'
      : ` The stone's section there is ${Math.round(numbers.section_area_cm2!)} cm².`
    if (declared.length > 0) summary += ' Colours: cyan line = your forms in this plane; stone tinted yellow, orange, red = outside the form (still to remove); violet = form with no stone.'
    if (outlines) summary += ' Pink line = the reference\'s front and left outlines pushed through the block.'
    return { summary, numbers, images: [png], strikes: [] }
  }

  const draw = (a: SketchArgs): StudioResult => {
    const pass = sketch(grid, { view: a.view, path: a.path.map(pt) })
    if (pass.error) throw new Error(pass.error)
    for (const s of pass.strikes) {
      strikes.push(s)
      if (s.kind === 'sketch') drawn.push(s)
    }
    return {
      summary: pass.summary,
      numbers: { line_on_stone_cm: r1(pass.line?.drawnCm ?? 0), line_off_stone_cm: r1(pass.line?.missedCm ?? 0), lines_drawn: drawn.length },
      strikes: pass.strikes
    }
  }

  // A form as kernel shapes, with the canon's hollows settled on it: logged, and described.
  const lay = (name: string, shapes: Shape[], rough: RoughCut[], blend: number, what: string, extra: (min: Vec3, max: Vec3) => string = () => ''): StudioResult => {
    const form: Form = { shapes, blend }
    const extent = formExtent(grid, form)
    if (extent.empty) throw new Error(`no part of "${name}" lies inside the block (X ${-grid.size[0] / 2} to ${grid.size[0] / 2}, Y 0 to ${grid.size[1]}, Z ${-grid.size[2] / 2} to ${grid.size[2] / 2}); check the centres and sizes`)
    const cuts = rough.length > 0 ? settleCuts(form, rough) : []
    const strike: FormStrike = { kind: 'form', name, shapes: form.shapes, blend: form.blend, ...(cuts.length > 0 ? { cuts } : {}) }
    applyStrike(grid, strike)
    cutsOf.set(name, cuts)
    strikes.push(strike)
    const again = declared.includes(name)
    if (!again) declared.push(name)
    const { min, max } = extent
    let summary = `${again ? 'Replaced' : 'Declared'} form "${name}" (${what}, blend ${r1(blend)} cm). Inside the block it spans X ${r1(min[0])} to ${r1(max[0])}, Y ${r1(min[1])} to ${r1(max[1])}, Z ${r1(min[2])} to ${r1(max[2])} and holds about ${Math.round(extent.cm3 / 100) / 10} litres (${(extent.cm3 * DENSITY / 1000).toFixed(0)} kg). Nothing was cut.`
    summary += extra(min, max)
    if (extent.outsidePct > 2) summary += ` ${Math.round(extent.outsidePct)}% of the form lies outside the block, where there is no stone to make it from.`
    if (min[1] > 1.5) summary += ` It does not reach the base (it starts ${r1(min[1])} cm up): rough_out will refuse it until something in the form stands on the base.`
    if (cuts.length > 0) summary += ` The canon also marks ${cuts.length} hollows to cut into it (${[...new Set(cuts.map(c => c.label))].join(', ')}); \`detail\` cuts those in its window, and they show as cut below the form.`
    if (declared.length > 1) summary += ` Looks and numbers measure the stone against all your forms together: ${declared.map(n => `"${n}"`).join(', ')}.`
    return {
      summary,
      numbers: { form_volume_cm3: Math.round(extent.cm3), form_y_min_cm: r1(min[1]), form_y_max_cm: r1(max[1]), form_outside_block_pct: r1(extent.outsidePct), form_solids: form.shapes.length },
      strikes: [strike]
    }
  }

  const declare = (a: DeclareFormArgs): StudioResult => {
    const canon = a.shapes.filter(s => s.kind === 'head' || s.kind === 'torso').map(s => s.kind)
    const expanded = expandCanon(a.shapes.map(declaredShape))
    const what = `${a.shapes.length} shape${a.shapes.length === 1 ? '' : 's'}${canon.length > 0 ? `, the ${canon.join(' and ')} expanded to ${expanded.shapes.length} solids in all` : ''}`
    const fitted = expanded.notes?.length ? ` The bust canon kept its proportions to the head: ${expanded.notes.join('; ')}.` : ''
    return lay(a.name, expanded.shapes, expanded.cuts, a.blend_cm, what, () => fitted)
  }

  // Posed figures, animals and the model's own solids as one form (sculpt/figure.ts).
  const declareFigure = (a: DeclareFigureArgs): StudioResult => {
    const figures = a.figures.map(figureSpec)
    const animals = a.animals.map(animalSpec)
    const declaredShapes = a.shapes.map(declaredShape)
    // Rocks and ground under the subjects stand at most a fifth of the block.
    const cap = Math.round(GROUND_CAP_SHARE * grid.size[1])
    const lowered = capGround([...figures.map(f => ({ ground: f.ground, riding: f.legs === 'ride' })), ...animals], declaredShapes, cap)
    const scene = expandScene({ figures, animals, shapes: [] })
    const own = expandCanon(declaredShapes)
    // Big masses first, so formDistance can pass over the many small parts far from a point.
    const volume = (s: Shape) => s.size[0] * s.size[1] * s.size[2]
    const shapes = [...scene.shapes].sort((x, y) => volume(y) - volume(x))
    shapes.push(...own.shapes)
    const n = a.figures.length + a.animals.length
    const what = `${n === 1 ? 'one subject' : `${n} subjects`}${a.shapes.length ? ` and ${a.shapes.length} shape${a.shapes.length === 1 ? '' : 's'} of yours` : ''}, ${shapes.length} solids in all`
    const pt3 = (p: Vec3) => `(${r1(p[0])}, ${r1(p[1])}, ${r1(p[2])})`
    const said = (): string => ' ' + scene.subjects.map((s, i) => {
      const where = Object.entries(s.points).map(([k, p]) => `${k.replace('_', ' ')} ${pt3(p)}`).join(', ')
      const outside = s.min[0] < -grid.size[0] / 2 - 0.5 || s.max[0] > grid.size[0] / 2 + 0.5 || s.min[2] < -grid.size[2] / 2 - 0.5 || s.max[2] > grid.size[2] / 2 + 0.5 || s.max[1] > grid.size[1] + 0.5
      return `Subject ${i + 1}, ${s.label}: X ${r1(s.min[0])} to ${r1(s.max[0])}, Y ${r1(s.min[1])} to ${r1(s.max[1])}, Z ${r1(s.min[2])} to ${r1(s.max[2])}${outside ? ' (part of it lies outside the block)' : ''}; ${where}.`
    }).join(' ')
    const capped = lowered.length ? ` Lowered to the ground cap (${cap} cm, a fifth of the block, so the subject stays the largest thing in the stone): ${lowered.join('; ')}.` : ''
    return lay(a.name, shapes, [...scene.cuts, ...own.cuts], a.blend_cm, what, () => capped + said())
  }

  // A pass protects one form. Cutting to a second form while the figure is another would take
  // off everything of the figure the new one does not cover (a torso declared on its own took a
  // head off in the study), so the figure can only be replaced under its own name, or retired.
  const sameFigure = (tool: string, to: string): void => {
    if (guarded === undefined || to === guarded || !declared.includes(guarded) || !grid.forms.has(guarded)) return
    if (formExtent(grid, grid.forms.get(guarded)!.source).cm3 < 1000) return
    throw new Error(`the stone was last cut to "${guarded}", and ${tool} to "${to}" would remove everything of "${guarded}" that "${to}" does not cover. To change the design, declare "${guarded}" again under the same name and cut to that; to work on one part, declare it inside "${guarded}" and use detail with a window`)
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
      pass = guardedPass('rough_out', on => roughOut(on, { to: REFERENCE_TARGET, margin_cm: a.margin_cm, tool: a.tool, ...limit }))
    } else {
      if (!declared.includes(a.to)) throw new Error(`no form named "${a.to}" has been declared${declared.length ? `; your forms: ${declared.map(n => `"${n}"`).join(', ')}` : '; declare one with declare_form first'}`)
      sameFigure('rough_out', a.to)
      pass = guardedPass('rough_out', on => roughOut(on, { to: a.to, margin_cm: a.margin_cm, tool: a.tool, ...limit }))
      if (!pass.error) guarded = a.to
    }
    return settle(pass, pass.stats ? { outside_margin_max_cm: r1(pass.stats.proudMaxCm), outside_margin_mean_cm: Math.round(pass.stats.proudMeanCm * 100) / 100, saw_cuts: pass.stats.saws, chisel_strikes: pass.stats.chiselStrikes } : {})
  }

  // The square window of a view, span_cm across round a ruler point, pushed through the block:
  // what `detail` works inside, on the surfaces that face that view.
  const detail = (a: DetailArgs): StudioResult => {
    if (!declared.includes(a.to)) throw new Error(`no form named "${a.to}" has been declared${declared.length ? `; your forms: ${declared.map(n => `"${n}"`).join(', ')}` : '; declare one with declare_form first'}`)
    sameFigure('detail', a.to)
    const def = VIEWS[a.view]
    const [w, h, d] = grid.size
    const lo: Vec3 = [-w / 2, 0, -d / 2]
    const hi: Vec3 = [w / 2, h, d / 2]
    const half = a.span_cm / 2
    lo[def.h!] = a.center.h - half
    hi[def.h!] = a.center.h + half
    lo[def.v!] = a.center.v - half
    hi[def.v!] = a.center.v + half
    const facing: Vec3 = [-def.look[0], -def.look[1], -def.look[2]]
    const box = { x0: lo[0], y0: lo[1], z0: lo[2], x1: hi[0], y1: hi[1], z1: hi[2] }
    const pass = guardedPass('detail', (on) => {
      let p = roughOut(on, { to: a.to, margin_cm: 0.1, tool: 'flat', window: { box, facing } })
      const cuts = cutsOf.get(a.to) ?? []
      if (!p.error && cuts.length > 0) p = joined(p, incise(on, { cuts, box, facing }))
      return p
    })
    if (!pass.error) guarded = a.to
    return settle(pass, pass.stats ? { window_proud_max_cm: r1(pass.stats.proudMaxCm), window_proud_mean_cm: Math.round(pass.stats.proudMeanCm * 100) / 100, chisel_strikes: pass.stats.chiselStrikes } : {})
  }

  const focusOn = async (a: FocusArgs): Promise<StudioResult> => {
    focus = { view: a.view, center: { h: a.center.h, v: a.center.v }, span: a.span_cm }
    const r = await closeup({ view: a.view, center: a.center, span_cm: a.span_cm, overlay: a.overlay }, `Focused on the ${a.view} view, a window ${r1(a.span_cm)} cm across centred on (${r1(a.center.h)}, ${r1(a.center.v)}), with the ${a.overlay} overlay and a grid line every centimetre. Until you unfocus, looks show this window and strokes stay inside it, from this view, no wider than ${r1(a.span_cm * FOCUS_STROKE_SHARE)} cm.`)
    return { ...r, views: [a.view] }
  }

  const unfocus = async (a: UnfocusArgs): Promise<StudioResult> => {
    if (!focus) throw new Error('you are not focused on anything; focus first, or look')
    const was = focus
    focus = null
    const views: ViewId[] = [was.view, was.view === 'right' || was.view === 'back' ? 'front_right' : 'front_left']
    const r = await look({ views, overlay: 'grid' })
    return { ...r, summary: `Stepped back from the ${was.view} window round (${r1(was.center.h)}, ${r1(was.center.v)}) ("${a.found.trim()}"). ${r.summary}`, views }
  }

  // Detail mode holds a stroke to the window: this view, inside it, and small.
  const inWindow = (tool: string, view: AxisView, points: RulerPoint[], width: number): void => {
    if (!focus) return
    const f = focus
    const where = `the ${f.view} view, ${r1(f.span)} cm round (${r1(f.center.h)}, ${r1(f.center.v)})`
    if (view !== f.view) throw new Error(`you are focused on ${where}: ${tool} from the ${view} view is not allowed in detail mode. Work from ${f.view}, or unfocus first`)
    const slack = 0.1 * f.span
    const half = f.span / 2 + slack
    for (const [h, v] of points) {
      if (Math.abs(h - f.center.h) > half || Math.abs(v - f.center.v) > half) throw new Error(`you are focused on ${where}: the point (${r1(h)}, ${r1(v)}) lies outside the window. Keep strokes inside it, or unfocus first`)
    }
    const widest = f.span * FOCUS_STROKE_SHARE
    if (width > widest) throw new Error(`you are focused on ${where}: strokes there are at most ${r1(widest)} cm wide, not ${r1(width)}. Use a smaller tool, or unfocus first`)
  }
  const wholeStone = (tool: string): void => {
    if (focus) throw new Error(`${tool} works on the whole stone and is not allowed in detail mode; unfocus first`)
  }

  const landed = (pass: PassResult): Record<string, number> => {
    const hit = pass.hits.filter(h => h.point !== null).length
    return { points_on_stone: hit, points_missed: pass.hits.length - hit }
  }

  const run = async (raw: ToolCall): Promise<StudioResult> => {
    const call = raw as StudioCall
    switch (call.name) {
      case 'look': return look(call.args)
      case 'closeup': return closeup(call.args)
      case 'slice': return slice(call.args)
      case 'focus': return focusOn(call.args)
      case 'unfocus': return unfocus(call.args)
      case 'sketch': return draw(call.args)
      case 'declare_form': return declare(call.args)
      case 'declare_figure': return declareFigure(call.args)
      case 'rough_out':
        wholeStone('rough_out')
        return rough(call.args)
      case 'detail': return detail(call.args)
      case 'saw': {
        const a: SawArgs = call.args
        wholeStone('saw')
        return settle(guardedPass('saw', on => saw(on, { view: a.view, from: pt(a.from), to: pt(a.to), discard: a.discard })))
      }
      case 'chisel': {
        const a: ChiselArgs = call.args
        const keep = a.protect !== undefined && a.protect !== NO_PROTECT ? a.protect : undefined
        if (keep !== undefined && !declared.includes(keep)) throw new Error(`no form named "${keep}" has been declared${declared.length ? `; your forms: ${declared.map(n => `"${n}"`).join(', ')}` : ''}. Pass protect "${NO_PROTECT}" to cut without protecting a form`)
        inWindow('chisel', a.view, a.path.map(pt), a.width_cm)
        const pass = chisel(grid, { tool: a.tool, view: a.view, path: a.path.map(pt), depth_cm: a.depth_cm, width_cm: a.width_cm, ...(keep !== undefined ? { protect: keep } : {}) })
        return settle(pass, landed(pass))
      }
      case 'drill': {
        const a: DrillArgs = call.args
        inWindow('drill', a.view, [pt(a.at)], a.diameter_cm)
        const pass = drill(grid, { view: a.view, at: pt(a.at), diameter_cm: a.diameter_cm, depth_cm: a.depth_cm })
        return settle(pass, { ...landed(pass), ...(pass.bore ? { depth_reached_cm: r1(pass.bore.depthCm), broke_through: pass.bore.through ? 1 : 0 } : {}) })
      }
      case 'polish': {
        const a: PolishArgs = call.args
        inWindow('polish', a.view, a.path.map(pt), a.width_cm)
        const pass = polish(grid, { view: a.view, path: a.path.map(pt), width_cm: a.width_cm, passes: a.passes })
        return settle(pass, { ...landed(pass), ...(pass.sheen ? { finish_before: pass.sheen.before, finish_after: pass.sheen.after } : {}), surface_polished_pct: r1(100 * surfaceFinish(grid).polished) })
      }
      case 'rasp': {
        const a: RaspArgs = call.args
        inWindow('rasp', a.view, a.path.map(pt), a.width_cm)
        // Ridges above the last form cut to come down; the form itself stays.
        const pass = rasp(grid, { view: a.view, path: a.path.map(pt), width_cm: a.width_cm, passes: a.passes, ...(guarded !== undefined && grid.forms.has(guarded) ? { protect: guarded } : {}) })
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
    sketches: () => drawn.slice(),
    focus: () => focus,
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
