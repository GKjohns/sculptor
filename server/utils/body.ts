/**
 * A JSON body read under a byte limit. h3's readBody has none, and a context full of looks
 * runs to megabytes, so each route states what it will take (the limits and the arithmetic
 * behind them are in shared/agent/wire.ts).
 */
type Event = Parameters<typeof readRawBody>[0]

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024 * 10) / 10} MB`

export async function readJsonBody(event: Event, limit: number): Promise<unknown> {
  const tooLarge = (size: number) => createError({ statusCode: 413, statusMessage: 'Payload Too Large', message: `the request is ${mb(size)}; the limit is ${mb(limit)}` })
  const declared = Number(getRequestHeader(event, 'content-length'))
  if (declared > limit) throw tooLarge(declared)

  const req = event.node.req
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) {
      // Let the rest drain unread so the 413 can still be delivered.
      req.resume()
      throw tooLarge(size)
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: 'the body is not JSON' })
  }
}
