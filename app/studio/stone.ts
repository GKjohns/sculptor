/**
 * The stone on screen: one mesh per chunk under the studio's stage, refilled in place from the kernel
 * worker's chunk messages, plus the pieces that fall away when a saw or an island check takes them off.
 *
 * Sprint 1 look only: plain off-white stone whose roughness follows the per-vertex finish the tools
 * left. Veining, subsurface light, debris physics and sound are Sprint 4.
 */
import * as THREE from 'three/webgpu'
import { attribute, float, mix } from 'three/tsl'
import { chunkBounds } from '#shared/sculpt/grid'
import type { ChunkMesh, GridInfo, Offcut } from '#shared/sculpt/types'
import type { StudioRenderer } from './renderer'

const MARBLE = 0xe9e4da
// Roughness at finish 0 (straight off the point chisel) and at finish 255 (polished).
const ROUGH = 0.96
const POLISHED = 0.14
const GRAVITY = 981 // cm/s²

interface Falling {
  mesh: THREE.Mesh
  velocity: THREE.Vector3
  spin: THREE.Vector3
  age: number
}

function dynamic<T extends THREE.TypedArray>(array: T, itemSize: number) {
  const attr = new THREE.BufferAttribute(array, itemSize)
  attr.setUsage(THREE.DynamicDrawUsage)
  return attr
}

function refill(attr: THREE.BufferAttribute, count: number) {
  attr.clearUpdateRanges()
  attr.addUpdateRange(0, count)
  attr.needsUpdate = true
}

export class Stone {
  readonly material: THREE.MeshPhysicalNodeMaterial
  /** The rev of the worker's stone that the chunk geometry now matches; -1 until the first mesh lands. */
  shownRev = -1

  private offcutMaterial = new THREE.MeshPhysicalNodeMaterial({ color: MARBLE, roughness: 0.6 })
  private meshes = new Map<number, THREE.Mesh>()
  private incoming = new Map<number, ChunkMesh>()
  private arrivedRev = -1
  private fresh = false
  private loose: { rev: number, offcut: Offcut }[] = []
  private falling: Falling[] = []
  private waiters: { rev: number, done: () => void }[] = []
  private stop: () => void

  constructor(private studio: StudioRenderer, readonly grid: GridInfo) {
    this.material = new THREE.MeshPhysicalNodeMaterial({ color: MARBLE })
    this.material.roughnessNode = mix(float(ROUGH), float(POLISHED), attribute('finish', 'float'))
    this.stop = studio.onFrame(dt => this.frame(dt))
  }

  /** The chunk meshes, for picking. */
  get chunks(): THREE.Mesh[] {
    return [...this.meshes.values()]
  }

  /** Offcuts still on their way out of frame. */
  get airborne() {
    return this.falling.length + this.loose.length
  }

  /** Takes a remesh from the worker. A newer mesh of a chunk replaces one not drawn yet. */
  receive(rev: number, chunks: ChunkMesh[]) {
    for (const chunk of chunks) this.incoming.set(chunk.chunk, chunk)
    this.arrivedRev = rev
    this.fresh = true
  }

  /** Takes pieces that came off. They appear with the chunks that show the cut. */
  shed(rev: number, offcuts: Offcut[]) {
    for (const offcut of offcuts) this.loose.push({ rev, offcut })
  }

  /** Resolves once the geometry matches the worker's stone at `rev` or later. Drawn one frame after. */
  whenShown(rev: number) {
    if (this.shownRev >= rev) return Promise.resolve()
    return new Promise<void>(done => this.waiters.push({ rev, done }))
  }

  dispose() {
    this.stop()
    for (const mesh of this.meshes.values()) this.drop(mesh)
    for (const piece of this.falling) this.drop(piece.mesh)
    this.meshes.clear()
    this.falling = []
    this.material.dispose()
    this.offcutMaterial.dispose()
  }

  private frame(dt: number) {
    // Everything that arrived since the last frame goes in together: each worker message is a
    // seamless set, so a frame never shows one side of a seam ahead of the other.
    if (this.fresh) {
      this.fresh = false
      for (const chunk of this.incoming.values()) this.fill(chunk)
      this.incoming.clear()
      this.shownRev = this.arrivedRev
      if (this.waiters.length) {
        this.waiters = this.waiters.filter((w) => {
          if (w.rev > this.shownRev) return true
          w.done()
          return false
        })
      }
    }
    if (this.loose.length) {
      this.loose = this.loose.filter((l) => {
        if (l.rev > this.shownRev) return true
        this.release(l.offcut)
        return false
      })
    }
    if (this.falling.length) this.fall(dt)
  }

  private fill(data: ChunkMesh) {
    const verts = data.finish.length
    const corners = data.indices.length
    let mesh = this.meshes.get(data.chunk)
    if (corners === 0) {
      if (mesh) {
        this.drop(mesh)
        this.meshes.delete(data.chunk)
      }
      return
    }
    if (!mesh) {
      mesh = new THREE.Mesh(this.roomFor(data.chunk, verts, corners), this.material)
      mesh.name = `chunk-${data.chunk}`
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.matrixAutoUpdate = false
      this.meshes.set(data.chunk, mesh)
      this.studio.stage.add(mesh)
    } else if (verts > mesh.geometry.getAttribute('finish').count || corners > mesh.geometry.index!.count) {
      // Outgrew its buffers. GPU buffers cannot grow, so this chunk gets a roomier geometry.
      mesh.geometry.dispose()
      mesh.geometry = this.roomFor(data.chunk, verts, corners)
    }
    const g = mesh.geometry
    const position = g.getAttribute('position') as THREE.BufferAttribute
    const normal = g.getAttribute('normal') as THREE.BufferAttribute
    const finish = g.getAttribute('finish') as THREE.BufferAttribute
    position.array.set(data.positions)
    normal.array.set(data.normals)
    // three r187 has no one-byte vertex format on the WebGPU path, so finish is widened to a float here.
    const smooth = finish.array
    for (let i = 0; i < verts; i++) smooth[i] = data.finish[i]! / 255
    g.index!.array.set(data.indices)
    refill(position, verts * 3)
    refill(normal, verts * 3)
    refill(finish, verts)
    refill(g.index!, corners)
    g.setDrawRange(0, corners)
  }

  // An empty geometry with headroom, so most remeshes of this chunk are a plain refill.
  private roomFor(chunk: number, verts: number, corners: number) {
    const vertexRoom = Math.ceil(verts * 1.5) + 256
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', dynamic(new Float32Array(vertexRoom * 3), 3))
    g.setAttribute('normal', dynamic(new Float32Array(vertexRoom * 3), 3))
    g.setAttribute('finish', dynamic(new Float32Array(vertexRoom), 1))
    g.setIndex(dynamic(new Uint32Array(Math.ceil(corners * 1.5) + 1536), 1))
    // Fixed bounds from the grid: nothing a chunk can hold reaches outside them.
    const { min, max } = chunkBounds(this.grid, chunk)
    g.boundingBox = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max))
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere())
    return g
  }

  // No physics yet: a piece tips outward, drops out of frame and is removed.
  private release(offcut: Offcut) {
    const [cx, cy, cz] = offcut.centroid
    const positions = offcut.positions
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = positions[i]! - cx
      positions[i + 1] = positions[i + 1]! - cy
      positions[i + 2] = positions[i + 2]! - cz
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(offcut.normals, 3))
    g.setIndex(new THREE.BufferAttribute(offcut.indices, 1))
    const mesh = new THREE.Mesh(g, this.offcutMaterial)
    mesh.name = 'offcut'
    mesh.castShadow = true
    mesh.position.set(cx, cy, cz)
    // Away from the block's axis; straight toward the viewer if it came off the middle.
    const out = new THREE.Vector3(cx, 0, cz)
    if (out.lengthSq() < 1) out.set(0, 0, 1)
    out.normalize()
    this.falling.push({
      mesh,
      velocity: out.clone().multiplyScalar(45),
      spin: new THREE.Vector3(out.z, 0, -out.x).multiplyScalar(1.4),
      age: 0
    })
    this.studio.stage.add(mesh)
  }

  private fall(dt: number) {
    this.falling = this.falling.filter((piece) => {
      piece.age += dt
      piece.velocity.y -= GRAVITY * dt
      piece.mesh.position.addScaledVector(piece.velocity, dt)
      piece.mesh.rotation.x += piece.spin.x * dt
      piece.mesh.rotation.z += piece.spin.z * dt
      if (piece.age < 2.5 && piece.mesh.position.y > -300) return true
      this.drop(piece.mesh)
      return false
    })
  }

  private drop(mesh: THREE.Mesh) {
    this.studio.stage.remove(mesh)
    mesh.geometry.dispose()
  }
}
