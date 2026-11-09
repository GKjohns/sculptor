// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ['@nuxt/eslint', '@nuxt/ui'],
  // The studio is one full-screen canvas; nothing to render on the server.
  ssr: false,
  // Off: its pill sits over the transport bar at the bottom of the canvas.
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  // Dark only: no colour-mode switching, app.vue pins the `dark` class.
  ui: { colorMode: false },
  runtimeConfig: {
    aiGatewayApiKey: process.env.AI_GATEWAY_API_KEY
  },
  compatibilityDate: '2026-06-30',
  eslint: { config: { stylistic: { commaDangle: 'never', braceStyle: '1tbs' } } },
  fonts: {
    families: [{ name: 'Geist', provider: 'google', weights: [400, 500, 600] }]
  }
})
