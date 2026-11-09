// One headless commission: a model (or the scripted --dry Brain) carves a subject through the
// real loop and the real kernel, and everything about the run lands in <study>/<run-id>/.
//
//   npm run bench:sculpt -- --subject pawn|cat|bust [--model opus|fable|sol|gemini]
//     [--tools direct|formed] [--ref on|off] [--round A|B|C] [--max-turns 60] [--max-usd 8]
//     [--name label] [--brain gateway|script] [--dry] [--study-cap 100] [--dir .data/study]
//     [--json-lines] [--reasoning medium] [--turn-timeout 90] [--voxel 0.4] [--no-judge]
//     [--looks png|webp] [--resume <run-id>] [--planner opus|fable|fable52|sol|gemini]
//
// --planner: a second model takes the opening turns (plan, sketch, form, first rough-out) and
// --model carves the rest. The run id carries both, e.g. ...-fable52-plans-opus-...
//
// --json-lines: no tool schemas are sent; the model writes its calls as JSON in plain text.
// For a provider that mishandles the schemas.
// --looks webp: contact sheets go to the model as WebP (about a fifth the bytes of PNG), for
// when request size becomes the problem. Needs cwebp.
//
// --dry needs no key: scripted Brain, reference drawn by code, scripted judge, pretend prices,
// and its own folder (.data/study-dry) so it never touches the real ledger.

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { runCommission } from '../shared/agent/loop.ts'
import { addUsage, resolveModel } from '../shared/agent/pricing.ts'
import { createStudio, replayLog } from '../shared/agent/studio.ts'
import type { StrikeLog } from '../shared/agent/studio.ts'
import { DEFAULT_CONFIG } from '../shared/agent/types.ts'
import type { LoopEvent, ReferenceMode, RunResult, RunState, ToolSetId, Usage } from '../shared/agent/types.ts'
import { createGrid, hashGrid, stoneMassKg } from '../shared/sculpt/grid.ts'
import { KERNEL_VERSION } from '../shared/sculpt/version.ts'
import type { ViewId } from '../shared/sculpt/views.ts'
import { parseArgs } from './args.ts'
import { plannedBrain } from '../shared/agent/planner.ts'
import { gatewayBrain } from './brain.ts'
import type { BrainMeter, Reasoning } from './brain.ts'
import { dryJudge, judge } from './judge.ts'
import type { Verdict } from './judge.ts'
import { Ledger, writeAtomic } from './ledger.ts'
import { encodePng } from './png.ts'
import { dryReference, loadReference, makeReference } from './reference.ts'
import type { CostLine, ReferenceAttempt, ReferenceSheet } from './reference.ts'
import { DRY_TURN_USD, scriptedBrain } from './script.ts'
import { SUBJECTS, SUBJECT_IDS } from './subjects.ts'
import type { SubjectId } from './subjects.ts'

export const SCULPTORS = ['opus', 'fable', 'fable52', 'sol', 'gemini'] as const
export type SculptorKey = typeof SCULPTORS[number]

// The judge's two sheets: every side with rulers, then the piece in the round with none.
export const FINAL_VIEWS: ViewId[] = ['front', 'right', 'back', 'left', 'top', 'front_left']
export const ROUND_VIEWS: ViewId[] = ['front_left', 'front_right', 'back_left', 'back_right']

// Kept back from the sculptor's share of --max-usd for the judge's one call.
const JUDGE_RESERVE_USD = 0.05
// A strike log above this is written gzipped.
const GZIP_OVER_BYTES = 2_000_000

export interface RunConfigFile {
  round: string
  subject: SubjectId
  subjectLabel: string
  commission: string
  model: SculptorKey
  modelId: string
  // A planner model for the opening turns, or null for one model throughout.
  planner: SculptorKey | null
  plannerId: string | null
  tools: ToolSetId
  ref: boolean
  maxTurns: number
  maxUsd: number
  studyCapUsd: number
  brain: 'gateway' | 'script'
  jsonLines: boolean
  reasoning: Reasoning
  turnTimeoutMs: number
  voxel: number
  looks: 'png' | 'webp'
  dry: boolean
  judge: boolean
  name: string | null
}

export interface TurnRow {
  turn: number
  calls: string[]
  strikes: number
  costUsd: number
  usage: Usage
  massKg: number
  ms: number
}

export interface RunFile {
  id: string
  status: 'running' | 'done'
  startedAt: string
  finishedAt: string | null
  wallMs: number
  kernel: number
  config: RunConfigFile
  reference: null | {
    outlines: boolean
    brief: string
    attempts: ReferenceAttempt[]
    heightSpread: number | null
    consistency: number | null
    file: string | null
    error?: string
  }
  result: null | {
    // The loop's own end, and the bench's reading of it (adds study_cap and interrupted).
    ended: RunResult['ended']
    endReason: string
    finish: RunResult['finish']
    error?: string
    turns: number
    passes: number
    strikes: number
  }
  turns: TurnRow[]
  usage: Usage
  cost: {
    // Metered spend: sculptor turns, reference, judge.
    totalUsd: number
    sculptorUsd: number
    referenceUsd: number
    judgeUsd: number
    // An allowance for turns that timed out: the provider bills them, nothing reports them.
    unmeteredUsd: number
    byModel: Record<string, number>
    lines: CostLine[]
    gateway: BrainMeter | null
  }
  // The loop's state after the last finished turn; --resume carries on from it.
  state: RunState | null
  final: null | { numbers: Record<string, number>, hash: string, sheets: string[], strikesFile: string }
  judge: null | (Verdict & { correct: boolean })
  replay: null | { ok: boolean, hash: string, replayHash: string, strikes: number, ms: number, error?: string }
}

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const usd = (v: number) => `$${v.toFixed(2)}`
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)

const CWEBP = existsSync('/opt/homebrew/bin/cwebp') ? '/opt/homebrew/bin/cwebp' : 'cwebp'

// Lossy, but at this quality the ruler digits stay sharp (-sharp_yuv keeps their colour edges).
function toWebp(png: Uint8Array): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'sculptor-look-'))
  try {
    writeFileSync(join(dir, 'in.png'), png)
    execFileSync(CWEBP, ['-quiet', '-q', '85', '-sharp_yuv', join(dir, 'in.png'), '-o', join(dir, 'out.webp')], { stdio: 'ignore' })
    return readFileSync(join(dir, 'out.webp'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function readStrikeLog(dir: string): StrikeLog {
  const gz = join(dir, 'strikes.json.gz')
  const text = existsSync(gz) ? gunzipSync(readFileSync(gz)).toString('utf8') : readFileSync(join(dir, 'strikes.json'), 'utf8')
  return JSON.parse(text) as StrikeLog
}

function writeStrikeLog(dir: string, log: StrikeLog): string {
  const text = JSON.stringify(log)
  // One name per run from the first write on, so a log that grows past the limit does not
  // leave a stale plain copy beside the gzipped one.
  const gz = existsSync(join(dir, 'strikes.json.gz')) || (text.length > GZIP_OVER_BYTES && !existsSync(join(dir, 'strikes.json')))
  const name = gz ? 'strikes.json.gz' : 'strikes.json'
  writeAtomic(join(dir, name), gz ? gzipSync(text) : text)
  return name
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const dry = args.has('dry')
  const studyDir = resolve(args.str('dir', dry ? '.data/study-dry' : '.data/study')!)
  const resumeId = args.str('resume')

  let config: RunConfigFile
  let id: string
  let prior: RunFile | null = null
  if (resumeId) {
    id = resumeId
    const file = join(studyDir, id, 'run.json')
    if (!existsSync(file)) throw new Error(`no run to resume at ${file}`)
    prior = JSON.parse(readFileSync(file, 'utf8')) as RunFile
    if (prior.kernel !== KERNEL_VERSION) throw new Error(`run ${id} was carved on kernel ${prior.kernel}; this is kernel ${KERNEL_VERSION}, and its strikes would not replay`)
    if (!prior.state) throw new Error(`run ${id} never finished a turn; start it again instead of resuming`)
    config = { ...prior.config, looks: prior.config.looks ?? 'png', maxTurns: args.num('max-turns', prior.config.maxTurns), maxUsd: args.num('max-usd', prior.config.maxUsd), studyCapUsd: args.num('study-cap', prior.config.studyCapUsd) }
  } else {
    if (!args.has('subject')) throw new Error(`--subject is required: ${SUBJECT_IDS.join(', ')}`)
    const subject = args.oneOf('subject', SUBJECT_IDS, 'pawn')
    const model = args.oneOf('model', SCULPTORS, 'opus')
    const brain = dry ? 'script' : args.oneOf('brain', ['gateway', 'script'] as const, 'gateway')
    config = {
      round: (args.str('round', 'X') ?? 'X').toUpperCase(),
      subject,
      subjectLabel: SUBJECTS[subject].label,
      commission: SUBJECTS[subject].commission,
      model,
      modelId: resolveModel(model),
      planner: args.has('planner') ? args.oneOf('planner', SCULPTORS, 'opus') : null,
      plannerId: args.has('planner') ? resolveModel(args.oneOf('planner', SCULPTORS, 'opus')) : null,
      tools: args.oneOf('tools', ['direct', 'formed'] as const, 'formed'),
      ref: args.oneOf('ref', ['on', 'off'] as const, 'off') === 'on',
      maxTurns: args.num('max-turns', 60),
      maxUsd: args.num('max-usd', 8),
      studyCapUsd: args.num('study-cap', 100),
      brain,
      jsonLines: args.has('json-lines'),
      reasoning: args.oneOf('reasoning', ['none', 'minimal', 'low', 'medium', 'high'] as const, 'medium'),
      turnTimeoutMs: Math.round(args.num('turn-timeout', DEFAULT_CONFIG.turnTimeoutMs / 1000) * 1000),
      voxel: args.num('voxel', 0.4),
      looks: args.oneOf('looks', ['png', 'webp'] as const, 'png'),
      // A scripted Brain with a real key would still call the real judge and image model.
      dry: dry || brain === 'script',
      judge: !args.has('no-judge'),
      name: args.str('name') ?? null
    }
    const label = config.name ? `-${slug(config.name)}` : ''
    id = `${config.round}-${config.subject}-${config.planner ? `${config.planner}-plans-` : ''}${config.model}-${config.tools}-${config.ref ? 'ref' : 'noref'}${label}-${stamp()}-${Math.random().toString(16).slice(2, 5)}`
  }
  const stray = args.unknown()
  if (stray.length) throw new Error(`unknown flag${stray.length === 1 ? '' : 's'}: ${stray.join(', ')}`)
  if (!(config.maxTurns >= 1) || !(config.maxUsd > 0)) throw new Error('--max-turns and --max-usd must be above zero')
  if (!config.dry && !process.env.AI_GATEWAY_API_KEY) {
    throw new Error('AI_GATEWAY_API_KEY is not set. Put it in .env (see .env.example), or pass --dry to run the scripted Brain with no key.')
  }

  const say = (line: string) => console.log(`[${id}] ${line}`)
  const dir = join(studyDir, id)
  const ledger = new Ledger(studyDir)
  const spentBefore = prior ? prior.cost.totalUsd + prior.cost.unmeteredUsd : 0
  const reserved = ledger.reserve(id, config.maxUsd, config.studyCapUsd, spentBefore)
  if (!reserved.ok) {
    console.error(`[${id}] not started. ${reserved.reason}.`)
    return 3
  }
  mkdirSync(join(dir, 'looks'), { recursive: true })

  const started = Date.now()
  const lines: CostLine[] = prior ? prior.cost.lines.filter(l => l.what !== 'sculptor') : []
  const run: RunFile = prior
    ? { ...prior, status: 'running', finishedAt: null, config, result: null, final: null, judge: null, replay: null }
    : {
        id,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        wallMs: 0,
        kernel: KERNEL_VERSION,
        config,
        reference: null,
        result: null,
        turns: [],
        usage: { input: 0, output: 0 },
        cost: { totalUsd: 0, sculptorUsd: 0, referenceUsd: 0, judgeUsd: 0, unmeteredUsd: 0, byModel: {}, lines: [], gateway: null },
        state: null,
        final: null,
        judge: null,
        replay: null
      }
  const wallBefore = prior?.wallMs ?? 0
  let meter: BrainMeter | null = null

  const tally = () => {
    const sum = (what: CostLine['what'][]) => lines.filter(l => what.includes(l.what)).reduce((n, l) => n + l.usd, 0)
    const byModel: Record<string, number> = {}
    for (const l of lines) byModel[l.model] = (byModel[l.model] ?? 0) + l.usd
    const cents = (v: number) => Math.round(v * 1e6) / 1e6
    const sculptorUsd = run.state?.costUsd ?? 0
    if (sculptorUsd > 0) byModel[config.dry ? 'dry' : config.modelId] = (byModel[config.dry ? 'dry' : config.modelId] ?? 0) + sculptorUsd
    run.cost = {
      ...run.cost,
      sculptorUsd: cents(sculptorUsd),
      referenceUsd: cents(sum(['reference_brief', 'reference_image'])),
      judgeUsd: cents(sum(['judge'])),
      totalUsd: cents(sculptorUsd + sum(['reference_brief', 'reference_image', 'judge'])),
      unmeteredUsd: cents(run.cost.unmeteredUsd),
      byModel: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, cents(v)])),
      lines: [...lines, ...(sculptorUsd > 0 ? [{ what: 'sculptor' as const, model: config.dry ? 'dry' : config.modelId, usage: run.usage, usd: sculptorUsd }] : [])],
      gateway: meter
    }
  }
  const stopper = new AbortController()
  let stopReason = ''
  // Saves the run and its spend; returns false once the study as a whole is over its cap.
  const save = (state: 'running' | 'done' = 'running'): boolean => {
    tally()
    run.wallMs = wallBefore + Date.now() - started
    writeAtomic(join(dir, 'run.json'), JSON.stringify(run, null, 2))
    const studySpent = ledger.record(id, run.cost.totalUsd + run.cost.unmeteredUsd, config.maxUsd, state)
    return studySpent < config.studyCapUsd
  }
  const overCap = () => {
    if (stopReason) return
    stopReason = 'study_cap'
    say(`the study has reached its cap of ${usd(config.studyCapUsd)}; stopping this run`)
    stopper.abort()
  }
  process.on('SIGINT', () => {
    if (stopReason === 'interrupted') process.exit(130)
    stopReason = stopReason || 'interrupted'
    say('interrupted; finishing the turn in hand and saving (Ctrl-C again to quit now)')
    stopper.abort()
  })
  save()
  say(`${config.subject} · ${config.dry ? 'scripted (dry)' : config.modelId} · ${config.tools} tools · reference ${config.ref ? 'on' : 'off'} · up to ${config.maxTurns} turns and ${usd(config.maxUsd)} → ${dir}`)

  // ---------- reference ----------
  let sheet: ReferenceSheet | null = null
  if (config.ref) {
    const saved = join(dir, 'reference.png')
    if (prior && existsSync(saved)) {
      sheet = loadReference(readFileSync(saved), prior.reference?.brief ?? '')
    } else if (!prior) {
      sheet = config.dry ? dryReference(config.subject) : await makeReference({ commission: config.commission, sculptor: config.modelId, signal: stopper.signal, log: say })
      lines.push(...sheet.costs)
      if (sheet.png) writeAtomic(saved, sheet.png)
      const c = sheet.analysis?.consistency ?? null
      run.reference = {
        outlines: sheet.outlines,
        brief: sheet.brief,
        attempts: sheet.attempts,
        heightSpread: c ? Math.round(c.heightSpread * 1000) / 1000 : null,
        consistency: c ? Math.round(c.score * 1000) / 1000 : null,
        file: sheet.png ? 'reference.png' : null,
        ...(sheet.error ? { error: sheet.error } : {})
      }
      writeAtomic(join(dir, 'reference.json'), JSON.stringify(run.reference, null, 2))
      say(sheet.png
        ? `reference sheet ${sheet.outlines ? 'traced' : 'kept for viewing only (could not be traced)'} after ${sheet.attempts.length} image${sheet.attempts.length === 1 ? '' : 's'}, ${usd(sheet.costs.reduce((n, l) => n + l.usd, 0))}`
        : `no reference sheet: ${sheet.error}; carving without one`)
      if (!save()) overCap()
    }
  }
  const hasSheet = !!sheet?.png
  const reference: ReferenceMode = !hasSheet ? 'none' : sheet!.outlines ? 'outlines' : 'view'

  // ---------- stone, studio, brain ----------
  let grid = createGrid({ voxel: config.voxel })
  let resumeLog: StrikeLog | undefined
  if (prior) {
    resumeLog = readStrikeLog(dir)
    grid = replayLog(resumeLog, g => createGrid(g))
    say(`resumed at turn ${prior.state!.turns}: ${resumeLog.strikes.length} strikes replayed, ${usd(spentBefore)} already spent`)
  }
  const studio = createStudio({
    grid,
    encodeImage: (image) => {
      const png = encodePng(image.data, image.width, image.height)
      return config.looks === 'webp' ? toWebp(png) : png
    },
    reference: hasSheet ? sheet!.analysis : null,
    ...(resumeLog ? { resume: resumeLog } : {})
  })
  const referenceUsd = lines.filter(l => l.what !== 'judge').reduce((n, l) => n + l.usd, 0)
  const loopMaxUsd = config.maxUsd - referenceUsd - (config.judge ? JUDGE_RESERVE_USD : 0)
  if (!(loopMaxUsd > 0)) throw new Error(`--max-usd ${config.maxUsd} leaves nothing for carving after the reference sheet (${usd(referenceUsd)})`)

  const gateway = config.brain === 'gateway'
    ? gatewayBrain({ model: config.modelId, toolSet: config.tools, reference, mode: config.jsonLines ? 'jsonl' : 'native', reasoning: config.reasoning, log: say })
    : null
  meter = gateway?.meter ?? null
  const planner = gateway && config.plannerId
    ? gatewayBrain({ model: config.plannerId, toolSet: config.tools, reference, mode: config.jsonLines ? 'jsonl' : 'native', reasoning: config.reasoning, log: say })
    : null
  const brain = planner && gateway ? plannedBrain({ planner, executor: gateway }) : gateway ?? scriptedBrain({ subject: config.subject, toolSet: config.tools, reference, turnUsd: DRY_TURN_USD })

  // ---------- events ----------
  const eventsFile = join(dir, 'events.ndjson')
  const record = (row: Record<string, unknown>) => appendFileSync(eventsFile, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`)
  let lookN = readdirSync(join(dir, 'looks')).filter(f => /\.(png|webp)$/.test(f)).length
  let text = ''
  let textTurn = 0
  const flushText = () => {
    if (text) record({ type: 'text', turn: textTurn, text })
    text = ''
  }
  let turnStarted = Date.now()
  let turnCalls: string[] = []
  let turnStrikes = 0
  let dearest = 0
  let savedStrikes = resumeLog?.strikes.length ?? 0

  const onEvent = (e: LoopEvent) => {
    if (e.type === 'text') {
      if (e.turn !== textTurn) flushText()
      textTurn = e.turn
      text += e.delta
      return
    }
    flushText()
    switch (e.type) {
      case 'turn_start':
        turnStarted = Date.now()
        turnCalls = []
        turnStrikes = 0
        record(e)
        break
      case 'turn_retry':
        // The first attempt was sent and will be billed, but its usage never came back.
        run.cost.unmeteredUsd += dearest || 0.1
        say(`turn ${e.turn} failed (${e.error}); asking again`)
        record(e)
        break
      case 'tool_call':
        turnCalls.push(e.call.name)
        record(e)
        break
      case 'tool_result': {
        turnStrikes += e.strikeCount
        const { strikes: _strikes, ...rest } = e
        record(rest)
        break
      }
      case 'look': {
        const files = e.images.map((png) => {
          const name = `${String(++lookN).padStart(3, '0')}.${png[0] === 0x52 ? 'webp' : 'png'}`
          writeAtomic(join(dir, 'looks', name), png)
          return `looks/${name}`
        })
        const { images: _images, ...rest } = e
        record({ ...rest, files })
        break
      }
      case 'rebuild':
        record({ type: e.type, turn: e.turn, reason: e.reason, messages: e.messages.length })
        break
      case 'turn_end': {
        dearest = Math.max(dearest, e.costUsd)
        run.state = e.state
        run.usage = e.state.usage
        const massKg = Math.round(stoneMassKg(grid) * 10) / 10
        run.turns.push({ turn: e.turn, calls: turnCalls, strikes: turnStrikes, costUsd: e.costUsd, usage: e.usage, massKg, ms: Date.now() - turnStarted })
        record({ type: e.type, turn: e.turn, calls: e.calls, usage: e.usage, costUsd: e.costUsd, totalUsd: e.state.costUsd })
        // Strikes first: a crash between the two writes must not leave a state that claims
        // passes the saved log does not hold.
        if (studio.strikes.length !== savedStrikes) {
          writeStrikeLog(dir, studio.log())
          savedStrikes = studio.strikes.length
        }
        writeAtomic(join(dir, 'passes.json'), JSON.stringify(e.state.passes, null, 2))
        const within = save()
        say(`turn ${String(e.turn).padStart(2)}/${config.maxTurns}  ${(turnCalls.join(', ') || '(no tool call)').padEnd(28)}  +${turnStrikes} strikes  ${usd(run.cost.totalUsd)}/${usd(config.maxUsd)}  ${massKg.toFixed(1)} kg`)
        if (!within) overCap()
        break
      }
      default:
        record(e)
    }
  }

  // ---------- the commission ----------
  let result: RunResult
  if (stopper.signal.aborted) {
    result = { ...(run.state ?? { turns: 0, passes: [], notebook: { stage: null, text: '', turn: 0 }, usage: { input: 0, output: 0 }, costUsd: 0 }), ended: 'aborted', finish: null }
  } else {
    result = await runCommission({
      brain,
      studio,
      commission: { prompt: config.commission, ...(hasSheet ? { reference: { png: sheet!.png!, outlines: sheet!.outlines } } : {}) },
      config: { toolSet: config.tools, maxTurns: config.maxTurns, maxUsd: loopMaxUsd, turnTimeoutMs: config.turnTimeoutMs, toolResults: config.jsonLines ? 'text' : 'native' },
      onEvent,
      signal: stopper.signal,
      ...(prior?.state ? { resume: prior.state } : {})
    })
  }
  flushText()
  // A run that died on a timed-out retry sent a second call nobody metered.
  if (result.ended === 'error' && /no answer from the model/.test(result.error ?? '')) run.cost.unmeteredUsd += dearest || 0.1
  // The loop's totals are the record; a turn that was cut short never reached turn_end.
  run.state = { turns: result.turns, passes: result.passes, notebook: result.notebook, usage: result.usage, costUsd: result.costUsd }
  run.usage = addUsage({ input: 0, output: 0 }, result.usage)
  const endReason = result.ended === 'aborted' && stopReason ? stopReason : result.ended
  run.result = {
    ended: result.ended,
    endReason,
    finish: result.finish,
    ...(result.error ? { error: result.error } : {}),
    turns: result.turns,
    passes: result.passes.length,
    strikes: studio.strikes.length
  }

  // ---------- what was made ----------
  const strikesFile = writeStrikeLog(dir, studio.log())
  writeAtomic(join(dir, 'passes.json'), JSON.stringify(result.passes, null, 2))
  const hash = hashGrid(grid)
  const final = studio.render(FINAL_VIEWS, 'grid')
  const round = studio.render(ROUND_VIEWS, 'grid')
  const finalPng = encodePng(final.data, final.width, final.height)
  const roundPng = encodePng(round.data, round.width, round.height)
  writeAtomic(join(dir, 'final.png'), finalPng)
  writeAtomic(join(dir, 'final_round.png'), roundPng)
  run.final = { numbers: studio.measure(reference === 'outlines' ? 'reference' : 'grid'), hash, sheets: ['final.png', 'final_round.png'], strikesFile }
  save()

  // ---------- the judge ----------
  // An untouched block or an interrupted run has nothing worth a verdict, and a run stopped by
  // the study cap must not spend past it.
  if (config.judge && studio.strikes.length > 0 && !stopReason) {
    const verdict = config.dry
      ? dryJudge(id, config.subjectLabel, config.subject === 'pawn')
      : await judge({ sheets: [finalPng, roundPng], runId: id, log: say })
    if (verdict.cost) lines.push(verdict.cost)
    run.judge = { ...verdict, correct: !verdict.error && verdict.pick === config.subjectLabel }
    say(verdict.error
      ? `the judge failed: ${verdict.error}`
      : `judge: "${verdict.pick}" (${run.judge.correct ? 'correct' : `wrong, it is a ${config.subjectLabel}`}), confidence ${verdict.confidence.toFixed(2)}`)
  }

  // ---------- does the log reproduce the stone? ----------
  const t0 = Date.now()
  try {
    const log = readStrikeLog(dir)
    const replayHash = hashGrid(replayLog(log, g => createGrid(g)))
    run.replay = { ok: replayHash === hash, hash, replayHash, strikes: log.strikes.length, ms: Date.now() - t0 }
  } catch (err) {
    run.replay = { ok: false, hash, replayHash: '', strikes: studio.strikes.length, ms: Date.now() - t0, error: (err as Error).message }
  }

  run.status = 'done'
  run.finishedAt = new Date().toISOString()
  save('done')
  const title = result.finish ? ` "${result.finish.title}"` : ''
  say(`${endReason}${title} after ${result.turns} turns, ${result.passes.length} passes, ${studio.strikes.length} strikes; ${usd(run.cost.totalUsd)}${run.cost.unmeteredUsd ? ` (+${usd(run.cost.unmeteredUsd)} allowed for timed-out turns)` : ''}; ${run.final.numbers.mass_kg} kg left; replay ${run.replay.ok ? 'matches' : `DOES NOT MATCH (${run.replay.error ?? `${run.replay.replayHash} vs ${hash}`})`}`)
  if (result.error) say(`error: ${result.error}`)
  if (!config.dry && meter && meter.reportedCalls > 0) say(`sculptor turns by our price table ${usd(meter.pricedUsd)}, as reported by the gateway ${usd(meter.reportedUsd)} (${meter.reportedCalls} of ${meter.calls} calls reported)`)
  return !run.replay.ok || result.ended === 'error' ? 1 : stopReason === 'study_cap' ? 3 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(code => process.exit(code), (err) => {
    console.error(`bench:sculpt: ${(err as Error).message}`)
    process.exit(2)
  })
}
