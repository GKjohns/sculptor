<script setup lang="ts">
/**
 * Full-bleed studio canvas with the HUD over it. The renderer and the kernel worker are created
 * once on mount; the scene code is plain .ts in ~/studio, the commission lives in useSculptor and
 * the HUD draws the view that hands back. Query flags:
 *   ?gl=1     force the WebGL 2 backend (the shoot script's --gl mode and the fallback check)
 *   ?hands=1  hand-carving: a tool palette, and strikes where you press on the stone
 *   ?demo=1   carve the fixed demo before the scene reports ready
 *   ?session=<id>  put a saved commission back on the stone and, if it was not finished, carry on.
 *             With ?pass=<n>, show the stone as it stood after pass n (1-based) and resume nothing
 *   ?replay=<run-id>  play a finished study run from .data/study; bare ?replay opens the list.
 *             With it: ?speed=1|8|30|120|max (30 if left out), and ?at=end to go straight to the
 *             finished piece before the scene reports ready
 *   ?model=, ?ref=0|1, ?turns=, ?usd=, ?speed=  a commission's settings for this page load
 *             (app.config.ts has the defaults); ?ref=1 also shows the reference sheet in the eye panel
 *   ?cam=free  the director leaves the camera alone (it stays where you, or a look preset, put it)
 *   ?film=0    no debris, tools, sound or director at all, to measure what they cost
 */
import { CameraRig } from '~/studio/camera'
import { Charcoal } from '~/studio/charcoal'
import { Cinema } from '~/studio/cinema'
import { burst, demo, frameMeter, timeReplay } from '~/studio/debug'
import { Hands } from '~/studio/hands'
import type { HandTool, ScreenLine } from '~/studio/hands'
import { KernelClient } from '~/studio/kernel'
import { applyLook, carveFrame5, effectsFromQuery } from '~/studio/look'
import { StudioRenderer } from '~/studio/renderer'
import type { ReplaySpeed } from '~/studio/replay'
import { Stone } from '~/studio/stone'
import type { HudInset, StartRequest } from '~/studio/viewState'
import type { StoneId } from '#shared/sculpt/protocol'

const hostEl = useTemplateRef<HTMLDivElement>('host')
const route = useRoute()
const toast = useToast()
const failure = ref('')
const handsOn = route.query.hands === '1'
const tool = ref<HandTool>('point')
const sawLine = ref<ScreenLine | null>(null)

const sculptor = useSculptor()
const { view, status: sculpting, problem: sculptorProblem, sessions } = sculptor
const sessionId = computed(() => typeof route.query.session === 'string' ? route.query.session : '')
// Where the open side panel covers the canvas; the stone keeps to what is left.
const inset = ref<HudInset>({ right: 0, bottom: 0 })
// The title plaque stands under the finished piece, not over it.
const PLAQUE_PX = 190
const room = computed(() => ({ right: inset.value.right, bottom: Math.max(inset.value.bottom, hudOn.value && view.value.phase === 'finished' ? PLAQUE_PX : 0) }))

const replay = useReplay()
const { runs, listProblem, run, passes, state: playback, problem: replayProblem } = replay
const picking = ref(false)
const replayId = computed(() => typeof route.query.replay === 'string' ? route.query.replay : '')
const wantedSpeed = Number(route.query.speed)
const firstSpeed: ReplaySpeed = route.query.speed === 'max' ? 'max' : wantedSpeed > 0 ? wantedSpeed : 30
const pass = computed(() => playback.value ? passes.value[playback.value.pass] : undefined)
const label = computed(() => run.value ? `${run.value.subject} · ${run.value.model} · ${run.value.tools} · ${run.value.ref ? 'reference' : 'no reference'}` : '')

// The commission HUD has the stage unless a study run, the demo or hand-carving does.
const replaying = computed(() => replayId.value !== '')
const hudOn = computed(() => !replaying.value && !handsOn && route.query.demo !== '1')
// A saved commission that is not being carved right now can be stepped through pass by pass.
const stepping = computed(() => hudOn.value && (sculpting.value === 'ended' || sculpting.value === 'viewing') && view.value.phase !== 'error')
const passCount = computed(() => stepping.value ? sculptor.state().passes : 0)
const passAt = ref(0)

let studio: StudioRenderer | null = null
let kernel: KernelClient | null = null
let stone: Stone | null = null
let hands: Hands | null = null
let camera: CameraRig | null = null
let charcoal: Charcoal | null = null
let stage: (ReplayStage & { camera: CameraRig, charcoal: Charcoal }) | null = null
// -- the film (Sprint 4): debris, tools, sound and the camera director --
let cinema: Cinema | null = null
const muted = ref(false)
function toggleSound() {
  cinema?.sound.unlock()
  cinema?.sound.setMuted(!muted.value)
  muted.value = cinema?.sound.muted ?? false
}
// -- end of the film --

watch(picking, (open) => {
  if (!open) return
  replay.refresh()
  sculptor.refreshSessions()
})

// Choosing a run, or going back, changes the query; the page stays and the stone starts over.
watch(replayId, (id) => {
  if (!stage) return
  if (id) {
    sculptor.release()
    replay.open(stage, id, { speed: playback.value?.speed ?? firstSpeed })
  } else {
    replay.close()
    if (!sessionId.value) sculptor.reset()
  }
})

// A session picked from the list (one the sculptor started itself is already on the stone).
watch(sessionId, (id) => {
  if (!stage || !id || id === sculptor.sessionId.value) return
  replay.close()
  sculptor.load(id)
})

watch(stepping, on => passAt.value = on ? passCount.value : 0)

function pick(id: string) {
  picking.value = false
  if (id === replayId.value) replay.player()?.restart()
  else navigateTo({ query: { ...route.query, replay: id, at: undefined, session: undefined, pass: undefined } })
}

function pickSession(id: string) {
  picking.value = false
  navigateTo({ query: { ...route.query, session: id, replay: undefined, at: undefined, pass: undefined } })
}

function toggle() {
  const player = replay.player()
  if (playback.value?.playing) player?.pause()
  else player?.play()
}

async function begin(request: StartRequest) {
  try {
    await sculptor.start({ commission: request.commission, model: request.model })
  } catch (e) {
    toast.add({ title: 'The commission could not start', description: e instanceof Error ? e.message : String(e), color: 'error', icon: 'i-lucide-triangle-alert' })
  }
}

async function stepTo(n: number) {
  const to = Math.max(1, Math.min(passCount.value, Math.round(n)))
  passAt.value = to
  try {
    await sculptor.replayTo(to - 1)
  } catch (e) {
    toast.add({ title: 'That pass could not be shown', description: e instanceof Error ? e.message : String(e), color: 'warning' })
  }
}

watch(tool, (t) => {
  if (hands) hands.tool = t
})

onMounted(async () => {
  // Nuxt's client-only wrapper renders a placeholder on the first pass, so the host div lands a tick later.
  await nextTick()
  if (!hostEl.value) return
  // ?fx=-dof,-godrays (or none, all) drops or adds post effects; ?dpr=1 caps the pixel ratio. Both are for measuring.
  const s = new StudioRenderer(hostEl.value, { forceWebGL: route.query.gl === '1', effects: effectsFromQuery(route.query.fx), maxPixelRatio: Number(route.query.dpr) || undefined })
  const k = new KernelClient()
  studio = s
  kernel = k
  let st: Stone
  // -- the film: remeshes that arrive before the film exists are kept for it (it fits the stone's boxes from them) --
  let film: Cinema | null = null
  let early: { rev: number, chunks: Parameters<Cinema['chunks']>[1] }[] | null = []
  // -- end of the film --
  try {
    // The block is built in the worker while the renderer picks its backend. The stone is wired up
    // in the same tick the worker reports ready, so the first mesh cannot arrive unheard.
    const built = k.init().then((grid) => {
      const made = new Stone(s, grid)
      // Only the shown stone is ever meshed; the true stone is the sculptor's and stays in the worker.
      k.onChunks = (_stone, rev, chunks) => {
        made.receive(rev, chunks)
        // -- the film --
        if (film) film.chunks(rev, chunks)
        else early?.push({ rev, chunks })
        // -- end of the film --
      }
      // The film's debris takes what comes off (the stone's own toy fall is only the fallback).
      k.onOffcuts = (_stone, rev, offcuts) => film ? film.offcuts(rev, offcuts) : made.shed(rev, offcuts)
      return made
    })
    // Awaited together, so neither can fail unobserved while the other is still starting.
    st = (await Promise.all([built, s.init()]))[0]
  } catch (e) {
    // Torn down mid-start (a hot reload, a navigation) is not a failure to report.
    if (studio === s) failure.value = e instanceof Error ? e.message : String(e)
    return
  }
  // Unmounted while the backend or the worker was starting.
  if (studio !== s) {
    st.dispose()
    return
  }
  stone = st
  const rig = new CameraRig(s)
  camera = rig
  // -- the film --
  // ?film=0 leaves the film out altogether, to measure what it costs.
  if (route.query.film !== '0') {
    film = cinema = new Cinema(s, st, k, rig)
    for (const e of early ?? []) film.chunks(e.rev, e.chunks)
    muted.value = film.sound.muted
  }
  early = null
  if (route.query.cam === 'free') rig.mode = 'free'
  // -- end of the film --

  if (handsOn) {
    rig.mode = 'free'
    hands = new Hands(s, st, k)
    hands.tool = tool.value
    hands.onSawLine = line => sawLine.value = line
    hands.onStrikes = strikes => film?.struck(strikes)
  }

  // A handle for the shoot script (and for poking at the studio from devtools).
  let demoRun: Promise<void> | null = null
  const handle = {
    stats: () => s.stats(),
    studio: () => s,
    /** A stone's grid hash: two stones with the same hash are the same stone. 'shown' if left out. */
    hash: async (which: StoneId = 'shown') => (await k.stats(true, which)).hash,
    /** A stone's rev and mass, and for the shown stone what its early island checks have cost. */
    kernel: (which: StoneId = 'shown') => k.stats(false, which),
    /** A sawn corner and rough, flat-chiselled and rasped patches. Runs once. */
    demo: () => demoRun ??= demo(s, k, st).then(() => film?.settled()),
    /** n rapid strikes; resolves with (and logs) frame-time stats. */
    burst: (n = 200) => burst(s, k, st, n, 2, strikes => film?.struck(strikes)),
    /** The film: debris, tools, sound, director. cinema().stats() says what each is doing and its budgets; slow(0.1) is bullet time for captures. */
    cinema: () => film,
    /** The ReplayPlayer of the run on the stage, or null. */
    replay: () => replay.player(),
    /** Plays the loaded run again from the start at `speed`; frame-time stats, as burst gives them. */
    timeReplay: (speed: ReplaySpeed = 30, seconds?: number) => {
      const player = replay.player()
      if (!player) throw new Error('no replay is loaded')
      return timeReplay(s, player, st, speed, seconds)
    },
    /** Starts a commission: start('a chess pawn') or start({ commission, model, reference }). */
    start: (options: string | { commission: string, model?: string, reference?: boolean }) => sculptor.start(typeof options === 'string' ? { commission: options } : options),
    /** Where the commission stands: status, turn, cost, queue depth, virtual time, clock rate, strikes shown and applied. */
    state: () => sculptor.state(),
    /** The commission itself: pause, resume, setSpeed, abort, load, replayTo, saved. */
    sculptor: () => sculptor,
    // -- the look (Sprint 4): the look book's camera presets --
    /** Puts the camera on a look-book preset (wide, medium, macro, raking, backlit), focuses, and holds it there. */
    look: (name: string) => applyLook(s, name),
    /** Carves the storyboard's frame-5 stone (three finishes and a thin fin); shoot it with look('frame5'). */
    frame5: () => carveFrame5(s, k, st),
    // -- end of the look --
    /** Times every frame until the returned stop() is called. */
    meter: () => frameMeter(s),
    /** How long a saved study run's log takes to put back on both stones. */
    timeRestore: (id: string) => sculptor.timeRestore(id)
  }
  const w = window as unknown as Record<string, unknown>
  w.__sculptor = handle

  // Ready means the whole stone has been meshed and frames with it in them have reached the canvas.
  await st.whenShown(0)
  if (route.query.demo === '1') await handle.demo()
  charcoal = new Charcoal(s)
  stage = { studio: s, kernel: k, stone: st, camera: rig, charcoal, cinema: film ?? undefined }
  await sculptor.attach(stage)
  if (replayId.value) {
    await replay.open(stage, replayId.value, { speed: firstSpeed, end: route.query.at === 'end' })
  } else if (sessionId.value) {
    const at = Number(route.query.pass)
    await sculptor.load(sessionId.value, at > 0 ? { pass: at - 1 } : {})
  } else if ('replay' in route.query) {
    picking.value = true
  }
  await s.rendered(3)
  if (studio === s) w.__sceneReady = true
})

onBeforeUnmount(() => {
  const w = window as unknown as Record<string, unknown>
  w.__sceneReady = false
  delete w.__sculptor
  hands?.dispose()
  cinema?.dispose()
  cinema = null
  camera?.dispose()
  charcoal?.dispose()
  stone?.dispose()
  kernel?.dispose()
  studio?.dispose()
  hands = null
  camera = null
  charcoal = null
  stage = null
  stone = null
  kernel = null
  studio = null
})
</script>

<template>
  <div class="fixed inset-0 overflow-hidden bg-[#0b0a09] select-none">
    <div
      ref="host"
      class="absolute top-0 left-0"
      :style="{ width: `calc(100% - ${room.right}px)`, height: `calc(100% - ${room.bottom}px)` }"
    />
    <svg
      v-if="sawLine"
      class="pointer-events-none absolute inset-0 size-full text-primary"
    >
      <line
        :x1="sawLine.x1"
        :y1="sawLine.y1"
        :x2="sawLine.x2"
        :y2="sawLine.y2"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-dasharray="6 4"
      />
    </svg>
    <HandPalette
      v-if="handsOn"
      v-model="tool"
    />
    <StudioHud
      v-if="hudOn"
      :view="view"
      @start="begin"
      @pause="sculptor.pause()"
      @resume="sculptor.resume()"
      @speed="sculptor.setSpeed($event)"
      @camera="sculptor.setCamera($event)"
      @abort="sculptor.abort()"
      @panel="sculptor.openPanel($event)"
      @reset="sculptor.reset()"
      @inset="inset = $event"
    />
    <!-- The stats bar has this corner while a commission is on the stone. -->
    <UButton
      v-if="!hudOn || view.phase === 'idle'"
      data-hud
      icon="i-lucide-film"
      label="Replays"
      color="neutral"
      variant="subtle"
      size="sm"
      class="absolute top-3 right-3 z-20"
      @click="picking = true"
    />
    <!-- the film: sound on or off. Lower right, clear of the transport and of an open side panel. -->
    <UButton
      v-if="route.query.film !== '0'"
      data-hud
      :icon="muted ? 'i-lucide-volume-x' : 'i-lucide-volume-2'"
      color="neutral"
      variant="subtle"
      size="sm"
      class="absolute bottom-3 z-20"
      :style="{ right: `${room.right + 12}px` }"
      :aria-label="muted ? 'Sound is off. Turn it on' : 'Sound is on. Turn it off'"
      :aria-pressed="!muted"
      @click="toggleSound"
    />
    <!-- end of the film -->
    <UFieldGroup
      v-if="stepping && passCount > 0"
      data-hud
      size="xs"
      class="absolute top-1/2 left-3 z-20 -translate-y-1/2"
      orientation="vertical"
    >
      <UButton
        icon="i-lucide-chevron-up"
        color="neutral"
        variant="subtle"
        aria-label="The pass after"
        :disabled="passAt >= passCount"
        @click="stepTo(passAt + 1)"
      />
      <UButton
        color="neutral"
        variant="subtle"
        class="justify-center tabular-nums"
        :label="`${passAt}/${passCount}`"
        aria-label="Back to the finished piece"
        @click="stepTo(passCount)"
      />
      <UButton
        icon="i-lucide-chevron-down"
        color="neutral"
        variant="subtle"
        aria-label="The pass before"
        :disabled="passAt <= 1"
        @click="stepTo(passAt - 1)"
      />
    </UFieldGroup>
    <ReplayPicker
      v-model:open="picking"
      :runs="runs"
      :sessions="sessions"
      :current="replayId || sessionId"
      :problem="listProblem"
      @pick="pick"
      @session="pickSession"
    />
    <div class="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 p-3">
      <UAlert
        v-if="replayProblem"
        data-hud
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="This run is not playing"
        :description="replayProblem"
        class="pointer-events-auto max-w-xl"
      />
      <template v-else-if="playback && run">
        <HudFinishCard
          v-if="playback.done && !playback.busy"
          :title="run.title ?? 'Untitled'"
          :statement="run.statement ?? `The sculptor did not call this one finished; the run stopped on ${run.ended}.`"
          class="pointer-events-auto lg:absolute lg:bottom-3 lg:left-3 lg:w-80"
        />
        <HudSubtitle
          v-else-if="pass"
          :text="pass.why"
          :tool="pass.tool"
        />
        <HudTransport
          :state="playback"
          :label="label"
          class="pointer-events-auto"
          @toggle="toggle"
          @restart="replay.player()?.restart()"
          @end="replay.player()?.end()"
          @speed="replay.player()?.setSpeed($event)"
        />
      </template>
    </div>
    <UAlert
      v-if="sculptorProblem && hudOn"
      data-hud
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :description="sculptorProblem"
      close
      class="absolute top-14 left-1/2 z-20 w-[min(36rem,calc(100%-1.5rem))] -translate-x-1/2 backdrop-blur"
      @update:open="sculptorProblem = ''"
    />
    <div
      v-if="failure"
      class="absolute inset-0 grid place-items-center p-8"
    >
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="The studio could not start a renderer"
        :description="failure"
        class="max-w-md"
      />
    </div>
  </div>
</template>
