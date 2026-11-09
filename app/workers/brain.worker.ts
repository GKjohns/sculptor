/**
 * The sculptor's turns, off the main thread. A turn's request is the whole conversation, looks
 * included: by the twentieth turn that is some 14 MB of JSON, and writing it out and posting it
 * from the page costs a frame of 150 ms or more. Here it costs the page one structured clone
 * (a few milliseconds). The reply is read as it streams and passed back event by event.
 *
 * No Nuxt auto-imports in here: a worker is bundled on its own, so everything is imported by name.
 */
import { readBrainEvents } from '#shared/agent/wire'
import type { BrainEvent, BrainRequest } from '#shared/agent/wire'

export type ToBrain
  = | { type: 'turn', id: number, body: BrainRequest }
  // Closes the request, and with it the model call.
    | { type: 'abort', id: number }

// Every turn ends with a `done` or `error` event, or with `failed` if the request itself broke
// (the network dropped, or it was aborted).
export type FromBrain
  = | { id: number, event: BrainEvent }
    | { id: number, failed: string, aborted: boolean }

const flights = new Map<number, AbortController>()

function send(message: FromBrain) {
  postMessage(message)
}

async function turn(id: number, body: BrainRequest) {
  const ctl = new AbortController()
  flights.set(id, ctl)
  try {
    const res = await fetch('/api/brain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal
    })
    for await (const event of readBrainEvents(res)) send({ id, event })
  } catch (e) {
    send({ id, failed: e instanceof Error ? e.message : String(e), aborted: ctl.signal.aborted })
  } finally {
    flights.delete(id)
  }
}

addEventListener('message', (event: MessageEvent<ToBrain>) => {
  const msg = event.data
  if (msg.type === 'abort') flights.get(msg.id)?.abort()
  else void turn(msg.id, msg.body)
})
