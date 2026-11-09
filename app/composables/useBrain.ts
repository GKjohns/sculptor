/**
 * The browser's Brain: one model turn is one POST to /api/brain, read back as it streams.
 * The server holds the key and builds the tool schemas; this side sends the context and hands
 * the loop its calls. The request is made by a worker (~/workers/brain.worker.ts), because the
 * context runs to megabytes and posting it from the page drops frames. A single attempt per turn:
 * the loop owns the deadline and the retry, and aborts through `signal`, which closes the request
 * and with it the model call.
 */
import type { TextModelKey } from '#shared/agent/pricing'
import type { Block, Brain, BrainTurn, ReferenceMode, RunConfig, ToolSetId } from '#shared/agent/types'
import type { BrainDone, BrainRequest } from '#shared/agent/wire'
import type { FromBrain, ToBrain } from '~/workers/brain.worker'

export interface BrainOptions {
  model: TextModelKey
  toolSet: ToolSetId
  reference: ReferenceMode
  block: Block
  stone: string
  toolResults: RunConfig['toolResults']
  /** The provider's reasoning summary as it streams, where it gives one. For show only. */
  onReasoning?: (delta: string) => void
  /** Every finished turn as the server settled it. */
  onDone?: (done: BrainDone) => void
}

/** What the server said the turns cost, added up apart from the loop's own count. */
export interface BrainSpend {
  turns: number
  usd: number
  /** Turns that failed or were cut off: the provider may have billed them, nothing reported them. */
  unmetered: number
  /** The longest the page was held up handing one request to the worker, ms. */
  slowestBodyMs: number
}

interface Flight {
  onText: (delta: string) => void
  resolve: (turn: BrainTurn) => void
  reject: (error: Error) => void
}

export function useBrain(options: BrainOptions): Brain & { spend: BrainSpend, dispose: () => void } {
  const spend: BrainSpend = { turns: 0, usd: 0, unmetered: 0, slowestBodyMs: 0 }
  const flights = new Map<number, Flight>()
  let worker: Worker | null = null
  let turn = 0

  function receive(msg: FromBrain) {
    const flight = flights.get(msg.id)
    if (!flight) return
    if ('failed' in msg) {
      flights.delete(msg.id)
      flight.reject(Object.assign(new Error(msg.failed), { name: msg.aborted ? 'AbortError' : 'Error' }))
      return
    }
    const event = msg.event
    if (event.t === 'text') {
      flight.onText(event.delta)
    } else if (event.t === 'reasoning') {
      options.onReasoning?.(event.delta)
    } else if (event.t === 'done') {
      flights.delete(msg.id)
      spend.turns++
      spend.usd += event.costUsd
      options.onDone?.(event)
      flight.resolve({ calls: event.calls, append: event.append, usage: event.usage, costUsd: event.costUsd })
    } else if (event.t === 'error') {
      flights.delete(msg.id)
      flight.reject(Object.assign(new Error(event.message), { code: event.code, retryable: event.retryable }))
    }
  }

  function post(message: ToBrain) {
    if (!worker) {
      worker = new Worker(new URL('../workers/brain.worker.ts', import.meta.url), { type: 'module' })
      worker.addEventListener('message', (e: MessageEvent<FromBrain>) => receive(e.data))
      worker.addEventListener('error', (e) => {
        for (const flight of flights.values()) flight.reject(new Error(e.message || 'the brain worker failed'))
        flights.clear()
      })
    }
    worker.postMessage(message)
  }

  return {
    spend,
    turn(input, onText) {
      const id = ++turn
      const body: BrainRequest = {
        model: options.model,
        instructions: input.instructions,
        messages: input.messages,
        toolSet: options.toolSet,
        reference: options.reference,
        block: options.block,
        stone: options.stone,
        toolResults: options.toolResults,
        turn: id
      }
      return new Promise<BrainTurn>((resolve, reject) => {
        if (input.signal?.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          return
        }
        const abort = () => post({ type: 'abort', id })
        input.signal?.addEventListener('abort', abort, { once: true })
        const settle = () => input.signal?.removeEventListener('abort', abort)
        flights.set(id, {
          onText,
          resolve: (reply) => {
            settle()
            resolve(reply)
          },
          reject: (error) => {
            settle()
            spend.unmetered++
            reject(error)
          }
        })
        const t0 = performance.now()
        post({ type: 'turn', id, body })
        spend.slowestBodyMs = Math.max(spend.slowestBodyMs, performance.now() - t0)
      })
    },
    dispose() {
      worker?.terminate()
      worker = null
      for (const flight of flights.values()) flight.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      flights.clear()
    }
  }
}
