/**
 * A commission, live. The sculptor's loop (#shared/agent/loop) runs here on the main thread with
 * the kernel worker as its Studio and POST /api/brain as its Brain. Every pass lands on the true
 * stone at once and joins the timeline's queue, which plays it onto the shown stone; this file
 * keeps the HUD's view (~/studio/viewState) in step with both, and saves the session after
 * every turn so a reload can put the stone back and carry on.
 *
 * Who stops whom: the person pauses the timeline; the timeline holds the loop at its next tool
 * call while it is paused or more than about a minute behind (Timeline.room); a turn that fails
 * twice halts the loop with a toast, and resume() starts it again from the last saved turn.
 */
import { toBase64 } from '#shared/agent/context'
import type { ReferenceRetry } from '#shared/agent/brainRequest'
import { runCommission } from '#shared/agent/loop'
import { TEXT_MODELS, addUsage } from '#shared/agent/pricing'
import type { TextModelKey } from '#shared/agent/pricing'
import type { StrikeLog } from '#shared/agent/studio'
import { DEFAULT_CONFIG } from '#shared/agent/types'
import type { Commission, LoopEvent, PassRecord, ReferenceMode, RunConfig, RunEnd, RunResult, RunState, Studio, Usage } from '#shared/agent/types'
import type { HealthResponse, ReferenceResponse, SessionCreate, SessionFile, SessionReferenceSave, SessionSave, SessionSaved, SessionSummary } from '#shared/agent/wire'
import type { GridInfo } from '#shared/sculpt/types'
import { KERNEL_VERSION } from '#shared/sculpt/version'
import type { CameraRig } from '~/studio/camera'
import type { Charcoal } from '~/studio/charcoal'
import type { KernelClient } from '~/studio/kernel'
import type { StudioRenderer } from '~/studio/renderer'
import { replayBlocker } from '~/studio/replay'
import type { Stone } from '~/studio/stone'
import { Timeline } from '~/studio/timeline'
import type { TimelineLook, TimelinePass } from '~/studio/timeline'
import { appendReasoning, applyLoopEvent, beginCommission, emptyView, endLook, landPass, lookView, modelOptions, setPanel, showPass, stageLook } from '~/studio/viewState'
import type { CameraMode, LookView, SculptorView, SidePanel } from '~/studio/viewState'

export interface SculptorStage {
  studio: StudioRenderer
  kernel: KernelClient
  stone: Stone
  camera: CameraRig
  charcoal?: Charcoal
}

export interface StartOptions {
  commission: string
  /** A sculptor's key; the configured default if left out or unknown. */
  model?: string
  /** Draw a reference sheet first; the configured default if left out. */
  reference?: boolean
}

// idle: the commission card. loading: a saved session is being put back. preparing: block,
// session, reference sheet. running: the loop is at work. halted: the loop stopped on an error
// and resume() carries on. ended: the loop is over (finished, capped, stopped). viewing: a
// saved session on the stone with no loop behind it.
export type SculptorStatus = 'idle' | 'loading' | 'preparing' | 'running' | 'halted' | 'ended' | 'viewing'

interface QueuedPass extends TimelinePass {
  tool: PassRecord['tool']
  args: Record<string, unknown>
  why: string
  numbers?: Record<string, number>
}

interface QueuedLook extends TimelineLook {
  look: LookView
}

// The first look, before the first cut, is the sculptor studying the block while it plans: the
// first turn is the longest wait of a commission, so the walk round the stone takes its time.
const OPENING_LINGER = 2.5

// A reasoning summary is not a loop event, but it is saved among them so a reload shows it again.
type SavedEvent = LoopEvent | { type: 'reasoning', turn: number, delta: string }

interface Run {
  id: string
  commission: Commission
  model: TextModelKey
  /** The commission's own caps; the loop is given what is left of maxUsd after the reference sheet. */
  config: RunConfig
  referenceUsd: number
  /** What turns cost before this page took the session over. */
  priorUsd: number
  brain: ReturnType<typeof useBrain> | null
  abort: AbortController | null
  /** The loop's state after the last finished turn. */
  state: RunState | null
  ended: RunEnd | null
  turn: number
  savedStrikes: number
  savedEvents: number
  pending: SavedEvent[]
  text: string
  reasoning: string
  /** Saves go out one at a time, in order. */
  chain: Promise<void>
  startedAt: number
}

const told = (e: unknown) => {
  const data = (e as { data?: { message?: string } } | null)?.data
  return data?.message ?? (e instanceof Error ? e.message : String(e))
}

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0))

const logGrid = (grid: GridInfo): StrikeLog['grid'] => ({ width: grid.size[0], height: grid.size[1], depth: grid.size[2], voxel: grid.voxel, chunk: grid.chunk })

// A saved log is sent to the stones in pieces this long, so their workers can answer in between.
const RESTORE_BATCH = 400
// The HUD's numbers follow the timeline this often, not every batch.
const STATS_EVERY_S = 0.1

export function useSculptor() {
  const route = useRoute()
  const router = useRouter()
  const toast = useToast()
  const defaults = useAppConfig().sculptor

  const flag = (name: string) => typeof route.query[name] === 'string' ? route.query[name] : ''
  const numberFlag = (name: string, otherwise: number) => Number(flag(name)) > 0 ? Number(flag(name)) : otherwise
  const wantReference = flag('ref') === '1' ? true : flag('ref') === '0' ? false : defaults.reference
  // ?ref=1 is also the debug flag that shows the hidden sheet in the Sculptor's eye.
  const revealReference = flag('ref') === '1'
  const caps = { maxTurns: Math.round(numberFlag('turns', defaults.maxTurns)), maxUsd: numberFlag('usd', defaults.maxUsd) }
  const firstSpeed = numberFlag('speed', defaults.speed)

  const pickModel = (key: string | undefined, known: readonly string[] = TEXT_MODELS): TextModelKey => {
    const wanted = [key, flag('model'), defaults.model].find(k => k && known.includes(k) && (TEXT_MODELS as readonly string[]).includes(k))
    return (wanted ?? 'opus') as TextModelKey
  }

  let health: HealthResponse | null = null
  const fresh = (): SculptorView => {
    const models = modelOptions(health?.models ?? [])
    const v = emptyView({ models, model: pickModel(undefined, models.length ? models.map(m => m.key) : TEXT_MODELS), gateway: health?.gateway ?? true, block: DEFAULT_CONFIG.block, ...caps })
    return { ...v, transport: { ...v.transport, speed: firstSpeed, speeds: v.transport.speeds.includes(firstSpeed) ? v.transport.speeds : [...v.transport.speeds, firstSpeed].sort((a, b) => a - b) } }
  }

  const view = shallowRef<SculptorView>(fresh())
  const status = ref<SculptorStatus>('idle')
  const sessionId = ref('')
  /** Why a saved session is not on the stone, or why a save failed. */
  const problem = ref('')
  const sessions = shallowRef<SessionSummary[] | null>(null)

  let stage: SculptorStage | null = null
  let timeline: Timeline<QueuedPass, QueuedLook> | null = null
  let run: Run | null = null
  let unhook = () => {}
  let disposed = false
  // Bumped whenever the stone is given to something else, so a slow start or load lets go quietly.
  let generation = 0
  let statsClock = 0
  let statsStale = false
  let referenceUrl: string | undefined
  let restored: { strikes: number, ms: number } | null = null
  const urls = new Map<Uint8Array, string>()
  // The longest the page spent answering one loop event of each kind, ms: where a dropped frame would come from.
  const slowest: Record<string, number> = {}

  const change = (fn: (v: SculptorView) => SculptorView) => view.value = fn(view.value)

  // One object URL per image, however many places show it.
  function toUrl(image: Uint8Array): string {
    let url = urls.get(image)
    if (!url) {
      url = URL.createObjectURL(new Blob([new Uint8Array(image)], { type: 'image/png' }))
      urls.set(image, url)
    }
    return url
  }

  function forgetImages() {
    for (const url of urls.values()) URL.revokeObjectURL(url)
    urls.clear()
    referenceUrl = undefined
  }

  // ---------- the view follows the timeline ----------

  function sync() {
    statsStale = false
    const t = timeline?.state()
    const v = view.value
    if (!t || v.phase === 'idle') return
    // "Behind" is said in screen time: how long until what the sculptor has already done has been shown.
    const stats = { ...v.stats, strikes: t.applied, elapsedVirtualMs: Math.round(t.clockMs + t.lookMs), behindMs: t.caughtUp ? 0 : Math.round(t.behindS * 1000) }
    if (t.massKg !== null) {
      stats.massKg = Math.round(t.massKg * 10) / 10
      stats.removedKg = Math.max(0, Math.round((stats.blockKg - t.massKg) * 10) / 10)
    }
    const transport = { ...v.transport, paused: !t.playing, speed: typeof t.speed === 'number' ? t.speed : v.transport.speed }
    let { phase, subtitle } = v
    if (status.value === 'running' || status.value === 'halted' || status.value === 'ended' || status.value === 'viewing') {
      if (t.looking) phase = 'looking'
      else if (!t.caughtUp) phase = 'carving'
      else if (status.value === 'ended') phase = 'finished'
      else if (status.value === 'viewing') phase = 'carving'
      else phase = 'thinking'
      if (phase === 'thinking' || phase === 'finished') subtitle = null
    }
    view.value = { ...v, stats, transport, phase, subtitle }
  }

  function makeTimeline(s: SculptorStage) {
    timeline?.dispose()
    s.charcoal?.clear()
    const rebuild = () => {
      s.charcoal?.clear()
      return s.kernel.reshow()
    }
    const t = new Timeline<QueuedPass, QueuedLook>(s.kernel, s.stone, { speed: view.value.transport.speed, elastic: true, camera: s.camera, rebuild })
    t.onChange = () => statsStale = true
    t.onSketch = strike => s.charcoal?.draw(strike)
    t.onPass = (pass) => {
      // The stone the lines were drawn on is about to come off.
      if (pass.tool !== 'sketch' && pass.tool !== 'declare_form') s.charcoal?.clear()
      change(v => showPass(v, pass))
      sync()
    }
    t.onLook = entry => change(v => stageLook(v, entry.look, revealReference ? referenceUrl : undefined))
    t.onLookEnd = () => {
      change(v => endLook(v))
      sync()
    }
    timeline = t
    s.camera.sway = true
    return t
  }

  function frame(dt: number) {
    if (!timeline) return
    timeline.tick(dt)
    statsClock += dt
    if (statsStale && statsClock >= STATS_EVERY_S) {
      statsClock = 0
      sync()
    }
  }

  // ---------- setting up ----------

  /** Takes the stage. Resolves once the server has said which sculptors there are. */
  async function attach(s: SculptorStage) {
    stage = s
    unhook = s.studio.onFrame(frame)
    try {
      health = await $fetch<HealthResponse>('/api/health')
    } catch (e) {
      problem.value = `The server did not answer: ${told(e)}`
    }
    if (view.value.phase === 'idle') view.value = fresh()
  }

  async function refreshSessions() {
    try {
      sessions.value = await $fetch<SessionSummary[]>('/api/sessions')
    } catch {
      sessions.value = []
    }
    return sessions.value
  }

  function setSession(id: string) {
    sessionId.value = id
    if (flag('session') !== id) void router.replace({ query: { ...route.query, session: id || undefined, replay: undefined, at: undefined } })
  }

  // Lets go of whatever commission was on the stage. Nothing is saved: a stopped loop that
  // should be recorded as stopped goes through abort() first.
  function letGo() {
    generation++
    const r = run
    run = null
    r?.abort?.abort()
    r?.brain?.dispose()
    timeline?.dispose()
    timeline = null
    forgetImages()
    restored = null
    problem.value = ''
  }

  // ---------- saving ----------

  // What the notebook is rebuilt from after a reload: the loop's events without the bulk.
  function record(r: Run, event: LoopEvent) {
    if (event.type === 'text') {
      r.text += event.delta
      return
    }
    if (event.type === 'turn_retry') r.text = r.reasoning = ''
    if (r.reasoning) r.pending.push({ type: 'reasoning', turn: r.turn, delta: r.reasoning })
    if (r.text) r.pending.push({ type: 'text', turn: r.turn, delta: r.text })
    r.text = r.reasoning = ''
    if (event.type === 'look') r.pending.push({ ...event, images: [] })
    else if (event.type === 'tool_result') r.pending.push({ ...event, strikes: [] })
    else if (event.type === 'rebuild') r.pending.push({ ...event, messages: [] })
    else if (event.type === 'turn_end') r.pending.push({ ...event, state: { ...event.state, passes: [] } })
    else r.pending.push(event)
  }

  // Everything up to the end of this turn, in one request: strikes, events, the loop's state and
  // the true stone's hash, so a reload can check the stone it rebuilds against the one that was saved.
  // The server answers with how much it now holds, which is where the next save starts from.
  function saveTurn(r: Run, state: RunState, result?: RunResult) {
    if (!stage || !timeline) return
    const upTo = timeline.total
    const log = timeline.log
    const events = r.pending.splice(0)
    const hashing = stage.kernel.stats(true, 'true')
    r.chain = r.chain.then(async () => {
      const body: SessionSave = {
        strikes: { from: r.savedStrikes, items: log.slice(r.savedStrikes, upTo) },
        events: { from: r.savedEvents, items: events },
        state,
        final: { hash: (await hashing).hash ?? 'unknown' },
        settings: { speed: view.value.transport.speed },
        ...(result ? { result: { ended: result.ended, finish: result.finish, ...(result.error ? { error: result.error } : {}) } } : {})
      }
      const saved = await $fetch<SessionSaved>(`/api/sessions/${encodeURIComponent(r.id)}`, { method: 'PATCH', body })
      r.savedStrikes = saved.strikes
      r.savedEvents = saved.events
    }).catch((e) => {
      // The strikes go out again with the next save; the events have to be put back to go with them.
      r.pending.unshift(...events)
      if (run === r) problem.value = `The session could not be saved: ${told(e)}`
    })
  }

  // ---------- the loop ----------

  // The loop counts its own turns; the HUD shows the commission's bill, reference sheet included.
  function billed(r: Run, event: LoopEvent): LoopEvent {
    if (event.type === 'budget') return { ...event, costUsd: event.costUsd + r.referenceUsd, maxUsd: r.config.maxUsd }
    if (event.type === 'turn_end') return { ...event, state: { ...event.state, costUsd: event.state.costUsd + r.referenceUsd } }
    return event
  }

  function onEvent(r: Run, event: LoopEvent) {
    if (run !== r || disposed) return
    const t0 = performance.now()
    handle(r, event)
    const ms = performance.now() - t0
    if (ms > (slowest[event.type] ?? 0)) slowest[event.type] = Math.round(ms * 10) / 10
  }

  function handle(r: Run, event: LoopEvent) {
    // A loop that stopped on an error is halted, not finished: resume() carries on.
    if (event.type === 'finish' && event.ended === 'error') return
    if (event.type === 'turn_start') r.turn = event.turn
    record(r, event)
    change(v => applyLoopEvent(v, billed(r, event), { toUrl }))
    if (event.type === 'error') change(v => ({ ...v, error: undefined }))

    if (event.type === 'tool_result' && event.strikes.length) {
      const p = event.pass
      timeline?.push(event.strikes, p ? { strikes: event.strikes.length, tool: p.tool, args: p.args, why: p.why, ...(p.numbers ? { numbers: p.numbers } : {}) } : undefined)
    } else if (event.type === 'look') {
      // A slice is a drawing, not a place to stand: the eye shows it and the camera stays where it is.
      const opening = event.auto && event.turn === 0 && timeline?.total === 0
      timeline?.look({ views: event.tool === 'slice' ? [] : event.views, close: event.tool === 'closeup', look: lookView(event, toUrl), ...(opening ? { linger: OPENING_LINGER } : {}) })
    } else if (event.type === 'turn_end') {
      saveTurn(r, event.state)
    }
  }

  async function drive(r: Run, resume?: RunState) {
    if (!stage || !timeline) return
    const { kernel } = stage
    const t = timeline
    const ctl = new AbortController()
    r.abort = ctl
    r.ended = null
    status.value = 'running'
    t.setOpen(true)
    t.play()
    change(v => ({ ...v, phase: v.phase === 'preparing' ? 'thinking' : v.phase, notice: null, finish: null, error: undefined }))
    sync()

    const reference: ReferenceMode = !r.commission.reference ? 'none' : r.commission.reference.outlines ? 'outlines' : 'view'
    r.brain ??= useBrain({
      model: r.model,
      toolSet: r.config.toolSet,
      reference,
      block: r.config.block,
      stone: r.config.stone,
      toolResults: r.config.toolResults,
      onReasoning: (delta) => {
        if (run !== r) return
        r.reasoning += delta
        change(v => appendReasoning(v, r.turn, delta))
      }
    })
    // Held before each call while the screen is paused or far behind, so the sculptor cannot outrun it.
    const studio: Studio = {
      run: async (call) => {
        await t.room(ctl.signal)
        return kernel.run(call)
      }
    }
    const result = await runCommission({
      brain: r.brain,
      studio,
      commission: r.commission,
      // The reference sheet came out of the same purse.
      config: { ...r.config, maxUsd: Math.max(0.01, r.config.maxUsd - r.referenceUsd) },
      onEvent: e => onEvent(r, e),
      signal: ctl.signal,
      ...(resume ? { resume } : {})
    })
    if (run !== r || disposed) return
    r.abort = null
    r.state = { turns: result.turns, passes: result.passes, notebook: result.notebook, usage: result.usage, costUsd: result.costUsd }
    if (result.ended === 'error') halt(r, result.error ?? 'the turn failed')
    else conclude(r, result)
  }

  function conclude(r: Run, result: RunResult) {
    r.ended = result.ended
    status.value = 'ended'
    timeline?.setOpen(false)
    saveTurn(r, r.state!, result)
    sync()
  }

  function halt(r: Run, message: string) {
    status.value = 'halted'
    timeline?.pause()
    change(v => ({ ...v, notice: `The sculptor stopped: ${message}` }))
    sync()
    toast.add({
      title: 'The sculptor stopped',
      description: `${message}. Nothing is lost: carry on from the last finished turn.`,
      color: 'error',
      icon: 'i-lucide-triangle-alert',
      duration: 0,
      actions: [{ label: 'Carry on', color: 'neutral', variant: 'outline', onClick: () => resume() }]
    })
  }

  // ---------- the reference sheet ----------

  // Drawn once more if it cannot be traced; if that fails too it is kept for the sculptor's
  // eyes only. The same policy as the study (bench/reference.ts). Every call is paid for from
  // the commission's budget, whatever comes of it.
  async function drawReference(r: Run, s: SculptorStage, signal: AbortSignal) {
    let costUsd = 0
    let usage: Usage = { input: 0, output: 0 }
    let brief = ''
    let error: string | undefined
    let kept: { png: Uint8Array, ok: boolean } | null = null
    let retry: ReferenceRetry | undefined
    for (let attempt = 0; attempt < 2 && !kept?.ok; attempt++) {
      let sheet: ReferenceResponse
      try {
        sheet = await $fetch<ReferenceResponse>('/api/reference', { method: 'POST', body: { commission: r.commission.prompt, model: r.model, ...(retry ? { retry } : {}) }, signal })
      } catch (e) {
        if (signal.aborted) throw e
        error = told(e)
        continue
      }
      costUsd += sheet.costUsd
      usage = addUsage(usage, sheet.usage)
      brief = sheet.brief || brief
      r.referenceUsd = costUsd
      change(v => ({ ...v, stats: { ...v.stats, costUsd } }))
      if (!sheet.pngBase64) {
        error = sheet.error ?? 'the image model returned no image'
        continue
      }
      const traced = await s.kernel.reference(fromBase64(sheet.pngBase64))
      if (!traced.png) {
        error = traced.reasons[0] ?? 'the sheet could not be read'
        // The worker let go of the sheet it had; hand the one being kept back to it.
        if (kept) await s.kernel.reference(kept.png.slice())
        continue
      }
      kept = { png: traced.png, ok: traced.ok }
      error = undefined
      retry = { reasons: traced.reasons, brief: sheet.brief }
    }
    if (kept) {
      r.commission.reference = { png: kept.png, outlines: kept.ok }
      referenceUrl = toUrl(kept.png)
    }
    const body: SessionReferenceSave = { pngBase64: kept ? toBase64(kept.png) : null, outlines: kept?.ok ?? false, brief, costUsd, usage, ...(error ? { error } : {}) }
    await $fetch(`/api/sessions/${encodeURIComponent(r.id)}/reference`, { method: 'PUT', body }).catch((e) => {
      problem.value = `The reference sheet could not be saved: ${told(e)}`
    })
  }

  // ---------- starting, stopping ----------

  function newRun(id: string, commission: string, model: TextModelKey, config: RunConfig): Run {
    return { id, commission: { prompt: commission }, model, config, referenceUsd: 0, priorUsd: 0, brain: null, abort: null, state: null, ended: null, turn: 0, savedStrikes: 0, savedEvents: 0, pending: [], text: '', reasoning: '', chain: Promise.resolve(), startedAt: Date.now() }
  }

  /** Starts a commission on a fresh block. Resolves once the sculptor has been set to work. */
  async function start(options: StartOptions) {
    const s = stage
    if (!s) throw new Error('the studio is not ready')
    if (status.value === 'running' || status.value === 'preparing' || status.value === 'loading') throw new Error('a commission is already under way')
    const commission = options.commission.trim()
    if (!commission) throw new Error('say what to carve')
    const model = pickModel(options.model)
    const withReference = options.reference ?? wantReference
    letGo()
    const mine = generation
    status.value = 'preparing'
    view.value = beginCommission({ ...fresh(), transport: view.value.transport, panel: view.value.panel }, { commission, model, stone: 'carrara' })
    try {
      const grid = await s.kernel.init()
      if (mine !== generation) return
      s.stone.reset(grid)
      makeTimeline(s)
      const config: RunConfig = { ...DEFAULT_CONFIG, toolSet: defaults.toolSet, ...caps }
      const create: SessionCreate = { commission, model, ref: withReference, run: config, grid: logGrid(grid), kernel: KERNEL_VERSION, settings: { speed: view.value.transport.speed } }
      const file = await $fetch<SessionFile>('/api/sessions', { method: 'POST', body: create })
      if (mine !== generation) return
      const r = newRun(file.id, commission, model, config)
      run = r
      setSession(file.id)
      if (withReference) {
        change(v => ({ ...v, notice: 'Modelling a small study to work from' }))
        const ctl = new AbortController()
        r.abort = ctl
        await drawReference(r, s, ctl.signal)
        if (mine !== generation) return
      }
      void drive(r)
    } catch (e) {
      if (mine !== generation) return
      // Stopped while the reference sheet was being drawn: there is nothing to keep.
      if (run?.abort?.signal.aborted) void reset()
      else fail(told(e))
    }
  }

  // The commission cannot go on at all (no session, no stone).
  function fail(message: string) {
    status.value = 'ended'
    change(v => ({ ...v, phase: 'error', error: message, notice: null, subtitle: null }))
  }

  function pause() {
    timeline?.pause()
    sync()
  }

  /** Lets the screen run again, and a halted sculptor carry on from its last finished turn. */
  function resume() {
    const r = run
    if (status.value === 'halted' && r) {
      change(v => ({ ...v, notice: null }))
      void drive(r, r.state ?? undefined)
      return
    }
    timeline?.play()
    sync()
  }

  function setSpeed(speed: number) {
    if (!(speed > 0)) return
    change(v => ({ ...v, transport: { ...v.transport, speed } }))
    timeline?.setSpeed(speed)
    sync()
  }

  function setCamera(mode: CameraMode) {
    if (stage) stage.camera.mode = mode
    change(v => ({ ...v, transport: { ...v.transport, cameraMode: mode } }))
  }

  function openPanel(panel: SidePanel | null) {
    change(v => setPanel(v, panel))
  }

  /** Stops the commission where it stands. The piece stays; the session is saved as stopped. */
  function abort() {
    const r = run
    if (!r) return
    if (r.abort) {
      r.abort.abort()
    } else if (status.value === 'halted' && r.state) {
      // No loop to stop: the halt becomes the end.
      const event: LoopEvent = { type: 'finish', turn: r.state.turns, ended: 'aborted', title: null, statement: null }
      record(r, event)
      change(v => applyLoopEvent({ ...v, notice: null }, event))
      conclude(r, { ...r.state, ended: 'aborted', finish: null })
    } else if (status.value === 'halted') {
      void reset()
      return
    }
    timeline?.play()
  }

  /** Back to the commission card and a fresh block. */
  async function reset() {
    const s = stage
    letGo()
    status.value = 'idle'
    view.value = { ...fresh(), transport: { ...view.value.transport, paused: false } }
    setSession('')
    if (!s) return
    const mine = generation
    s.camera.sway = false
    const grid = await s.kernel.init()
    if (mine === generation) s.stone.reset(grid)
  }

  // ---------- saved sessions ----------

  // A saved log back on both stones as fast as their workers can take it: each plays it for
  // itself, side by side, and the shown stone is meshed once at the end.
  async function restore(s: SculptorStage, log: StrikeLog, passes: QueuedPass[] | null) {
    const blocker = replayBlocker(log.kernel)
    if (blocker) throw new Error(blocker)
    const t0 = performance.now()
    const grid = await s.kernel.init(log.grid)
    s.stone.reset(grid)
    const t = makeTimeline(s)
    const feed = async (which: 'true' | 'shown') => {
      for (let i = 0; i < log.strikes.length; i += RESTORE_BATCH) await s.kernel.strike(log.strikes.slice(i, i + RESTORE_BATCH), which, { silent: true })
    }
    await Promise.all([feed('true'), feed('shown')])
    // An empty batch that is not silent: one remesh of everything the log touched.
    const { rev } = await s.kernel.strike([])
    await s.stone.whenShown(rev)
    restored = { strikes: log.strikes.length, ms: Math.round(performance.now() - t0) }
    if (passes && passes.reduce((n, p) => n + p.strikes, 0) === log.strikes.length) {
      let at = 0
      for (const pass of passes) {
        t.push(log.strikes.slice(at, at + pass.strikes), pass)
        at += pass.strikes
      }
    } else {
      t.push(log.strikes)
    }
    t.adopt(rev)
    t.setOpen(false)
    return t
  }

  const queued = (p: PassRecord): QueuedPass => ({ strikes: p.strikes, tool: p.tool, args: p.args, why: p.why, ...(p.numbers ? { numbers: p.numbers } : {}) })

  /**
   * Puts a saved session back on the stone. An unfinished one is carried on from its last saved
   * turn; a finished one is shown as it ended. With `pass`, the stone is shown as it stood after
   * that pass (0-based) and nothing is resumed.
   */
  async function load(id: string, options: { pass?: number } = {}) {
    const s = stage
    if (!s) throw new Error('the studio is not ready')
    letGo()
    const mine = generation
    status.value = 'loading'
    sessionId.value = id
    view.value = { ...beginCommission(fresh(), { commission: '', model: view.value.model, stone: 'carrara' }, 'Putting the stone back'), transport: view.value.transport }
    try {
      const at = `/api/sessions/${encodeURIComponent(id)}`
      const [file, log, events] = await Promise.all([$fetch<SessionFile>(at), $fetch<StrikeLog>(`${at}/strikes`), $fetch<SavedEvent[]>(`${at}/events`)])
      if (mine !== generation) return
      const passes = file.state?.passes ?? []
      const accounted = passes.reduce((n, p) => n + p.strikes, 0)
      const t = await restore(s, log, passes.map(queued))
      if (mine !== generation) return

      const model = pickModel(file.config.model)
      const r = newRun(file.id, file.config.commission, model, { ...DEFAULT_CONFIG, ...file.config.run })
      r.savedStrikes = file.strikes
      r.savedEvents = file.events
      r.state = file.state
      r.referenceUsd = file.reference?.costUsd ?? 0
      r.priorUsd = file.state?.costUsd ?? 0
      r.turn = file.state?.turns ?? 0
      r.ended = file.result?.ended ?? null
      run = r

      // The notebook, the stage list and the bill, from the events as they were saved.
      let v = beginCommission({ ...fresh(), transport: view.value.transport, panel: view.value.panel }, { commission: file.config.commission, model, stone: 'carrara' })
      v = { ...v, stats: { ...v.stats, maxTurns: r.config.maxTurns, maxUsd: r.config.maxUsd, costUsd: r.referenceUsd } }
      const finished = file.status === 'done' && file.result !== null
      for (const event of events) {
        if (event.type === 'reasoning') v = appendReasoning(v, event.turn, event.delta)
        else if (event.type !== 'finish' || finished) v = applyLoopEvent(v, billed(r, event), { now: file.finishedAt ?? file.updatedAt })
      }
      const last = passes.findLast(p => p.numbers?.mass_kg !== undefined)
      if (last) v = landPass(v, last)
      view.value = { ...v, notice: null, error: undefined }

      const mismatch = log.strikes.length !== accounted
        ? `Its log holds ${log.strikes.length} strikes and its pass record accounts for ${accounted}`
        : file.final?.hash && (await s.kernel.stats(true, 'true')).hash !== file.final.hash ? 'The stone its log gives is not the stone that was saved' : ''
      if (mine !== generation) return

      const sheet = file.reference?.file ? new Uint8Array(await $fetch<ArrayBuffer>(`${at}/reference`, { responseType: 'arrayBuffer' })) : null
      if (sheet) {
        const traced = await s.kernel.reference(sheet)
        if (traced.png) {
          r.commission.reference = { png: traced.png, outlines: traced.ok }
          referenceUrl = toUrl(traced.png)
        }
      }
      if (mine !== generation) return

      if (options.pass !== undefined) {
        status.value = 'viewing'
        await t.seekPass(options.pass)
        const shown = passes[Math.min(passes.length - 1, Math.max(0, Math.round(options.pass)))]
        if (shown) change(w => landPass(showPass(w, shown), shown))
      } else if (finished || mismatch) {
        status.value = finished ? 'ended' : 'viewing'
        if (mismatch && !finished) problem.value = `${mismatch}, so this commission can be looked at but not carried on.`
      } else {
        void drive(r, file.state ?? undefined)
        return
      }
      sync()
    } catch (e) {
      if (mine !== generation) return
      status.value = 'idle'
      view.value = fresh()
      problem.value = told(e)
    }
  }

  /** The loaded session's stone as it stood after pass `index` (0-based). Not while the sculptor is at work. */
  async function replayTo(index: number) {
    if (!timeline || status.value === 'running' || status.value === 'preparing' || status.value === 'loading') throw new Error('nothing to replay, or the sculptor is still at work')
    await timeline.seekPass(index)
    const shown = run?.state?.passes[Math.max(0, Math.round(index))]
    if (shown) change(v => landPass(showPass(v, shown), shown))
    sync()
  }

  /** For the debug handle: how long a saved study run's log takes to put back on both stones. */
  async function timeRestore(runId: string) {
    const s = stage
    if (!s) throw new Error('the studio is not ready')
    letGo()
    const log = await $fetch<StrikeLog>(`/api/study/${encodeURIComponent(runId)}/strikes`)
    await restore(s, log, null)
    status.value = 'viewing'
    return { ...restored!, hash: (await s.kernel.stats(true, 'shown')).hash }
  }

  /** Everything a script needs to follow a run. */
  function state() {
    const t = timeline?.state()
    const v = view.value
    const r = run
    return {
      status: status.value,
      phase: v.phase,
      session: sessionId.value,
      paused: v.transport.paused,
      speed: v.transport.speed,
      turn: v.stats.turns,
      maxTurns: v.stats.maxTurns,
      costUsd: v.stats.costUsd,
      maxUsd: v.stats.maxUsd,
      // What the server said this page's turns cost, plus what was spent before it and on the reference sheet.
      serverUsd: (r?.brain?.spend.usd ?? 0) + (r?.priorUsd ?? 0) + (r?.referenceUsd ?? 0),
      referenceUsd: r?.referenceUsd ?? 0,
      reference: !r?.commission.reference ? 'none' : r.commission.reference.outlines ? 'outlines' : 'view',
      failedTurns: r?.brain?.spend.unmetered ?? 0,
      strikesApplied: t?.total ?? 0,
      strikesShown: t?.applied ?? 0,
      queue: t ? t.total - t.applied : 0,
      passes: t?.passes ?? 0,
      virtualMs: Math.round(t?.clockMs ?? 0),
      issuedMs: Math.round(t?.totalMs ?? 0),
      rate: Math.round((t?.rate ?? 0) * 100) / 100,
      behindS: Math.round((t?.behindS ?? 0) * 10) / 10,
      looking: t?.looking ?? false,
      caughtUp: t?.caughtUp ?? true,
      idle: timeline ? { ...timeline.idle } : null,
      ended: r?.ended ?? null,
      title: v.finish?.title ?? null,
      wallMs: r ? Date.now() - r.startedAt : 0,
      restored,
      slowest: { ...slowest, body: Math.round((r?.brain?.spend.slowestBodyMs ?? 0) * 10) / 10 },
      problem: problem.value
    }
  }

  /** Gives the stage up to something else (a replay of a study run): no commission, no timeline, the stone left as it is. */
  function release() {
    letGo()
    status.value = 'idle'
    view.value = fresh()
    sessionId.value = ''
    if (stage) stage.camera.sway = false
  }

  /** Resolves once every save asked for so far has reached the server. */
  const saved = () => run?.chain ?? Promise.resolve()

  onBeforeUnmount(() => {
    disposed = true
    unhook()
    letGo()
    stage = null
  })

  return { view, status, sessionId, problem, sessions, attach, refreshSessions, start, pause, resume, setSpeed, setCamera, openPanel, abort, reset, release, load, replayTo, timeRestore, state, saved, timeline: () => timeline }
}
