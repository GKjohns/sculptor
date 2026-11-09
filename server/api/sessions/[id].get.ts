// One session: settings, status, costs, and the loop's state (pass record included) to resume
// from. The strike log is its own request (/strikes); it runs to megabytes.
import type { SessionFile } from '#shared/agent/wire'

export default defineEventHandler((event): SessionFile => withSessions(store => store.get(getRouterParam(event, 'id') ?? '')))
