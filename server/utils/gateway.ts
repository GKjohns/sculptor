/**
 * The server's end of the Vercel AI Gateway: the one place that holds the key. Two jobs, both
 * stateless: one sculptor turn streamed back as events (POST /api/brain), and the hidden
 * reference sheet (POST /api/reference). What is sent and how it is priced comes from
 * shared/agent/brainRequest.ts, the same code the bench calls, so the two cannot drift.
 */
import { generateText, streamText } from 'ai'
import { brainCall, cacheWarning, newMeter, referenceBriefCall, referenceImageCall, settleCost, turnOutcome } from '#shared/agent/brainRequest'
import { MODELS, addUsage, usageOf } from '#shared/agent/pricing'
import type { ToolOptions } from '#shared/agent/toolSchemas'
import type { Usage } from '#shared/agent/types'
import type { BrainError, BrainEvent, BrainRequest, ReferenceCost, ReferenceRequest, ReferenceResponse } from '#shared/agent/wire'
import { toSheetPng } from './sheetPng.ts'

type Event = Parameters<typeof useRuntimeConfig>[0]

export const NO_KEY_MESSAGE = 'No gateway key. Put AI_GATEWAY_API_KEY in .env and restart the server.'

// The loop gives a turn 90 s and then asks again; this only stops a call nobody is waiting for.
const BRAIN_HARD_LIMIT_MS = 240_000
const BRIEF_TIMEOUT_MS = 90_000
const IMAGE_TIMEOUT_MS = 120_000

/** Whether there is a key, moving it from runtime config into the env, where the AI SDK reads it. */
export function hasGatewayKey(event?: Event): boolean {
  const config = useRuntimeConfig(event)
  if (!process.env.AI_GATEWAY_API_KEY && config.aiGatewayApiKey) process.env.AI_GATEWAY_API_KEY = config.aiGatewayApiKey
  return !!process.env.AI_GATEWAY_API_KEY
}

/** For the JSON routes. /api/brain answers with an error event instead. */
export function requireGatewayKey(event: Event): void {
  if (!hasGatewayKey(event)) throw createError({ statusCode: 503, statusMessage: 'No gateway key', message: NO_KEY_MESSAGE, data: { code: 'no_key' } })
}

// What the tool schemas are built from. If ToolOptions grows, this is the one place the body
// is mapped onto it; tool names are never spelled out on the server.
function toolOptionsOf(body: BrainRequest): ToolOptions {
  return { toolSet: body.toolSet, reference: body.reference }
}

const reasonOf = (signal: AbortSignal) => signal.reason instanceof Error ? signal.reason : new Error('aborted')

/** Any failure of an upstream call as the event the client is shown. */
export function gatewayError(err: unknown, signal?: AbortSignal): BrainError {
  if (signal?.aborted) {
    const timeout = reasonOf(signal).name === 'TimeoutError'
    return { t: 'error', code: timeout ? 'timeout' : 'aborted', message: timeout ? 'the model took too long to answer' : 'the turn was cancelled', retryable: timeout }
  }
  const e = err as { message?: string, statusCode?: number, isRetryable?: boolean, name?: string } | undefined
  const status = typeof e?.statusCode === 'number' ? e.statusCode : undefined
  const message = (e?.message ?? String(err)).replace(/\s+/g, ' ').slice(0, 300)
  if (status === 401 || e?.name === 'GatewayAuthenticationError') {
    return { t: 'error', code: 'no_key', message: 'The gateway refused the key. Check AI_GATEWAY_API_KEY in .env.', status: status ?? 401, retryable: false }
  }
  if (e?.name === 'AI_InvalidPromptError' || e?.name === 'AI_TypeValidationError') {
    return { t: 'error', code: 'bad_request', message, retryable: false }
  }
  const retryable = typeof e?.isRetryable === 'boolean' ? e.isRetryable : status === undefined || status >= 500 || status === 429 || status === 408
  return { t: 'error', code: 'upstream', message, ...(status ? { status } : {}), retryable }
}

/**
 * One model turn. Yields `start`, then text, reasoning and call events as the model produces
 * them, then exactly one `done` or `error`. Never throws. A single attempt: the loop in the
 * browser owns the deadline and the retry.
 */
export async function* streamBrainTurn(body: BrainRequest, outer: AbortSignal): AsyncGenerator<BrainEvent> {
  const started = Date.now()
  const model = MODELS[body.model]
  const mode = body.toolResults === 'text' ? 'jsonl' : 'native'
  const signal = AbortSignal.any([outer, AbortSignal.timeout(BRAIN_HARD_LIMIT_MS)])
  yield { t: 'start', model }
  try {
    const settings = brainCall({ model, tools: toolOptionsOf(body), mode })({ instructions: body.instructions, messages: body.messages, signal })
    let failure: { error: unknown } | null = null
    const r = streamText({
      ...settings,
      onError: ({ error }) => {
        failure ??= { error }
      }
    })
    for await (const part of r.stream) {
      if (part.type === 'text-delta') {
        if (part.text) yield { t: 'text', delta: part.text }
      } else if (part.type === 'reasoning-delta') {
        if (part.text) yield { t: 'reasoning', delta: part.text }
      } else if (part.type === 'tool-call') {
        if (mode === 'native') yield { t: 'call', call: { id: part.toolCallId, name: part.toolName, args: part.input } }
      } else if (part.type === 'error') {
        failure ??= { error: part.error }
      }
    }
    if (failure) throw (failure as { error: unknown }).error
    signal.throwIfAborted()

    const step = await r.finalStep
    const usage = usageOf(await r.usage)
    const { calls, append } = turnOutcome({ mode, turn: body.turn ?? 0, text: step.text, toolCalls: step.toolCalls, responseMessages: await r.responseMessages })
    // JSON-lines calls only exist once the whole reply can be read.
    if (mode === 'jsonl') for (const call of calls) yield { t: 'call', call }

    const meter = newMeter()
    const log = (line: string) => console.warn(`[brain] ${line}`)
    const costUsd = settleCost(model, usage, step.providerMetadata, meter, log)
    const warning = cacheWarning(body.turn ?? 0, usage, model)
    if (warning) log(warning)
    yield {
      t: 'done',
      calls,
      // JSON round trip: what the client gets is what it sends back, byte for byte.
      append: JSON.parse(JSON.stringify(append)),
      usage,
      costUsd,
      pricedUsd: meter.pricedUsd,
      reportedUsd: meter.reportedCalls ? meter.reportedUsd : null,
      finishReason: step.finishReason,
      ms: Date.now() - started
    }
  } catch (err) {
    yield gatewayError(err, signal)
  }
}

/**
 * The reference sheet for one commission: the sculptor model writes the brief, the image model
 * draws it once. Whether the sheet can be traced is for the client to decide (the kernel is
 * there); if it cannot, the client asks again with `retry` and the brief is rewritten plainer.
 * Once a call has been paid for, a failure comes back in `error` with the costs, not as a throw.
 */
export async function makeReferenceSheet(req: ReferenceRequest, outer: AbortSignal): Promise<ReferenceResponse> {
  const sculptor = MODELS[req.model]
  const costs: ReferenceCost[] = []
  const meter = newMeter()
  const log = (line: string) => console.warn(`[reference] ${line}`)
  const within = (ms: number) => AbortSignal.any([outer, AbortSignal.timeout(ms)])
  const answer = (rest: Pick<ReferenceResponse, 'pngBase64' | 'mediaType' | 'width' | 'height' | 'brief' | 'error'>): ReferenceResponse => ({
    ...rest,
    costUsd: costs.reduce((n, c) => n + c.usd, 0),
    usage: costs.reduce<Usage>((u, c) => addUsage(u, c.usage), { input: 0, output: 0 }),
    costs
  })
  const none = { pngBase64: null, mediaType: 'image/png', width: null, height: null }
  const why = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300)

  let brief = ''
  try {
    const r = await generateText({ ...referenceBriefCall(sculptor, req.commission, req.retry), maxRetries: 1, abortSignal: within(BRIEF_TIMEOUT_MS) })
    const usage = usageOf(r.usage)
    costs.push({ what: 'reference_brief', model: sculptor, usage, usd: settleCost(sculptor, usage, r.providerMetadata, meter, log) })
    brief = r.text.trim()
  } catch (err) {
    return answer({ ...none, brief, error: `the brief failed: ${why(err)}` })
  }
  if (!brief) return answer({ ...none, brief, error: 'the sculptor wrote an empty brief' })

  try {
    const call = referenceImageCall(brief)
    const r = await generateText({ ...call, maxRetries: 1, abortSignal: within(IMAGE_TIMEOUT_MS) })
    const file = r.files.find(f => f.mediaType?.startsWith('image/'))
    const usage = usageOf(r.usage)
    costs.push({ what: 'reference_image', model: call.model, usage, usd: settleCost(call.model, usage, r.providerMetadata, meter, log, file ? 1 : 0) })
    if (!file) return answer({ ...none, brief, error: 'the image model returned no image' })
    const sheet = await toSheetPng(file.uint8Array)
    return answer({ pngBase64: Buffer.from(sheet.bytes).toString('base64'), mediaType: sheet.mediaType, width: sheet.width, height: sheet.height, brief })
  } catch (err) {
    return answer({ ...none, brief, error: `the image call failed: ${why(err)}` })
  }
}
