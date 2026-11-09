// The contract between hand, kernel, timeline and renderer.
// Units are centimetres, block-local: origin at the centre of the block's base,
// +Y up, +Z toward a viewer standing in front, +X to that viewer's right.

export type Vec3 = [number, number, number]

export type ToolId = 'saw' | 'point' | 'claw' | 'flat' | 'roundel' | 'drill' | 'rasp' | 'polish'

// at: contact point on the surface (cm). dir: unit vector the tool travels into the stone.
// ms: virtual duration, used by the timeline.
export interface CutStrike {
  kind: 'cut'
  tool: ToolId
  at: Vec3
  dir: Vec3
  size: number
  depth: number
  seed: number
  // Name of a declared form this strike may not cut into, and how far outside it the strike
  // has to stay (cm, default 0): a roughing margin.
  protect?: string
  margin?: number
  // Toothed tools only: the direction the teeth are spaced along (across the stroke). Grooves
  // run at right angles to it. Left out, the kernel picks one from dir.
  across?: Vec3
  ms: number
}

// Removes the side the normal points to.
export interface SawStrike {
  kind: 'saw'
  plane: { point: Vec3, normal: Vec3 }
  ms: number
}

// Run the island check here.
export interface DetachStrike {
  kind: 'detach'
}

// Declares (or replaces) a named form at this point in the log, so that a replay, or a second
// copy of the stone, protects the same stone from the same strike onward. Moves no stone.
export interface FormStrike extends Form {
  kind: 'form'
  name: string
}

export type Strike = CutStrike | SawStrike | DetachStrike | FormStrike

export interface Offcut {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  centroid: Vec3
  cm3: number
}

// offcuts is non-empty only for 'saw' and 'detach'. A 'form' entry returns an empty result.
export interface StrikeResult {
  dirtyChunks: number[]
  removedCm3: number
  offcuts: Offcut[]
}

export interface GridOptions {
  width: number
  height: number
  depth: number
  voxel: number
  chunk: number
}

export interface Grid {
  // Samples per axis, air padding included. Sample (i, j, k) sits at
  // (x0 + i * voxel, y0 + j * voxel, z0 + k * voxel) and is stored at i + nx * (j + ny * k).
  nx: number
  ny: number
  nz: number
  voxel: number
  x0: number
  y0: number
  z0: number
  // Chunk edge in samples, and chunks per axis. Chunk id = cx + ncx * (cy + ncy * cz).
  chunk: number
  ncx: number
  ncy: number
  ncz: number
  // Sample layer of the fresh block's lowest stone; the base face is half a voxel below it.
  baseY: number
  // The block as represented, cm (the request rounded to whole voxels).
  size: Vec3
  // Stored distance units per centimetre.
  qPerCm: number
  // Signed distance to the surface: negative inside stone, clamped to ±4 voxels, scaled to ±127.
  dist: Int8Array
  // Smoothness left by whichever tool last touched the surface, 0 to 255.
  finish: Uint8Array
  // One flag per chunk whose mesh is stale. Read and cleared by takeDirty().
  dirty: Uint8Array
  // Stone volume in units of voxel³ / 254, kept current by every edit.
  solidUnits: number
  forms: Map<string, CompiledForm>
}

// The grid's layout without its contents: enough to place chunks and samples, and small enough
// to send to another thread.
export type GridInfo = Omit<Grid, 'dist' | 'finish' | 'dirty' | 'solidUnits' | 'forms'>

export interface MeshData {
  // xyz per vertex, cm, block-local.
  positions: Float32Array
  // Unit normals pointing out of the stone.
  normals: Float32Array
  // One finish value per vertex, 0 (rough) to 255 (polished).
  finish: Uint8Array
  // Triangle list, counter-clockwise seen from outside.
  indices: Uint32Array
}

export interface ChunkMesh extends MeshData {
  chunk: number
}

export type ShapeKind = 'ellipsoid' | 'box' | 'capsule' | 'cone'

// size is the full extent along the shape's own axes before rotation. Capsules and cones stand
// along their local Y. rotation is in degrees, applied as three.js Euler order 'XYZ'.
export interface Shape {
  kind: ShapeKind
  center: Vec3
  size: Vec3
  rotation: Vec3
}

// A binary image as runs of filled cells: for each row from the top, [start, end) column
// pairs one after another. Plain numbers, so it survives JSON inside a strike log.
export interface Outline {
  width: number
  height: number
  rows: number[][]
}

// Two outlines pushed through the block: the volume common to the front outline extruded
// along Z and the left outline extruded along X. Each image spans a whole face of a block of
// `size` (width X, height Y, depth Z, cm) standing on the base: row 0 is the top, front
// column 0 is X = -width/2, left column 0 is Z = -depth/2.
export interface Silhouette {
  front: Outline
  left: Outline
  size: Vec3
}

export interface Form {
  shapes: Shape[]
  // Radius of the smooth union between shapes, cm. 0 is a hard union.
  blend: number
  // Grows the form outward by this many cm, e.g. a roughing margin.
  inflate?: number
  // When present the form is this silhouette volume and `shapes` is ignored.
  silhouette?: Silhouette
}

// One outline as a signed distance image, cm, negative inside.
export interface OutlineField {
  width: number
  height: number
  // Cell size, cm, and the horizontal coordinate of the image's left edge.
  sx: number
  sy: number
  left: number
  top: number
  field: Float32Array
}

export interface CompiledSilhouette {
  front: OutlineField
  left: OutlineField
}

export interface CompiledForm {
  count: number
  kinds: Uint8Array
  // 16 numbers per shape: centre, half extents, the world-to-local rotation by rows, one spare.
  data: Float64Array
  blend: number
  inflate: number
  silhouette?: CompiledSilhouette
  // What it was compiled from, so the hand can declare the same form again with a margin.
  source: Form
}

export interface RayHit {
  point: Vec3
  normal: Vec3
  distance: number
}
