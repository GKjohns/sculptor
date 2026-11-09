# Look book

Fifteen fixed shots for judging the render against itself: five camera presets on three stones taken from saved study runs. Reshoot all of them after every change to the marble, the room, the lights or the post stack, and look at them before deciding the change was an improvement.

```
npm run shoot -- --gpu --lookbook                     # all 15, into docs/look/ (add --url http://localhost:3131 for another server)
npm run shoot -- --gpu --lookbook --only finished     # one stone
npm run shoot -- --gpu --lookbook --preset macro      # one preset on every stone
npm run shoot -- --gpu --preset macro --bare --query "replay=<run>&at=end"   # one shot into .shots/
```

`--gpu` only: headed Chrome on real WebGPU. The files are WebP (`cwebp -q 80`, 1440 px wide, never upscaled).

| Stone | Run | Where in the log |
|---|---|---|
| `early` | `X-bust-opus-formed-ref-tune-2-20261109142712-095` | entry 520: part-way through the first rough-out, sawn planes and the first craters |
| `middle` | `C-bust-sol-formed-ref-20261109130608-a36` | entry 6121: blocked in with the claw, features cut, before the rasp |
| `finished` | `X-bust-opus-formed-ref-tune-2-20261109142712-095` | the end: polished face and chest, claw-textured hair |

| Preset | What it is for |
|---|---|
| `wide` | The whole room: banker, floor, the shaft, the pool of window light, the back wall falling away |
| `medium` | Three-quarter on the stone, the distance most of a commission is watched from |
| `macro` | The face or whatever is at that height, long lens wide open: surface, veins, shallow focus |
| `raking` | From low on the dark side: tool marks under grazing light, the shadow side's fill |
| `backlit` | From behind toward the window: silhouette, bloom, light through anything thin |

The presets are `LOOKS` in `app/studio/look.ts`; `__sculptor.look('macro')` puts the page's camera on one and holds it there. Two more live there for the storyboard's frame 5, on the stone `__sculptor.frame5()` carves (a table with raw, rasped and polished bands and a thin fin): `frame5` and `fin`.

`before_*.webp` is the same fifteen on the Sprint 3 render (one key light, no room, no post), shot once for comparison.

## What is being judged

- Is the marble stone, not plastic or chalk? Do veins read at wide and at macro, and run on through a cut?
- Do the three finishes read apart: raw (matte, pitted, pale), rasped (satin), polished (a crisp highlight)?
- Is the key soft, with shadows that have a penumbra, and does it fall off into the room?
- Does the back of the room fall to black without the stone's shadow side crushing?
- Is there depth: the shaft, the pool on the floor, something out of focus?
- Is the grain felt and not seen?

## Tuning log

Each pass is one look-book shoot and what it led to.

1. **First light.** Stone washed out, room lit like an office. The environment map's window card and the fill were lighting the walls and floor unshadowed. Cut the room's own environment intensity to a few percent, key from 7.5 to 3.4, bloom threshold above paper white.
2. **Speckle.** Orange dots all over the shadow side: the thickness bake read the nearest voxel a fraction of a voxel under the surface, which is sometimes air. Rays now start 1.6 voxels down the normal. Shadow-side fill was a saturated blue; made the fill and the hemisphere light nearly neutral.
3. **Grain that was not film grain.** A sandy noise on raw stone turned out to be the tool-mark normal noise aliasing below a pixel, not the shadow dither. Both noise layers now fade out as their wavelength nears a pixel. Key down to 2.5 so the lit side sits under the tone curve's shoulder and veins survive on it.
4. **Veins.** They read as contour lines on a map (one noise field, nested sheets). Now two families of warped sheets, each a broad smoky band with a thin core, switched on and off along their length. Added light scattered past the terminator (the difference between stone and painted plaster), the yard at the back of the room, a stronger shaft, and reframed `wide` and `backlit`.
5. **Hard shadows under a soft key.** The screen-space contact shadows were marching 5 cm and drawing their own hard edge over the key's penumbra. Cut to 1.4 cm, so they only find tool marks; key penumbra widened to about a centimetre. Thickness changed from a harmonic to a plain mean of its four rays with an exponential falloff, so a thin edge glows as a soft band and not as a hot line. Built the frame-5 stone.
6. **Frame time.** See below; no change to the look intended, but fixing the pre-pass exposed that ambient occlusion had never been doing anything: its `thickness` is in world units and was 1.2 cm. Set radius 10 cm, thickness 12 cm. With real occlusion and the environment no longer accidentally dimmed, the fill was too strong; cut the cool fill card and the floor bounce.
7. **Presets that stay put.** The camera rig was nudging the look-book shots between passes. `look()` now sets the pose again every frame. Pulled `medium` and `macro` back to hold the whole subject.
8. **Final.** Cool fill back up (card 0.28, fill light 0.09): colour contrast against the warm key, and the director's shots from the shadow side were too dim to watch. `medium` stopped down so the plinth stays sharp.

## What it costs

M4 Pro, 1440 x 900 window, drawn at 1.5x (2160 x 1350), whole stack, motion layer on. Frame intervals from `__sculptor.meter()` and `timeReplay(8, 20)`.

| | mean | p95 | max |
|---|---|---|---|
| Finished bust, still, vsync (120 Hz) | 8.33 ms | 9.4 ms | 10.4 ms |
| Replay at 8x, first 20 s (saw cuts and roughing), vsync | 8.34 ms | 9.5 ms | 16.7 ms |
| Finished bust, still, no vsync | 6.4 ms | 15.7 ms | 16.2 ms |
| Replay at 8x, no vsync | 7.0 ms | 23.2 ms | 41.5 ms |
| Same at the display's own 2x (2880 x 1800), vsync: still / replay | 11.6 / 12.4 ms | 16.8 ms | 17.6 / 18.6 ms |

So the film tier draws at 1.5x by default (`?dpr=2` overrides): it holds 120 Hz there and only 60 at 2x.

What each effect adds on its own to a frame with none (2.9 ms), measured in one session at 1.5x (another browser was using the GPU at the time, so read them against each other): depth of field 3.3 ms, bloom 2.5, god rays 1.7, TRAA 1.5, ambient occlusion with its pre-pass 1.3, contact shadows 1.2.

Three things had been costing more than the whole post stack:

- **`DynamicDrawUsage`.** three's WebGPU path uploads an attribute with that usage again on every render call, changed or not. The stone's buffers had it, so the whole stone went to the GPU once per geometry pass, three times a frame: 82% of the main thread. Removed; buffers go up when their version moves.
- **The pre-pass ran every material's full lighting**, and the marble evaluated some thirty noise lookups a fragment. The pre-pass now wears one flat material, and the veins are baked once into a volume (208 slices tiled on one 2048 x 1664 texture) and read back with two samples.
- **One mesh per 32-voxel chunk** is about 150 objects in each of three passes. The stone is drawn as bundles of 2 x 2 x 2 chunks.

The 0.25 cm grid was tried on the finished bust (the same log replayed on a finer grid) and not kept: 648k triangles against 242k, 55 MB a grid copy against 13 MB, 33 s to restore against 10 s, and 27 ms a still frame against 11.5 ms measured at the time (before the fixes above). The voxel size is still a parameter.
