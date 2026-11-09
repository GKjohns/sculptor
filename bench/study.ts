// A round of the study in one command: runs its arms as separate bench:sculpt processes, a few
// at a time. Rounds are launched one by one by the operator, who reads the report in between.
//
//   npm run bench:study -- --round A                       Opus × {pawn, cat, bust} × {direct, formed}, no reference
//   npm run bench:study -- --round B --tools formed        the better tool set, three subjects, with reference
//   npm run bench:study -- --round C --tools formed --ref on   {cat, bust} × {fable, sol, gemini}
//     [--concurrency 3] [--dry] [--list] and anything bench:sculpt takes (--max-turns, --max-usd,
//     --study-cap, --dir, --voxel, --json-lines, --reasoning, --turn-timeout, --no-judge, --looks)

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from './args.ts'

interface Arm { subject: string, model: string, tools: string, ref: string }

const PASS_ON = ['max-turns', 'max-usd', 'study-cap', 'dir', 'voxel', 'reasoning', 'turn-timeout', 'name', 'looks']
const SWITCHES = ['dry', 'json-lines', 'no-judge']

function armsFor(round: string, tools: string | undefined, ref: string | undefined): Arm[] {
  const arms: Arm[] = []
  if (round === 'A') {
    for (const subject of ['pawn', 'cat', 'bust']) {
      for (const t of ['direct', 'formed']) arms.push({ subject, model: 'opus', tools: t, ref: 'off' })
    }
  } else if (round === 'B') {
    if (!tools) throw new Error('round B needs --tools direct|formed: the tool set that did better in round A')
    for (const subject of ['pawn', 'cat', 'bust']) arms.push({ subject, model: 'opus', tools, ref: 'on' })
  } else {
    if (!tools || !ref) throw new Error('round C needs --tools direct|formed and --ref on|off: the best configuration so far')
    for (const subject of ['cat', 'bust']) {
      for (const model of ['fable', 'sol', 'gemini']) arms.push({ subject, model, tools, ref })
    }
  }
  return arms
}

function runArm(round: string, arm: Arm, extra: string[]): Promise<number> {
  const tag = `${arm.subject}/${arm.model}/${arm.tools}/${arm.ref === 'on' ? 'ref' : 'noref'}`
  const script = fileURLToPath(new URL('./sculpt.ts', import.meta.url))
  const argv = ['--env-file-if-exists=.env', script, '--round', round, '--subject', arm.subject, '--model', arm.model, '--tools', arm.tools, '--ref', arm.ref, ...extra]
  return new Promise((done) => {
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    const pipe = (stream: NodeJS.ReadableStream, out: NodeJS.WritableStream) => {
      let rest = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        const lines = (rest + chunk).split('\n')
        rest = lines.pop() ?? ''
        for (const line of lines) out.write(`${line}\n`)
      })
      stream.on('end', () => {
        if (rest) out.write(`${rest}\n`)
      })
    }
    pipe(child.stdout, process.stdout)
    pipe(child.stderr, process.stderr)
    child.on('error', (err) => {
      console.error(`${tag}: could not start: ${err.message}`)
      done(2)
    })
    child.on('close', code => done(code ?? 1))
  })
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const round = args.oneOf('round', ['A', 'B', 'C'] as const, 'A')
  if (!args.has('round')) throw new Error('--round A|B|C is required')
  const tools = args.has('tools') ? args.oneOf('tools', ['direct', 'formed'] as const, 'formed') : undefined
  const ref = args.has('ref') ? args.oneOf('ref', ['on', 'off'] as const, 'off') : undefined
  const concurrency = Math.max(1, Math.round(args.num('concurrency', 3)))
  const list = args.has('list')
  const extra: string[] = []
  for (const key of PASS_ON) {
    const v = args.str(key)
    if (v !== undefined) extra.push(`--${key}`, v)
  }
  for (const key of SWITCHES) if (args.has(key)) extra.push(`--${key}`)
  const stray = args.unknown()
  if (stray.length) throw new Error(`unknown flag${stray.length === 1 ? '' : 's'}: ${stray.join(', ')}`)
  if (round === 'A' && (tools || ref)) throw new Error('round A is fixed: both tool sets, no reference. Leave out --tools and --ref.')
  if (round === 'B' && ref) throw new Error('round B is always with the reference. Leave out --ref.')

  const arms = armsFor(round, tools, ref)
  console.log(`Round ${round}: ${arms.length} runs, ${concurrency} at a time${args.has('dry') ? ' (dry)' : ''}`)
  for (const a of arms) console.log(`  ${a.subject.padEnd(5)} ${a.model.padEnd(7)} ${a.tools.padEnd(7)} reference ${a.ref}`)
  if (list) return 0

  const codes: number[] = new Array<number>(arms.length).fill(-1)
  let next = 0
  const worker = async () => {
    while (next < arms.length) {
      const i = next++
      codes[i] = await runArm(round, arms[i]!, extra)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, arms.length) }, worker))

  const label = (code: number) => code === 0 ? 'ok' : code === 3 ? 'stopped by the study cap' : `exit ${code}`
  console.log(`\nRound ${round} finished:`)
  arms.forEach((a, i) => console.log(`  ${a.subject.padEnd(5)} ${a.model.padEnd(7)} ${a.tools.padEnd(7)} reference ${a.ref.padEnd(3)}  ${label(codes[i]!)}`))
  console.log('Next: npm run bench:report')
  return codes.every(c => c === 0) ? 0 : 1
}

main().then(code => process.exit(code), (err) => {
  console.error(`bench:study: ${(err as Error).message}`)
  process.exit(2)
})
