<script setup lang="ts">
/**
 * Transport for whatever is playing on the stone. One compact bar that still fits a pane 350 px wide.
 * Given `state` it is the replay's: restart, play or pause, skip to the end, speed, and how far along
 * the log it is. Given `live` it is a commission's: pause, speed, who has the camera, the two side
 * panels and a way to stop. With `ended` the live bar keeps only the panels and a new commission.
 */
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
        @click="emit('restart')"
      />
      <UButton
        :icon="state.playing ? 'i-lucide-pause' : 'i-lucide-play'"
        color="primary"
        variant="soft"
        size="sm"
        :loading="state.busy"
        :disabled="state.busy"
        :aria-label="state.playing ? 'Pause' : state.done ? 'Play again' : 'Play'"
        @click="emit('toggle')"
      />
      <UButton
        icon="i-lucide-skip-forward"
        color="neutral"
        variant="ghost"
        size="sm"
        aria-label="Skip to the end"
        :disabled="state.busy || state.done"
        @click="emit('end')"
      />
      <USelect
        v-model="speed"
        :items="speeds"
        size="sm"
        aria-label="Speed"
        class="w-20"
      />
      <span
        v-if="state.passes"
        class="ml-auto text-xs whitespace-nowrap text-muted tabular-nums"
      >Pass {{ state.pass + 1 }} of {{ state.passes }}</span>
    </div>
    <UProgress
      :model-value="state.applied"
      :max="state.total"
      size="xs"
      class="mt-2"
    />
    <div class="mt-1.5 flex items-baseline justify-between gap-3 text-xs text-muted">
      <span class="truncate">{{ label }}</span>
      <span class="whitespace-nowrap tabular-nums">Strike {{ count(state.applied) }} of {{ count(state.total) }}</span>
    </div>
  </div>
</template>
