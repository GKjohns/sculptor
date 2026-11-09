/**
 * Commissions carved in the browser, saved as plain files so a reload can carry on and a
 * finished piece can be replayed:
 *
 *   <root>/<id>/run.json         the session: settings, status, costs, the loop's state (rewritten whole)
 *   <root>/<id>/strikes.ndjson   line 1 {"kernel","grid"}, then one strike per line (append only)
 *   <root>/<id>/passes.json      the pass record (rewritten whole; a few hundred rows at most)
 *   <root>/<id>/events.ndjson    whatever the studio logs for itself, one entry per line (append only)
 *   <root>/<id>/reference.png    the hidden reference sheet, if one was made
 *
 * run.json, passes.json and the strike log's { kernel, grid, strikes } follow the study's run
 * folders (bench/sculpt.ts), so one replay path can read either.
 *
 * Plain Node with no Nitro imports, so the tests run it against a temp folder. The routes
 * turn a SessionError into an HTTP error.
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StrikeLog } from '#shared/agent/studio'
import type { PassRecord, RunState } from '#shared/agent/types'
import type { LogAppend, SessionCreate, SessionFile, SessionReferenceSave, SessionSave, SessionSaved, SessionSummary } from '#shared/agent/wire'

export class SessionError extends Error {
  status: number
  data: unknown

  constructor(status: number, message: string, data?: unknown) {
    super(message)
    this.name = 'SessionError'
    this.status = status
    this.data = data
  }
}

// run.json as it sits on disk: the pass record lives in passes.json, not inside the state.
type StoredFile = Omit<SessionFile, 'state'> & { state: Omit<RunState, 'passes'> | null }

export interface SessionStore {
  create(input: SessionCreate): SessionFile
  // Newest first. Folders that are not sessions are skipped.
  list(): SessionSummary[]
  get(id: string): SessionFile
  save(id: string, patch: SessionSave): SessionSaved
  saveReference(id: string, ref: SessionReferenceSave): SessionSaved
  // The strike log as JSON text, { kernel, grid, strikes }, built without parsing the strikes.
  strikeLogText(id: string): string
  passes(id: string): PassRecord[]
  eventsText(id: string): string
  referencePng(id: string): Uint8Array | null
}

const NEWLINE = 10

function writeAtomic(file: string, data: string | Uint8Array): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14)
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32).replace(/-$/, '')
const micro = (usd: number) => Math.round(usd * 1e6) / 1e6

// `kernel` is this build's KERNEL_VERSION; `models` maps a short model key to its gateway id.
export function createSessionStore(root: string, options: { kernel: number, models: Record<string, string> }): SessionStore {
  const models = options.models
  // Entries per log file, remembered with the size they were counted at so a file changed
  // behind the store's back is counted again.
  const counted = new Map<string, { size: number, lines: number }>()

  function dirOf(id: string): string {
    // Matched against the listing, never joined into a path as given.
    const known = existsSync(root) ? readdirSync(root, { withFileTypes: true }).find(e => e.isDirectory() && e.name === id) : undefined
    if (!known) throw new SessionError(404, 'no such session')
    return join(root, known.name)
  }

  function lines(file: string): number {
    if (!existsSync(file)) return 0
    const size = statSync(file).size
    const hit = counted.get(file)
    if (hit && hit.size === size) return hit.lines
    const bytes = readFileSync(file)
    // A write that was cut short leaves a last line with no newline. Drop it, so the next
    // append starts on a clean line and the sender, told the lower count, sends it again.
    const end = bytes.lastIndexOf(NEWLINE) + 1
    if (end < bytes.length) truncateSync(file, end)
    let n = 0
    for (let i = 0; i < end; i++) if (bytes[i] === NEWLINE) n++
    counted.set(file, { size: end, lines: n })
    return n
  }

  // Appends what the file does not have yet and returns the new entry count.
  function append(file: string, log: LogAppend<unknown>, what: string, headerLines = 0): number {
    const have = lines(file) - headerLines
    if (log.from > have) throw new SessionError(409, `${what} ${have} to ${log.from - 1} are missing: the server holds ${have}`, { have })
    const fresh = log.items.slice(have - log.from)
    if (!fresh.length) return have
    const text = `${fresh.map(item => JSON.stringify(item)).join('\n')}\n`
    appendFileSync(file, text)
    counted.set(file, { size: statSync(file).size, lines: headerLines + have + fresh.length })
    return have + fresh.length
  }

  function completeLines(file: string): string[] {
    if (!existsSync(file)) return []
    lines(file)
    return readFileSync(file, 'utf8').split('\n').filter(Boolean)
  }

  function read(dir: string): StoredFile {
    let file: StoredFile
    try {
      file = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as StoredFile
    } catch {
      throw new SessionError(404, 'no such session')
    }
    // The logs are the truth; run.json's counts can trail them if a save was cut short.
    file.strikes = Math.max(0, lines(join(dir, 'strikes.ndjson')) - 1)
    file.events = lines(join(dir, 'events.ndjson'))
    return file
  }

  function readPasses(dir: string): PassRecord[] {
    try {
      return JSON.parse(readFileSync(join(dir, 'passes.json'), 'utf8')) as PassRecord[]
    } catch {
      return []
    }
  }

  function write(dir: string, file: StoredFile): SessionSaved {
    file.updatedAt = new Date().toISOString()
    const sculptorUsd = file.state?.costUsd ?? 0
    const referenceUsd = file.reference?.costUsd ?? 0
    file.cost = { totalUsd: micro(sculptorUsd + referenceUsd), sculptorUsd: micro(sculptorUsd), referenceUsd: micro(referenceUsd) }
    writeAtomic(join(dir, 'run.json'), JSON.stringify(file, null, 2))
    return { id: file.id, status: file.status, updatedAt: file.updatedAt, strikes: file.strikes, events: file.events }
  }

  function guardKernel(file: StoredFile): void {
    if (file.kernel !== options.kernel) throw new SessionError(409, `this session was carved on kernel ${file.kernel}; this is kernel ${options.kernel}, and its strikes would not replay`)
  }

  return {
    create(input) {
      if (input.kernel !== options.kernel) throw new SessionError(409, `the page is on kernel ${input.kernel} and the server on kernel ${options.kernel}; reload the page`)
      const now = new Date()
      mkdirSync(root, { recursive: true })
      let id: string
      do {
        id = [stamp(now), slug(input.commission) || 'commission', randomBytes(2).toString('hex').slice(0, 3)].join('-')
      } while (existsSync(join(root, id)))
      const dir = join(root, id)
      mkdirSync(dir)
      const file: StoredFile = {
        id,
        status: 'running',
        startedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        finishedAt: null,
        kernel: options.kernel,
        grid: input.grid,
        config: {
          commission: input.commission,
          model: input.model,
          modelId: models[input.model] ?? input.model,
          tools: input.run.toolSet,
          ref: input.ref,
          maxTurns: input.run.maxTurns,
          maxUsd: input.run.maxUsd,
          voxel: input.grid.voxel,
          run: input.run,
          settings: input.settings ?? {}
        },
        reference: null,
        result: null,
        usage: { input: 0, output: 0 },
        cost: { totalUsd: 0, sculptorUsd: 0, referenceUsd: 0 },
        state: null,
        final: null,
        strikes: 0,
        passes: 0,
        events: 0
      }
      writeFileSync(join(dir, 'strikes.ndjson'), `${JSON.stringify({ kernel: options.kernel, grid: input.grid })}\n`)
      writeFileSync(join(dir, 'passes.json'), '[]')
      write(dir, file)
      return { ...file, state: null }
    },

    list() {
      if (!existsSync(root)) return []
      const out: SessionSummary[] = []
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        try {
          const f = read(join(root, entry.name))
          out.push({
            id: f.id,
            commission: f.config.commission,
            model: f.config.model,
            tools: f.config.tools,
            ref: f.config.ref,
            status: f.status,
            turns: f.state?.turns ?? 0,
            costUsd: f.cost.totalUsd,
            strikes: f.strikes,
            passes: f.passes,
            ended: f.result?.ended ?? null,
            title: f.result?.finish?.title ?? null,
            statement: f.result?.finish?.statement ?? null,
            kernel: f.kernel,
            hash: f.final?.hash ?? null,
            startedAt: f.startedAt,
            updatedAt: f.updatedAt,
            finishedAt: f.finishedAt
          })
        } catch {
          // not a session folder, or one whose run.json does not parse
        }
      }
      return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
    },

    get(id) {
      const dir = dirOf(id)
      const file = read(dir)
      return { ...file, state: file.state ? { ...file.state, passes: readPasses(dir) } : null }
    },

    save(id, patch) {
      const dir = dirOf(id)
      const file = read(dir)
      guardKernel(file)
      // Strikes first: a save cut short then leaves stone the record does not know about,
      // which a resume can see (more strikes than the passes account for) and trim.
      if (patch.strikes) file.strikes = append(join(dir, 'strikes.ndjson'), patch.strikes, 'strikes', 1)
      if (patch.events) file.events = append(join(dir, 'events.ndjson'), patch.events, 'events')
      if (patch.state) {
        const { passes, ...state } = patch.state
        writeAtomic(join(dir, 'passes.json'), JSON.stringify(passes, null, 2))
        file.state = state
        file.passes = passes.length
        file.usage = state.usage
      }
      if (patch.settings) file.config.settings = { ...file.config.settings, ...patch.settings }
      if (patch.final) file.final = patch.final
      if (patch.result) {
        file.result = { ...patch.result, turns: file.state?.turns ?? 0, passes: file.passes, strikes: file.strikes }
        file.status = 'done'
        file.finishedAt = new Date().toISOString()
      } else if (file.status === 'done' && (patch.state || patch.strikes?.items.length)) {
        // Carried on after it had ended (stopped by hand, then resumed).
        file.status = 'running'
        file.result = null
        file.finishedAt = null
      }
      return write(dir, file)
    },

    saveReference(id, ref) {
      const dir = dirOf(id)
      const file = read(dir)
      if (ref.pngBase64) writeAtomic(join(dir, 'reference.png'), Buffer.from(ref.pngBase64, 'base64'))
      file.reference = {
        outlines: ref.outlines,
        brief: ref.brief,
        file: existsSync(join(dir, 'reference.png')) ? 'reference.png' : null,
        costUsd: ref.costUsd,
        ...(ref.usage ? { usage: ref.usage } : {}),
        ...(ref.error ? { error: ref.error } : {})
      }
      return write(dir, file)
    },

    strikeLogText(id) {
      const [head, ...strikes] = completeLines(join(dirOf(id), 'strikes.ndjson'))
      if (!head) throw new SessionError(404, 'this session has no strike log')
      const { kernel, grid } = JSON.parse(head) as Pick<StrikeLog, 'kernel' | 'grid'>
      return `{"kernel":${JSON.stringify(kernel)},"grid":${JSON.stringify(grid)},"strikes":[${strikes.join(',')}]}`
    },

    passes(id) {
      return readPasses(dirOf(id))
    },

    eventsText(id) {
      return `[${completeLines(join(dirOf(id), 'events.ndjson')).join(',')}]`
    },

    referencePng(id) {
      const file = join(dirOf(id), 'reference.png')
      return existsSync(file) ? readFileSync(file) : null
    }
  }
}
