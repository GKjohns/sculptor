// Makes the hidden reference sheet for one commission: the sculptor model writes the brief, the
// image model draws it, and shared/agent/reference.ts turns the picture into outlines. A sheet
// that cannot be traced is drawn once more; if that fails too the picture is kept for the
// sculptor's eyes only. Every call is priced and handed back, so it counts against the run.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateText } from 'ai'
import { IMAGE_MODEL, MODELS, usageOf } from '../shared/agent/pricing.ts'
import { referenceBriefCall, referenceImageCall } from '../shared/agent/brainRequest.ts'
import { analyzeReference } from '../shared/agent/reference.ts'
import type { ReferenceAnalysis } from '../shared/agent/reference.ts'
import type { Usage } from '../shared/agent/types.ts'
import { newMeter, settleCost } from './brain.ts'
import { decodePng, encodePng } from './png.ts'
import type { Rgba } from './png.ts'
import { scriptedSheet } from './script.ts'
import type { SubjectId } from './subjects.ts'

export interface CostLine {
  what: 'reference_brief' | 'reference_image' | 'judge' | 'sculptor'
  model: string
  usage: Usage
  usd: number
}

export interface ReferenceAttempt {
  ok: boolean
  reasons: string[]
  width: number
  height: number
}

export interface ReferenceSheet {
  // The sheet as the sculptor is shown it and as it was traced (PNG, long side at most 1024 px).
  // Null if no image came back.
  png: Uint8Array | null
  // The analysis of the sheet that was kept. `ok` false means view only.
  analysis: ReferenceAnalysis | null
  outlines: boolean
  brief: string
  attempts: ReferenceAttempt[]
  costs: CostLine[]
  error?: string
}

const BRIEF_TIMEOUT_MS = 90_000
const IMAGE_TIMEOUT_MS = 120_000
// The sheet is shrunk to this before anything reads it, so the PNG that is saved (and analysed
// again on a resume) is pixel for pixel what the outlines were traced from. At 1024 px a
// quadrant still gives about 0.25 cm a pixel, finer than the 0.4 cm outline cells.
const MAX_SIDE = 1024

const isPng = (b: Uint8Array) => b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71

// Image models return JPEG or a PNG flavour the small decoder does not read as often as not;
// macOS's own converter turns either into a plain 8-bit PNG.
function viaSips(bytes: Uint8Array): Rgba {
  const dir = mkdtempSync(join(tmpdir(), 'sculptor-ref-'))
  try {
    writeFileSync(join(dir, 'in.img'), bytes)
    execFileSync('/usr/bin/sips', ['-s', 'format', 'png', join(dir, 'in.img'), '--out', join(dir, 'out.png')], { stdio: 'ignore' })
    return decodePng(readFileSync(join(dir, 'out.png')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function decodeImage(bytes: Uint8Array): Rgba {
  if (isPng(bytes)) {
    try {
      return decodePng(bytes)
    } catch {
      // 16-bit, paletted or interlaced: let the converter flatten it
    }
  }
  return viaSips(bytes)
}

// Area-averaged shrink so the long side is at most `max`. Never enlarges.
export function shrink(src: Rgba, max: number): Rgba {
  const k = Math.max(src.width, src.height) / max
  if (k <= 1) return src
  const width = Math.max(1, Math.round(src.width / k))
  const height = Math.max(1, Math.round(src.height / k))
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * src.height / height)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * src.height / height))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * src.width / width)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * src.width / width))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * src.width + sx) * 4
          r += src.data[o]!
          g += src.data[o + 1]!
          b += src.data[o + 2]!
          a += src.data[o + 3]!
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const o = (y * width + x) * 4
      data[o] = r / n
      data[o + 1] = g / n
      data[o + 2] = b / n
      data[o + 3] = a / n
    }
  }
  return { width, height, data }
}

function keep(sheet: Rgba, analysis: ReferenceAnalysis, brief: string, attempts: ReferenceAttempt[], costs: CostLine[]): ReferenceSheet {
  return { png: encodePng(sheet.data, sheet.width, sheet.height), analysis, outlines: analysis.ok, brief, attempts, costs }
}

const attemptOf = (sheet: Rgba, a: ReferenceAnalysis): ReferenceAttempt => ({ ok: a.ok, reasons: a.reasons.map(r => r.detail), width: sheet.width, height: sheet.height })

export interface MakeReferenceOptions {
  commission: string
  // Gateway id of the sculptor model, which writes the brief.
  sculptor: string
  signal?: AbortSignal
  log?: (line: string) => void
}

export async function makeReference(opts: MakeReferenceOptions): Promise<ReferenceSheet> {
  const costs: CostLine[] = []
  const attempts: ReferenceAttempt[] = []
  const meter = newMeter()
  const within = (ms: number) => opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)

  let brief = ''
  try {
    const r = await generateText({ ...referenceBriefCall(opts.sculptor, opts.commission), maxRetries: 1, abortSignal: within(BRIEF_TIMEOUT_MS) })
    const usage = usageOf(r.usage)
    costs.push({ what: 'reference_brief', model: opts.sculptor, usage, usd: settleCost(opts.sculptor, usage, r.providerMetadata, meter, opts.log) })
    brief = r.text.trim()
  } catch (err) {
    return { png: null, analysis: null, outlines: false, brief, attempts, costs, error: `the brief failed: ${(err as Error).message.slice(0, 300)}` }
  }
  if (!brief) return { png: null, analysis: null, outlines: false, brief, attempts, costs, error: 'the sculptor wrote an empty brief' }

  const model = MODELS[IMAGE_MODEL]
  let last: { sheet: Rgba, analysis: ReferenceAnalysis } | null = null
  let error: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await generateText({ ...referenceImageCall(brief), maxRetries: 1, abortSignal: within(IMAGE_TIMEOUT_MS) })
      const file = r.files.find(f => f.mediaType?.startsWith('image/'))
      const usage = usageOf(r.usage)
      costs.push({ what: 'reference_image', model, usage, usd: settleCost(model, usage, r.providerMetadata, meter, opts.log, file ? 1 : 0) })
      if (!file) {
        error = 'the image model returned no image'
        continue
      }
      const sheet = shrink(decodeImage(file.uint8Array), MAX_SIDE)
      const analysis = analyzeReference(sheet)
      attempts.push(attemptOf(sheet, analysis))
      last = { sheet, analysis }
      if (analysis.ok) break
      opts.log?.(`reference attempt ${attempt + 1} could not be traced: ${analysis.reasons.map(x => x.detail).join('; ')}`)
    } catch (err) {
      error = `the image call failed: ${(err as Error).message.slice(0, 300)}`
      if (opts.signal?.aborted) break
    }
  }
  if (!last) return { png: null, analysis: null, outlines: false, brief, attempts, costs, error: error ?? 'no reference sheet' }
  return keep(last.sheet, last.analysis, brief, attempts, costs)
}

// --dry: the scripted figure drawn by code, priced as one brief and one image would be.
export function dryReference(subject: SubjectId): ReferenceSheet {
  const sheet = scriptedSheet(subject)
  const analysis = analyzeReference(sheet)
  const costs: CostLine[] = [
    { what: 'reference_brief', model: 'dry', usage: { input: 400, output: 200 }, usd: 0.01 },
    { what: 'reference_image', model: 'dry', usage: { input: 500, output: 0 }, usd: 0.034 }
  ]
  return keep(sheet, analysis, `A scripted ${subject} drawn by code for a dry run.`, [attemptOf(sheet, analysis)], costs)
}

// A sheet saved by an earlier run, for --resume: analysed again, nothing regenerated.
export function loadReference(png: Uint8Array, brief: string): ReferenceSheet {
  const sheet = decodePng(png)
  const analysis = analyzeReference(sheet)
  return { png, analysis, outlines: analysis.ok, brief, attempts: [attemptOf(sheet, analysis)], costs: [] }
}
