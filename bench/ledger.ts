// The study's spend ledger. Every run keeps its own file under <study>/ledger/, rewritten whole
// after each turn, and the study's total is the sum of those files read fresh each time, so
// runs in separate processes can never overwrite each other's spend. A run also reserves its
// cap while it is alive; a new run starts only if spend so far, plus what the live runs may
// still spend, plus its own cap fits under the study cap. ledger.json beside the folder is a
// readable summary written for people; nothing reads it back.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LedgerEntry {
  runId: string
  // Spent so far, USD.
  usd: number
  // The most this run may spend in all.
  capUsd: number
  state: 'running' | 'done'
  pid: number
  updatedAt: string
}

export interface LedgerTotals {
  spentUsd: number
  // What live runs may still spend: cap minus spent, for runs whose process is alive.
  reservedUsd: number
  runs: number
  live: number
}

export function writeAtomic(file: string, text: string | Uint8Array): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

function alive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export class Ledger {
  readonly dir: string
  readonly studyDir: string

  constructor(studyDir: string) {
    this.studyDir = studyDir
    this.dir = join(studyDir, 'ledger')
    mkdirSync(this.dir, { recursive: true })
  }

  entries(): LedgerEntry[] {
    const out: LedgerEntry[] = []
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as LedgerEntry)
      } catch {
        // Renames are atomic, so this is a file someone damaged by hand. Counting it as zero
        // would let the study overspend; stop instead.
        throw new Error(`ledger entry ${join(this.dir, name)} cannot be read; fix or remove it before running`)
      }
    }
    return out
  }

  totals(): LedgerTotals {
    let spentUsd = 0
    let reservedUsd = 0
    let live = 0
    const entries = this.entries()
    for (const e of entries) {
      spentUsd += e.usd
      if (e.state === 'running' && alive(e.pid)) {
        live++
        reservedUsd += Math.max(0, e.capUsd - e.usd)
      }
    }
    return { spentUsd, reservedUsd, runs: entries.length, live }
  }

  // mkdir is atomic, which makes it a lock two processes cannot both take. Held only for the
  // check-and-reserve at the start of a run.
  private locked<T>(run: () => T): T {
    const lock = join(this.dir, '.lock')
    for (let waited = 0; ; waited += 50) {
      try {
        mkdirSync(lock)
        break
      } catch {
        // A lock older than ten seconds belongs to a process that died holding it.
        const held = statSync(lock, { throwIfNoEntry: false })
        // Gone already: whoever held it has finished; try again at once.
        if (!held) continue
        if (Date.now() - held.mtimeMs > 10_000) rmSync(lock, { recursive: true, force: true })
        else if (waited > 15_000) throw new Error('the study ledger is locked; is another run stuck starting?')
        else sleep(50)
      }
    }
    try {
      return run()
    } finally {
      rmSync(lock, { recursive: true, force: true })
    }
  }

  // Reserves `capUsd` for a run, or says why it may not start.
  reserve(runId: string, capUsd: number, studyCapUsd: number, alreadySpentUsd = 0): { ok: true } | { ok: false, reason: string } {
    return this.locked(() => {
      const t = this.totals()
      const own = this.entries().find(e => e.runId === runId)
      // A resumed run's earlier spend is already in the total; only what it may add is new.
      const spentByOthers = t.spentUsd - (own?.usd ?? 0)
      const committed = spentByOthers + t.reservedUsd
      if (committed + capUsd > studyCapUsd + 1e-9) {
        return {
          ok: false as const,
          reason: `study cap $${studyCapUsd.toFixed(2)}: $${t.spentUsd.toFixed(2)} already spent across ${t.runs} runs, $${t.reservedUsd.toFixed(2)} reserved by ${t.live} live run${t.live === 1 ? '' : 's'}, and this run may spend up to $${capUsd.toFixed(2)}`
        }
      }
      this.write({ runId, usd: Math.max(alreadySpentUsd, own?.usd ?? 0), capUsd, state: 'running', pid: process.pid, updatedAt: new Date().toISOString() })
      return { ok: true as const }
    })
  }

  write(entry: LedgerEntry): void {
    writeAtomic(join(this.dir, `${entry.runId}.json`), JSON.stringify(entry, null, 2))
  }

  // Records a run's spend so far and returns the study's total spend.
  record(runId: string, usd: number, capUsd: number, state: LedgerEntry['state']): number {
    this.write({ runId, usd, capUsd, state, pid: process.pid, updatedAt: new Date().toISOString() })
    const t = this.totals()
    if (state === 'done') this.summarise()
    return t.spentUsd
  }

  // ledger.json: the totals and one line per run, for reading. Rewritten from the entries.
  summarise(): void {
    const entries = this.entries().sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    const t = this.totals()
    const round = (v: number) => Math.round(v * 10000) / 10000
    writeAtomic(join(this.studyDir, 'ledger.json'), JSON.stringify({
      note: 'Summary only. The per-run files in ledger/ are the record; this file is rebuilt from them.',
      spentUsd: round(t.spentUsd),
      reservedUsd: round(t.reservedUsd),
      runs: entries.map(e => ({ runId: e.runId, usd: round(e.usd), capUsd: e.capUsd, state: e.state === 'running' && !alive(e.pid) ? 'died' : e.state, updatedAt: e.updatedAt }))
    }, null, 2))
  }
}

export function ledgerExists(studyDir: string): boolean {
  return existsSync(join(studyDir, 'ledger'))
}
