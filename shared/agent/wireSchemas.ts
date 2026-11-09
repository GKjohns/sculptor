// Validation for the bodies in ./wire.ts. Server and tests only: the browser sends these
// shapes, it does not need zod to check them.

import { z } from 'zod'
import { TEXT_MODELS } from './pricing.ts'
import type { BrainRequest, ReferenceRequest, SessionCreate, SessionReferenceSave, SessionSave } from './wire.ts'

const model = z.enum(TEXT_MODELS, { error: issue => `unknown model ${JSON.stringify(issue.input)}; one of ${TEXT_MODELS.join(', ')}` })
const toolSet = z.enum(['direct', 'formed'])
const block = z.object({ width: z.number().positive(), height: z.number().positive(), depth: z.number().positive() })
const count = z.number().int().min(0)
const usage = z.object({ input: z.number(), output: z.number(), cacheRead: z.number().optional(), cacheWrite: z.number().optional(), reasoning: z.number().optional() })

// Checked for shape only and passed on as sent: stripping a field the schema does not know
// would break a provider's reasoning block, which must go back unchanged.
const message = z.looseObject({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))])
})

const brainRequest = z.object({
  model,
  instructions: z.string().min(1),
  messages: z.array(message).min(1),
  toolSet,
  reference: z.enum(['none', 'view', 'outlines']),
  block: block.optional(),
  stone: z.string().max(80).optional(),
  toolResults: z.enum(['native', 'text']),
  turn: count.optional()
})

const referenceRequest = z.object({
  commission: z.string().trim().min(1).max(2000),
  model,
  retry: z.object({
    reasons: z.array(z.string().max(400)).max(16),
    brief: z.string().max(4000).optional()
  }).optional()
})

const grid = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  depth: z.number().positive(),
  voxel: z.number().positive(),
  chunk: z.number().int().positive()
})

// Loose, like the state below: a field the loop gains later is saved rather than dropped.
const runConfig = z.looseObject({
  toolSet,
  block,
  stone: z.string().min(1).max(80),
  maxTurns: z.number().int().positive(),
  maxUsd: z.number().positive(),
  rebuildEvery: z.number().int().positive(),
  turnTimeoutMs: z.number().positive(),
  lookEvery: z.number().int().positive(),
  toolResults: z.enum(['native', 'text'])
})

const settings = z.record(z.string(), z.unknown())

const sessionCreate = z.object({
  commission: z.string().trim().min(1).max(2000),
  model,
  ref: z.boolean(),
  run: runConfig,
  grid,
  kernel: z.number().int(),
  settings: settings.optional()
})

const ENDS = ['finish', 'turn_cap', 'cost_cap', 'stalled', 'aborted', 'error'] as const
const finish = z.object({ title: z.string(), statement: z.string() })

const runState = z.looseObject({
  turns: count,
  // A pass keeps whatever the loop put in it; only what the server reads is checked.
  passes: z.array(z.looseObject({ n: z.number(), turn: z.number(), tool: z.string(), strikes: z.number() })),
  notebook: z.object({ stage: z.string().nullable(), text: z.string(), turn: z.number() }),
  usage,
  costUsd: z.number().min(0)
})

const sessionSave = z.object({
  strikes: z.object({ from: count, items: z.array(z.looseObject({ kind: z.string() })) }).optional(),
  events: z.object({ from: count, items: z.array(z.unknown()) }).optional(),
  state: runState.optional(),
  result: z.object({ ended: z.enum(ENDS), finish: finish.nullable(), error: z.string().optional() }).optional(),
  final: z.object({ hash: z.string().min(1), numbers: z.record(z.string(), z.number()).optional() }).optional(),
  settings: settings.optional()
})

const sessionReference = z.object({
  pngBase64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'not base64').nullable(),
  outlines: z.boolean(),
  brief: z.string().max(8000),
  costUsd: z.number().min(0),
  usage: usage.optional(),
  error: z.string().max(1000).optional()
})

export type Parsed<T> = { ok: true, value: T } | { ok: false, error: string }

function parser<T>(schema: z.ZodType): (body: unknown) => Parsed<T> {
  return (body) => {
    const r = schema.safeParse(body)
    if (r.success) return { ok: true, value: r.data as T }
    const issues = r.error.issues.slice(0, 4).map(i => `${i.path.length ? i.path.join('.') : 'body'}: ${i.message}`)
    return { ok: false, error: issues.join('; ') }
  }
}

export const parseBrainRequest = parser<BrainRequest>(brainRequest)
export const parseReferenceRequest = parser<ReferenceRequest>(referenceRequest)
export const parseSessionCreate = parser<SessionCreate>(sessionCreate)
export const parseSessionSave = parser<SessionSave>(sessionSave)
export const parseSessionReference = parser<SessionReferenceSave>(sessionReference)
