// The hidden reference sheet for a commission: POST ReferenceRequest → ReferenceResponse.
// The sculptor model writes the brief and the image model draws it once; tracing the outlines
// and deciding whether to ask again (with `retry`) is the browser's job, where the kernel is.
import { REFERENCE_BODY_LIMIT } from '#shared/agent/wire'
import type { ReferenceResponse } from '#shared/agent/wire'
import { parseReferenceRequest } from '#shared/agent/wireSchemas'

export default defineEventHandler(async (event): Promise<ReferenceResponse> => {
  const body = parsedOr400(parseReferenceRequest(await readJsonBody(event, REFERENCE_BODY_LIMIT)))
  requireGatewayKey(event)
  const ctrl = new AbortController()
  // The response closing before it was finished means nobody is waiting for the sheet.
  event.node.res.on('close', () => {
    if (!event.node.res.writableFinished) ctrl.abort(new Error('client closed'))
  })
  const sheet = await makeReferenceSheet(body, ctrl.signal)
  console.info(`[reference] ${body.model}${body.retry ? ' retry' : ''} $${sheet.costUsd.toFixed(4)} ${sheet.error ?? `${sheet.width}×${sheet.height} ${sheet.mediaType}`}`)
  return sheet
})
