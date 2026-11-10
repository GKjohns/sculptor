// The figure and animal canon on its own, with no model: a preset scene is expanded
// (shared/sculpt/figure.ts), set into the block, and rendered as a contact sheet, so a person
// can judge the poses. This is how the pose canon is tuned, at no spend.
//
//   npm run bench:poses -- [--preset david|...|all] [--out .shots/poses] [--name x]
//     [--carve] [--voxel 0.4] [--webp]
//
// By default the stone is set straight to the form (what `detail` would leave), which takes
// seconds. --carve roughs it out with the real hand instead (point at 3 cm, claw at 0.6 cm),
// which is what a commission does, and prints how long each pass took and how many strikes.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FINISH, Q_MAX, createGrid, recountSolid } from '../shared/sculpt/grid.ts'
import { roughOut } from '../shared/sculpt/hand.ts'
import { renderContactSheet } from '../shared/sculpt/observer.ts'
import { declareForm, formDistance } from '../shared/sculpt/shapes.ts'
import { expandScene } from '../shared/sculpt/figure.ts'
import type { AnimalSpec, FigureSpec, SceneSpec } from '../shared/sculpt/figure.ts'
import type { Grid, Shape, Vec3 } from '../shared/sculpt/types.ts'
import type { ViewId } from '../shared/sculpt/views.ts'
import { parseArgs } from './args.ts'
import { encodePng } from './png.ts'

const BASE_TOP = 6

const base = (w = 54, d = 54, h = BASE_TOP): Shape => ({ kind: 'box', center: [0, h / 2, 0], size: [w, h, d], rotation: [0, 0, 0] })

const figure = (f: Partial<FigureSpec>): FigureSpec => ({
  body: 'man',
  build: 'athletic',
  ground: [0, BASE_TOP, 0],
  height: 86,
  facing: 0,
  legs: 'stand',
  weightOn: 'both',
  twist: 0,
  lean: 0,
  headTurn: 0,
  headTilt: 0,
  leftArm: 'down',
  rightArm: 'down',
  drapery: 'none',
  support: 'none',
  style: [],
  ...f
})

const animal = (a: Partial<AnimalSpec>): AnimalSpec => ({
  species: 'horse',
  pose: 'stand',
  ground: [0, BASE_TOP, 0],
  length: 44,
  facing: 0,
  headTurn: 0,
  headRaise: 0,
  tail: 'down',
  lead: 'left',
  ...a
})

export interface Preset { title: string, scene: SceneSpec, blend: number }

// What a model following the prompt would declare for the study's commissions, and the
// canon's range beyond them.
export const POSES: Record<string, Preset> = {
  david: {
    title: 'David a moment before the throw',
    blend: 1.3,
    scene: {
      figures: [figure({ legs: 'lunge', weightOn: 'left', twist: -12, lean: 10, headTurn: 34, headTilt: -4, leftArm: 'across', rightArm: 'sling', support: 'rock', facing: -20, ground: [2, BASE_TOP, 3], style: ['curls', 'frown'] })],
      animals: [],
      shapes: [base()]
    }
  },
  contrapposto: {
    title: 'Standing hero, weight on the right, mantle and stump',
    blend: 1.3,
    scene: {
      figures: [figure({ weightOn: 'right', twist: 12, headTurn: 22, headTilt: 6, leftArm: 'akimbo', rightArm: 'down', drapery: 'mantle', support: 'stump', height: 88, style: ['short_hair'] })],
      animals: [],
      shapes: [base()]
    }
  },
  daphne: {
    title: 'Apollo and Daphne',
    blend: 1.3,
    scene: {
      figures: [
        figure({ body: 'woman', legs: 'stride', weightOn: 'left', twist: 20, headTurn: -60, headTilt: -14, leftArm: 'reach_up', rightArm: 'reach_up', height: 84, ground: [6, BASE_TOP, 12], facing: 10, drapery: 'none', support: 'stump', style: ['long_hair', 'lips_parted'] }),
        figure({ legs: 'stride', weightOn: 'right', twist: -10, lean: 10, headTurn: 0, leftArm: 'forward', rightArm: 'back', height: 86, ground: [-8, BASE_TOP, -6], facing: 22, drapery: 'cloak', style: ['curls'] })
      ],
      animals: [],
      shapes: [base()]
    }
  },
  rider: {
    title: 'A rearing horse with a rider',
    blend: 1.3,
    scene: {
      figures: [figure({ legs: 'ride', weightOn: 'both', twist: 14, lean: 4, headTurn: 25, headTilt: -8, leftArm: 'across', rightArm: 'raised', height: 56, style: ['curls'] })],
      animals: [animal({ species: 'horse', pose: 'rear', length: 40, facing: 0, headTurn: -20, headRaise: 10, ground: [0, BASE_TOP, -4] })],
      shapes: [base()]
    }
  },
  bull: {
    title: 'A charging bull',
    blend: 1.5,
    scene: {
      figures: [],
      animals: [animal({ species: 'bull', pose: 'charge', length: 47, facing: 45, headTurn: -10, headRaise: -14, tail: 'raised', ground: [0, 9, 0] })],
      shapes: [base(), { kind: 'ellipsoid', center: [0, 7, 0], size: [70, 8, 34], rotation: [0, 45, 0] }, { kind: 'box', center: [-9, 7.5, -9], size: [22, 6, 16], rotation: [8, 30, 6] }, { kind: 'box', center: [11, 7, 9], size: [18, 5, 14], rotation: [-6, 60, 5] }]
    }
  },
  horse: {
    title: 'A horse rearing, alone',
    blend: 1.3,
    scene: {
      figures: [],
      animals: [animal({ species: 'horse', pose: 'rear', length: 44, facing: 30, headTurn: -15, headRaise: 5 })],
      shapes: [base()]
    }
  },
  gallop: {
    title: 'A galloping horse',
    blend: 1.3,
    scene: {
      figures: [],
      animals: [animal({ species: 'horse', pose: 'gallop', length: 46, facing: 45, headTurn: 10, tail: 'out', ground: [0, 16, 0] })],
      shapes: [base(), { kind: 'capsule', center: [0, 22, 0], size: [12, 44, 12], rotation: [0, 0, 0] }]
    }
  },
  lion: {
    title: 'A lion lying, head turned',
    blend: 1.2,
    scene: {
      figures: [],
      animals: [animal({ species: 'lion', pose: 'lie', length: 50, facing: 45, headTurn: -30, headRaise: 8, tail: 'curled' })],
      shapes: [base()]
    }
  },
  dog: {
    title: 'A dog sitting',
    blend: 1.3,
    scene: {
      figures: [],
      animals: [animal({ species: 'dog', pose: 'sit', length: 48, headTurn: 25, headRaise: 6 })],
      shapes: [base()]
    }
  },
  cat: {
    title: 'A cat walking, tail up',
    blend: 1.3,
    scene: {
      figures: [],
      animals: [animal({ species: 'cat', pose: 'walk', length: 52, facing: 40, headTurn: -25, tail: 'raised' })],
      shapes: [base()]
    }
  },
  mourner: {
    title: 'A kneeling woman in a robe, hand to her brow',
    blend: 1.3,
    scene: {
      figures: [figure({ body: 'woman', legs: 'kneel', weightOn: 'right', twist: 15, lean: 18, headTurn: -20, headTilt: 25, leftArm: 'to_head', rightArm: 'across', height: 96, drapery: 'robe', support: 'rock', style: ['bun'] })],
      animals: [],
      shapes: [base()]
    }
  },
  thinker: {
    title: 'A seated figure on a rock',
    blend: 1.3,
    scene: {
      figures: [figure({ legs: 'sit', weightOn: 'left', twist: -10, lean: 22, headTurn: 0, headTilt: 15, leftArm: 'down', rightArm: 'to_head', height: 100, support: 'rock', drapery: 'loincloth', style: ['curls', 'beard'] })],
      animals: [],
      shapes: [base()]
    }
  }
}

// The stone set straight to the form: every sample outside it becomes air.
export function cast(grid: Grid, name: string): void {
  const form = grid.forms.get(name)!
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
}

const SHEET: ViewId[] = ['front', 'left', 'top', 'front_left', 'front_right', 'back_left']

function save(out: string, file: string, img: { width: number, height: number, data: Uint8Array }, webp: boolean): void {
  const path = join(out, file)
  writeFileSync(path, encodePng(img.data, img.width, img.height))
  if (webp) execFileSync('cwebp', ['-quiet', '-q', '80', path, '-o', path.replace(/\.png$/, '.webp')])
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const which = args.str('preset', 'all')!
  const out = resolve(args.str('out', '.shots/poses')!)
  const voxel = args.num('voxel', 0.4)
  const webp = args.has('webp')
  const carve = args.has('carve')
  const label = args.str('name')
  const unknown = args.unknown()
  if (unknown.length) throw new Error(`unknown flags: ${unknown.join(', ')}`)
  mkdirSync(out, { recursive: true })
  const names = which === 'all' ? Object.keys(POSES) : which.split(',')
  for (const id of names) {
    const preset = POSES[id]
    if (!preset) throw new Error(`no preset "${id}"; presets: ${Object.keys(POSES).join(', ')}`)
    const scene = expandScene(preset.scene)
    const grid = createGrid({ voxel })
    declareForm(grid, 'scene', { shapes: scene.shapes, blend: preset.blend })
    const t = Date.now()
    let detail = ''
    if (carve) {
      const passes: string[] = []
      for (const [margin, tool] of [[3, 'point'], [0.6, 'claw']] as const) {
        const t0 = Date.now()
        const r = roughOut(grid, { to: 'scene', margin_cm: margin, tool })
        if (r.error) throw new Error(`${id}: ${r.error}`)
        passes.push(`${tool} ${margin} cm ${((Date.now() - t0) / 1000).toFixed(1)} s, ${r.strikes.length} strikes`)
      }
      detail = passes.join('; ')
    } else {
      cast(grid, 'scene')
    }
    const name = label ? `${label}-${id}` : id
    save(out, `${name}.png`, renderContactSheet(grid, SHEET), webp)
    const where = scene.subjects.map(s => `${s.label} [${s.shapes} solids] X ${s.min[0].toFixed(0)}..${s.max[0].toFixed(0)} Y ${s.min[1].toFixed(0)}..${s.max[1].toFixed(0)} Z ${s.min[2].toFixed(0)}..${s.max[2].toFixed(0)}`).join(' | ')
    console.log(`${id}: ${scene.shapes.length} solids, ${scene.cuts.length} cuts, ${((Date.now() - t) / 1000).toFixed(1)} s${detail ? ` (${detail})` : ''}\n  ${where}`)
  }
}

export type { Vec3 }

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
