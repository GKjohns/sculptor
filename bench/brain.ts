// The gateway Brain: one model turn through the Vercel AI Gateway. The loop owns the deadline
// and the retry, so every call here is a single attempt that honours the loop's signal.
// AI_GATEWAY_API_KEY comes from the environment (node --env-file-if-exists=.env).

import { generateText } from 'ai'
import { costUsd, usageOf } from '../shared/agent/pricing.ts'
import { jsonLinesProtocol, sdkTools } from '../shared/agent/toolSchemas.ts'
import type { Brain, BrainTurn, Message, ReferenceMode, ToolCall, ToolSetId, Usage } from '../shared/agent/types.ts'

export type Reasoning = 'none' | 'minimal' | 'low' | 'medium' | 'high'
// native: the provider's own tool calls. jsonl: no tools are sent; the model ends its reply with
// one JSON array of calls, for a provider that mishandles the schemas. The loop must then run
// with toolResults: 'text'.
export type BrainMode = 'native' | 'jsonl'

export interface GatewayBrainOptions {
  // A gateway id, e.g. 'anthropic/claude-opus-5.5'.
  model: string
  toolSet: ToolSetId
  reference: ReferenceMode
  mode?: BrainMode
  reasoning?: Reasoning
  maxOutputTokens?: number
  log?: (line: string) => void
}

export interface BrainMeter {
  calls: number
  // By our own price table, and as the gateway reported it (0 where it reported nothing).
  pricedUsd: number
  reportedUsd: number
  reportedCalls: number
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

export function newMeter(): BrainMeter {
  return { calls: 0, pricedUsd: 0, reportedUsd: 0, reportedCalls: 0 }
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

export function gatewayBrain(opts: GatewayBrainOptions): Brain & { meter: BrainMeter } {
  const mode = opts.mode ?? 'native'
  const tools = sdkTools({ toolSet: opts.toolSet, reference: opts.reference })
  const protocol = mode === 'jsonl' ? `\n\n${jsonLinesProtocol({ toolSet: opts.toolSet, reference: opts.reference })}` : ''
  const meter = newMeter()
  const anthropic = opts.model.startsWith('anthropic/')
  let turns = 0

  return {
    meter,
    async turn(input, onText): Promise<BrainTurn> {
      const turn = ++turns
      const r = await generateText({
        model: opts.model,
        instructions: input.instructions + protocol,
        messages: input.messages,
        ...(mode === 'native' ? { tools } : {}),
        maxOutputTokens: opts.maxOutputTokens ?? 12_000,
        maxRetries: 0,
        abortSignal: input.signal,
        reasoning: opts.reasoning ?? 'medium',
        // Anthropic first: the gateway's other routes for these models add prompt tokens in
        // tool mode and do not all honour the cache markers.
        providerOptions: { gateway: { caching: 'auto', ...(anthropic ? { order: ['anthropic'] } : {}) } }
      })
      if (r.text) onText(r.text)
      const usage = usageOf(r.usage)
      // From the second turn on nearly all the input should come from the cache. If none does,
      // every turn is paying full price for the whole history and the run will hit its cap early.
      if (turn > 1 && turn % 5 === 2 && usage.input > 4000 && !usage.cacheRead) {
        opts.log?.(`warning: turn ${turn} read nothing from the prompt cache (${usage.input} input tokens at full price); check gateway caching for ${opts.model}`)
      }
      const calls: ToolCall[] = mode === 'native'
        ? r.toolCalls.map(c => ({ id: c.toolCallId, name: c.toolName, args: c.input }))
        : parseJsonLines(r.text).map((c, i) => ({ id: `jl-${turn}-${i + 1}`, name: c.tool, args: c.args }))
      // Verbatim: providers want their own reasoning blocks back exactly as they sent them.
      let append = r.responseMessages as Message[]
      if (!append.some(m => m.role === 'assistant')) append = [{ role: 'assistant', content: r.text || '(no reply)' }]
      return { calls, append, usage, costUsd: settleCost(opts.model, usage, r.providerMetadata, meter, opts.log) }
    }
  }
}
