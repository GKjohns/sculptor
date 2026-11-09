/**
 * The Vue side of a replay: fetches a study run's strike log and pass record, owns the ReplayPlayer
 * that plays it on the stage, and mirrors the player's state for the HUD.
 */
import type { ReplayRun } from '#shared/agent/replay'
import type { StrikeLog } from '#shared/agent/studio'
import type { PassRecord } from '#shared/agent/types'
import type { CameraRig } from '~/studio/camera'
import type { Cinema } from '~/studio/cinema'
import type { KernelClient } from '~/studio/kernel'
import type { StudioRenderer } from '~/studio/renderer'
import { ReplayPlayer, replayBlocker } from '~/studio/replay'
import type { ReplaySpeed, ReplayState } from '~/studio/replay'
import type { Stone } from '~/studio/stone'

export interface ReplayStage {
  studio: StudioRenderer
  kernel: KernelClient
  stone: Stone
  camera?: CameraRig
  /** The film round the stone (debris, tools, sound, director): it follows whichever timeline it is bound to. */
  cinema?: Cinema
}

const told = (e: unknown) => e instanceof Error ? e.message : String(e)

export function useReplay() {
  const runs = shallowRef<ReplayRun[] | null>(null)
  const listProblem = ref('')
  /** The run on the stage, its pass record and the player's state; null when nothing is loaded. */
  const run = shallowRef<ReplayRun | null>(null)
  const passes = shallowRef<PassRecord[]>([])
  const state = shallowRef<ReplayState | null>(null)
  /** Why the run asked for is not playing (no such run, another kernel, a failed fetch). */
  const problem = ref('')

  let player: ReplayPlayer | null = null
  let unhook = () => {}
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
    unhook()
    unhook = () => {}
    player?.dispose()
    player = null
    run.value = null
    passes.value = []
    state.value = null
    problem.value = ''
  }

  /**
   * Loads run `id` onto a fresh block and plays it, or with `end` goes straight to the finished
   * piece. Resolves once it is playing (or, with `end`, once the finished stone is in the scene).
   */
  async function open(stage: ReplayStage, id: string, options: { speed?: ReplaySpeed, end?: boolean } = {}) {
    close()
    const mine = turn
    try {
      const found = (await refresh())?.find(r => r.id === id)
      if (mine !== turn) return
      if (!found) throw new Error(listProblem.value || `There is no finished run called ${id}.`)
      run.value = found
      const blocker = replayBlocker(found.kernel)
      if (blocker) throw new Error(blocker)
      const at = `/api/study/${encodeURIComponent(id)}`
      const [log, record] = await Promise.all([$fetch<StrikeLog>(`${at}/strikes`), $fetch<PassRecord[]>(`${at}/passes`)])
      if (mine !== turn) return
      const p = new ReplayPlayer(stage.kernel, stage.stone, log, record, options.speed, stage.camera)
      p.onChange = s => state.value = s
      stage.cinema?.bind(p.timeline)
      player = p
      passes.value = record
      unhook = stage.studio.onFrame(dt => p.tick(dt))
      await p.restart()
      if (mine !== turn) return
      if (options.end) await p.end()
      else p.play()
    } catch (e) {
      if (mine === turn) problem.value = told(e)
    }
  }

  onBeforeUnmount(close)

  return { runs, listProblem, run, passes, state, problem, refresh, open, close, player: () => player }
}
