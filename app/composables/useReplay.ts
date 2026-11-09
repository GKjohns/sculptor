/**
 * The Vue side of a replay: fetches a finished run's strike log and pass record (a study run under
 * .data/study, or a saved commission under .data/sessions: the same shapes), owns the ReplayPlayer
 * that plays it on the stage, and mirrors the player's state for the HUD. Scrubbing is the
 * timeline's seek; a film is film.ts run over the same player. Nothing here calls a model.
 */
import type { ReplayRun } from '#shared/agent/replay'
import type { StrikeLog } from '#shared/agent/studio'
import type { PassRecord } from '#shared/agent/types'
import type { SessionFile } from '#shared/agent/wire'
import type { CameraRig } from '~/studio/camera'
import type { Cinema } from '~/studio/cinema'
import { download, exportFilm } from '~/studio/film'
import type { FilmOptions, FilmResult } from '~/studio/film'
import type { KernelClient } from '~/studio/kernel'
import { stonePreset } from '~/studio/materials/marble'
import type { StudioRenderer } from '~/studio/renderer'
import { ReplayPlayer, replayBlocker } from '~/studio/replay'
import type { ReplaySpeed, ReplayState } from '~/studio/replay'
import type { Stone } from '~/studio/stone'
import { modelLabel } from '~/studio/viewState'

export interface ReplayStage {
  studio: StudioRenderer
  kernel: KernelClient
  stone: Stone
  camera?: CameraRig
  /** The film round the stone (debris, tools, sound, director): it follows whichever timeline it is bound to. */
  cinema?: Cinema
  /** Puts a stone of this medium on the banker ('carrara', 'nero'). */
  setStone?: (key: string) => Promise<void>
}

/** A finished run as the replay shows it: a study run, or a saved commission dressed the same way. */
export interface ReplaySource extends ReplayRun {
  kind: 'study' | 'session'
  /** The stone's preset name. */
  stone: string
}

/** Where a film export stands. */
export interface FilmProgress {
  frame: number
  frames: number
}

const told = (e: unknown) => e instanceof Error ? e.message : String(e)

// A saved commission, in the study's terms.
function fromSession(file: SessionFile): ReplaySource {
  return {
    id: file.id,
    kind: 'session',
    round: '',
    subject: file.config.commission,
    model: file.config.model,
    tools: file.config.tools,
    ref: file.config.ref,
    turns: file.result?.turns ?? file.state?.turns ?? 0,
    costUsd: file.cost.totalUsd,
    strikes: file.strikes,
    passes: file.passes,
    ended: file.result?.ended ?? 'unfinished',
    title: file.result?.finish?.title ?? null,
    statement: file.result?.finish?.statement ?? null,
    judge: null,
    kernel: file.kernel,
    hash: file.final?.hash ?? '',
    finishedAt: file.finishedAt ?? file.updatedAt,
    stone: stonePreset(file.config.run.stone).name
  }
}

export function useReplay() {
  const runs = shallowRef<ReplayRun[] | null>(null)
  const listProblem = ref('')
  /** The run on the stage, its pass record and the player's state; null when nothing is loaded. */
  const run = shallowRef<ReplaySource | null>(null)
  const passes = shallowRef<PassRecord[]>([])
  const state = shallowRef<ReplayState | null>(null)
  /** Why the run asked for is not playing (no such run, another kernel, a failed fetch). */
  const problem = ref('')
  /** A film being rendered, or null. */
  const filming = shallowRef<FilmProgress | null>(null)

  let player: ReplayPlayer | null = null
  let stage: ReplayStage | null = null
  let unhook = () => {}
  let cancel: AbortController | null = null
  // Bumped on every open and close, so a slow load that was overtaken lets go quietly.
  let turn = 0

  /** Reads the run list again; the study may still be adding to it. */
  async function refresh() {
    try {
      runs.value = await $fetch<ReplayRun[]>('/api/study')
      listProblem.value = ''
    } catch (e) {
      listProblem.value = told(e)
    }
    return runs.value
  }

  /** Lets go of the player. The stone stays as it was left. */
  function close() {
    turn++
    cancel?.abort()
    unhook()
    unhook = () => {}
    player?.dispose()
    player = null
    stage = null
    run.value = null
    passes.value = []
    state.value = null
    problem.value = ''
  }

  // A study run by that id, else a saved commission.
  async function find(id: string): Promise<{ source: ReplaySource, at: string }> {
    const study = (await refresh())?.find(r => r.id === id)
    if (study) return { source: { ...study, kind: 'study', stone: 'carrara' }, at: `/api/study/${encodeURIComponent(id)}` }
    const at = `/api/sessions/${encodeURIComponent(id)}`
    let file: SessionFile
    try {
      file = await $fetch<SessionFile>(at)
    } catch {
      throw new Error(listProblem.value || `There is no finished run or saved commission called ${id}.`)
    }
    return { source: fromSession(file), at }
  }

  /**
   * Loads run `id` onto a fresh block and plays it, or with `end` goes straight to the finished
   * piece. Resolves once it is playing (or, with `end`, once the finished stone is in the scene).
   */
  async function open(on: ReplayStage, id: string, options: { speed?: ReplaySpeed, end?: boolean } = {}) {
    close()
    const mine = turn
    try {
      const { source, at } = await find(id)
      if (mine !== turn) return
      run.value = source
      const blocker = replayBlocker(source.kernel)
      if (blocker) throw new Error(blocker)
      const [log, record] = await Promise.all([$fetch<StrikeLog>(`${at}/strikes`), $fetch<PassRecord[]>(`${at}/passes`)])
      if (mine !== turn) return
      await on.setStone?.(source.stone)
      if (mine !== turn) return
      const p = new ReplayPlayer(on.kernel, on.stone, log, record, options.speed, on.camera)
      p.onChange = s => state.value = s
      on.cinema?.bind(p.timeline)
      on.cinema?.credit(modelLabel(source.model), new Date(source.finishedAt))
      player = p
      stage = on
      passes.value = record
      unhook = on.studio.onFrame(dt => p.tick(dt))
      await p.restart()
      if (mine !== turn) return
      if (options.end) await p.end()
      else p.play()
    } catch (e) {
      if (mine === turn) problem.value = told(e)
    }
  }

  /** The stone as it stood after log entry `to` (scrubbing). Going back replays the log from a fresh block. */
  async function seek(to: number) {
    if (!player || filming.value) return
    await player.timeline.seek(to)
  }

  /**
   * Renders the run to an MP4 (film.ts) and hands it to the browser to save. Resolves with what was
   * made, without the file itself.
   */
  async function film(options: FilmOptions = {}): Promise<Omit<FilmResult, 'blob'> & { name: string }> {
    const p = player
    const s = stage
    const r = run.value
    if (!p || !s || !r) throw new Error('no replay is loaded')
    if (filming.value) throw new Error('a film is already being made')
    cancel = new AbortController()
    filming.value = { frame: 0, frames: 1 }
    try {
      const day = r.finishedAt ? new Date(r.finishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : ''
      const title = { title: r.title ?? 'Untitled', meta: [modelLabel(r.model), stonePreset(r.stone).label, day].filter(Boolean).join(' · ') }
      const made = await exportFilm(s.studio, s.stone, p, s.cinema ?? null, {
        title,
        ...options,
        signal: cancel.signal,
        onProgress: (frame, frames) => {
          // The HUD hears about it once a percent, not once a frame.
          if (frame === frames || frame % Math.max(1, Math.round(frames / 100)) === 0) filming.value = { frame, frames }
        }
      })
      const slug = (r.title ?? r.subject).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'sculpture'
      const name = `sculptor-${slug}-${made.seconds}s.mp4`
      const { blob, ...rest } = made
      download(blob, name)
      return { ...rest, name }
    } finally {
      cancel = null
      filming.value = null
    }
  }

  /** Stops a film being rendered; the replay is left paused where the film got to. */
  function stopFilm() {
    cancel?.abort()
  }

  onBeforeUnmount(close)

  return { runs, listProblem, run, passes, state, problem, filming, refresh, open, close, seek, film, stopFilm, player: () => player }
}
