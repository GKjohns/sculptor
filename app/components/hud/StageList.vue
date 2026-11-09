<script setup lang="ts">
/**
 * The order of work, with the stage the sculptor says it is in marked. A vertical UStepper drawn
 * as the storyboard's small dots; `compact` lays the dots in a row with only the current stage
 * named, for a narrow pane. It shows progress and is not a control, so a screen reader gets one
 * sentence in place of the stepper.
 */
import type { StageView } from '~/studio/viewState'

const props = defineProps<{ stages: StageView[], compact?: boolean }>()

const current = computed(() => props.stages.findIndex(s => s.state === 'current'))
// The stepper's value is the index of the active step: -1 leaves every dot empty, the length fills them all.
const at = computed(() => current.value >= 0 ? current.value : props.stages.every(s => s.state === 'done') ? props.stages.length : -1)
const items = computed(() => props.stages.map(s => props.compact ? { value: s.id } : { value: s.id, title: s.label }))
const summary = computed(() => {
  const now = props.stages[current.value]
  if (now) return `Stage ${current.value + 1} of ${props.stages.length}: ${now.label}`
  return at.value < 0 ? 'Setting out, before the first stage' : 'All stages done'
})
const dots = {
  trigger: 'size-2 bg-transparent ring ring-accented group-data-[state=active]:bg-primary group-data-[state=active]:ring-primary group-data-[state=active]:outline-3 group-data-[state=active]:outline-primary/20 group-data-[state=completed]:bg-success group-data-[state=completed]:ring-success',
  indicator: 'hidden',
  separator: 'hidden',
  container: 'flex items-center'
}
const column = {
  ...dots,
  header: 'gap-1.5',
  item: 'items-center gap-2',
  wrapper: 'mt-0',
  title: 'text-xs font-normal text-muted group-data-[state=active]:font-medium group-data-[state=active]:text-highlighted group-data-[state=completed]:text-toned'
}
const row = { ...dots, root: 'gap-0', header: 'gap-1.5', item: 'w-auto', wrapper: 'hidden' }
</script>

<template>
  <div
    data-hud
    class="hud-glass flex items-center gap-2 px-2.5 py-2"
  >
    <span class="sr-only">{{ summary }}</span>
    <UStepper
      aria-hidden="true"
      :model-value="at"
      :items="items"
      :orientation="compact ? 'horizontal' : 'vertical'"
      size="xs"
      disabled
      :ui="compact ? row : column"
    />
    <span
      v-if="compact"
      class="truncate text-xs font-medium text-highlighted"
    >{{ stages[current]?.label ?? (at < 0 ? 'Setting out' : 'Done') }}</span>
  </div>
</template>
