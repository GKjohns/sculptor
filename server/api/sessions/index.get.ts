// Every saved session, newest first, for the picker.
import type { SessionSummary } from '#shared/agent/wire'

export default defineEventHandler((): SessionSummary[] => withSessions(store => store.list()))
