// How long a full rough-out takes against how many solids the form holds: the pass every
// commission makes first (point at 3 cm), then the close one (claw at 0.6 cm). No model.
//
//   node bench/timing.ts [--preset a,b] [--voxel 0.4]

import { expandCanon } from '../shared/sculpt/anatomy.ts'
import type { DeclaredShape } from '../shared/sculpt/anatomy.ts'
import { expandScene } from '../shared/sculpt/figure.ts'
import { createGrid } from '../shared/sculpt/grid.ts'
import { roughOut } from '../shared/sculpt/hand.ts'
import { declareForm } from '../shared/sculpt/shapes.ts'
import type { Shape } from '../shared/sculpt/types.ts'
import { parseArgs } from './args.ts'
import { POSES } from './poses.ts'

const sh = (kind: DeclaredShape['kind'], center: Shape['center'], size: Shape['size'], rotation: Shape['rotation'] = [0, 0, 0]): DeclaredShape => ({ kind, center, size, rotation })

// The study's kind of form: a dozen to two dozen plain solids.
function blobs(n: number): Shape[] {
  const out: Shape[] = [{ kind: 'box', center: [0, 3, 0], size: [50, 6, 44], rotation: [0, 0, 0] }]
  const step = 88 / (n - 1)
  for (let i = 1; i < n; i++) {
    const t = i / n
    out.push({ kind: i % 3 === 0 ? 'capsule' : 'ellipsoid', center: [5 * Math.sin(i * 2.1), 4 + step * i - step / 2, 4 * Math.cos(i * 1.7)], size: [30 - 12 * t, 1.8 * step + 6, 26 - 8 * t], rotation: [0, i * 13, 0] })
  }
  return out
}

export const FORMS: Record<string, () => { shapes: Shape[], blend: number }> = {
  blobs4: () => ({ shapes: blobs(4), blend: 3 }),
  blobs12: () => ({ shapes: blobs(12), blend: 2 }),
  blobs24: () => ({ shapes: blobs(24), blend: 2 }),
  bust: () => ({
    shapes: expandCanon([
      { ...sh('head', [0, 83, 1], [22, 32, 27], [6, 16, 3]), style: ['male', 'mature', 'curls'] },
      { ...sh('torso', [0, 36, -1], [60, 46, 30], [0, -8, -3]), style: ['mantle', 'socle'] }
    ]).shapes,
    blend: 1.2
  }),
  ...Object.fromEntries(Object.entries(POSES).map(([id, p]) => [id, () => ({ shapes: expandScene(p.scene).shapes, blend: p.blend })]))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const which = (args.str('preset', 'blobs4,blobs12,blobs24,bust,david,rider,daphne')!).split(',')
  const voxel = args.num('voxel', 0.4)
  for (const id of which) {
    const make = FORMS[id]
    if (!make) throw new Error(`no form "${id}"`)
    const form = make()
    const grid = createGrid({ voxel })
    declareForm(grid, 'f', form)
    const row: string[] = [`${id.padEnd(13)} ${String(form.shapes.length).padStart(4)} solids`]
    for (const [margin, tool] of [[3, 'point'], [0.6, 'claw']] as const) {
      const t = performance.now()
      const r = roughOut(grid, { to: 'f', margin_cm: margin, tool })
      if (r.error) throw new Error(`${id}: ${r.error}`)
      row.push(`${tool} ${margin}: ${((performance.now() - t) / 1000).toFixed(1).padStart(5)} s ${String(r.strikes.length).padStart(5)} strikes`)
    }
    console.log(row.join(' | '))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
