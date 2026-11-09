// The session's pass record: PassRecord[], the same shape as a study run's.
import type { PassRecord } from '#shared/agent/types'

export default defineEventHandler((event): PassRecord[] => withSessions(store => store.passes(getRouterParam(event, 'id') ?? '')))
