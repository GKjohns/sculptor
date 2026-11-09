// What the studio needs to know before a commission: is there a gateway key, which sculptors
// can be picked and what they cost. Never says anything about the key but whether it is there.
import { DEFAULT_SCULPTOR, IMAGE_MODEL, MODELS, MODEL_LABELS, PRICING, SCULPTORS } from '#shared/agent/pricing'
import { BRAIN_BODY_LIMIT, SESSION_BODY_LIMIT } from '#shared/agent/wire'
import type { HealthResponse } from '#shared/agent/wire'
import { KERNEL_VERSION } from '#shared/sculpt/version'

export default defineEventHandler((event): HealthResponse => {
  const image = MODELS[IMAGE_MODEL]
  return {
    ok: true,
    gateway: hasGatewayKey(event),
    kernel: KERNEL_VERSION,
    models: SCULPTORS.map((key) => {
      const { input, output, cacheRead, cacheWrite } = PRICING[MODELS[key]]!
      return { key, id: MODELS[key], label: MODEL_LABELS[key], default: key === DEFAULT_SCULPTOR, price: { input, output, cacheRead, cacheWrite } }
    }),
    defaultModel: DEFAULT_SCULPTOR,
    image: { id: image, label: MODEL_LABELS[IMAGE_MODEL], perImageUsd: PRICING[image]?.perImage ?? 0 },
    limits: { brainBodyBytes: BRAIN_BODY_LIMIT, sessionBodyBytes: SESSION_BODY_LIMIT }
  }
})
