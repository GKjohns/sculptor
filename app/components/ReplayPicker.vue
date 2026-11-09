<script setup lang="ts">
/**
 * What can be put back on the stone: commissions carved in this studio (an unfinished one is
 * carried on where it stopped) and the finished runs of the headless study. A modal, so it works
 * the same in a narrow pane.
 */
import type { ReplayRun } from '#shared/agent/replay'
import type { SessionSummary } from '#shared/agent/wire'

defineProps<{ runs: ReplayRun[] | null, sessions?: SessionSummary[] | null, current?: string, problem?: string }>()
const emit = defineEmits<{ pick: [id: string], session: [id: string] }>()
const open = defineModel<boolean>('open', { required: true })

const ENDED: Record<string, string> = { finish: 'finished', turn_cap: 'out of turns', cost_cap: 'out of budget', stalled: 'stalled', aborted: 'stopped', error: 'stopped on an error' }
</script>

<template>
  <UModal
    v-model:open="open"
    title="Replays"
    description="Commissions carved here, and finished runs from the headless study."
  >
    <template #body>
      <template v-if="sessions?.length">
        <p class="mb-1 text-[11px] font-medium tracking-wider text-muted uppercase">
          Commissions
        </p>
        <div class="-mx-2 mb-4 flex max-h-64 flex-col gap-1 overflow-y-auto">
          <UButton
            v-for="s in sessions"
            :key="s.id"
            color="neutral"
            :variant="s.id === current ? 'soft' : 'ghost'"
            block
            class="justify-start text-left font-normal"
            @click="emit('session', s.id)"
          >
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <span class="mr-0.5 min-w-0 truncate font-medium text-highlighted">{{ s.title ?? s.commission }}</span>
                <UBadge
                  color="neutral"
                  variant="subtle"
                  size="sm"
                >
                  {{ s.model }}
                </UBadge>
                <UBadge
                  :color="s.status === 'running' ? 'primary' : 'neutral'"
                  variant="subtle"
                  size="sm"
                >
                  {{ s.status === 'running' ? 'unfinished' : ENDED[s.ended ?? ''] ?? 'done' }}
                </UBadge>
                <span class="ml-auto text-xs text-muted tabular-nums">${{ s.costUsd.toFixed(2) }}</span>
              </div>
              <div class="mt-1 flex items-center gap-1 text-xs text-muted">
                <span class="truncate">{{ s.title ? s.commission : new Date(s.startedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }}</span>
                <span class="ml-auto whitespace-nowrap tabular-nums">{{ s.strikes.toLocaleString('en-US') }} strikes · {{ s.turns }} turns</span>
              </div>
            </div>
          </UButton>
        </div>
        <p class="mb-1 text-[11px] font-medium tracking-wider text-muted uppercase">
          Study runs
        </p>
      </template>
      <UAlert
        v-if="problem"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="The run list could not be read"
        :description="problem"
      />
      <div
        v-else-if="!runs"
        class="flex flex-col gap-2"
      >
        <USkeleton
          v-for="n in 4"
          :key="n"
          class="h-12"
        />
      </div>
      <p
        v-else-if="!runs.length"
        class="text-sm text-muted"
      >
        No finished runs under .data/study yet.
      </p>
      <div
        v-else
        class="-mx-2 flex flex-col gap-1"
      >
        <UButton
          v-for="run in runs"
          :key="run.id"
          color="neutral"
          :variant="run.id === current ? 'soft' : 'ghost'"
          block
          class="justify-start text-left font-normal"
          @click="emit('pick', run.id)"
        >
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span class="mr-0.5 font-medium text-highlighted capitalize">{{ run.subject }}</span>
              <UBadge
                color="neutral"
                variant="subtle"
                size="sm"
              >
                {{ run.model }}
              </UBadge>
              <UBadge
                color="neutral"
                variant="subtle"
                size="sm"
              >
                {{ run.tools }}
              </UBadge>
              <UBadge
                :color="run.ref ? 'primary' : 'neutral'"
                variant="subtle"
                size="sm"
              >
                {{ run.ref ? 'reference' : 'no reference' }}
              </UBadge>
              <span class="ml-auto text-xs text-muted tabular-nums">${{ run.costUsd.toFixed(2) }}</span>
            </div>
            <div class="mt-1 flex items-center gap-1 text-xs text-muted">
              <template v-if="run.judge">
                <UIcon
                  :name="run.judge.correct ? 'i-lucide-check' : 'i-lucide-x'"
                  :class="run.judge.correct ? 'text-success' : 'text-error'"
                  class="shrink-0"
                />
                <span class="truncate">Judge saw: {{ run.judge.pick }}</span>
              </template>
              <span
                v-else
                class="truncate"
              >Not judged</span>
              <span class="ml-auto whitespace-nowrap tabular-nums">{{ run.strikes.toLocaleString('en-US') }} strikes · {{ run.turns }} turns</span>
            </div>
          </div>
        </UButton>
      </div>
    </template>
  </UModal>
</template>
