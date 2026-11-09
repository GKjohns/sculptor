<script setup lang="ts">
/**
 * Transport for whatever is playing on the stone. One compact bar that still fits a pane 350 px wide.
 * Given `state` it is the replay's: restart, play or pause, skip to the end, speed, a scrubber over
 * the whole log (let go and the stone is as it stood there; going back replays from a fresh block),
 * and film export at a choice of lengths. Given `live` it is a commission's: pause, speed, who has the camera, the two side
 * panels and a way to stop. With `ended` the live bar keeps only the panels and a new commission.
 */
import { passAt, passStarts } from '#shared/agent/replay'
import type { ReplayPass } from '#shared/agent/replay'
import { FILM_LENGTHS } from '~/studio/film'
import { REPLAY_SPEEDS } from '~/studio/replay'
import type { ReplaySpeed, ReplayState } from '~/studio/replay'
import type { CameraMode, SidePanel, TransportView } from '~/studio/viewState'

const props = defineProps<{
  state?: ReplayState
  label?: string
  live?: TransportView
  // The side panel that is open, and whether there is a look to show in the eye.
  panel?: SidePanel | null
  canLook?: boolean
  ended?: boolean
  // A finished commission: it can be watched again on the replay page.
  replayable?: boolean
  // The replay's pass record, for the scrubber's labels; and whether a film is being made.
  passes?: ReplayPass[]
  filming?: boolean
}>()
const emit = defineEmits<{
  toggle: []
  restart: []
  end: []
  speed: [speed: ReplaySpeed]
  camera: [mode: CameraMode]
  panel: [panel: SidePanel | null]
  abort: []
  reset: []
  seek: [to: number]
  film: [seconds: number]
  replay: []
}>()

// The listed speeds, plus whatever ?speed= asked for if it is not one of them.
const speeds = computed(() => {
  const now = props.state?.speed ?? 1
  const all = REPLAY_SPEEDS.includes(now) ? REPLAY_SPEEDS : [...REPLAY_SPEEDS, now]
  return all.map(s => ({ label: s === 'max' ? 'Max' : `${s}×`, value: s }))
})
const speed = computed({ get: () => props.state?.speed ?? 1, set: s => emit('speed', s) })
const count = (n: number) => n.toLocaleString('en-US')

// The live speed is a slider over the listed stops; a speed that is not listed sits at the nearest.
const stop = computed({
  get() {
    const list = props.live?.speeds ?? []
    const now = props.live?.speed ?? 1
    return list.reduce((best, s, i) => Math.abs(s - now) < Math.abs(list[best]! - now) ? i : best, 0)
  },
  set(i: number | undefined) {
    const next = props.live?.speeds[i ?? 0]
    if (next !== undefined && next !== props.live?.speed) emit('speed', next)
  }
})
// The scrubber follows the stone until it is grabbed; let go and the stone goes there.
const grabbed = ref<number | null>(null)
const scrub = computed({
  get: () => grabbed.value ?? props.state?.applied ?? 0,
  set: (v: number | undefined) => grabbed.value = v ?? 0
})
function letGo() {
  if (grabbed.value === null) return
  emit('seek', grabbed.value)
  grabbed.value = null
}
const starts = computed(() => props.passes && props.state ? passStarts(props.passes, props.state.total) : null)
// The pass at the scrubber's position: the one being dragged over, or the one on the stone.
const at = computed(() => {
  const s = props.state
  if (!s) return null
  if (grabbed.value === null) return s.passes ? { index: s.pass, pass: props.passes?.[s.pass] } : null
  const index = starts.value ? passAt(starts.value, Math.max(0, grabbed.value - 1)) : -1
  return index >= 0 ? { index, pass: props.passes?.[index] } : null
})
const films = computed(() => [FILM_LENGTHS.map(seconds => ({
  label: seconds < 60 ? `${seconds}-second film` : seconds === 60 ? 'One-minute film' : `${seconds / 60}-minute film`,
  icon: 'i-lucide-clapperboard',
  onSelect: () => emit('film', seconds)
}))])

const more = computed(() => [[{ label: 'Stop the commission', icon: 'i-lucide-square', color: 'error' as const, onSelect: () => emit('abort') }]])
const flip = (which: SidePanel) => emit('panel', props.panel === which ? null : which)
</script>

<template>
  <div
    v-if="live"
    data-hud
    class="hud-glass flex max-w-full items-center gap-1.5 px-2 py-1.5"
  >
    <template v-if="!ended">
      <UButton
        :icon="live.paused ? 'i-lucide-play' : 'i-lucide-pause'"
        color="primary"
        variant="soft"
        size="sm"
        :aria-label="live.paused ? 'Resume' : 'Pause'"
        @click="emit('toggle')"
      >
        <span class="max-sm:hidden">{{ live.paused ? 'Resume' : 'Pause' }}</span>
      </UButton>
      <label class="flex items-center gap-2 pl-1 text-xs text-muted">
        <span class="max-sm:hidden">Speed</span>
        <USlider
          v-model="stop"
          :min="0"
          :max="Math.max(1, live.speeds.length - 1)"
          :step="1"
          size="xs"
          aria-label="Speed"
          class="w-14 sm:w-24"
        />
        <b class="w-7 font-medium text-highlighted tabular-nums">{{ live.speed }}×</b>
      </label>
      <UTooltip :text="live.cameraMode === 'auto' ? 'The director has the camera. Drag the stone, or press this, to take it.' : 'You have the camera. Press to hand it back to the director.'">
        <UButton
          :icon="live.cameraMode === 'auto' ? 'i-lucide-clapperboard' : 'i-lucide-hand'"
          color="neutral"
          variant="ghost"
          size="sm"
          :aria-label="live.cameraMode === 'auto' ? 'Camera: director. Take the camera' : 'Camera: free. Hand it back to the director'"
          @click="emit('camera', live.cameraMode === 'auto' ? 'free' : 'auto')"
        >
          <span class="max-sm:hidden">Camera: {{ live.cameraMode === 'auto' ? 'Director' : 'Free' }}</span>
        </UButton>
      </UTooltip>
    </template>
    <UButton
      icon="i-lucide-notebook-pen"
      color="neutral"
      :variant="panel === 'notebook' ? 'soft' : 'ghost'"
      size="sm"
      aria-label="Notebook"
      :aria-pressed="panel === 'notebook'"
      @click="flip('notebook')"
    >
      <span class="max-sm:hidden">Notebook</span>
    </UButton>
    <UButton
      icon="i-lucide-eye"
      color="neutral"
      :variant="panel === 'eye' ? 'soft' : 'ghost'"
      size="sm"
      aria-label="Sculptor's eye"
      :aria-pressed="panel === 'eye'"
      :disabled="!canLook"
      @click="flip('eye')"
    >
      <span class="max-sm:hidden">Sculptor's eye</span>
    </UButton>
    <UButton
      v-if="ended && replayable"
      icon="i-lucide-film"
      color="neutral"
      variant="ghost"
      size="sm"
      aria-label="Replay, scrub and export a film"
      @click="emit('replay')"
    >
      <span class="max-sm:hidden">Replay</span>
    </UButton>
    <UButton
      v-if="ended"
      icon="i-lucide-plus"
      color="primary"
      variant="soft"
      size="sm"
      label="New commission"
      @click="emit('reset')"
    />
    <UDropdownMenu
      v-else
      :items="more"
      :content="{ side: 'top', align: 'end' }"
    >
      <UButton
        icon="i-lucide-ellipsis"
        color="neutral"
        variant="ghost"
        size="sm"
        aria-label="More"
      />
    </UDropdownMenu>
  </div>
  <div
    v-else-if="state"
    data-hud
    class="hud-glass w-full max-w-xl px-2.5 py-2"
  >
    <div class="flex items-center gap-1.5">
      <UButton
        icon="i-lucide-rotate-ccw"
        color="neutral"
        variant="ghost"
        size="sm"
        aria-label="Restart"
        :disabled="filming"
        @click="emit('restart')"
      />
      <UButton
        :icon="state.playing ? 'i-lucide-pause' : 'i-lucide-play'"
        color="primary"
        variant="soft"
        size="sm"
        :loading="state.busy"
        :disabled="state.busy || filming"
        :aria-label="state.playing ? 'Pause' : state.done ? 'Play again' : 'Play'"
        @click="emit('toggle')"
      />
      <UButton
        icon="i-lucide-skip-forward"
        color="neutral"
        variant="ghost"
        size="sm"
        aria-label="Skip to the end"
        :disabled="state.busy || state.done || filming"
        @click="emit('end')"
      />
      <USelect
        v-model="speed"
        :items="speeds"
        size="sm"
        aria-label="Speed"
        class="w-20"
        :disabled="filming"
      />
      <span
        v-if="at"
        class="ml-auto truncate text-xs whitespace-nowrap text-muted tabular-nums"
      >Pass {{ at.index + 1 }} of {{ state.passes }}<template v-if="at.pass"> · {{ at.pass.tool.replace('_', ' ') }}</template></span>
      <UDropdownMenu
        :items="films"
        :content="{ side: 'top', align: 'end' }"
        :disabled="filming || state.busy"
      >
        <UButton
          icon="i-lucide-film"
          color="neutral"
          variant="ghost"
          size="sm"
          :class="at ? '' : 'ml-auto'"
          :loading="filming"
          :disabled="filming || state.busy"
          aria-label="Export film"
        >
          <span class="max-sm:hidden">Export film</span>
        </UButton>
      </UDropdownMenu>
    </div>
    <USlider
      v-model="scrub"
      :min="0"
      :max="Math.max(1, state.total)"
      :step="1"
      size="xs"
      class="mt-2.5 mb-1"
      aria-label="Replay position"
      :disabled="filming || state.busy"
      @change="letGo"
    />
    <div class="mt-1.5 flex items-baseline justify-between gap-3 text-xs text-muted">
      <span class="truncate">{{ label }}</span>
      <span class="whitespace-nowrap tabular-nums">Strike {{ count(scrub) }} of {{ count(state.total) }}</span>
    </div>
  </div>
</template>
