// The judge: a model that was not one of the sculptors looks at the finished stone, and only
// the stone, and says which of twelve things it is. It never sees the commission, the reference
// sheet, the sculptor's notes or any overlay.

import { generateText, Output } from 'ai'
import { z } from 'zod'
import { JUDGE_MODEL, MODELS, usageOf } from '../shared/agent/pricing.ts'
import { toBase64 } from '../shared/agent/context.ts'
import { createRng } from '../shared/sculpt/rng.ts'
import { newMeter, settleCost } from './brain.ts'
import type { CostLine } from './reference.ts'
import { JUDGE_LABELS, tidySentence } from './subjects.ts'

export interface Verdict {
  pick: string
  // 0 to 1, the judge's own.
  confidence: number
  reasoning: string
  // The labels in the order this judge was shown them.
  labels: string[]
  model: string
  cost: CostLine | null
  error?: string
}

const INSTRUCTIONS = `You are shown a small sculpture carved from a single block of stone, rendered as plain grey clay so that only its shape can be judged. The first image shows it from the front, right, back, left and top, plus one three-quarter view; the faint grid lines and the numbers along the edges are centimetre rulers and are not part of the piece. The second image shows it from four three-quarter angles with no rulers.

The carving may be rough or unfinished. Judge the shape as a whole. Decide which one of the listed things it most likely depicts. You must choose exactly one label from the list, copied exactly. Give your confidence from 0 (a guess) to 1 (certain), and one sentence saying what in the shape decided it.`

function hashText(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

// The same run always sees the same order; different runs see different ones, so no label
// wins by sitting first.
export function shuffledLabels(seed: string): string[] {
  const rng = createRng(hashText(seed))
  const out = JUDGE_LABELS.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1)
    const t = out[i]!
    out[i] = out[j]!
    out[j] = t
  }
  return out
}

export interface JudgeOptions {
  // Encoded PNGs: the six-view sheet with rulers, then the ruler-free three-quarter sheet.
  sheets: Uint8Array[]
  // Seeds the label order.
  runId: string
  signal?: AbortSignal
  log?: (line: string) => void
}

export async function judge(opts: JudgeOptions): Promise<Verdict> {
  const labels = shuffledLabels(opts.runId)
  const model = MODELS[JUDGE_MODEL]
  const schema = z.object({
    pick: z.enum(labels as [string, ...string[]]),
    confidence: z.number().min(0).max(1),
    reasoning: z.string()
  })
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000)
  try {
    const r = await generateText({
      model,
      instructions: INSTRUCTIONS,
      messages: [{
        role: 'user',
        content: [
          ...opts.sheets.map(png => ({ type: 'file' as const, mediaType: 'image/png', data: { type: 'data' as const, data: toBase64(png) } })),
          { type: 'text', text: `Which one of these does the sculpture depict?\n${labels.map(l => `- ${l}`).join('\n')}` }
        ]
      }],
      output: Output.object({ schema }),
      reasoning: 'low',
      maxOutputTokens: 2000,
      maxRetries: 1,
      abortSignal: signal,
      providerOptions: { gateway: { order: ['anthropic'] } }
    })
    const usage = usageOf(r.usage)
    const cost: CostLine = { what: 'judge', model, usage, usd: settleCost(model, usage, r.providerMetadata, newMeter(), opts.log) }
    const out = r.output as z.infer<typeof schema>
    return { pick: out.pick, confidence: out.confidence, reasoning: tidySentence(out.reasoning), labels, model, cost }
  } catch (err) {
    return { pick: '', confidence: 0, reasoning: '', labels, model, cost: null, error: (err as Error).message.slice(0, 300) }
  }
}

// --dry: no model. Recognises the pawn and misses the others, so the report shows both.
export function dryJudge(runId: string, subjectLabel: string, isPawn: boolean): Verdict {
  const labels = shuffledLabels(runId)
  const pick = isPawn ? subjectLabel : labels.find(l => l !== subjectLabel)!
  return {
    pick,
    confidence: isPawn ? 0.8 : 0.35,
    reasoning: 'A scripted verdict for a dry run; no model looked at the stone.',
    labels,
    model: 'dry',
    cost: { what: 'judge', model: 'dry', usage: { input: 3000, output: 100 }, usd: 0.008 }
  }
}
