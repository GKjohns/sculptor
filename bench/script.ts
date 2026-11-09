// A scripted Brain for --dry: no key, no network, and every tool exercised end to end against
// the real Studio (declare a form, rough out, saw, chisel, rasp, look, note, a refused pass, a
// malformed call, finish). Its figures are crude on purpose; it tests plumbing, not sculpture.

import type { Brain, BrainTurn, Message, ReferenceMode, ToolSetId } from '../shared/agent/types.ts'
import { compileForm, formDistance } from '../shared/sculpt/shapes.ts'
import type { Form, Shape, ShapeKind, Vec3 } from '../shared/sculpt/types.ts'
import type { SubjectId } from './subjects.ts'

interface Call { name: string, args: Record<string, unknown> }
interface Turn { say: string, calls: Call[] }

const shape = (kind: ShapeKind, c: Vec3, s: Vec3) => ({ kind, center_x: c[0], center_y: c[1], center_z: c[2], size_x: s[0], size_y: s[1], size_z: s[2], rot_x: 0, rot_y: 0, rot_z: 0 })

type FlatShape = ReturnType<typeof shape>

const FIGURES: Record<SubjectId, { shapes: FlatShape[], blend: number }> = {
  pawn: {
    blend: 3,
    shapes: [
      shape('box', [0, 5, 0], [44, 10, 44]),
      shape('cone', [0, 40, 0], [38, 70, 38]),
      shape('ellipsoid', [0, 60, 0], [30, 6, 30]),
      shape('ellipsoid', [0, 78, 0], [28, 28, 28])
    ]
  },
  cat: {
    blend: 4,
    shapes: [
      shape('box', [0, 4, 0], [50, 8, 54]),
      shape('ellipsoid', [0, 28, -4], [44, 44, 50]),
      shape('ellipsoid', [0, 56, 12], [30, 28, 28]),
      shape('cone', [-9, 72, 12], [9, 12, 7]),
      shape('cone', [9, 72, 12], [9, 12, 7])
    ]
  },
  bust: {
    blend: 4,
    shapes: [
      shape('box', [0, 6, 0], [40, 12, 34]),
      shape('ellipsoid', [0, 30, 0], [54, 40, 34]),
      shape('capsule', [0, 55, 0], [16, 26, 16]),
      shape('ellipsoid', [0, 76, 2], [28, 36, 32])
    ]
  }
}

// Fixed token counts, so a dry run's cost is the same every time: about 2 cents a turn.
export const DRY_USAGE = { input: 4000, output: 400, cacheRead: 3000, cacheWrite: 0, reasoning: 0 }
export const DRY_TURN_USD = 0.02

function turnsFor(subject: SubjectId, toolSet: ToolSetId, reference: ReferenceMode): Turn[] {
  const figure = FIGURES[subject]
  const saws: Turn = {
    say: 'Two straight cuts to take the top corners.',
    calls: [
      { name: 'saw', args: { view: 'front', from: { h: -30, v: 86 }, to: { h: -18, v: 100 }, discard: 'above', why: 'Taking the top left corner off, well clear of the head.' } },
      { name: 'saw', args: { view: 'front', from: { h: 18, v: 100 }, to: { h: 30, v: 86 }, discard: 'above', why: 'And the top right corner to match.' } }
    ]
  }
  const strokes: Turn = {
    say: 'Strokes across the front, then one that misses on purpose.',
    calls: [
      { name: 'chisel', args: { tool: 'point', view: 'front', path: [{ h: -8, v: 30 }, { h: 8, v: 30 }], depth_cm: 2, width_cm: 4, protect: 'none', why: 'Opening a groove low on the front with the point.' } },
      { name: 'chisel', args: { tool: 'flat', view: 'top', path: [{ h: -5, v: 0 }, { h: 5, v: 0 }], depth_cm: 0.6, width_cm: 3, protect: 'none', why: 'Flattening the crown a little.' } },
      { name: 'chisel', args: { tool: 'claw', view: 'left', path: [{ h: -29.5, v: 99.5 }, { h: -29, v: 99 }], depth_cm: 1, width_cm: 2, protect: 'none', why: 'Trying the far corner, which should already be gone.' } }
    ]
  }
  if (toolSet === 'direct') {
    return [
      { say: 'Planning the piece.', calls: [{ name: 'note', args: { stage: 'rough_out', text: `A ${subject}, centred on the block, standing on an 8 cm plinth. Saw the corners, then chisel.` } }] },
      saws,
      strokes,
      { say: 'Stepping back.', calls: [{ name: 'look', args: { views: ['front', 'left', 'top', 'front_left'], overlay: 'grid' } }] },
      { say: 'Asking for a tool I do not have.', calls: [{ name: 'rasp', args: { view: 'front', path: [{ h: 0, v: 50 }, { h: 5, v: 50 }], width_cm: 4, passes: 1, why: 'Smoothing.' } }] },
      { say: 'Done.', calls: [{ name: 'finish', args: { title: `Dry ${subject}, cut direct`, statement: 'A scripted run: two saw cuts and three strokes. It proves the bench, not the sculptor.' } }] }
    ]
  }
  const viaReference = reference === 'outlines'
  return [
    {
      say: 'Planning the piece and declaring its masses.',
      calls: [
        { name: 'note', args: { stage: 'rough_out', text: `A ${subject}, centred on the block. One form, "figure", of ${figure.shapes.length} overlapping shapes on a plinth. Rough out at 4 cm, look, then tighten.` } },
        { name: 'declare_form', args: { name: 'figure', shapes: figure.shapes, blend_cm: figure.blend, why: 'Setting out the masses I want the stone to end up as.' } }
      ]
    },
    saws,
    {
      say: 'A pass the hand should refuse, then the real rough-out.',
      calls: [
        { name: 'rough_out', args: { to: 'nope', margin_cm: 4, tool: 'point', why: 'Roughing out to a form I never declared.' } },
        { name: 'rough_out', args: { to: viaReference ? 'reference' : 'figure', margin_cm: 4, tool: 'point', why: 'Taking the big waste off, leaving a hand\'s width all round.' } }
      ]
    },
    { say: 'Stepping back to see what is left standing.', calls: [{ name: 'look', args: { views: ['front', 'left', 'top', 'front_left'], overlay: 'form' } }] },
    strokes,
    {
      say: 'Closing in and smoothing the front.',
      calls: [
        { name: 'rough_out', args: { to: 'figure', margin_cm: 1.5, tool: 'claw', why: 'Coming in closer with the claw now the shape is safe.' } },
        { name: 'rasp', args: { view: 'front', path: [{ h: -6, v: 78 }, { h: 6, v: 78 }, { h: 6, v: 70 }], width_cm: 6, passes: 2, why: 'Rasping the front of the head smooth.' } }
      ]
    },
    { say: 'A call with a bad argument.', calls: [{ name: 'chisel', args: { tool: 'spoon', view: 'front', path: [{ h: 0, v: 50 }, { h: 4, v: 50 }], depth_cm: 1, width_cm: 2, protect: 'none', why: 'Using a tool that does not exist.' } }] },
    { say: 'A last look.', calls: [{ name: 'look', args: { views: ['front', 'right', 'back', 'left'], overlay: viaReference ? 'reference' : 'form' } }] },
    {
      say: 'Done.',
      calls: [
        { name: 'note', args: { stage: 'refine', text: 'Roughed to 1.5 cm, corners sawn, front of the head rasped. Nothing left to do in this script.' } },
        { name: 'finish', args: { title: `Dry ${subject}`, statement: 'A scripted run through every tool in the studio. It proves the bench, not the sculptor.' } }
      ]
    }
  ]
}

export function scriptedBrain(opts: { subject: SubjectId, toolSet: ToolSetId, reference: ReferenceMode, turnUsd?: number }): Brain {
  const turns = turnsFor(opts.subject, opts.toolSet, opts.reference)
  let at = 0
  return {
    async turn(input, onText): Promise<BrainTurn> {
      if (input.signal?.aborted) throw new Error('aborted')
      // Past the end of the script the Brain says nothing, which the loop treats as a stall.
      const turn = turns[at] ?? { say: 'The script has run out.', calls: [] }
      const n = ++at
      onText(turn.say)
      const calls = turn.calls.map((c, i) => ({ id: `dry-${n}-${i + 1}`, name: c.name, args: c.args }))
      const append: Message[] = [{
        role: 'assistant',
        content: [{ type: 'text', text: turn.say }, ...calls.map(c => ({ type: 'tool-call' as const, toolCallId: c.id, toolName: c.name, input: c.args }))]
      }]
      return { calls, append, usage: { ...DRY_USAGE }, costUsd: opts.turnUsd ?? DRY_TURN_USD }
    }
  }
}

// A stand-in reference sheet for --dry --ref on: the scripted figure as flat grey clay on black
// in the sheet's four quadrants (front, left / back, right), so the real analysis, the outlines,
// rough_out to the reference and the reference overlay all run without an image model.
export function scriptedSheet(subject: SubjectId, quadrant = 192): { width: number, height: number, data: Uint8Array } {
  const figure = FIGURES[subject]
  const shapes: Shape[] = figure.shapes.map(s => ({ kind: s.kind, center: [s.center_x, s.center_y, s.center_z], size: [s.size_x, s.size_y, s.size_z], rotation: [0, 0, 0] }))
  const form: Form = { shapes, blend: figure.blend }
  const compiled = compileForm(form)
  const size = quadrant * 2
  const data = new Uint8Array(size * size * 4)
  for (let i = 3; i < data.length; i += 4) data[i] = 255
  // 100 cm of block height across 80% of a quadrant, the figure centred with its base low.
  const cmPerPx = 100 / (0.8 * quadrant)
  const views: { col: number, row: number, across: 0 | 2, sign: number }[] = [
    { col: 0, row: 0, across: 0, sign: 1 }, // front: +X to the right
    { col: 1, row: 0, across: 2, sign: 1 }, // left: +Z to the right
    { col: 0, row: 1, across: 0, sign: -1 }, // back: +X to the left
    { col: 1, row: 1, across: 2, sign: -1 } // right: +Z to the left
  ]
  for (const v of views) {
    for (let py = 0; py < quadrant; py++) {
      const y = (0.9 * quadrant - py) * cmPerPx
      if (y < 0 || y > 100) continue
      for (let px = 0; px < quadrant; px++) {
        const u = v.sign * (px + 0.5 - quadrant / 2) * cmPerPx
        if (u < -30 || u > 30) continue
        let nearest = Infinity
        for (let t = -29; t <= 29; t += 2) {
          const d = v.across === 0 ? formDistance(compiled, u, y, t) : formDistance(compiled, t, y, u)
          if (d < nearest) nearest = d
        }
        if (nearest >= 0) continue
        // Lighter toward the middle of the mass, so it reads as lit clay and thresholds cleanly.
        const grey = Math.round(120 + Math.min(60, -nearest * 6))
        const o = ((v.row * quadrant + py) * size + v.col * quadrant + px) * 4
        data[o] = grey
        data[o + 1] = grey
        data[o + 2] = grey
      }
    }
  }
  return { width: size, height: size, data }
}
