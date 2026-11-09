<script setup lang="ts">
/**
 * The commission in numbers: strikes, stone removed, turns and money against their caps, and the
 * hand's clock. Words on a wide screen, icons in a narrow pane; every figure is tabular so the
 * bar does not twitch as they climb. A quiet chip appears while the screen is behind the sculptor.
 */
import { formatClock, formatUsd } from '~/studio/viewState'
import type { StatsView } from '~/studio/viewState'

const props = defineProps<{ stats: StatsView, model?: string }>()

const count = (n: number) => Math.round(n).toLocaleString('en-US')
// Under ten seconds of unplayed work is the normal lead, not worth a chip.
const behind = computed(() => props.stats.behindMs >= 10_000 ? formatClock(props.stats.behindMs) : '')
const costColor = computed(() => props.stats.budget === 'last' ? 'text-error' : props.stats.budget === 'ok' ? 'text-highlighted' : 'text-warning')
</script>

<template>
  <div
    data-hud
    class="hud-glass flex max-w-full flex-wrap items-center gap-x-2.5 gap-y-0.5 px-2.5 py-1.5 text-xs whitespace-nowrap text-muted tabular-nums max-sm:justify-between sm:gap-x-3"
  >
    <span
      v-if="model"
      class="truncate max-lg:hidden"
    >{{ model }}</span>
    <span
      class="flex items-center gap-1"
      :aria-label="`${count(stats.strikes)} strikes`"
    >
      <UIcon
        name="i-lucide-hammer"
        class="shrink-0 sm:hidden"
      />
      <b class="font-medium text-highlighted">{{ count(stats.strikes) }}</b>
      <span class="max-sm:hidden">strikes</span>
    </span>
    <UTooltip :text="`${count(stats.massKg)} kg still standing of ${count(stats.blockKg)} kg`">
      <span
        class="flex items-center gap-1"
        :aria-label="`${count(stats.removedKg)} kilograms removed, ${count(stats.massKg)} remaining`"
      >
        <UIcon
          name="i-lucide-weight"
          class="shrink-0 sm:hidden"
        />
        <b class="font-medium text-highlighted">{{ count(stats.removedKg) }} kg</b>
        <span class="max-sm:hidden">removed</span>
        <span class="max-xl:hidden">· {{ count(stats.massKg) }} left</span>
      </span>
    </UTooltip>
    <span
      class="flex items-center gap-1"
      :aria-label="`Turn ${stats.turns} of ${stats.maxTurns}`"
    >
      <UIcon
        name="i-lucide-messages-square"
        class="shrink-0 sm:hidden"
      />
      <span class="max-sm:hidden">turn</span>
      <b class="font-medium text-highlighted">{{ stats.turns }}</b>/{{ stats.maxTurns }}
    </span>
    <UTooltip :text="`${formatUsd(stats.costUsd)} spent of a ${formatUsd(stats.maxUsd)} budget`">
      <span
        class="flex items-center gap-1"
        :aria-label="`${formatUsd(stats.costUsd)} spent of ${formatUsd(stats.maxUsd)}`"
      >
        <b
          class="font-medium"
          :class="costColor"
        >{{ formatUsd(stats.costUsd) }}</b>
        <span class="max-sm:hidden">of ${{ Math.round(stats.maxUsd) }}</span>
      </span>
    </UTooltip>
    <span
      class="flex items-center gap-1"
      :aria-label="`${formatClock(stats.elapsedVirtualMs)} at the stone`"
    >
      <UIcon
        name="i-lucide-timer"
        class="shrink-0 sm:hidden"
      />
      <b class="font-medium text-highlighted">{{ formatClock(stats.elapsedVirtualMs) }}</b>
    </span>
    <UTooltip
      v-if="behind"
      text="The sculptor is ahead of the screen: this much work is issued and still to play"
    >
      <span
        class="flex items-center gap-1 text-dimmed"
        :aria-label="`The screen is ${behind} behind the sculptor`"
      >
        <UIcon
          name="i-lucide-hourglass"
          class="shrink-0"
        />
        <span class="max-sm:hidden">{{ behind }} behind</span>
      </span>
    </UTooltip>
  </div>
</template>
