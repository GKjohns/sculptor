<script setup lang="ts">
useHead({
  meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
  htmlAttrs: { lang: 'en', class: 'dark' }
})
useSeoMeta({ title: 'Sculptor', description: 'An AI carves a block of virtual marble while you watch.' })
</script>

<template>
  <UApp>
    <NuxtPage />
  </UApp>
</template>
