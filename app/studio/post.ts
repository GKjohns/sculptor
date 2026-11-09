/**
 * The post stack: one RenderPipeline. In order, on the film tier (WebGPU):
 *
 *   pre-pass      depth and normals of everything opaque, in one flat material
 *   ao            GTAO at half resolution from the pre-pass; it dims indirect light only
 *   contact       screen-space shadows toward the key, multiplied into the key's shadow (off by default)
 *   scene pass    the beauty render, lit with both of those through its context
 *   god rays      the window's shaft, marched through the key's shadow map at half resolution
 *   traa          temporal anti-aliasing (it also resolves the dithered soft shadows and the AO)
 *   dof           depth of field about a settable point
 *   bloom         only what is brighter than paper white
 *   AgX           tone mapping, then vignette and grain in display space
 *
 * The plain tier (the WebGL 2 fallback, and software WebGL in the shoot script's --gl mode) is the
 * scene pass with AgX, vignette and grain: no screen-space effect is asked of it.
 *
 * Transparent things (dust, sparks, anything with depthWrite off) are left out of the pre-pass by
 * the pass itself, so they neither occlude nor take contact shadows; they are drawn in the scene
 * pass and go through TRAA, depth of field and bloom with the depth of what is behind them.
 */
import * as THREE from 'three/webgpu'
import { unpackRGBToNormal, context, packNormalToRGB, float, mix, mrt, normalView, output, pass, rand, renderOutput, sample, screenUV, smoothstep, time, uniform, uv, vec3, vec4, velocity } from 'three/tsl'
import { bilateralBlur } from 'three/addons/tsl/display/BilateralBlurNode.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { godrays } from 'three/addons/tsl/display/GodraysNode.js'
import { sss } from 'three/addons/tsl/display/SSSNode.js'
import { traa } from 'three/addons/tsl/display/TRAANode.js'

export type PostTier = 'film' | 'plain'

export interface PostEffects {
  ao: boolean
  contact: boolean
  godrays: boolean
  traa: boolean
  dof: boolean
  bloom: boolean
  grain: boolean
  vignette: boolean
}

// Contact shadows are built but off: against 0.4 cm voxels at half resolution they drew blotches
// and hatching on smooth stone and a hard edge over the key's penumbra. `?fx=contact` for a look.
const FILM: PostEffects = { ao: true, contact: false, godrays: true, traa: true, dof: true, bloom: true, grain: true, vignette: true }
const PLAIN: PostEffects = { ao: false, contact: false, godrays: false, traa: false, dof: false, bloom: false, grain: true, vignette: true }

type Float = THREE.Node<'float'>
type Vec3 = THREE.Node<'vec3'>
type Vec4 = THREE.Node<'vec4'>

// How quickly focus is pulled to a new point, seconds.
const FOCUS_EASE_S = 0.35

export class Post {
  readonly pipeline: THREE.RenderPipeline
  readonly effects: PostEffects
  /** Dials the look book turns. */
  readonly dials = {
    exposure: uniform(1),
    grain: uniform(0.055),
    vignette: uniform(0.42),
    bloom: uniform(0.1),
    /** Colour and strength of the haze in the shaft. */
    haze: uniform(new THREE.Color(0xffe9cf)),
    hazeStrength: uniform(0.55)
  }

  // Depth of field: distance to the plane in focus, the depth either side of it that stays
  // acceptably sharp, and the size of the blur, all eased toward what setFocus() asked for.
  private focusDistance = uniform(250)
  private focusRange = uniform(600)
  private bokeh = uniform(0)
  private focusPoint: THREE.Vector3 | null = null
  private aperture = 0
  private forward = new THREE.Vector3()
  private toFocus = new THREE.Vector3()
  private nodes: { dispose?: () => void }[] = []
  private view: 'final' | 'ao' | 'contact' | 'normal' = 'final'
  /** The nodes with dials of their own, for tuning from the console; null when their effect is off. */
  readonly parts: { ao: ReturnType<typeof ao> | null, contact: ReturnType<typeof sss> | null, godrays: ReturnType<typeof godrays> | null } = { ao: null, contact: null, godrays: null }

  constructor(
    private renderer: THREE.WebGPURenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private key: THREE.DirectionalLight,
    readonly tier: PostTier,
    effects: Partial<PostEffects> = {},
    /** A software renderer: no multisampling either. */
    private lean = false
  ) {
    this.effects = { ...(tier === 'film' ? FILM : PLAIN), ...effects }
    this.pipeline = new THREE.RenderPipeline(renderer)
    // Tone mapping is placed by hand, so grain and vignette can come after it.
    this.pipeline.outputColorTransform = false
    renderer.toneMapping = THREE.AgXToneMapping
    this.build()
  }

  /**
   * Focus on a world point with an aperture from 0 (everything sharp: the wide shots) to 1 (a
   * macro lens wide open: a few centimetres sharp). null lets go: deep focus.
   */
  setFocus(point: THREE.Vector3 | null, aperture = 0.5) {
    this.focusPoint = point ? (this.focusPoint ?? new THREE.Vector3()).copy(point) : null
    this.aperture = point ? Math.max(0, Math.min(1, aperture)) : 0
  }

  /** Shows one of the stack's intermediate images in place of the picture ('ao', 'contact', 'normal'), or the picture again ('final'). */
  inspect(view: 'final' | 'ao' | 'contact' | 'normal') {
    this.view = view
    this.build()
  }

  /** Turns effects on or off and rebuilds the graph. For measuring what each one costs. */
  configure(effects: Partial<PostEffects>) {
    Object.assign(this.effects, effects)
    this.build()
  }

  /** Call once a frame before render(): eases the focus. */
  update(dt: number) {
    const k = 1 - Math.exp(-dt / FOCUS_EASE_S)
    let distance = this.focusDistance.value
    if (this.focusPoint) {
      this.camera.getWorldDirection(this.forward)
      distance = Math.max(8, this.toFocus.copy(this.focusPoint).sub(this.camera.position).dot(this.forward))
    }
    const a = this.aperture
    // Wide open, a tenth of the focus distance stays sharp; stopped down, several times it.
    const range = distance * (a > 0 ? 0.1 + 3.5 * (1 - a) * (1 - a) : 6)
    this.focusDistance.value += (distance - this.focusDistance.value) * k
    this.focusRange.value += (range - this.focusRange.value) * k
    this.bokeh.value += (a * 3.2 - this.bokeh.value) * k
  }

  render() {
    this.renderer.toneMappingExposure = this.dials.exposure.value
    this.pipeline.render()
  }

  dispose() {
    for (const node of this.nodes) node.dispose?.()
    this.nodes = []
    this.pipeline.dispose()
  }

  private build() {
    for (const node of this.nodes) node.dispose?.()
    this.nodes = []
    const { scene, camera, key, effects, dials } = this
    const keep = <T extends { dispose?: () => void }>(node: T) => {
      this.nodes.push(node)
      return node
    }

    // TRAA wants unresolved samples; without it the pass is multisampled.
    this.parts.ao = this.parts.contact = this.parts.godrays = null
    const scenePass = keep(pass(scene, camera, { samples: effects.traa || this.lean ? 0 : 4 }))
    const lit: Record<string, unknown> = {}
    const inspected: Record<string, Vec4> = {}

    if (effects.ao || effects.contact) {
      // Every surface in the pre-pass wears one material that writes its view normal and nothing
      // else. Left to their own, materials run their whole lighting in this pass too (the MRT only
      // picks what is kept), which on a screen full of marble cost more than the beauty pass.
      const plain = keep(new THREE.NodeMaterial())
      plain.fragmentNode = vec4(packNormalToRGB(normalView), 1)
      const pre = keep(pass(scene, camera))
      pre.transparent = false
      pre.overrideMaterial = plain
      const preDepth = pre.getTextureNode('depth')
      const preNormal = sample(at => unpackRGBToNormal(pre.getTextureNode('output').sample(at)))
      if (effects.ao) {
        const occlusion = this.parts.ao = keep(ao(preDepth, preNormal, camera))
        occlusion.resolutionScale = 0.5
        // Centimetres, both: how far round a point occluders are looked for, and how far behind the
        // surface in front a sample may lie and still count (three's defaults are for metres).
        occlusion.radius.value = 10
        occlusion.thickness.value = 12
        occlusion.scale.value = 1.25
        occlusion.samples.value = 12
        occlusion.useTemporalFiltering = effects.traa
        const amount = occlusion.getTextureNode().sample(screenUV).r
        inspected.ao = vec4(vec3(occlusion.getTextureNode().sample(uv()).r), 1)
        inspected.normal = vec4(pre.getTextureNode('output').sample(uv()).rgb, 1)
        lit.getAO = (input: Float | null, { material }: { material: THREE.Material }) => {
          if (material.transparent === true) return input
          return input !== null ? input.mul(amount) : amount
        }
      }
      if (effects.contact) {
        const contact = this.parts.contact = keep(sss(preDepth, camera, key))
        // Centimetres. Only what touches: tool marks and creases. Longer, and its hard edge takes over the key's soft one.
        contact.maxDistance.value = 1.4
        contact.thickness.value = 0.5
        contact.shadowIntensity.value = 0.7
        contact.quality.value = 0.45
        // It is the dearest effect in the stack at full size, and at half it still finds the tool marks.
        contact.resolutionScale = 0.5
        contact.useTemporalFiltering = effects.traa
        const shade = contact.getTextureNode().sample(screenUV).r
        inspected.contact = vec4(vec3(contact.getTextureNode().sample(uv()).r), 1)
        lit.getShadow = ({ light, shadowColorNode }: { light: THREE.Light, shadowColorNode: Vec3 }) => light === key ? shadowColorNode.mul(shade) : shadowColorNode
      }
      scenePass.contextNode = context(lit)
    }

    if (effects.traa) scenePass.setMRT(mrt({ output, velocity }))
    let image: Vec4 = scenePass.getTextureNode('output')
    const depth = scenePass.getTextureNode('depth')

    if (effects.godrays) {
      const rays = this.parts.godrays = keep(godrays(depth, camera, key))
      rays.resolutionScale = 0.5
      rays.raymarchSteps.value = 36
      // Per centimetre of lit air; three's default is per metre-sized unit.
      rays.density.value = 0.008
      rays.maxDensity.value = 0.5
      rays.distanceAttenuation.value = 0.4
      const soft = keep(bilateralBlur(rays.getTextureNode(), float(1.5), 4, 0.2))
      const shaft = soft.getTextureNode().sample(screenUV).r.mul(dials.hazeStrength)
      // In-scattered light: added, so the shaft glows without greying what is behind it.
      image = vec4(image.rgb.add((dials.haze as unknown as Vec3).mul(shaft)), image.a)
    }

    if (effects.traa) {
      const resolved = keep(traa(image, depth, scenePass.getTextureNode('velocity'), camera))
      image = (resolved as unknown as { getTextureNode: () => Vec4 }).getTextureNode()
    }

    if (effects.dof) {
      // The node itself, not its texture: only building the node sets its passes up.
      image = keep(dof(image, scenePass.getViewZNode(), this.focusDistance, this.focusRange, this.bokeh)) as unknown as Vec4
    }

    if (effects.bloom) {
      const glow = keep(bloom(image, dials.bloom as unknown as number, 0.4, 1.25))
      image = image.add(glow as unknown as Vec4)
    }

    let display: Vec4 = renderOutput(image, THREE.AgXToneMapping, THREE.SRGBColorSpace)
    if (effects.vignette) {
      const d = uv().sub(0.5).mul(vec3(1.15, 1, 1).xy).length()
      display = vec4(display.rgb.mul(mix(float(1), smoothstep(0.3, 0.95, d).oneMinus(), dials.vignette)), display.a)
    }
    if (effects.grain) {
      // Luminance-weighted: grain lives in the mid-tones and leaves black black.
      const noise = rand(uv().add(time.fract())).sub(0.5)
      const luma = display.rgb.dot(vec3(0.2126, 0.7152, 0.0722))
      const weight = smoothstep(0, 0.25, luma).mul(smoothstep(0.6, 1.1, luma).oneMinus())
      display = vec4(display.rgb.add(noise.mul(dials.grain).mul(weight.mul(0.8).add(0.2))), display.a)
    }
    this.pipeline.outputNode = this.view === 'final' ? display : (inspected[this.view] ?? display)
    this.pipeline.needsUpdate = true
  }
}
