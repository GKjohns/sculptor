<script setup lang="ts">
/**
 * The sculptor's charcoal sketches, pinned to the wall: one sheet of paper per view, every line
 * drawn on that view laid over a ten-centimetre grid. Points are block centimetres as read off the
 * view's rulers, so each sheet is the block face seen from that side.
 */
import type { Block } from '#shared/agent/types'
import type { PinnedSketch } from '~/studio/viewState'

const props = defineProps<{ sketches: PinnedSketch[], block: Block }>()

interface Sheet {
  view: string
  width: number
  height: number
  lines: { id: string, d: string, why?: string }[]
  grid: string
}

const round = (n: number) => Math.round(n * 10) / 10

// Where a ruler point lands on the sheet. The rulers run the way the views do: X runs backwards
// seen from the back, Z has the front on the right seen from the left, and the top looks down
// with the front at the bottom.
function sheetFor(view: string): Pick<Sheet, 'width' | 'height'> & { place: (h: number, v: number) => [number, number] } {
  const { width: w, height: t, depth: d } = props.block
  if (view === 'top') return { width: w, height: d, place: (h, v) => [h + w / 2, v + d / 2] }
  if (view === 'left') return { width: d, height: t, place: (h, v) => [h + d / 2, t - v] }
  if (view === 'right') return { width: d, height: t, place: (h, v) => [d / 2 - h, t - v] }
  if (view === 'back') return { width: w, height: t, place: (h, v) => [w / 2 - h, t - v] }
  return { width: w, height: t, place: (h, v) => [h + w / 2, t - v] }
}

const sheets = computed(() => {
  const out: Sheet[] = []
  for (const sketch of props.sketches) {
    const { width, height, place } = sheetFor(sketch.view)
    let sheet = out.find(s => s.view === sketch.view)
    if (!sheet) {
      let grid = ''
      for (let x = 10; x < width; x += 10) grid += `M${x} 0V${height}`
      for (let y = height - 10; y > 0; y -= 10) grid += `M0 ${y}H${width}`
      sheet = { view: sketch.view, width, height, lines: [], grid }
      out.push(sheet)
    }
    const d = sketch.points.map((p, i) => `${i ? 'L' : 'M'}${place(p.h, p.v).map(round).join(' ')}`).join('')
    sheet.lines.push({ id: sketch.id, d, ...(sketch.why ? { why: sketch.why } : {}) })
  }
  return out
})
</script>

<template>
  <div
    v-if="sheets.length"
    data-hud
    class="hud-glass flex gap-1.5 p-1.5"
  >
    <figure
      v-for="sheet in sheets"
      :key="sheet.view"
      class="w-12 sm:w-16 xl:w-20"
    >
      <svg
        :viewBox="`0 0 ${sheet.width} ${sheet.height}`"
        class="block w-full rounded-xs bg-[#efe9da]"
        role="img"
        :aria-label="`Charcoal sketch on the ${sheet.view} face`"
      >
        <path
          :d="sheet.grid"
          fill="none"
          stroke="#cfc8b6"
          stroke-width="0.4"
        />
        <path
          v-for="line in sheet.lines"
          :key="line.id"
          :d="line.d"
          fill="none"
          stroke="#2c2924"
          stroke-width="1.4"
          stroke-linejoin="round"
          stroke-linecap="round"
        >
          <title v-if="line.why">{{ line.why }}</title>
        </path>
      </svg>
      <figcaption class="mt-0.5 text-center text-[10px]/tight text-muted">
        {{ sheet.view.replaceAll('_', ' ') }}
      </figcaption>
    </figure>
  </div>
</template>
