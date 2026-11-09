<script setup lang="ts">
/**
 * The plaque shown once the piece is done: the title the sculptor gave it, who carved it from what
 * and when, and the sculptor's statement. The parent places it: stacked over the transport in a
 * narrow pane, beside the stone in a wide one. `centered` is the storyboard's plaque; the replay
 * viewer keeps the left-aligned card.
 */
defineProps<{ title: string, statement?: string | null, meta?: string, centered?: boolean }>()
</script>

<template>
  <div
    data-hud
    class="hud-glass w-full max-w-xl px-3.5 py-2.5"
    :class="centered ? 'text-center' : ''"
  >
    <p class="font-semibold text-balance text-highlighted sm:text-lg/snug">
      {{ title }}
    </p>
    <p
      v-if="meta"
      class="mt-0.5 truncate text-xs text-muted"
    >
      {{ meta }}
    </p>
    <p
      v-if="statement"
      class="mt-1.5 max-h-28 overflow-y-auto text-xs/relaxed text-pretty text-toned sm:text-sm/relaxed lg:max-h-none"
    >
      {{ statement }}
    </p>
  </div>
</template>
