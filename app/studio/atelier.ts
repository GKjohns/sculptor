/**
 * The room the stone stands in: a timber banker on a dusty floor, a wall with one tall window to
 * the viewer's left, a back wall that falls away into the dark, and the light.
 *
 * Light rig, all of it reachable from here so debris, tools and dust are lit the same way:
 *   key      the sun through the window: a DirectionalLight (the only kind three's god rays and
 *            contact shadows accept) whose colour is shaped by the window opening (`keyLightAt`),
 *            so it lights a pool, not the whole room, and falls off to nothing outside it
 *   fill     a dim cool directional from the camera side, no shadows
 *   ambient  a hemisphere light at the bottom of everything
 *   environment  a generated cube map (PMREM of a few emissive cards: the window, the floor's
 *            bounce, a cool fill) for soft wrap-around light and for reflections in polished stone
 *
 * Scene units are block centimetres: the banker's top is y = BANKER_TOP_Y, where the block stands.
 */
import * as THREE from 'three/webgpu'
import { CARRARA, createMarble } from './materials/marble'
import { Fn, color, float, frameId, int, interleavedGradientNoise, mix, mx_fractal_noise_float, mx_noise_float, normalWorld, positionWorld, screenCoordinate, smoothstep, texture, uniform, vec3, vogelDiskSample } from 'three/tsl'

type Float = THREE.Node<'float'>
type Vec3 = THREE.Node<'vec3'>

/** The banker's top surface, which the block stands on, and the floor under it. */
export const BANKER_TOP_Y = 0
export const FLOOR_Y = -84
/** Half the side of the banker's square top. */
export const BANKER_HALF = 47
/** Thickness of the banker's top. */
export const BANKER_TOP_CM = 7
/** The wall the window is in (its room-side face), and the wall behind the stone. */
export const WALL_X = -250
export const BACK_Z = -390
const WALL_CM = 30
/** The window opening in the left wall. */
export const WINDOW = { y0: 130, y1: 372, z0: 96, z1: 304 }
/** What the key is aimed at: the middle of the block. */
export const KEY_TARGET = new THREE.Vector3(0, 55, 0)

/**
 * Things debris can land on, as axis-aligned boxes (centre and half extents, cm). The floor is
 * the plane y = FLOOR_Y.
 */
export const ATELIER_SOLIDS: { name: string, center: [number, number, number], half: [number, number, number] }[] = [
  { name: 'banker-top', center: [0, BANKER_TOP_Y - BANKER_TOP_CM / 2, 0], half: [BANKER_HALF, BANKER_TOP_CM / 2, BANKER_HALF] },
  { name: 'banker-frame', center: [0, (BANKER_TOP_Y - BANKER_TOP_CM + FLOOR_Y) / 2, 0], half: [40, (BANKER_TOP_Y - BANKER_TOP_CM - FLOOR_Y) / 2, 40] }
]

const SUN = 0xffe2bd
const DAYLIGHT = 0xcfe0ff
// Taps in the key's shadow filter.
const SHADOW_TAPS = 8

function box(w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material, cast = true) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)
  mesh.position.set(x, y, z)
  mesh.castShadow = cast
  mesh.receiveShadow = true
  mesh.matrixAutoUpdate = false
  mesh.updateMatrix()
  return mesh
}

// Marble dust settles on anything that faces up; thickest near the work.
function dusted(base: Vec3, amount: number): Vec3 {
  const p = positionWorld
  const near = smoothstep(40, 260, p.xz.length()).oneMinus()
  const patchy = mx_fractal_noise_float(p.mul(0.045), 3).mul(0.5).add(0.6).saturate()
  const up = smoothstep(0.75, 1, normalWorld.y)
  return mix(base, color(0xb9b3a8), up.mul(near).mul(patchy).mul(amount))
}

// Old workbench timber with the grain running along `axis`.
function timber(axis: 'x' | 'y' | 'z') {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0 })
  material.name = `timber-${axis}`
  const p = positionWorld
  const along = axis === 'x' ? p.x : axis === 'y' ? p.y : p.z
  const across = axis === 'x' ? p.yz : axis === 'y' ? p.xz : p.xy
  const g = vec3(along.mul(0.035), across.x.mul(0.55), across.y.mul(0.55))
  const figure = mx_noise_float(g).mul(0.5).add(0.5)
  const pores = mx_noise_float(vec3(along.mul(0.25), across.x.mul(5), across.y.mul(5))).mul(0.5).add(0.5)
  const wood = mix(color(0x21170f), color(0x574029), figure.mul(0.7).add(pores.mul(0.3)))
  material.colorNode = dusted(wood, 0.4)
  material.roughnessNode = mix(float(0.62), float(0.88), pores)
  material.envMapIntensity = 0.12
  return material
}

export class Atelier {
  /** Everything built here; the stone is not in it. */
  readonly room = new THREE.Group()
  readonly key = new THREE.DirectionalLight(SUN, 1)
  readonly fill = new THREE.DirectionalLight(0xb9c6e0, 0.09)
  readonly ambient = new THREE.HemisphereLight(0xb4bccb, 0x2a2119, 0.045)
  /** The way the key's light travels, unit length. */
  readonly keyDirection = new THREE.Vector3()
  /** The key's strength; the light's own colour and intensity fields are not read once it has a window. */
  readonly keyColor = uniform(new THREE.Color(SUN))
  readonly keyStrength = uniform(2.8)
  /** Colour of the haze the shaft shows up in, for the post stack's god rays. */
  readonly haze = new THREE.Color(0xffe9cf)
  environment: THREE.Texture | null = null

  /**
   * 1 when something downstream averages frames (TRAA): the shadow filter then turns its taps a
   * different way every frame and the average is a smooth penumbra. 0 keeps the dither still.
   */
  readonly temporal = uniform(0)

  private disposables: { dispose: () => void }[] = []
  private lean = false
  private direction = uniform(new THREE.Vector3())

  constructor(private scene: THREE.Scene) {
    this.room.name = 'atelier'
    const from = new THREE.Vector3(WALL_X, (WINDOW.y0 + WINDOW.y1) / 2 + 14, (WINDOW.z0 + WINDOW.z1) / 2)
    this.keyDirection.copy(KEY_TARGET).sub(from).normalize()
    this.direction.value.copy(this.keyDirection)

    this.buildBanker()
    this.buildRoom()
    this.buildYard()
    this.buildLights(from)
    scene.add(this.room)
  }

  /**
   * The key's colour at a world position, before shadows: the sun's colour inside the shaft the
   * window lets through, nothing outside it, with an edge that softens with distance from the
   * window. This is the key light's colorNode; a particle material that wants to light up in the
   * shaft multiplies by it (pass positionWorld).
   */
  keyLightAt(position: Vec3): Vec3 {
    const d = this.direction
    // Back along the light to the plane of the window.
    const t = position.x.sub(WALL_X).div(d.x)
    const y = position.y.sub(d.y.mul(t))
    const z = position.z.sub(d.z.mul(t))
    const soft: Float = t.mul(0.022).add(1.5)
    const inside = y.sub(WINDOW.y0).min(float(WINDOW.y1).sub(y)).min(z.sub(WINDOW.z0)).min(float(WINDOW.z1).sub(z))
    const open = smoothstep(0, soft.mul(2), inside).mul(position.x.greaterThan(WALL_X).select(1, 0))
    return this.keyColor.mul(this.keyStrength).mul(open)
  }

  // three's PCF filter with more taps and a dither that moves from frame to frame (when `temporal`
  // is set), so TRAA can average it: five still taps leave a pattern in a penumbra this wide.
  private shadowFilter() {
    const radius = uniform(1).onRenderUpdate(() => this.key.shadow.radius / this.key.shadow.mapSize.x)
    return Fn(({ depthTexture, shadowCoord }: { depthTexture: THREE.DepthTexture, shadowCoord: Vec3 }) => {
      const turn = float(frameId.mod(32)).mul(5.588238).mul(this.temporal)
      const phi = interleavedGradientNoise(screenCoordinate.xy.add(turn)).mul(6.28318530718)
      // Built when the first material compiles, by which time bake() has said whether to go easy.
      const taps = this.lean ? 3 : SHADOW_TAPS
      let lit: Float = float(0)
      for (let i = 0; i < taps; i++) {
        const at = shadowCoord.xy.add(vogelDiskSample(int(i), int(taps), phi).mul(radius))
        lit = lit.add((texture(depthTexture, at) as unknown as { compare: (z: Float) => Float }).compare(shadowCoord.z))
      }
      return lit.div(taps)
    })
  }

  /**
   * Builds the environment map. Needs an initialised renderer. `lean` is for a software renderer:
   * a small map, and a shadow map a sixteenth the size.
   */
  bake(renderer: THREE.WebGPURenderer, lean = false) {
    if (lean) {
      this.lean = true
      const scale = 1024 / this.key.shadow.mapSize.x
      this.key.shadow.mapSize.set(1024, 1024)
      this.key.shadow.radius *= scale
    }
    const env = new THREE.Scene()
    const card = (w: number, h: number, hex: number, strength: number, at: THREE.Vector3, face: THREE.Vector3) => {
      const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide })
      material.colorNode = color(hex).mul(strength)
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material)
      mesh.position.copy(at)
      mesh.lookAt(face)
      env.add(mesh)
      this.disposables.push(material, mesh.geometry)
    }
    const shell = new THREE.Mesh(new THREE.BoxGeometry(1600, 900, 1600), new THREE.MeshBasicNodeMaterial({ color: 0x060607, side: THREE.BackSide }))
    shell.position.set(0, 300, 0)
    env.add(shell)
    this.disposables.push(shell.geometry, shell.material as THREE.Material)
    const centre = KEY_TARGET
    // The window: the large soft source. Wider than the opening, as the sky behind it is.
    card(WINDOW.z1 - WINDOW.z0 + 40, WINDOW.y1 - WINDOW.y0, DAYLIGHT, 2.6, new THREE.Vector3(WALL_X, (WINDOW.y0 + WINDOW.y1) / 2, (WINDOW.z0 + WINDOW.z1) / 2), centre)
    // The sunlit patch of floor behind and to the right, bouncing warm light back up.
    card(300, 220, 0xffc998, 0.5, new THREE.Vector3(170, FLOOR_Y, -150), new THREE.Vector3(170, 400, -150))
    // A broad cool fill from the camera's side of the room.
    card(700, 500, 0x86a0d0, 0.28, new THREE.Vector3(420, 180, 420), centre)
    // The pale floor round the banker.
    card(900, 900, 0x4a443c, 0.07, new THREE.Vector3(0, FLOOR_Y, 0), new THREE.Vector3(0, 400, 0))
    const pmrem = new THREE.PMREMGenerator(renderer)
    const target = pmrem.fromScene(env, 0.02, 1, 3000, { size: lean ? 32 : 256, position: centre })
    pmrem.dispose()
    this.environment = target.texture
    this.disposables.push(target)
    this.scene.environment = target.texture
    this.scene.environmentIntensity = 1
  }

  dispose() {
    this.scene.remove(this.room, this.key, this.key.target, this.fill, this.fill.target, this.ambient)
    this.room.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    })
    for (const d of this.disposables) d.dispose()
    this.key.shadow.dispose()
    if (this.scene.environment === this.environment) this.scene.environment = null
  }

  private buildBanker() {
    const banker = new THREE.Group()
    banker.name = 'banker'
    const x = timber('x')
    const y = timber('y')
    const z = timber('z')
    const top = BANKER_TOP_Y
    const under = top - BANKER_TOP_CM
    // The top: four planks.
    const plank = (BANKER_HALF * 2) / 4
    for (let i = 0; i < 4; i++) banker.add(box(BANKER_HALF * 2, BANKER_TOP_CM, plank - 0.5, 0, top - BANKER_TOP_CM / 2, -BANKER_HALF + plank * (i + 0.5), x))
    // Apron, legs and low stretchers.
    const leg = 10
    const reach = BANKER_HALF - 9
    const legH = under - FLOOR_Y
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) banker.add(box(leg, legH, leg, sx * reach, under - legH / 2, sz * reach, y))
      banker.add(box(4, 13, reach * 2 - leg, sx * reach, under - 6.5, 0, z))
      banker.add(box(reach * 2 - leg, 13, 4, 0, under - 6.5, sx * reach, x))
      banker.add(box(4, 8, reach * 2 - leg, sx * reach, FLOOR_Y + 16, 0, z))
    }
    banker.add(box(reach * 2 - leg, 8, 4, 0, FLOOR_Y + 16, 0, x))
    this.room.add(banker)
  }

  private buildRoom() {
    // Floor: worn stone flags under a film of dust.
    const floor = new THREE.MeshStandardNodeMaterial({ metalness: 0 })
    floor.name = 'floor'
    const p = positionWorld
    const flag = p.xz.div(62).add(vec3(0.3, 0.7, 0).xy)
    // Distance to the nearest edge of the flag, in flags.
    const edge = flag.fract().sub(0.5).abs().oneMinus().sub(0.5)
    const seam = smoothstep(0.008, 0.028, edge.x.min(edge.y)).oneMinus()
    const tone = mx_noise_float(vec3(flag.floor().mul(7.31), 3)).mul(0.5).add(0.5)
    const wear = mx_fractal_noise_float(p.mul(0.012), 4).mul(0.5).add(0.5)
    const stoneFloor = mix(color(0x2b2824), color(0x4a443c), tone.mul(0.6).add(wear.mul(0.4))).mul(mix(float(1), float(0.45), seam))
    floor.colorNode = dusted(stoneFloor, 0.5)
    floor.roughnessNode = mix(float(0.7), float(0.95), wear)
    floor.envMapIntensity = 0.06
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), floor)
    ground.name = 'floor'
    ground.rotation.x = -Math.PI / 2
    ground.position.set(200, FLOOR_Y, 0)
    ground.receiveShadow = true
    ground.matrixAutoUpdate = false
    ground.updateMatrix()
    this.room.add(ground)

    // Walls: old limewash, darker and blotchier toward the floor.
    const plaster = new THREE.MeshStandardNodeMaterial({ metalness: 0 })
    plaster.name = 'plaster'
    const blotch = mx_fractal_noise_float(p.mul(0.008), 4).mul(0.5).add(0.5)
    const rising = smoothstep(FLOOR_Y, FLOOR_Y + 160, p.y)
    plaster.colorNode = mix(color(0x1c1a17), color(0x3d382f), blotch.mul(0.55).add(rising.mul(0.45)))
    plaster.roughnessNode = float(0.93)
    plaster.envMapIntensity = 0.04
    const top = 640
    const span = top - FLOOR_Y
    const front = 700
    const wx = WALL_X - WALL_CM / 2
    const { y0, y1, z0, z1 } = WINDOW
    // The left wall in four pieces round the opening.
    this.room.add(
      box(WALL_CM, y0 - FLOOR_Y, front - BACK_Z, wx, (y0 + FLOOR_Y) / 2, (front + BACK_Z) / 2, plaster),
      box(WALL_CM, top - y1, front - BACK_Z, wx, (top + y1) / 2, (front + BACK_Z) / 2, plaster),
      box(WALL_CM, y1 - y0, z0 - BACK_Z, wx, (y0 + y1) / 2, (z0 + BACK_Z) / 2, plaster),
      box(WALL_CM, y1 - y0, front - z1, wx, (y0 + y1) / 2, (front + z1) / 2, plaster),
      // The back wall.
      box(1400, span, WALL_CM, WALL_X + 700, FLOOR_Y + span / 2, BACK_Z - WALL_CM / 2, plaster)
    )
    // The window's bars, where their shadows miss the stone: a transom above it and a mullion behind it.
    const frame = new THREE.MeshStandardNodeMaterial({ color: 0x1b1714, roughness: 0.8, metalness: 0 })
    frame.name = 'window-frame'
    frame.envMapIntensity = 0.04
    const fx = WALL_X - WALL_CM + 5
    this.room.add(
      box(5, 5, z1 - z0, fx, y1 - 34, (z0 + z1) / 2, frame),
      box(5, y1 - y0, 5, fx, (y0 + y1) / 2, z0 + 34, frame)
    )
    // The sky outside: what the window looks like from the room, and what bloom catches.
    const sky = new THREE.MeshBasicNodeMaterial()
    sky.name = 'sky'
    sky.colorNode = color(DAYLIGHT).mul(5.5)
    sky.fog = false
    const outside = new THREE.Mesh(new THREE.PlaneGeometry(z1 - z0 + 260, y1 - y0 + 260), sky)
    outside.name = 'sky'
    outside.position.set(WALL_X - WALL_CM - 60, (y0 + y1) / 2 + 40, (z0 + z1) / 2 + 40)
    outside.rotation.y = Math.PI / 2
    outside.matrixAutoUpdate = false
    outside.updateMatrix()
    this.room.add(outside)
  }

  // What stands about at the far end of the room, where the window's light lands: blocks waiting
  // their turn and timber against the wall. They give the dark some depth and the lens something
  // to lose focus on. All of it is well clear of the banker.
  private buildYard() {
    const yard = new THREE.Group()
    yard.name = 'yard'
    const put = (mesh: THREE.Mesh, turnY: number, tiltZ = 0) => {
      mesh.rotation.set(0, turnY, tiltZ)
      mesh.updateMatrix()
      yard.add(mesh)
    }
    // Each block reads the veins somewhere else in the same quarry.
    // They stand outside the shaft, where the environment's window would light them unshadowed.
    const quarried = (offset: [number, number, number], finish: number) => {
      const material = createMarble(CARRARA, { coords: positionWorld.add(vec3(...offset)), finish, thickness: 1 })
      material.envMapIntensity = 0.1
      return material
    }
    const sawn = quarried([310, 40, 95], 0.34)
    const rough = quarried([-120, 260, 30], 0.12)
    put(box(74, 52, 58, 236, FLOOR_Y + 26, -268, sawn), 0.34)
    put(box(46, 30, 40, 228, FLOOR_Y + 67, -272, rough), -0.22)
    put(box(38, 96, 34, 118, FLOOR_Y + 48, -338, sawn), 0.12)
    put(box(120, 7, 70, 330, FLOOR_Y + 3.5, -190, sawn), -0.5)
    const plank = timber('y')
    put(box(22, 250, 4, -40, FLOOR_Y + 122, BACK_Z + 26, plank), 0, 0)
    put(box(18, 230, 4, -12, FLOOR_Y + 112, BACK_Z + 22, plank), 0, 0.05)
    put(box(26, 210, 5, -150, FLOOR_Y + 103, BACK_Z + 24, plank), 0, -0.04)
    // Leaning: tipped back onto the wall.
    for (const o of yard.children) {
      if ((o as THREE.Mesh).material !== plank) continue
      o.rotation.x = -0.1
      o.updateMatrix()
    }
    this.room.add(yard)
  }

  private buildLights(from: THREE.Vector3) {
    const { key, fill } = this
    // The colour node carries strength and the window's shape; three multiplies the shadow into it.
    ;(key as unknown as { colorNode: Vec3 }).colorNode = this.keyLightAt(positionWorld)
    key.position.copy(from).addScaledVector(this.keyDirection, -160)
    key.target.position.copy(KEY_TARGET)
    key.castShadow = true
    key.shadow.mapSize.set(4096, 4096)
    key.shadow.bias = -0.0002
    key.shadow.normalBias = 0.12
    // Texels of blur in the shadow filter: the sun is not a point, and TRAA resolves the dither.
    key.shadow.radius = 14
    ;(key.shadow as unknown as { filterNode: unknown }).filterNode = this.shadowFilter()

    // The shadow box holds the whole shaft: from outside the window to where its light lands on
    // the floor. Whatever lies outside the box lies outside the shaft, where the key's colour is zero.
    key.updateMatrixWorld()
    key.target.updateMatrixWorld()
    const cam = key.shadow.camera
    cam.position.copy(key.position)
    cam.lookAt(KEY_TARGET)
    cam.updateMatrixWorld()
    const inverse = cam.matrixWorld.clone().invert()
    const bounds = new THREE.Box3()
    const corner = new THREE.Vector3()
    const pad = 26
    for (const y of [WINDOW.y0 - pad, WINDOW.y1 + pad]) {
      for (const z of [WINDOW.z0 - pad, WINDOW.z1 + pad]) {
        corner.set(WALL_X - WALL_CM, y, z)
        bounds.expandByPoint(corner.clone().applyMatrix4(inverse))
        // The same ray carried on to the floor.
        const t = (FLOOR_Y - 4 - y) / this.keyDirection.y
        bounds.expandByPoint(corner.clone().addScaledVector(this.keyDirection, t).applyMatrix4(inverse))
      }
    }
    cam.left = bounds.min.x
    cam.right = bounds.max.x
    cam.bottom = bounds.min.y
    cam.top = bounds.max.y
    cam.near = Math.max(1, -bounds.max.z - 10)
    cam.far = -bounds.min.z + 10
    cam.updateProjectionMatrix()

    fill.position.set(260, 140, 300)
    fill.target.position.copy(KEY_TARGET)
    this.scene.add(key, key.target, fill, fill.target, this.ambient)
  }
}
