<script setup lang="ts">
/**
 * The sculptor's own sentence for the pass on screen, as a film subtitle, with the tool in hand.
 * `label` is the small line over it; left out, the tool's name stands in (the replay viewer does that).
 * `pending` shimmers the sentence: nobody is speaking yet, the studio is waiting on something.
 * The block keeps room for three lines and grows upward from its bottom edge, so a longer sentence
 * moves nothing below or beside it.
 */
const props = defineProps<{ text: string, tool?: string, label?: string, pending?: boolean }>()
const over = computed(() => props.label ?? props.tool?.replaceAll('_', ' '))
</script>

<template>
  <div
    data-hud
    class="flex min-h-22 w-full max-w-xl flex-col items-center justify-end gap-1 text-center"
  >
    <UBadge
      v-if="over"
      color="primary"
      variant="subtle"
      size="sm"
      class="max-w-full truncate tracking-wider uppercase backdrop-blur-sm"
    >
      {{ over }}
    </UBadge>
    <p
      class="max-w-full rounded-md bg-default/75 px-3 py-1.5 text-sm/snug font-medium text-highlighted backdrop-blur-sm sm:text-base/snug"
      :title="pending ? undefined : text"
      aria-live="polite"
    >
      <UChatShimmer
        v-if="pending"
        :text="text"
      />
      <span
        v-else
        class="line-clamp-4 text-balance wrap-anywhere"
      >{{ text }}</span>
    </p>
  </div>
</template>
