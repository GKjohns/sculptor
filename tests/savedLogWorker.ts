/**
 * Replays one saved study run in a worker thread and posts back the hash of the stone it
 * ends on. Not a test file itself: tests/savedLogs.test.ts runs one of these per run.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { gunzipSync } from 'node:zlib'
import { createGrid, hashGrid } from '../shared/sculpt/grid.ts'
import { applyStrike } from '../shared/sculpt/strike.ts'
import type { Strike } from '../shared/sculpt/types.ts'

interface SavedLog { kernel: number, grid: { width: number, height: number, depth: number, voxel: number, chunk: number }, strikes: Strike[] }

const dir = workerData as string
try {
  const gz = join(dir, 'strikes.json.gz')
  const text = existsSync(gz) ? gunzipSync(readFileSync(gz)).toString('utf8') : readFileSync(join(dir, 'strikes.json'), 'utf8')
  const log = JSON.parse(text) as SavedLog
  const grid = createGrid(log.grid)
  for (const strike of log.strikes) applyStrike(grid, strike)
  parentPort!.postMessage({ hash: hashGrid(grid), kernel: log.kernel, strikes: log.strikes.length })
} catch (err) {
  parentPort!.postMessage({ error: (err as Error).message })
}
