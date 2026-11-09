// One stateless model turn: POST BrainRequest → NDJSON BrainEvents (shared/agent/wire.ts).
//   {"t":"start","model":"anthropic/claude-opus-5.5"}
//   {"t":"text","delta":"..."}  {"t":"reasoning","delta":"..."}  {"t":"call","call":{id,name,args}}
//   {"t":"done","calls":[...],"append":[...],"usage":{...},"costUsd":0.04,...}   or   {"t":"error","code":"...","message":"..."}
// The last line is always `done` or `error`, including when the request is refused outright
// (then it is the only line and the status says why: 400, 413, 503). Tool schemas go to the
// model without execute functions: the browser's loop runs every call against the stone.
// Closing the request aborts the model call.
import { BRAIN_BODY_LIMIT, encodeEvent } from '#shared/agent/wire'
import type { Message } from '#shared/agent/types'
import type { BrainErrorCode, BrainRequest } from '#shared/agent/wire'
import { parseBrainRequest } from '#shared/agent/wireSchemas'

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
  const refuse = (status: number, code: BrainErrorCode, message: string) => {
    setResponseStatus(event, status)
    return encodeEvent({ t: 'error', code, message, status, retryable: false })
  }

  let raw: unknown
  try {
    raw = await readJsonBody(event, BRAIN_BODY_LIMIT)
  } catch (err) {
    const e = err as { statusCode?: number, message?: string }
    return refuse(e.statusCode ?? 400, e.statusCode === 413 ? 'too_large' : 'bad_request', e.message ?? 'the body could not be read')
  }
  const parsed = parseBrainRequest(raw)
  if (!parsed.ok) return refuse(400, 'bad_request', parsed.error)
  if (!hasGatewayKey(event)) return refuse(503, 'no_key', NO_KEY_MESSAGE)
  // The messages go on as they were sent, not as the validator copied them: a provider's
  // reasoning block has to come back to it unchanged.
  const body: BrainRequest = { ...parsed.value, messages: (raw as { messages: Message[] }).messages }

  const ctrl = new AbortController()
  // The response closing before it was finished is the client going away (a stop, or the
  // loop's deadline). The request's own close event fires as soon as the body has been read.
  event.node.res.on('close', () => {
    if (!event.node.res.writableFinished) ctrl.abort(new Error('client closed'))
  })

  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const ev of streamBrainTurn(body, ctrl.signal)) {
        if (ev.t === 'done') console.info(`[brain] ${body.model} turn ${body.turn ?? '?'}: ${ev.calls.length} calls, ${ev.ms} ms, $${ev.costUsd.toFixed(4)} (in ${ev.usage.input}, cache read ${ev.usage.cacheRead ?? 0}, out ${ev.usage.output})`)
        if (ev.t === 'error' && ev.code === 'aborted') console.info(`[brain] ${body.model} turn ${body.turn ?? '?'} cancelled by the client`)
        else if (ev.t === 'error') console.warn(`[brain] ${body.model} turn ${body.turn ?? '?'} failed: ${ev.code} ${ev.status ?? ''} ${ev.message}`)
        if (ctrl.signal.aborted) break
        try {
          controller.enqueue(enc.encode(encodeEvent(ev)))
        } catch {
          break // the client went away
        }
      }
      try {
        controller.close()
      } catch {
        // already closed
      }
    },
    cancel() {
      ctrl.abort(new Error('client cancelled'))
    }
  })
})
