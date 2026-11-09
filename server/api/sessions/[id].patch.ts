// The save after every turn: PATCH SessionSave → SessionSaved. Strikes and events are appended
// from the sender's `from`, so sending a save twice changes nothing and a gap is a 409 whose
// data.have is the count to send from.
import { SESSION_BODY_LIMIT } from '#shared/agent/wire'
import type { SessionSaved } from '#shared/agent/wire'
import { parseSessionSave } from '#shared/agent/wireSchemas'

export default defineEventHandler(async (event): Promise<SessionSaved> => {
  const id = getRouterParam(event, 'id') ?? ''
  const patch = parsedOr400(parseSessionSave(await readJsonBody(event, SESSION_BODY_LIMIT)))
  return withSessions(store => store.save(id, patch))
})
