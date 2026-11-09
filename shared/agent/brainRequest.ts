// How one sculptor turn is asked of the gateway, and how its bill is settled. The bench calls
// generateText with these settings and POST /api/brain calls streamText with the same ones, so
// the study and the live studio cannot drift apart. Nothing here makes a call: no key, no I/O.

import type { ToolSet } from 'ai'
import { IMAGE_MODEL, MODELS, costUsd } from './pricing.ts'
import { REFERENCE_BRIEF_INSTRUCTIONS, referenceBriefPrompt, referenceImagePrompt } from './reference.ts'
import { jsonLinesProtocol, sdkTools } from './toolSchemas.ts'
import type { ToolOptions } from './toolSchemas.ts'
import type { Message, ToolCall, Usage } from './types.ts'

export type Reasoning = 'none' | 'minimal' | 'low' | 'medium' | 'high'
// native: the provider's own tool calls. jsonl: no tools are sent; the model ends its reply with
// one JSON array of calls, for a provider that mishandles the schemas. The loop must then run
// with toolResults: 'text'.
export type BrainMode = 'native' | 'jsonl'

export const BRAIN_REASONING: Reasoning = 'medium'
export const BRAIN_MAX_OUTPUT_TOKENS = 12_000

export interface BrainCallOptions {
  // A gateway id, e.g. 'anthropic/claude-opus-5.5'.
  model: string
  tools: ToolOptions
  mode?: BrainMode
  reasoning?: Reasoning
  maxOutputTokens?: number
}

type GatewayOptions = { gateway: { caching?: 'auto', order?: string[] } }

// What generateText and streamText are given for one turn.
export interface BrainCallSettings {
  model: string
  instructions: string
  messages: Message[]
  tools?: ToolSet
  maxOutputTokens: number
  maxRetries: 0
  abortSignal?: AbortSignal
  reasoning: Reasoning
  providerOptions: GatewayOptions
}

// Anthropic first: the gateway's other routes for these models add prompt tokens in tool mode
// and do not all honour the cache markers.
function routing(model: string): { order?: string[] } {
  return model.startsWith('anthropic/') ? { order: ['anthropic'] } : {}
}

// The settings for every turn of one commission. The loop owns the deadline and the retry, so
// a call is a single attempt that honours the loop's signal.
export function brainCall(opts: BrainCallOptions): (input: { instructions: string, messages: Message[], signal?: AbortSignal }) => BrainCallSettings {
  const mode = opts.mode ?? 'native'
  const tools = sdkTools(opts.tools)
  const protocol = mode === 'jsonl' ? `\n\n${jsonLinesProtocol(opts.tools)}` : ''
  return input => ({
    model: opts.model,
    instructions: input.instructions + protocol,
    messages: input.messages,
    ...(mode === 'native' ? { tools } : {}),
    maxOutputTokens: opts.maxOutputTokens ?? BRAIN_MAX_OUTPUT_TOKENS,
    maxRetries: 0,
    abortSignal: input.signal,
    reasoning: opts.reasoning ?? BRAIN_REASONING,
    providerOptions: { gateway: { caching: 'auto', ...routing(opts.model) } }
  })
}

const isCall = (v: unknown): v is { tool: string, args?: unknown } => !!v && typeof v === 'object' && typeof (v as { tool?: unknown }).tool === 'string'

// The calls in a JSON-lines reply: the last JSON array of {"tool", "args"} objects in the text,
// or failing that every line that parses as one.
export function parseJsonLines(text: string): { tool: string, args: unknown }[] {
  const end = text.lastIndexOf(']')
  for (let start = text.indexOf('['); start >= 0 && start < end; start = text.indexOf('[', start + 1)) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isCall)) return parsed.map(c => ({ tool: c.tool, args: c.args ?? {} }))
    } catch {
      // not the array; try the next bracket
    }
  }
  const out: { tool: string, args: unknown }[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/,$/, '')
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (isCall(parsed)) out.push({ tool: parsed.tool, args: parsed.args ?? {} })
    } catch {
      // prose that happens to start with a brace
    }
  }
  return out
}

// What a finished turn hands the loop: its calls and the messages to append.
export function turnOutcome(reply: {
  mode: BrainMode
  // Makes the ids of JSON-lines calls, which have none of their own.
  turn: number
  text: string
  toolCalls: readonly { toolCallId: string, toolName: string, input: unknown }[]
  responseMessages: readonly unknown[]
}): { calls: ToolCall[], append: Message[] } {
  const calls: ToolCall[] = reply.mode === 'native'
    ? reply.toolCalls.map(c => ({ id: c.toolCallId, name: c.toolName, args: c.input }))
    : parseJsonLines(reply.text).map((c, i) => ({ id: `jl-${reply.turn}-${i + 1}`, name: c.tool, args: c.args }))
  // Verbatim: providers want their own reasoning blocks back exactly as they sent them.
  let append = reply.responseMessages as Message[]
  if (!append.some(m => m.role === 'assistant')) append = [{ role: 'assistant', content: reply.text || '(no reply)' }]
  return { calls, append }
}

// From the second turn on nearly all the input should come from the cache. If none does, every
// turn is paying full price for the whole history and the run will hit its cap early.
export function cacheWarning(turn: number, usage: Usage, model: string): string | null {
  if (turn > 1 && turn % 5 === 2 && usage.input > 4000 && !usage.cacheRead) {
    return `warning: turn ${turn} read nothing from the prompt cache (${usage.input} input tokens at full price); check gateway caching for ${model}`
  }
  return null
}

export interface BrainMeter {
  calls: number
  // By our own price table, and as the gateway reported it (0 where it reported nothing).
  pricedUsd: number
  reportedUsd: number
  reportedCalls: number
}

export function newMeter(): BrainMeter {
  return { calls: 0, pricedUsd: 0, reportedUsd: 0, reportedCalls: 0 }
}

// What the gateway says a call cost, when it says. It arrives as a number or a numeric string.
export function reportedCost(providerMetadata: unknown): number | null {
  const gw = (providerMetadata as { gateway?: Record<string, unknown> } | undefined)?.gateway
  if (!gw) return null
  for (const key of ['cost', 'totalCost', 'marketCost']) {
    const v = typeof gw[key] === 'string' ? Number(gw[key]) : gw[key]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  }
  return null
}

// The spend caps must hold against the real bill, so a call is charged at whichever is larger:
// our table's price or the gateway's own figure. Both are logged when they are 5% or more apart.
export function settleCost(model: string, usage: Usage, providerMetadata: unknown, meter: BrainMeter, log?: (line: string) => void, images = 0): number {
  const priced = costUsd(model, usage, images)
  const reported = reportedCost(providerMetadata)
  meter.calls++
  meter.pricedUsd += priced
  if (reported !== null) {
    meter.reportedUsd += reported
    meter.reportedCalls++
    if (Math.abs(reported - priced) > Math.max(0.002, 0.05 * Math.max(reported, priced))) {
      log?.(`cost check ${model}: price table $${priced.toFixed(4)}, gateway $${reported.toFixed(4)} (in ${usage.input}, cache read ${usage.cacheRead ?? 0}, cache write ${usage.cacheWrite ?? 0}, out ${usage.output})`)
    }
  }
  return Math.max(priced, reported ?? 0)
}

// ---------- the reference sheet's two calls ----------

// Why an earlier sheet could not be used, so the sculptor writes a plainer brief this time.
export interface ReferenceRetry {
  // The checks the sheet failed, as analyzeReference worded them.
  reasons: string[]
  // The brief that sheet was drawn from.
  brief?: string
}

export function referenceRetryNote(retry: ReferenceRetry): string {
  const reasons = retry.reasons.map(r => r.trim()).filter(Boolean).slice(0, 8)
  return [
    'A sheet has already been drawn for this commission and could not be used.',
    ...(retry.brief?.trim() ? [`The brief it was drawn from:\n${retry.brief.trim().slice(0, 1500)}`] : []),
    ...(reasons.length ? [`What was wrong with it:\n${reasons.map(r => `- ${r}`).join('\n')}`] : []),
    'Write a new brief for a simpler figure: one compact upright mass on a plain base, nothing separate from it or reaching the edges, with an outline that is easy to read from the front and from the side.'
  ].join('\n\n')
}

// The sculptor model writes the brief. `sculptor` is a gateway id.
export function referenceBriefCall(sculptor: string, commission: string, retry?: ReferenceRetry) {
  return {
    model: sculptor,
    instructions: REFERENCE_BRIEF_INSTRUCTIONS,
    prompt: retry ? `${referenceBriefPrompt(commission)}\n\n${referenceRetryNote(retry)}` : referenceBriefPrompt(commission),
    reasoning: 'low' as const,
    maxOutputTokens: 3000,
    providerOptions: { gateway: { ...routing(sculptor) } }
  }
}

// One image-model call draws the sheet from the brief.
export function referenceImageCall(brief: string) {
  return {
    model: MODELS[IMAGE_MODEL] as string,
    prompt: referenceImagePrompt(brief),
    providerOptions: { google: { responseModalities: ['IMAGE'] } }
  }
}
