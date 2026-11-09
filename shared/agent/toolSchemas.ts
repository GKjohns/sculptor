// The core tools as the model sees them. Schemas stay small and flat: no unions, no optional
// fields, every shape with the same fields. A provider once refused a schema with many
// optionals and the gateway silently fell back to a slower route (conjure/server/utils/gateway.ts).

import { z } from 'zod'
import type { ToolSet } from 'ai'
import { STYLE_TOKENS } from '../sculpt/anatomy.ts'
import { ANIMAL_POSES, ARM_GESTURES, DRAPERIES, FIGURE_BODIES, FIGURE_BUILDS, LEADS, LEG_ACTIONS, SPECIES, SUPPORTS, TAILS, WEIGHT_SIDES } from '../sculpt/figure.ts'
import { AXIS_VIEWS, VIEW_IDS } from '../sculpt/views.ts'
import { STAGES } from './types.ts'
import type { LookTool, PassTool, ReferenceMode, ToolCall, ToolName, ToolSetId } from './types.ts'

export interface ToolOptions {
  toolSet: ToolSetId
  reference: ReferenceMode
}

// The name `rough_out` takes in `to` to mean the traced reference outlines.
export const REFERENCE_TARGET = 'reference'
// What `chisel` takes in `protect` to mean no form at all.
export const NO_PROTECT = 'none'

const DIRECT: ToolName[] = ['look', 'saw', 'chisel', 'note', 'finish']
const FORMED: ToolName[] = ['look', 'closeup', 'slice', 'focus', 'unfocus', 'sketch', 'declare_form', 'declare_figure', 'rough_out', 'detail', 'saw', 'chisel', 'drill', 'rasp', 'polish', 'note', 'finish']

// Detail mode: the window of a focus is at most this wide, and strokes in it at most this
// share of its width.
export const FOCUS_SPAN = { min: 6, max: 30 } as const
export const FOCUS_STROKE_SHARE = 0.2

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

// The solids a form is declared in: the kernel's four primitives and the canon's `head` and
// `torso` (shared/sculpt/anatomy.ts), which become kernel primitives before anything is logged.
export const SHAPE_KINDS = ['ellipsoid', 'box', 'capsule', 'cone', 'head', 'torso'] as const
// Shapes a form may hold. A head or a torso counts as one.
export const MAX_SHAPES = 24

const shape = z.object({
  kind: z.enum(SHAPE_KINDS),
  center_x: z.number(),
  center_y: z.number(),
  center_z: z.number(),
  size_x: z.number().min(0.5).describe('Full extent along the shape\'s own X before rotation, cm'),
  size_y: z.number().min(0.5).describe('Full extent along the shape\'s own Y before rotation, cm'),
  size_z: z.number().min(0.5).describe('Full extent along the shape\'s own Z before rotation, cm'),
  rot_x: z.number().describe('Degrees about X'),
  rot_y: z.number().describe('Degrees about Y'),
  rot_z: z.number().describe('Degrees about Z'),
  style: z.array(z.enum(STYLE_TOKENS)).max(12).describe('For a head or torso: who the sitter is, the expression, hair and drapery. An empty list for any other kind')
})

// ---------- Composition and pose: posed figures, animals and groups (sculpt/figure.ts) ----------

// Subjects one declare_figure may hold, figures and animals together.
export const MAX_SUBJECTS = 3

const figure = z.object({
  body: z.enum(FIGURE_BODIES),
  build: z.enum(FIGURE_BUILDS),
  ground_x: z.number().describe('Where it stands: the point on the ground between its feet, block cm'),
  ground_y: z.number().describe('Height of the ground it stands on (the top of your base), cm'),
  ground_z: z.number(),
  height_cm: z.number().min(15).max(200).describe('Standing height sole to crown, as if upright; a kneeling or seated figure comes out lower'),
  facing_deg: z.number().min(-360).max(360).describe('0 faces the viewer (+Z); positive turns it toward +X'),
  legs: z.enum(LEG_ACTIONS),
  weight_on: z.enum(WEIGHT_SIDES).describe('The figure\'s own leg that carries it: contrapposto when standing, the front leg of a stride or lunge, the planted foot of a kneel'),
  twist_deg: z.number().min(-70).max(70).describe('Shoulders turned against the hips; positive turns the chest toward the figure\'s own left'),
  lean_deg: z.number().min(-50).max(70).describe('Torso bent forward (+) or back (-) at the waist'),
  head_turn_deg: z.number().min(-80).max(80).describe('Positive turns the face toward the figure\'s own left'),
  head_tilt_deg: z.number().min(-45).max(45).describe('Positive nods the face down, negative throws the head back'),
  left_arm: z.enum(ARM_GESTURES).describe('The figure\'s own left arm'),
  right_arm: z.enum(ARM_GESTURES),
  drapery: z.enum(DRAPERIES),
  support: z.enum(SUPPORTS).describe('What a marble figure leans on: a tree stump by the weighted leg, a rock under or behind it (a rock under the free foot when standing). A seated figure always gets a seat; this says what it is'),
  style: z.array(z.enum(STYLE_TOKENS)).max(8).describe('The head canon\'s tokens for this person: hair, beard, expression, nose, age. Sex and age come from body unless given')
})

const animal = z.object({
  species: z.enum(SPECIES),
  pose: z.enum(ANIMAL_POSES),
  ground_x: z.number().describe('The point on the ground under the middle of its footprint, block cm'),
  ground_y: z.number().describe('Height of the ground it stands on, cm; it is dropped onto it'),
  ground_z: z.number(),
  length_cm: z.number().min(10).max(150).describe('Body length, point of the chest to point of the rump (head, neck and tail add about half again)'),
  facing_deg: z.number().min(-360).max(360).describe('0 faces the viewer (+Z); positive turns it toward +X. 45 or -45 lays a long animal along the diagonal of the block'),
  head_turn_deg: z.number().min(-80).max(80).describe('Positive turns the head toward the animal\'s own left'),
  head_raise_deg: z.number().min(-45).max(45).describe('Positive raises the head, negative lowers it (a charging bull is -15 to -30)'),
  tail: z.enum(TAILS),
  lead: z.enum(LEADS).describe('The foreleg that reaches first in a walk, trot, gallop or charge')
})

const OVERLAYS = ['grid', 'form', 'reference'] as const

// The stroke-only tool set keeps the chisel it was studied with: three tools, nothing protected.
const chiselDirect = z.object({
  tool: z.enum(['point', 'claw', 'flat']),
  view: carveView,
  path,
  depth_cm: z.number().min(0.1).max(8).describe('How deep each bite goes'),
  width_cm: z.number().min(0.5).max(12).describe('Width of the channel the stroke leaves'),
  why
})

const SCHEMAS = {
  look: z.object({
    views: z.array(z.enum(VIEW_IDS)).min(1).max(6),
    overlay: z.enum(OVERLAYS)
  }),
  closeup: z.object({
    view: carveView,
    center: point,
    span_cm: z.number().min(8).max(50).describe('Width and height of the square window, cm'),
    overlay: z.enum(OVERLAYS)
  }),
  slice: z.object({
    axis: z.enum(['x', 'y', 'z']).describe('The block axis the cutting plane is square to'),
    at_cm: z.number().describe('Where the plane sits on that axis, block cm')
  }),
  focus: z.object({
    view: carveView,
    center: point,
    span_cm: z.number().min(FOCUS_SPAN.min).max(FOCUS_SPAN.max).describe('Width and height of the square window, cm'),
    overlay: z.enum(OVERLAYS),
    why
  }),
  unfocus: z.object({
    found: z.string().min(1).describe('One sentence on what the window shows now that you are done with it')
  }),
  sketch: z.object({
    view: carveView,
    path: z.array(point).min(2).max(32).describe('Points along the line, in order'),
    why
  }),
  declare_form: z.object({
    name: z.string().min(1).max(40).refine(n => n !== REFERENCE_TARGET && n !== NO_PROTECT, { message: `"${REFERENCE_TARGET}" and "${NO_PROTECT}" are reserved; choose another name` }),
    shapes: z.array(shape).min(1).max(MAX_SHAPES),
    blend_cm: z.number().min(0).max(10).describe('Radius of the smooth blend where shapes meet; 0 for hard joins'),
    why
  }),
  declare_figure: z.object({
    name: z.string().min(1).max(40).refine(n => n !== REFERENCE_TARGET && n !== NO_PROTECT, { message: `"${REFERENCE_TARGET}" and "${NO_PROTECT}" are reserved; choose another name` }),
    figures: z.array(figure).max(MAX_SUBJECTS).describe('Posed human figures; an empty list for none'),
    animals: z.array(animal).max(MAX_SUBJECTS).describe('Posed animals; an empty list for none'),
    shapes: z.array(shape).max(MAX_SHAPES).describe('Your own solids in the same form: the base, a rock or ground, a branch, a sling, hair, a weapon. Same fields as declare_form'),
    blend_cm: z.number().min(0).max(10).describe('Radius of the smooth blend where solids meet; 1 to 1.5 for a figure of 80 to 95 cm'),
    why
  }).superRefine((a, ctx) => {
    const n = a.figures.length + a.animals.length
    if (n === 0) ctx.addIssue({ code: 'custom', path: ['figures'], message: 'give at least one figure or animal; for plain solids use declare_form' })
    if (n > MAX_SUBJECTS) ctx.addIssue({ code: 'custom', path: ['animals'], message: `at most ${MAX_SUBJECTS} figures and animals together in one form` })
  }),
  rough_out: z.object({
    to: z.string().min(1),
    margin_cm: z.number().min(0).max(10).describe('Stone left standing outside the target'),
    tool: z.enum(['point', 'claw']),
    why
  }),
  detail: z.object({
    to: z.string().min(1).describe('The name of a form you have declared'),
    view: carveView,
    center: point,
    span_cm: z.number().min(8).max(60).describe('Width and height of the square window, cm'),
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
    tool: z.enum(['point', 'claw', 'flat', 'roundel']),
    view: carveView,
    path,
    depth_cm: z.number().min(0.1).max(8).describe('How deep each bite goes'),
    width_cm: z.number().min(0.5).max(12).describe('Width of the channel the stroke leaves'),
    protect: z.string().min(1).describe(`A form of yours that the stroke must not cut into, or "${NO_PROTECT}"`),
    why
  }),
  drill: z.object({
    view: carveView,
    at: point,
    diameter_cm: z.number().min(0.8).max(6),
    depth_cm: z.number().min(0.5).max(30).describe('How far in from the surface the hole goes'),
    why
  }),
  rasp: z.object({
    view: carveView,
    path,
    width_cm: z.number().min(1).max(15),
    passes: z.number().int().min(1).max(6).describe('Times over the same path; more is smoother'),
    why
  }),
  polish: z.object({
    view: carveView,
    path,
    width_cm: z.number().min(1).max(15),
    passes: z.number().int().min(1).max(6).describe('Times over the same path; more is glossier'),
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
export type CloseupArgs = z.infer<typeof SCHEMAS.closeup>
export type SliceArgs = z.infer<typeof SCHEMAS.slice>
export type FocusArgs = z.infer<typeof SCHEMAS.focus>
export type UnfocusArgs = z.infer<typeof SCHEMAS.unfocus>
export type SketchArgs = z.infer<typeof SCHEMAS.sketch>
export type DeclareFormArgs = z.infer<typeof SCHEMAS.declare_form>
export type DeclareFigureArgs = z.infer<typeof SCHEMAS.declare_figure>
export type FigureArgs = z.infer<typeof figure>
export type AnimalArgs = z.infer<typeof animal>
export type RoughOutArgs = z.infer<typeof SCHEMAS.rough_out>
export type DetailArgs = z.infer<typeof SCHEMAS.detail>
export type SawArgs = z.infer<typeof SCHEMAS.saw>
// `protect` is absent in the stroke-only tool set, which has no forms to name.
export type ChiselArgs = Omit<z.infer<typeof SCHEMAS.chisel>, 'protect'> & { protect?: string }
export type DrillArgs = z.infer<typeof SCHEMAS.drill>
export type RaspArgs = z.infer<typeof SCHEMAS.rasp>
export type PolishArgs = z.infer<typeof SCHEMAS.polish>
export type NoteArgs = z.infer<typeof SCHEMAS.note>
export type FinishArgs = z.infer<typeof SCHEMAS.finish>
export type ViewPoint = z.infer<typeof point>
export type ShapeArgs = z.infer<typeof shape>

export interface ToolArgs {
  look: LookArgs
  closeup: CloseupArgs
  slice: SliceArgs
  focus: FocusArgs
  unfocus: UnfocusArgs
  sketch: SketchArgs
  declare_form: DeclareFormArgs
  declare_figure: DeclareFigureArgs
  rough_out: RoughOutArgs
  detail: DetailArgs
  saw: SawArgs
  chisel: ChiselArgs
  drill: DrillArgs
  rasp: RaspArgs
  polish: PolishArgs
  note: NoteArgs
  finish: FinishArgs
}

// What a Studio receives: the loop has validated `args`, so `call as StudioCall` is sound.
export type StudioTool = LookTool | PassTool
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
        + (formed ? ', how much of the surface is still raw chisel work, rasped, or polished (surface_*_pct; a look\'s image shows every finish alike)' : '')
        + (formed ? ', how far the stone stands proud of your declared forms taken together (form_proud_max_cm and form_proud_mean_cm; form_overcut_* is form that no longer has stone, which cannot be put back)' : '')
        + (outlines ? ', and with the reference overlay how well the stone\'s silhouette agrees with the reference outlines from the front and the left (silhouette_*_iou, 1 is a perfect match; stone_outside_outline_pct is still to remove, outline_not_covered_pct is already lost)' : '') + '.',
        'views: up to 6 of front, back, right, left, top (axis views with centimetre rulers in block coordinates) and front_left, front_right, back_left, back_right (three-quarter views, no rulers, for judging the form in the round).',
        'overlay: grid draws a centimetre grid over each axis view.'
        + (formed ? ' form also draws your declared forms over the stone: their outline in cyan, stone that stands proud of them tinted yellow, orange, then red (about 1, 4 and 12 cm or more proud), and blue to violet where the stone has been cut below the form.' : '')
        + (outlines ? ' reference puts each side view (front, back, left, right) beside the matching view of the reference sheet under the same rulers, so coordinates can be read off the reference: the reference outline is drawn in cyan over the stone, stone outside it is tinted orange, outline with no stone behind it is dark violet, and the stone\'s own outline is drawn in yellow over the reference.' : '')
      ].join(' ')
    case 'closeup':
      return [
        'Look closely at one part of the stone: one axis view enlarged to a square window span_cm across, centred on center, under the same rulers and with a grid line every centimetre, so a point read off it goes straight into a carving tool. In a full look a face is a few dozen pixels across; take a close-up before you work on anything small (a face, an ear, a paw) and again after, or you are carving blind.',
        POINTS,
        'overlay: as in look.' + (outlines ? ' With reference, the same window of the reference sheet sits beside the stone, so you can read off where its features are.' : ''),
        'Numbers: the share of the window that is stone, and the nearest and deepest surface in it along the view direction (surface_*_min_cm, surface_*_max_cm, relief_cm)' + (formed ? '; with the form overlay, how far the surface in the window stands proud of your forms or is cut below them' : '') + '.'
      ].join(' ')
    case 'slice':
      return [
        'Cut the stone open with an imaginary plane and look at the section. Nothing is carved. It shows what no look can: how thick a neck or a waist really is, how far a nose stands off a face, whether a hollow is as deep as you think.',
        'axis y is a level plane at height at_cm, drawn as the top view shows it (X across, Z down the image, the front at the bottom). axis x is an upright plane running front to back at that X, drawn as the left view (Z across with the front on the right, Y up): at_cm 0 is the profile through the middle of a face. axis z is an upright plane facing you at that Z, drawn as the front view.',
        'The section of your forms in the same plane is outlined in cyan, with stone outside it tinted yellow to red and form that has no stone in violet.' + (outlines ? ' The pink line is the reference: its front and left outlines pushed through the block.' : ''),
        'Numbers: the section\'s area and its extent on each ruler (section_*).'
      ].join(' ')
    case 'focus':
      return [
        `Go in close on one part of the stone and stay there: detail mode. The window (span_cm across, ${FOCUS_SPAN.min} to ${FOCUS_SPAN.max} cm, centred on center in the view you name) is shown enlarged at once, as a closeup is, and from then on every look shows that window, with the stone's relief along its centre lines in numbers, until you unfocus. In the window only small work is allowed: chisel, drill, rasp and polish must be from this view, inside the window, and no wider than a fifth of it; rough_out and saw are refused. detail still works. Focus on one feature at a time: an eye, the mouth, an ear, a paw.`,
        `The stone is a grid of ${'0.4'} cm cells: nothing under about 1 cm across can be cut or seen, and a line a cell wide reads as noise. Make a feature at least 2 cm across or leave it to the form.`,
        POINTS
      ].join(' ')
    case 'unfocus':
      return 'Leave detail mode and step back: the whole stone is shown again from the view you were focused on and a three-quarter view. Say in found what the window shows now, for the record.'
    case 'sketch':
      return [
        'Draw a line on the stone in charcoal, the way a sculptor marks a block before cutting: a profile on a face of the block, a centre line, where a feature will sit. path is the line, laid on the first surface it meets from that view.',
        POINTS,
        'It cuts nothing and no tool cuts to it. It shows in your looks and close-ups from then on: dark on the stone it was drawn on, and in its own view a faint ghost once that stone has been cut away, so a profile drawn on the block stays as a guide. The person watching sees you draw it.'
      ].join(' ')
    case 'declare_form':
      return [
        'Declare the masses the stone should end up as, as a few simple solids in block coordinates (cm). Nothing is cut. Declaring a name again replaces that form.',
        'Every shape has a centre, a full size along its own three axes, and a rotation in degrees (Euler order XYZ; 0 0 0 is upright, and most shapes need at most one turn). An ellipsoid or box fills its size. A capsule or cone stands along its own Y: size_y is its full length, size_x and size_z its thickness, and a cone has its base at the -Y end and its point at the +Y end.',
        `kind head is a whole human head with its face and hair already on it, the sculptor's canon (it becomes fifty to a hundred solids: cranium, forehead, brow ridges, cheekbones, eyes as balls between their lids, a nose with bridge, tip and wings, lips, chin, jaw, ears, and the hair in separate locks). Its centre is the middle of the skull and its size is the skull alone: size_x temple to temple, size_y chin to crown, size_z brow to the back of the skull (about 0.68 and 0.85 of the height for ordinary proportions; the nose, ears and hair stand outside it). rot_x tilts it (positive nods the face down), rot_y turns it (positive turns the face toward +X, the viewer's right), rot_z cocks it. The head looks along +Z with no rotation. A blend of 3 to 4 percent of its height suits it (1.3 cm for a 40 cm head); the lids, lips, nostrils and locks keep their own crisp joins whatever the blend.`,
        `style says who the sitter is, so faces are not siblings: male or female; young, mature or old; lean or heavy; square_jaw or narrow_jaw; straight, aquiline, snub or broad nose; calm, lips_parted, smile, raised_brow or frown; gaze_left, gaze_right, gaze_up, gaze_down; the hair (bald, short_hair, curls, waves, long_hair, bun) and beard, moustache. Give each head four to eight. The canon also marks the hollows a carver cuts once the form stands (the iris ringed and the pupil drilled, the lid lines, nostrils, the corners and parting of the mouth, the eyes of the curls): detail cuts those in its window.`,
        `kind torso is the rest of a bust, the canon's: neck, shoulders, chest and back down to a rounded cut, the arms cut off under the shoulders, standing on a turned socle on a square plinth that reaches the base. Its centre is the middle of that box and its size is shoulder to shoulder (size_x), the cut to the top of the shoulders (size_y), chest to back (size_z); rot_y turns the chest against the head. Declared in the same form as a head above it, the neck is made between them and follows the head's turn. style: bare, mantle (a cloak knotted on the shoulder the head turns away from, across the chest and down the back, in folds) or collar (a buttoned coat), and socle or no_socle. A bust is one head and one torso; anything more (a hand, a laurel wreath, a book) is shapes of your own.`,
        'Overlap shapes that belong to one mass; blend_cm rounds the joins between them.',
        'Put the whole figure, base included, in one form: rough_out protects only the form it is given. The result says where the form sits in the block and warns if it does not reach the base.',
        'Whatever stands proud of a surface (a nose, ears, a brow, a chin, a muzzle, paws) belongs in the form as a small shape of its own, with a blend of 1 cm or less so it is not smoothed away. Declared, it is left standing by rough_out and can be protected from every stroke; left to be found later by chiselling, it is usually destroyed.'
      ].join(' ')
    case 'declare_figure':
      return [
        'Declare a posed figure, an animal, or a group of up to three, as one form: the sculptor\'s canon of the body. You give the pose; each subject is built for you from anatomically jointed solids (torso, pelvis, limbs reaching from hip and shoulder, hands, feet, and for a human the head canon with its face and hair), turned to its facing, and set on its ground point. Nothing is cut. Declaring a name again replaces that form, as declare_form does, and rough_out, detail, protect and every overlay treat it like any other form.',
        'A figure: body and build; where it stands (ground_x/y/z: between its feet, on the top of your base) and how tall it would stand upright; facing; legs (stand, stride, lunge, kneel, sit, recline, crouch, ride); weight_on, the figure\'s own leg that carries it (contrapposto when standing: that hip up and out, the shoulders tilted against it, the other knee bent); twist_deg, the shoulders turned against the hips; lean_deg; the head turned and tilted; each arm\'s gesture (down, akimbo, across the body, forward, raised, overhead, back, out to the side, to_head); drapery (loincloth, collar, mantle over one shoulder, cloak flying behind and reaching the ground, robe); support (stump, rock); style, tokens for the head. Left and right are the figure\'s own: facing you, its left is your right (+X).',
        'An animal: species (horse, bull, lion, dog, cat); pose (stand, walk, trot, gallop, rear, charge, lie, sit); its ground point under the middle of its footprint; length_cm, chest to rump; facing; head turned and raised or lowered; tail (down, out, raised, curled); lead foreleg. A rearing animal stands on its hind legs and its tail. It is dropped so its lowest hoof or paw stands on ground_y.',
        'A figure with legs ride sits astride the first animal in the form (a second rider on the second animal), facing as it faces; its own ground point is ignored.',
        'shapes are your own solids in the same form: the base (a box 5 to 8 cm tall, which every figure needs), a rock or ground the subject stands on, a tree stump, a sling, a laurel branch, hair, a weapon. Put the subjects on the base by setting ground_y to its top.',
        'The result gives each subject\'s extent and where its head, hands, feet (or muzzle and back) ended up in block cm, so you can lay your own solids on them, and says if anything lies outside the block. Check that from the front and the side; then look with the form overlay before cutting.',
        'Body parts are 3 cm or more thick only on a figure of about 80 cm or more; a smaller figure loses its wrists and ankles. A figure under about 70 cm gets a plain head with no face.'
      ].join(' ')
    case 'rough_out':
      return [
        'Remove the stone that lies outside a target, leaving margin_cm of stone standing all round it. The hand saws off any big slabs first, then works down with the chisel you choose: point is fast and coarse, claw is slower and leaves an even surface.',
        `to: the name of a form you have declared${outlines ? `, or "${REFERENCE_TARGET}" for the volume inside both the front and the left outline of the reference sheet` : ''}. Only that target is protected: stone inside any other form you declared is cut away like the rest. The target must be one connected mass standing on the base (Y 0); one that floats, or has a part not joined to the rest, is refused and nothing is cut.`,
        'Start with a generous margin (3 to 4 cm) and come back with a smaller one after looking; stone cannot be put back. Once the form carries the features, a last pass with the claw at 0.5 cm or less brings them out of the stone, and `detail` then takes the window round them down to the form itself.'
      ].join(' ')
    case 'detail':
      return [
        'Bring one part of the stone down onto your form with the flat chisel: inside a square window span_cm across centred on center in the view you name, every surface that faces that view is cut back to the form (a tenth of a centimetre over it), small bites laid side by side, so what you declared is what stands there, with the features the form carries and nothing of the claw\'s roughness. Stone turned away from the view, and everything outside the window, is left alone: work a head from the front, then each side, then the back and the top.',
        'to: the name of a form you have declared; it is the only thing protected, so anything else inside the window goes. Use it after rough_out has come within a centimetre or so, and only where the form is already right: the form is what you get.',
        POINTS
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
        'tool: point is for fast rough removal and leaves a coarse surface (bites of 1 to 4 cm). claw evens out what the point left (0.5 to 1.5 cm). flat makes clean planes and crisp edges (0.2 to 1 cm).'
        + (formed ? ' roundel has a rounded end and leaves a smooth concave channel: the line of a mouth, a fold, the groove under a brow or round an eye (0.3 to 1.5 cm deep, never more than 1.5 times its width).' : ''),
        ...(formed
          ? [
              `protect: the name of one of your forms, or "${NO_PROTECT}". The stroke cannot cut into that form however deep you ask, so name your figure's form whenever you clear stone from around something in it (beside a nose, behind an ear, under a chin). "${NO_PROTECT}" lets the stroke cut whatever it meets: only for sinking a hollow into the form itself (an eye socket, a mouth, a nostril), and then shallow.`,
              'Size the stroke to the feature: no wider than a third of what you are shaping and no deeper than half its own width. On a face that means widths of 0.6 to 2 cm. A 3 cm stroke takes out a whole cheek.'
            ]
          : []),
        POINTS,
        REACH
      ].join(' ')
    case 'drill':
      return [
        'Bore a round hole straight along the view direction, starting on the first surface under at: diameter_cm across and depth_cm deep. For deep, narrow detail no chisel reaches: nostrils, the corners of eyes and mouth, a pupil, the gap between an arm and a body. It stops if it comes out into open air.',
        POINTS,
        'The result gives the 3D point where the bit went in and the depth it reached.'
      ].join(' ')
    case 'rasp':
      return [
        'Smooth the surface along a path: takes down high spots in a band width_cm wide and leaves the hollows alone. It removes little stone; it is for finishing surfaces, not for changing the shape.',
        POINTS,
        REACH
      ].join(' ')
    case 'polish':
      return [
        'Polish the surface along a path: a band width_cm wide is rubbed toward a shine, further with each pass. Only the finish changes. No stone comes off and the shape stays as it is, so a look\'s image shows no difference; the result and every look report it in numbers (surface_polished_pct).',
        'Rasp first: polish over raw chisel work is only shiny chisel work. Leave some surfaces unpolished (hair, drapery, the base) so the polished ones read against them.',
        POINTS,
        REACH
      ].join(' ')
    case 'note':
      return 'Write your notebook: the stage you are in (rough_out, block_in, model, refine or polish) and your plan. It replaces the previous note, and it is the only thing you wrote that survives when your earlier messages are cleared, so keep in it what you would need to carry on cold: what the piece is, where its masses sit in block coordinates, what is done and what comes next.'
    case 'finish':
      return 'End the commission. Nothing can be carved afterwards, so call it on its own, after a look taken since your last cut. title: the name of the piece. statement: two or three sentences from you for the plaque, written from that last look: describe the stone as it is and name no feature it does not plainly have.'
  }
}

export function toolDefs(o: ToolOptions): ToolDef[] {
  const overlays = OVERLAYS.filter(v => v === 'grid' || (v === 'form' && o.toolSet === 'formed') || (v === 'reference' && o.reference === 'outlines'))
  // Only the overlays this commission can draw are offered, so the model cannot ask for one that is not there.
  const look = SCHEMAS.look.extend({ overlay: z.enum(overlays) })
  const closeup = SCHEMAS.closeup.extend({ overlay: z.enum(overlays) })
  const focus = SCHEMAS.focus.extend({ overlay: z.enum(overlays) })
  return toolNames(o.toolSet).map(name => ({
    name,
    description: describe(name, o),
    schema: name === 'look' ? look : name === 'closeup' ? closeup : name === 'focus' ? focus : name === 'chisel' && o.toolSet === 'direct' ? chiselDirect : SCHEMAS[name]
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
    case 'closeup': {
      const a = args as CloseupArgs
      return `closeup ${a.view} at ${pt(a.center)}, ${num(a.span_cm)} cm across (${a.overlay})`
    }
    case 'slice': {
      const a = args as SliceArgs
      return `slice at ${a.axis.toUpperCase()} ${num(a.at_cm)}`
    }
    case 'focus': {
      const a = args as FocusArgs
      return `focus ${a.view} at ${pt(a.center)}, ${num(a.span_cm)} cm across (${a.overlay})`
    }
    case 'unfocus':
      return 'unfocus'
    case 'sketch': {
      const a = args as SketchArgs
      return `sketch ${a.view} ${a.path.map(pt).join('→')}`
    }
    case 'declare_form': {
      const a = args as DeclareFormArgs
      const shapes = a.shapes.map((s) => {
        const rot = s.rot_x || s.rot_y || s.rot_z ? ` rot ${num(s.rot_x)},${num(s.rot_y)},${num(s.rot_z)}` : ''
        return `${s.kind} at ${num(s.center_x)},${num(s.center_y)},${num(s.center_z)} size ${num(s.size_x)}×${num(s.size_y)}×${num(s.size_z)}${rot}`
      })
      return `declare_form "${a.name}": ${shapes.join('; ')}; blend ${num(a.blend_cm)}`
    }
    case 'declare_figure': {
      const a = args as DeclareFigureArgs
      const who = [
        ...a.figures.map(f => `${f.body} ${f.legs}${f.weight_on === 'both' ? '' : ` on ${f.weight_on}`} at ${num(f.ground_x)},${num(f.ground_y)},${num(f.ground_z)} ${num(f.height_cm)} cm facing ${num(f.facing_deg)}, twist ${num(f.twist_deg)}, arms ${f.left_arm}/${f.right_arm}${f.drapery === 'none' ? '' : `, ${f.drapery}`}${f.support === 'none' ? '' : `, ${f.support}`}`),
        ...a.animals.map(n => `${n.species} ${n.pose} at ${num(n.ground_x)},${num(n.ground_y)},${num(n.ground_z)} ${num(n.length_cm)} cm facing ${num(n.facing_deg)}`)
      ]
      return `declare_figure "${a.name}": ${who.join('; ')}${a.shapes.length ? `; ${a.shapes.length} own shape${a.shapes.length === 1 ? '' : 's'}` : ''}; blend ${num(a.blend_cm)}`
    }
    case 'rough_out': {
      const a = args as RoughOutArgs
      return `rough_out to "${a.to}", margin ${num(a.margin_cm)} cm, ${a.tool}`
    }
    case 'detail': {
      const a = args as DetailArgs
      return `detail to "${a.to}" from ${a.view} at ${pt(a.center)}, ${num(a.span_cm)} cm across`
    }
    case 'saw': {
      const a = args as SawArgs
      return `saw ${a.view} ${pt(a.from)}→${pt(a.to)}, discard ${a.discard}`
    }
    case 'chisel': {
      const a = args as ChiselArgs
      const kept = a.protect && a.protect !== NO_PROTECT ? `, protecting "${a.protect}"` : ''
      return `chisel ${a.tool} ${a.view} ${a.path.map(pt).join('→')}, depth ${num(a.depth_cm)}, width ${num(a.width_cm)}${kept}`
    }
    case 'drill': {
      const a = args as DrillArgs
      return `drill ${a.view} ${pt(a.at)}, ${num(a.diameter_cm)} cm across, ${num(a.depth_cm)} deep`
    }
    case 'polish': {
      const a = args as PolishArgs
      return `polish ${a.view} ${a.path.map(pt).join('→')}, width ${num(a.width_cm)}, ${a.passes}×`
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
