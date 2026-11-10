// The canon on its own, with no model: a preset bust is declared, roughed out and finished
// with `detail` from every side through the real Studio, then rendered at the cameras the
// study pages use. This is how the canon is tuned, at no spend.
//
//   npm run bench:canon -- [--preset bust|woman|old|all] [--out .shots/canon] [--name x]
//     [--voxel 0.4] [--webp] [--fast]
//
// --fast skips the carving: the stone is set straight to the form (what `detail` leaves, to a
// tenth of a centimetre) and the canon's cuts are struck from every side. Seconds, not minutes.
//
// Writes <out>/<name>-face.png (front close-up, 44 cm), -profile.png (left close-up), -front.png
// (front and left with rulers) and -round.png (the four three-quarter views), and prints how
// long each stage took.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createStudio } from '../shared/agent/studio.ts'
import type { KernelStudio } from '../shared/agent/studio.ts'
import type { ShapeArgs } from '../shared/agent/toolSchemas.ts'
import type { StyleToken } from '../shared/sculpt/anatomy.ts'
import { FINISH, Q_MAX, createGrid, recountSolid } from '../shared/sculpt/grid.ts'
import { incise } from '../shared/sculpt/hand.ts'
import { formDistance } from '../shared/sculpt/shapes.ts'
import { VIEWS } from '../shared/sculpt/views.ts'
import { renderCloseup } from '../shared/sculpt/observer.ts'
import type { Image } from '../shared/sculpt/observer.ts'
import type { AxisView } from '../shared/sculpt/views.ts'
import { parseArgs } from './args.ts'
import { encodePng } from './png.ts'

type Kind = ShapeArgs['kind']
const shape = (kind: Kind, c: [number, number, number], s: [number, number, number], r: [number, number, number] = [0, 0, 0], style: StyleToken[] = []): ShapeArgs => ({
  kind, center_x: c[0], center_y: c[1], center_z: c[2], size_x: s[0], size_y: s[1], size_z: s[2], rot_x: r[0], rot_y: r[1], rot_z: r[2], style
})

// What a model following the prompt would declare: one head and one torso in one form.
export const PRESETS: Record<string, { shapes: ShapeArgs[], blend: number, head: [number, number] }> = {
  bust: {
    shapes: [
      shape('head', [0, 80, 1.5], [24, 35, 29.5], [6, 16, 3], ['male', 'mature', 'waves', 'lips_parted', 'gaze_left', 'aquiline_nose']),
      shape('torso', [0, 36, -1], [60, 46, 30], [0, -8, -3], ['mantle', 'socle'])
    ],
    blend: 1.2,
    head: [0, 77]
  },
  woman: {
    shapes: [
      shape('head', [0, 83, 1], [21, 31, 26], [4, -14, -4], ['female', 'young', 'bun', 'waves', 'raised_brow', 'gaze_right', 'straight_nose']),
      shape('torso', [0, 36, -1], [56, 46, 28], [0, 6, 2], ['bare', 'socle'])
    ],
    blend: 1.2,
    head: [0, 80]
  },
  plain: {
    shapes: [
      shape('head', [0, 83, 1], [22, 32, 27], [0, 0, 0], ['male', 'young', 'curls']),
      shape('torso', [0, 36, -1], [60, 46, 30], [0, 0, 0], ['bare', 'socle'])
    ],
    blend: 1.2,
    head: [0, 80]
  },
  long: {
    shapes: [
      shape('head', [0, 80, 1], [22, 33, 27], [6, -18, -3], ['female', 'young', 'long_hair', 'calm', 'gaze_down', 'straight_nose']),
      shape('torso', [0, 36, -1], [56, 46, 28], [0, 8, 2], ['mantle', 'socle'])
    ],
    blend: 1.2,
    head: [0, 77]
  },
  old: {
    shapes: [
      shape('head', [0, 83, 1], [22, 32, 27], [8, 10, 0], ['male', 'old', 'lean', 'short_hair', 'beard', 'moustache', 'frown', 'broad_nose']),
      shape('torso', [0, 36, -1], [60, 46, 30], [0, -4, 0], ['collar', 'socle'])
    ],
    blend: 1.2,
    head: [0, 80]
  }
}

// Every side, windows that between them hold the whole figure.
const WINDOWS: { view: AxisView, h: number, v: number, span: number }[] = [
  { view: 'front', h: 0, v: 78, span: 48 },
  { view: 'front', h: 0, v: 30, span: 60 },
  { view: 'left', h: 0, v: 78, span: 48 },
  { view: 'left', h: 0, v: 30, span: 60 },
  { view: 'right', h: 0, v: 78, span: 48 },
  { view: 'right', h: 0, v: 30, span: 60 },
  { view: 'back', h: 0, v: 78, span: 48 },
  { view: 'back', h: 0, v: 30, span: 60 },
  { view: 'top', h: 0, v: 0, span: 60 }
]

export async function carvePreset(studio: KernelStudio, preset: typeof PRESETS[string], say: (s: string) => void = () => {}): Promise<void> {
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = Date.now()
    const r = await studio.run({ id: name, name: name as never, args })
    say(`${name} ${((Date.now() - t) / 1000).toFixed(1)}s: ${r.summary.slice(0, 160)}`)
    return r
  }
  await call('declare_form', { name: 'bust', shapes: preset.shapes, blend_cm: preset.blend, why: 'canon' })
  await call('rough_out', { to: 'bust', margin_cm: 3, tool: 'point', why: 'canon' })
  await call('rough_out', { to: 'bust', margin_cm: 0.6, tool: 'claw', why: 'canon' })
  for (const w of WINDOWS) await call('detail', { to: 'bust', view: w.view, center: { h: w.h, v: w.v }, span_cm: w.span, why: 'canon' })
}

// The stone set to the form at once, then the cuts struck from every side.
export async function castPreset(studio: KernelStudio, preset: typeof PRESETS[string]): Promise<void> {
  await studio.run({ id: 'form', name: 'declare_form', args: { name: 'bust', shapes: preset.shapes, blend_cm: preset.blend, why: 'canon' } })
  const grid = studio.grid
  const form = grid.forms.get('bust')!
  const { nx, ny, nz, voxel, dist, qPerCm } = grid
  const band = 4 * voxel
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const at = i + nx * (j + ny * k)
        const d0 = dist[at]! / qPerCm
        if (d0 >= band) continue
        const d = Math.max(d0, formDistance(form, grid.x0 + i * voxel, grid.y0 + j * voxel, grid.z0 + k * voxel))
        dist[at] = Math.max(-Q_MAX, Math.min(Q_MAX, Math.round(d * qPerCm)))
        grid.finish[at] = FINISH.flat
      }
    }
  }
  grid.solidUnits = recountSolid(grid)
  const cuts = studio.log().strikes.find(s => s.kind === 'form')?.cuts ?? []
  const [w, h, d] = grid.size
  const box = { x0: -w / 2, y0: 0, z0: -d / 2, x1: w / 2, y1: h, z1: d / 2 }
  for (const view of ['front', 'left', 'right', 'back', 'top'] as const) {
    const look = VIEWS[view].look
    incise(grid, { cuts, box, facing: [-look[0], -look[1], -look[2]] })
  }
}

function save(out: string, file: string, image: Image, webp: boolean): void {
  const path = join(out, file)
  writeFileSync(path, encodePng(image.data, image.width, image.height))
  if (webp) execFileSync('cwebp', ['-quiet', '-q', '82', path, '-o', path.replace(/\.png$/, '.webp')])
}

// The study pages' cameras: 44 cm close-ups on the head from the front and the left, the
// front and left with rulers, the four three-quarter views.
export function renderStudy(studio: KernelStudio, head: [number, number], out: string, name: string, webp = false): void {
  save(out, `${name}-face.png`, renderCloseup(studio.grid, 'front', head, 44).image, webp)
  save(out, `${name}-profile.png`, renderCloseup(studio.grid, 'left', [2, head[1]], 44).image, webp)
  save(out, `${name}-eye.png`, renderCloseup(studio.grid, 'front', [-4.5, head[1] + 1.5], 12).image, webp)
  save(out, `${name}-mouth.png`, renderCloseup(studio.grid, 'front', [0, head[1] - 7], 14).image, webp)
  save(out, `${name}-front.png`, studio.render(['front', 'left']), webp)
  save(out, `${name}-round.png`, studio.render(['front_left', 'front_right', 'back_left', 'back_right']), webp)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const which = args.str('preset', 'bust')!
  const out = resolve(args.str('out', '.shots/canon')!)
  const voxel = args.num('voxel', 0.4)
  const webp = args.has('webp')
  args.has('fast')
  const label = args.str('name')
  const unknown = args.unknown()
  if (unknown.length) throw new Error(`unknown flags: ${unknown.join(', ')}`)
  mkdirSync(out, { recursive: true })
  const names = which === 'all' ? Object.keys(PRESETS) : which.split(',')
  for (const id of names) {
    const preset = PRESETS[id]
    if (!preset) throw new Error(`no preset "${id}"; presets: ${Object.keys(PRESETS).join(', ')}`)
    const grid = createGrid({ voxel })
    const studio = createStudio({ grid, encodeImage: image => encodePng(image.data, image.width, image.height) })
    const t = Date.now()
    if (args.has('fast')) await castPreset(studio, preset)
    else await carvePreset(studio, preset, s => console.log(`  ${s}`))
    const name = label ? `${label}-${id}` : id
    renderStudy(studio, preset.head, out, name, webp)
    console.log(`${id}: ${studio.strikes.length} strikes, ${((Date.now() - t) / 1000).toFixed(1)}s, ${out}/${name}-*.png`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
