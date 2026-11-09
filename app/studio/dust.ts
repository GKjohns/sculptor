/**
 * Marble dust, the smallest of the three scales of debris: a puff where a tool lands, motes that
 * hang in the window's shaft and thicken as the work goes on, and a pale film that builds on the
 * floor round the banker.
 *
 * The puffs and the motes are one TSL compute particle system: two instanced storage buffers
 * (position + age, velocity + lifetime) stepped on the GPU by renderer.compute() and drawn as
 * sprites straight from the same buffers. The first HAZE particles are the motes, alive for good
 * and wrapped round a box that holds the shaft; the rest are a ring that puffs are written into,
 * one puff a frame, by handing the compute pass the puff as uniforms.
 *
 * The WebGL 2 fallback gets no particles at all (`compute: false`): only the film, which is a
 * plain mesh. Nothing here reads the wall clock; update(dt) is the only way time gets in.
 */
import * as THREE from 'three/webgpu'
import { cameraPosition, cos, exp, float, Fn, hash, If, instancedArray, instanceIndex, max, mx_noise_float, positionWorld, sin, smoothstep, uniform, uv, vec3, vec4 } from 'three/tsl'
import type { StudioRenderer } from './renderer'

type Node = ReturnType<typeof float>

export interface DustOptions {
  floorY: number
  /** The top the block stands on: the film lies on it too. */
  bankerY: number
  bankerHalf: number
  /** False on the WebGL 2 fallback: no compute, no particles. */
  compute: boolean
  /** The key light's colour at a world position, for motes that light up in the shaft. Left out, a soft column over the block. */
  shaft?: (position: Node) => Node
}

/** The budget: motes, puff particles, and the most puffs kept waiting. */
export const DUST_HAZE = 1400
export const DUST_PUFF = 5000
const QUEUE = 10
// The box the motes drift in: from the window side of the banker to just past it, floor to above the block.
const HAZE_MIN = new THREE.Vector3(-190, -80, -70)
const HAZE_SIZE = new THREE.Vector3(290, 300, 300)
// The stone that has to come off for the air to be as thick with dust as it gets, cm³ (a
// commission takes off 100,000 to 200,000), and for the film on the floor to be as thick as it gets.
const HAZE_FULL_CM3 = 220_000
const FILM_FULL_CM3 = 140_000
const DUST_COLOR = 0xf1ece2

interface Puff {
  x: number
  y: number
  z: number
  dx: number
  dy: number
  dz: number
  count: number
  radius: number
  speed: number
  spread: number
  life: number
}

export class Dust {
  /** 0 to 1: how much dust the work has put in the air and on the floor so far. */
  level = 0

  private sprites: THREE.Sprite | null = null
  private films: THREE.Mesh[] = []
  private step: THREE.ComputeNode | null = null
  private queue: Puff[] = []
  private head = 0
  private emitted = 0
  private clock = 0
  private u = {
    dt: uniform(0),
    time: uniform(0),
    at: uniform(new THREE.Vector3()),
    dir: uniform(new THREE.Vector3(0, 1, 0)),
    start: uniform(0),
    count: uniform(0),
    seed: uniform(0),
    radius: uniform(1),
    speed: uniform(0),
    spread: uniform(0.5),
    life: uniform(1),
    haze: uniform(0),
    film: uniform(0)
  }

  constructor(private studio: StudioRenderer, private options: DustOptions) {
    this.buildFilm()
    if (options.compute) this.buildParticles()
  }

  /** How many particles the last second's puffs asked for, and what is waiting. */
  stats() {
    return { particles: this.sprites ? DUST_HAZE + DUST_PUFF : 0, queued: this.queue.length, emitted: this.emitted, level: Math.round(this.level * 1000) / 1000 }
  }

  /**
   * A puff at a point, thrown along `dir`. `amount` is about 1 for a heavy chisel blow, a
   * fraction for a rasp stroke and several for a slab landing; it sets how many particles, how
   * wide and how long. One puff goes out a frame; when more are waiting than the queue holds,
   * the smallest waiting one is dropped.
   */
  puff(x: number, y: number, z: number, dx: number, dy: number, dz: number, amount: number, speed = 60) {
    if (!this.sprites) return
    const puff: Puff = {
      x, y, z, dx, dy, dz,
      count: Math.min(900, Math.max(4, Math.round(14 * amount))),
      radius: 0.6 + Math.sqrt(amount) * 1.6,
      speed,
      spread: 0.55,
      life: 1.4 + Math.min(4, Math.sqrt(amount) * 0.9)
    }
    if (this.queue.length >= QUEUE) {
      let least = 0
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i]!.count < this.queue[least]!.count) least = i
      if (this.queue[least]!.count >= puff.count) return
      this.queue.splice(least, 1)
    }
    this.queue.push(puff)
  }

  /** Stone has come off: the air and the floor take their share of it, whether or not a puff was drawn. */
  raise(cm3: number) {
    this.level = Math.min(1, this.level + cm3 / HAZE_FULL_CM3)
    this.u.haze.value = this.level
    this.u.film.value = Math.min(1, this.u.film.value + cm3 / FILM_FULL_CM3)
  }

  /** Steps the particles by dt seconds; 0 holds them still (a paused timeline). */
  update(dt: number) {
    if (!this.step || dt <= 0) return
    this.clock += dt
    const u = this.u
    u.dt.value = Math.min(dt, 0.05)
    u.time.value = this.clock
    const puff = this.queue.shift()
    if (puff) {
      u.at.value.set(puff.x, puff.y, puff.z)
      u.dir.value.set(puff.dx, puff.dy, puff.dz)
      u.start.value = this.head
      u.count.value = puff.count
      u.seed.value = (this.emitted * 7919) % 100003
      u.radius.value = puff.radius
      u.speed.value = puff.speed
      u.spread.value = puff.spread
      u.life.value = puff.life
      this.head = (this.head + puff.count) % DUST_PUFF
      this.emitted += puff.count
    } else {
      u.count.value = 0
    }
    this.studio.renderer.compute(this.step)
  }

  /** A fresh block: the air clears and the floor is swept. */
  reset() {
    this.level = 0
    this.u.haze.value = 0
    this.u.film.value = 0
    this.queue.length = 0
  }

  /** Dust as it would lie after this much stone has come off, without the puffs that put it there. */
  settle(cm3: number) {
    this.reset()
    this.raise(cm3)
  }

  dispose() {
    for (const film of this.films) {
      film.removeFromParent()
      film.geometry.dispose()
      ;(film.material as THREE.Material).dispose()
    }
    if (this.sprites) {
      this.sprites.removeFromParent()
      this.sprites.material.dispose()
    }
    this.step?.dispose()
  }

  // The film: dust lying on the floor round the banker and on the banker's own top, thickest by
  // the block and thinning outward, broken up by noise so it never reads as a disc.
  private buildFilm() {
    const { floorY, bankerY, bankerHalf } = this.options
    const lay = (size: number, y: number, reach: number, strength: number) => {
      const material = new THREE.MeshStandardNodeMaterial({ color: DUST_COLOR, roughness: 1, metalness: 0, transparent: true, depthWrite: false })
      material.name = 'dust-film'
      const p = positionWorld
      const away = p.xz.length()
      const patchy = mx_noise_float(vec3(p.x.mul(0.045), p.z.mul(0.045), 1.7)).mul(0.5).add(0.5)
      const fine = mx_noise_float(vec3(p.x.mul(0.6), p.z.mul(0.6), 4.1)).mul(0.5).add(0.5)
      material.opacityNode = smoothstep(reach, reach * 0.25, away).mul(patchy.mul(0.7).add(0.3)).mul(fine.mul(0.35).add(0.65)).mul(this.u.film).mul(strength)
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material)
      mesh.name = 'dust-film'
      mesh.rotation.x = -Math.PI / 2
      mesh.position.y = y
      mesh.receiveShadow = true
      mesh.renderOrder = 1
      this.studio.stage.add(mesh)
      this.films.push(mesh)
    }
    lay(520, floorY + 0.25, 250, 0.62)
    lay(bankerHalf * 2 - 1, bankerY + 0.12, bankerHalf * 1.6, 0.5)
  }

  private buildParticles() {
    const total = DUST_HAZE + DUST_PUFF
    const u = this.u
    // xyz and age; xyz velocity and lifetime. A puff particle is dead once its age reaches its lifetime.
    const place = instancedArray(total, 'vec4')
    const motion = instancedArray(total, 'vec4')
    const hazeMin = vec3(HAZE_MIN.x, HAZE_MIN.y, HAZE_MIN.z)
    const hazeSize = vec3(HAZE_SIZE.x, HAZE_SIZE.y, HAZE_SIZE.z)
    const floor = float(this.options.floorY + 0.5)

    const init = Fn(() => {
      const p = place.element(instanceIndex)
      const m = motion.element(instanceIndex)
      If(float(instanceIndex).lessThan(DUST_HAZE), () => {
        const r = vec3(hash(instanceIndex), hash(instanceIndex.add(7919)), hash(instanceIndex.add(104729)))
        p.assign(vec4(hazeMin.add(r.mul(hazeSize)), 0))
        m.assign(vec4(0, 0, 0, 1))
      }).Else(() => {
        p.assign(vec4(0, -9999, 0, 1))
        m.assign(vec4(0, 0, 0, 1))
      })
    })().compute(total)

    this.step = Fn(() => {
      const p = place.element(instanceIndex)
      const m = motion.element(instanceIndex)
      const i = float(instanceIndex)
      If(i.lessThan(DUST_HAZE), () => {
        // The room's slow air, and each mote's own wander on top of it.
        const own = hash(instanceIndex)
        const wander = vec3(
          sin(u.time.mul(0.11).add(own.mul(40))),
          sin(u.time.mul(0.07).add(own.mul(91))).mul(0.5),
          cos(u.time.mul(0.09).add(own.mul(63)))
        )
        const moved = p.xyz.add(vec3(1.3, 0.3, -0.7).add(wander.mul(1.8)).mul(u.dt))
        p.assign(vec4(hazeMin.add(moved.sub(hazeMin).div(hazeSize).fract().mul(hazeSize)), 0))
      }).Else(() => {
        const slot = i.sub(DUST_HAZE).sub(u.start).add(DUST_PUFF).mod(DUST_PUFF)
        If(slot.lessThan(u.count), () => {
          const s = i.add(u.seed)
          const r = vec3(hash(s), hash(s.add(13)), hash(s.add(31))).sub(0.5).mul(2)
          const speed = u.speed.mul(hash(s.add(57)).mul(0.8).add(0.2))
          p.assign(vec4(u.at.add(r.mul(u.radius)), 0))
          m.assign(vec4(u.dir.mul(speed).add(r.mul(u.speed).mul(u.spread)), u.life.mul(hash(s.add(91)).mul(0.8).add(0.6))))
        }).ElseIf(p.w.lessThan(m.w), () => {
          // Stone dust is heavy for dust: it is thrown, stalls in the air within a hand's width, then sinks.
          const velocity = m.xyz.mul(exp(u.dt.mul(-2.4))).add(vec3(0.5, -11, -0.3).mul(u.dt)).toVar()
          const moved = p.xyz.add(velocity.mul(u.dt)).toVar()
          moved.y.assign(max(moved.y, floor))
          p.assign(vec4(moved, p.w.add(u.dt)))
          m.assign(vec4(velocity, m.w))
        })
      })
    })().compute(total)

    const material = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false })
    material.name = 'dust'
    const here = place.toAttribute()
    const going = motion.toAttribute()
    const mote = float(instanceIndex).lessThan(DUST_HAZE)
    const own = hash(instanceIndex)
    const age = here.w.div(going.w).clamp(0, 1)
    material.positionNode = here.xyz
    // A puff particle swells as it slows. A mote is a speck: a pixel or three across however far
    // off it is, since a real one is seen by the light it scatters and not by its size.
    const far = here.xyz.sub(cameraPosition).length()
    material.scaleNode = mote.select(far.mul(own.mul(0.0009).add(0.0008)), age.mul(4.5).add(0.9).mul(own.mul(0.6).add(0.7)).mul(here.w.lessThan(going.w).select(1, 0)))
    const soft = smoothstep(0.5, 0.08, uv().sub(0.5).length())
    const rise = smoothstep(0, 0.06, age)
    const puffAlpha = rise.mul(age.oneMinus().pow(1.6)).mul(0.11)
    // Motes come and go on their own slow beat, and there are only as many as the work has raised.
    const twinkle = sin(u.time.mul(own.mul(0.5).add(0.25)).add(own.mul(50))).mul(0.5).add(0.5)
    // A third of them at the most: the haze itself is the post stack's shaft, and these are the
    // few specks in it big enough to catch the eye. More than that reads as snow.
    const pick = hash(instanceIndex.add(977))
    const moteAlpha = twinkle.mul(0.75).add(0.25).mul(smoothstep(0, 0.04, u.haze.mul(0.33).sub(pick).add(0.01))).mul(0.6)
    // Right in front of the lens a speck is a disc as big as a coin; those are left out.
    const near = smoothstep(45, 150, far)
    material.opacityNode = soft.mul(mote.select(moteAlpha.mul(near), puffAlpha.mul(near.mul(0.6).add(0.4))))
    const world = here.xyz
    const sun = this.options.shaft
      ? this.options.shaft(world as unknown as Node)
      : vec3(1, 0.93, 0.82).mul(smoothstep(110, 30, world.xz.length())).mul(4)
    // Dust shows where the sun is on it and is only just there in the shade. Marble dust is white:
    // it takes a little of the sun's warmth and no more.
    const lit = (sun as unknown as ReturnType<typeof vec3>).dot(vec3(0.3, 0.55, 0.15))
    material.colorNode = vec3(0.97, 0.95, 0.9).mul(mote.select(0.012, 0.08).add(lit.mul(mote.select(0.16, 0.085))))
    const sprites = new THREE.Sprite(material)
    sprites.name = 'dust'
    sprites.count = total
    sprites.frustumCulled = false
    sprites.renderOrder = 2
    this.sprites = sprites
    this.studio.stage.add(sprites)
    this.studio.renderer.compute(init)
  }
}
