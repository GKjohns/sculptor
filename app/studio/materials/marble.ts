/**
 * The stone's look. One preset per medium: body and vein colours, how the veins run, how each
 * finish takes the light, how much light comes through a thin section.
 *
 * Veining is 3D noise evaluated at the stone's own block coordinates (cm), never at screen or
 * object-local ones, so the veins are sheets running through the block: every cut shows the next
 * slice of the same sheet, and a piece that falls off keeps the veins it had (see `coords`).
 * The noise is worked out once per preset into a volume (a sheet of slices, see VeinVolume) and
 * read back with two texture samples: evaluated per fragment it was some thirty noise lookups, and
 * a screen full of stone cost more to shade than everything else in the frame.
 * Roughness and the grain of the surface come from the per-vertex finish the tools left
 * (0 straight off the point chisel, 1 polished). Light through thin stone uses the per-vertex
 * thickness the mesher bakes (0 a knife edge, 1 THICKNESS_CM of stone or more).
 */
import * as THREE from 'three/webgpu'
import { attribute, color, diffuseColor, float, mix, mx_fractal_noise_float, mx_fractal_noise_vec3, mx_noise_float, mx_noise_vec3, normalLocal, normalView, positionLocal, positionViewDirection, select, smoothstep, texture, transformNormalToView, uniform, uv, vec2, vec3, vec4 } from 'three/tsl'

type Float = THREE.Node<'float'>
type Vec3 = THREE.Node<'vec3'>

export interface StonePreset {
  name: string
  /** The body of the stone and the grey its clouding drifts toward (sRGB). */
  body: number
  cloud: number
  /** The veins themselves. */
  vein: number
  /** Veins per centimetre along the bedding, and how strongly they show (0 none, 1 solid). */
  veinScale: number
  veinStrength: number
  /** Share of the surface the soft clouding greys. */
  cloudStrength: number
  /** The bedding the veins follow: a unit-ish axis they run square to, block coordinates. */
  bedding: [number, number, number]
  /** Roughness straight off the point chisel, off the rasp, and polished. */
  roughRaw: number
  roughSatin: number
  roughPolished: number
  /** Colour of light that has come through the stone, and how much of it there is. */
  glow: number
  translucency: number
  /** Specular strength of the polished surface (0 to 1). */
  sheen: number
}

/** Statuario-leaning Carrara: a warm white body, soft blue-grey veins, smoky clouding. */
export const CARRARA: StonePreset = {
  name: 'carrara',
  body: 0xf2ede4,
  cloud: 0xbdbcbb,
  vein: 0x70747c,
  veinScale: 0.072,
  veinStrength: 1.15,
  cloudStrength: 0.55,
  bedding: [0.45, 0.8, 0.4],
  roughRaw: 0.94,
  roughSatin: 0.58,
  roughPolished: 0.36,
  glow: 0xfff0de,
  translucency: 1.25,
  sheen: 1
}

/** Nero Marquina: the second medium's slot (Sprint 5). Constants only; not yet tuned by eye. */
export const NERO: StonePreset = {
  name: 'nero',
  body: 0x15151a,
  cloud: 0x1f2026,
  vein: 0xe8e4dc,
  veinScale: 0.07,
  veinStrength: 1,
  cloudStrength: 0.2,
  bedding: [0.7, 0.5, -0.5],
  roughRaw: 0.9,
  roughSatin: 0.42,
  roughPolished: 0.07,
  glow: 0x000000,
  translucency: 0,
  sheen: 1
}

export const STONE_PRESETS: Record<string, StonePreset> = { carrara: CARRARA, nero: NERO }

export interface MarbleOptions {
  /**
   * Where the fragment sits in the block, cm. The chunk meshes are in block coordinates already,
   * so the default is the local position. A piece that has left the block passes the attribute
   * that holds where each vertex was (see STONE_COORDS). Such a piece is shaded with its own
   * normals; only the stone on the banker has the mesher's smooth ones.
   */
  coords?: Vec3
  /** 0 to 1 per fragment. Left out, the `finish` vertex attribute; a number for loose pieces. */
  finish?: Float | number
  /** 0 to 1 per fragment. Left out, the `thickness` vertex attribute; a number for loose pieces. */
  thickness?: Float | number
}

/** The vertex attribute a loose piece carries so its veins stay where they were in the block. */
export const STONE_COORDS = 'stone'

// Physical lighting plus light that has passed through thin stone. three's own SSS model adds the
// term with the light's shadowed colour, and a thin edge lit from behind is, to the shadow map, in
// its own shadow: the light would go out exactly where it should show. So the transmitted term
// takes the light's colour before shadowing (still shaped by the window, see atelier.ts) and lets
// the baked thickness do the attenuating.
// Thickness is baked over THICKNESS_CM (3.2 cm); this many e-foldings of light are lost across it.
const THROUGH_FALLOFF = 2.4
// How far past the terminator scattered light reaches, as a share of the quarter turn.
const WRAP = 0.4

class MarbleLightingModel extends THREE.PhysicalLightingModel {
  constructor(private glow: Vec3, private through: Float, private scatter: Float) {
    super()
  }

  override direct(input: Parameters<THREE.PhysicalLightingModel['direct']>[0], builder: THREE.NodeBuilder) {
    const { lightDirection, lightColor, reflectedLight } = input
    const lightNode = (input as { lightNode?: { baseColorNode?: Vec3 | null, light?: THREE.Light } }).lightNode
    // Only a light that casts shadows is strong and directed enough to be seen through stone.
    if (lightNode?.light?.castShadow) {
      const open = lightNode.baseColorNode ?? (lightColor as Vec3)
      // Looking toward the light through the surface, with the normal bending the lobe a little.
      const half = vec3(lightDirection as Vec3).add(normalView.mul(0.35)).normalize()
      const facing = positionViewDirection.dot(half.negate()).saturate()
      const lobe = facing.pow(3).mul(1.5).add(facing.mul(0.35)).add(0.04)
      const diffuse = reflectedLight.directDiffuse as unknown as { addAssign: (n: Vec3) => void }
      diffuse.addAssign(this.glow.mul(this.through).mul(lobe).mul(open))
      // Light also scatters a few millimetres sideways under the surface, which carries it past the
      // terminator: the difference between stone and painted plaster. Shadowed, unlike the above.
      const facingLight = normalView.dot(lightDirection as Vec3)
      const wrapped = facingLight.add(WRAP).div(1 + WRAP).saturate().sub(facingLight.saturate())
      diffuse.addAssign(this.glow.mul(diffuseColor.rgb).mul(this.scatter).mul(wrapped).mul(lightColor as Vec3))
    }
    super.direct(input, builder)
  }
}

class MarbleMaterial extends THREE.MeshPhysicalNodeMaterial {
  glowNode: Vec3 = vec3(0)
  throughNode: Float = float(0)
  scatterNode: Float = float(0)

  override setupLightingModel() {
    return new MarbleLightingModel(this.glowNode, this.throughNode, this.scatterNode)
  }
}

/** Dials the look book turns; every stone material made here reads the same ones. */
export const marbleDials = {
  /** Multiplies every preset's translucency. */
  translucency: uniform(1),
  /** Multiplies vein contrast. */
  veins: uniform(1),
  /** Multiplies the light scattered past the terminator. */
  scatter: uniform(1),
  /** Multiplies the tool-mark normal noise on rough stone. */
  marks: uniform(1),
  /** Debug view, unlit: 0 off, 1 the finish, 2 the shading normal, 3 the thickness, 4 the mesh normal, 5 the veins. */
  view: uniform(0)
}

// The veins of one preset, worked out once. The volume covers VOLUME_CM of stone at TEXEL_CM a
// texel, which is finer than the thinnest vein, and repeats mirrored beyond that, so a block of
// any size (and the blocks standing about the room) can read it. It is stored as horizontal
// slices tiled across one 2D texture: that renders in a single draw on either backend, and
// reading it is two samples and a mix.
const VOLUME_CM: [number, number, number] = [64, 104, 64]
const SLICE = 128
const SLICES = 208
const TILES_X = 16
const TILES_Y = SLICES / TILES_X

// Veining (x) and clouding (y), each 0 to 1, at a point in the block, cm.
function veinField(p: Vec3, preset: StonePreset) {
  // The block is bent by a slow warp and frayed by a quicker one, then squeezed along the
  // bedding axis, so a noise read there has its zero crossings lying roughly in sheets. Near a
  // sheet the stone greys: a broad smoky band with a fainter core. Two such families, each
  // switched on and off by a slower noise, so a vein runs a hand or two and dies away.
  const [bx, by, bz] = preset.bedding
  const bed = vec3(bx, by, bz).normalize()
  const warp = mx_fractal_noise_vec3(p.mul(0.026), 3).mul(15).add(mx_fractal_noise_vec3(p.mul(0.13).add(vec3(9.2, 3.3, 6.1)), 2).mul(1.8))
  const bent = p.add(warp)
  const squeezed = bent.add(bed.mul(bent.dot(bed)).mul(1.1))
  const s = preset.veinScale
  const a = mx_noise_float(squeezed.mul(s)).abs().oneMinus()
  const b = mx_noise_float(squeezed.mul(s * 2.3).add(vec3(31.7, 4.1, 12.9))).abs().oneMinus()
  const onA = smoothstep(-0.35, 0.25, mx_noise_float(p.mul(0.021).add(vec3(7.3, 1.9, 4.4))))
  const onB = smoothstep(-0.25, 0.35, mx_noise_float(p.mul(0.034).add(vec3(2.6, 8.8, 0.7))))
  const major = a.pow(3).mul(0.5).add(a.pow(18).mul(0.2)).mul(onA)
  const minor = b.pow(5).mul(0.34).add(b.pow(24).mul(0.14)).mul(onB)
  // And faint hairline feathering everywhere, finer than either, so that no carved face is blank.
  const c = mx_noise_float(squeezed.mul(s * 3.1).add(vec3(5.9, 17.3, 2.2))).abs().oneMinus()
  const feather = c.pow(8).mul(0.45).mul(mx_noise_float(p.mul(0.05).add(vec3(1.4, 6.6, 9.1))).mul(0.5).add(0.6).saturate())
  const veining = major.add(minor).add(feather).mul(preset.veinStrength).saturate()
  // Clouding: broad smoky greys that follow the same bedding.
  const smoke = mx_fractal_noise_float(squeezed.mul(s * 0.5).add(vec3(3.1, 8.2, 5.5)), 4).mul(0.5).add(0.5)
  const clouding = smoothstep(0.42, 0.85, smoke).mul(preset.cloudStrength)
  return { veining, clouding }
}

class VeinVolume {
  readonly target = new THREE.RenderTarget(SLICE * TILES_X, SLICE * TILES_Y, { depthBuffer: false, type: THREE.UnsignedByteType, colorSpace: THREE.NoColorSpace })
  baked = false

  constructor(readonly preset: StonePreset) {
    this.target.texture.name = `veins-${preset.name}`
    this.target.texture.generateMipmaps = false
    this.target.texture.minFilter = this.target.texture.magFilter = THREE.LinearFilter
  }

  /** Veining (x) and clouding (y) at a point, cm, block coordinates. */
  sample(p: Vec3) {
    const [vx, vy, vz] = VOLUME_CM
    // Volume coordinates, 0 to 1, folded back and forth outside the volume.
    const folded = p.add(vec3(vx / 2, 2, vz / 2)).div(vec3(vx, vy, vz)).mul(0.5).fract().mul(2).sub(1).abs()
    const level = folded.y.mul(SLICES - 1)
    const below = level.floor()
    // Half a texel in from a tile's edge, so the filter never reaches into the next tile.
    const inTile = folded.xz.clamp(0.5 / SLICE, 1 - 0.5 / SLICE)
    const tile = (slice: Float) => {
      const row = slice.div(TILES_X).floor()
      return vec2(slice.sub(row.mul(TILES_X)), row).add(inTile).div(vec2(TILES_X, TILES_Y))
    }
    const map = this.target.texture
    return mix(texture(map, tile(below)), texture(map, tile(below.add(1).min(SLICES - 1))), level.fract())
  }

  /** Works the volume out: one draw. */
  bake(renderer: THREE.WebGPURenderer) {
    const [vx, vy, vz] = VOLUME_CM
    const at = uv().mul(vec2(TILES_X, TILES_Y))
    const cell = at.floor()
    // The slice's own texel centres run 0 to 1 edge to edge, as sample() reads them.
    const inTile = at.fract().sub(0.5 / SLICE).div(1 - 1 / SLICE)
    const slice = cell.y.mul(TILES_X).add(cell.x)
    const p = vec3(inTile.x, slice.div(SLICES - 1), inTile.y).mul(vec3(vx, vy, vz)).sub(vec3(vx / 2, 2, vz / 2))
    const { veining, clouding } = veinField(p, this.preset)
    const material = new THREE.NodeMaterial()
    material.fragmentNode = vec4(veining, clouding, 0, 1)
    const quad = new THREE.QuadMesh(material)
    const before = renderer.getRenderTarget()
    renderer.setRenderTarget(this.target)
    quad.render(renderer)
    renderer.setRenderTarget(before)
    material.dispose()
    this.baked = true
  }
}

const volumes = new Map<string, VeinVolume>()

function veinVolume(preset: StonePreset) {
  let volume = volumes.get(preset.name)
  if (!volume) volumes.set(preset.name, volume = new VeinVolume(preset))
  return volume
}

/**
 * Works out the vein volume of every preset a material has been made for and that has not been
 * done yet. Cheap to call every frame; needs an initialised renderer. Until it has run, stone is
 * plain body colour, and with `skip` it stays that way (a software renderer takes most of a
 * minute over the bake).
 */
export function bakeStone(renderer: THREE.WebGPURenderer, skip = false) {
  for (const volume of volumes.values()) {
    if (volume.baked) continue
    if (skip) volume.baked = true
    else volume.bake(renderer)
  }
}

/** Frees the vein volumes (they are made again on the next createMarble). */
export function disposeStone() {
  for (const volume of volumes.values()) volume.target.dispose()
  volumes.clear()
}

export function createMarble(preset: StonePreset = CARRARA, options: MarbleOptions = {}): THREE.MeshPhysicalNodeMaterial {
  const material = new MarbleMaterial()
  material.name = `stone-${preset.name}`
  const p: Vec3 = options.coords ?? positionLocal
  const finish: Float = typeof options.finish === 'number' ? float(options.finish) : options.finish ?? attribute('finish', 'float')
  const thickness: Float = typeof options.thickness === 'number' ? float(options.thickness) : options.thickness ?? attribute('thickness', 'float')

  // Veins and clouding, read from the preset's volume.
  const field = veinVolume(preset).sample(p)
  const veining = field.x.mul(marbleDials.veins).saturate()
  const clouding = field.y
  // The crystal grain: a faint speckle a millimetre or two across.
  const grain = mx_noise_float(p.mul(11)).mul(0.035).mul(smoothstep(0.015, 0.045, p.fwidth().length()).oneMinus())
  const body = mix(color(preset.body), color(preset.cloud), clouding)
  const stone = mix(body, color(preset.vein), veining).mul(grain.add(1))
  // Fresh-cut rough stone scatters more and reads paler and chalkier than the same stone polished.
  const raw = finish.oneMinus()
  material.colorNode = mix(stone, mix(stone, color(0xffffff), 0.12), raw.mul(raw))

  // Finish. Roughness falls slowly from the point chisel to the rasp, then quickly to the polish.
  const matte = mix(float(preset.roughRaw), float(preset.roughSatin), smoothstep(0, 0.7, finish))
  material.roughnessNode = mix(matte, float(preset.roughPolished), smoothstep(0.68, 1, finish)).add(grain.mul(raw).mul(2)).clamp(0.04, 1)
  material.metalnessNode = float(0)
  // Polished stone, not glaze: a low, broad highlight.
  material.specularIntensityNode = mix(float(0.45), float(0.6), finish).mul(preset.sheen)
  material.ior = 1.49

  // Tool marks below the size of a voxel: a coarse tooth and a fine one, both gone by the polish.
  // Each fades out as it shrinks toward a pixel, where it would only be noise.
  const footprint = p.fwidth().length()
  const tooth = mx_noise_vec3(p.mul(7)).mul(raw.pow(1.5).mul(0.24)).mul(smoothstep(0.03, 0.09, footprint).oneMinus())
  const bite = mx_noise_vec3(p.mul(19)).mul(raw.mul(0.14)).mul(smoothstep(0.008, 0.026, footprint).oneMinus())
  // The surface the light sees. What the point chisel left keeps its own normals, craters and
  // all. Anything worked further (claw, flat, saw, rasp, polish) is shaded with the mesher's smooth
  // normals: the geometry still carries every groove, a voxel or two deep and as regular as the
  // hand's strokes, and lit by its own normals a rasped cheek is corduroy.
  const worked: Float = smoothstep(0.09, 0.2, finish)
  const surface: Vec3 = options.coords ? normalLocal : mix(normalLocal, attribute('smoothNormal', 'vec3'), worked).normalize()
  material.normalNode = transformNormalToView(surface.add(tooth.add(bite).mul(marbleDials.marks)).normalize())
  const view = marbleDials.view
  const shown = select(view.equal(1), vec3(finish), select(view.equal(2), surface.mul(0.5).add(0.5), select(view.equal(4), normalLocal.mul(0.5).add(0.5), select(view.equal(5), vec3(veining.oneMinus()), vec3(thickness)))))
  material.emissiveNode = select(view.greaterThan(0), shown, vec3(0))
  material.colorNode = select(view.greaterThan(0), vec3(0), material.colorNode)

  // Light through thin stone dies away with depth, by about two thirds every centimetre; the
  // curve is shifted so that the bake's full thickness lets nothing through. Veins and clouding
  // are denser and let less through.
  const depth = thickness.saturate().mul(THROUGH_FALLOFF)
  const through = depth.negate().exp().sub(Math.exp(-THROUGH_FALLOFF)).max(0)
  material.glowNode = color(preset.glow).mul(float(preset.translucency).mul(marbleDials.translucency))
  // Much less of it off the point chisel: every crater rim is thin, and lit through they read as flecks.
  material.throughNode = through.mul(veining.mul(0.6).add(clouding.mul(0.3)).oneMinus()).mul(mix(float(0.25), float(1), worked))
  // In Lambert's units: a third of what a square-on face returns, at the terminator.
  material.scatterNode = float(preset.translucency * 0.3).mul(marbleDials.scatter)
  return material
}

/** For a piece that has come off the block: veins where they were, thick, with the finish it is given. */
export function createLooseMarble(preset: StonePreset = CARRARA, finish = 0.2): THREE.MeshPhysicalNodeMaterial {
  return createMarble(preset, { coords: attribute(STONE_COORDS, 'vec3'), finish, thickness: 1 })
}

/**
 * For chips and shards, which are instanced and too small to show a vein: the body colour, fresh
 * broken and matte. Cheap; no noise.
 */
export function createChipMarble(preset: StonePreset = CARRARA): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: preset.roughRaw, metalness: 0 })
  material.name = `chip-${preset.name}`
  material.colorNode = mix(color(preset.body), color(0xffffff), 0.1)
  return material
}
