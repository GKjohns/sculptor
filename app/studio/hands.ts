/**
 * Hand-carving, the debug mode behind ?hands=1. Press or drag on the stone to strike along the view
 * ray with the chosen tool; with the saw, drag a line across the stone and the cut goes straight into
 * the screen along it. A drag that starts on empty space orbits as usual, and so does any drag with
 * Alt held.
 *
 * Two rays are involved on purpose. Whether a press landed on the stone has to be known inside the
 * pointerdown handler, before OrbitControls sees the event, so that is a pick against the chunk
 * meshes on this thread. Where a strike lands is asked of the worker: the kernel's own raycast reads
 * the grid, so it sees strikes the mesh has not caught up with yet, returns the exact surface point,
 * and is the same function the hand will aim with in Sprint 2.
 */
import * as THREE from 'three/webgpu'
import { hashSeed } from '#shared/sculpt/rng'
import type { Strike, Vec3 } from '#shared/sculpt/types'
import type { KernelClient } from './kernel'
import type { StudioRenderer } from './renderer'
import type { Stone } from './stone'

export type HandTool = 'saw' | 'point' | 'flat' | 'rasp'

export interface ScreenLine { x1: number, y1: number, x2: number, y2: number }

// One strike of each tool: diameter and depth in cm, and the virtual time it takes.
const BITE: Record<Exclude<HandTool, 'saw'>, { size: number, depth: number, ms: number }> = {
  point: { size: 3.2, depth: 1.6, ms: 220 },
  flat: { size: 5, depth: 0.7, ms: 200 },
  rasp: { size: 7, depth: 0.5, ms: 120 }
}
// Pointer travel between strikes while dragging, and the shortest drag the saw acts on, px.
const SPACING = 7
const MIN_SAW = 12

interface Gesture {
  pointer: number
  tool: HandTool
  startX: number
  startY: number
  lastX: number
  lastY: number
  /** View ray through the press point (the saw's first edge). */
  from: THREE.Vector3
  strikes: number
  /** A raycast is out; `next` is where to strike when it returns. */
  busy: boolean
  next: { x: number, y: number } | null
  ended: boolean
}

export class Hands {
  tool: HandTool = 'point'
  /** The saw line being dragged, in client pixels; null when there is none. */
  onSawLine: (line: ScreenLine | null) => void = () => {}
  /** Every batch of strikes as it is sent to the stone, for the film (chips, tools, sound). */
  onStrikes: (strikes: Strike[]) => void = () => {}

  private picker = new THREE.Raycaster()
  private ndc = new THREE.Vector2()
  private gesture: Gesture | null = null
  private count = 0
  private host: HTMLElement

  constructor(private studio: StudioRenderer, private stone: Stone, private kernel: KernelClient) {
    this.host = studio.renderer.domElement.parentElement!
    // Capture on the parent runs before OrbitControls' own listener on the canvas.
    this.host.addEventListener('pointerdown', this.down, { capture: true })
    window.addEventListener('pointermove', this.move)
    window.addEventListener('pointerup', this.up)
    window.addEventListener('pointercancel', this.up)
  }

  dispose() {
    this.host.removeEventListener('pointerdown', this.down, { capture: true })
    window.removeEventListener('pointermove', this.move)
    window.removeEventListener('pointerup', this.up)
    window.removeEventListener('pointercancel', this.up)
    this.studio.controls.enabled = true
    this.gesture = null
    this.onSawLine(null)
  }

  private aim(x: number, y: number) {
    const rect = this.studio.renderer.domElement.getBoundingClientRect()
    this.ndc.set((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2)
    this.picker.setFromCamera(this.ndc, this.studio.camera)
    return this.picker.ray
  }

  private down = (e: PointerEvent) => {
    if (this.gesture || e.button !== 0 || e.altKey) return
    const ray = this.aim(e.clientX, e.clientY)
    if (this.picker.intersectObjects(this.stone.chunks, false).length === 0) return
    this.studio.controls.enabled = false
    const g: Gesture = {
      pointer: e.pointerId,
      tool: this.tool,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      from: ray.direction.clone(),
      strikes: 0,
      busy: false,
      next: null,
      ended: false
    }
    this.gesture = g
    if (g.tool !== 'saw') void this.strikeAt(g, e.clientX, e.clientY)
  }

  private move = (e: PointerEvent) => {
    const g = this.gesture
    if (!g || e.pointerId !== g.pointer) return
    if (g.tool === 'saw') {
      this.onSawLine({ x1: g.startX, y1: g.startY, x2: e.clientX, y2: e.clientY })
      return
    }
    if (Math.hypot(e.clientX - g.lastX, e.clientY - g.lastY) < SPACING) return
    g.lastX = e.clientX
    g.lastY = e.clientY
    if (g.busy) g.next = { x: e.clientX, y: e.clientY }
    else void this.strikeAt(g, e.clientX, e.clientY)
  }

  private up = (e: PointerEvent) => {
    const g = this.gesture
    if (!g || e.pointerId !== g.pointer) return
    this.gesture = null
    this.studio.controls.enabled = true
    if (g.tool === 'saw') {
      this.onSawLine(null)
      if (e.type === 'pointerup' && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) >= MIN_SAW) this.saw(g, e.clientX, e.clientY)
      return
    }
    g.ended = true
    if (!g.busy) this.close(g)
  }

  private async strikeAt(g: Gesture, x: number, y: number) {
    g.busy = true
    const ray = this.aim(x, y)
    const dir = ray.direction.toArray() as Vec3
    try {
      const hit = await this.kernel.raycast(ray.origin.toArray() as Vec3, dir)
      if (hit) {
        const bite = BITE[g.tool as Exclude<HandTool, 'saw'>]
        g.strikes++
        this.send([{ kind: 'cut', tool: g.tool, at: hit.point, dir, seed: hashSeed(0x68616e64, this.count++), ...bite }])
      }
    } catch (e) {
      console.error('[hands]', e)
    }
    g.busy = false
    if (g.next) {
      const { x: nx, y: ny } = g.next
      g.next = null
      void this.strikeAt(g, nx, ny)
    } else if (g.ended) {
      this.close(g)
    }
  }

  // A drag is one pass, and the island check runs after each pass.
  private close(g: Gesture) {
    if (g.strikes > 0) this.send([{ kind: 'detach' }])
  }

  // The plane through the eye and both ends of the dragged line. What falls is the side away from
  // the middle of the block.
  private saw(g: Gesture, x: number, y: number) {
    const ray = this.aim(x, y)
    const normal = new THREE.Vector3().crossVectors(g.from, ray.direction)
    if (normal.lengthSq() < 1e-12) return
    normal.normalize()
    const middle = new THREE.Vector3(0, this.stone.grid.size[1] / 2, 0)
    if (normal.dot(middle.sub(ray.origin)) > 0) normal.negate()
    this.send([
      { kind: 'saw', plane: { point: ray.origin.toArray() as Vec3, normal: normal.toArray() as Vec3 }, ms: 1500 },
      { kind: 'detach' }
    ])
  }

  private send(strikes: Strike[]) {
    this.onStrikes(strikes)
    this.kernel.strike(strikes).catch(e => console.error('[hands]', e))
  }
}
