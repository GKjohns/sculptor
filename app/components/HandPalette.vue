<script setup lang="ts">
/**
 * Tool palette for hand-carving (?hands=1). A debug control, so it is the plainest thing Nuxt UI
 * offers: one field group of buttons and a line of help.
 */
import type { HandTool } from '~/studio/hands'

const tool = defineModel<HandTool>({ required: true })

const tools: { id: HandTool, label: string, icon: string }[] = [
  { id: 'saw', label: 'Saw', icon: 'i-lucide-slice' },
  { id: 'point', label: 'Point', icon: 'i-lucide-pickaxe' },
  { id: 'flat', label: 'Flat', icon: 'i-lucide-hammer' },
  { id: 'rasp', label: 'Rasp', icon: 'i-lucide-grip' }
]

const help = computed(() => tool.value === 'saw'
  ? 'Drag a line across the stone; the smaller side falls.'
  : 'Press or drag on the stone to strike.')
</script>

<template>
  <div
    data-hud
    class="absolute top-4 left-4 flex flex-col gap-2"
  >
    <UFieldGroup>
      <UButton
        v-for="t in tools"
        :key="t.id"
        :icon="t.icon"
        :label="t.label"
        color="neutral"
        :variant="tool === t.id ? 'solid' : 'subtle'"
        :aria-pressed="tool === t.id"
        @click="tool = t.id"
      />
    </UFieldGroup>
    <p class="text-xs text-muted">
      {{ help }} Drag empty space, or hold Alt, to orbit.
    </p>
  </div>
</template>
