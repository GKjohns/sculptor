// The gateway Brain: one model turn through the Vercel AI Gateway. The loop owns the deadline
// and the retry, so every call here is a single attempt that honours the loop's signal.
// AI_GATEWAY_API_KEY comes from the environment (node --env-file-if-exists=.env).
// The request and the cost accounting are shared with POST /api/brain (shared/agent/brainRequest.ts).

import { generateText } from 'ai'
import { brainCall, cacheWarning, newMeter, settleCost, turnOutcome } from '../shared/agent/brainRequest.ts'
import type { BrainMeter, BrainMode, Reasoning } from '../shared/agent/brainRequest.ts'
import { usageOf } from '../shared/agent/pricing.ts'
import type { Brain, BrainTurn, ReferenceMode, ToolSetId } from '../shared/agent/types.ts'

export { newMeter, parseJsonLines, reportedCost, settleCost } from '../shared/agent/brainRequest.ts'
export type { BrainMeter, BrainMode, Reasoning } from '../shared/agent/brainRequest.ts'

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

export function gatewayBrain(opts: GatewayBrainOptions): Brain & { meter: BrainMeter } {
  const mode = opts.mode ?? 'native'
  const settings = brainCall({ model: opts.model, tools: { toolSet: opts.toolSet, reference: opts.reference }, mode, reasoning: opts.reasoning, maxOutputTokens: opts.maxOutputTokens })
  const meter = newMeter()
  let turns = 0

  return {
    meter,
    async turn(input, onText): Promise<BrainTurn> {
      const turn = ++turns
      const r = await generateText(settings(input))
      if (r.text) onText(r.text)
      const usage = usageOf(r.usage)
      const warning = cacheWarning(turn, usage, opts.model)
      if (warning) opts.log?.(warning)
      const { calls, append } = turnOutcome({ mode, turn, text: r.text, toolCalls: r.toolCalls, responseMessages: r.responseMessages })
      return { calls, append, usage, costUsd: settleCost(opts.model, usage, r.providerMetadata, meter, opts.log) }
    }
  }
}
