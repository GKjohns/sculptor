// The core tools as the model sees them. Schemas stay small and flat: no unions, no optional
// fields, every shape with the same fields. A provider once refused a schema with many
// optionals and the gateway silently fell back to a slower route (conjure/server/utils/gateway.ts).

import { z } from 'zod'
import type { ToolSet } from 'ai'
import { AXIS_VIEWS, VIEW_IDS } from '../sculpt/views.ts'
import { STAGES } from './types.ts'
import type { PassTool, ReferenceMode, ToolCall, ToolName, ToolSetId } from './types.ts'

export interface ToolOptions {
  toolSet: ToolSetId
  reference: ReferenceMode
}

// The name `rough_out` takes in `to` to mean the traced reference outlines.
export const REFERENCE_TARGET = 'reference'

const DIRECT: ToolName[] = ['look', 'saw', 'chisel', 'note', 'finish']
const FORMED: ToolName[] = ['look', 'declare_form', 'rough_out', 'saw', 'chisel', 'rasp', 'note', 'finish']

export function toolNames(toolSet: ToolSetId): ToolName[] {
  return toolSet === 'direct' ? DIRECT : FORMED
}

const POINTS = 'A point is {h, v} in centimetres, read off the rulers of the view you name: h from the horizontal ruler, v from the vertical ruler. In front and back, h is X and v is Y. In right and left, h is Z and v is Y. In top, h is X and v is Z.'
const REACH = 'The tool works on the first surface it meets along the view direction through each point, so carve from the view that faces the surface you mean. The result reports the 3D point that was hit, or that the point missed the stone.'
const WHY = 'One sentence in your own voice as the sculptor, said to the person watching: what you are doing and what for. No coordinates.'

const point = z.object({
  h: z.number().describe('Horizontal ruler value, cm'),
  v: z.number().describe('Vertical ruler value, cm')
})
const why = z.string().min(1).describe(WHY)
const carveView = z.enum(AXIS_VIEWS).describe('The axis view the points are read from')
const path = z.array(point).min(2).max(16).describe('Points along the stroke, in order')

const shape = z.object({
  kind: z.enum(['ellipsoid', 'box', 'capsule', 'cone']),
  center_x: z.number(),
  center_y: z.number(),
  center_z: z.number(),
  size_x: z.number().min(0.5).describe('Full extent along the shape\'s own X before rotation, cm'),
  size_y: z.number().min(0.5).describe('Full extent along the shape\'s own Y before rotation, cm'),
  size_z: z.number().min(0.5).describe('Full extent along the shape\'s own Z before rotation, cm'),
  rot_x: z.number().describe('Degrees about X'),
  rot_y: z.number().describe('Degrees about Y'),
  rot_z: z.number().describe('Degrees about Z')
})

const OVERLAYS = ['grid', 'form', 'reference'] as const

const SCHEMAS = {
  look: z.object({
    views: z.array(z.enum(VIEW_IDS)).min(1).max(6),
    overlay: z.enum(OVERLAYS)
  }),
  declare_form: z.object({
    name: z.string().min(1).max(40).refine(n => n !== REFERENCE_TARGET, { message: `"${REFERENCE_TARGET}" is reserved; choose another name` }),
    shapes: z.array(shape).min(1).max(12),
    blend_cm: z.number().min(0).max(10).describe('Radius of the smooth blend where shapes meet; 0 for hard joins'),
    why
  }),
  rough_out: z.object({
    to: z.string().min(1),
    margin_cm: z.number().min(0).max(10).describe('Stone left standing outside the target'),
    tool: z.enum(['point', 'claw']),
    why
  }),
  saw: z.object({
    view: carveView,
    from: point,
    to: point,
    discard: z.enum(['above', 'below', 'left', 'right']),
    why
  }).superRefine((a, ctx) => {
    // A side the line does not have would leave the hand guessing which half to drop.
    if (a.from.h === a.to.h && a.from.v === a.to.v) ctx.addIssue({ code: 'custom', path: ['to'], message: 'from and to are the same point; give two different points on the cut line' })
    else if (a.from.v === a.to.v && (a.discard === 'left' || a.discard === 'right')) ctx.addIssue({ code: 'custom', path: ['discard'], message: 'a horizontal line has no left or right side; use above or below' })
    else if (a.from.h === a.to.h && (a.discard === 'above' || a.discard === 'below')) ctx.addIssue({ code: 'custom', path: ['discard'], message: 'a vertical line has no above or below; use left or right' })
  }),
  chisel: z.object({
    tool: z.enum(['point', 'claw', 'flat']),
    view: carveView,
    path,
    depth_cm: z.number().min(0.1).max(8).describe('How deep each bite goes'),
    width_cm: z.number().min(0.5).max(12).describe('Width of the channel the stroke leaves'),
    why
  }),
  rasp: z.object({
    view: carveView,
    path,
    width_cm: z.number().min(1).max(15),
    passes: z.number().int().min(1).max(6).describe('Times over the same path; more is smoother'),
    why
  }),
  note: z.object({
    stage: z.enum(STAGES),
    text: z.string().min(1)
  }),
  finish: z.object({
    title: z.string().min(1),
    statement: z.string().min(1)
  })
}

export type LookArgs = z.infer<typeof SCHEMAS.look>
export type DeclareFormArgs = z.infer<typeof SCHEMAS.declare_form>
export type RoughOutArgs = z.infer<typeof SCHEMAS.rough_out>
export type SawArgs = z.infer<typeof SCHEMAS.saw>
export type ChiselArgs = z.infer<typeof SCHEMAS.chisel>
export type RaspArgs = z.infer<typeof SCHEMAS.rasp>
export type NoteArgs = z.infer<typeof SCHEMAS.note>
export type FinishArgs = z.infer<typeof SCHEMAS.finish>
export type ViewPoint = z.infer<typeof point>
export type ShapeArgs = z.infer<typeof shape>

export interface ToolArgs {
  look: LookArgs
  declare_form: DeclareFormArgs
  rough_out: RoughOutArgs
  saw: SawArgs
  chisel: ChiselArgs
  rasp: RaspArgs
  note: NoteArgs
  finish: FinishArgs
}

// What a Studio receives: the loop has validated `args`, so `call as StudioCall` is sound.
export type StudioTool = 'look' | PassTool
export type StudioCall = { [K in StudioTool]: { id: string, name: K, args: ToolArgs[K] } }[StudioTool]

export interface ToolDef {
  name: ToolName
  description: string
  schema: z.ZodType
}

function describe(name: ToolName, o: ToolOptions): string {
  const formed = o.toolSet === 'formed'
  const outlines = o.reference === 'outlines'
  switch (name) {
    case 'look':
      return [
        'Step back and look at the stone. Returns one contact sheet image of the views you ask for (it arrives in the next message) and numbers measured by code: mass remaining (mass_kg, removed_pct) and the stone\'s bounding box (bbox_*)'
        + (formed ? ', how far the stone stands proud of your declared forms taken together (form_proud_max_cm and form_proud_mean_cm; form_overcut_* is form that no longer has stone, which cannot be put back)' : '')
        + (outlines ? ', and with the reference overlay how well the stone\'s silhouette agrees with the reference outlines from the front and the left (silhouette_*_iou, 1 is a perfect match; stone_outside_outline_pct is still to remove, outline_not_covered_pct is already lost)' : '') + '.',
        'views: up to 6 of front, back, right, left, top (axis views with centimetre rulers in block coordinates) and front_left, front_right, back_left, back_right (three-quarter views, no rulers, for judging the form in the round).',
        'overlay: grid draws a centimetre grid over each axis view.'
        + (formed ? ' form also draws your declared forms over the stone: their outline in cyan, stone that stands proud of them tinted yellow, orange, then red (about 1, 4 and 12 cm or more proud), and blue to violet where the stone has been cut below the form.' : '')
        + (outlines ? ' reference puts each side view (front, back, left, right) beside the matching view of the reference sheet under the same rulers, so coordinates can be read off the reference: the reference outline is drawn in cyan over the stone, stone outside it is tinted orange, outline with no stone behind it is dark violet, and the stone\'s own outline is drawn in yellow over the reference.' : '')
      ].join(' ')
    case 'declare_form':
      return [
        'Declare the masses the stone should end up as, as a few simple solids in block coordinates (cm). Nothing is cut. Declaring a name again replaces that form.',
        'Every shape has a centre, a full size along its own three axes, and a rotation in degrees (Euler order XYZ; 0 0 0 is upright, and most shapes need at most one turn). An ellipsoid or box fills its size. A capsule or cone stands along its own Y: size_y is its full length, size_x and size_z its thickness, and a cone has its base at the -Y end and its point at the +Y end.',
        'Overlap shapes that belong to one mass; blend_cm rounds the joins between them.',
        'Put the whole figure, base included, in one form: rough_out protects only the form it is given. The result says where the form sits in the block and warns if it does not reach the base.'
      ].join(' ')
    case 'rough_out':
      return [
        'Remove the stone that lies outside a target, leaving margin_cm of stone standing all round it. The hand saws off any big slabs first, then works down with the chisel you choose: point is fast and coarse, claw is slower and leaves an even surface.',
        `to: the name of a form you have declared${outlines ? `, or "${REFERENCE_TARGET}" for the volume inside both the front and the left outline of the reference sheet` : ''}. Only that target is protected: stone inside any other form you declared is cut away like the rest. The target must be one connected mass standing on the base (Y 0); one that floats, or has a part not joined to the rest, is refused and nothing is cut.`,
        'Start with a generous margin (3 to 4 cm) and come back with a smaller one after looking; stone cannot be put back.'
      ].join(' ')
    case 'saw':
      return [
        'One straight saw cut through the whole block. from and to are two points on the cut line; the line is extended to the edges of the block, and the cut runs the full depth of the block along the view direction. Everything on the discard side falls away, including whatever lies behind it, so use it only where nothing you want is on that side at any depth.',
        POINTS,
        'discard: the side to remove as you see it in that view\'s image: above or below the line, or left or right of it. Left and right are the image\'s left and right, whichever way the ruler numbers run. In top, above is the back of the block (smaller Z). A horizontal line has no left or right, a vertical line no above or below.'
      ].join(' ')
    case 'chisel':
      return [
        'One chisel stroke along a path on the surface. Each bite goes depth_cm into the stone, square to the surface at that point, and the stroke leaves a channel width_cm wide. To lower an area, lay strokes side by side about one width apart.',
        'tool: point is for fast rough removal and leaves a coarse surface (bites of 1 to 4 cm). claw evens out what the point left (0.5 to 1.5 cm). flat makes clean planes and crisp edges (0.2 to 1 cm).',
        POINTS,
        REACH
      ].join(' ')
    case 'rasp':
      return [
        'Smooth the surface along a path: takes down high spots in a band width_cm wide and leaves the hollows alone. It removes little stone; it is for finishing surfaces, not for changing the shape.',
        POINTS,
        REACH
      ].join(' ')
    case 'note':
      return 'Write your notebook: the stage you are in (rough_out, block_in, model, refine or polish) and your plan. It replaces the previous note, and it is the only thing you wrote that survives when your earlier messages are cleared, so keep in it what you would need to carry on cold: what the piece is, where its masses sit in block coordinates, what is done and what comes next.'
    case 'finish':
      return 'End the commission. Nothing can be carved afterwards. title: the name of the piece. statement: two or three sentences from you about it, for the plaque.'
  }
}

export function toolDefs(o: ToolOptions): ToolDef[] {
  const overlays = OVERLAYS.filter(v => v === 'grid' || (v === 'form' && o.toolSet === 'formed') || (v === 'reference' && o.reference === 'outlines'))
  // Only the overlays this commission can draw are offered, so the model cannot ask for one that is not there.
  const look = SCHEMAS.look.extend({ overlay: z.enum(overlays) })
  return toolNames(o.toolSet).map(name => ({
    name,
    description: describe(name, o),
    schema: name === 'look' ? look : SCHEMAS[name]
  }))
}

// For generateText / streamText `tools`. No execute functions: the loop runs every call itself.
export function sdkTools(o: ToolOptions): ToolSet {
  const out: ToolSet = {}
  for (const d of toolDefs(o)) out[d.name] = { description: d.description, inputSchema: d.schema }
  return out
}

export interface JsonTool {
  name: ToolName
  description: string
  parameters: Record<string, unknown>
}

// The same tools as plain JSON Schema, for the JSON-lines fallback and for logs.
export function jsonTools(o: ToolOptions): JsonTool[] {
  return toolDefs(o).map((d) => {
    const { $schema: _, ...parameters } = z.toJSONSchema(d.schema, { target: 'draft-7', reused: 'inline' }) as Record<string, unknown>
    return { name: d.name, description: d.description, parameters }
  })
}

// A section a fallback Brain appends to the instructions when native tool calls misbehave.
// It scans the reply with an op scanner (conjure/server/utils/opStream.ts) and hands the loop
// ToolCalls with ids of its own; the loop must then run with toolResults: 'text'.
export function jsonLinesProtocol(o: ToolOptions): string {
  const tools = jsonTools(o).map(t => `${t.name}: ${t.description}\nargs: ${JSON.stringify(t.parameters)}`).join('\n\n')
  return [
    'CALLING TOOLS',
    'Call tools by ending your reply with one JSON array, one call per line, each {"tool": "<name>", "args": {...}}. For example:\n[\n{"tool": "look", "args": {"views": ["front", "right"], "overlay": "grid"}}\n]\nCalls run in order. Anything before the array is read as you thinking aloud; do not use square brackets there. Every reply needs the array, with at least one call.',
    tools
  ].join('\n\n')
}

export type ParsedCall
  = | { ok: true, name: ToolName, args: Record<string, unknown> }
    | { ok: false, error: string }

// Validates a call against this commission's tools. The error text goes back to the model.
export function parseCall(defs: ToolDef[], call: ToolCall): ParsedCall {
  const def = defs.find(d => d.name === call.name)
  if (!def) return { ok: false, error: `There is no tool called "${call.name}" in this commission. Your tools: ${defs.map(d => d.name).join(', ')}.` }
  let args = call.args
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return { ok: false, error: `Invalid arguments for ${call.name}: not valid JSON. Nothing was done; correct the call and send it again.` }
    }
  }
  const r = def.schema.safeParse(args)
  if (r.success) return { ok: true, name: def.name, args: r.data as Record<string, unknown> }
  const issues = r.error.issues.slice(0, 6).map(i => `${i.path.length ? i.path.join('.') : 'arguments'}: ${i.message}`)
  return { ok: false, error: `Invalid arguments for ${call.name}: ${issues.join('; ')}. Nothing was done; correct the call and send it again.` }
}

const num = (n: number) => String(Math.round(n * 10) / 10)
const pt = (p: ViewPoint) => `(${num(p.h)},${num(p.v)})`

// One call as a short phrase, for the pass record and the bench log.
export function describeCall(name: ToolName, args: Record<string, unknown>): string {
  switch (name) {
    case 'look': {
      const a = args as LookArgs
      return `look ${a.views.join(', ')} (${a.overlay})`
    }
    case 'declare_form': {
      const a = args as DeclareFormArgs
      const shapes = a.shapes.map((s) => {
        const rot = s.rot_x || s.rot_y || s.rot_z ? ` rot ${num(s.rot_x)},${num(s.rot_y)},${num(s.rot_z)}` : ''
        return `${s.kind} at ${num(s.center_x)},${num(s.center_y)},${num(s.center_z)} size ${num(s.size_x)}×${num(s.size_y)}×${num(s.size_z)}${rot}`
      })
      return `declare_form "${a.name}": ${shapes.join('; ')}; blend ${num(a.blend_cm)}`
    }
    case 'rough_out': {
      const a = args as RoughOutArgs
      return `rough_out to "${a.to}", margin ${num(a.margin_cm)} cm, ${a.tool}`
    }
    case 'saw': {
      const a = args as SawArgs
      return `saw ${a.view} ${pt(a.from)}→${pt(a.to)}, discard ${a.discard}`
    }
    case 'chisel': {
      const a = args as ChiselArgs
      return `chisel ${a.tool} ${a.view} ${a.path.map(pt).join('→')}, depth ${num(a.depth_cm)}, width ${num(a.width_cm)}`
    }
    case 'rasp': {
      const a = args as RaspArgs
      return `rasp ${a.view} ${a.path.map(pt).join('→')}, width ${num(a.width_cm)}, ${a.passes}×`
    }
    case 'note': {
      const a = args as NoteArgs
      return `note (${a.stage})`
    }
    case 'finish': {
      const a = args as FinishArgs
      return `finish "${a.title}"`
    }
  }
}
