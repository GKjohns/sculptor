<script setup lang="ts">
// The replay page: a finished commission or study run played back on the stone, with a scrubber
// and film export. No model calls; ?speed= and ?at=end work as they do on /?replay=.
const route = useRoute()
const id = computed(() => String(route.params.id ?? ''))
useSeoMeta({ title: 'Sculptor · replay' })
</script>

<template>
  <StudioScene :run-id="id" />
</template>
