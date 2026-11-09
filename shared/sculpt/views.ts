import type { Vec3 } from './types.ts'

// The named viewpoints the sculptor looks and carves from. Rulers are labelled in block
// coordinates (cm), so a point carries the same X in `front` and `back`; only the direction
// the ruler runs across the image differs.

export type AxisView = 'front' | 'back' | 'right' | 'left' | 'top'
export type QuarterView = 'front_left' | 'front_right' | 'back_left' | 'back_right'
export type ViewId = AxisView | QuarterView

export interface ViewDef {
  id: ViewId
  look: Vec3 // unit vector the camera looks along
  right: Vec3 // world direction of image +x
  up: Vec3 // world direction of image up
  carve: boolean // axis views only: a ruler coordinate maps to exactly one ray
  h?: 0 | 2 // block axis on the horizontal ruler
  v?: 1 | 2 // block axis on the vertical ruler
}

// Hardcoded so the kernel never calls Math.sin/cos (logs must replay across JS engines).
const S = 0.7071067811865476
const COS20 = 0.9396926207859084
const SIN20 = 0.3420201433256687

function quarter(id: QuarterView, ax: number, az: number): ViewDef {
  return {
    id,
    look: [ax * COS20, -SIN20, az * COS20],
    right: [-az, 0, ax],
    up: [ax * SIN20, COS20, az * SIN20],
    carve: false
  }
}

export const VIEWS: Record<ViewId, ViewDef> = {
  front: { id: 'front', look: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], carve: true, h: 0, v: 1 },
  back: { id: 'back', look: [0, 0, 1], right: [-1, 0, 0], up: [0, 1, 0], carve: true, h: 0, v: 1 },
  right: { id: 'right', look: [-1, 0, 0], right: [0, 0, -1], up: [0, 1, 0], carve: true, h: 2, v: 1 },
  left: { id: 'left', look: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0], carve: true, h: 2, v: 1 },
  top: { id: 'top', look: [0, -1, 0], right: [1, 0, 0], up: [0, 0, -1], carve: true, h: 0, v: 2 },
  front_left: quarter('front_left', S, -S),
  front_right: quarter('front_right', -S, -S),
  back_left: quarter('back_left', S, S),
  back_right: quarter('back_right', -S, S)
}

export const AXIS_VIEWS: AxisView[] = ['front', 'back', 'right', 'left', 'top']
export const VIEW_IDS = Object.keys(VIEWS) as ViewId[]

export function isAxisView(id: string): id is AxisView {
  return (AXIS_VIEWS as string[]).includes(id)
}

const FAR = 500

// A point read off an axis view's two rulers, as the ray the hand casts into the stone.
export function viewRay(view: AxisView, h: number, v: number): { origin: Vec3, dir: Vec3 } {
  const def = VIEWS[view]
  const p: Vec3 = [0, 0, 0]
  p[def.h!] = h
  p[def.v!] = v
  const l = def.look
  return { origin: [p[0] - l[0] * FAR, p[1] - l[1] * FAR, p[2] - l[2] * FAR], dir: [l[0], l[1], l[2]] }
}
