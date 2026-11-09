/**
 * Reads the headless study's run folders (.data/study/<run-id>/, written by bench/sculpt.ts) for the
 * replay routes. Local files under the project root: on a deploy the folder is not there and the
 * list is empty.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { ReplayRun } from '#shared/agent/replay'

const STUDY_DIR = resolve('.data/study')

function strikesFile(dir: string): string | null {
  for (const name of ['strikes.json.gz', 'strikes.json']) {
    if (existsSync(join(dir, name))) return join(dir, name)
  }
  return null
}

/** The folders under .data/study by name. */
export function studyRunIds(): string[] {
  if (!existsSync(STUDY_DIR)) return []
  return readdirSync(STUDY_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
}

/** The folder of run `id`. The id is matched against the directory listing, never joined into a path as given. */
export function studyRunDir(id: string | undefined): string {
  const known = studyRunIds().find(name => name === id)
  if (!known) throw createError({ statusCode: 404, message: 'no such study run' })
  return join(STUDY_DIR, known)
}

/** One run as the replay list shows it, or null if it is not a finished run (still carving, cut short, not a run folder). */
export function studyRun(id: string): ReplayRun | null {
  const dir = join(STUDY_DIR, id)
  try {
    const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
    if (run.status !== 'done' || !run.result || !run.final?.hash) return null
    if (!strikesFile(dir) || !existsSync(join(dir, 'passes.json'))) return null
    return {
      id,
      round: String(run.config.round ?? ''),
      subject: String(run.config.subject),
      model: String(run.config.model),
      tools: String(run.config.tools),
      ref: run.config.ref === true,
      turns: Number(run.result.turns),
      costUsd: Number(run.cost?.totalUsd ?? 0),
      strikes: Number(run.result.strikes),
      passes: Number(run.result.passes),
      ended: String(run.result.endReason ?? run.result.ended),
      title: run.result.finish?.title ?? null,
      statement: run.result.finish?.statement ?? null,
      judge: run.judge ? { pick: String(run.judge.pick), correct: run.judge.correct === true } : null,
      kernel: Number(run.kernel),
      hash: String(run.final.hash),
      finishedAt: String(run.finishedAt ?? run.startedAt ?? '')
    }
  } catch {
    // No run.json yet, or one that does not parse: not a finished run.
    return null
  }
}

/** The strike log as the JSON text bench/sculpt.ts wrote (it gzips the big ones). */
export function studyStrikeLogText(dir: string): string {
  const file = strikesFile(dir)
  if (!file) throw createError({ statusCode: 404, message: 'this run has no strike log' })
  const bytes = readFileSync(file)
  return file.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8')
}
