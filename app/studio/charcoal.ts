/**
 * The sculptor's charcoal: the lines a `sketch` pass draws on the block, as dark dabs along the
 * surface points the kernel recorded. Theatre only; the kernel never reads them. A dab goes with
 * the stone it was drawn on: every cut rubs out the dabs within its bite and a saw cut takes the
 * ones on the side that comes away. What is left is wiped when the next cutting pass begins.
 */
import * as THREE from 'three/webgpu'
import type { SketchStrike, Vec3 } from '#shared/sculpt/types'
import { VIEWS } from '#shared/sculpt/views'
import type { StudioRenderer } from './renderer'

const DAB_CM = 0.32
// Dabs per centimetre of line, and how far they stand off the surface toward the viewpoint they were drawn from.
const DENSITY = 2.5
const LIFT_CM = 0.12
const MAX_DABS = 6000
// How far beyond half a tool's width a cut rubs the charcoal out, cm.
const RUB_CM = 0.5

/** A cut or a saw cut as the timeline reports it: where, which way, and how wide the tool was. */
export interface Rub {
  kind: 'cut' | 'saw'
  at: Vec3
  dir: Vec3
  size: number
}

export class Charcoal {
  private mesh: THREE.InstancedMesh
  private count = 0
  private dab = new THREE.Matrix4()
  // Where each dab is, xyz, in the order the instances are in.
  private at = new Float32Array(MAX_DABS * 3)

  constructor(private studio: StudioRenderer) {
    const material = new THREE.MeshBasicNodeMaterial({ color: 0x23201d })
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(DAB_CM, 6, 4), material, MAX_DABS)
    this.mesh.name = 'charcoal'
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    studio.stage.add(this.mesh)
  }

  draw(strike: SketchStrike) {
    const look = VIEWS[strike.view].look
    const put = (x: number, y: number, z: number) => {
      if (this.count >= MAX_DABS) return
      this.at.set([x, y, z], this.count * 3)
      this.dab.makeTranslation(x - look[0] * LIFT_CM, y - look[1] * LIFT_CM, z - look[2] * LIFT_CM)
      this.mesh.setMatrixAt(this.count++, this.dab)
    }
    for (const stroke of strike.strokes) {
      for (let i = 0; i < stroke.length; i++) {
        const a = stroke[i]!
        put(a[0], a[1], a[2])
        const b = stroke[i + 1]
        if (!b) continue
        const steps = Math.min(8, Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * DENSITY))
        for (let k = 1; k < steps; k++) {
          const t = k / steps
          put(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)
        }
      }
    }
    this.mesh.count = this.count
    this.mesh.instanceMatrix.needsUpdate = true
  }

  /** Rubs out the dabs on stone these strikes have just taken: inside a cut's bite, or on the side of a saw's plane that came off. */
  erase(strikes: readonly Rub[]) {
    if (this.count === 0) return
    const at = this.at
    const before = this.count
    for (const strike of strikes) {
      const [ax, ay, az] = strike.at
      const [dx, dy, dz] = strike.dir
      const reach = strike.size / 2 + RUB_CM
      for (let i = this.count - 1; i >= 0; i--) {
        const x = at[i * 3]! - ax
        const y = at[i * 3 + 1]! - ay
        const z = at[i * 3 + 2]! - az
        const gone = strike.kind === 'saw' ? x * dx + y * dy + z * dz > -RUB_CM : x * x + y * y + z * z < reach * reach
        if (!gone) continue
        // The last dab takes the place of the one rubbed out.
        const last = --this.count
        if (i === last) continue
        at.copyWithin(i * 3, last * 3, last * 3 + 3)
        this.mesh.getMatrixAt(last, this.dab)
        this.mesh.setMatrixAt(i, this.dab)
      }
    }
    if (this.count === before) return
    this.mesh.count = this.count
    this.mesh.instanceMatrix.needsUpdate = true
  }

  clear() {
    this.count = 0
    this.mesh.count = 0
  }

  dispose() {
    this.studio.stage.remove(this.mesh)
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}
