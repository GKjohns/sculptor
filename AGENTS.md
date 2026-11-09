# Sculptor — agent notes

An AI carves a block of virtual marble while a person watches. Nuxt 4 at the repo root, `ssr: false`, one full-screen three.js canvas with a Nuxt UI HUD over it. The plan, with the reasons behind every choice below, is `internal_docs/20261108_ai_sculptor/implementation_plan.md`. Read its "Handoff / Execution Notes" before changing anything.

## Shape

```
app/
  app.vue, pages/index.vue        shell; the page is one <StudioScene />
  components/StudioScene.client.vue   mounts the renderer, owns window.__sculptor and __sceneReady
  components/hud/                 HUD panels (Sprint 3), Nuxt UI primitives
  studio/                         all three.js code, plain .ts, no Vue
    renderer.ts                   StudioRenderer: WebGPURenderer, scene, camera, key light, RenderPipeline, frame loop
    kernel.ts                     KernelClient: the page's end of the worker (promises in, chunk geometry out)
    stone.ts                      Stone: one mesh per chunk refilled in place, roughness from finish; falling offcuts
    hands.ts                      hand-carving input behind ?hands=1 (palette is components/HandPalette.vue)
    debug.ts                      demo() and burst() behind window.__sculptor
  workers/kernel.worker.ts        the kernel in a worker: owns the grid, applies strikes, remeshes dirty chunks
shared/
  sculpt/                         the kernel: grid, strikes, mesher, islands, hand, observer. No three.js, no DOM
  sculpt/protocol.ts              the messages between page and worker; every one names a stone ('true' | 'shown')
  agent/                          the look, think, carve loop and its Brain and Studio seams (Sprint 2)
server/api/                       stateless gateway routes (Sprint 3)
tests/                            node --test, kernel only
bench/                            the headless model study (Sprint 2)
scripts/shoot.mjs                 screenshot loop with a blank-capture guard
internal_docs/                    plans, storyboard, research, verification pages
```

Not everything listed exists yet; the sprint in brackets is where it arrives.

## Commands

Node 22 (`source ~/.nvm/nvm.sh && nvm use 22`), npm.

- `npm run dev`: port 3130. `?gl=1` forces the WebGL 2 backend, `?hands=1` turns on hand-carving, `?demo=1` carves a fixed demo (sawn corner, rough, flat-chiselled and rasped patches) before the scene reports ready.
- `npm run typecheck`, `npm run lint`, `npm test` (`node --test tests/*.test.ts`): all three before calling work done.
- `npm run shoot -- --gl [--name x] [--query "a=1&b=2"]`: headless, software WebGL 2. Layout and logic.
- `npm run shoot -- --gpu ...`: headed Chrome, WebGPU. The only mode for judging how anything looks.
- `npm run shoot -- --gpu --eval "__sculptor.burst(200)"`: runs an expression in the page and prints the result; this one gives frame times for 200 rapid strikes.
- Shots land in `.shots/` (gitignored). Keepers are copied by hand into a plan's `verification/screenshots/`.

## Rules

**three.js is on the WebGPU path.**
- Import three from `three/webgpu` and TSL from `three/tsl`. Never from bare `three` in `app/` (addons under `three/addons/` are fine).
- Materials are node materials (`MeshStandardNodeMaterial`, `MeshSSSNodeMaterial`, ...) with TSL nodes.
- `ShaderMaterial`, `RawShaderMaterial`, `onBeforeCompile` and `EffectComposer` do not work on this path. Do not copy post-processing from Voice World or any other `WebGLRenderer` repo.
- Post-processing is one `RenderPipeline` (r183 renamed it from `PostProcessing`) built from `pass(scene, camera)` and nodes in `three/addons/tsl/display/`.
- Renderer init is async: `await renderer.init()` before the first render or any backend check.
- Raw three.js only. No TresJS. Scene code lives in `app/studio/*.ts`; the `.client.vue` component only mounts it.
- Scene units are block centimetres: origin at the centre of the block's base, +Y up, +Z toward the viewer, +X to the viewer's right.

**Imports.**
- From `app/` and `server/`: `#shared/...` for shared code, `~/...` for app code.
- Inside `shared/`, `tests/` and `bench/`: relative imports with the `.ts` extension (`import { x } from './grid.ts'`). Those files also run under plain `node`, which resolves neither aliases nor missing extensions. Nuxt's generated tsconfig already sets `allowImportingTsExtensions`.
- `shared/` never imports three.js, Vue or anything from the DOM.
- The worker is bundled on its own: `#shared/...` resolves there, Nuxt auto-imports do not. Import everything by name in `app/workers/`.

**Screenshots.**
- The page sets `window.__sceneReady = true` once the whole stone has been meshed and frames with it have rendered, and exposes `window.__sculptor` (`stats()` gives backend, frame count, frame time, draw calls; `studio()` gives the `StudioRenderer`; `hash()` the worker's grid hash; `demo()` and `burst(n)` are the verification runs in `app/studio/debug.ts`). Keep both working: the shoot script waits on them.
- HUD roots carry a `data-hud` attribute. The shoot script hides them for its blank-canvas check so a HUD over a black canvas still fails.
- A headless WebGPU capture can be silently black. Never judge the look from `--gl`, and never from a screenshot the guard did not pass.

**Style.**
- No semicolons, 2 spaces, no trailing commas, `1tbs` braces (ESLint stylistic, enforced by `npm run lint`).
- Nuxt UI 4 primitives for every panel and control. Dark only. The canvas and the film-style HUD layout are the only custom layout.
- Model calls go through the Vercel AI Gateway only (`AI_GATEWAY_API_KEY`), per `~/claude-ops/conventions/ai_sdk_usage.md`.

**Process.**
- Commit locally per sprint. Do not push or create a remote until Kyle says so.
- Stone cannot be put back: there is no undo in the kernel, and none should be added.
