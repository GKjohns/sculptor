/**
 * The stone on screen, refilled in place from the kernel worker's chunk messages, plus the pieces
 * that fall away when a saw or an island check takes them off.
 *
 * The kernel meshes 32-voxel chunks, which is the right size to remesh. It is the wrong size to
 * draw: every object costs the renderer the same few tens of microseconds on the CPU in each of
 * the frame's three geometry passes (shadow map, pre-pass, beauty), and a block has some 150
 * chunks with surface in them. So the chunks are drawn in bundles of GROUP x GROUP x GROUP: one
 * mesh per bundle, rebuilt from its chunks' arrays whenever one of them changes.
 *
 * The look is materials/marble.ts: veins read at block coordinates, roughness and tool marks from the
 * per-vertex finish the tools left, worked faces shaded with the mesher's smooth normals, light
 * through thin stone from the per-vertex thickness it bakes. A piece that falls away keeps the block coordinates of its vertices in a `stone` attribute,
 * so its veins stay where they were.
 */
import * as THREE from 'three/webgpu'
import { chunkBounds, chunkCoords } from '#shared/sculpt/grid'
import type { ChunkMesh, GridInfo, Offcut } from '#shared/sculpt/types'
import { CARRARA, STONE_COORDS, createLooseMarble, createMarble } from './materials/marble'
import type { StonePreset } from './materials/marble'
import type { StudioRenderer } from './renderer'

const GRAVITY = 981 // cm/s²
// Chunks per bundle along each axis.
const GROUP = 2
// The finish a face has where the stone broke or the saw went through.
const BROKEN = 0.3

interface Falling {
  mesh: THREE.Mesh
  velocity: THREE.Vector3
  spin: THREE.Vector3
  age: number
}

// Refilled in place, but not marked DynamicDrawUsage: three's WebGPU path uploads an attribute
// with that usage again on every render call, changed or not, which sent the whole stone to the
// GPU three times a frame (82% of the main thread's frame). Left static, it goes up when its
// version moves, and only the range refill() names.
function dynamic<T extends THREE.TypedArray>(array: T, itemSize: number) {
  return new THREE.BufferAttribute(array, itemSize)
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

  /** For pieces off the block. Their geometry needs the block coordinates of each vertex as `stone` (see offcutGeometry). */
  readonly offcutMaterial: THREE.MeshPhysicalNodeMaterial
  // The latest mesh of every chunk that has surface in it, as the worker sent it.
  private parts = new Map<number, ChunkMesh>()
  // One mesh per bundle of chunks, by bundle id.
  private meshes = new Map<number, THREE.Mesh>()
  private incoming = new Map<number, ChunkMesh>()
  private arrivedRev = -1
  private fresh = false
  private loose: { rev: number, offcut: Offcut }[] = []
  private falling: Falling[] = []
  private waiters: { rev: number, done: () => void }[] = []
  private stop: () => void
  private warm: THREE.Mesh

  constructor(private studio: StudioRenderer, public grid: GridInfo, readonly preset: StonePreset = CARRARA) {
    this.material = createMarble(preset)
    this.offcutMaterial = createLooseMarble(preset, BROKEN)
    // One speck of loose stone under the floor from the start, so the offcut material's shaders
    // are compiled with everything else and the first slab to fall does not cost a frame.
    const speck = new THREE.BufferGeometry()
    speck.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0, 0.1]), 3))
    speck.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3))
    speck.setAttribute(STONE_COORDS, new THREE.BufferAttribute(new Float32Array(9), 3))
    this.warm = new THREE.Mesh(speck, this.offcutMaterial)
    this.warm.name = 'offcut-warm'
    this.warm.position.set(0, -400, 0)
    this.warm.castShadow = true
    this.warm.frustumCulled = false
    studio.stage.add(this.warm)
    this.stop = studio.onFrame(dt => this.frame(dt))
  }

  /** The stone's meshes (bundles of chunks), for picking. */
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

  /**
   * Starts over on a fresh block. Call it when the worker reports the new block ready, before its
   * first mesh lands: that mesh covers every chunk, so the old ones are refilled in place.
   */
  reset(grid: GridInfo) {
    const g = this.grid
    if (grid.nx !== g.nx || grid.ny !== g.ny || grid.nz !== g.nz || grid.chunk !== g.chunk || grid.voxel !== g.voxel) {
      for (const mesh of this.meshes.values()) this.drop(mesh)
      this.meshes.clear()
      this.parts.clear()
    }
    this.grid = grid
    for (const piece of this.falling) this.drop(piece.mesh)
    this.falling = []
    this.loose = []
    this.incoming.clear()
    this.fresh = false
    this.arrivedRev = this.shownRev = -1
  }

  dispose() {
    this.stop()
    for (const mesh of this.meshes.values()) this.drop(mesh)
    for (const piece of this.falling) this.drop(piece.mesh)
    this.drop(this.warm)
    this.meshes.clear()
    this.parts.clear()
    this.falling = []
    this.material.dispose()
    this.offcutMaterial.dispose()
  }

  private frame(dt: number) {
    // Everything that arrived since the last frame goes in together: each worker message is a
    // seamless set, so a frame never shows one side of a seam ahead of the other.
    if (this.fresh) {
      this.fresh = false
      const stale = new Set<number>()
      for (const chunk of this.incoming.values()) {
        if (chunk.indices.length === 0) this.parts.delete(chunk.chunk)
        else this.parts.set(chunk.chunk, chunk)
        stale.add(this.bundleOf(chunk.chunk))
      }
      for (const bundle of stale) this.fill(bundle)
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

  // Bundle coordinates are chunk coordinates divided by GROUP; the id packs them the way chunk ids do.
  private bundleOf(chunk: number) {
    const [cx, cy, cz] = chunkCoords(this.grid, chunk)
    const bx = Math.ceil(this.grid.ncx / GROUP)
    const by = Math.ceil(this.grid.ncy / GROUP)
    return Math.floor(cx / GROUP) + bx * (Math.floor(cy / GROUP) + by * Math.floor(cz / GROUP))
  }

  // The ids of the chunks in a bundle, whether or not they have surface in them.
  private chunksOf(bundle: number) {
    const { ncx, ncy, ncz } = this.grid
    const bx = Math.ceil(ncx / GROUP)
    const by = Math.ceil(ncy / GROUP)
    const gx = bundle % bx
    const gy = Math.floor(bundle / bx) % by
    const gz = Math.floor(bundle / (bx * by))
    const ids: number[] = []
    for (let z = gz * GROUP; z < Math.min(ncz, (gz + 1) * GROUP); z++) {
      for (let y = gy * GROUP; y < Math.min(ncy, (gy + 1) * GROUP); y++) {
        for (let x = gx * GROUP; x < Math.min(ncx, (gx + 1) * GROUP); x++) ids.push(x + ncx * (y + ncy * z))
      }
    }
    return ids
  }

  // Rebuilds one bundle's mesh from the chunks it holds.
  private fill(bundle: number) {
    const ids = this.chunksOf(bundle)
    let verts = 0
    let corners = 0
    for (const id of ids) {
      const part = this.parts.get(id)
      if (!part) continue
      verts += part.finish.length
      corners += part.indices.length
    }
    let mesh = this.meshes.get(bundle)
    if (corners === 0) {
      if (mesh) {
        this.drop(mesh)
        this.meshes.delete(bundle)
      }
      return
    }
    if (!mesh) {
      mesh = new THREE.Mesh(this.roomFor(ids, verts, corners), this.material)
      mesh.name = `chunk-${bundle}`
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.matrixAutoUpdate = false
      this.meshes.set(bundle, mesh)
      this.studio.stage.add(mesh)
    } else if (verts > mesh.geometry.getAttribute('finish').count || corners > mesh.geometry.index!.count) {
      // Outgrew its buffers. GPU buffers cannot grow, so this bundle gets a roomier geometry.
      mesh.geometry.dispose()
      mesh.geometry = this.roomFor(ids, verts, corners)
    }
    const g = mesh.geometry
    const position = g.getAttribute('position') as THREE.BufferAttribute
    const normal = g.getAttribute('normal') as THREE.BufferAttribute
    const finish = g.getAttribute('finish') as THREE.BufferAttribute
    const thickness = g.getAttribute('thickness') as THREE.BufferAttribute
    const smoothed = g.getAttribute('smoothNormal') as THREE.BufferAttribute
    const smooth = finish.array
    const thick = thickness.array
    const index = g.index!.array
    let v = 0
    let c = 0
    for (const id of ids) {
      const part = this.parts.get(id)
      if (!part) continue
      const count = part.finish.length
      position.array.set(part.positions, v * 3)
      normal.array.set(part.normals, v * 3)
      smoothed.array.set(part.smooth, v * 3)
      // three r187 has no one-byte vertex format on the WebGPU path, so finish and thickness are widened to floats here.
      for (let i = 0; i < count; i++) {
        smooth[v + i] = part.finish[i]! / 255
        thick[v + i] = part.thickness[i]! / 255
      }
      const corner = part.indices
      for (let i = 0; i < corner.length; i++) index[c + i] = corner[i]! + v
      v += count
      c += corner.length
    }
    refill(position, verts * 3)
    refill(normal, verts * 3)
    refill(finish, verts)
    refill(thickness, verts)
    refill(smoothed, verts * 3)
    refill(g.index!, corners)
    g.setDrawRange(0, corners)
  }

  // An empty geometry with headroom, so most remeshes of this bundle are a plain refill.
  private roomFor(chunks: number[], verts: number, corners: number) {
    const vertexRoom = Math.ceil(verts * 1.4) + 1024
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', dynamic(new Float32Array(vertexRoom * 3), 3))
    g.setAttribute('normal', dynamic(new Float32Array(vertexRoom * 3), 3))
    g.setAttribute('finish', dynamic(new Float32Array(vertexRoom), 1))
    g.setAttribute('thickness', dynamic(new Float32Array(vertexRoom), 1))
    g.setAttribute('smoothNormal', dynamic(new Float32Array(vertexRoom * 3), 3))
    g.setIndex(dynamic(new Uint32Array(Math.ceil(corners * 1.4) + 6144), 1))
    // Fixed bounds from the grid: nothing the bundle's chunks can hold reaches outside them.
    const box = new THREE.Box3()
    for (const id of chunks) {
      const { min, max } = chunkBounds(this.grid, id)
      box.expandByPoint(new THREE.Vector3(...min)).expandByPoint(new THREE.Vector3(...max))
    }
    g.boundingBox = box
    g.boundingSphere = box.getBoundingSphere(new THREE.Sphere())
    return g
  }

  // No physics yet: a piece tips outward, drops out of frame and is removed.
  private release(offcut: Offcut) {
    const [cx, cy, cz] = offcut.centroid
    const mesh = new THREE.Mesh(offcutGeometry(offcut), this.offcutMaterial)
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

/**
 * Geometry for a piece that came off, centred on its centroid (so the mesh goes at
 * `offcut.centroid`), with each vertex's place in the block kept as the `stone` attribute the
 * offcut material reads its veins at. Takes over the offcut's arrays.
 */
export function offcutGeometry(offcut: Offcut) {
  const [cx, cy, cz] = offcut.centroid
  const positions = offcut.positions
  const home = positions.slice()
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i]! - cx
    positions[i + 1] = positions[i + 1]! - cy
    positions[i + 2] = positions[i + 2]! - cz
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(offcut.normals, 3))
  g.setAttribute(STONE_COORDS, new THREE.BufferAttribute(home, 3))
  g.setIndex(new THREE.BufferAttribute(offcut.indices, 1))
  return g
}
