// Model map and price table. Copied from picnic-panic/shared/utils/pricing.ts (gateway
// /v1/models, base tier, checked 2026-10-11), plus the image model from Voice World's table.

import type { Usage } from './types.ts'

export const MODELS = {
  opus: 'anthropic/claude-opus-5.5',
  fable: 'anthropic/claude-fable-5.1',
  fable52: 'anthropic/claude-fable-5.2',
  sol: 'openai/gpt-6-sol',
  gemini: 'google/gemini-3.1-pro-preview',
  sonnet: 'anthropic/claude-sonnet-5.5',
  haiku: 'anthropic/claude-haiku-5.5',
  image: 'google/gemini-3.1-flash-lite-image'
} as const

export type ModelKey = keyof typeof MODELS

export const DEFAULT_SCULPTOR: ModelKey = 'opus'
// The sculptors a person can choose between, in the order the picker lists them.
export const SCULPTORS = ['opus', 'sol', 'fable52', 'fable', 'gemini'] as const satisfies readonly ModelKey[]
export type SculptorKey = typeof SCULPTORS[number]
// Every model that can take a turn through /api/brain: all of them but the image model.
export const TEXT_MODELS = ['opus', 'fable', 'fable52', 'sol', 'gemini', 'sonnet', 'haiku'] as const satisfies readonly ModelKey[]
export type TextModelKey = typeof TEXT_MODELS[number]

export const MODEL_LABELS: Record<ModelKey, string> = {
  opus: 'Opus 5.5',
  fable: 'Fable 5.1',
  fable52: 'Fable 5.2',
  sol: 'GPT-6 Sol',
  gemini: 'Gemini 3.1 Pro',
  sonnet: 'Sonnet 5.5',
  haiku: 'Haiku 5.5',
  image: 'Gemini 3.1 Flash Lite Image'
}
// Not one of the sculptors in the study, so no model judges its own work.
export const JUDGE_MODEL: ModelKey = 'sonnet'
export const IMAGE_MODEL: ModelKey = 'image'

export interface Price {
  // USD per 1M tokens.
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  // USD per generated image, on top of its tokens.
  perImage?: number
}

export const PRICING: Record<string, Price> = {
  'anthropic/claude-opus-5.5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'anthropic/claude-fable-5.1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  // Gateway /v1/models, checked 2026-11-09.
  'anthropic/claude-fable-5.2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  'openai/gpt-6-sol': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'google/gemini-3.1-pro-preview': { input: 2, output: 12, cacheRead: 0.2 },
  'anthropic/claude-sonnet-5.5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'anthropic/claude-haiku-5.5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'google/gemini-3.1-flash-lite-image': { input: 0.1, output: 0.4, perImage: 0.034 }
}

// A short key or a full gateway id. Anything without a price throws.
export function resolveModel(name: string): string {
  const id = (MODELS as Record<string, string>)[name] ?? name
  priceOf(id)
  return id
}

export function shortModel(id: string): string {
  const found = Object.entries(MODELS).find(([, v]) => v === id)
  return found ? found[0] : id.split('/').pop() ?? id
}

// An unpriced model would cost $0 and walk straight through the spend cap, so it is an error.
function priceOf(model: string): Price {
  const p = Object.hasOwn(PRICING, model) ? PRICING[model] : undefined
  if (!p) throw new Error(`no price for model "${model}": add it to shared/agent/pricing.ts before using it`)
  return p
}

// `model` is a short key or a gateway id. `images` is the number of images generated.
export function costUsd(model: string, usage: Usage, images = 0): number {
  const p = priceOf((MODELS as Record<string, string>)[model] ?? model)
  const read = usage.cacheRead ?? 0
  const write = usage.cacheWrite ?? 0
  const plain = Math.max(0, usage.input - read - write)
  // Reasoning is billed as output and should already be inside `output`. If a provider reports
  // more reasoning than output it has reported them apart, and both are charged.
  const reasoning = usage.reasoning ?? 0
  const output = reasoning > usage.output ? usage.output + reasoning : usage.output
  const tokens = plain * p.input + read * (p.cacheRead ?? p.input) + write * (p.cacheWrite ?? p.input) + output * p.output
  return tokens / 1_000_000 + images * (p.perImage ?? 0)
}

// The AI SDK's usage object (generateText / streamText `usage`) as ours.
export function usageOf(u: {
  inputTokens?: number
  outputTokens?: number
  inputTokenDetails?: { cacheReadTokens?: number, cacheWriteTokens?: number }
  outputTokenDetails?: { reasoningTokens?: number }
} | undefined): Usage {
  return {
    input: u?.inputTokens ?? 0,
    output: u?.outputTokens ?? 0,
    cacheRead: u?.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWrite: u?.inputTokenDetails?.cacheWriteTokens ?? 0,
    reasoning: u?.outputTokenDetails?.reasoningTokens ?? 0
  }
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0)
  }
}
