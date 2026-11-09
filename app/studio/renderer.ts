/**
 * The three.js side of the studio: one WebGPURenderer, one scene, one RenderPipeline.
 * It owns no stone data. Whatever stands on the banker is added to `stage`; per-frame work registers
 * with `onFrame`. The scene is in block centimetres (origin at the centre of the block's base, +Y up).
 * The room and its lights are `atelier` (atelier.ts); the post stack is `post` (post.ts).
 *
 * Import rule for everything under app/studio/: three from 'three/webgpu', TSL from 'three/tsl'.
 * ShaderMaterial, onBeforeCompile and EffectComposer do not work on this path.
 */
import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Atelier } from './atelier'
import { bakeStone, disposeStone, marbleDials } from './materials/marble'
import { Post } from './post'
import type { PostEffects } from './post'

export interface StudioOptions {
  /** Skip WebGPU and run the WebGL 2 backend (`?gl=1`). Without it three still falls back on its own. */
  forceWebGL?: boolean
  /** Post effects to turn off or on over the tier's own set (`?fx=`), for measuring what each costs. */
  effects?: Partial<PostEffects>
  /** Cap on the device pixel ratio the canvas is drawn at. Left out: 1.5 with the full post stack, 2 without. */
  maxPixelRatio?: number
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

// What the room falls away to, and the colour of the air between here and there.
const BACKDROP = 0x0b0a09
const HAZE_PER_CM = 0.00055
// The most device pixels per CSS pixel each tier draws, unless the page says otherwise.
const FILM_PIXEL_RATIO = 1.5
const PLAIN_PIXEL_RATIO = 2
// The default block is 60 x 100 x 60 cm standing on the origin; the camera orbits its middle.
const TARGET = new THREE.Vector3(0, 50, 0)
const CAMERA_HOME = new THREE.Vector3(128, 96, 204)
// CAMERA_HOME frames the block's height. In a pane narrower than that leaves room for, the width is
// what has to fit: half the block's plan diagonal, the widest it gets from any orbit angle, with a
// tenth to spare. Its nearest corner can stand half the block's height in front of the target.
const HOME_DISTANCE = CAMERA_HOME.distanceTo(TARGET)
const BLOCK_REACH = Math.hypot(30, 30) * 1.1
const BLOCK_NEAR = 50
// Backing off for width leaves height to spare. This share of it goes under the stone, where the
// HUD's subtitle and transport sit, by sliding the picture up.
const SPARE_BELOW = 0.8

// A perspective camera whose picture can be slid up the frame (a lens shift). The view offset
// would do it, but TRAA sets and clears the view offset every frame for its jitter.
class ShiftCamera extends THREE.PerspectiveCamera {
  /** How far up the frame the picture is slid, as a share of the frame's height. */
  shiftY = 0

  override updateProjectionMatrix() {
    super.updateProjectionMatrix()
    if (this.shiftY === 0) return
    this.projectionMatrix.elements[9]! -= this.shiftY * 2
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert()
  }
}

// Whether the WebGL context is drawn by the CPU (SwiftShader or llvmpipe).
function softwareGL(renderer: THREE.WebGPURenderer) {
  const gl = (renderer.backend as { gl?: WebGL2RenderingContext }).gl
  if (!gl) return false
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
  return /swiftshader|llvmpipe|software/i.test(name)
}

export class StudioRenderer {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera = new ShiftCamera(35, 1, 4, 6000)
  /** Everything on the banker goes here: the stone's chunk meshes, offcuts, debug gizmos. */
  readonly stage = new THREE.Group()
  /** The room: banker, floor, walls, window, and the light rig. */
  readonly atelier: Atelier
  /** The key light (the sun through the window). Same object as `atelier.key`. */
  readonly key: THREE.DirectionalLight
  readonly renderer: THREE.WebGPURenderer
  readonly controls: OrbitControls
  /** The stone's dials (translucency, veins), for tuning from the console. */
  readonly marble = marbleDials
  /** The post stack; null until init() has picked a backend. */
  post: Post | null = null

  private effects: Partial<PostEffects>
  private lean = false
  private maxPixelRatio: number
  private resizer: ResizeObserver
  private frameFns = new Set<FrameFn>()
  private waiters: { at: number, done: () => void }[] = []
  private fitDistance = HOME_DISTANCE
  private frames = 0
  private frameMs = 0
  private last = 0
  private disposed = false
  // A film export has the frame loop: frames are drawn by step(), at a fixed size.
  private held = false
  private heldNow = 0
  private leave = () => {}
  /** Resolves when the studio is disposed (the page left, or a hot reload replaced the scene): for whatever is awaiting frames that will now never come. */
  readonly gone = new Promise<void>(done => this.leave = done)
  private focus: { point: THREE.Vector3, aperture: number } | null = null

  constructor(private host: HTMLElement, options: StudioOptions = {}) {
    this.effects = options.effects ?? {}
    // No MSAA on the canvas: the film tier anti-aliases with TRAA, which wants unresolved samples,
    // and the plain tier asks for it on its own pass (post.ts).
    this.renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: options.forceWebGL === true })
    this.maxPixelRatio = options.maxPixelRatio ?? 0
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.maxPixelRatio || PLAIN_PIXEL_RATIO))
    this.renderer.domElement.classList.add('block', 'size-full')
    host.appendChild(this.renderer.domElement)

    this.scene.background = new THREE.Color(BACKDROP)
    this.scene.fog = new THREE.FogExp2(BACKDROP, HAZE_PER_CM)
    this.scene.add(this.stage)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.atelier = new Atelier(this.scene)
    this.key = this.atelier.key

    this.camera.position.copy(CAMERA_HOME)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.copy(TARGET)
    this.controls.enableDamping = true
    this.controls.minDistance = 40
    this.controls.update()

    this.resizer = new ResizeObserver(() => this.resize())
    this.resizer.observe(host)
    this.resize()
  }

  /** Picks the backend (async on WebGPU), builds the pipeline and starts the frame loop. */
  async init() {
    await this.renderer.init()
    if (this.disposed) return
    // Headless Chrome's software WebGL (the shoot script's --gl mode) is for layout and logic.
    // It loses its context under the full-size shadow map, environment and vein bake.
    this.lean = this.backend === 'webgl2' && softwareGL(this.renderer)
    this.atelier.bake(this.renderer, this.lean)
    // The whole stack on WebGPU; on the WebGL 2 fallback, the scene with tone mapping and grain.
    this.post = new Post(this.renderer, this.scene, this.camera, this.key, this.backend === 'webgpu' ? 'film' : 'plain', this.effects, this.lean)
    if (this.focus) this.post.setFocus(this.focus.point, this.focus.aperture)
    this.atelier.temporal.value = this.post.effects.traa ? 1 : 0
    // The full stack at the display's own 2x costs 25 ms a frame on an M4 Pro at 1440 x 900; at 1.5x, 10.
    if (this.post.tier === 'film' && !this.maxPixelRatio) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, FILM_PIXEL_RATIO))
      this.resize()
    }
    this.renderer.setAnimationLoop(now => this.frame(now))
  }

  /**
   * Depth of field: keep `point` (world cm) sharp with an aperture from 0 (everything sharp) to 1
   * (a macro lens wide open). null goes back to deep focus. Eased, so call it as often as you like.
   */
  setFocus(point: THREE.Vector3 | null, aperture = 0.5) {
    this.focus = point ? { point: point.clone(), aperture } : null
    this.post?.setFocus(point, aperture)
  }

  /** How far from its target the camera frames the whole block in the pane as it is now. */
  get homeDistance() {
    return this.fitDistance
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

  /**
   * Draws a couple of frames with nothing culled, so every material in the room has its pipelines
   * in every pass before anyone is watching. Left to the first time it comes into view (the
   * quarried blocks at the back, when the director first swings round for a slab fall), a lit
   * material costs a 100 ms frame: its own shader, and the AO and contact-shadow passes it reads
   * are set up again with it. Call it once everything is on the stage, before the scene reports ready.
   */
  async prewarm() {
    const culled: THREE.Object3D[] = []
    this.scene.traverse((object) => {
      if (!object.frustumCulled) return
      object.frustumCulled = false
      culled.push(object)
    })
    await this.rendered(2)
    for (const object of culled) object.frustumCulled = true
  }

  /**
   * For a film export: stops the frame loop and draws at `width` x `height` pixels, one frame per
   * step(dt), until the returned function is called. Nothing in the studio reads the wall clock,
   * so a step is a frame of film whatever it takes to draw.
   */
  hold(width: number, height: number) {
    if (this.held) throw new Error('the studio is already held')
    this.held = true
    this.renderer.setAnimationLoop(null)
    const ratio = this.renderer.getPixelRatio()
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.fit(width, height)
    return () => {
      if (!this.held || this.disposed) return
      this.held = false
      this.renderer.setPixelRatio(ratio)
      this.resize()
      this.last = 0
      this.renderer.setAnimationLoop(now => this.frame(now))
    }
  }

  /** Draws one frame `dt` seconds after the last, while held. */
  step(dt: number) {
    if (!this.held || !this.post) return
    this.heldNow += dt * 1000
    this.draw(dt, this.heldNow)
  }

  /** The canvas the frames are drawn on. */
  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement
  }

  stats(): StudioStats {
    const size = this.renderer.getSize(new THREE.Vector2())
    const { drawCalls, triangles } = this.renderer.info.render
    return { backend: this.backend, frames: this.frames, frameMs: this.frameMs, width: size.x, height: size.y, drawCalls, triangles }
  }

  dispose() {
    this.disposed = true
    this.leave()
    this.renderer.setAnimationLoop(null)
    this.resizer.disconnect()
    this.controls.dispose()
    this.frameFns.clear()
    this.post?.dispose()
    this.atelier.dispose()
    disposeStone()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private frame(now: number) {
    if (!this.post) return
    const ms = this.last ? now - this.last : 16.7
    this.last = now
    this.frameMs = this.frameMs ? this.frameMs * 0.9 + ms * 0.1 : ms
    // Clamped so a backgrounded tab doesn't come back with one huge step.
    this.draw(Math.min(ms, 100) / 1000, now)
  }

  private draw(dt: number, now: number) {
    if (!this.post) return
    for (const fn of this.frameFns) fn(dt, now)
    this.controls.update()
    // The veins of any stone preset that has turned up since the last frame.
    bakeStone(this.renderer, this.lean)
    this.post.update(dt)
    this.post.render()
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
    if (this.held) return
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.fit(w, h)
  }

  // Keeps the whole block in frame at any aspect ratio. The camera moves along its own line of
  // sight by the ratio between the old fit and the new, so the orbit angle and whatever zoom the
  // viewer has dialled in carry over a resize.
  private fit(w: number, h: number) {
    const halfWidth = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect
    const fit = Math.max(HOME_DISTANCE, BLOCK_REACH / halfWidth + BLOCK_NEAR)
    const { target } = this.controls
    this.camera.position.sub(target).multiplyScalar(fit / this.fitDistance).add(target)
    this.controls.maxDistance = fit * 2.5
    this.fitDistance = fit
    // The stone is 1 - HOME_DISTANCE / fit shorter on screen than the home framing would have it.
    const lift = (1 - HOME_DISTANCE / fit) * (h / 2) * (SPARE_BELOW - 0.5) * 2
    ;(this.camera as ShiftCamera).shiftY = Math.round(lift) / h
    // Also updates the projection for the new aspect.
    this.camera.updateProjectionMatrix()
  }
}
