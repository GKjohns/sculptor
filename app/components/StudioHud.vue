<script setup lang="ts">
/**
 * The whole film-style HUD over the canvas, drawn from one prop. It holds no state of the
 * commission: every control emits, and the engine answers by passing a changed view back in
 * (see ~/studio/viewState for the view, the events and the helpers that change one).
 *
 * Layout: the brand and commission top left with the stage list under it, the stats top right with
 * the pinned sketches under them, the subtitle over the transport at the bottom centre, and one
 * side panel (notebook or sculptor's eye) in a non-modal USlideover: down the right on a wide
 * screen, a sheet over the lower half in a narrow pane. While the panel is open everything else
 * keeps clear of it (and `inset` says how much of the canvas it covers); in a narrow pane the
 * subtitle steps aside too, since the open panel says the same thing. Only the panels take the
 * pointer; the canvas gets the rest.
 */
import { finishFallback } from '~/studio/viewState'
import type { HudEvents, HudInset, LookView, SculptorView } from '~/studio/viewState'
import type { ReplaySpeed } from '~/studio/replay'

const props = defineProps<{ view: SculptorView }>()
const emit = defineEmits<HudEvents>()

// The same line the padding classes below break on (Tailwind's lg).
const query = window.matchMedia('(min-width: 64rem)')
const wide = ref(query.matches)
const sync = () => wide.value = query.matches
onMounted(() => query.addEventListener('change', sync))
onBeforeUnmount(() => query.removeEventListener('change', sync))

const running = computed(() => props.view.phase !== 'idle')
const over = computed(() => props.view.phase === 'finished' || props.view.phase === 'error')
const model = computed(() => props.view.models.find(m => m.key === props.view.model)?.label ?? props.view.model)
const stone = computed(() => props.view.stones.find(s => s.key === props.view.stone)?.label ?? props.view.stone)

// Said in the subtitle's place while nobody is speaking.
const waiting = computed(() => {
  if (props.view.notice) return props.view.notice
  if (props.view.transport.paused) return ''
  return props.view.phase === 'thinking' ? 'The sculptor is thinking' : props.view.phase === 'preparing' ? 'Setting up the studio' : ''
})

// A narrow pane with the sheet open has room for the stone or the subtitle, not both.
const roomForWords = computed(() => wide.value || !props.view.panel)

const plaque = computed(() => {
  const finish = props.view.finish
  if (!finish) return null
  const day = new Date(finish.finishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  return {
    title: finish.title ?? 'Untitled',
    statement: finish.statement ?? finishFallback(finish.ended),
    meta: [model.value, stone.value, day].filter(Boolean).join(' · ')
  }
})

// A look picked out of the notebook, shown in the eye until the next look or until the panel changes.
const picked = shallowRef<LookView | null>(null)
watch(() => [props.view.eye, props.view.panel], ([, panel]) => {
  if (panel !== 'eye') picked.value = null
})
watch(() => props.view.eye, () => picked.value = null)
const look = computed(() => picked.value ?? props.view.eye)

function pick(found: LookView) {
  picked.value = found
  emit('panel', 'eye')
}

function speed(next: ReplaySpeed) {
  if (typeof next === 'number') emit('speed', next)
}

// How much of the canvas the open panel covers, in CSS pixels, so the engine can keep the stone
// in what is left (a camera view offset). Matches --hud-panel in main.css and the sheet's height.
const GAP = 24
function measure(): HudInset {
  if (!props.view.panel) return { right: 0, bottom: 0 }
  if (wide.value) return { right: Math.round(Math.min(Math.max(336, window.innerWidth * 0.31), 440)) + GAP, bottom: 0 }
  return { right: 0, bottom: Math.round(window.innerHeight * 0.46) + GAP }
}
let last = ''
function report() {
  const inset = measure()
  const key = `${inset.right},${inset.bottom}`
  if (key !== last) emit('inset', inset)
  last = key
}
watch([() => props.view.panel, wide], report)
onMounted(() => {
  report()
  window.addEventListener('resize', report)
})
onBeforeUnmount(() => window.removeEventListener('resize', report))

// The panel opens without taking the keyboard focus from wherever it was.
const quiet = { onOpenAutoFocus: (e: Event) => e.preventDefault(), onCloseAutoFocus: (e: Event) => e.preventDefault() }

const PANEL = {
  header: 'min-h-0 gap-1 px-3 py-2 sm:px-3',
  wrapper: 'min-w-0 flex-1',
  title: 'truncate text-[11px] font-medium tracking-wider text-muted uppercase',
  close: 'static',
  body: 'p-3 sm:p-3'
}
const SIDES = {
  right: { ...PANEL, content: 'pointer-events-auto inset-y-3 right-3 w-(--hud-panel) max-w-none bg-elevated/90 shadow-lg ring ring-default backdrop-blur sm:max-w-none' },
  bottom: { ...PANEL, content: 'pointer-events-auto inset-x-3 bottom-3 h-[46dvh] max-h-none bg-elevated/90 shadow-lg ring ring-default backdrop-blur' }
}
</script>

<template>
  <div
    data-hud
    class="pointer-events-none fixed inset-0 z-10 flex flex-col gap-2 p-3 transition-[padding] duration-200 ease-out"
    :class="view.panel ? 'max-lg:pb-[calc(46dvh+1.5rem)] lg:pr-[calc(var(--hud-panel)+1.5rem)]' : ''"
  >
    <header class="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
      <div class="hud-glass pointer-events-auto col-span-2 flex max-w-full min-w-0 items-baseline gap-1.5 justify-self-start px-2.5 py-1.5 text-xs lg:col-span-1">
        <span class="font-semibold tracking-wide text-highlighted">Sculptor</span>
        <template v-if="view.commission">
          <span class="text-dimmed">·</span>
          <span
            class="truncate text-default"
            :title="view.commission"
          >{{ view.commission }}</span>
        </template>
      </div>
      <template v-if="running">
        <HudStatsBar
          :stats="view.stats"
          :model="model"
          class="pointer-events-auto col-span-2 lg:col-span-1 lg:justify-self-end"
        />
        <template v-if="view.phase !== 'finished'">
          <HudStageList
            v-if="wide"
            :stages="view.stages"
            class="pointer-events-auto col-start-1 justify-self-start"
          />
          <HudStageList
            v-else
            :stages="view.stages"
            compact
            class="pointer-events-auto col-start-1 max-w-full justify-self-start"
          />
          <HudPinnedSketches
            :sketches="view.sketches"
            :block="view.block"
            class="pointer-events-auto col-start-2 justify-self-end"
          />
        </template>
      </template>
    </header>

    <div class="min-h-0 flex-1" />

    <footer class="flex flex-col items-center gap-2">
      <HudCommissionCard
        v-if="view.phase === 'idle'"
        :models="view.models"
        :stones="view.stones"
        :examples="view.examples"
        :model="view.model"
        :stone="view.stone"
        :gateway="view.gateway"
        class="pointer-events-auto lg:mb-[9dvh]"
        @start="emit('start', $event)"
      />
      <template v-else>
        <UAlert
          v-if="view.phase === 'error'"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="The commission stopped"
          :description="view.error ?? 'Something went wrong and the sculptor could not carry on.'"
          class="pointer-events-auto max-w-xl backdrop-blur"
          :ui="{ description: 'line-clamp-4 wrap-anywhere' }"
        />
        <HudFinishCard
          v-else-if="view.phase === 'finished' && plaque"
          centered
          :title="plaque.title"
          :meta="plaque.meta"
          :statement="plaque.statement"
          class="pointer-events-auto"
        />
        <HudSubtitle
          v-else-if="view.subtitle && roomForWords"
          :text="view.subtitle.text"
          :label="view.subtitle.label"
        />
        <HudSubtitle
          v-else-if="waiting && roomForWords"
          :text="waiting"
          pending
        />
        <HudTransport
          :live="view.transport"
          :panel="view.panel"
          :can-look="!!view.eye"
          :ended="over"
          class="pointer-events-auto"
          @toggle="view.transport.paused ? emit('resume') : emit('pause')"
          @speed="speed"
          @camera="emit('camera', $event)"
          @panel="emit('panel', $event)"
          @abort="emit('abort')"
          @reset="emit('reset')"
        />
      </template>
    </footer>

    <USlideover
      :open="!!view.panel"
      :side="wide ? 'right' : 'bottom'"
      :modal="false"
      :overlay="false"
      :dismissible="false"
      :portal="false"
      inset
      :title="view.panel === 'eye' ? 'What the sculptor sees' : 'Sculptor\'s notebook'"
      :close="{ size: 'xs' }"
      :content="quiet"
      :ui="wide ? SIDES.right : SIDES.bottom"
      @update:open="(open: boolean) => { if (!open) emit('panel', null) }"
    >
      <template #actions>
        <UButton
          v-if="view.panel === 'eye'"
          icon="i-lucide-notebook-pen"
          color="neutral"
          variant="ghost"
          size="xs"
          label="Notebook"
          @click="emit('panel', 'notebook')"
        />
        <UButton
          v-else-if="view.eye"
          icon="i-lucide-eye"
          color="neutral"
          variant="ghost"
          size="xs"
          label="Eye"
          aria-label="Sculptor's eye"
          @click="emit('panel', 'eye')"
        />
      </template>
      <template #body>
        <template v-if="view.panel === 'eye'">
          <template v-if="look">
            <UButton
              v-if="picked && view.eye"
              icon="i-lucide-arrow-left"
              color="neutral"
              variant="link"
              size="xs"
              label="Back to the latest look"
              class="mb-2 p-0"
              @click="picked = null"
            />
            <HudSculptorsEye
              :look="look"
              :reference-image="picked ? undefined : view.eye?.referenceImage"
            />
          </template>
          <UEmpty
            v-else
            icon="i-lucide-eye"
            title="The sculptor has not looked yet"
            description="When it steps back to look, the exact sheet it was sent shows here."
            variant="naked"
            size="sm"
          />
        </template>
        <HudNotebook
          v-else-if="view.panel === 'notebook'"
          :entries="view.notebook"
          :live="running && !over"
          @look="pick"
        />
      </template>
    </USlideover>
  </div>
</template>
