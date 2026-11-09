// Starts a session for a commission: POST SessionCreate → SessionFile (its id is the server's).
import { SESSION_BODY_LIMIT } from '#shared/agent/wire'
import type { SessionFile } from '#shared/agent/wire'
import { parseSessionCreate } from '#shared/agent/wireSchemas'

export default defineEventHandler(async (event): Promise<SessionFile> => {
  const body = parsedOr400(parseSessionCreate(await readJsonBody(event, SESSION_BODY_LIMIT)))
  return withSessions(store => store.create(body))
})
