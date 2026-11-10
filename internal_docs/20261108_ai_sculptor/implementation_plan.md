# Sculptor — Implementation Plan

**Created:** November 8, 2026
**Status:** All five sprints built — Sprints 1 to 3 complete (gate passed November 9, 2026); Sprint 4 built and merged, waiting on Kyle's sign-off on the look; Sprint 5 built on the `sprint5-reveal` worktree (not merged); the gallery and deploy (5.5) skipped until Kyle decides on going public
**Context:** Kyle wants an AI that carves a virtual block of marble the way a sculptor does: it knocks stone off with different tools, walks around the piece, thinks, and goes back in. He wants to watch it happen live and have it look like a film.

**Goal:** Type a commission, pick a stone and a model, and watch that model carve it start to finish in a cinematic real-time studio, ending with a finished piece and a replay you can scrub and export.

**Scope:** One new Nuxt app, `sculptor`, local-first. Marble first, with the stone's look and tool behaviour kept in one preset so other media can follow. No accounts, no database, no public deploy until Sprint 5.

Companion files in this folder: [storyboard.html](storyboard.html) (open it in a browser), [research_notes.md](research_notes.md).

---

## The idea in one page

Four decisions carry the whole design.

**1. The stone is a grid of distances, not a mesh.** Each voxel stores how far it is from the stone's surface (a signed distance field, SDF). Removing stone is one `max()` per voxel, it can never produce broken geometry however many thousand cuts pile up, and the amount removed is measurable. A triangle mesh is rebuilt from the grid only for the chunks a cut touched. A second number per voxel records the surface finish, so a chiselled face and a polished face look different.

**2. The model directs; a deterministic "hand" does the striking.** A language model cannot place ten thousand individual chisel blows, and should not try. It issues **passes**: "rough out everything outside this form with the point chisel, leaving 4 cm", "run the flat chisel along this line 1 cm deep". Code we call the **hand** expands each pass into the individual **strikes** you see on screen. The model decides what comes off and where. The hand supplies rhythm and physical plausibility.

**3. The same kernel runs in the browser and in Node.** The stone, the hand, and a small software renderer that produces the model's views are plain TypeScript in `shared/` with no three.js or DOM imports. In the browser it runs in a worker behind the live studio. In Node it runs headless, which lets us test whether models can actually sculpt before spending a sprint on cinematography.

**4. A sculpture is its log of strikes.** The ordered list of strikes, stamped with the kernel version that produced it, reproduces the piece exactly. That gives replays, scrubbing and offline film export without storing geometry, and a public gallery of replays makes no model calls.

The loop the model runs is the one Kyle described: **look → think → carve → look**. A look returns neutral clay-style renders from named viewpoints with a centimetre grid, plus numbers computed by code (mass remaining, how far the stone still stands proud of the intended shape). The research is blunt that vision models are poor judges of subtle 3D differences, so the numbers are there to keep the model honest.

Optionally, and invisibly to the person watching, the sculptor works from a **reference sheet** produced by an image model before the first cut.

Stone cannot be put back. There is no undo. That is the product's tension and the reason the model is told to leave a margin and close in gradually.

---

## Handoff / Execution Notes (read first — this plan is self-contained)

**Repo and runtime**
- Repo root: `~/Programming/Workspace/sculptor`. Nuxt lives at the root, like Voice World (`~/Programming/Workspace/conjure`), not in `src/` like cosmo. Do not bootstrap from cosmo: this is a single full-screen canvas with no auth, database or marketing site, which is the documented exception in `~/claude-ops/conventions/project_bootstrap.md`.
- Scaffold by copying Voice World's `nuxt.config.ts`, `eslint.config.mjs`, `tsconfig.json`, `.env.example` and `package.json`, then trimming: keep its dependency set minus `@mediapipe/tasks-vision`, bump `three` and `@types/three` to `^0.187`, rename to `sculptor`, drop the Voice World scripts. `ssr: false`. npm, Node 22 (`nvm use 22`).
- Dev server: `npm run dev` on **port 3130**. Start it in the background and open the page at the start of every session.
- Checks: `npm run typecheck`, `npm run lint`, `npm test` (`node --test tests/*.test.ts`), `npm run shoot`, `npm run bench:sculpt`.
- Env: `AI_GATEWAY_API_KEY` only. Kyle creates a capped gateway key for this project (suggested `sculptor-100`). The app boots and hand-carving works without it.

**Conventions to match**
- Model calls: `~/claude-ops/conventions/ai_sdk_usage.md`. Gateway only, `ai@7`, bare `'provider/model'` strings. Copy the model map and price table from `picnic-panic/shared/utils/pricing.ts` and `picnic-panic/shared/agents/types.ts`, which cover every model used here. (Voice World's table prices only Anthropic models and returns $0 for anything else, which would silently defeat the spend cap.) Turn on `providerOptions.gateway.caching: 'auto'`.
- Every model turn has a 90-second deadline and one retry, as in Picnic Panic's gateway helper. Reasoning level `medium` unless the study says otherwise.
- Tool schemas stay small and flat with no unions and few optionals. Voice World hit a provider refusing a schema with many optional fields, after which the gateway silently fell back to a slower route (header of `conjure/server/utils/gateway.ts`). If tool calls misbehave, fall back to one JSON object per line in plain text with Voice World's `server/utils/opStream.ts` scanner.
- Imports: `#shared/...` from `app/` and `server/`. Inside `shared/`, `tests/` and `bench/`, relative imports with `.ts` extensions, because those files also run under plain `node`.
- three.js: raw three.js inside one `*.client.vue` component with the scene code in plain `.ts` modules under `app/studio/`, the way `conjure/app/world/` is organised. No TresJS. The page sets `window.__sceneReady` and exposes a small `window.__sculptor` debug handle for the shoot script.
- Web worker: no sibling repo has one to copy. Use `new Worker(new URL('../workers/kernel.worker.ts', import.meta.url), { type: 'module' })` and put the message types in `shared/sculpt/protocol.ts`.
- UI: Nuxt UI 4 primitives for every panel and control; the canvas and film-style HUD are the only custom layout (reasons in the storyboard's footer). Dark only.
- Code style: no semicolons, 2 spaces, Voice World's ESLint stylistic settings.

**Execution order and rules**
- Sprints run in order, one at a time. Sprint 2 ends in a **gate**: stop and show Kyle the study report before starting Sprint 3.
- Per-sprint loop: implement → typecheck, lint, tests → screenshot verification (delegate multi-image review to a subagent that returns text and paths) → update this file's status and deviations → report.
- A verification page (`verification/index.html` with captioned `.webp` screenshots, per `~/claude-ops/conventions/verification_artifacts.md`) is required before the work is called done.

**Commit and push policy:** commit locally per sprint. Do not push or create the GitHub repo until Kyle says so.

---

## Current State

### What exists
- This repo, containing this plan folder, a README and a `.gitignore`. No app code.
- Reference code in sibling repos: Voice World (`conjure/`: Nuxt-at-root layout, shoot script, three.js module organisation, sound, reference-image generation in `server/utils/forge.ts`) and Picnic Panic (`picnic-panic/shared/agents/types.ts` for the Brain seam and model map, `shared/runner.ts` for a headless model-versus-model runner whose replays are stamped with an engine version, `shared/utils/pricing.ts`).

### What gets built
- A sculpting kernel in `shared/sculpt/`: the stone grid, strikes, the mesher, raycasts, island detection, the hand, and the observer (software renderer).
- An agent loop in `shared/agent/` with two seams, **Brain** (one model turn) and **Studio** (execute one tool), so the same loop runs in the browser and in the bench.
- The live studio in `app/`: WebGPU scene, marble material, debris, tools, sound, an automatic camera, and the HUD from the storyboard.
- A headless study in `bench/` that produces a report comparing tool sets, reference on and off, and models.

### What stays untouched
- Every other repo. If the WebGPU work turns up something the fleet should know, it goes in a new conventions note at the end, with Kyle's OK.

---

## Architecture

```
                         ┌──────────────────────── browser tab ────────────────────────┐
 commission ──▶ agent loop (shared/agent/loop.ts)                                       │
                  │   ▲                                                                 │
        Brain     │   │ tool results (text, numbers, images)                            │
   POST /api/brain│   │                                                                 │
   (stateless,    ▼   │                                                                 │
    gateway)   model turn ──▶ tool call ──▶ Studio ──▶ kernel worker                    │
                                                        │                               │
                                       true stone ◀─────┤ strikes applied at once;      │
                                       (looks, numbers) │ looks and numbers read this   │
                                                        │                               │
                                       shown stone ◀────┘ same strikes, applied as the  │
                                       (meshed)           timeline's clock reaches them │
                                            │                                           │
                                            ▼                                           │
                              three.js studio (app/studio/*)                            │
                              stone · debris · tools · sound · camera                   │
                         └─────────────────────────────────────────────────────────────┘

 bench/sculpt.ts (Node): the same loop, Brain = direct gateway call, Studio = the kernel in-process, true stone only
```

**Why the loop runs in the browser.** A commission can take an hour and a couple of hundred model turns, and the stone is megabytes of state that changes on every strike. Keeping the loop next to the stone means the server is one stateless route that holds the gateway key and proxies a single model turn, which deploys to Vercel with no durable-execution machinery. The cost is that the tab must stay open. Server-side runs with spectators are deferred.

### The stone

- **Units and axes.** Centimetres, block-local. Origin at the centre of the block's base. +Y up, +Z toward a viewer standing in front, +X to that viewer's right. Default block 60 wide × 100 tall × 60 deep. Carrara marble at 2.71 g/cm³, so the untouched block weighs about 975 kg.
- **Grid.** Voxel size 0.4 cm, so 160 × 256 × 160 voxels (6.5 million), in 32³ chunks. Dimensions and voxel size are parameters; Sprint 4 tries 0.25 cm if faces look coarse.
- **Distance channel.** `Int8Array`, negative inside stone, clamped to ±4 voxels and scaled to ±127.
- **Finish channel.** `Uint8Array`, 0 to 255 smoothness written by whichever tool last touched the surface (point chisel ≈ 20, claw ≈ 60, sawn ≈ 90, flat ≈ 110, rasp ≈ 170, polished 255).
- **A strike** removes the intersection of a tool-shaped volume with the stone: `d = max(d, -tool(p))` over the tool's bounding box padded by the 4-voxel band, with seeded noise on the tool shape so no two chips match. If the strike names a protected shape, the removal volume is clipped by it, so a strike can never bite into stone the model said to keep.
- **The rasp** only ever raises distances (removes high spots) and re-clamps, which avoids the distance-field collapse reported for naive smoothing brushes.
- **The saw** removes stone on one side of a plane in a single operation, and the removed region becomes an offcut directly.
- **Islands.** After each pass, a full-resolution flood fill from the base finds stone that is no longer attached. Detached pieces leave the grid and become offcuts. (Half resolution was considered and rejected: it either bridges a saw cut so the slab never falls, or snaps off thin features.) The check is recorded in the strike list as its own entry so both copies of the stone run it at the same point.
- **Meshing.** Naive surface nets per chunk with a one-voxel pad, normals from the distance gradient so chunk seams are invisible, finish baked per vertex. "Watertight" in tests means every edge of the stitched mesh is shared by exactly two triangles.

### Strikes and the log

```ts
// shared/sculpt/types.ts — the contract between hand, kernel, timeline and renderer
type ToolId = 'saw' | 'point' | 'claw' | 'flat' | 'roundel' | 'drill' | 'rasp' | 'polish'

type Strike =
  | { kind: 'cut', tool: ToolId, at: Vec3, dir: Vec3, size: number, depth: number, seed: number, protect?: string, ms: number }
  | { kind: 'saw', plane: { point: Vec3, normal: Vec3 }, ms: number }   // removes the side the normal points to
  | { kind: 'detach' }                                                  // run the island check here

// at: contact point on the surface (cm). dir: unit vector the tool travels into the stone.
// ms: virtual duration, used by the timeline.

interface Offcut { positions: Float32Array, normals: Float32Array, indices: Uint32Array, centroid: Vec3, cm3: number }

// applyStrike(grid, strike) → { dirtyChunks: number[], removedCm3: number, offcuts: Offcut[] }
// offcuts is non-empty only for 'saw' and 'detach'.
```

The hand (`shared/sculpt/hand.ts`) turns one pass into an ordered list of strikes by reading the true stone. Its output depends on the stone's state and on the hand's own code, so **the saved log is the expanded strike list plus a `KERNEL_VERSION` stamp**, not the passes. Passes are saved alongside for captions and the notebook. A log replays only on the kernel version that wrote it; on a mismatch the replay page says so.

### Looking: views and addressing

| View | Looks along | Horizontal ruler | Vertical ruler | Carve from it? |
|---|---|---|---|---|
| `front` | −Z | X, increasing to the right | Y | yes |
| `back` | +Z | X, increasing to the left | Y | yes |
| `right` | −X (camera on the +X side) | Z, increasing to the left | Y | yes |
| `left` | +X | Z, increasing to the right | Y | yes |
| `top` | −Y | X, increasing to the right | Z, increasing downward | yes |
| `front_left`, `front_right`, `back_left`, `back_right` | 45° between two axis views, pitched 20° down | none | none | no, looking only |

Rulers are labelled in **block coordinates**, so a point in the `back` view carries the same X it has in the `front` view. Carving tools take a view and a point in that view's two ruler coordinates; the hand casts a ray along the view direction to the first surface it meets. Every carving result reports the 3D point that was hit, or says the ray missed, so a misplaced stroke is visible in the very next message. Surfaces hidden from all five axis views cannot be addressed in this version (see Deferred).

The observer (`shared/sculpt/observer.ts`) renders axis views by scanning grid columns, which is fast, and three-quarter views by stepping rays through the grid. Shading is neutral clay under a raking key light. Ruler labels use a tiny bitmap digit font embedded in the file. It returns RGBA; PNG encoding lives at the edges (`node:zlib` in the bench, a canvas in the browser).

### What the model can do

Every carving tool also takes a required `why`: one sentence in the sculptor's voice. It becomes the on-screen subtitle and the notebook entry, so there is always something to read even when a model returns tool calls with no other text.

**Core tools (Sprint 2, used in the study)**

| Tool | Arguments | What happens |
|---|---|---|
| `look` | `views` (up to 6), `overlay`: `grid` \| `form` \| `reference` | One contact sheet. Also returns numbers: mass remaining, bounding box, and how far the stone stands proud of the declared form (maximum and mean). With `reference`, each view sits beside the matching reference quadrant and the numbers include silhouette agreement with the reference outlines. |
| `declare_form` | `name`, `shapes`: a list where every shape has the same flat fields (`kind`: ellipsoid \| box \| capsule \| cone, `center` x y z, `size` x y z, `rotation` x y z in degrees), `blend_cm` | Declares the masses the stone should end up as. Nothing is cut. Declaring a name again replaces it. |
| `rough_out` | `to` (a form name, or `reference`), `margin_cm`, `tool`: `point` \| `claw` | Removes stone outside the target, leaving the margin. With `reference`, the target is the volume common to the front and left reference outlines pushed through the block. |
| `saw` | `view`, `from`, `to` (two points), `discard`: `above` \| `below` \| `left` \| `right` | A straight cut through the whole block perpendicular to the view. |
| `chisel` | `tool`: `point` \| `claw` \| `flat`, `view`, `path` (points), `depth_cm`, `width_cm` | A stroke along a line on the surface. Each bite travels into the stone along the surface normal at that point. |
| `rasp` | `view`, `path`, `width_cm`, `passes` | Smooths high spots along the path. |
| `note` | `stage`, `text` | Updates the notebook: current stage and plan. Survives context rebuilds. |
| `finish` | `title`, `statement` | Ends the commission. |

**Added in Sprint 3, once the gate has shown what is worth having**

| Tool | What it adds |
|---|---|
| `sketch` | The sculptor draws a profile on a block face in charcoal. It is theatre and an overlay for looks. It is not something `rough_out` cuts to, because the research suggests freehand outlines from a language model are imprecise. |
| `drill` | A hole along the view direction, for deep detail. |
| `chisel` with `roundel` | Concave channels. |
| `polish` | Raises finish with no geometry change. It is invisible in clay renders, so it waits for the real material. |
| `slice` | A cross-section image at a plane. |

`declare_form` plus `rough_out` is the software version of working from a model with callipers: the sculptor says what masses it wants and the hand takes the stone down toward them. Detail still has to be carved by stroke.

The system prompt walks the model through the real order of work (general to specific: rough out, block in, model, refine, polish), tells it stone cannot be replaced, gives it a budget of turns and dollars, and requires a look after every few passes.

### Working from a reference image (optional, hidden)

A sculptor rarely works from nothing; there is a drawing or a small model somewhere out of frame. The software version: before the first cut, an image model produces a **reference sheet** for the commission, and the sculptor carries it in its context for the whole job. The person watching never has to see it or know it exists. It is a setting on the commission, off or on, and the study measures whether it helps.

Because nobody but the model looks at it, the sheet is built for use, not beauty:

- **Layout.** One square image in four quadrants: front, left, back, right. Matte grey clay on a flat black background, even lighting, no perspective, the figure filling each quadrant to the same height. The sculptor model writes the brief for the image model, so the design is still the sculptor's.
- **Carvable by construction.** The brief asks for a compact single mass on a base: no floating parts, no thin unsupported limbs, nothing a block of stone could not hold.
- **Two uses.** First, the model simply sees it, which gives it a concrete target instead of an idea. Second, code thresholds the front and left quadrants against the black background, traces their outlines and scales them to the block. `rough_out` can cut to them and every look can report how well the stone's silhouette agrees with them. Outlines lifted from a generated image should be far more accurate than ones a language model draws point by point.
- **Checks.** Each quadrant must contain one connected shape of sensible size. If not, regenerate once; if it fails again, keep the image for viewing only and skip the outlines. Generated views will not agree with each other perfectly, so outlines are cut with a margin and the sculptor's own looks settle the rest.
- **Plumbing.** One gateway call to the image model (`generateText` with `responseModalities: ['IMAGE']`, as in `conjure/server/utils/forge.ts`), a few cents per commission. The sheet sits at the start of the context, inside the cached prefix. It is saved with the session so replays and resumes do not regenerate it.

What hiding it changes: no HUD work, and the sheet can be ugly. It appears only in the Sculptor's eye panel behind a debug flag. Whether a finished piece ever discloses that it was carved from a generated reference is a presentation choice for Kyle, listed under Open Questions.

### The agent loop and its seams

```ts
// shared/agent/types.ts
// Message is the AI SDK's ModelMessage, passed back to the next turn verbatim (some providers
// require their own reasoning blocks to be returned unchanged).

interface Brain {
  // One model turn. Streams text as it arrives; resolves with the tool calls and the messages to append.
  turn(input: { instructions: string, messages: Message[], signal?: AbortSignal },
       onText: (delta: string) => void): Promise<{ calls: ToolCall[], append: Message[], usage: Usage, costUsd: number }>
}

interface Studio {
  // Executes one tool call against the true stone.
  run(call: ToolCall): Promise<{ summary: string, numbers?: Record<string, number>, images?: Uint8Array[], strikes: Strike[] }>
}
```

- Bench (Sprint 2): `Brain` calls the gateway directly with `generateText`; `Studio` calls the kernel in-process.
- Browser (Sprint 3): `Brain` posts to `server/api/brain.post.ts`, which calls `streamText` through the gateway with the tool schemas and no `execute` functions and streams text and tool calls back as NDJSON. `Studio` talks to the kernel worker.
- **Images** go back as a user message that follows the tool result, not inside it; image content in tool results is not something all four providers are known to accept.
- **Context is append-only between rebuilds.** Every 20 turns the history is rebuilt from scratch as: instructions, the reference sheet if any, the notebook, a one-line record of every pass so far, and one fresh look. Between rebuilds nothing is removed, so the cached prefix stays valid. A resume after a reload uses the same rebuild, which is what restores the conversation.
- **Guardrails:** a hard cap on turns and on dollars per commission, both shown in the HUD. The model is told its budget and warned as it runs low so it lands the piece.

### Time

The timeline (`app/studio/timeline.ts`) owns a **virtual clock**. The worker holds two copies of the grid. The **true stone** has every strike of a pass applied the instant the pass is issued; the hand, looks and measurements read it, so the model gets its result straight away and can think about its next move while the work is still playing out on screen. The **shown stone** receives the same strikes as the clock reaches them, and only it is meshed. At 0.4 cm the second copy costs about 13 MB. The bench has only the true stone.

- **Elastic pacing.** A model turn takes 10 to 30 seconds; a pass may be 20 strikes or 400. The clock's rate adjusts so the queue of unplayed strikes is neither empty nor long. If the screen falls more than about a minute of work behind, the loop waits before asking for the next turn. The speed control scales all of this.
- **Looks are staged.** A look is an entry in the queue. When the clock reaches it the hand stops, the camera walks to the requested viewpoints, and the Sculptor's eye panel shows the sheet the model was sent.
- **Fixed-step replay.** Nothing reads the wall clock, so a replay can be rendered frame by frame at any resolution for export.

### The studio (what makes it look like a film)

The research found no vibe-coded demo with a truly film-like look. What the best-looking projects share is a render pipeline specified by hand, reference code in the agent's context, and a screenshot loop that is known to capture real frames. Sprint 4 is built around those three things. Sources and version checks are in `research_notes.md` Part 2.

- **Renderer.** three.js r187 `WebGPURenderer` from `three/webgpu`, materials in TSL from `three/tsl`. This is a departure from the fleet (Voice World and the desk scene are on `WebGLRenderer`), and three's own docs still call the WebGPU renderer experimental. We take it anyway because the node post-processing stack, the subsurface material and GPU particles only exist on that path. It falls back to WebGL 2 on its own, and Chrome, Safari 26 and current Firefox on macOS all ship WebGPU. Init is async (`await renderer.init()`). `ShaderMaterial`, `onBeforeCompile` and `EffectComposer` do not work on this path, so nothing is copied from Voice World's post pass.
- **Marble.** `MeshSSSNodeMaterial`. Veining is 3D noise evaluated at the stone's own coordinates (`tsl-textures/marble.js` is the reference to read, not a dependency), so veins run through the block and each cut reveals more of them. Roughness and tool marks come from the finish value. Thin sections (ears, fingers, drapery edges) pick up light from behind: the mesher bakes a per-vertex thickness by marching a short way inward, and feeds the material's thickness nodes. Because thickness depends on stone outside the chunk being remeshed, the set of chunks to rebuild is widened by the march distance.
- **Atelier.** A wooden banker under a tall window: one large soft key with a visible shaft through dust, a dim cool fill, a dark backdrop that falls away. Environment lighting for reflections.
- **Debris.** Three scales. Offcuts are real meshes cut from the removed volume, simulated as rigid bodies in Rapier (`@dimforge/rapier3d-compat` 0.21, the version three r187's own helper pins), and they break once on landing. Chips are instanced shards: a few hundred live ones in Rapier, the rest on cheap ballistic paths, all settling into a static pile. Dust is a TSL compute particle system (`instancedArray` plus `renderer.compute()`): a puff per strike, a haze that builds in the light shaft, and a pale film on the floor.
- **Tools.** A chisel and mallet (and drill, rasp, pad) float and work with no hands. They are built procedurally, animated from strike events, and shake the camera slightly on heavy blows.
- **Sound.** Synthesised with Web Audio: mallet thud, steel ring pitched by tool and force, chips scattering, slab impacts, rasp. Room tone underneath.
- **Camera director.** A small state machine choosing among shots: wide orbit, medium on the working area, macro insert with shallow focus, step-back during looks, a cut and brief slow motion when a big piece falls, the reveal. Minimum shot lengths, damped moves, and an occlusion test against the stone. Dragging the canvas takes over; it hands back after a few idle seconds.
- **Post.** One `RenderPipeline` (the r183 rename of `PostProcessing`) with nodes from `three/addons/tsl/display/`: `ao` (GTAO), `sss` (screen-space contact shadows, despite the name), `dof` focused on the strike point, `bloom`, `godrays` for the window shaft, `film` grain, `traa`, and AgX tone mapping. Screen-space global illumination (`ssgi`) is tried last and kept only if it holds frame rate. The reference to read for how these fit together is `ektogamat/threejs-conference`.
- **Screenshots that can be trusted.** Headless Chrome can silently capture a black WebGPU canvas. The shoot script has two modes. `--gl` runs headless on software WebGL 2 (`?gl=1` forces that path) and is for checking layout and logic in Sprints 1 to 3. `--gpu` launches a headed Chrome with WebGPU on Kyle's Mac and is the only mode used to judge the look in Sprint 4. Both wait for frames and fail if pixel variance is near zero.

---

## Storyboard

[storyboard.html](storyboard.html) — six frames, with working controls on four of them. The stone drawings are placeholders; the HUD, panels and controls are the commitment.

1. **The commission** — empty state: block on the banker, prompt, example chips, stone and model pickers. Sprint 3.
2. **Sketching on the block** — charcoal profiles on the faces and pinned to the wall, stage list, subtitle. Sprint 3.
3. **Roughing out** — the main watching state: stats bar, subtitle, transport (pause, speed, camera mode), notebook panel with tool calls. HUD in Sprint 3; slabs, chips and dust in Sprint 4.
4. **Stepping back to look** — the Sculptor's eye panel showing the exact contact sheet and numbers the model received. Observer in Sprint 2, panel in Sprint 3.
5. **Refining and polishing** — macro shot, mixed finishes. Sprint 4.
6. **The reveal and the replay** — title plaque, scrubber, film export. Sprint 5.

The reference sheet has no frame on purpose: the person watching never sees it.

---

## Sprint Breakdown

### Sprint 1: Stone you can hit — Foundational `[Complete]`
**Goal:** A block in the browser that you can carve by hand at 60 fps, backed by a tested kernel.
**Estimated effort:** 5–7 hours

#### Tasks
- 1.1 Scaffold the app
  - As described in the handoff notes. Expand `README.md`; add `AGENTS.md` (shape, commands, rules, including the WebGPU import rules).
  - Prove the renderer path on day one: a lit cube through `WebGPURenderer` and a one-node `RenderPipeline`, checked in the browser pane and through `npm run shoot -- --gl`.
- 1.2 Grid and strikes
  - Files: `shared/sculpt/types.ts`, `grid.ts`, `strike.ts`, `tools.ts`, `rng.ts`, `version.ts`
  - Block creation, both channels, four tools to start (`saw`, `point`, `flat`, `rasp`), protection clipping, removed-volume accounting.
- 1.3 Mesher and raycast
  - Files: `shared/sculpt/mesher.ts`, `raycast.ts`
  - Padded-chunk surface nets with finish baked per vertex.
- 1.4 Islands and offcuts
  - File: `shared/sculpt/islands.ts`
- 1.5 Kernel worker and stone renderer
  - Files: `shared/sculpt/protocol.ts`, `app/workers/kernel.worker.ts`, `app/studio/renderer.ts`, `app/studio/stone.ts`, `app/components/StudioScene.client.vue`, `app/pages/index.vue`
  - Worker owns the grid; the main thread receives chunk geometry as transferables. Plain off-white physical material with roughness from finish, one key light, orbit camera. Veining, subsurface light and everything else about the look is Sprint 4.
- 1.6 Hand-carving mode
  - A tool palette (`UButtonGroup`) and click or drag on the stone to strike along the view ray. Stays as a debug mode behind `?hands=1`.
- 1.7 Tests and shoot script
  - Files: `tests/grid.test.ts`, `tests/mesher.test.ts`, `tests/islands.test.ts`, `scripts/shoot.mjs`

#### Verification
- [x] `npm test` passes (30/30): a strike removes the expected volume within 5%; a protected shape is never cut; the mesh of a block with one corner chiselled is watertight across chunk seams; a sawn-off corner is returned as an offcut with the right volume; a thin bridge left standing is not detached.
- [x] In the browser, 200 rapid strikes hold 60 fps on Kyle's Mac: `burst(200)` on WebGPU at 120 Hz gave mean 8.33 ms, p95 9.0 ms, max 9.4 ms, no frame over 16 ms; `burst(1000)` gave the same. These are vsync-quantised frame intervals, so they prove no dropped frames, not how much main-thread headroom is left.
- [x] Screenshot: a block with a sawn corner and visibly different rough and smooth patches — `verification/screenshots/sprint1_demo_stone_gpu.webp` (and `_gl`; same grid hash on both backends).

#### Results and deviations
- Kernel timings on the default grid (Node 22): strike 0.2 ms, chunk remesh 0.5 ms, island check 3–9 ms, full initial mesh 61 ms, saw through half the block 80–160 ms (in the worker).
- **`form` log entry added.** Protected cuts depend on declared forms, which were not in the strike log, so a replay or the shown stone could not reproduce them. `Strike` gained `{ kind: 'form', name, shapes, blend, inflate? }`; it must precede any strike that names it, and both grids must receive it.
- **Edge-contact cleanup.** After every edit, stone that touches other stone only along a voxel edge has its shallower sample turned to air; without it, surface nets produced edges shared by four triangles.
- **Small strikes are less exact than 5%.** 4 cm strikes are within 3% of their true volume; 2 cm strikes (5 voxels across) can be 8% off.
- The base is closed (the grid keeps a layer of air under the block). Detached pieces under 0.5 cm³ are counted as removed but produce no offcut. The kernel uses its own polynomial sin/cos so logs replay across JS engines; the hand must follow the same rule.
- three is 0.187.0; the post class is `RenderPipeline`. The palette is `UFieldGroup` (Nuxt UI 4 has no `UButtonGroup`). Finish is widened to Float32 on the main thread because WebGPU has no one-byte vertex format.
- The worker protocol already names a stone (`'true' | 'shown'`) on every message; only `shown` exists until Sprint 3.
- Offcuts tip out and fall under plain gravity, then are removed. Real physics is Sprint 4.
- Remeshing is not time-sliced: a saw remeshes about 30 chunks in one flush. Fine today; revisit in Sprint 4 if a slab fall drops a frame.
- Finish-driven sheen only shows near the mirror angle because there is no environment light yet; rough versus smooth currently reads from geometry and shadow. The face away from the key light is very dark. Both are Sprint 4 lighting work.
- `bench:sculpt` script is added in Sprint 2 with the bench. `shoot.mjs` gained `--eval`, hides `[data-hud]` for its blank-canvas check, and fails on page errors or the wrong backend.

---

### Sprint 2: The sculptor, and the gate `[Complete]`
**Goal:** Know whether models can carve recognisable things, with which tools, and whether a reference image helps, before building the theatre.
**Estimated effort:** 9–12 hours, plus up to $100 of model spend

#### Tasks
- 2.1 Observer — `shared/sculpt/observer.ts`
- 2.2 Measurements — `shared/sculpt/measure.ts` (mass, bounding box, stone proud of form, silhouette agreement with an outline)
- 2.3 The hand — `shared/sculpt/hand.ts`, adding the `claw` tool. Pass → strikes for every core tool, including finding slabs to saw off at the start of a rough-out.
- 2.4 Tool schemas, prompt and loop — `shared/agent/types.ts`, `toolSchemas.ts`, `prompt.ts`, `context.ts`, `loop.ts`, and `shared/agent/pricing.ts` with the model map
- 2.5 Reference sheet — `shared/agent/reference.ts` (brief prompt, quadrant split, background threshold, outline tracing, validity checks; pure, works on RGBA) and the image call in `bench/`. Test against a fixture sheet in `tests/fixtures/`.
- 2.6 The study — `bench/sculpt.ts`, `bench/subjects.ts`, `bench/report.ts`
  - Every run is capped at 60 turns and $8, and writes its strike log, pass record, final contact sheet, cost and turn count.
  - **Round A, tool set.** Opus 5.5 on three subjects (chess pawn, loaf-shaped cat, human bust), no reference, two tool sets: **direct** (`saw` and `chisel` only, no forms) and **formed** (everything in the core table). Six runs. If strokes land in the wrong places in both, add a third arm where positions are picked from a lettered dot grid drawn on the look instead of read off rulers.
  - **Round B, reference.** The better tool set, same model and subjects, with a reference sheet. Three runs, compared against their Round A twins.
  - **Round C, models.** The best configuration so far on the cat and the bust with Fable 5.1, GPT-6 Sol and Gemini 3.1 Pro. Six runs. (GPT-6 Astra is left out: it has no cached-input price and one run would exceed the cap.)
  - **Judging.** A judge model sees each final contact sheet, never the reference, and picks what it depicts from a fixed list of twelve labels: the subjects plus distractors. The report also gives the numbers code can measure, and Kyle's eye is the final word.
  - `bench/report.ts` writes one `report.html` with the runs side by side per round, each with cost, turns and the judge's pick; Round B pairs sit next to the reference sheet that was used.
- 2.7 Tests — `tests/hand.test.ts` (a rough-out to an ellipsoid leaves the ellipsoid plus margin and nothing else), `tests/loop.test.ts` (a scripted Brain drives a full loop), `tests/reference.test.ts`.

#### Verification
- [x] `npm run bench:sculpt -- --subject pawn --model opus` completes and writes a contact sheet. First real run: Opus 5.5, formed tools, no reference, 11 turns, $0.33, judge picked "chess pawn" at 0.97, strike log replays to the same hash (`verification/screenshots/sprint2_smoke_pawn_opus.webp`).
- [x] `report.html` exists and covers all three rounds: [study/report.html](study/report.html), 16 runs, $17.88 of the $100 cap ($17.72 in recorded runs plus a $0.16 allowance for timed-out turns).
- [x] The report answers the reference question plainly: per subject, with and without, the judge's pick, the measured agreement, and the cost difference.

#### Study results (November 9, 2026)

| Round | Subject | Model | Tools | Ref | Turns | Cost | Judge | Person's read (independent reviewer, 1–5) |
|---|---|---|---|---|---|---|---|---|
| A | pawn | Opus 5.5 | direct | – | 22 | $2.07 | pawn ✓ 0.90 | 3: pawn silhouette under spiky texture |
| A | pawn | Opus 5.5 | formed | – | 12 | $0.37 | pawn ✓ 0.97 | 5: clean pawn |
| A | cat | Opus 5.5 | direct | – | 45 | $2.26 | owl ✗ | 1: barely touched block |
| A | cat | Opus 5.5 | formed | – | 9 | $0.37 | rabbit ✗ | 2: sitting snowman-cat, not a loaf |
| A | bust | Opus 5.5 | direct | – | 54 | $2.01 | bottle ✗ | 1: square decanter |
| A | bust | Opus 5.5 | formed | – | 19 | $0.82 | bust ✓ 0.80 | 2: egg on a box, no neck |
| B | pawn | Opus 5.5 | formed | on | 14 | $0.72 | pawn ✓ 0.97 | 5: best pawn, waist and stepped base |
| B | cat | Opus 5.5 | formed | on | 15 | $0.69 | cat ✓ 0.70 | 3: correct loaf on a tall pedestal, ears shattered |
| B | bust | Opus 5.5 | formed | on | 35 | $1.07 | bust ✓ 0.93 | 3: head with ears on a bulb body, face cratered |
| C | cat | Fable 5.1 | formed | on | 34 | $2.05 | cat ✓ 0.60 | 2: loaf body, head gouged hollow |
| C | bust | Fable 5.1 | formed | on | 16 | $1.95 | bust ✓ 0.80 | 3: skull-faced head on a mound |
| C | cat | GPT-6 Sol | formed | on | 58 | $0.58 | cat ✓ 0.60 | 3: best-made, but round bear ears |
| C | bust | GPT-6 Sol | formed | on | 59 | $0.54 | bust ✓ 0.96 | 4: mannequin head, neck, shoulders, plinth |
| C | cat | Gemini 3.1 Pro | formed | on | 15 | $0.73 | cat ✓ 0.80 | 4: unmistakable cartoon cat, pitted |
| C | bust | Gemini 3.1 Pro | formed | on | 31 | $1.16 | pawn ✗ | 1: pitted totem on a pedestal |

What the study says:
- **Tool set: formed.** Stroke-only carving never got past roughing on the cat or the bust and cost two to five times as much.
- **Reference: on.** It turned the cat from a wrong pose into the right one and made the bust fuller, for $0.25–0.35 more per run. Its cost: sculptors copy whatever the sheet draws, including a pedestal that eats half the height.
- **Model:** GPT-6 Sol made the best bust and the best-made cat, at the lowest cost, by using nearly all 60 turns; it is also the slowest to watch (14–21 minutes). Opus 5.5 is the fastest (3–5 minutes) and good at masses but wrecked faces and ears with fine chiselling. Fable 5.1 cost about $2 a run without doing better. Gemini 3.1 Pro made the most recognisable cat and the worst bust. Native tool calling worked on all four; the JSON-lines fallback was never needed.
- **The automatic gate criteria pass** for Opus, Fable and Sol with formed tools and a reference (judge correct on both cat and bust, every run under $2.10). The best bust (Sol) reads as a head and shoulders; it is a crude mannequin, not a portrait.
- **Problems that showed up across runs:** fine chisel work destroys faces more often than it makes them; every run ended by the model's own choice, often very early (Opus stopped a cat at 9 of 60 turns); necks go missing and shoulders come out as bulbs; vertical comb ridges on nearly every surface; pieces left at half the block's height; the automated judge is lenient (0.93 for a bust with a cratered face); and the sculptor's finish statements describe features the stone does not have.
- [x] **Gate passed, November 9, 2026.** Kyle's decisions: **full (formed) tool set, reference on by default, Opus 5.5 as the default model**, with Fable 5.1, GPT-6 Sol and Gemini 3.1 Pro in the picker. (GPT-6 Sol made the best pieces in the study; Opus was chosen for its 3–5 minute pace. Its two weaknesses — stopping early and wrecking faces with fine chiselling — get one bounded prompt-tuning pass at the start of Sprint 3.) The original criteria, for the record: pass means: for at least one configuration the judge picks correctly for both the cat and the bust, the bust reads as a head and shoulders to a person, and that run cost under $8. Then lock the tool set, the default model and whether the reference is on by default. Simple subjects are deliberately not part of the gate, because declaring a sphere as a form and roughing to it only tests the hand. If the gate fails, the fallback is to lean harder on forms and the reference (more and finer shapes, outlines from all four quadrants) and re-run before any studio work.

#### Results and deviations
- Code complete, 120 tests. Commands: `npm run bench:sculpt -- --subject cat --model opus --tools formed --ref off`, `npm run bench:study -- --round A|B|C [--tools X] [--ref on|off]`, `npm run bench:report`. Runs land in `.data/study/<run-id>/` (gitignored); the report is written to `study/report.html` in this folder.
- **Gateway key.** `sculptor-100` was minted with the Vercel CLI on the `gkjohns-projects` team: $100 hard cap, 30-day expiry. The bench also keeps its own study-wide ledger and refuses to start a run that could pass $100.
- **Kernel version 2.** Added the claw, a per-strike `margin` on protected cuts, and silhouette forms (two outlines pushed through the block, logged as a `form` entry so replays stay exact).
- **A full rough-out** of the default block is about 15 saw cuts plus 1,400 chisel strikes, computed in about 2 s, leaving stone a mean 0.5–0.7 cm proud of the margin. No protected voxel was removed in any test.
- **`rough_out` refuses a target that floats** or has a part not joined to the rest, since the island check would otherwise drop the target itself.
- **The rasp was rewritten.** The first version only lowered convex high spots and could not smooth point-chisel pits. It now levels ridges toward the local pit floor, removal only: five passes take a real rough-out from 0.23 cm to 0.05 cm RMS roughness.
- **Look overlays.** With `form`, stone proud of the form is tinted yellow through red, overcut is blue, the form outline is cyan. A six-view sheet is about 1234 × 1273 px and renders in about 200 ms.
- **Reference sheets** scale each view to the same height in block cm (a shared pixel scale would shave the top when generated views differ slightly). Back and right outlines are the mirrored front and left ones.
- **The judge sees two sheets**: the six-view sheet with rulers and four three-quarter views. Never the reference or the commission.
- **Loop additions beyond the plan's seams:** a run ends as `stalled` after three turns with no tool call; budget warnings at 75% and 90% and a final-turn notice; invalid arguments come back to the model as an error result; the 90 s deadline and single retry live in the loop, not the Brain.
- **Cost accounting** charges the larger of the price table and the gateway's own figure. `--max-usd` includes the reference and judge calls.
- Native tool calling on GPT-6 Sol and Gemini 3.1 Pro was exercised in Round C and worked. The JSON-lines fallback has still not been exercised with real calls.

---

### Sprint 3: The live studio `[Complete]`
**Goal:** Type a commission in the browser and watch it carved live with the storyboard's HUD, on Sprint 1's plain render.
**Estimated effort:** 7–9 hours

#### Tasks
- 3.1 Timeline and the second grid
  - Files: `app/studio/timeline.ts`, worker changes
  - Virtual clock, true and shown stone, elastic pacing, pause, speed, staged looks.
- 3.2 Server routes
  - Files: `server/api/brain.post.ts`, `server/api/reference.post.ts`, `server/utils/gateway.ts`
- 3.3 Browser loop
  - Files: `app/composables/useSculptor.ts`, `app/composables/useBrain.ts`
  - Runs `shared/agent/loop.ts` with the worker as Studio; abort, budget caps, error recovery (a failed turn retries once, then pauses with a toast).
  - Reference sheet: generated before the first turn when the setting is on. The default comes from the gate and lives in `app/app.config.ts`; `?ref=0` or `?ref=1` overrides it, and `?ref=1` also reveals the sheet in the Sculptor's eye panel. Nothing about it appears in the normal HUD.
- 3.4 The remaining tools — `sketch`, `drill`, `roundel`, `polish`, `slice`, whichever of them the gate did not rule out.
- 3.5 HUD
  - Files: `app/components/hud/CommissionCard.vue`, `StageList.vue`, `StatsBar.vue`, `Subtitle.vue`, `Transport.vue`, `Notebook.vue`, `SculptorsEye.vue`, `PinnedSketches.vue`
  - The notebook adapts loop events into the AI SDK's UI-message parts so `UChatMessages`, `UChatReasoning` and `UChatTool` render them. If the adapter fights the components, fall back to a plain list of `UCard` rows.
- 3.6 Sessions and replay-to-a-point
  - Files: `server/api/sessions/index.post.ts`, `[id].get.ts`, `index.get.ts`, `app/studio/replay.ts`
  - Strike log, pass record, notebook, costs, settings and reference sheet saved as JSON under `.data/sessions/` as the commission runs. Loading a session replays the log to any chosen pass. This gives resume after a reload, and it gives Sprint 4 fixed stones to tune the look against.

#### Verification
- [x] A full commission runs start to finish in the browser with no manual steps. "A chess pawn", Opus 5.5, speed 8, WebGPU: 20 turns, $1.09, 293 s, title "Pawn"; true and shown hashes equal; the saved log replays in Node to the same hash. The screen ran at most 20.5 s behind and finished 24 s after the model.
- [x] Screenshots of the HUD for storyboard frames 1 to 4: `verification/screenshots/sprint3_live_*.webp` (live) and `sprint3_hud_frame*.webp` (mock preview at `/hud`). The scene is still the plain render.
- [x] Reloading mid-commission restores the stone exactly and the sculptor carries on: "a sleeping cat curled in a loaf" was killed during turn 7, restored from `?session=` to the saved hash, and finished as "Loaf" at turn 49 ($1.575; the stats bar shows $1.57). Replaying a 10,218-strike log takes 5.8 s; a 13,547-entry new-format log takes 9.1 s.
- [x] The stats bar's cost equals the sum of the server's per-turn cost plus the reference, and the server's priced cost equalled the gateway's own figure on every verified turn.

#### Results and deviations
- **Watch a finished run:** `/?replay` lists every study run and saved session; `?replay=<id>&speed=1|8|30|120|max`, `&at=end`. **Watch a new one:** type a commission on `/`. **Resume or inspect:** `?session=<id>` and `&pass=<n>`. HUD mock preview: `/hud`.
- **Opus prompt tuning (one bounded pass, $3.68).** Features are declared as small shapes in the form and roughed to at a fine margin; chisel strokes are for hollows only; a pacing rule and finish checklist; fill the block and keep the plinth low; the statement is written from the last look. Result on the bust: full height, a real neck, square shoulders, and a face with brow, nose, eyes, mouth and intact ears (34 turns, $1.29, judge 0.96), against the study's helmeted head with a cratered face. Still a caricature. Early stopping is improved, not fixed (the cat stopped at 24 turns and 59 cm).
- **Tools added:** `drill`, `chisel` with `roundel` (and a required `protect` argument), `polish` (looks now report surface finish percentages), `slice`, `sketch`, and — beyond the plan — `closeup`, a zoomed axis view with a 1 cm grid. All 16 study logs still replay to their recorded hashes; kernel version stays 2.
- **Hanging stone.** Kyle noticed pieces floating in mid-air: the island check only ran at the end of a pass. New passes log a check after every saw cut and every 2 s of carving (longest hang went from 580–911 strikes to 4–5). For older logs, the browser keeps the shown stone log-exact and, only while a piece hangs, meshes a display copy in which it has already fallen; the copy is reconciled at the pass's own check. Running extra checks on the real grid was tried first and rejected: it changed 3–12 voxels by the end of a run.
- **Two kernel workers, one per stone,** and a third worker for `/api/brain`. In one worker the hand froze playback for up to 2.7 s per rough-out; posting the growing context from the page cost a 67–358 ms frame per turn.
- **Pacing rule:** playback rate = backlog ÷ drain time, clamped between a floor and 8× the chosen speed and eased over 0.5 s; the loop is held at its next tool call while paused or more than 60 s behind.
- **Sessions** are files under `.data/sessions/<id>/` with an append-only `strikes.ndjson`. Request bodies to `/api/brain` are capped at 24 MB; a Vercel deploy will need WebP looks to fit its 4.5 MB function limit (Sprint 5).
- **HUD departures from the storyboard:** no "Sketch" stage (the loop has none), speed stops 1/4/8/20/60 on a slider, the overlay in the eye panel is a badge, scrubber and export wait for Sprint 5.
- **Known rough edges:** about 27 s of dead air before the first cut (the opening look was lengthened afterwards and not re-measured); a turn in flight at reload is paid for but lost; charcoal sketches are wiped at the next cutting pass, not faded where carved; restored sessions show past looks without images; each of a new log's frequent checks costs a full island check on the shown stone; the stats bar shows the model's short key ("opus") during a run (the picker itself says "Opus 5.5") and the Nuxt DevTools pill overlaps the transport in dev.

---

### Sprint 4: Cinema `[Built — awaiting Kyle's sign-off]`
**Goal:** The same commission looks and sounds like a film.
**Estimated effort:** 10–14 hours, iterated by screenshot against saved sessions

#### Tasks
- 4.1 Marble material, veining, finish and subsurface light — `app/studio/materials/marble.ts`, thickness bake in `shared/sculpt/mesher.ts`
- 4.2 Atelier, lighting and post — `app/studio/atelier.ts`, `post.ts`
- 4.3 Debris — `app/studio/debris.ts`
- 4.4 Tools — `app/studio/tools.ts`
- 4.5 Sound — `app/studio/sound.ts`
- 4.6 Camera director — `app/studio/director.ts`
- 4.7 Resolution — try the 0.25 cm grid and keep it if frame time and memory allow.
- 4.8 Look book — `docs/look/`: five fixed camera presets on three saved stones (early, middle, finished), shot with `npm run shoot -- --gpu` after every tuning pass, the way `workspace-3d` iterates against reference shots.

#### Verification
- [~] Storyboard frame 5 reproduced: macro shot with raw, rasped and polished stone in one frame and light through a thin edge. Partly: `sprint4_frame5_macro_gpu` has pitted and polished stone and `sprint4_backlit_thin_edge_gpu` has a fin glowing when backlit, but it is a test stone, not a commission, the rasped zone is hard to tell apart, and no tool is in frame.
- [x] A slab fall captured as a five-frame sequence: cut, fall, impact, break, settle (`sprint4_slab_1_cut_gpu` to `sprint4_slab_5_settle_gpu`, shot before the dust and debris fixes; `sprint4_fix_impact_dust` shows the landing puff after them).
- [x] 60 fps during normal carving and no frame over 33 ms during a slab fall on Kyle's Mac; the WebGL 2 fallback renders without errors. Headed Chrome, 120 Hz, film tier at 1.5x: first slab fall after a fresh load 8.33 ms mean, 9.4 max; 8x replay through a rough-out 8.34 mean, 16.6 max; 200 hand strikes 8.33 mean, 9.4 max; no frame over 16.7 ms in any of the three. The GPU may have been shared during the measurement, and a separate measurement under known shared load gave 12.4 ms mean, p95 16.7, max 25.1 for an 8x replay. `--gl` and headed `?gl=1` reach ready with a clean console.
- [ ] Kyle watches one full commission and signs off on the look.

#### Results and deviations (November 9, 2026)
- **Built in a worktree** (`sprint4-cinema`, four commits) so the live tab did not hot-reload, then merged into `ai-sculptor-build` as `5742f14`. 185 tests, typecheck and lint pass. `KERNEL_VERSION` is still 2 and the three reference replays end on their recorded hashes (cat `90ed9085f7a66a4d`, pawn `aee99ec9b7973290`, Sol bust `0ab275d2c385097f`).
- **Look:** marble with veins baked into a tiled volume read at block coordinates (they run through cuts and offcuts), finish-driven roughness, light through thin stone from a thickness march toward the key; atelier with a window shaft; post is pre-pass, GTAO, scene, god rays, TRAA, depth of field, bloom, AgX, vignette, grain. The film tier renders at 1.5x (`?dpr=2` overrides). WebGL 2 gets scene, AgX, vignette and grain; software GL gets a lean mode with no veins. Tuning log and look book: `docs/look/`.
- **Grid stays at 0.4 cm.** The 0.25 cm trial gave 648k triangles against 242k, 55 MB per grid copy against 13 MB, and a 33 s restore against 10 s.
- **Shading pass after an independent review** of the first screenshots (verdict: the room read as film, the stone as ribbed plaster). Shading normals now come from the distance field blurred two voxels wide, which removed the corduroy ribbing on rasped and polished stone; contact shadows are off in the film tier and the key's normal bias is 0.7 cm, which removed the sawtooth and moire shadows; vein coverage widened; polish roughness 0.26 to 0.36; shadow tint warm-neutral.
- **Motion:** falling offcuts on Rapier that topple, break and settle, chips with a rubble pile, dust, a floating chisel, mallet and saw, synthesised sound with a mute button, and a camera director (wide, medium, macro, saw, fall in slow motion, look, reveal, free) with a 3.5 s minimum between cuts. `?film=0` turns the layer off, `?cam=free` the director. Caps: 6,000 chip instances, 24 moving offcut bodies, 28 sound voices.
- **Fixes from the review:** the saw shows only during its cut and has a matt steel blade; the mallet rests when idle; debris that comes to rest on the sculpture is pushed off, then shrinks away; dust varies in size and opacity and a landing slab raises a visible puff.
- **First-slab-fall hitch:** first-use pipeline compiles cost one 299 ms frame; a prewarm draw before `__sceneReady` brings the worst frame to 9.4 ms (`?prewarm=0` turns it off).
- **Live run on the film build:** "a chess pawn" on Opus 5.5, 14 turns, $0.93, true and shown hashes both `e71e528775456405`, the same after a reload. The run was interrupted at turn 4 and resumed from `?session=`. No saw cut happened after the resume, so no slab fall has been seen in a live commission, only in replays.
- **Sound** was confirmed by an analyser on the master gain in headed Chrome (signal 0.117 playing, 0.012 paused, 0.0025 muted). Nobody has listened to it on speakers.
- **Sprint 3 rough edges closed:** charcoal is rubbed out where the stone is cut, the stats bar shows "Opus 5.5", Nuxt DevTools is off, the finished plaque wraps at 400 px, the tool badge has a backing, `timeReplay` twice in one page no longer hangs.
- **Known rough edges:** bumpy silhouettes and a faint toothed shadow edge at grazing light, both from the 0.4 cm voxels; thin relief such as an ear does not glow because there is no air behind it; veins are faint on brightly lit polished stone; the point-chisel band reads as honeycomb close up; break faces are clean planes; dust still reads a little dotted; the mallet floats in front of the stone when carried between passes; the room is sparsely dressed and the window is a plain bright rectangle; the stage list stayed on "Rough out" for the whole live pawn (not diagnosed); `docs/look/*` was shot before the saw fix; medium and macro cuts wait on an async raycast, so cut frames will not be bit-exact under a fixed-step export (matters for Sprint 5's film export); SSGI was never tried; the `NERO` black marble preset exists but is untuned.

---

### Sprint 5: Reveal and share `[Built]`
**Goal:** Every commission ends well and leaves something to show people.
**Estimated effort:** 5–7 hours

#### Tasks
- 5.1 Reveal sequence: signature on the base, floor sweep, light sweep, title plaque.
- 5.2 Replay page — `app/pages/replay/[id].vue`: scrubbing on top of Sprint 3's replay-to-a-point. Add periodic grid snapshots only if Sprint 3's measured replay time makes seeking feel slow.
- 5.3 Film export: fixed-step offline render of a replay to video in the browser with `mediabunny` (`CanvasSource`, one frame added per simulation step), with a time-lapse length option. Nobody has published this recipe against a WebGPU canvas, so spike it first; the fallback is exporting from the WebGL 2 path.
- 5.4 A second stone preset, black marble, to prove that a medium is one preset. It is a material and a few tool constants, not new physics.
- 5.5 Gallery and deploy, if Kyle wants it public: replays only, live commissions behind a gate.
- 5.6 Verification page for the whole plan.

#### Verification
- [x] Storyboard frame 6 reproduced; scrubbing to any stage shows the stone as it was. `/replay/20261109180313-a-chess-pawn-0ee`: header, stats strip (10,941 strikes, 720 kg removed, $0.93, 54:09), centred plaque, transport with scrubber and Export film (`verification/screenshots/sprint5_frame6_replay_gpu`, `sprint5_scrub_1500_gpu`, `sprint5_scrub_6000_gpu`). Seeking the log back and forth ends on the live run's hash `e71e528775456405`. Seeks on the pawn: back to the middle 2.3 s (9.6 s before snapshots), forward to the end 0.36 s, back to 3,000 0.73 s, forward to 9,000 0.92 s. Not verified: mouse scrubbing beyond the one click in the end-to-end run; films are 1080p, not the storyboard's 4K.
- [x] An exported 60-second film plays in QuickTime with no dropped frames. The pawn as a one-minute time-lapse: H.264 High, 1920 x 1080, 30 fps, 60.0 s, 1,800 frames, 79.2 MB, rendered in 69 s. AVFoundation (QuickTime's framework) reads it as playable and decodes all 1,800 frames at exactly 1/30 s apart; `ffprobe` and a full `ffmpeg` decode agree. Not verified: nobody has watched it in the QuickTime Player app; no sound track.
- [x] A replay page loads and plays with the network tab showing zero model calls. Five `/api/` requests (health, study list, the session, its strikes, its passes), none to `/api/brain` or `/api/reference`; counted with Playwright's request log (`shoot --api`), not the devtools tab. The end-to-end run repeated it on a fresh session with an export.

#### Results and deviations (November 9, 2026)
- **Built in a worktree** (`sprint5-reveal`, one commit) while Kyle watched a commission on the main checkout. 185 tests, typecheck and lint pass. `KERNEL_VERSION` is still 2.
- **Reveal** (`app/studio/reveal.ts`, wired through `Cinema`): starts when the director reaches its reveal shot, so only for a piece watched to its end. On the film clock: floor swept over 2.4 s (chips pushed off by a moving edge, offcuts shrunk away, dust film lifted: `Debris.sweep`, `Dust.sweep`), a shadowless spotlight sweeping round the piece from 1.0 s for 4.2 s, the signature fading up from 2.2 s. The signature is the model and the year in Roman numerals ("Opus 5.5 · MMXXVI"), dark on Carrara, pale on Nero, cast onto the front of the base in sixteen columns of raycasts so it follows the surface. A finished piece that is skipped to is signed without the rest. The plaque is the HUD's (new, centred, on the replay page) and is set into the last seconds of an exported film.
- **Replay page** `app/pages/replay/[id].vue` is `<StudioScene :run-id>`: a saved session or a study run (`useReplay` now reads both), a stats strip, the plaque, and the replay transport with a scrubber over the log (label shows the pass under the thumb; letting go seeks) and Export film. A finished live commission's transport has a Replay button. `/?replay=` still works.
- **Snapshots added for scrubbing.** The plan said only if seeking felt slow; going back to the middle of the pawn took 9.6 s. The kernel worker keeps copies of the shown stone (`snapshot` message, 13 MB each, at most ten) every max(800, log ÷ 8) entries as a seek passes them; a seek back, or forward past one, starts from the nearest. Hash unchanged.
- **Film export** (`app/studio/film.ts`, mediabunny 1.65.2 `CanvasSource`): the WebGPU spike worked first time, so the WebGL 2 fallback was never needed or tried. The studio's frame loop is held (`StudioRenderer.hold/step`) and stepped at 1/30 s; before each frame the export waits for the timeline's batch (`Timeline.pending`), its mesh (`Stone.arrived`), any shot the director is asking the worker about (`Director.pending`) and where the signature goes. So the director's raycast cuts land on a fixed frame without restructuring the director. The worker still splits batches by time (budget raised to 150 ms for export), so a strike can move by a frame between two exports: deterministic enough, not bit-exact. The replay speed is steered every frame so the carving ends where the 9 s reveal tail begins (the one-minute pawn: carving ended at 52.2 s, speeds 0.5x to 64x); looks are shortened to 0.6 of their length. H.264 about 10.5 Mbit/s at 1920 x 1080, 30 fps; lengths 30 s, one minute, two minutes. No audio. `__sculptor.film(options)` and `shoot --downloads` for automation.
- **Black marble** (5.4): `NERO` tuned by eye on the finished pawn and wired to the stone picker. Near-black body, few thin white veins (new `veinFineness` sharpens the same vein field; `feather` and `bruise` per preset), polish to a dark mirror, no light through. Picking it re-skins the stone, chips and signature at once (`Stone.setPreset`, `Cinema.restone`, then a prewarm); a commission records it in its run config's `stone` ("Nero Marquina, a black marble with white veins"), which is what the sculptor is told, and replays and resumes put the same stone back. No tool constants needed changing. `?stone=nero` for one page load.
- **End-to-end run** (5.6): "a chess pawn" on Opus 5.5, $2 cap, driven through the UI in headed Chrome: finished as "Pawn" at turn 24, 13,326 strikes, $1.23 (reference $0.09), 384 s to the finished piece on screen, true and shown hashes equal (`7aaa5561dffea4ac`); the reveal; the Replay button to `/replay/20261109191043-a-chess-pawn-a53` (no model calls); a click on the scrubber to strike 4,620; Export film, 30 s, saved by the browser and read back by AVFoundation as 900 frames, 30.0 s, 1920 x 1080, 30.6 MB. Screenshots `verification/screenshots/e2e_*`. Not verified: sound on speakers, a viewing in QuickTime Player, Kyle's sign-off on the look.
- **Skipped by decision:** 5.5 gallery and deploy, and the deploy-only work with it (WebP looks for Vercel's 4.5 MB body limit). Nothing is public.
- **Known rough edges:** a film opens wherever the camera happened to be, sometimes on the block's shadowed side; at time-lapse speeds the director never takes the macro or slow motion (it refuses them above 12x and 24x); a one-minute film is about 79 MB; export holds the tab (about 70 s per minute of film) and shows the canvas stretched behind the progress card; title and signature fall back to Georgia or Iowan Old Style (no web font is loaded); the light sweep barely shows in stills; nobody has carved a commission in black marble live or listened to anything on speakers; Kyle has not signed off on the look.


### Sculpting skill pass: better faces `[Built]` (November 9, 2026)
**Goal:** Make the sculptor better at sculpting, the bust above all. Kyle's read: the pawn and the cat were good, the bust "looks like a little kid sculpted it"; try a better model where it plans, try Fable 5.2, and make fine-grained detail work on a face possible. Report: `study/skill_pass.html`.

**Diagnosis.** The face failed because the tools could not say one: a form held twelve convex solids under one blend (a head was an egg with a nose), the roughing-out's last layer left 0.3 to 0.6 cm of claw noise (a lip's whole depth), and every finer feature had to be chiselled from a contact sheet where the face was a few dozen pixels wide. The reference sheets were sculptable busts already; the model had no way to carry their relief into the stone.

**What changed** (all in `shared/`, so the bench and the browser share it; `KERNEL_VERSION` stays 2 and every old log replays):
- `shared/sculpt/anatomy.ts`: a head canon. `declare_form` takes `kind: head` (centre, skull size, tilt/turn/cock) and expands it into 27 kernel primitives built additively (cranium, frontal bone, two brow ridges, a face mass whose sides are the socket floors, cheekbones, eyes, a cone nose with tip and wings, muzzle, lips, chin, jaw, ears), so the log holds only kernel kinds. Tuned offline in five iterations at no spend; `tests/anatomy.test.ts` pins the landmarks. Shapes per form 12 → 24.
- `detail`: a windowed `roughOut` (`window` in `hand.ts`): flat chisel, 0.1 cm margin, only surfaces facing the view, no saw. The face is finished by it and is then the form itself.
- Detail mode: `focus` / `unfocus` in the Studio. The window (6 to 30 cm) is shown enlarged with the surface's relief along its centre lines in numbers; while focused every `look` is the window, strokes must be from that view, inside it and under a fifth of its width, `rough_out` and `saw` are refused. The camera takes a macro shot of a close-up or focus (`Macro` in `camera.ts`). Focus is in-memory only.
- Guards: the rasp protects the form last cut to; cutting to a second form while the figure is another is refused (run skill-2 lost its head that way).
- Prompt: placing and dressing a head, the measure of a bust in centimetres, compose as a sculpture, what 0.4 cm cells can resolve. Reference brief: a sculptor's study (planes, a slight turn, hair mass, head ≥ two fifths, classical shoulders, low socle); the sheets changed at once.
- Fable 5.2 (`anthropic/claude-fable-5.2`, $8/$40 per million) added as `fable52`. `shared/agent/planner.ts`: a planner/executor split (`--planner`, `?planner=`), off by default.

**Results.** Before/after at the same camera is on the report page. The face went from an egg with notches to a brow, deep eyes with lids and pupils, a nose with bridge and wings, a closed mouth with corners, chin and jaw, under a parted hair mass, head turned: a stylised portrait bust, not yet a carver's. Composition (long neck, low shoulders, vase chest) is the weak part now. Pawn still clean (8 turns, $0.61); cat better made than the study's but sat upright rather than loafed (judge said dog).

| Run | Model | Turns | Cost | Read |
|---|---|---|---|---|
| `S-bust-opus-formed-ref-skill-1-20261109201733-66b` | Opus 5.5 | 25 | $1.45 | first readable face; chest shrunk to a bulb on a socle |
| `S-bust-opus-formed-ref-skill-2-20261109202848-43f` | Opus 5.5 | 29 | $1.41 | head cut away by a second form (now refused) |
| `S-bust-opus-formed-ref-skill-3-20261109203854-aff` | Opus 5.5 | 42 | $2.22 | detail mode used for lids, pupils, mouth; tall socle |
| `S-bust-opus-formed-ref-skill-4-20261109205403-2ff` | Opus 5.5 | 40 | $1.89 | **best face**; the "after" |
| `S-bust-fable52-formed-ref-skill-4-20261109205403-775` | Fable 5.2 | 25 | $4.48 | best composition, cruder face |
| `S-bust-fable-formed-ref-skill-4-20261109211127-6ea` | Fable 5.1 | 32 | $3.36 | readable face, head on a post |
| `S-bust-sol-formed-ref-skill-4-20261109205403-6a5` | GPT-6 Sol | 60 | $0.64 | helmet hair, tiered torso |
| `S-bust-gemini-formed-ref-skill-4-20261109205403-c87` | Gemini 3.1 Pro | 52 | $1.56 | worst: low head in a hood |
| `S-bust-fable52-plans-opus-formed-ref-skill-4-20261109211127-65f` | Fable 5.2 plans, Opus carves | 13 | $1.37 | hair swallowed the brow; stopped early |
| `S-pawn-opus-formed-ref-skill-4-20261109211127-032` | Opus 5.5 | 8 | $0.61 | clean pawn |
| `S-cat-opus-formed-ref-skill-4-20261109211127-f0d` | Opus 5.5 | 14 | $0.76 | sitting cat, ears intact |

Ranking: Opus 5.5, Fable 5.2, Fable 5.1, Sol, Gemini. Fable 5.2 wins only on composition at 2.4× the cost, so **Opus 5.5 stays the default**; the planner split did not help in its one run and stays off. One run per arm: Opus's own runs vary as much as the models do.

**Spend:** $19.77 of the $25 cap (ledger $21.56 → $41.33). 197 tests, typecheck and lint pass.

**Next:** a `bust_torso` canon (neck, shoulders, chest with the classical cut) so composition stops failing; character knobs or variants on the head so faces are not siblings; a lid groove and iris in the canon instead of drilled pupils; a `hair` canon; persist focus in the session; three runs per model before believing the ranking.

---

### Sculpting skill pass 2: figures and poses `[Built; 9 paid runs]` (November 9 and 10, 2026)
**Goal:** Kyle: "Don't be afraid to get more artistic and intricate. Like the kinds of things Bernini would sculpt." Full figures, animals and scenes, artistic poses, never a boring default pose; and, after the parallel face pass was stopped, the faces and busts as well (the last pass's Next list). Built and validated offline at zero model spend; the paid bench runs wait on a budget. Report: `study/pose_pass.html`. Branch `figure-pass`.

**What changed** (all in `shared/` and `bench/`; `KERNEL_VERSION` stays 2 and every saved study log replays to its hash):
- `shared/sculpt/figure.ts`: the canon of the body. `declare_figure` (a new tool) takes one to three posed subjects plus the model's own shapes as one form. A figure is declared by pose: body and build, ground point, standing height, facing, legs (stand, stride, lunge, kneel, sit, recline, crouch, ride), weight_on (contrapposto: that hip up and out, shoulders tilted against it, the free knee bent), twist, lean, head turn and tilt, each arm's gesture (down, akimbo, across, forward, raised, overhead, back, out, to_head), drapery (loincloth, collar, mantle, cloak, robe), support (stump, rock) and head style tokens. Limbs reach from hip and shoulder to a target by a two-bone reach, so any pose stays jointed. A quadruped: horse, bull, lion, dog or cat in stand, walk, trot, gallop, rear, charge, lie or sit, head turned and raised or lowered, tail, lead foreleg; a rearing animal stands on its hind legs and tail. A rider sits on the first animal. Everything expands into kernel primitives before the form is logged. The result tells the model each subject's extent and where its head, hands, feet (or muzzle and back) ended up.
- Faces and busts, starting from the stopped `bust-pass-2` snapshot (adopted in commit 21998b6; what was kept and dropped is on the report page): style tokens on the head (sex, age, build, jaw, nose, expression, gaze, hair, beard); a `torso` canon (neck, shoulders, chest narrowing to a rounded cut, arm stumps, mantle or buttoned collar, socle); canon cuts (iris rings, drilled pupils, lid lines, nostrils, mouth, curl eyes, fold valleys) carried on the form entry and struck by `detail` in its window; a hair canon. This pass then opened the eyes (a ball between two lids), slimmed the lower face, rebuilt the hair as hooked locks along the fall from the crown whorl on a hair mass, rebuilt the bust's trunk to a classical silhouette, and laid cloth in strips on the real trunk surface.
- Kernel: a shape may carry its own `blend`, never more than the form's, so lids, lips, nostril wings and locks stay crisp on a softly blended body. Old logs carry none and replay identically.
- Speed for forms of a hundred and more solids, both exact (the same number to the last bit, checked against every saved log): an inherited bounding-sphere cull, per-cell candidate lists (bins), and a sample memo for strike clipping.
- `shared/agent/prompt.ts`: a COMPOSITION AND POSE section in both tool sets (choose the moment; name the dominant diagonal, silhouette, torsion, gesture and contrast of surfaces; a frontal, symmetric, static pose is a failure unless commissioned; compose within the block; supports where marble needs them), and with the formed tools the use of `declare_figure`, figure and animal measures for this block, and how to carve a figure. The bust paragraph now uses head + torso + style. `reference.ts`: the brief no longer forbids outstretched limbs or raised tails (only free strands), and asks for the moment and a Baroque pose.
- Bench: subjects `david` ("David a moment before the throw."), `bull` ("A charging bull."), `rider` ("A rearing horse with a rider.") with their own twelve judge labels, among them the same subject at rest, so a static pose scores as a miss; the study's twelve stay as they were. The `--dry` Brain declares the new subjects with `declare_figure`. `npm run bench:poses`, `bench:canon` and `bench:timing` preview and time the canons offline.

**Rough-out time against solid count** (`npm run bench:timing`, voxel 0.4, Kyle's Mac, one run each):

| Form | Solids | Point at 3 cm | Claw at 0.6 cm |
|---|---|---|---|
| 4 plain solids | 4 | 5.7 s (2498 strikes) | 2.1 s (1485 strikes) |
| 12 plain solids | 12 | 6.0 s (2280 strikes) | 2.7 s (1433 strikes) |
| 24 plain solids (the study's limit) | 24 | 6.7 s (2137 strikes) | 3.0 s (1335 strikes) |
| bust: head + torso (mantle, curls) | 199 | 16.5 s (2100 strikes) | 7.6 s (1428 strikes) |
| David (one figure) | 79 | 11.0 s (2167 strikes) | 4.9 s (1392 strikes) |
| contrapposto, mantle, stump | 102 | 15.2 s (2347 strikes) | 6.2 s (1326 strikes) |
| seated figure on a rock | 120 | 11.1 s (1865 strikes) | 5.5 s (1236 strikes) |
| rearing horse and rider | 85 | 17.3 s (2568 strikes) | 6.9 s (1402 strikes) |
| charging bull on a rock | 38 | 7.1 s (1860 strikes) | 3.6 s (1290 strikes) |
| Apollo and Daphne (two figures) | 177 | 24.1 s (2211 strikes) | 12.4 s (1417 strikes) |

Point pass at 3 cm, then claw at 0.6 cm, the two passes every commission makes. A form of up to 24 solids (what the study's forms were) takes 6 to 7 s; a figure 11 to 16 s; a two-figure group about 25 s. Limits: `declare_figure` takes at most three subjects and 24 of the model's own shapes (`MAX_SUBJECTS`, `MAX_SHAPES`); the kernel has no limit of its own. Small heads (under 18 cm) use a coarse hair and drop sub-cell ear parts, which took a two-figure group from 258 to 177 solids.

**Not done:** focus is still in-memory only (persisting it needs the loop's RunState and the worker protocol to carry it: not cheap). The figure canon's hands are paddles, feet are short wedges, and a figure under about 70 cm gets a plain three-solid head. Animals' heads are small and their legs thin; the lion's mane swallows the face from the front. The block is fixed at 60 x 100 x 60, so a long animal must go on the diagonal or on a rock.

**Offline tune after review** (zero spend, same cameras, before/after on the report page): the bull on a low rough slab with a head about a fifth of its body forward and low, horns out then forward and up, a dewlap and a bigger hump; arched two-piece necks with a mane crest and longer heads for the horse (and bigger heads for lion and dog); the rider clear of the back with legs down the flanks; hair as swept locks laid on the skull from a parting, blended into one mass with a groove along each; two broad mantle folds instead of many grooves; ears tucked; a higher trapezius; a thumb and a heel on each figure.

**Paid runs** (round S, `--name pass2`, formed tools, reference on; Opus 5.5 capped at $2.40 a run, Fable 5.2 at $5):

| Run | Model | Turns | Cost | Judge | Pose unprompted | declare_figure | Read |
|---|---|---|---|---|---|---|---|
| `S-david-opus-formed-ref-pass2-20261109235131-5a9` | Opus 5.5 | 15 | $0.64 | at rest (miss) | stride, hand to head | yes | a youth thinking, not throwing |
| `S-bull-opus-formed-ref-pass2-20261109235131-a94` | Opus 5.5 | 10 | $0.46 | charging bull | charge, head down, tail up | yes | small bull on a 33 cm rock pedestal |
| `S-rider-opus-formed-ref-pass2-20261109235131-e00` | Opus 5.5 | 11 | $0.44 | rider | rear, fist raised, cloak | yes | reads from every side |
| `S-david-opus-formed-ref-pass2-20261109235704-32b` | Opus 5.5 | 20 | $0.71 | dancer (miss) | stride, hand to head, arm back | yes | more torsion, still not a throw |
| `S-david-fable52-formed-ref-pass2-20261109235704-ef6` | Fable 5.2 | 7 | $1.04 | about to throw | lunge, twist -35, arm across, arm back | yes | **Bernini's wind-up** |
| `S-bull-opus-formed-ref-pass2-20261109235704-783` | Opus 5.5 | 12 | $0.48 | charging bull | charge on the diagonal | yes | on a domed rock a quarter of the height |
| `S-rider-opus-formed-ref-pass2-20261109235704-5a5` | Opus 5.5 | 17 | $0.57 | rider | rear, leaning in, mantle | yes | an extra rock under the belly |
| `S-bust-opus-formed-ref-pass2-20261109235704-6f3` | Opus 5.5 | 11 | $0.53 | bust | turned 15, chest -8, frown | head + torso | ears stand out, long neck |
| `S-bust-opus-formed-ref-pass2-20261109235704-b41` | Opus 5.5 | 13 | $0.49 | bust | same, calm | head + torso | a sibling of 6f3 |

The prompt was adjusted once after the first three (an action in its wind-up, no pedestal under an animal, figures take most of the budget). Every figure run used `declare_figure` and chose an action pose unprompted; 7 of 9 judged correct, both misses Opus Davids mapping the sling to `to_head`. All runs stopped early (7 to 20 of 60 turns), so the canon is most of the quality now. **Spend: $5.36** (ledger $41.33 → $46.69). Re-runs on the rest of the $25 were allowed by the coordinator but blocked by the tool permission check as a real-world spend, so not run.

**Second offline tune, after the runs** (zero spend): the bust's hair is a mass with its own silhouette and a few big locks swept back from an off-centre parting, a fringe over the brow, a few deep separations and undercuts (hair modes in the tokens: `waves` the default swept mass, `curls` short cropped, `long_hair` to the shoulders, `short_hair`, `bun`); ears flatter and shorter; a thicker neck with a nape and a diagonal sternomastoid; the mantle one cloth with four folds of different depths fanning from the shoulder knot, the neck and other shoulder bare. New arm gestures `sling` (drawn arm behind and above the head, the torso wound 28 degrees, the other hand at the pouch on the far hip), `reach_up`, `embrace`. A ground cap in `declare_figure`: grounds and rocks under subjects are lowered to a fifth of the block and the result says so (`capGround`; run a94's own declaration re-declared through it on the report page with `bench/rerun-declare.ts`). A finish guard in the loop: a figure or bust commission's `finish` is refused before 40 percent of its turns, twice at most, while under 70 percent of its money, quoting the commission back and asking for a last look and a check (`FINISH_FLOOR`); pawn and cat commissions are unchanged. 213 tests, typecheck and lint pass; every saved study log still replays.

**Next, if more spend is approved:** Opus David x3 (does it use `sling`, does the guard buy finished hands and face), bull x2 and rider x2 (cap and guard), bust x3 (do three busts differ now), one David and one rider on Fable 5.2; about $15 to $20. Then thicker animal legs, a sitter description before the bust's tokens, three runs per model before ranking.

---

## Risks

| Risk | Why it might happen | What the plan does about it |
|---|---|---|
| Models cannot carve anything recognisable | Vision models misjudge subtle 3D differences and place things imprecisely | Sprint 2 exists to find out for under $100. Forms, the reference sheet, code-computed measurements and a margin discipline are the supports; the gate has a stated fallback. |
| Faces look blocky | 0.4 cm voxels give an eye about ten voxels | Voxel size is a parameter; Sprint 4 tries 0.25 cm. A sparse or two-level grid is the next step and is deferred. |
| Cost per commission is too high | Hundreds of turns with images | Gateway caching, append-only context, one image per look, hard caps. Rough arithmetic for a 60-turn run: about $3 on Opus 5.5 and $7 on Fable 5.1. The study reports real cost per run so the default model is chosen with the bill in view. |
| WebGPU rough edges | Newer renderer path, officially experimental | The path is proven on day one of Sprint 1; the WebGL 2 fallback is checked every sprint; the look is only ever judged on a real GPU. |
| The watch is dull between model turns | Long thinking, short passes | The two-grid design lets the model think while the hand is still working; elastic pacing and staged looks fill the rest. |
| Saved pieces stop replaying | A change to the hand or the kernel alters what a strike does | The log is strikes, not passes, and carries a kernel version; a mismatch is reported, never silently replayed wrong. |
| The reference sheet misleads | Generated views disagree with each other, or show a shape stone cannot hold | The brief asks for a compact carvable mass; quadrants are validated; outlines are cut with a margin; the with-and-without round shows whether it earns its place. |
| "It isn't really sculpting" | `rough_out` does a lot of work per call | Every gram still leaves by an animated strike the model asked for, nothing can be undone, and the study's direct arm shows Kyle the difference so he can choose. |

## Considered and rejected

- **Mesh booleans** (three-bvh-csg): fragile after thousands of cuts and needs watertight inputs every time.
- **Rendering the stone by ray-marching the grid** instead of meshing: attractive, but it fights three.js shadows, depth of field and physics. Revisit only if triangle counts become a problem.
- **The model writes code** (the Blender-agent pattern): powerful, but there is nothing to watch, and the point here is the carving.
- **One tool call per strike:** thousands of turns per piece and worse results; the hand exists to avoid it.
- **Logging passes instead of strikes:** smaller, but any change to the hand would break every saved piece.
- **Baking ambient occlusion per vertex:** the post stack's GTAO covers it.
- **Carving from three-quarter views:** their rulers do not line up with the block's axes, so a coordinate read off one is ambiguous.
- **Running Sprints 3 and 4 in parallel:** both edit the scene component, the renderer and the timeline, and Sprint 4 needs Sprint 3's saved stones to tune against.
- **Server-side durable runs** (Inngest or Workflow): needed for spectators and unattended runs, not for watching your own commission. Deferred.
- **TresJS:** the scene is imperative and worker-driven, and TresJS's WebGPU entry point is weeks old.
- **Bootstrapping from cosmo:** no auth, database or marketing surface to inherit.
- **Dropping the second stone preset** (suggested in review): kept, because "marble or other medium" was in the original ask and a preset is cheap.

## Environment / Config Changes

| Variable | Required | Description |
|----------|----------|-------------|
| `AI_GATEWAY_API_KEY` | Yes, for commissions and the study | A capped Vercel AI Gateway key for this project. Covers the sculptor, the judge and the image model. |

## What's Deferred / Out of Scope
- Other media with different physics: clay (additive), wood (grain direction), ice (transparency).
- Reaching surfaces hidden from all five axis views (deep undercuts), which needs tools that carve from an arbitrary direction.
- Stone that snaps under load, beyond pieces that are fully detached.
- A reference supplied by the person ("carve this photo"). It would reuse the reference-sheet path once a photo can be turned into the four-view sheet.
- Spectators, unattended server-side runs, accounts, payments.
- Human and model carving the same block together.
- Analytics. Nothing is public until Sprint 5; if the gallery ships, page views come from Vercel Analytics and nothing custom.

## Open Questions
1. **Name.** `sculptor` is a working title and the folder name. Candidates if this becomes a product: Non Finito (Michelangelo's unfinished figures emerging from the block), Taille Directe, Banker. A collision check comes before any domain.
2. **How pure should the carving be?** The plan lets the sculptor declare masses and have the hand rough toward them, and tests that against stroke-only carving in Round A. If you only want stroke-only, the study still runs but the gate gets harder to pass.
3. **Tools on screen.** Floating chisel and mallet with no hands is the plan. A robot arm would be a striking alternative and roughly doubles Sprint 4's tool work.
4. **Public or private.** Create the GitHub repo private now, and decide on a public gallery at Sprint 5?
5. **Disclosing the reference.** If the study says the reference helps and it ships on by default, should a finished piece's page say so, show the sheet as a "sculptor's study" at the reveal, or say nothing? It makes no difference to the build; it only matters once pieces are shown to other people or models are compared publicly.
