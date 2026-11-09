/**
 * The three.js side of the studio: one WebGPURenderer, one scene, one RenderPipeline.
 * It owns no stone data. Whatever stands on the banker is added to `stage`; per-frame work registers
 * with `onFrame`. The scene is in block centimetres (origin at the centre of the block's base, +Y up).
 *
 * Import rule for everything under app/studio/: three from 'three/webgpu', TSL from 'three/tsl'.
 * ShaderMaterial, onBeforeCompile and EffectComposer do not work on this path.
 */
import * as THREE from 'three/webgpu'
import { pass } from 'three/tsl'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

export interface StudioOptions {
  /** Skip WebGPU and run the WebGL 2 backend (`?gl=1`). Without it three still falls back on its own. */
  forceWebGL?: boolean
}

export interface StudioStats {
  backend: 'webgpu' | 'webgl2'
  /** Frames rendered through the pipeline since init. */
  frames: number
  /** Smoothed frame time. */
  frameMs: number
  width: number
  height: number
  drawCalls: number
  triangles: number
}

export type FrameFn = (dt: number, now: number) => void

const BACKDROP = 0x0b0a09
// The default block is 60 x 100 x 60 cm standing on the origin; the camera orbits its middle.
const TARGET = new THREE.Vector3(0, 50, 0)
const CAMERA_HOME = new THREE.Vector3(128, 96, 204)

export class StudioRenderer {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(35, 1, 1, 5000)
  /** Everything on the banker goes here: the stone's chunk meshes, offcuts, debug gizmos. */
  readonly stage = new THREE.Group()
  readonly key = new THREE.DirectionalLight(0xfff1dc, 4.2)
  readonly renderer: THREE.WebGPURenderer
  readonly controls: OrbitControls

  private pipeline: THREE.RenderPipeline | null = null
  private resizer: ResizeObserver
  private frameFns = new Set<FrameFn>()
  private waiters: { at: number, done: () => void }[] = []
  private frames = 0
  private frameMs = 0
  private last = 0
  private disposed = false

  constructor(private host: HTMLElement, options: StudioOptions = {}) {
    this.renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: options.forceWebGL === true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.domElement.classList.add('block', 'size-full')
    host.appendChild(this.renderer.domElement)

    this.scene.background = new THREE.Color(BACKDROP)
    this.scene.add(this.stage)

    // One warm key from the upper left and a dim cool fill. The atelier and its window are Sprint 4.
    this.key.position.set(-140, 220, 160)
    this.key.target.position.copy(TARGET)
    // The key casts shadows, which is most of what makes tool marks read. The shadow camera is a
    // box around the default block with room for a piece falling away.
    this.renderer.shadowMap.enabled = true
    this.key.castShadow = true
    this.key.shadow.mapSize.set(2048, 2048)
    this.key.shadow.camera.left = this.key.shadow.camera.bottom = -90
    this.key.shadow.camera.right = this.key.shadow.camera.top = 90
    this.key.shadow.camera.near = 100
    this.key.shadow.camera.far = 600
    this.key.shadow.bias = -0.0004
    this.key.shadow.normalBias = 0.25
    this.scene.add(this.key, this.key.target, new THREE.HemisphereLight(0x8fa3c4, 0x1c1814, 0.55))

    this.camera.position.copy(CAMERA_HOME)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.copy(TARGET)
    this.controls.enableDamping = true
    this.controls.minDistance = 40
    this.controls.maxDistance = 600
    this.controls.update()

    this.resizer = new ResizeObserver(() => this.resize())
    this.resizer.observe(host)
    this.resize()
  }

  /** Picks the backend (async on WebGPU), builds the pipeline and starts the frame loop. */
  async init() {
    await this.renderer.init()
    if (this.disposed) return
    // One node for now. Sprint 4 chains ao, dof, bloom and the rest onto this pass in post.ts.
    this.pipeline = new THREE.RenderPipeline(this.renderer, pass(this.scene, this.camera))
    this.renderer.setAnimationLoop(now => this.frame(now))
  }

  get backend(): StudioStats['backend'] {
    return (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2'
  }

  /** Run `fn` every frame before the render. Returns the unsubscribe. */
  onFrame(fn: FrameFn) {
    this.frameFns.add(fn)
    return () => this.frameFns.delete(fn)
  }

  /** Resolves once `count` more frames have gone through the pipeline. */
  rendered(count = 1) {
    return new Promise<void>(done => this.waiters.push({ at: this.frames + count, done }))
  }

  stats(): StudioStats {
    const size = this.renderer.getSize(new THREE.Vector2())
    const { drawCalls, triangles } = this.renderer.info.render
    return { backend: this.backend, frames: this.frames, frameMs: this.frameMs, width: size.x, height: size.y, drawCalls, triangles }
  }

  dispose() {
    this.disposed = true
    this.renderer.setAnimationLoop(null)
    this.resizer.disconnect()
    this.controls.dispose()
    this.frameFns.clear()
    this.pipeline?.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private frame(now: number) {
    if (!this.pipeline) return
    const ms = this.last ? now - this.last : 16.7
    this.last = now
    this.frameMs = this.frameMs ? this.frameMs * 0.9 + ms * 0.1 : ms
    // Clamped so a backgrounded tab doesn't come back with one huge step.
    const dt = Math.min(ms, 100) / 1000
    for (const fn of this.frameFns) fn(dt, now)
    this.controls.update()
    this.pipeline.render()
    this.frames++
    if (this.waiters.length) {
      this.waiters = this.waiters.filter((w) => {
        if (w.at > this.frames) return true
        w.done()
        return false
      })
    }
  }

  private resize() {
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }
}
