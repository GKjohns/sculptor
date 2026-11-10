# Sculptor — agent notes

An AI carves a block of virtual marble while a person watches. Nuxt 4 at the repo root, `ssr: false`, one full-screen three.js canvas with a Nuxt UI HUD over it. The plan, with the reasons behind every choice below, is `internal_docs/20261108_ai_sculptor/implementation_plan.md`. Read its "Handoff / Execution Notes" before changing anything.

## Shape

```
app/
  app.vue, pages/index.vue        shell; the page is one <StudioScene />
  pages/replay/[id].vue           the replay page: <StudioScene :run-id> for a saved commission or study run, with the scrubber and film export
  components/StudioScene.client.vue   mounts the renderer, the HUD and the commission; owns window.__sculptor and __sceneReady
  components/StudioHud.vue, hud/  the film-style HUD, drawn from one SculptorView (studio/viewState.ts); /hud previews it on mock views
  components/ReplayPicker.vue     saved commissions (.data/sessions) and finished study runs
  components/hud/Transport.vue    the live transport, and the replay's: play, speed, the scrubber over the log, Export film
  composables/useSculptor.ts      a live commission: runs the loop with the worker as Studio, feeds the timeline, keeps the HUD's view, saves the session every turn, resumes one after a reload
  composables/useBrain.ts         the browser's Brain: one POST to /api/brain per turn, read as it streams
  composables/useReplay.ts        fetches a study run or a saved session, owns its ReplayPlayer, mirrors the state for the HUD; seek() for the scrubber, film() for the export
  studio/                         all three.js code, plain .ts, no Vue
    renderer.ts                   StudioRenderer: WebGPURenderer, scene, camera, frame loop; owns the atelier and the post stack; prewarm() builds every material's pipelines before the scene reports ready
    atelier.ts                    the room: banker, floor, walls, window, the quarried blocks at the back, the light rig (key through the window, fill, hemisphere, generated environment); ATELIER_SOLIDS is what debris lands on
    post.ts                       Post: the one RenderPipeline. Film tier (WebGPU): pre-pass, GTAO, contact shadows, scene, god rays, TRAA, depth of field, bloom, AgX, vignette, grain. Plain tier (WebGL 2): scene, AgX, vignette, grain
    materials/marble.ts           the stone: veins baked once into a volume, finish and tool marks from the per-vertex finish, light through thin stone from the baked thickness; loose-piece and chip variants; the presets CARRARA and NERO (stonePreset() maps a name or a run's `stone` text to one)
    look.ts                       the look book's camera presets (__sculptor.look), ?fx= parsing, the storyboard frame-5 stone
    kernel.ts                     KernelClient: the page's end of the worker (promises in, chunk geometry out)
    stone.ts                      Stone: chunk meshes drawn in bundles of 2 x 2 x 2 and refilled in place; the offcut material
    cinema.ts                     Cinema: debris, tools, sound and director wired to each other, to the room and to whichever timeline is bound; one film clock (slow motion is its timeScale)
    debris.ts                     Debris: offcuts as Rapier rigid bodies that fall, break once and come to rest; instanced chips and the pile they leave; budgets in stats()
    rubble.ts                     mesh work on loose pieces: thinning, cleaving along a plane, collider points. No three.js (tests/rubble.test.ts)
    dust.ts                       Dust: puffs and the motes in the window's shaft (a TSL compute particle system, WebGPU only) and the film of dust on the floor
    tools.ts                      Tools: chisel and mallet, saw, rasp, drill, pad; animated from the timeline's strikes and laid along the banker when put down
    sound.ts                      Sound: everything synthesised with Web Audio, started by the first key press or click; mute is remembered in localStorage
    director.ts                   Director: picks the shot (wide, medium, macro, saw, fall, look, reveal, free), cuts and slow motion; the rig does the moving; pending() for an export
    reveal.ts                     Reveal: the floor swept, a light across the piece, the signature cut into the base, on the film's clock when a finished piece was watched to its end
    film.ts                       exportFilm(): a replay rendered frame by frame at a fixed dt to an MP4 (mediabunny, H.264), its speed steered to a fixed length, the title plaque set in over the reveal
    timeline.ts                   Timeline: the virtual clock and the growing queue of strikes and staged looks that plays onto the shown stone; elastic pacing, pause, speed, seek (from the nearest snapshot the worker kept), backpressure on the loop
    replay.ts                     ReplayPlayer: a timeline with its queue filled up front and its pace fixed
    camera.ts                     CameraRig: default framing, the walk round the stone for a staged look, hand-back after a drag
    charcoal.ts                   the lines a `sketch` pass draws on the block; cuts rub them out where the stone goes
    viewState.ts                  the HUD's view-model and the pure helpers that change it
    hands.ts                      hand-carving input behind ?hands=1 (palette is components/HandPalette.vue)
    debug.ts                      demo(), burst(), timeReplay() and frameMeter() behind window.__sculptor
  workers/kernel.worker.ts        the kernel in a worker: the true stone with the Studio running against it, the shown stone remeshed chunk by chunk, look PNGs and the reference sheet decoded here, snapshots of a stone kept for scrubbing
shared/
  sculpt/                         the kernel: grid, strikes, mesher (which also bakes the per-vertex thickness the marble reads), islands, hand, observer. No three.js, no DOM
  sculpt/anatomy.ts               the sculptor's canon: a declared `head` (with style tokens and canon cuts) or `torso` expanded into kernel primitives before anything is logged
  sculpt/hair.ts, torso.ts        the head's hair and beard; the bust's trunk, neck, drapery and socle
  sculpt/figure.ts                the canon of the body: posed human figures, quadrupeds and groups (declare_figure), reaching limbs from hip and shoulder
  sculpt/frame.ts                 the canon's matrix and frame helpers
  sculpt/display.ts               DisplayStone: lets loose stone fall on screen ahead of the log's island check without touching the log's stone
  sculpt/protocol.ts              the messages between page and worker; every one names a stone ('true' | 'shown')
  agent/                          the look, think, carve loop and its Brain and Studio seams
server/api/                       stateless gateway routes: brain, reference, health, sessions
server/api/study/                 finished runs under .data/study for the replay: the list, a strike log, a pass record
tests/                            node --test, kernel only
bench/                            the headless model study
scripts/shoot.mjs                 screenshot loop with a blank-capture guard; also the look book, sequences and timing runs
docs/look/                        the look book: 15 fixed shots (5 presets on 3 saved stones) and the tuning log; reshoot after any change to the look
internal_docs/                    plans, storyboard, research, verification pages
```

All five sprints of the plan are built. Nothing is deployed: the gallery and deploy (task 5.5) wait on Kyle deciding whether this goes public.

## Commands

Node 22 (`source ~/.nvm/nvm.sh && nvm use 22`), npm.

- `npm run dev`: port 3130. `/replay/<id>` is the replay page for a saved commission (`.data/sessions/`) or a study run (`.data/study/`): scrubber, film export, the title plaque; `?speed=` and `?at=end` work there as on `/?replay=`. `?stone=nero` puts the black marble on the banker (a commission records its stone, and its replays use it). `?gl=1` forces the WebGL 2 backend, `?hands=1` turns on hand-carving, `?demo=1` carves a fixed demo (sawn corner, rough, flat-chiselled and rasped patches) before the scene reports ready. `?replay=<run-id>` plays a finished study run (`?replay` alone lists them), with `?speed=1|8|30|120|max` and `?at=end` to go straight to the finished piece before the scene reports ready. `?session=<id>` puts a saved commission (`.data/sessions/`) back on the stone and carries on if it was unfinished; with `&pass=<n>` it shows the stone as it stood after pass n and resumes nothing. A commission's defaults are in `app/app.config.ts`; `?model=`, `?planner=` (a second model for the opening turns), `?ref=0|1`, `?turns=`, `?usd=` and `?speed=1|4|8|20|60` override them for one page load.
- Film flags, all for one page load:
  - `?film=0`: no debris, tools, sound or director at all (the stone alone in the room), to measure what they cost.
  - `?cam=free`: the director leaves the camera alone; it stays where you, or a look preset, put it.
  - `?fx=-dof,-godrays` (or `none`, `all`, `+name`): drops or adds post effects over the tier's own set. Names: `ao`, `contact`, `godrays`, `traa`, `dof`, `bloom`, `grain`, `vignette`.
  - `?dpr=1|1.5|2`: caps the device pixel ratio the canvas is drawn at. Left out, the film tier draws at 1.5 at most and the plain tier at 2.
  - `?prewarm=0`: skips the unculled frames that build every material's pipelines before the scene reports ready, to measure the first-slab hitch they remove.
  - Film export runs in the page from the replay's transport (Export film: 30 s, one minute, two minutes, 1920 x 1080 at 30 fps), or `__sculptor.film({ seconds, width, height, fps })`, which resolves with frames, size and render time. It holds the frame loop and steps it at 1/fps, so the tab draws nothing else meanwhile; a 60 s film takes about 70 s on Kyle's Mac. Sound is not in the film.
  - `/hud` (the HUD on mock views, no stone): `?frame=1..8` picks the storyboard frame, `?panel=notebook|eye` opens a side panel, `?stress=1` fills it with the longest text it has to hold, `?bare=1` leaves out the preview's own controls.
- `npm run typecheck` (Nuxt's projects, then `tsconfig.bench.json` for `bench/` and `tests/`), `npm run lint`, `npm test` (`node --test tests/*.test.ts`): all three before calling work done.
- `npm run shoot -- --gl [--name x] [--query "a=1&b=2"]`: headless, software WebGL 2. Layout and logic.
- `npm run shoot -- --gpu ...`: headed Chrome, WebGPU. The only mode for judging how anything looks.
- `npm run shoot -- --gpu --eval "__sculptor.burst(200)"`: runs an expression in the page and prints the result; this one gives frame times for 200 rapid strikes.
- More `shoot` options (the full list is at the top of `scripts/shoot.mjs`):
  - `--url http://localhost:3131/`: another server than port 3130 (a worktree's).
  - `--preset wide|medium|macro|raking|backlit`: puts the camera on a look-book shot and holds it there.
  - `--seek n`: with a `?replay=` query, the stone as it stood after log entry n.
  - `--bare`: leaves the HUD out of the saved picture. `--webp`: also writes a `.webp` (needs `cwebp`).
  - `--dpr n`: the browser's device pixel ratio (1 if left out; a Retina screen is 2).
  - `--unthrottled`: no vsync and no frame cap, so frame times show what a frame costs. Timing only.
  - `--lookbook [--only early,finished] [--preset macro] [--prefix before_]`: reshoots the look book into `docs/look/` as WebP. Needs `--gpu`.
  - `--gesture`: presses a key once the scene is ready, the user gesture that lets the page start its sound.
  - `--until "js"`: after `--eval`, waits up to two minutes for an expression to turn truthy (a slab leaving the block).
  - `--sequence n [--every ms]`: n pictures that far apart, for motion (`<name>_01_<mode>.png` onward).
  - `--downloads dir`: saves whatever the page hands the browser to save, e.g. `--eval "__sculptor.film({ seconds: 60 })" --downloads .shots/films`.
  - `--api`: lists every `/api/` request the page made (a replay should make no model calls).
- Shots land in `.shots/` (gitignored). Keepers are copied by hand into a plan's `verification/screenshots/`.
- `npm run bench:sculpt -- --subject pawn|cat|bust|david|bull|rider [--model opus|fable|fable52|sol|gemini] [--tools direct|formed] [--ref on|off] [--round A|B|C] [--planner <model>]`: one headless commission into `.data/study/<run-id>/`. `--dry` runs a scripted Brain with no key into `.data/study-dry/`. Flags are listed at the top of `bench/sculpt.ts`.
- `npm run bench:study -- --round A` (then `--round B --tools X`, `--round C --tools X --ref on|off`): a whole round, three runs at a time. Spend is capped per run (`--max-usd`, default 8) and across the study (`--study-cap`, default 100, summed from `.data/study/ledger/`).
- `npm run bench:canon -- --preset bust|woman|plain|old|all [--fast]` and `npm run bench:poses -- --preset david|...|all [--carve]`: the head, bust, figure and animal canons on their own, rendered to `.shots/canon` and `.shots/poses`, no model. `npm run bench:timing`: a full rough-out timed against how many solids the form holds. `node bench/rerun-declare.ts --run <run-id>`: a saved run's `declare_figure` declared again through today's Studio and roughed out, to see what a canon change does to a real declaration.
- `npm run bench:report`: writes `internal_docs/20261108_ai_sculptor/study/report.html` from whatever has been run.

## Rules

**three.js is on the WebGPU path.**
- Import three from `three/webgpu` and TSL from `three/tsl`. Never from bare `three` in `app/` (addons under `three/addons/` are fine).
- Materials are node materials (`MeshStandardNodeMaterial`, `MeshSSSNodeMaterial`, ...) with TSL nodes.
- `ShaderMaterial`, `RawShaderMaterial`, `onBeforeCompile` and `EffectComposer` do not work on this path. Do not copy post-processing from Voice World or any other `WebGLRenderer` repo.
- Post-processing is one `RenderPipeline` (r183 renamed it from `PostProcessing`) built from `pass(scene, camera)` and nodes in `three/addons/tsl/display/`. It lives in `app/studio/post.ts`.
- A lit material that first comes into view mid-commission costs a 100 ms frame (its own shader, and the AO and contact-shadow passes are set up again with it). `StudioRenderer.prewarm()` draws everything unculled before the scene reports ready; anything added to the scene later should share a material that is already there, or be added before that call.
- Do not mark a buffer `DynamicDrawUsage` that is drawn in more than one pass: three's WebGPU path uploads it again on every render call.
- Renderer init is async: `await renderer.init()` before the first render or any backend check.
- Nothing in `app/studio/` reads the wall clock: time comes in only as the frame's dt. Film export depends on it (it steps the studio with `StudioRenderer.hold()/step()`). Anything async that a frame depends on needs a `pending()` the export can wait on (the timeline's batch, `Stone.arrived()`, the director's raycast, the signature's placement).
- Raw three.js only. No TresJS. Scene code lives in `app/studio/*.ts`; the `.client.vue` component only mounts it.
- Scene units are block centimetres: origin at the centre of the block's base, +Y up, +Z toward the viewer, +X to the viewer's right.

**Imports.**
- From `app/` and `server/`: `#shared/...` for shared code, `~/...` for app code.
- Inside `shared/`, `tests/` and `bench/`: relative imports with the `.ts` extension (`import { x } from './grid.ts'`). Those files also run under plain `node`, which resolves neither aliases nor missing extensions. Nuxt's generated tsconfig already sets `allowImportingTsExtensions`.
- `shared/` never imports three.js, Vue or anything from the DOM.
- The worker is bundled on its own: `#shared/...` resolves there, Nuxt auto-imports do not. Import everything by name in `app/workers/`.

**Screenshots.**
- The page sets `window.__sceneReady = true` once the whole stone has been meshed and frames with it have rendered, and exposes `window.__sculptor` (`stats()` gives backend, frame count, frame time, draw calls; `studio()` gives the `StudioRenderer`; `hash('true' | 'shown')` a stone's grid hash; `kernel(stone)` its rev, mass and early-check cost; `replay()` the loaded `ReplayPlayer`; `start('a chess pawn')` or `start({ commission, model, reference })` begins a commission and `state()` says where it stands (status, turn, cost, queue depth, virtual time, clock rate, strikes shown and applied, dead air); `sculptor()` is the commission itself (`pause`, `resume`, `setSpeed`, `abort`, `load`, `replayTo`, `saved`); `meter()` times frames until its `stop()`; `demo()`, `burst(n)`, `timeReplay(speed, seconds?)` and `timeRestore(runId)` are the verification runs; `cinema()` is the film (`stats()` says what debris, director, tools and sound are doing and their budgets, `slow(0.1)` is bullet time for captures); `look('macro')` puts the camera on a look-book preset and `frame5()` carves the storyboard's frame-5 stone; `film(options)` exports the loaded replay; `setStone('nero')` changes the stone's medium). Keep both working: the shoot script waits on them.
- Editing anything under `app/` while a page is open hot-reloads the scene: the stone, the commission and any timing run in that page are gone (`timeReplay` rejects, saying so). Do not edit while a live commission or a measurement is running in the same worktree.
- HUD roots carry a `data-hud` attribute. The shoot script hides them for its blank-canvas check so a HUD over a black canvas still fails.
- A headless WebGPU capture can be silently black. Never judge the look from `--gl`, and never from a screenshot the guard did not pass. `--gl` runs a lean mode (no vein bake, fewer shadow taps, a small environment map), because software WebGL loses its context under the full one.
- Sound needs a user gesture. In automation, `--gesture` (or a real click) starts it; add Chrome's `--mute-audio` to keep it off the speakers, and read an `AnalyserNode` hung on the master gain to check it.

**Style.**
- No semicolons, 2 spaces, no trailing commas, `1tbs` braces (ESLint stylistic, enforced by `npm run lint`).
- Nuxt UI 4 primitives for every panel and control. Dark only. The canvas and the film-style HUD layout are the only custom layout.
- Model calls go through the Vercel AI Gateway only (`AI_GATEWAY_API_KEY`), per `~/claude-ops/conventions/ai_sdk_usage.md`.

**Carving tools (skill passes).**
- `declare_form` accepts `kind: head` and `kind: torso`: `shared/sculpt/anatomy.ts` (with `hair.ts` and `torso.ts`) expands them into kernel primitives (a head is fifty to a hundred: skull, eyes between lids, nose, lips, jaw, ears and hair in locks; a torso is neck, shoulders, chest to a rounded cut, drapery and socle) before the form is logged, so logs hold only kernel kinds and replay on kernel 2. Every shape carries `style` tokens (sex, age, jaw, nose, expression, gaze, hair, beard; drapery and socle for a torso), an empty list for the plain kinds. Tune the canon offline with `npm run bench:canon -- --fast`; `tests/anatomy.test.ts` pins the landmarks.
- Canon cuts: the head and torso also mark hollows (iris ring, drilled pupil, lid lines, nostrils, mouth, curl eyes, folds) that ride on the form's log entry (`FormStrike.cuts`, which the kernel ignores) and are struck by `detail` in its window (`incise` in `hand.ts`) as ordinary strikes.
- A shape may carry its own `blend` (never more than the form's): the canon's lids, lips, nostrils and locks stay crisp on a softly blended body. Old logs have none and replay as before.
- Hair modes are style tokens: `waves` (default: a swept mass from an off-centre parting with a fringe), `curls`, `long_hair`, `short_hair`, `bun`, `bald` (`hair.ts`).
- The finish guard (`FINISH_FLOOR` in `shared/agent/loop.ts`): a commission that used `declare_figure` or a head or torso canon has `finish` refused before 40 percent of its turns, twice at most, while under 70 percent of its money; the refusal quotes the commission back. The scripted `--dry` Brain tries finish three times for that reason.
- `declare_figure` (`shared/sculpt/figure.ts`): one to three posed subjects plus the model's own shapes as one form. Figures: body, build, ground point, height, facing, legs (stand, stride, lunge, kneel, sit, recline, crouch, ride), weight_on (contrapposto), twist, lean, head turn/tilt, each arm's gesture, drapery, support, head style. Animals: horse, bull, lion, dog, cat; stand, walk, trot, gallop, rear, charge, lie, sit; head turn/raise, tail, lead. Arm gestures include `sling` (a throw's wind-up: it winds the torso and puts the other hand at the far hip), `reach_up` and `embrace`. Limbs reach from hip and shoulder by a two-bone reach; a rider sits on the first animal. Grounds and rocks under subjects are capped at a fifth of the block (`capGround`), and the result says when. The result gives each subject's extent and landmarks. Tune with `npm run bench:poses`; `tests/figure.test.ts` pins the poses.
- Forms of many solids: `formDistance` keeps per-cell candidate lists (bins) and strike clipping a sample memo (`formDistanceAt`), both exact (same number to the last bit). A two-figure group (~180 solids) roughs out in about 25 s at 3 cm against 7 s for a 24-solid form.
- The prompt's COMPOSITION AND POSE section and the reference brief ask for a moment, a dominant diagonal, torsion, a gesture and supports, and call a frontal, symmetric, static pose a failure unless commissioned. Keep that block separate from the tool notes so prompt edits merge.
- `detail` is a windowed `roughOut` (`window` option in `hand.ts`): flat chisel, margin 0.1, no saw, only surfaces facing the view. It is how a face is finished; the form is what you get.
- Detail mode: `focus` / `unfocus` live in the Studio (`shared/agent/studio.ts`), not the loop. While focused, `look` shows the window, strokes must be from that view, inside it and under a fifth of its width, and `rough_out` and `saw` are refused. Close-ups report the surface's relief along their centre lines. Focus is in-memory only: a reload or a context rebuild leaves the sculptor unfocused.
- The rasp protects the form last cut to by `rough_out` or `detail` (`RaspPass.protect`), so smoothing cannot take a declared feature down.
- `shared/agent/planner.ts` splits a commission between a planner (the first three turns: plan, form, first rough-out) and an executor; `--planner` in the bench, `?planner=` or `sculptor.planner` in `app.config.ts` in the app. The planner's reasoning parts are dropped before the executor sees the history.
- The camera takes a macro shot for `closeup` and `focus` looks (`Macro` in `camera.ts`, carried on `TimelineLook.macro`).
- Bench subjects: pawn, cat, bust (the study's twelve judge labels) and david, bull, rider (their own twelve, with the same subject at rest among the distractors).

**Process.**
- Commit locally per sprint. Do not push or create a remote until Kyle says so.
- Stone cannot be put back: there is no undo in the kernel, and none should be added.
