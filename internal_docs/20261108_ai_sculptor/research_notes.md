# Research notes — 8 November 2026

Two web-research passes ran before the plan was written. This file keeps what they found and what the plan took from it. Each line is marked **read** (the page was opened), **snippet** (search result only), or **inference**.

## Part 1. Carving geometry and prior art

### Stone representation

- **read** GPU marching cubes over a full 256³ volume takes 31–37 ms on an RTX 3080 and 41–54 ms on an M2 Max in WebGPU ([Will Usher](https://www.willusher.io/graphics/2024/04/22/webgpu-marching-cubes/)). That is a whole-volume remesh, so remeshing only the chunks a strike touches is comfortably real-time.
- **read** A three.js forum write-up sphere-traces a 512³ SDF 3D texture and reports tracing cost stays flat while triangle cost climbs past roughly 100k triangles ([forum](https://discourse.threejs.org/t/signed-distance-fields-for-fun-and-profit/77121)).
- **snippet** Meta's Medium stored a sparse narrow-band level set, about 2 voxels wide, in 8³ blocks ([Meta](https://developers.meta.com/horizon/blog/medium-under-the-hood-part-2-move-tool-implementation/)).
- **snippet** One devlog found a smoothing brush collapsed the distance field on a small volume ([Cinevva](https://app.cinevva.com/blog/2026-04-13-open-world-browser-part-13-terrain-sculpting)). Single source, but it matches how truncated SDFs behave.
- **snippet** Dreams' Alex Evans on SDF-in-3D-texture: "great for incremental edits, but terrible for loading and animation". We only need incremental edits.
- **inference** 256³ at 8 bits is about 16 MB; 512³ is about 128 MB. Dense 256³ is the low-risk start.

### Meshing

- **read** `isosurface` (surface nets, marching cubes) is unmaintained since 2014 ([repo](https://github.com/mikolalysenko/isosurface)). The three.js `MarchingCubes` addon is a metaball effect, not a chunked mesher ([docs](https://threejs.org/docs/pages/MarchingCubes.html)).
- **snippet** `fast-surface-nets` is Rust only: chunk-friendly naive surface nets with padded chunks ([repo](https://github.com/bonsairobo/fast-surface-nets-rs)). No JS port was found.
- **Taken into the plan:** write our own naive surface nets over padded 32³ chunks (about 150 lines). No dependency is worth taking here.

### Existing web sculpting tools

- **read** SculptGL is mesh-based and was archived in January 2026 ([repo](https://github.com/stephomi/sculptgl)).
- **read** The three-mesh-bvh sculpt demo moves vertices on a fixed-topology sphere and never removes material ([source](https://github.com/gkjohnson/three-mesh-bvh/blob/master/example/sculpt.js)).
- **snippet** three-bvh-csg does mesh booleans but needs watertight manifold inputs ([repo](https://github.com/gkjohnson/three-bvh-csg)). Thousands of accumulated chisel cuts would be fragile.
- **Taken into the plan:** nothing existing fits subtractive carving. Voxel SDF with our own kernel.

### Chips and fracture

- Nothing useful turned up on simulating stone chips. General practice is to fake it: jitter the cut with noise, spawn short-lived debris at the cut, leave tool-mark texture.

### Agents that act, render, look and correct

| System | Actions | Feedback | What it showed |
|---|---|---|---|
| [BlenderMCP](https://github.com/ahujasid/blender-mcp) (read) | arbitrary Blender Python | viewport and multi-angle screenshots | complex operations need breaking into small steps |
| [BlenderGym](https://arxiv.org/html/2504.01786v1) (read) | Python script diffs | two rendered views | 13 VLMs trail humans badly; they miss or hallucinate subtle differences; best VLM verifier agrees with humans 0.66 against 0.79 between humans |
| [L3GO](https://arxiv.org/html/2402.09052) (read) | five add-primitive calls | text only | a rule-based spatial critic matters: removing it drops accuracy from 0.60 to 0.515 |
| [VIGA](https://arxiv.org/abs/2601.11109) (abstract) | code | render and inspect | 35% better on BlenderGym than one-shot |
| [ViSculpt](https://arxiv.org/abs/2608.24169) (abstract) | localized mesh edits via simulated GUI | watches the viewport | closest prior art to "an LLM sculpts"; results described as initial |
| [MineBench](https://github.com/Ammaar-Alam/minebench) (read) | voxel JSON or `block`/`box`/`line` | none | models can place primitives blind |

### How well vision models handle space

- **read** PointArena: pointing accuracy varies enormously by model, and asking for chain-of-thought before pointing made it worse ([paper](https://arxiv.org/html/2505.09990v2)).
- **snippet** Set-of-Mark: picking numbered marks beats asking for raw coordinates ([paper](https://arxiv.org/abs/2310.11441)). Scaffold: a labelled dot-matrix overlay beats text-only reasoning ([paper](https://arxiv.org/abs/2402.12058)).
- **snippet** "Vision language models are blind": unreliable on basic geometry such as whether two lines cross. SVG benchmarks rate spatial accuracy as the weakest dimension.
- No study compares drawing 2D silhouettes or pointing in a view against emitting raw 3D coordinates. That comparison is ours to run.
- **Taken into the plan:**
  1. Looks are orthographic with a labelled centimetre grid, and tools take positions read off that grid.
  2. Code, not the model, verifies geometry: every look returns numbers (remaining mass, how far the stone stands proud of the declared form, silhouette agreement with the reference outlines).
  3. The Sprint 2 study compares addressing modes instead of assuming one.
  4. Freehand profile sketches are treated as a guide and a piece of theatre, not as a precise cutting template, until the study says otherwise.

### Real stone carving, mapped to tools

Source (read): Wootton, Russell and Rockwell, ["Stoneworking techniques and processes"](https://artofmaking.ac.uk/content/essays/3-stoneworking-techniques-and-processes-w-wootton-b-russell-p-rockwell/), Art of Making. "Carvers will progress from the general to the specific." Guidelines were drawn on the stone in charcoal or paint, and models were used for statuary.

| Real tool | Job | In the kernel |
|---|---|---|
| Point chisel | roughing out, removes the most stone | large, low-precision conical bites; leaves a pitted finish |
| Tooth (claw) chisel | intermediate shaping | medium, wide, shallow bites; leaves parallel grooves |
| Flat chisel, roundel | fine shaping and detail | small precise planar or concave cuts; leaves a clean matte finish |
| Drill | deep detail and undercuts | cylinder subtraction |
| Rasp | smoothing | local smoothing that only removes high spots |
| Abrasives | polish | finish channel only, no geometry change |
| Model plus measuring | transferring a design | the declared form: primitives the hand roughs toward, with a margin |

## Part 2. Browser rendering stack

### three.js today

- **read** Current release is r187 (`three@0.187.0`, 30 October 2026). The fleet's 3D apps are on r186.
- **read** WebGPU is not the official default. The r187 manual says the renderer "is still in an experimental state", and three's own `llms.txt` tells coding agents to use `WebGLRenderer` unless they need TSL, compute or node materials ([manual](https://threejs.org/manual/pages/webgpurenderer.html)). We need all three.
- **read** Imports are `three/webgpu`, `three/tsl` and `three/addons/tsl/display/*`. Init is async. WebGL 2 fallback is automatic; `forceWebGL: true` forces it. `ShaderMaterial`, `onBeforeCompile` and `EffectComposer` are unsupported on this path.
- **read** `PostProcessing` was renamed `RenderPipeline` in r183. Pattern: `new THREE.RenderPipeline(renderer)`, `pass(scene, camera)`, `scenePass.setMRT(mrt({ output, velocity }))`, then set `outputNode`.
- **read** Effects shipped in r187: `ao` (GTAO), `ssr`, `ssgi`, `traa`, `dof`, `bloom`, `film`, `godrays`, `motionBlur`, and `sss`, which is screen-space shadows and not subsurface scattering. `AgXToneMapping` exists.
- **read** Browser support: Chrome 113+, Safari 26 on by default, Firefox 147 on all macOS.

### How people get good-looking results with coding agents

- **read** Simon Willison's ["The October inflection point for vibe game development"](https://simonwillison.net/2026/oct/28/vibe-game-development): Opus 5.5, a spec written first, then Claude Code. The games are stylised, not cinematic.
- **read** [Velocity GP](https://buildingbetter.tech/p/i-built-a-browser-racing-game-in): the loop is play, screenshot what looks off, describe it.
- **read** Skills people load: [`dgreenheck/webgpu-claude-skill`](https://github.com/dgreenheck/webgpu-claude-skill) (TSL, compute and post-processing reference, updated for r183+) and [`majidmanzarpour/threejs-game-skills`](https://github.com/majidmanzarpour/threejs-game-skills) (Playwright visual regression and canvas pixel metrics; WebGL-era).
- **read** The best cinematic reference found is [`ektogamat/threejs-conference`](https://github.com/ektogamat/threejs-conference): `RenderPipeline`, a GTAO pre-pass, half-resolution bloom, depth of field, film grain, compute-shader rain. It ships an `AGENTS.md`.
- **read** Trap: headless Chrome can capture a black WebGPU canvas without any error ([guide](https://vgpu.labs.vercel.dev/guides/agent-browser-webgpu)).
- Nothing found: a named vibe-coded demo that looks like film. Vibe Jam 2026 winners were not published.
- **inference** Quality comes from a render pipeline specified by hand, reference code in the agent's context, and a screenshot loop you can trust. Model choice matters less.
- **Taken into the plan:** Sprint 4 names its pipeline node by node, reads `threejs-conference` first, and iterates against a fixed look book of camera presets. The shoot script forces WebGL 2 and checks pixel variance. Whether to install the WebGPU skill is Kyle's call; it is third-party code.

### Marble

- **read** `MeshSSSNodeMaterial` is in core and extends the physical material with thickness-based translucency (an approximation, not true diffusion). The official example feeds it a baked thickness texture.
- **read** `tsl-textures` 3.0.5 has `marble.js`: three octaves of noise on object-space position.
- Nothing found: a real-time marble statue demo with subsurface light. One forum thread reports a subsurface shader breaking under WebGPU.
- **Taken into the plan:** `MeshSSSNodeMaterial` with our own position-based veining, and thickness baked per vertex by the mesher because a block being carved cannot have a thickness texture.

### Vue and Nuxt

- **read** TresJS 5.10 added a WebGPU entry point (`@tresjs/core/webgpu`) in late October 2026. Its docs label it experimental, its post-processing package is WebGL-only, and an open PR covers duplicate renderers under hot reload.
- **Taken into the plan:** raw three.js in one client-only component, as in the fleet's other 3D apps.

### Physics and particles

- **read** Rapier is at 0.21.0 across `@dimforge/rapier3d`, `-compat` and `-simd`; three r187's helper pins the same version.
- **read** TSL compute particle examples use `instancedArray` plus `renderer.compute()`.
- Nothing found: a benchmark for many small rigid chips.
- **Taken into the plan:** Rapier for offcuts and a few hundred hero chips, ballistic instancing for the rest, TSL compute for dust.

### Recording

- **read** `mediabunny` 1.65 encodes a canvas frame by frame (`CanvasSource`, `add(timestamp, duration)` with backpressure). `canvas-record` 6 wraps it and claims WebGPU canvas support.
- Nothing found: a confirmed end-to-end recipe for a three.js WebGPU canvas.
- **Taken into the plan:** step the virtual clock manually and encode one frame per step; spike it before building the export UI.
