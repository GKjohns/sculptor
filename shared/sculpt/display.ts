import { cloneGrid, markDirtyBox } from './grid.ts'
import { detachIslands } from './islands.ts'
import { applyStrike } from './strike.ts'
import type { Grid, Offcut, Strike } from './types.ts'

// The stone on screen, for a timeline that wants loose pieces to fall the moment they are cut
// free and not at the end of the pass, where the log's own island check sits.
//
// An extra island check cannot simply be run on the stone itself. A strike through a piece
// that is still hanging leaves different numbers behind than one through air, and the
// edge-contact cleanup can take a sample off the standing stone next to a hanging piece, so a
// stone checked early ends a pass a few hundred samples away from the log's stone and with
// another hash. (Measured on three study runs: every one ended on a different hash.)
//
// So there are two grids. `grid` takes the log's entries and nothing else: it is the log's
// stone exactly, and it is what gets hashed, measured and saved. While nothing is hanging it
// is also what is drawn. settle() looks for loose stone on a copy; if there is any, that copy
// (without the loose pieces) becomes `display`, the grid that is drawn, and takes every later
// entry alongside `grid`. At the log's own island check the two are compared, the chunks that
// differ are flagged on `grid`, and the copy is dropped. The drift never outlives a pass.

export interface DisplayStrike {
  // What the log's stone lost.
  removedCm3: number
  // The pieces to drop on screen: those of the grid being drawn.
  offcuts: Offcut[]
}

export interface DisplayStone {
  // The log's stone.
  readonly grid: Grid
  // The grid to mesh from, and whose dirty flags say which chunks to mesh.
  drawn(): Grid
  // True while a copy is being drawn in place of the log's stone.
  split(): boolean
  apply(strike: Strike): DisplayStrike
  // The early island check. Returns the pieces that came loose since the last one.
  settle(): Offcut[]
  // Back to drawing the log's stone, whatever is hanging on it.
  rejoin(): void
}

function copyInto(to: Grid, from: Grid): void {
  to.dist.set(from.dist)
  to.finish.set(from.finish)
  to.solidUnits = from.solidUnits
  to.dirty.fill(0)
}

// Flags on `grid` every chunk whose mesh reads a sample that differs between the two buffers.
// Both are whole words long and start on a word boundary (see createGrid).
function flagDifferences(grid: Grid, a: Int8Array | Uint8Array, b: Int8Array | Uint8Array, out: number[]): void {
  const wa = new Int32Array(a.buffer, a.byteOffset, a.length >> 2)
  const wb = new Int32Array(b.buffer, b.byteOffset, b.length >> 2)
  const { nx, ny } = grid
  for (let w = 0; w < wa.length; w++) {
    if (wa[w] === wb[w]) continue
    const i = w << 2
    const x = i % nx
    const row = (i - x) / nx
    const y = row % ny
    const z = (row - y) / ny
    markDirtyBox(grid, x, y, z, x + 3, y, z, out)
  }
}

export function createDisplayStone(grid: Grid): DisplayStone {
  let display: Grid | null = null
  // One spare copy, kept between uses: a fresh one is 13 MB at the default size.
  let spare: Grid | null = null

  const rejoin = () => {
    if (!display) return
    const pending = display.dirty
    const out: number[] = []
    // The log's stone has been flagging chunks all along, but every one of those changes was
    // either made to the copy too (and meshed from it, or still pending there) or shows up
    // below as a difference.
    grid.dirty.fill(0)
    flagDifferences(grid, grid.dist, display.dist, out)
    flagDifferences(grid, grid.finish, display.finish, out)
    // Whatever the copy had not been meshed for yet is owed on the log's stone now.
    for (let c = 0; c < pending.length; c++) if (pending[c] === 1) grid.dirty[c] = 1
    spare = display
    display = null
  }

  return {
    grid,
    drawn: () => display ?? grid,
    split: () => display !== null,

    apply(strike) {
      const real = applyStrike(grid, strike)
      if (!display) return { removedCm3: real.removedCm3, offcuts: real.offcuts }
      // Forms live in the map both grids share, and a sketch moves no stone.
      if (strike.kind === 'form' || strike.kind === 'sketch') return { removedCm3: real.removedCm3, offcuts: [] }
      const shown = applyStrike(display, strike)
      // The log's own check: nothing hangs on either grid any more, so the copy has done its job.
      if (strike.kind === 'detach') rejoin()
      return { removedCm3: real.removedCm3, offcuts: shown.offcuts }
    },

    settle() {
      if (display) return detachIslands(display).offcuts
      const copy = spare ?? cloneGrid(grid)
      spare = null
      // The forms are shared, not copied: a form declared later protects both grids.
      copy.forms = grid.forms
      copyInto(copy, grid)
      const loose = detachIslands(copy)
      if (loose.dirtyChunks.length === 0) {
        spare = copy
        return []
      }
      // The chunks the log's stone still owes a mesh for are owed by the copy now.
      for (let c = 0; c < grid.dirty.length; c++) if (grid.dirty[c] === 1) copy.dirty[c] = 1
      display = copy
      return loose.offcuts
    },

    rejoin
  }
}
