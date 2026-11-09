<script setup lang="ts">
/**
 * The HUD on its own, over a drawn stand-in for the canvas: no three.js, no worker, no model.
 * Each storyboard frame is a mock view (mockView in ~/studio/viewState) and the controls work
 * against it locally, so the HUD can be felt and screenshotted without a commission running.
 *   ?frame=1|2|3|4|6  the storyboard frame to open on
 *   ?panel=notebook|eye  open that side panel
 *   ?bare=1  no frame switcher and nothing ticking, for screenshots
 *   ?stress=1  the awkward cases: a long commission, a four-line subtitle, a budget nearly spent,
 *              and (on frame 1) no gateway key
 */
import type { PassRecord } from '#shared/agent/types'
import { applyLoopEvent, mockView, setPanel, showPass, STORY_FRAMES } from '~/studio/viewState'
import type { CameraMode, HudInset, SculptorView, SidePanel, StartRequest, StoryFrame } from '~/studio/viewState'

const route = useRoute()
const toast = useToast()
const bare = route.query.bare === '1'

const asFrame = (q: unknown): StoryFrame => STORY_FRAMES.find(f => String(f.frame) === q)?.frame ?? 1
const frame = ref<StoryFrame>(asFrame(route.query.frame))
const view = shallowRef<SculptorView>(mockView(frame.value))

function open(next: StoryFrame) {
  frame.value = next
  view.value = mockView(next)
}
if (route.query.panel === 'notebook' || route.query.panel === 'eye') view.value = setPanel(view.value, route.query.panel)
if (route.query.stress === '1') {
  const v = view.value
  view.value = {
    ...v,
    gateway: false,
    commission: v.commission && 'A portrait bust of a Roman senator in late middle age: head, neck and shoulders, facing forward, on a plain square base, unimpressed',
    stats: { ...v.stats, turns: 55, costUsd: 7.31, budget: 'warn90', strikes: 128_402, elapsedVirtualMs: 5_025_000, behindMs: 95_000 },
    subtitle: v.subtitle && { ...v.subtitle, text: 'Cutting the shoulders down to their slope and freeing the neck, and taking the boxy corners off under the chest, then coming back along the collarbone with the claw so that the whole upper mass turns into the plinth without a ledge anywhere a shadow could catch.' }
  }
}

// Where the HUD's open panel covers the canvas; the stand-in scene keeps to what is left, as the camera should.
const inset = ref<HudInset>({ right: 0, bottom: 0 })

// A few real passes of different lengths, so the subtitle can be watched changing.
const LINES: Pick<PassRecord, 'tool' | 'args' | 'why'>[] = [
  { tool: 'rough_out', args: { tool: 'point' }, why: 'Knocking the big waste off all round to find the bust\'s envelope, leaving a safe skin.' },
  { tool: 'saw', args: {}, why: 'Taking the top slab off; the head doesn\'t need it.' },
  { tool: 'rough_out', args: { tool: 'point' }, why: 'Cutting the shoulders down to their slope and freeing the neck, and taking the boxy corners off under the chest.' },
  { tool: 'chisel', args: { tool: 'claw' }, why: 'And the left cheek to match.' },
  { tool: 'rasp', args: {}, why: 'Easing the hard chisel ridges off the face so the planes start to flow into each other.' }
]

// The stand-in for the timeline: while a frame is carving and not paused, the clock, the strike
// count and the subtitle move at the chosen speed.
let line = 0
let since = 0
const TICK_MS = 250
const timer = bare
  ? undefined
  : setInterval(() => {
      const v = view.value
      if (v.phase !== 'carving' || v.transport.paused || frame.value === 2) return
      const stats = { ...v.stats, elapsedVirtualMs: v.stats.elapsedVirtualMs + TICK_MS * v.transport.speed, strikes: v.stats.strikes + Math.max(1, Math.round(v.transport.speed / 4)) }
      since += TICK_MS
      if (since >= 4000) {
        since = 0
        line = (line + 1) % LINES.length
        view.value = { ...showPass(v, LINES[line]!), stats }
      } else {
        view.value = { ...v, stats }
      }
    }, TICK_MS)
onBeforeUnmount(() => clearInterval(timer))

function start(request: StartRequest) {
  frame.value = 2
  view.value = { ...mockView(2), commission: request.commission, model: request.model, stone: request.stone }
  toast.add({ title: 'Commission accepted', description: 'The sculptor is sketching.', color: 'success', icon: 'i-lucide-check' })
}

const transport = (change: Partial<SculptorView['transport']>) => view.value = { ...view.value, transport: { ...view.value.transport, ...change } }
const camera = (mode: CameraMode) => transport({ cameraMode: mode })
const panel = (next: SidePanel | null) => view.value = setPanel(view.value, next)

function abort() {
  const stopped = applyLoopEvent(view.value, { type: 'finish', turn: view.value.stats.turns, ended: 'aborted', title: null, statement: null })
  view.value = { ...stopped, phase: 'finished', subtitle: null, panel: stopped.panel === 'eye' ? null : stopped.panel }
}

// What the placeholder stone looks like at each frame: the block, the block roughed, the bust.
const shape = computed(() => frame.value <= 2 || view.value.phase === 'idle' ? 'block' : frame.value === 3 ? 'rough' : 'bust')
</script>

<template>
  <div class="fixed inset-0 overflow-hidden bg-[#0b0a09] select-none">
    <svg
      viewBox="0 0 800 450"
      preserveAspectRatio="xMidYMid meet"
      class="absolute top-0 left-0 bg-[radial-gradient(circle_at_38%_30%,#3a352e,#16151a_55%,#050506)] transition-[width,height] duration-200 ease-out"
      :style="{ width: `calc(100% - ${inset.right}px)`, height: `calc(100% - ${inset.bottom}px)` }"
      aria-hidden="true"
    >
      <g transform="translate(0 -52)">
        <polygon
          points="0,0 250,0 620,450 240,450"
          fill="#ffe9c4"
          opacity=".08"
        />
        <ellipse
          cx="400"
          cy="408"
          rx="250"
          ry="34"
          fill="#000"
          opacity=".5"
        />
        <rect
          x="296"
          y="360"
          width="208"
          height="16"
          fill="#6b5137"
        />
        <rect
          x="310"
          y="376"
          width="180"
          height="46"
          fill="#4b3826"
        />
        <template v-if="shape === 'block'">
          <polygon
            points="320,130 480,130 510,112 350,112"
            fill="#f6f3ec"
          />
          <polygon
            points="480,130 510,112 510,342 480,360"
            fill="#bcb5a7"
          />
          <rect
            x="320"
            y="130"
            width="160"
            height="230"
            fill="#ece8df"
          />
        </template>
        <template v-else-if="shape === 'rough'">
          <polygon
            points="352,128 448,128 470,116 374,116"
            fill="#f6f3ec"
          />
          <polygon
            points="448,128 470,116 498,170 498,342 480,360 480,172"
            fill="#bcb5a7"
          />
          <polygon
            points="352,128 448,128 480,172 480,360 320,360 320,250 338,176"
            fill="#ece8df"
          />
        </template>
        <template v-else>
          <polygon
            points="372,140 428,140 446,168 446,214 428,240 420,266 462,284 478,312 480,360 320,360 322,312 338,284 380,266 372,240 354,214 354,168"
            fill="#e6e1d6"
          />
          <polygon
            points="428,140 446,168 446,214 428,240 420,266 462,284 478,312 480,360 452,360 448,300 414,270 420,236 432,212 432,170"
            fill="#c2bbad"
          />
        </template>
      </g>
    </svg>

    <StudioHud
      :view="view"
      @start="start"
      @pause="transport({ paused: true })"
      @resume="transport({ paused: false })"
      @speed="transport({ speed: $event })"
      @camera="camera"
      @abort="abort"
      @panel="panel"
      @reset="open(1)"
      @inset="inset = $event"
    />

    <UFieldGroup
      v-if="!bare"
      orientation="vertical"
      size="xs"
      class="fixed top-[38%] left-3 z-20 -translate-y-1/2"
    >
      <UTooltip
        v-for="f in STORY_FRAMES"
        :key="f.frame"
        :text="`Frame ${f.frame}: ${f.label}`"
        :content="{ side: 'right' }"
      >
        <UButton
          :label="String(f.frame)"
          color="neutral"
          :variant="frame === f.frame ? 'solid' : 'subtle'"
          :aria-label="`Storyboard frame ${f.frame}: ${f.label}`"
          :aria-pressed="frame === f.frame"
          @click="open(f.frame)"
        />
      </UTooltip>
    </UFieldGroup>
  </div>
</template>
