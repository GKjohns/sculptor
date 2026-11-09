# Sculptor — agent notes

An AI carves a block of virtual marble while a person watches. Nuxt 4 at the repo root, `ssr: false`, one full-screen three.js canvas with a Nuxt UI HUD over it. The plan, with the reasons behind every choice below, is `internal_docs/20261108_ai_sculptor/implementation_plan.md`. Read its "Handoff / Execution Notes" before changing anything.

## Shape

```
app/
  app.vue, pages/index.vue        shell; the page is one <StudioScene />
  components/StudioScene.client.vue   mounts the renderer, the HUD and the commission; owns window.__sculptor and __sceneReady
  components/StudioHud.vue, hud/  the film-style HUD, drawn from one SculptorView (studio/viewState.ts); /hud previews it on mock views
  components/ReplayPicker.vue     saved commissions (.data/sessions) and finished study runs
  composables/useSculptor.ts      a live commission: runs the loop with the worker as Studio, feeds the timeline, keeps the HUD's view, saves the session every turn, resumes one after a reload
  composables/useBrain.ts         the browser's Brain: one POST to /api/brain per turn, read as it streams
  composables/useReplay.ts        fetches a study run, owns its ReplayPlayer, mirrors the state for the HUD
  studio/                         all three.js code, plain .ts, no Vue
    renderer.ts                   StudioRenderer: WebGPURenderer, scene, camera, key light, RenderPipeline, frame loop
    kernel.ts                     KernelClient: the page's end of the worker (promises in, chunk geometry out)
    stone.ts                      Stone: one mesh per chunk refilled in place, roughness from finish; falling offcuts
    timeline.ts                   Timeline: the virtual clock and the growing queue of strikes and staged looks that plays onto the shown stone; elastic pacing, pause, speed, seek, backpressure on the loop
    replay.ts                     ReplayPlayer: a timeline with its queue filled up front and its pace fixed
    camera.ts                     CameraRig: default framing, the walk round the stone for a staged look, hand-back after a drag
    charcoal.ts                   the lines a `sketch` pass draws on the block
    viewState.ts                  the HUD's view-model and the pure helpers that change it
    hands.ts                      hand-carving input behind ?hands=1 (palette is components/HandPalette.vue)
    debug.ts                      demo(), burst(), timeReplay() and frameMeter() behind window.__sculptor
  workers/kernel.worker.ts        the kernel in a worker: the true stone with the Studio running against it, the shown stone remeshed chunk by chunk, look PNGs and the reference sheet decoded here
shared/
  sculpt/                         the kernel: grid, strikes, mesher, islands, hand, observer. No three.js, no DOM
  sculpt/display.ts               DisplayStone: lets loose stone fall on screen ahead of the log's island check without touching the log's stone
  sculpt/protocol.ts              the messages between page and worker; every one names a stone ('true' | 'shown')
  agent/                          the look, think, carve loop and its Brain and Studio seams (Sprint 2)
server/api/                       stateless gateway routes (Sprint 3)
server/api/study/                 finished runs under .data/study for the replay: the list, a strike log, a pass record
tests/                            node --test, kernel only
bench/                            the headless model study (Sprint 2)
scripts/shoot.mjs                 screenshot loop with a blank-capture guard
internal_docs/                    plans, storyboard, research, verification pages
```

Not everything listed exists yet; the sprint in brackets is where it arrives.

## Commands

Node 22 (`source ~/.nvm/nvm.sh && nvm use 22`), npm.

- `npm run dev`: port 3130. `?gl=1` forces the WebGL 2 backend, `?hands=1` turns on hand-carving, `?demo=1` carves a fixed demo (sawn corner, rough, flat-chiselled and rasped patches) before the scene reports ready. `?replay=<run-id>` plays a finished study run (`?replay` alone lists them), with `?speed=1|8|30|120|max` and `?at=end` to go straight to the finished piece before the scene reports ready. `?session=<id>` puts a saved commission (`.data/sessions/`) back on the stone and carries on if it was unfinished; with `&pass=<n>` it shows the stone as it stood after pass n and resumes nothing. A commission's defaults are in `app/app.config.ts`; `?model=`, `?ref=0|1`, `?turns=`, `?usd=` and `?speed=1|4|8|20|60` override them for one page load.
- `npm run typecheck` (Nuxt's projects, then `tsconfig.bench.json` for `bench/` and `tests/`), `npm run lint`, `npm test` (`node --test tests/*.test.ts`): all three before calling work done.
- `npm run shoot -- --gl [--name x] [--query "a=1&b=2"]`: headless, software WebGL 2. Layout and logic.
- `npm run shoot -- --gpu ...`: headed Chrome, WebGPU. The only mode for judging how anything looks.
- `npm run shoot -- --gpu --eval "__sculptor.burst(200)"`: runs an expression in the page and prints the result; this one gives frame times for 200 rapid strikes.
- Shots land in `.shots/` (gitignored). Keepers are copied by hand into a plan's `verification/screenshots/`.
- `npm run bench:sculpt -- --subject pawn|cat|bust [--model opus|fable|sol|gemini] [--tools direct|formed] [--ref on|off] [--round A|B|C]`: one headless commission into `.data/study/<run-id>/`. `--dry` runs a scripted Brain with no key into `.data/study-dry/`. Flags are listed at the top of `bench/sculpt.ts`.
- `npm run bench:study -- --round A` (then `--round B --tools X`, `--round C --tools X --ref on|off`): a whole round, three runs at a time. Spend is capped per run (`--max-usd`, default 8) and across the study (`--study-cap`, default 100, summed from `.data/study/ledger/`).
- `npm run bench:report`: writes `internal_docs/20261108_ai_sculptor/study/report.html` from whatever has been run.

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
- The page sets `window.__sceneReady = true` once the whole stone has been meshed and frames with it have rendered, and exposes `window.__sculptor` (`stats()` gives backend, frame count, frame time, draw calls; `studio()` gives the `StudioRenderer`; `hash('true' | 'shown')` a stone's grid hash; `kernel(stone)` its rev, mass and early-check cost; `replay()` the loaded `ReplayPlayer`; `start('a chess pawn')` or `start({ commission, model, reference })` begins a commission and `state()` says where it stands (status, turn, cost, queue depth, virtual time, clock rate, strikes shown and applied, dead air); `sculptor()` is the commission itself (`pause`, `resume`, `setSpeed`, `abort`, `load`, `replayTo`, `saved`); `meter()` times frames until its `stop()`; `demo()`, `burst(n)`, `timeReplay(speed)` and `timeRestore(runId)` are the verification runs). Keep both working: the shoot script waits on them.
- HUD roots carry a `data-hud` attribute. The shoot script hides them for its blank-canvas check so a HUD over a black canvas still fails.
- A headless WebGPU capture can be silently black. Never judge the look from `--gl`, and never from a screenshot the guard did not pass.

**Style.**
- No semicolons, 2 spaces, no trailing commas, `1tbs` braces (ESLint stylistic, enforced by `npm run lint`).
- Nuxt UI 4 primitives for every panel and control. Dark only. The canvas and the film-style HUD layout are the only custom layout.
- Model calls go through the Vercel AI Gateway only (`AI_GATEWAY_API_KEY`), per `~/claude-ops/conventions/ai_sdk_usage.md`.

**Process.**
- Commit locally per sprint. Do not push or create a remote until Kyle says so.
- Stone cannot be put back: there is no undo in the kernel, and none should be added.
