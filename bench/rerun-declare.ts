// A saved run's first declare_figure, declared again through today's Studio and roughed out
// with the hand (point at 3 cm, claw at 0.6), rendered as a contact sheet: how a canon change
// would have treated what a model actually declared. No model.
//
//   node bench/rerun-declare.ts --run <run-id> [--out .shots] [--name x]

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createStudio } from '../shared/agent/studio.ts'
import { createGrid } from '../shared/sculpt/grid.ts'
import { parseArgs } from './args.ts'
import { encodePng } from './png.ts'

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const run = args.str('run')
  if (!run) throw new Error('--run <run-id> is required')
  const out = resolve(args.str('out', '.shots')!)
  const name = args.str('name', run)!
  const dir = join(resolve('.data/study'), run)
  let declared: { name: string, args: Record<string, unknown> } | null = null
  for (const line of readFileSync(join(dir, 'events.ndjson'), 'utf8').split('\n')) {
    if (!line) continue
    const e = JSON.parse(line) as { type: string, ok?: boolean, call?: { name: string, args: Record<string, unknown> } }
    if (e.type === 'tool_result' && e.ok && e.call?.name === 'declare_figure') declared = e.call
  }
  if (!declared) throw new Error(`no declare_figure in ${run}`)
  const studio = createStudio({ grid: createGrid({}), encodeImage: image => encodePng(image.data, image.width, image.height) })
  const form = String(declared.args.name)
  const r = await studio.run({ id: 'd', name: 'declare_figure', args: declared.args } as never)
  console.log(r.summary.slice(0, 600))
  for (const [margin, tool] of [[3, 'point'], [0.6, 'claw']] as const) {
    await studio.run({ id: tool, name: 'rough_out', args: { to: form, margin_cm: margin, tool, why: 'rerun' } } as never)
  }
  const sheet = studio.render(['front', 'left', 'top', 'front_left', 'front_right', 'back_left'])
  writeFileSync(join(out, `${name}.png`), encodePng(sheet.data, sheet.width, sheet.height))
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
