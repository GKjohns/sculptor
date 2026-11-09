/**
 * The reveal: what happens once a finished piece has been watched to its end. The director takes
 * the camera slowly round it (director.ts, the `reveal` shot) and the HUD puts up the title plaque;
 * this does the rest, on the film's clock, so an export gets it frame for frame:
 *
 *   0.0 s  the floor is swept (debris.sweep): chips pushed off into the dark, pieces gone, dust lifted
 *   1.0 s  a light sweeps once across the piece, from the window side round to the other
 *   2.2 s  the sculptor's signature comes up on the front of the base, cut into the stone
 *
 * A finished piece arrived at without being watched (skipped to, a saved session put back) gets
 * the signature at once and nothing else.
 *
 * Everything here exists from the start, the light dark and the signature clear, so its shaders
 * are built with the rest before the scene reports ready (see StudioRenderer.prewarm).
 */
import * as THREE from 'three/webgpu'
import { texture, uniform } from 'three/tsl'
import type { Debris } from './debris'
import type { KernelClient } from './kernel'
import type { StudioRenderer } from './renderer'

const SWEEP_S = 2.4
const LIGHT_AT_S = 1
const LIGHT_S = 4.2
const SIGN_AT_S = 2.2
const SIGN_S = 1.6
// The light that sweeps: how far out and how high it travels, and how bright it gets at its peak.
const LIGHT_REACH = 190
const LIGHT_Y = 120
const LIGHT_PEAK = 2.6
// The signature: its size on the stone, cm, and how far up the base it is cut.
const SIGN_W = 18
const SIGN_H = 4.5
const SIGN_Y = [5, 9, 3.5]
// Columns the strip is cast onto the stone in, and how far proud of the surface it sits, cm.
const SIGN_COLUMNS = 16
const SIGN_PROUD = 0.18
// Cut into pale stone it reads dark; into black stone, pale.
const INK_ON_PALE = 0x2c2722
const INK_ON_DARK = 0xd9d1c3

const ROMAN: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]

/** A year as a mason would cut it. */
export function roman(year: number) {
  let out = ''
  for (const [n, s] of ROMAN) {
    while (year >= n) {
      out += s
      year -= n
    }
  }
  return out
}

export class Reveal {
  private clock = -1
  private light: THREE.SpotLight
  private sign: THREE.Mesh
  private canvas: HTMLCanvasElement
  private map: THREE.CanvasTexture
  private fade = uniform(0)
  private ink = uniform(new THREE.Color(INK_ON_PALE))
  private placed: Promise<boolean> | null = null
  private text = ''
  private shown = 0

  constructor(studio: StudioRenderer, private debris: Debris, private kernel: KernelClient) {
    // No shadow: the key already casts the one that matters, and a second map would cost every frame.
    this.light = new THREE.SpotLight(0xfff1dd, 0, 0, 0.42, 0.85, 0)
    this.light.name = 'reveal-sweep'
    this.light.target.position.set(0, 46, 0)
    studio.scene.add(this.light, this.light.target)

    this.canvas = document.createElement('canvas')
    this.canvas.width = 1024
    this.canvas.height = 256
    // A context from the start: an untouched canvas cannot be uploaded as a texture.
    this.canvas.getContext('2d')!.clearRect(0, 0, 1024, 256)
    this.map = new THREE.CanvasTexture(this.canvas)
    this.map.colorSpace = THREE.NoColorSpace
    this.map.anisotropy = 4
    const material = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, roughness: 0.95, metalness: 0 })
    material.name = 'signature'
    material.colorNode = this.ink
    material.opacityNode = texture(this.map).a.mul(this.fade)
    material.polygonOffset = true
    material.polygonOffsetFactor = -2
    material.polygonOffsetUnits = -2
    // A strip of columns, bent onto the base when it is placed (see place()).
    this.sign = new THREE.Mesh(new THREE.PlaneGeometry(SIGN_W, SIGN_H, SIGN_COLUMNS, 1), material)
    this.sign.name = 'signature'
    // Below the floor until there is a base to cut it into; drawn from the start, faded out.
    this.sign.position.set(0, -400, 0)
    this.sign.frustumCulled = false
    studio.stage.add(this.sign)
  }

  /** What the signature says: the sculptor and the year. */
  credit(by: string, when: Date = new Date()) {
    const text = `${by} · ${roman(when.getFullYear())}`
    if (text === this.text) return
    this.text = text
    const g = this.canvas.getContext('2d')!
    g.clearRect(0, 0, this.canvas.width, this.canvas.height)
    g.fillStyle = '#fff'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    let size = 132
    do {
      g.font = `italic 600 ${size}px "Cormorant Garamond", "Iowan Old Style", Georgia, serif`
      size -= 6
    } while (g.measureText(text).width > this.canvas.width * 0.94 && size > 40)
    g.fillText(text, this.canvas.width / 2, this.canvas.height / 2)
    this.map.needsUpdate = true
  }

  /** Light stone or dark: which way the signature reads. */
  setDark(dark: boolean) {
    this.ink.value.set(dark ? INK_ON_DARK : INK_ON_PALE)
  }

  /** Whether the sequence is running or has run. */
  get active() {
    return this.clock >= 0
  }

  /** The finished piece has been watched to its end: sweep, light, signature. */
  begin() {
    this.clock = 0
    this.shown = 0
    this.fade.value = 0
    this.placed = this.place()
    this.debris.sweep(SWEEP_S)
  }

  /** The finished piece is on the stone without having been watched: the signature at once. */
  show() {
    if (this.active || this.placed) return
    this.placed = this.place()
    void this.placed.then((ok) => {
      if (ok && !this.active) this.fade.value = this.shown = 1
    })
  }

  /** Back to work, or a fresh block: no signature, no light. */
  end() {
    this.clock = -1
    this.shown = 0
    this.fade.value = 0
    this.light.intensity = 0
    this.placed = null
  }

  /** Resolves once the signature knows where it goes (a raycast to the base): an export waits on it. */
  async pending() {
    await this.placed
  }

  /** `dt` is film time. */
  update(dt: number) {
    if (this.clock < 0 || dt <= 0) return
    this.clock += dt
    const t = this.clock
    // The light: round from the window side (-x) to the far side, rising and falling once.
    const k = (t - LIGHT_AT_S) / LIGHT_S
    if (k > 0 && k < 1) {
      const a = -1.5 + k * 3
      this.light.position.set(Math.sin(a) * LIGHT_REACH, LIGHT_Y + Math.sin(k * Math.PI) * 20, Math.cos(a) * LIGHT_REACH)
      this.light.intensity = LIGHT_PEAK * Math.sin(k * Math.PI) ** 2
    } else {
      this.light.intensity = 0
    }
    const s = Math.min(1, Math.max(0, (t - SIGN_AT_S) / SIGN_S))
    this.shown = s * s * (3 - 2 * s)
    this.fade.value = this.shown
  }

  dispose() {
    this.light.removeFromParent()
    this.light.target.removeFromParent()
    this.light.dispose()
    this.sign.removeFromParent()
    this.sign.geometry.dispose()
    ;(this.sign.material as THREE.Material).dispose()
    this.map.dispose()
  }

  // Finds the front of the base and lays the signature on it, following the stone's own surface:
  // every column of the strip is cast onto the stone from the front and sits just proud of where
  // it lands, so the letters wrap a curved base instead of floating off it or sinking into it.
  private async place(): Promise<boolean> {
    try {
      for (const y of SIGN_Y) {
        const centre = await this.kernel.raycast([0, y, 200], [0, 0, -1], 'shown')
        if (!centre) continue
        const [nx, , nz] = centre.normal
        const level = Math.hypot(nx, nz)
        // Facing the front well enough to read: anything turned more than about 50 degrees is not a face for it.
        if (level < 0.5 || nz / level < 0.64) continue
        const position = this.sign.geometry.getAttribute('position') as THREE.BufferAttribute
        const rows = [y + SIGN_H / 2, y - SIGN_H / 2]
        const z: number[][] = [[], []]
        for (let r = 0; r < 2; r++) {
          for (let i = 0; i <= SIGN_COLUMNS; i++) {
            const x = (i / SIGN_COLUMNS - 0.5) * SIGN_W
            const hit = await this.kernel.raycast([x, rows[r]!, 200], [0, 0, -1], 'shown')
            z[r]!.push(hit ? hit.point[2] : Number.NaN)
          }
        }
        // A column that missed (past the edge of the base) takes its neighbour's depth, less a little.
        for (const line of z) {
          for (let i = 1; i < line.length; i++) if (Number.isNaN(line[i]!)) line[i] = line[i - 1]! - 0.5
          for (let i = line.length - 2; i >= 0; i--) if (Number.isNaN(line[i]!)) line[i] = line[i + 1]! - 0.5
          if (line.some(Number.isNaN)) return this.unplace()
        }
        for (let r = 0; r < 2; r++) {
          for (let i = 0; i <= SIGN_COLUMNS; i++) position.setXYZ(r * (SIGN_COLUMNS + 1) + i, (i / SIGN_COLUMNS - 0.5) * SIGN_W, rows[r]!, z[r]![i]! + SIGN_PROUD)
        }
        position.needsUpdate = true
        this.sign.geometry.computeBoundingSphere()
        this.sign.position.set(0, 0, 0)
        return true
      }
    } catch {
      // the worker had no stone to cast onto (the page is going)
    }
    return this.unplace()
  }

  private unplace() {
    this.sign.position.set(0, -400, 0)
    return false
  }
}
