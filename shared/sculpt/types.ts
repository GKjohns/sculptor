// The contract between hand, kernel, timeline and renderer.
// Units are centimetres, block-local: origin at the centre of the block's base,
// +Y up, +Z toward a viewer standing in front, +X to that viewer's right.

import type { AxisView } from './views.ts'

export type Vec3 = [number, number, number]

export type ToolId = 'saw' | 'point' | 'claw' | 'flat' | 'roundel' | 'drill' | 'rasp' | 'polish'

// at: contact point on the surface (cm). dir: unit vector the tool travels into the stone.
// ms: virtual duration, used by the timeline.
// The polish moves no stone: size is the pad's width and depth is the share (0 to 1) of the
// way to a full polish that one stroke takes the surface under it.
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

// A charcoal line drawn on the stone from an axis view. It is theatre and an aid to the eye:
// the kernel does nothing with it (no stone moves, the grid and its hash are untouched), but
// it rides in the log so a replay draws it at the same moment.
export interface SketchStrike {
  kind: 'sketch'
  view: AxisView
  // The line as it was asked for, in the view's ruler coordinates: [horizontal, vertical] cm.
  points: [number, number][]
  // Where the charcoal landed: runs of points about a centimetre apart on the surface as it
  // stood, block cm. A run ends where the line left the stone or jumped to a surface behind.
  strokes: Vec3[][]
  ms: number
}

export type Strike = CutStrike | SawStrike | DetachStrike | FormStrike | SketchStrike

export interface Offcut {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  centroid: Vec3
  cm3: number
}

// offcuts is non-empty only for 'saw' and 'detach'. A 'form' or 'sketch' entry returns an
// empty result.
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
  // How many samples beyond its own range a chunk's mesh reads, which is how far round a changed
  // sample chunks are flagged. 2 for geometry and normals; more once thickness is baked (mesher.ts).
  reach: number
  // Stone volume in units of voxel³ / 254, kept current by every edit.
  solidUnits: number
  forms: Map<string, CompiledForm>
}

// The grid's layout without its contents: enough to place chunks and samples, and small enough
// to send to another thread.
export type GridInfo = Omit<Grid, 'dist' | 'finish' | 'dirty' | 'reach' | 'solidUnits' | 'forms'>

export interface MeshData {
  // xyz per vertex, cm, block-local.
  positions: Float32Array
  // Unit normals pointing out of the stone.
  normals: Float32Array
  // One finish value per vertex, 0 (rough) to 255 (polished).
  finish: Uint8Array
  // How much stone stands behind each vertex, 0 (a knife edge) to 255 (THICKNESS_CM or more). Only
  // the renderer reads it, for light through thin sections. All 255 unless the bake was asked for.
  thickness: Uint8Array
  // Unit normals again, from the distance gradient over a wider span, so that tool grooves a
  // voxel or two deep do not show in them. Only the renderer reads them, to shade worked stone.
  // A copy of `normals` unless the bake was asked for.
  smooth: Float32Array
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
