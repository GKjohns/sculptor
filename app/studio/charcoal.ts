/**
 * The sculptor's charcoal: the lines a `sketch` pass draws on the block, as dark dabs along the
 * surface points the kernel recorded. Theatre only; the kernel never reads them. They are wiped
 * when carving starts again, since the stone they were drawn on is about to come off.
 */
import * as THREE from 'three/webgpu'
import type { SketchStrike } from '#shared/sculpt/types'
import { VIEWS } from '#shared/sculpt/views'
import type { StudioRenderer } from './renderer'

const DAB_CM = 0.32
// Dabs per centimetre of line, and how far they stand off the surface toward the viewpoint they were drawn from.
const DENSITY = 2.5
const LIFT_CM = 0.12
const MAX_DABS = 6000

export class Charcoal {
  private mesh: THREE.InstancedMesh
  private count = 0
  private dab = new THREE.Matrix4()

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
