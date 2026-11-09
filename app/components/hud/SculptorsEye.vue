<script setup lang="ts">
/**
 * What the sculptor sees: the contact sheet a look sent the model, exactly as sent, with the
 * numbers code measured for it and the sentence that came with them. The reference sheet shows
 * only when the person asked to see it. The sheet opens full size on a press.
 */
import { allNumbers, headlineNumbers, toolLabel } from '~/studio/viewState'
import type { LookView } from '~/studio/viewState'

const props = defineProps<{ look: LookView, referenceImage?: string }>()

const OVERLAYS: Record<string, string> = { grid: 'Centimetre grid', form: 'Form outline', reference: 'Reference outline', slice: 'Cross-section' }

const zoomed = ref('')
const open = computed({
  get: () => !!zoomed.value,
  set: (v) => {
    if (!v) zoomed.value = ''
  }
})
const headlines = computed(() => headlineNumbers(props.look.numbers, 6))
const every = computed(() => allNumbers(props.look.numbers))
const views = computed(() => props.look.views.map(v => v.replaceAll('_', ' ')))
</script>

<template>
  <div
    data-hud
    class="flex flex-col gap-2.5 text-sm"
  >
    <div class="flex flex-wrap items-center gap-1">
      <span class="mr-1 text-xs text-muted">{{ look.auto ? 'The studio\'s own look' : toolLabel(look.tool) }} · turn {{ look.turn }}</span>
      <UBadge
        v-for="v in views"
        :key="v"
        color="neutral"
        variant="subtle"
        size="sm"
      >
        {{ v }}
      </UBadge>
      <UBadge
        color="primary"
        variant="subtle"
        size="sm"
      >
        {{ OVERLAYS[look.overlay] ?? look.overlay }}
      </UBadge>
    </div>
    <UButton
      v-for="(src, i) in look.images"
      :key="i"
      color="neutral"
      variant="link"
      class="block w-full p-0"
      aria-label="Open the contact sheet full size"
      @click="zoomed = src"
    >
      <img
        :src="src"
        alt="The contact sheet the sculptor was sent"
        class="max-h-[42dvh] w-full rounded-md bg-default object-contain ring ring-default lg:max-h-[46dvh]"
      >
    </UButton>
    <USkeleton
      v-if="!look.images.length"
      class="aspect-4/3 w-full"
    />
    <dl
      v-if="headlines.length"
      class="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3"
    >
      <div
        v-for="chip in headlines"
        :key="chip.key"
        class="min-w-0"
      >
        <dd class="font-medium text-highlighted tabular-nums">
          {{ chip.value }}
        </dd>
        <dt class="truncate text-xs text-muted">
          {{ chip.label }}
        </dt>
      </div>
    </dl>
    <p class="text-xs/relaxed text-toned">
      {{ look.summary }}
    </p>
    <UCollapsible
      v-if="every.length > headlines.length"
      :unmount-on-hide="false"
    >
      <UButton
        color="neutral"
        variant="link"
        size="xs"
        trailing-icon="i-lucide-chevron-down"
        class="group p-0"
        :ui="{ trailingIcon: 'transition-transform group-data-[state=open]:rotate-180' }"
      >
        All {{ every.length }} numbers the sculptor was given
      </UButton>
      <template #content>
        <dl class="mt-1.5 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 font-mono text-xs">
          <template
            v-for="chip in every"
            :key="chip.key"
          >
            <dt class="truncate text-muted">
              {{ chip.key }}
            </dt>
            <dd class="text-right text-toned tabular-nums">
              {{ chip.value }}
            </dd>
          </template>
        </dl>
      </template>
    </UCollapsible>
    <figure v-if="referenceImage">
      <figcaption class="mb-1 text-xs text-muted">
        The reference sheet the sculptor works from
      </figcaption>
      <UButton
        color="neutral"
        variant="link"
        class="block w-full p-0"
        aria-label="Open the reference sheet full size"
        @click="zoomed = referenceImage"
      >
        <img
          :src="referenceImage"
          alt="The reference sheet"
          class="max-h-[42dvh] w-full rounded-md bg-default object-contain ring ring-default"
        >
      </UButton>
    </figure>
    <UModal
      v-model:open="open"
      title="What the sculptor was sent"
      description="The image exactly as the model received it."
      :ui="{ content: 'sm:max-w-5xl', body: 'p-2 sm:p-3' }"
    >
      <template #body>
        <img
          :src="zoomed"
          alt="The contact sheet at full size"
          class="mx-auto max-h-[78dvh] rounded-sm object-contain"
        >
      </template>
    </UModal>
  </div>
</template>
