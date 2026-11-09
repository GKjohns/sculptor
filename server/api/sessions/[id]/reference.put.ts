// The reference sheet, saved once so a resume or a replay never draws it again:
// PUT SessionReferenceSave → SessionSaved.
import { SESSION_BODY_LIMIT } from '#shared/agent/wire'
import type { SessionSaved } from '#shared/agent/wire'
import { parseSessionReference } from '#shared/agent/wireSchemas'

export default defineEventHandler(async (event): Promise<SessionSaved> => {
  const id = getRouterParam(event, 'id') ?? ''
  const ref = parsedOr400(parseSessionReference(await readJsonBody(event, SESSION_BODY_LIMIT)))
  return withSessions(store => store.saveReference(id, ref))
})
