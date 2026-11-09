<script setup lang="ts">
/**
 * The empty state: one prompt, a stone, a sculptor, and Begin. Example chips fill the prompt.
 * Without a gateway key on the server nothing can be carved, so the card says so and stays shut.
 */
import type { ModelOption, StartRequest, StoneOption } from '~/studio/viewState'

const props = defineProps<{
  models: ModelOption[]
  stones: StoneOption[]
  examples: string[]
  // The picks to start from: the default sculptor and the stone on the banker.
  model: string
  stone: string
  gateway: boolean
  // Accepted and on its way: the card waits.
  busy?: boolean
}>()
const emit = defineEmits<{ start: [request: StartRequest] }>()

const prompt = ref('')
const model = ref(props.model)
const stone = ref(props.stone)
// The model list arrives with /api/health, after the card is on screen.
watch(() => props.model, m => model.value = m)
watch(() => props.stone, s => stone.value = s)

const modelItems = computed(() => props.models.map(m => ({ label: m.label, value: m.key, description: m.priceHint })))
const stoneItems = computed(() => props.stones.map(s => ({
  label: s.label,
  value: s.key,
  description: s.available ? s.detail : `${s.detail} · coming`,
  disabled: !s.available
})))
const ready = computed(() => props.gateway && !props.busy && !!prompt.value.trim() && !!model.value)

function begin() {
  if (ready.value) emit('start', { commission: prompt.value.trim(), model: model.value, stone: stone.value })
}
</script>

<template>
  <UCard
    data-hud
    as="form"
    variant="subtle"
    class="w-full max-w-xl bg-elevated/85 backdrop-blur"
    :ui="{ body: 'flex flex-col gap-2.5 p-3 sm:p-3.5' }"
    @submit.prevent="begin"
  >
    <UAlert
      v-if="!gateway"
      color="warning"
      variant="subtle"
      icon="i-lucide-key-round"
      title="No gateway key on the server"
      description="Add AI_GATEWAY_API_KEY to .env and restart the dev server to commission a piece. Replays still play without it."
    />
    <UInput
      v-model="prompt"
      size="xl"
      placeholder="What should I carve?"
      aria-label="Commission"
      autofocus
      autocomplete="off"
      maxlength="400"
      :disabled="!gateway || busy"
      class="w-full"
    />
    <div class="flex flex-wrap gap-1.5">
      <UButton
        v-for="example in examples"
        :key="example"
        color="neutral"
        variant="outline"
        size="xs"
        class="rounded-full"
        :disabled="!gateway || busy"
        @click="prompt = example"
      >
        {{ example }}
      </UButton>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <USelect
        v-model="stone"
        :items="stoneItems"
        size="sm"
        aria-label="Stone"
        icon="i-lucide-box"
        :disabled="!gateway || busy"
        class="min-w-36 flex-1 sm:flex-none"
      />
      <USelect
        v-model="model"
        :items="modelItems"
        size="sm"
        aria-label="Sculptor"
        icon="i-lucide-user-round"
        :disabled="!gateway || busy || !models.length"
        placeholder="Sculptor"
        class="min-w-36 flex-1 sm:flex-none"
      />
      <UButton
        type="submit"
        size="sm"
        label="Begin"
        trailing-icon="i-lucide-arrow-right"
        :loading="busy"
        :disabled="!ready"
        class="ml-auto"
      />
    </div>
  </UCard>
</template>
