/**
 * The session store for the routes: .data/sessions under the project root, stamped with this
 * build's kernel. Local files, like the study's runs; on a deploy without a disk the list is
 * empty and a save fails.
 */
import { resolve } from 'node:path'
import { MODELS } from '#shared/agent/pricing'
import { KERNEL_VERSION } from '#shared/sculpt/version'
import { SessionError, createSessionStore } from './sessionStore.ts'
import type { SessionStore } from './sessionStore.ts'

let store: SessionStore | undefined

/** Runs `run` against the store and turns its refusals (unknown id, a gap in a log, another kernel) into HTTP errors. */
export function withSessions<T>(run: (store: SessionStore) => T): T {
  store ??= createSessionStore(resolve('.data/sessions'), { kernel: KERNEL_VERSION, models: MODELS })
  try {
    return run(store)
  } catch (err) {
    if (err instanceof SessionError) throw createError({ statusCode: err.status, statusMessage: err.status === 404 ? 'Not Found' : 'Conflict', message: err.message, data: err.data })
    throw err
  }
}

/** A validated body, or a 400 that says which field was wrong. */
export function parsedOr400<T>(parsed: { ok: true, value: T } | { ok: false, error: string }): T {
  if (!parsed.ok) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: parsed.error })
  return parsed.value
}
