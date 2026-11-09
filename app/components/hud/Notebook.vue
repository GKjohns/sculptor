<script setup lang="ts">
/**
 * The sculptor's notebook: what it said, what it reasoned, every tool it picked up and what came
 * back, turn by turn. The rows are adapted into AI SDK UI messages (notebookMessages in ~/studio/viewState) and
 * drawn by UChatMessages, with UChatReasoning and UChatTool for their parts, per
 * ~/claude-ops/conventions/nuxt_ui_chat.md. It scrolls inside whatever panel holds it.
 */
import { isDataUIPart, isReasoningUIPart, isTextUIPart, isToolUIPart } from 'ai'
import { isPartStreaming, isToolStreaming } from '@nuxt/ui/utils/ai'
import { headlineNumbers, notebookMessages, STAGE_LABELS, toolLabel } from '~/studio/viewState'
import type { LookView, NotebookEntry, NotebookToolPart } from '~/studio/viewState'

const props = defineProps<{
  entries: NotebookEntry[]
  // The commission is running: new rows keep the view at the bottom unless the reader scrolled up.
  live?: boolean
}>()
const emit = defineEmits<{ look: [look: LookView] }>()

const messages = computed(() => notebookMessages(props.entries))

const ICONS: Record<string, string> = {
  look: 'i-lucide-eye',
  closeup: 'i-lucide-zoom-in',
  slice: 'i-lucide-layers-2',
  sketch: 'i-lucide-pencil',
  declare_form: 'i-lucide-shapes',
  rough_out: 'i-lucide-hammer',
  saw: 'i-lucide-slice',
  chisel: 'i-lucide-pickaxe',
  drill: 'i-lucide-drill',
  rasp: 'i-lucide-eraser',
  polish: 'i-lucide-sparkles',
  note: 'i-lucide-notebook-pen',
  finish: 'i-lucide-signature'
}

// Every tool part here was made by notebookMessages, which the SDK's own part types cannot say.
const asTool = (part: unknown) => part as NotebookToolPart
const toolName = (part: NotebookToolPart) => part.type.slice('tool-'.length)
const count = (n: number) => n.toLocaleString('en-US')

// The chisel a call named, read back out of its phrase ("chisel claw front …", "… cm, point").
function toolText(part: NotebookToolPart): string {
  const name = toolName(part)
  const which = /\b(point|claw|flat|roundel)\b/.exec(part.input.phrase)?.[1]
  return toolLabel(name, which ? { tool: which } : undefined)
}

// What the call came to, in a few words after the tool's name.
function toolSuffix(part: NotebookToolPart): string {
  if (part.state === 'output-error') return 'refused'
  if (part.state !== 'output-available') return ''
  const out = part.output
  const kg = out.numbers?.removed_kg
  const bits = [
    out.strikes && out.strikes > 1 ? `${count(out.strikes)} strikes` : '',
    kg ? `${kg >= 10 ? count(Math.round(kg)) : kg.toFixed(kg >= 1 ? 1 : 2)} kg` : '',
    out.look ? out.look.views.length === 1 ? '1 view' : `${out.look.views.length} views` : ''
  ]
  return bits.filter(Boolean).join(' · ')
}
</script>

<template>
  <div data-hud>
    <UEmpty
      v-if="!entries.length"
      icon="i-lucide-notebook-pen"
      title="Nothing written yet"
      description="The sculptor's words, tools and results appear here as the commission runs."
      variant="naked"
      size="sm"
    />
    <UChatMessages
      v-else
      :messages="messages"
      :status="live ? 'streaming' : 'ready'"
      should-auto-scroll
      compact
      :auto-scroll="{ size: 'xs' }"
      :ui="{ root: 'gap-0' }"
    >
      <template #content="{ message }">
        <p class="text-[10px]/none tracking-wider text-dimmed uppercase">
          Turn {{ message.metadata?.turn }}
        </p>
        <template
          v-for="(part, i) in message.parts"
          :key="`${message.id}-${i}`"
        >
          <UChatReasoning
            v-if="isReasoningUIPart(part)"
            :text="part.text"
            :streaming="isPartStreaming(part)"
            chevron="leading"
          />
          <p
            v-else-if="isTextUIPart(part)"
            class="text-sm whitespace-pre-wrap text-default"
          >
            {{ part.text }}
          </p>
          <template v-else-if="isToolUIPart(part)">
            <div
              v-for="tool in [asTool(part)]"
              :key="tool.toolCallId"
            >
              <p
                v-if="tool.input.why"
                class="mb-1 text-sm text-default"
              >
                {{ tool.input.why }}
              </p>
              <UChatTool
                :text="toolText(tool)"
                :suffix="toolSuffix(tool)"
                :icon="tool.state === 'output-error' ? 'i-lucide-circle-alert' : ICONS[toolName(tool)] ?? 'i-lucide-wrench'"
                :streaming="isToolStreaming(tool)"
                :loading="isToolStreaming(tool)"
                chevron="leading"
                :ui="{ suffix: tool.state === 'output-error' ? 'text-error' : '' }"
              >
                <p class="font-mono text-xs/relaxed wrap-anywhere text-toned">
                  {{ tool.input.phrase }}
                </p>
                <p
                  v-if="tool.state === 'output-error'"
                  class="mt-1.5 text-xs/relaxed text-error"
                >
                  {{ tool.errorText }}
                </p>
                <template v-else-if="tool.state === 'output-available'">
                  <p class="mt-1.5 text-xs/relaxed">
                    {{ tool.output.summary }}
                  </p>
                  <div
                    v-if="headlineNumbers(tool.output.numbers).length"
                    class="mt-1.5 flex flex-wrap gap-1"
                  >
                    <UBadge
                      v-for="chip in headlineNumbers(tool.output.numbers)"
                      :key="chip.key"
                      color="neutral"
                      variant="subtle"
                      size="sm"
                    >
                      {{ chip.value }} {{ chip.label }}
                    </UBadge>
                  </div>
                  <UButton
                    v-if="tool.output.look?.images.length"
                    color="neutral"
                    variant="link"
                    size="xs"
                    class="mt-1.5 block p-0"
                    aria-label="Open this look in the sculptor's eye"
                    @click="emit('look', tool.output.look!)"
                  >
                    <img
                      :src="tool.output.look.images[0]"
                      alt="The contact sheet the sculptor was sent"
                      loading="lazy"
                      class="max-h-40 rounded-sm ring ring-default"
                    >
                  </UButton>
                </template>
              </UChatTool>
            </div>
          </template>
          <template v-else-if="isDataUIPart(part)">
            <UChatTool
              v-if="part.type === 'data-note'"
              text="Rewrote the plan"
              :suffix="STAGE_LABELS[part.data.stage]"
              icon="i-lucide-notebook-pen"
              variant="card"
            >
              {{ part.data.text }}
            </UChatTool>
            <UAlert
              v-else-if="part.type === 'data-budget'"
              :color="part.data.level === 'last' ? 'error' : 'warning'"
              variant="subtle"
              icon="i-lucide-coins"
              :description="part.data.text"
              :ui="{ root: 'px-2.5 py-2', description: 'text-xs' }"
            />
            <UAlert
              v-else-if="part.type === 'data-error'"
              color="error"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :description="part.data.text"
              :ui="{ root: 'px-2.5 py-2', description: 'text-xs wrap-anywhere' }"
            />
            <p
              v-else-if="part.type === 'data-system'"
              class="flex items-start gap-1.5 text-xs/relaxed text-dimmed"
            >
              <UIcon
                name="i-lucide-info"
                class="mt-0.5 shrink-0"
              />
              <span>{{ part.data.text }}</span>
            </p>
          </template>
        </template>
      </template>
    </UChatMessages>
  </div>
</template>
