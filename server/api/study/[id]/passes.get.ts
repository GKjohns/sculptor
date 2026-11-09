// One run's pass record: every pass with its tool, its `why` and how many log entries it became.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export default defineEventHandler((event) => {
  const file = join(studyRunDir(getRouterParam(event, 'id')), 'passes.json')
  if (!existsSync(file)) throw createError({ statusCode: 404, message: 'this run has no pass record' })
  setResponseHeader(event, 'content-type', 'application/json')
  return readFileSync(file, 'utf8')
})
