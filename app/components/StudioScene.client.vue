<script setup lang="ts">
/**
 * Full-bleed studio canvas. The renderer and the kernel worker are created once on mount; the scene
 * code is plain .ts in ~/studio. Query flags:
 *   ?gl=1     force the WebGL 2 backend (the shoot script's --gl mode and the fallback check)
 *   ?hands=1  hand-carving: a tool palette, and strikes where you press on the stone
 *   ?demo=1   carve the fixed demo before the scene reports ready
 */
import { burst, demo } from '~/studio/debug'
import { Hands } from '~/studio/hands'
import type { HandTool, ScreenLine } from '~/studio/hands'
import { KernelClient } from '~/studio/kernel'
import { StudioRenderer } from '~/studio/renderer'
import { Stone } from '~/studio/stone'

const hostEl = useTemplateRef<HTMLDivElement>('host')
const route = useRoute()
const failure = ref('')
const handsOn = route.query.hands === '1'
const tool = ref<HandTool>('point')
const sawLine = ref<ScreenLine | null>(null)

let studio: StudioRenderer | null = null
let kernel: KernelClient | null = null
let stone: Stone | null = null
let hands: Hands | null = null

watch(tool, (t) => {
  if (hands) hands.tool = t
})

onMounted(async () => {
  // Nuxt's client-only wrapper renders a placeholder on the first pass, so the host div lands a tick later.
  await nextTick()
  if (!hostEl.value) return
  const s = new StudioRenderer(hostEl.value, { forceWebGL: route.query.gl === '1' })
  const k = new KernelClient()
  studio = s
  kernel = k
  let st: Stone
  try {
    // The block is built in the worker while the renderer picks its backend. The stone is wired up
    // in the same tick the worker reports ready, so the first mesh cannot arrive unheard.
    const built = k.init().then((grid) => {
      const made = new Stone(s, grid)
      k.onChunks = (_stone, rev, chunks) => made.receive(rev, chunks)
      k.onOffcuts = (_stone, rev, offcuts) => made.shed(rev, offcuts)
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

  if (handsOn) {
    hands = new Hands(s, st, k)
    hands.tool = tool.value
    hands.onSawLine = line => sawLine.value = line
  }

  // A handle for the shoot script (and for poking at the studio from devtools).
  let demoRun: Promise<void> | null = null
  const handle = {
    stats: () => s.stats(),
    studio: () => s,
    /** The worker's grid hash: two stones with the same hash are the same stone. */
    hash: async () => (await k.stats(true)).hash,
    /** A sawn corner and rough, flat-chiselled and rasped patches. Runs once. */
    demo: () => demoRun ??= demo(s, k, st),
    /** n rapid strikes; resolves with (and logs) frame-time stats. */
    burst: (n = 200) => burst(s, k, st, n)
  }
  const w = window as unknown as Record<string, unknown>
  w.__sculptor = handle

  // Ready means the whole stone has been meshed and frames with it in them have reached the canvas.
  await st.whenShown(0)
  if (route.query.demo === '1') await handle.demo()
  await s.rendered(3)
  if (studio === s) w.__sceneReady = true
})

onBeforeUnmount(() => {
  const w = window as unknown as Record<string, unknown>
  w.__sceneReady = false
  delete w.__sculptor
  hands?.dispose()
  stone?.dispose()
  kernel?.dispose()
  studio?.dispose()
  hands = null
  stone = null
  kernel = null
  studio = null
})
</script>

<template>
  <div class="fixed inset-0 overflow-hidden bg-[#0b0a09] select-none">
    <div
      ref="host"
      class="absolute inset-0"
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
