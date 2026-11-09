/**
 * The sculptor's tools, which float and work with no hands: a chisel and a mallet, a saw, a rasp,
 * a drill and a polishing pad. Built here from a few primitives (steel that has seen use, turned
 * beech), laid out along the banker's edge when nobody is holding them, and animated from what
 * the timeline says is happening:
 *
 *   chisel + mallet  the chisel sets on the contact point along the strike direction; the mallet
 *                    swings and lands on the strike's beat (the timeline says which strike is
 *                    coming and when); the chisel kicks back. Point, claw, flat and roundel are
 *                    one chisel with four ends.
 *   saw              rides its cut plane from the edge of the block through to the far side as
 *                    the saw cut's own time runs, stroking as it goes.
 *   rasp             lies on the surface and strokes along the line its strikes are following.
 *   drill, pad       turn on the spot.
 *
 * A change of tool is a put-down and a pick-up: the old one goes back to its place on the banker
 * before the new one leaves its own. When the sculptor stops to look, everything is put down.
 *
 * When blows come faster than a mallet can be seen to swing (a fast replay), the mallet stops
 * following individual strikes and keeps a steady rhythm of its own while the chisel glides
 * along the work. Motion stays continuous; nothing strobes.
 *
 * Time comes in through update(dt) only.
 */
import * as THREE from 'three/webgpu'
import { float, mix, mx_noise_float, positionLocal, smoothstep, vec3 } from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { ToolId, Vec3 } from '#shared/sculpt/types'
import type { StudioRenderer } from './renderer'
import type { StrikeEvent, UpcomingStrike } from './timeline'

type Actor = 'chisel' | 'saw' | 'rasp' | 'drill' | 'pad'
type ChiselEnd = 'point' | 'claw' | 'flat' | 'roundel'

export interface ToolsOptions {
  /** The banker's top (the tools lie on it) and half its side, cm. */
  bankerY?: number
  bankerHalf?: number
  /** The block, cm: width, height, depth. The saw needs to know how far it has to travel. */
  block?: Vec3
}

const ACTOR: Record<ToolId, Actor> = { point: 'chisel', claw: 'chisel', flat: 'chisel', roundel: 'chisel', saw: 'saw', rasp: 'rasp', drill: 'drill', polish: 'pad' }
const CHISEL_LENGTH = 22
// Where the mallet is held, down its handle from the middle of the head: the radius of its swing.
const GRIP_CM = 12.5
// Above this many blows a second the mallet keeps its own beat; it goes back to following
// strikes below the lower figure.
const RHYTHM_ABOVE = 5.5
const RHYTHM_BELOW = 4.2
const RHYTHM_HZ = 4.6
// The share of a swing spent coming down, and how long the downswing takes when it follows a strike, s.
const RAISED = 0.62
const DOWN_S = 0.13
// After this long without a blow the tool backs off the stone; after this long it is put down.
const PAUSE_S = 0.9
const REST_S = 5
const STANDOFF_CM = 9
// How long a pick-up or a put-down takes to mostly happen, s.
const CARRY_S = 0.2

const Y = new THREE.Vector3(0, 1, 0)

function steel(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0x9a9da3, metalness: 0.9, roughness: 0.4 })
  material.name = 'tool-steel'
  // Worn bright in streaks along its length, dull and a little brown between.
  const p = positionLocal as unknown as ReturnType<typeof vec3>
  const wear = mx_noise_float(vec3(p.x.mul(2.2), p.y.mul(0.35), p.z.mul(2.2))).mul(0.5).add(0.5)
  const pits = mx_noise_float(p.mul(5.5)).mul(0.5).add(0.5)
  material.colorNode = mix(vec3(0.26, 0.24, 0.22), vec3(0.66, 0.67, 0.7), smoothstep(0.25, 0.8, wear)).mul(pits.mul(0.25).add(0.8))
  material.roughnessNode = mix(float(0.62), float(0.3), smoothstep(0.3, 0.8, wear))
  return material
}

function wood(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0x9a6a3c, metalness: 0, roughness: 0.62 })
  material.name = 'tool-wood'
  // Grain running the long way, and the paler bruising of a face that gets hit.
  const p = positionLocal as unknown as ReturnType<typeof vec3>
  const grain = mx_noise_float(vec3(p.x.mul(3.5), p.y.mul(0.22), p.z.mul(3.5))).mul(0.5).add(0.5)
  const fine = mx_noise_float(vec3(p.x.mul(14), p.y.mul(0.8), p.z.mul(14))).mul(0.5).add(0.5)
  material.colorNode = mix(vec3(0.3, 0.17, 0.08), vec3(0.6, 0.4, 0.2), grain).mul(fine.mul(0.3).add(0.78))
  material.roughnessNode = grain.mul(0.2).add(0.5)
  return material
}

function felt(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xd9d2c0, metalness: 0, roughness: 1 })
  material.name = 'tool-felt'
  return material
}

const at = (g: THREE.BufferGeometry, x: number, y: number, z: number) => g.translate(x, y, z)

// Pinches one end of a box to an edge: a chisel's bevel.
function wedge(width: number, height: number, thick: number, edge: number) {
  const g = new THREE.BoxGeometry(width, height, thick, 1, 1, 1)
  const p = g.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < p.count; i++) if (p.getY(i) < 0) p.setZ(i, p.getZ(i) * edge)
  g.computeVertexNormals()
  return at(g, 0, height / 2, 0)
}

function chiselEnd(kind: ChiselEnd): THREE.BufferGeometry {
  // Each end runs from the working edge at y = 0 up to the shaft at y = 3.2.
  if (kind === 'point') return at(new THREE.CylinderGeometry(0.85, 0.07, 3.2, 8), 0, 1.6, 0)
  if (kind === 'flat') return wedge(2.3, 3.2, 1.3, 0.06)
  if (kind === 'roundel') {
    const neck = at(new THREE.CylinderGeometry(0.85, 0.55, 2.7, 8), 0, 1.85, 0)
    const nose = new THREE.SphereGeometry(0.55, 10, 6)
    nose.scale(1, 1, 0.55)
    return mergeGeometries([neck, at(nose, 0, 0.55, 0)])!
  }
  // The claw: a wide bevel that ends in a row of teeth.
  const parts = [at(wedge(3.3, 2.6, 1.3, 0.12), 0, 0.6, 0)]
  for (let i = 0; i < 6; i++) parts.push(at(new THREE.CylinderGeometry(0.24, 0.03, 0.7, 4), -1.4 + i * 0.56, 0.35, 0))
  return mergeGeometries(parts)!
}

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material) {
  const m = new THREE.Mesh(geometry, material)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

export class Tools {
  /** A blow heavy enough to feel through the camera: 0 to 1. */
  onKnock: (strength: number) => void = () => {}
  /** Dust raised by a tool that works continuously (the saw in its cut): where, which way, how much. */
  onDust: (x: number, y: number, z: number, dx: number, dy: number, dz: number, amount: number) => void = () => {}

  private root = new THREE.Group()
  private actors: Record<Actor, THREE.Group>
  private mallet: THREE.Group
  private ends: Record<ChiselEnd, THREE.Mesh>
  private restAt: Record<Actor | 'mallet', { position: THREE.Vector3, quaternion: THREE.Quaternion }>
  private presence: Record<Actor, number> = { chisel: 0, saw: 0, rasp: 0, drill: 0, pad: 0 }
  private malletPresence = 0
  private materials: THREE.Material[]
  private block: Vec3

  private active: Actor | null = null
  private end: ChiselEnd = 'point'
  private wantedEnd: ChiselEnd = 'point'
  private tip = new THREE.Vector3(0, 60, 30)
  private tipGoal = new THREE.Vector3(0, 60, 30)
  private axis = new THREE.Vector3(0, 0, 1)
  private axisGoal = new THREE.Vector3(0, 0, 1)
  private travel = new THREE.Vector3(1, 0, 0)
  private hasTip = false
  private sinceBlow = 99
  private blows = 0
  private pendingBlows = 0
  private rhythm = false
  private phase = RAISED
  private kick = 0
  private strength = 0.5
  private standoff = STANDOFF_CM
  private stroke = 0
  private spin = 0
  private looking = false
  private next: UpcomingStrike | null = null
  private rate = 1
  private sawDust = 0
  private sawing = false

  private sawPosition = new THREE.Vector3(0, 100, 0)
  private sawQuaternion = new THREE.Quaternion()

  private a = new THREE.Vector3()
  private b = new THREE.Vector3()
  private c = new THREE.Vector3()
  private q = new THREE.Quaternion()
  private q2 = new THREE.Quaternion()
  private basis = new THREE.Matrix4()

  constructor(private studio: StudioRenderer, options: ToolsOptions = {}) {
    const bankerY = options.bankerY ?? 0
    const half = options.bankerHalf ?? 47
    this.block = options.block ?? [60, 100, 60]
    const metal = steel()
    const timber = wood()
    const cloth = felt()
    this.materials = [metal, timber, cloth]
    this.root.name = 'tools'

    // Chisel: tip at the origin, +Y back along the shaft to the struck end.
    const chisel = new THREE.Group()
    chisel.add(mesh(mergeGeometries([
      at(new THREE.CylinderGeometry(0.85, 0.85, 16.4, 8), 0, 3.2 + 8.2, 0),
      // The struck end, burred over by the mallet.
      at(new THREE.CylinderGeometry(1.12, 0.86, 1.3, 8), 0, 20.2, 0),
      at(new THREE.CylinderGeometry(0.95, 1.12, 1.1, 8), 0, 21.4, 0)
    ])!, metal))
    this.ends = { point: mesh(chiselEnd('point'), metal), claw: mesh(chiselEnd('claw'), metal), flat: mesh(chiselEnd('flat'), metal), roundel: mesh(chiselEnd('roundel'), metal) }
    for (const [kind, end] of Object.entries(this.ends)) {
      end.visible = kind === this.end
      chisel.add(end)
    }

    // Mallet: a carver's round mallet. The middle of the head is the origin, the handle hangs down -Y.
    const profile = [[0, 5.6], [3.6, 5.6], [4.5, 4.4], [4.75, 0], [4.3, -4.6], [3.4, -5.6], [1.5, -5.9], [1.35, -9], [1.55, -14], [1.45, -18.4], [0, -18.8]]
    this.mallet = new THREE.Group()
    this.mallet.add(mesh(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 20), timber))

    // Saw: a two-handed stone saw, a long blade with an upright grip at each end and nothing
    // across its back, so it can sink as deep as the block is. The middle of the toothed edge is
    // the origin; the blade runs along X, cuts toward -Y, and is thin in Z.
    const saw = new THREE.Group()
    const blade = new THREE.BoxGeometry(96, 10, 0.24, 48, 1, 1)
    const teeth = blade.getAttribute('position') as THREE.BufferAttribute
    // Teeth: every other vertex along the cutting edge is pulled back.
    for (let i = 0; i < teeth.count; i++) if (teeth.getY(i) < 0 && Math.round((teeth.getX(i) + 48) / 2) % 2 === 1) teeth.setY(i, teeth.getY(i) + 0.9)
    blade.computeVertexNormals()
    saw.add(mesh(at(blade, 0, 5, 0), metal))
    saw.add(mesh(mergeGeometries([
      at(new THREE.BoxGeometry(3.2, 13, 2.6), -47, 8, 0),
      at(new THREE.BoxGeometry(3.2, 13, 2.6), 47, 8, 0),
      at(new THREE.CylinderGeometry(1.6, 1.6, 15, 10), -47, 21, 0),
      at(new THREE.CylinderGeometry(1.6, 1.6, 15, 10), 47, 21, 0)
    ])!, timber))

    // Rasp: the middle of its working face is the origin; it runs along X and bears down -Y.
    const rasp = new THREE.Group()
    const bar = new THREE.BoxGeometry(24, 0.8, 2.8, 12, 1, 2)
    const bp = bar.getAttribute('position') as THREE.BufferAttribute
    // Tapered toward the nose.
    for (let i = 0; i < bp.count; i++) if (bp.getX(i) > 0) bp.setZ(i, bp.getZ(i) * (1 - bp.getX(i) / 12 * 0.45))
    bar.computeVertexNormals()
    rasp.add(mesh(mergeGeometries([at(bar, 0, 0.4, 0), at(new THREE.CylinderGeometry(0.4, 0.4, 4, 6).rotateZ(Math.PI / 2), -14, 0.4, 0)])!, metal))
    rasp.add(mesh(at(new THREE.CapsuleGeometry(1.5, 8, 4, 10).rotateZ(Math.PI / 2), -21, 0.5, 0), timber))

    // Drill: bit tip at the origin, +Y up the bit to a palm handle.
    const drill = new THREE.Group()
    drill.add(mesh(mergeGeometries([
      at(new THREE.CylinderGeometry(0.62, 0.04, 1.6, 8), 0, 0.8, 0),
      at(new THREE.CylinderGeometry(0.62, 0.62, 14, 8), 0, 8.6, 0),
      at(new THREE.CylinderGeometry(1.3, 0.9, 2.2, 10), 0, 16.7, 0)
    ])!, metal))
    drill.add(mesh(mergeGeometries([
      at(new THREE.CylinderGeometry(1.1, 1.3, 5, 10), 0, 20.3, 0),
      at(new THREE.SphereGeometry(2.7, 14, 10).scale(1, 0.75, 1), 0, 24, 0)
    ])!, timber))

    // Pad: its face is at the origin looking -Y.
    const pad = new THREE.Group()
    pad.add(mesh(at(new THREE.CylinderGeometry(4.6, 4.7, 0.9, 24), 0, 0.45, 0), cloth))
    pad.add(mesh(mergeGeometries([
      at(new THREE.CylinderGeometry(4.3, 4.5, 2, 24), 0, 1.9, 0),
      at(new THREE.SphereGeometry(2.2, 14, 8).scale(1, 0.7, 1), 0, 4, 0)
    ])!, timber))

    this.actors = { chisel, saw, rasp, drill, pad }

    // Where each lies when put down: in a row along the right-hand edge of the banker, the saw
    // hung on that side below them.
    const lie = (x: number, y: number, z: number, rx: number, ry: number, rz: number) => ({
      position: new THREE.Vector3(x, bankerY + y, z),
      quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'))
    })
    const edge = half - 6
    this.restAt = {
      chisel: lie(edge - 1, 0.9, 20, Math.PI / 2, 0.12, 0),
      mallet: lie(edge - 2.5, 4.75, -1, Math.PI / 2, -0.3, 0),
      rasp: lie(edge + 1.5, 0.05, -24, 0, Math.PI / 2 + 0.08, 0),
      drill: lie(edge - 6, 1.3, 30, Math.PI / 2, 0.5, 0),
      pad: lie(edge - 7, 0, -36, 0, 0.4, 0),
      saw: lie(half + 1.8, -31, 0, -0.08, Math.PI / 2, 0)
    }
    for (const [name, group] of Object.entries(this.actors) as [Actor, THREE.Group][]) {
      group.name = name
      group.position.copy(this.restAt[name].position)
      group.quaternion.copy(this.restAt[name].quaternion)
      this.root.add(group)
    }
    this.mallet.name = 'mallet'
    this.mallet.position.copy(this.restAt.mallet.position)
    this.mallet.quaternion.copy(this.restAt.mallet.quaternion)
    this.root.add(this.mallet)
    studio.stage.add(this.root)
  }

  /** Which tool is at work, for tests. */
  state() {
    return { active: this.active, end: this.end, rhythm: this.rhythm, blowsPerS: Math.round(this.blows * 10) / 10, presence: { ...this.presence } }
  }

  // ---------- what it is told ----------

  strikes(events: StrikeEvent[], rate: number) {
    this.rate = rate
    for (const event of events) {
      if (event.kind === 'saw') {
        this.sawing = false
        continue
      }
      const actor = ACTOR[event.tool] ?? 'chisel'
      this.use(actor, event.tool)
      const [x, y, z] = event.at
      if (this.hasTip) this.c.set(x, y, z).sub(this.tipGoal)
      this.tipGoal.set(x, y, z)
      // Which way the work is moving across the surface: the rasp lies along it.
      if (this.hasTip && this.c.lengthSq() > 0.04 && this.c.lengthSq() < 400) this.travel.lerp(this.c.normalize(), 0.5).normalize()
      this.axisGoal.set(-event.dir[0], -event.dir[1], -event.dir[2]).normalize()
      if (!this.hasTip) {
        this.tip.copy(this.tipGoal)
        this.axis.copy(this.axisGoal)
        this.hasTip = true
      }
      this.strength = Math.max(0.15, Math.min(1, (event.size * 0.06 + event.depth * 0.16)))
      this.pendingBlows++
      this.sinceBlow = 0
      // A blow that was not seen coming (hand carving, a batch of several): the mallet is simply there.
      if (actor === 'chisel' && !this.rhythm) this.land()
    }
  }

  /** The strike the clock is on its way to, every frame; null when nothing is due. */
  upcoming(next: UpcomingStrike | null) {
    this.next = next
    if (next?.strike.kind === 'saw') {
      this.sawing = true
      this.use('saw', 'saw')
    }
  }

  /** The sculptor has stepped back (true) or come back to the stone. */
  look(on: boolean) {
    this.looking = on
  }

  /** A fresh block: everything back on the banker. */
  reset() {
    this.active = null
    this.hasTip = false
    this.sinceBlow = 99
    this.blows = this.pendingBlows = 0
    this.rhythm = false
    this.sawing = false
    this.next = null
  }

  // ---------- every frame ----------

  update(dt: number) {
    if (dt <= 0) return
    dt = Math.min(dt, 0.05)
    this.sinceBlow += dt
    this.blows += (this.pendingBlows / dt - this.blows) * (1 - Math.exp(-dt / 0.7))
    this.pendingBlows = 0
    if (this.blows > RHYTHM_ABOVE) this.rhythm = true
    else if (this.blows < RHYTHM_BELOW) this.rhythm = false

    // The contact point and the tool's line glide after the strikes; faster when the hand is slow enough to follow.
    const glide = 1 - Math.exp(-dt / (this.rhythm ? 0.16 : 0.07))
    this.tip.lerp(this.tipGoal, glide)
    this.axis.lerp(this.axisGoal, glide)
    if (this.axis.lengthSq() < 1e-4) this.axis.copy(this.axisGoal)
    this.axis.normalize()

    const idle = this.sawing ? 0 : this.sinceBlow
    const down = this.looking || idle > REST_S || !this.active
    const backOff = idle > PAUSE_S ? STANDOFF_CM : 0
    this.standoff += (backOff - this.standoff) * (1 - Math.exp(-dt / 0.25))
    // One tool in the air at a time: the new one waits for the old to be nearly down.
    const quick = this.rate > 12 ? 0.4 : 1
    let othersUp = 0
    for (const name of Object.keys(this.presence) as Actor[]) if (name !== this.active) othersUp = Math.max(othersUp, this.presence[name])
    // A different end on the chisel is a put-down and a pick-up as well.
    const swapping = this.end !== this.wantedEnd
    for (const name of Object.keys(this.presence) as Actor[]) {
      const goal = name === this.active && !down && othersUp < 0.35 && !(name === 'chisel' && swapping) ? 1 : 0
      this.presence[name] += (goal - this.presence[name]) * (1 - Math.exp(-dt / (CARRY_S * quick)))
      if (Math.abs(goal - this.presence[name]) < 0.002) this.presence[name] = goal
    }
    // The chisel's end is changed while it is away from the stone.
    if (this.end !== this.wantedEnd && this.presence.chisel < 0.45) {
      this.ends[this.end].visible = false
      this.end = this.wantedEnd
      this.ends[this.end].visible = true
    }
    const malletGoal = this.active === 'chisel' && this.end === this.wantedEnd ? this.presence.chisel : 0
    this.malletPresence += (malletGoal - this.malletPresence) * (1 - Math.exp(-dt / (CARRY_S * quick)))

    this.swing(dt)
    this.kick *= Math.exp(-dt / 0.06)
    this.stroke += dt
    this.spin += dt

    this.poseChisel()
    this.poseSaw(dt)
    this.poseRasp()
    this.poseTurning()
  }

  dispose() {
    this.root.removeFromParent()
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose()
    })
    for (const material of this.materials) material.dispose()
  }

  // ---------- inside ----------

  private use(actor: Actor, tool: ToolId) {
    this.active = actor
    if (actor === 'chisel') {
      const end = tool as ChiselEnd
      this.wantedEnd = end
    }
  }

  // The mallet's head meets the chisel.
  private land() {
    this.phase = 0
    this.kick = 1
    if (this.strength > 0.45 && this.presence.chisel > 0.6) this.onKnock(this.strength)
  }

  // The mallet's swing as a phase: 0 on the chisel, RAISED at the top, 1 on the chisel again.
  private swing(dt: number) {
    if (this.active !== 'chisel') {
      this.phase += (RAISED - this.phase) * (1 - Math.exp(-dt / 0.2))
      return
    }
    if (this.rhythm) {
      // Its own beat. Each time round is a blow, whichever strike it stands for.
      this.phase += RHYTHM_HZ * dt
      if (this.phase >= 1) {
        this.phase -= 1
        this.kick = 1
        if (this.strength > 0.45 && this.presence.chisel > 0.6) this.onKnock(this.strength * 0.7)
      }
      return
    }
    const next = this.next
    const coming = next && next.strike.kind === 'cut' && ACTOR[next.strike.tool] === 'chisel' ? next.inS : Infinity
    if (coming <= DOWN_S && this.phase >= RAISED - 0.08) {
      // Coming down to land as the strike does.
      this.phase = Math.max(this.phase, Math.min(0.995, 1 - (1 - RAISED) * coming / DOWN_S))
    } else if (this.phase < RAISED) {
      // Back up off the last blow.
      this.phase = Math.min(RAISED, this.phase + dt * 3.4)
    } else if (this.phase > RAISED && coming > DOWN_S) {
      this.phase += (RAISED - this.phase) * (1 - Math.exp(-dt / 0.12))
    }
  }

  // Sets a group between its place on the banker (presence 0) and a pose at the stone (1), lifted through an arc.
  private carry(group: THREE.Group, rest: { position: THREE.Vector3, quaternion: THREE.Quaternion }, presence: number, position: THREE.Vector3, quaternion: THREE.Quaternion) {
    const p = presence * presence * (3 - 2 * presence)
    group.position.lerpVectors(rest.position, position, p)
    group.position.y += Math.sin(Math.PI * p) * 14
    group.quaternion.slerpQuaternions(rest.quaternion, quaternion, p)
  }

  private poseChisel() {
    const p = this.presence.chisel
    if (p <= 0 && this.malletPresence <= 0.001) {
      this.carry(this.actors.chisel, this.restAt.chisel, 0, this.tip, this.q)
      this.carry(this.mallet, this.restAt.mallet, 0, this.tip, this.q)
      return
    }
    // The chisel: tip on the contact point, shaft back along the blow, kicked back by each one.
    const back = this.standoff + this.kick * 0.45 * this.strength
    this.a.copy(this.tip).addScaledVector(this.axis, back)
    this.q.setFromUnitVectors(Y, this.axis)
    this.carry(this.actors.chisel, this.restAt.chisel, p, this.a, this.q)

    // The mallet: held by its handle below and to one side of the chisel's line, swung about the
    // end of the handle so its face meets the struck end at phase 0.
    const side = this.b.crossVectors(this.axis, Y)
    if (side.lengthSq() < 0.01) side.set(1, 0, 0)
    side.normalize()
    const under = this.c.crossVectors(side, this.axis).normalize()
    // The handle's line at the moment of the blow, out from the head.
    const handle = this.a.copy(under).multiplyScalar(-0.75).addScaledVector(side, 0.66).normalize()
    const turn = this.b.crossVectors(handle, this.axis).normalize()
    const up = this.phase <= RAISED ? 1 - (1 - this.phase / RAISED) ** 3 : 1 - ((this.phase - RAISED) / (1 - RAISED)) ** 2
    const angle = up * (0.5 + this.strength * 0.4)
    const butt = this.c.copy(this.tip).addScaledVector(this.axis, back + CHISEL_LENGTH)
    // Head centre at the blow: a head's radius behind the struck end. The grip is GRIP_CM down the handle.
    const grip = butt.clone().addScaledVector(this.axis, 4.7).addScaledVector(handle, GRIP_CM)
    // Turning about handle × axis carries the head into the stone, so the swing back is the other way.
    this.q2.setFromAxisAngle(turn, -angle)
    const head = handle.clone().multiplyScalar(-GRIP_CM).applyQuaternion(this.q2).add(grip)
    // Local -Y is the handle; local +X is turned to the swing's axis so the head's side meets the chisel.
    const handleNow = handle.clone().applyQuaternion(this.q2)
    this.basis.makeBasis(turn, handleNow.clone().negate(), this.a.crossVectors(turn, handleNow.clone().negate()).normalize())
    this.q.setFromRotationMatrix(this.basis)
    this.carry(this.mallet, this.restAt.mallet, this.malletPresence, head, this.q)
  }

  private poseSaw(dt: number) {
    const p = this.presence.saw
    const next = this.next
    if (next?.strike.kind === 'saw') {
      const { point, normal } = next.strike.plane
      const n = this.a.set(normal[0], normal[1], normal[2]).normalize()
      // Feed: down through an upright cut, front to back through a level one.
      const feed = Math.abs(n.y) < 0.75 ? this.b.set(0, -1, 0) : this.b.set(0, 0, -1)
      feed.addScaledVector(n, -feed.dot(n)).normalize()
      const along = this.c.crossVectors(n, feed).normalize()
      // How far the block reaches along the feed and along the blade, from the plane's own point.
      const [w, h, d] = this.block
      let f0 = Infinity
      let f1 = -Infinity
      let s0 = Infinity
      let s1 = -Infinity
      for (let i = 0; i < 8; i++) {
        const x = (i & 1 ? w / 2 : -w / 2) - point[0]
        const y = (i & 2 ? h : 0) - point[1]
        const z = (i & 4 ? d / 2 : -d / 2) - point[2]
        const f = x * feed.x + y * feed.y + z * feed.z
        const s = x * along.x + y * along.y + z * along.z
        f0 = Math.min(f0, f)
        f1 = Math.max(f1, f)
        s0 = Math.min(s0, s)
        s1 = Math.max(s1, s)
      }
      const edge = f0 - 2 + (f1 - f0 + 3) * next.progress
      const sweep = Math.sin(this.stroke * Math.PI * 2 * 1.5) * 11
      this.sawPosition.set(point[0], point[1], point[2]).addScaledVector(feed, edge).addScaledVector(along, (s0 + s1) / 2 + sweep)
      this.basis.makeBasis(along, feed.clone().negate(), n)
      this.sawQuaternion.setFromRotationMatrix(this.basis)
      // Dust out of the kerf, a few times a second.
      this.sawDust -= dt
      if (this.sawDust <= 0 && p > 0.8) {
        this.sawDust = 0.09
        const where = (Math.sin(this.stroke * 53) * 0.5) * (s1 - s0)
        this.onDust(point[0] + feed.x * edge + along.x * ((s0 + s1) / 2 + where), point[1] + feed.y * edge + along.y * ((s0 + s1) / 2 + where), point[2] + feed.z * edge + along.z * ((s0 + s1) / 2 + where), n.x * 0.4, n.y * 0.4 - 0.4, n.z * 0.4, 0.8)
      }
    }
    this.carry(this.actors.saw, this.restAt.saw, p, this.sawPosition, this.sawQuaternion)
  }

  private poseRasp() {
    const p = this.presence.rasp
    // Flat on the surface, lying along the way the work is going, stroking back and forth.
    const along = this.a.copy(this.travel).addScaledVector(this.axis, -this.travel.dot(this.axis))
    if (along.lengthSq() < 0.01) along.crossVectors(this.axis, Y)
    if (along.lengthSq() < 0.01) along.set(1, 0, 0)
    along.normalize()
    const across = this.b.crossVectors(along, this.axis).normalize()
    this.basis.makeBasis(along, this.axis, across)
    this.q.setFromRotationMatrix(this.basis)
    const reach = Math.sin(this.stroke * Math.PI * 2 * 2.1) * 4.5
    this.c.copy(this.tip).addScaledVector(this.axis, this.standoff * 0.6).addScaledVector(along, reach)
    this.carry(this.actors.rasp, this.restAt.rasp, p, this.c, this.q)
  }

  private poseTurning() {
    // The drill turns on its own line; the pad turns in small circles on the surface.
    this.q.setFromUnitVectors(Y, this.axis)
    this.q2.setFromAxisAngle(Y, this.spin * 26)
    this.a.copy(this.tip).addScaledVector(this.axis, this.standoff * 0.6 + Math.sin(this.stroke * 9) * 0.25)
    this.carry(this.actors.drill, this.restAt.drill, this.presence.drill, this.a, this.q.clone().multiply(this.q2))

    const u = this.b.crossVectors(this.axis, Y)
    if (u.lengthSq() < 0.01) u.set(1, 0, 0)
    u.normalize()
    const v = this.c.crossVectors(this.axis, u)
    const t = this.stroke * Math.PI * 2 * 1.3
    this.a.copy(this.tip).addScaledVector(this.axis, this.standoff * 0.5).addScaledVector(u, Math.cos(t) * 2.2).addScaledVector(v, Math.sin(t) * 2.2)
    this.q2.setFromAxisAngle(Y, this.spin * 1.5)
    this.carry(this.actors.pad, this.restAt.pad, this.presence.pad, this.a, this.q.clone().multiply(this.q2))
  }
}
