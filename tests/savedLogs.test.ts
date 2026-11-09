/**
 * The saved-log guarantee. Every finished run under .data/study/ was carved by some kernel
 * version and recorded the hash of the stone it ended on. A log written by the kernel in
 * this checkout has to replay to exactly that hash, or the replay viewer shows a different
 * sculpture from the one that was made. A kernel change that fails here either needs undoing
 * or KERNEL_VERSION needs a bump (which retires the old logs, loudly).
 *
 * .data/ is not in the repository, so with no saved runs this is skipped. The logs replay in
 * worker threads, a few at a time: one after another they take a minute and a half.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { KERNEL_VERSION } from '../shared/sculpt/version.ts'

const STUDY = join(import.meta.dirname, '..', '.data', 'study')

interface Saved { id: string, dir: string, kernel: number, hash: string }

function savedRuns(): Saved[] {
  if (!existsSync(STUDY)) return []
  const out: Saved[] = []
  for (const id of readdirSync(STUDY).sort()) {
    const dir = join(STUDY, id)
    const file = join(dir, 'run.json')
    if (!existsSync(file) || !(existsSync(join(dir, 'strikes.json')) || existsSync(join(dir, 'strikes.json.gz')))) continue
    const run = JSON.parse(readFileSync(file, 'utf8')) as { status?: string, kernel?: number, final?: { hash?: string } | null }
    // A run still being carved has no final stone to compare with.
    if (run.status !== 'done' || !run.final?.hash || typeof run.kernel !== 'number') continue
    out.push({ id, dir, kernel: run.kernel, hash: run.final.hash })
  }
  return out
}

interface Replayed { hash?: string, kernel?: number, strikes?: number, error?: string }

function replay(dir: string): Promise<Replayed> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./savedLogWorker.ts', import.meta.url), { workerData: dir })
    worker.once('message', (message: Replayed) => resolve(message))
    worker.once('error', reject)
  })
}

const runs = savedRuns().filter(run => run.kernel === KERNEL_VERSION)

test(`every saved study log written by kernel ${KERNEL_VERSION} replays to the hash it recorded`, { skip: runs.length === 0 ? 'no saved runs under .data/study' : false }, async () => {
  const results = new Map<string, Replayed>()
  const queue = runs.slice()
  const lanes = Math.max(1, Math.min(8, availableParallelism() - 2, queue.length))
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (let run = queue.shift(); run; run = queue.shift()) results.set(run.id, await replay(run.dir))
  }))
  const wrong: string[] = []
  for (const run of runs) {
    const got = results.get(run.id)!
    if (got.error) wrong.push(`${run.id}: ${got.error}`)
    else if (got.hash !== run.hash) wrong.push(`${run.id}: replayed to ${got.hash}, recorded ${run.hash} (${got.strikes} entries)`)
  }
  assert.deepEqual(wrong, [], `${wrong.length} of ${runs.length} saved logs no longer replay to their stone`)
})
