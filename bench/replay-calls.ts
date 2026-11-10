// A saved run's tool calls, turn by turn, run again through today's Studio with no model: what
// a canon or guard change would have done to what a model actually asked for. Looks are skipped.
//
//   node bench/replay-calls.ts --run <run-id> [--turns 4] [--out .shots] [--name x]

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createStudio } from '../shared/agent/studio.ts'
import { createGrid, stoneMassKg } from '../shared/sculpt/grid.ts'
import { parseArgs } from './args.ts'
import { encodePng } from './png.ts'

const SKIP = new Set(['look', 'closeup', 'slice', 'note', 'finish', 'focus', 'unfocus'])

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const run = args.str('run')
  if (!run) throw new Error('--run <run-id> is required')
  const turns = args.num('turns', 1e9)
  const out = resolve(args.str('out', '.shots')!)
  const name = args.str('name', run)!
  const dir = join(resolve('.data/study'), run)
  const studio = createStudio({ grid: createGrid({}), encodeImage: image => encodePng(image.data, image.width, image.height) })
  for (const line of readFileSync(join(dir, 'events.ndjson'), 'utf8').split('\n')) {
    if (!line) continue
    const e = JSON.parse(line) as { type: string, turn: number, ok?: boolean, call?: { id: string, name: string, args: Record<string, unknown> } }
    if (e.type !== 'tool_result' || !e.ok || !e.call || e.turn > turns || SKIP.has(e.call.name)) continue
    try {
      const r = await studio.run({ id: e.call.id, name: e.call.name, args: e.call.args } as never)
      console.log(`turn ${e.turn} ${e.call.name}: ${r.summary.slice(0, 160)}`)
    } catch (err) {
      console.log(`turn ${e.turn} ${e.call.name}: REFUSED ${(err as Error).message}`)
    }
  }
  console.log(`${stoneMassKg(studio.grid).toFixed(1)} kg of stone remains`)
  const sheet = studio.render(['front', 'left', 'front_left', 'front_right'])
  writeFileSync(join(out, `${name}.png`), encodePng(sheet.data, sheet.width, sheet.height))
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
