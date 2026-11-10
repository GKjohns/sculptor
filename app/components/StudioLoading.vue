<script setup lang="ts">
/**
 * Covers the studio while it starts: the renderer, the block meshed in the worker, the commission or
 * replay put on the stage, every material's pipelines built. It continues spa-loading-template.html
 * in the same place and fades once the stone has reached the canvas. CSS transitions only, so it keeps
 * moving through the long tasks underneath.
 */
defineProps<{
  /** Whether the studio is still starting. */
  loading: boolean
  /** What it is doing now. */
  caption: string
  /** How far along, 0 to 1. */
  progress: number
}>()
</script>

<template>
  <Transition
    leave-active-class="transition-opacity duration-700 ease-out"
    leave-to-class="opacity-0"
  >
    <div
      v-if="loading"
      data-hud
      data-loading
      class="absolute inset-0 z-40 grid place-items-center bg-[#0b0a09]"
      role="status"
      aria-live="polite"
    >
      <div class="flex flex-col items-center gap-3.5">
        <b class="pl-[0.32em] text-[13px] font-semibold tracking-[0.32em] text-stone-200 uppercase">Sculptor</b>
        <i class="relative block h-px w-40 overflow-hidden bg-white/10">
          <span
            class="absolute inset-y-0 left-0 bg-amber-400 transition-[width] duration-500 ease-out"
            :style="{ width: `${Math.round(progress * 100)}%` }"
          />
        </i>
        <span class="text-xs text-stone-400">{{ caption }}</span>
      </div>
    </div>
  </Transition>
</template>
