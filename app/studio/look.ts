/**
 * The look book's five fixed shots (docs/look/), and the page's end of the shoot script's
 * --preset flag: `__sculptor.look('macro')` puts the camera there, sets the focus and holds the
 * camera rig off, the way a drag does. They are for judging the render against itself from one
 * tuning pass to the next; the shots a commission is watched through are the director's.
 */
import * as THREE from 'three/webgpu'
import { createRng } from '#shared/sculpt/rng'
import type { Strike, Vec3 } from '#shared/sculpt/types'
import type { KernelClient } from './kernel'
import type { PostEffects } from './post'
import type { StudioRenderer } from './renderer'
import type { Stone } from './stone'

export interface LookPreset {
  /** Camera position and what it looks at, block cm. */
  from: [number, number, number]
  at: [number, number, number]
  /** Vertical field of view, degrees. */
  fov: number
  /** What is sharp, and how wide the lens is open (0 everything sharp, 1 a macro lens wide open). */
  focus: [number, number, number]
  aperture: number
}

export const LOOKS: Record<string, LookPreset> = {
  // The whole room: banker, floor, the shaft from the window, the back wall falling away.
  wide: { from: [118, 58, 372], at: [34, 30, 0], fov: 36, focus: [0, 55, 0], aperture: 0.12 },
  // Three-quarter on the stone, the default watching distance.
  medium: { from: [104, 86, 182], at: [0, 52, 0], fov: 32, focus: [0, 60, 20], aperture: 0.2 },
  // The face, or whatever is being worked at that height, on a long lens wide open.
  macro: { from: [36, 84, 84], at: [1, 76, 12], fov: 24, focus: [2, 78, 15], aperture: 0.9 },
  // From low on the dark side, looking along the surface the key rakes across.
  raking: { from: [112, 16, 64], at: [0, 56, 4], fov: 30, focus: [10, 60, 12], aperture: 0.45 },
  // From behind, toward the window: light through whatever is thin.
  backlit: { from: [128, 60, -34], at: [-8, 84, 10], fov: 28, focus: [6, 78, 2], aperture: 0.6 },
  // Storyboard frame 5, on the stone carveFrame5() makes: the three finishes side by side under
  // raking light, and behind them a fin of stone with the window's light coming through it.
  frame5: { from: [54, 86, -39], at: [0, 65, 0], fov: 30, focus: [2, 62, 2], aperture: 0.55 },
  // The same stone from lower down, so the fin stands against the window it is lit by.
  fin: { from: [42, 60, -30], at: [-12, 74, 10], fov: 34, focus: [-11, 70, 6], aperture: 0.5 }
}

let letGo: (() => void) | null = null

/**
 * Puts the camera on a preset and holds it there: the pose and the focus are set again every
 * frame, after whatever else steers the camera has had its say, until releaseLook().
 */
export function applyLook(studio: StudioRenderer, name: string) {
  const look = LOOKS[name]
  if (!look) throw new Error(`no look called '${name}' (there are: ${Object.keys(LOOKS).join(', ')})`)
  releaseLook()
  // What a pointer going down on the canvas sends: whoever steers the camera lets go until it comes up.
  studio.controls.dispatchEvent({ type: 'start' })
  const damping = studio.controls.enableDamping
  studio.controls.enableDamping = false
  const focus = new THREE.Vector3(...look.focus)
  const hold = () => {
    if (studio.camera.fov !== look.fov) {
      studio.camera.fov = look.fov
      studio.camera.updateProjectionMatrix()
    }
    studio.camera.position.set(...look.from)
    studio.controls.target.set(...look.at)
    studio.setFocus(focus, look.aperture)
  }
  hold()
  studio.controls.update()
  const stop = studio.onFrame(hold)
  letGo = () => {
    stop()
    studio.controls.enableDamping = damping
    studio.controls.dispatchEvent({ type: 'end' })
  }
  return look
}

/** Hands the camera back after applyLook(). */
export function releaseLook() {
  letGo?.()
  letGo = null
}

/** `?fx=-dof,-godrays`, `?fx=none`, `?fx=none,ao`: effects to drop from or add to the tier's set. */
export function effectsFromQuery(value: unknown): Partial<PostEffects> {
  const out: Partial<PostEffects> = {}
  if (typeof value !== 'string') return out
  const names: (keyof PostEffects)[] = ['ao', 'contact', 'godrays', 'traa', 'dof', 'bloom', 'grain', 'vignette']
  for (const part of value.split(',')) {
    const word = part.trim()
    if (word === 'none') for (const n of names) out[n] = false
    else if (word === 'all') for (const n of names) out[n] = true
    else {
      const name = word.replace(/^[-+]/, '') as keyof PostEffects
      if (names.includes(name)) out[name] = !word.startsWith('-')
    }
  }
  return out
}

// The frame-5 stone is laid out along the way the key's light travels over the floor (toward the
// camera that shoots it) and square to that: [x, z] of a point `along` and `across` from the middle.
const ALONG: [number, number] = [0.78, -0.63]
const ACROSS: [number, number] = [0.63, 0.78]
const plan = (along: number, across: number): [number, number] => [along * ALONG[0] + across * ACROSS[0], along * ALONG[1] + across * ACROSS[1]]

/**
 * A fixed stone for storyboard frame 5: the block taken down to a table at 60 cm, left as the
 * point chisel leaves it, with one band of it rasped and one rasped and polished, and standing on
 * it a fin of stone a couple of centimetres thick at the middle and nothing at the rim.
 * `size` is the block, cm. Deterministic.
 */
export function frame5Strikes(size: Vec3): Strike[] {
  const [w, h, d] = size
  const rng = createRng(505)
  const table = 60
  const [fx, fz] = plan(-5, -12)
  // Thin along the light, so the light goes through it.
  const fin = { kind: 'ellipsoid' as const, center: [fx, table + 5, fz] as Vec3, size: [2.4, 30, 19] as Vec3, rotation: [0, 39, 0] as Vec3 }
  const strikes: Strike[] = [
    { kind: 'form', name: 'frame5', blend: 0, shapes: [{ kind: 'box', center: [0, table / 2, 0], size: [w + 4, table, d + 4], rotation: [0, 0, 0] }, fin] },
    { kind: 'form', name: 'frame5-fin', blend: 0, shapes: [fin] }
  ]
  // Everything above the table that is not the fin, a layer at a time.
  for (let y = h; y > table; y -= 4) {
    for (let x = -w / 2 + 2; x <= w / 2 - 2; x += 5.6) {
      for (let z = -d / 2 + 2; z <= d / 2 - 2; z += 5.6) {
        strikes.push({ kind: 'cut', tool: 'flat', at: [x + rng.range(-0.8, 0.8), y, z + rng.range(-0.8, 0.8)], dir: [0, -1, 0], size: 9.5, depth: 5, seed: rng.int(1 << 30), protect: 'frame5', ms: 120 })
      }
    }
    strikes.push({ kind: 'detach' })
  }
  // The table as the point chisel leaves it.
  for (let x = -w / 2 + 1; x <= w / 2 - 1; x += 2) {
    for (let z = -d / 2 + 1; z <= d / 2 - 1; z += 2) {
      strikes.push({ kind: 'cut', tool: 'point', at: [x + rng.range(-0.7, 0.7), table + 0.4, z + rng.range(-0.7, 0.7)], dir: [rng.range(-0.25, 0.25), -1, rng.range(-0.25, 0.25)], size: rng.range(2.8, 4), depth: rng.range(1, 1.9), seed: rng.int(1 << 30), protect: 'frame5-fin', margin: 0.4, ms: 200 })
    }
  }
  // Two bands across it, rasped until the marks are gone; the far one is then polished.
  const rasped: [number, number] = [5.5, 12.5]
  const polished: [number, number] = [14, 22]
  for (let pass = 0; pass < 16; pass++) {
    for (let across = rasped[0]; across <= polished[1]; across += 2.6) {
      for (let along = -16; along <= 20; along += 2.6) {
        const [x, z] = plan(along + rng.range(-0.8, 0.8), across + rng.range(-0.8, 0.8))
        strikes.push({ kind: 'cut', tool: 'rasp', at: [x, table - 1.6, z], dir: [0, -1, 0], size: 8, depth: 0.6, seed: 0, ms: 120 })
      }
    }
  }
  for (let pass = 0; pass < 5; pass++) {
    for (let across = polished[0] + 1.5; across <= polished[1]; across += 2.4) {
      for (let along = -16; along <= 20; along += 2.4) {
        const [x, z] = plan(along, across)
        strikes.push({ kind: 'cut', tool: 'polish', at: [x, table - 2, z], dir: [0, -1, 0], size: 7, depth: 0.6, seed: 0, ms: 120 })
      }
    }
  }
  strikes.push({ kind: 'detach' })
  return strikes
}

/** Carves the frame-5 stone onto whatever is on the banker and resolves once it is on screen. */
export async function carveFrame5(studio: StudioRenderer, kernel: KernelClient, stone: Stone) {
  const { rev } = await kernel.strike(frame5Strikes(stone.grid.size))
  await stone.whenShown(rev)
  await studio.rendered(2)
  while (stone.airborne > 0) await studio.rendered(1)
}
