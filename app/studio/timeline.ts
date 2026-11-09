/**
 * The timeline: what the shown stone does, and when. It is a queue of strikes that grows while it
 * plays (a live commission adds each pass the moment the sculptor issues it; a replay is the same
 * queue filled before the first tick) and a virtual clock that walks along it. A cut or a saw lands
 * when the clock reaches the end of its `ms`; entries that take no time go in right behind.
 *
 * Nothing here reads the wall clock. Time moves only through tick(dt): the studio's frame loop
 * drives it with real frame times, and a frame-by-frame export can step it at a fixed dt instead.
 *
 * Pacing. With `elastic` off the clock runs at `speed` virtual seconds per second, as a replay
 * wants. With it on, the rate follows the queue so the hand is neither idle nor far behind:
 *
 *     rate = clamp(backlog / drain, floor, speed × CEILING)
 *
 * where backlog is the unplayed work in virtual seconds and drain = min(48, 96 / speed) s is how
 * long the timeline aims to take over whatever is queued (24 s at the default 4×). A sculptor's
 * turn takes 10 to 30 s, so a pass is usually still playing when the next arrives. As the queue
 * runs dry the hand slows to the floor, max(0.35, speed / 8) of its own pace, instead of rushing to
 * a stop; once nothing more can arrive the floor is `speed`. The rate eases toward its target so
 * a pass landing in the queue does not jerk the hand.
 *
 * The stone decides how fast that can really go: one batch is out at a time, the worker cuts each
 * batch off after BUDGET_MS of work, and the clock waits at the next entry the worker has not
 * been handed. So a costly stretch (a rough-out's saw cuts) slows time down; it never piles up.
 *
 * Looks are staged. A look sits in the queue where the sculptor took it. When the clock gets
 * there the hand stops, the camera walks to the viewpoints asked for, and the look is handed to
 * onLook (the Sculptor's eye shows the sheet the model was sent) until its time is up.
 *
 * Backpressure on the sculptor: room() resolves when the screen is less than about a minute
 * behind and not paused. The loop's Studio waits on it before answering a call, so a sculptor
 * that outruns the screen is held at the next tool result.
 *
 * The film around the stone (debris, tools, sound, the camera director) listens in through
 * listen(): every cut and saw cut as it lands, passes and looks as they begin and end, the block
 * being rebuilt, the stone jumping ahead without playing. upcoming() says which strike the clock is
 * on its way to, so a mallet can land on the beat and a saw can travel its cut. `timeScale`
 * stretches tick time for slow motion; it is the director's, and 1 unless a slab is falling.
 */
import { strikeMs } from '#shared/agent/replay'
import { DENSITY } from '#shared/sculpt/grid'
import { nominalBiteCm3, TOOLS } from '#shared/sculpt/tools'
import type { CutStrike, GridInfo, SawStrike, SketchStrike, Strike, ToolId, Vec3 } from '#shared/sculpt/types'
import type { CameraRig } from './camera'
import type { KernelClient } from './kernel'
import type { Stone } from './stone'

/** Virtual seconds per second of tick time (the centre of the elastic band when pacing is elastic), or 'max': as fast as the worker takes strikes while still drawing them. */
export type Speed = number | 'max'

/** What the timeline needs to know of a pass: how many log entries it is. The rest rides along for the HUD. */
export interface TimelinePass {
  strikes: number
}

export interface TimelineLook {
  /** The viewpoints the camera walks to, in order. */
  views: string[]
  /** A close-up brings the camera in; anything else steps it back. */
  close?: boolean
  /** A close-up's window: the camera turns about its centre and frames it (a macro shot). */
  macro?: { target: [number, number, number], span: number }
  /** Stretches the look: 2 takes twice as long over it. */
  linger?: number
}

export interface TimelineState {
  playing: boolean
  speed: Speed
  /** Virtual seconds per tick second right now; 0 while there is nothing to play. */
  rate: number
  /** Log entries the shown stone has taken, of `total` issued. */
  applied: number
  total: number
  /** 0-based index of the pass on screen, of `passes` queued; -1 before the first. */
  pass: number
  passes: number
  /** The virtual clock, ms: strike time played, of `totalMs` issued. `lookMs` is the time spent looking on top. */
  clockMs: number
  totalMs: number
  lookMs: number
  /** Screen seconds the queue would take at the pace the timeline is aiming for, staged looks included. */
  behindS: number
  /** What the shown stone weighs, kg; null until the worker has said. */
  massKg: number | null
  looking: boolean
  /** Everything queued is on the stone and no look is on stage or waiting. */
  caughtUp: boolean
  /** More may still arrive. */
  open: boolean
  /** Nothing more will arrive and everything is on screen. */
  done: boolean
  /** Rebuilding the block or skipping ahead: the controls wait. */
  busy: boolean
  error: string
}

export interface TimelineOptions {
  speed?: Speed
  /** Follow the queue (a live commission) instead of running at exactly `speed` (a replay). */
  elastic?: boolean
  /** A fresh shown stone to play the queue onto again; resolves with its layout. */
  rebuild: () => Promise<GridInfo>
  camera?: CameraRig | null
  /** Drop loose stone on screen as it comes free instead of at the end of its pass. On unless set false. */
  settle?: boolean
}

/** A cut or a saw cut as it landed on the shown stone: what debris, tools, sound and the director act on. */
export interface StrikeEvent {
  kind: 'cut' | 'saw'
  tool: ToolId
  /** Contact point, cm. A saw's is the point its plane was given by. */
  at: Vec3
  /** Unit vector the tool travelled into the stone. A saw's is its plane's normal, toward the side that came off. */
  dir: Vec3
  /** Tool width and bite depth, cm; 0 for a saw. */
  size: number
  depth: number
  /** Stone this strike took, cm³: its share of what the worker measured for the batch. A saw's is 0; its offcuts say what they weigh. */
  removedCm3: number
  seed: number
  /** The virtual time it took and the virtual clock when it landed, ms, and its place in the log. */
  ms: number
  atMs: number
  index: number
}

/** The strike the clock is on its way to. */
export interface UpcomingStrike {
  strike: CutStrike | SawStrike
  index: number
  /** How far through its own time the clock is, 0 to 1. */
  progress: number
  /** Tick seconds until it lands at the current rate. */
  inS: number
}

/** Everything a listener can hear. All optional; none may change what the timeline does. */
export interface TimelineListener {
  /** A batch of cuts and saw cuts has just landed, oldest first. `rate` is virtual seconds per tick second right now. */
  strikes?: (events: StrikeEvent[], rate: number) => void
  pass?: (pass: TimelinePass, index: number) => void
  passEnd?: (pass: TimelinePass, index: number) => void
  /** A look is on stage for `seconds` of tick time. */
  look?: (look: TimelineLook, seconds: number) => void
  lookEnd?: (look: TimelineLook) => void
  /** The block is being rebuilt: whatever came off the old one is gone. */
  reset?: () => void
  /** The stone now stands at log entry `applied` without the entries before it having been played (a seek, a restored session). */
  jump?: (log: readonly Strike[], applied: number) => void
  change?: (state: TimelineState) => void
  /** The timeline is gone. */
  end?: () => void
}

/** How dull it got: tick seconds with the queue open and nothing on screen to watch. */
export interface TimelineIdle {
  totalS: number
  longestS: number
  /** The longest the worker kept one batch (tick seconds): the hand standing still because the worker was busy with the true stone. */
  longestStallS: number
  /** The furthest the screen fell behind, screen seconds. */
  maxBehindS: number
}

// Worker time one batch may take before it has to stop and let the mesh catch up.
const BUDGET_MS = 10
// Most entries offered in one batch, and the batch size when skipping without drawing.
const MAX_BATCH = 256
const SKIP_BATCH = 250
// Scrubbing back: a copy of the shown stone is kept in the worker every so many log entries as a
// seek passes them, at most this many to a log, and going back starts from the nearest one.
const SNAP_MIN = 800
const SNAPS_PER_LOG = 8

// Elastic pacing (see the top of the file).
const DRAIN_S = 96
const DRAIN_MAX_S = 48
const FLOOR = 0.35
const CEILING = 8
const EASE_S = 0.5

// The sculptor is held once the screen is this far behind, and let go again at the lower mark.
const GATE_S = 60
const UNGATE_S = 30

// A staged look at 4×: the walk to each viewpoint, then a moment on the last. Faster speeds and a
// long queue shorten it, but never to less than it takes to see that the sculptor stepped back.
const LOOK_WALK_S = 0.8
const LOOK_HOLD_S = 2
const LOOK_MIN_S = 1.5
const LOOK_VIEWS = 6

// Tick seconds of carving between early island checks on the shown stone. Each costs the worker
// one copy of the grid and one flood fill (about 10 ms at the default size), so this is some 7%
// of its time; the frame loop never sees it.
const SETTLE_S = 0.15

type Mark<P, L>
  = | { kind: 'pass', start: number, end: number, index: number, pass: P }
    | { kind: 'look', at: number, look: L }

const clamp = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v

export class Timeline<P extends TimelinePass = TimelinePass, L extends TimelineLook = TimelineLook> {
  /** Called whenever the state changes (at most once per batch, not once per frame). */
  onChange: (state: TimelineState) => void = () => {}
  /** The first strike of a pass is about to land. */
  onPass: (pass: P, index: number) => void = () => {}
  /** The last strike of a pass is on the stone. */
  onPassEnd: (pass: P, index: number) => void = () => {}
  /** The clock has reached a look: the hand has stopped and the camera is on its way. */
  onLook: (look: L) => void = () => {}
  onLookEnd: (look: L) => void = () => {}
  /** A charcoal line has been drawn. */
  onSketch: (strike: SketchStrike) => void = () => {}

  /** The shown stone's rev after the last batch the worker confirmed. */
  rev = 0
  /** Tick seconds per second handed to tick(): below 1 is slow motion. The director's to set. */
  timeScale = 1
  /** Worker time one batch may take, ms. A film export raises it: nobody is waiting on the frame. */
  budgetMs = BUDGET_MS
  /** Stretches (above 1) or shortens every staged look. A time-lapse film shortens them. */
  lookScale = 1
  readonly idle: TimelineIdle = { totalS: 0, longestS: 0, longestStallS: 0, maxBehindS: 0 }

  private strikes: Strike[] = []
  private ends: number[] = []
  private marks: Mark<P, L>[] = []
  private passes: Extract<Mark<P, L>, { kind: 'pass' }>[] = []
  // The next mark to act on, the last pass announced and the next pass to land.
  private cursor = 0
  private announced = -1
  private landed = 0
  private clock = 0
  private lookClock = 0
  private sent = 0
  private applied = 0
  // Sketch entries below this have had their lines drawn.
  private drawn = 0
  private flight: Promise<void> | null = null
  private staged: { look: L, left: number } | null = null
  private playing = false
  private busy = false
  private open: boolean
  private error = ''
  private speed: Speed
  private elastic: boolean
  private rate = 0
  private settles: boolean
  private sinceSettle = 0
  private unsettled = 0
  private idleRun = 0
  private flightS = 0
  private mass: number | null = null
  private gated = false
  private waiters: (() => void)[] = []
  private kernel: KernelClient
  private stone: Stone
  private camera: CameraRig | null
  private rebuild: () => Promise<GridInfo>
  private listeners = new Set<TimelineListener>()
  // Bumped by restart() and dispose(): replies to anything sent before are for a stone that is gone.
  private epoch = 0
  // Log entries at which the worker holds a copy of the shown stone, and this timeline's name for them.
  private snaps = new Set<number>()
  private tag = Math.random().toString(36).slice(2, 10)

  constructor(kernel: KernelClient, stone: Stone, options: TimelineOptions) {
    this.kernel = kernel
    this.stone = stone
    this.speed = options.speed ?? 4
    this.elastic = options.elastic === true
    this.open = this.elastic
    this.rebuild = options.rebuild
    this.camera = options.camera ?? null
    this.settles = options.settle !== false
    void this.weigh()
  }

  get total() {
    return this.strikes.length
  }

  get clockMs() {
    return this.clock
  }

  get totalMs() {
    return this.ends[this.ends.length - 1] ?? 0
  }

  /** The whole queue, oldest first: the commission's strike log so far. */
  get log(): readonly Strike[] {
    return this.strikes
  }

  state(): TimelineState {
    return {
      playing: this.playing,
      speed: this.speed,
      rate: this.applied < this.total && this.playing && !this.staged ? this.rate : 0,
      applied: this.applied,
      total: this.total,
      pass: this.announced,
      passes: this.passes.length,
      clockMs: this.clock,
      totalMs: this.totalMs,
      lookMs: this.lookClock,
      behindS: this.behind(),
      massKg: this.mass,
      looking: this.staged !== null,
      caughtUp: this.caughtUp(),
      open: this.open,
      done: !this.open && this.caughtUp(),
      busy: this.busy,
      error: this.error
    }
  }

  // ---------- listening in ----------

  /** Hears what happens on the timeline until the returned function is called. */
  listen(listener: TimelineListener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The cut or saw cut the clock is on its way to; null while paused, looking, or with nothing due. */
  upcoming(): UpcomingStrike | null {
    if (!this.playing || this.busy || this.staged) return null
    const limit = this.limit()
    let i = this.sent
    while (i < limit && this.strikes[i]!.kind !== 'cut' && this.strikes[i]!.kind !== 'saw') i++
    if (i >= limit) return null
    const end = this.ends[i]!
    const start = i > 0 ? this.ends[i - 1]! : 0
    const rate = this.rate > 0 && this.rate !== Infinity ? this.rate : 1
    return {
      strike: this.strikes[i] as CutStrike | SawStrike,
      index: i,
      progress: end > start ? clamp((this.clock - start) / (end - start), 0, 1) : 1,
      inS: Math.max(0, end - this.clock) / 1000 / rate
    }
  }

  // ---------- the queue ----------

  /** Resolves once the batch the worker has (if any) is back: a fixed-step export waits on it before the next frame. */
  async pending() {
    while (this.flight) await this.flight
  }

  /** Adds log entries to the end of the queue; with `pass`, they are that pass (its `strikes` is their count). */
  push(strikes: readonly Strike[], pass?: P) {
    const start = this.strikes.length
    let t = this.totalMs
    for (const strike of strikes) {
      t += strikeMs(strike)
      this.strikes.push(strike)
      this.ends.push(t)
    }
    if (pass) {
      const mark = { kind: 'pass' as const, start, end: this.strikes.length, index: this.passes.length, pass }
      this.marks.push(mark)
      this.passes.push(mark)
    }
    this.emit()
  }

  /** Queues a look where the log now ends: it is staged once everything before it is on the stone. */
  look(look: L) {
    this.marks.push({ kind: 'look', at: this.strikes.length, look })
    this.emit()
  }

  /** Nothing more will arrive (the commission ended), or more may after all (it was resumed). */
  setOpen(open: boolean) {
    if (this.open === open) return
    this.open = open
    this.emit()
    this.release()
  }

  /** Everything queued is on the stone and no look is on stage. */
  caughtUp() {
    return this.applied >= this.total && this.cursor >= this.marks.length && !this.staged && !this.flight
  }

  /**
   * Resolves when the sculptor may carry on: the screen is not paused and is less than about a
   * minute behind. Also resolves when `signal` aborts, so a stopped commission is never left waiting.
   */
  room(signal?: AbortSignal): Promise<void> {
    if (!this.holding() || signal?.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        signal?.removeEventListener('abort', done)
        this.waiters = this.waiters.filter(w => w !== done)
        resolve()
      }
      signal?.addEventListener('abort', done, { once: true })
      this.waiters.push(done)
    })
  }

  // ---------- the controls ----------

  play() {
    if (this.playing || this.error) return
    this.playing = true
    this.emit()
    this.release()
  }

  pause() {
    if (!this.playing) return
    this.playing = false
    this.emit()
  }

  setSpeed(speed: Speed) {
    this.speed = speed
    this.emit()
    this.release()
  }

  /** Advances the clock by dt seconds and hands the worker what has come due. */
  tick(dt: number) {
    if (!this.playing || this.busy) return
    dt *= this.timeScale
    if (this.staged) {
      this.idleRun = 0
      this.lookClock += dt * 1000
      this.staged.left -= dt
      if (this.staged.left <= 0) this.endLook()
      return
    }
    this.act()
    if (this.staged) return
    if (this.flight) {
      this.flightS += dt
      if (this.flightS > this.idle.longestStallS) this.idle.longestStallS = this.flightS
    } else {
      this.flightS = 0
    }

    const total = this.total
    const limit = this.limit()
    const target = this.pace(dt)
    if (!this.flight && this.sent < limit) {
      const cap = Math.min(limit, this.sent + MAX_BATCH)
      const due = this.clock + dt * 1000 * target
      let to = this.sent
      while (to < cap && this.ends[to]! <= due) to++
      if (to > this.sent) this.flight = this.send(this.sent, to, this.epoch)
    }
    // Time stops at the first entry not yet handed over. It is due the moment the worker is free.
    this.clock = Math.min(this.clock + dt * 1000 * target, this.sent < total ? this.ends[this.sent]! : this.totalMs)
    this.sinceSettle += dt

    if (this.open && this.applied >= total && !this.flight) {
      this.idleRun += dt
      this.idle.totalS += dt
      if (this.idleRun > this.idle.longestS) this.idle.longestS = this.idleRun
    } else {
      this.idleRun = 0
    }
    const behind = this.behind()
    if (behind > this.idle.maxBehindS && Number.isFinite(behind)) this.idle.maxBehindS = behind
    this.release()
  }

  /** A fresh block and the clock back at zero, with the queue kept. Resolves once the worker has rebuilt it; playing or paused carries over. */
  async restart() {
    const epoch = this.clear()
    // A rebuild may be a full init, which lets go of every copy the worker kept.
    this.snaps.clear()
    const grid = await this.rebuild()
    if (epoch !== this.epoch) return
    // Still inside the task that delivered 'ready', so this runs before the new block's first mesh.
    this.stone.reset(grid)
    this.busy = false
    void this.weigh()
    this.emit()
  }

  // Back to the start of the queue, with the stone to be replaced: returns the new epoch.
  private clear() {
    const epoch = ++this.epoch
    this.flight = null
    this.busy = true
    this.error = ''
    if (this.staged) this.camera?.release()
    this.staged = null
    this.clock = this.lookClock = this.sent = this.applied = this.rev = this.cursor = this.landed = this.rate = this.drawn = 0
    this.announced = -1
    this.sinceSettle = this.unsettled = 0
    for (const l of this.listeners) l.reset?.()
    this.emit()
    return epoch
  }

  // The log entry of the nearest copy of the stone kept at or before `to`; 0 if none.
  private nearest(to: number) {
    let best = 0
    for (const at of this.snaps) if (at <= to && at > best) best = at
    return best
  }

  // Puts the shown stone back to the copy kept at log entry `at`. False if the worker has let it
  // go, in which case nothing has changed.
  private async fromSnapshot(at: number) {
    let reply: Awaited<ReturnType<KernelClient['snapshot']>>
    try {
      reply = await this.kernel.snapshot(`${this.tag}:${at}`, 'load')
    } catch {
      this.snaps.delete(at)
      return false
    }
    this.clear()
    // A remesh of every chunk is owed: the stone waits for it as it does after a rebuild.
    this.stone.reset(this.stone.grid)
    this.sent = this.applied = at
    this.rev = reply.rev
    this.busy = false
    return true
  }

  /**
   * Applies everything up to log entry `to` (the whole queue if left out) as fast as the worker
   * can, without drawing the steps, staging the looks or dropping the offcuts, then shows the
   * result. Going back means starting the block over. Resolves once that stone's mesh has reached
   * the scene; the timeline is left paused there.
   */
  async seek(to = this.total) {
    if (this.busy || this.error) return
    to = clamp(Math.round(to), 0, this.total)
    // From the nearest copy of the stone kept on the way, back or forward, if it saves work.
    const near = this.nearest(to)
    if (to < this.applied || near > this.applied) {
      this.playing = false
      const restored = near > 0 && await this.fromSnapshot(near)
      if (!restored && to < this.applied) await this.restart()
      if (this.busy || this.error) return
    }
    const epoch = this.epoch
    this.busy = true
    this.playing = false
    if (this.staged) {
      this.camera?.release()
      this.onLookEnd(this.staged.look)
      for (const l of this.listeners) l.lookEnd?.(this.staged.look)
      this.staged = null
    }
    this.emit()
    try {
      await this.flight
      const every = Math.max(SNAP_MIN, Math.ceil(this.total / SNAPS_PER_LOG))
      while (epoch === this.epoch && this.applied < to) {
        const from = this.applied
        const mark = (Math.floor(from / every) + 1) * every
        const reply = await this.kernel.strike(this.strikes.slice(from, Math.min(to, from + SKIP_BATCH, mark)), 'shown', { silent: true })
        if (epoch !== this.epoch) return
        this.sent = this.applied = from + reply.applied
        // Passing a mark: keep a copy there for scrubbing back.
        if (this.applied === mark && !this.snaps.has(mark)) {
          await this.kernel.snapshot(`${this.tag}:${mark}`, 'save')
          if (epoch !== this.epoch) return
          this.snaps.add(mark)
        }
        this.emit()
      }
      if (epoch !== this.epoch) return
      // An empty batch that is not silent: one remesh of every chunk the skipped strikes touched.
      this.rev = (await this.kernel.strike([])).rev
      await this.stone.whenShown(this.rev)
    } catch (e) {
      if (epoch === this.epoch) this.error = e instanceof Error ? e.message : String(e)
    }
    if (epoch !== this.epoch) return
    this.skipMarks()
    this.busy = false
    void this.weigh()
    for (const l of this.listeners) l.jump?.(this.strikes, this.applied)
    this.emit()
    this.release()
  }

  /** The stone as it stood when pass `index` (0-based) had just been finished; past the last pass, the whole queue. */
  seekPass(index: number) {
    const pass = this.passes[Math.max(0, Math.round(index))]
    return this.seek(pass ? pass.end : this.total)
  }

  /**
   * Takes the queue as already on the stone at `rev`: a saved log was played straight onto the
   * shown stone, so there is nothing left to play.
   */
  adopt(rev: number) {
    this.sent = this.applied = this.total
    this.rev = rev
    this.skipMarks()
    void this.weigh()
    for (const l of this.listeners) l.jump?.(this.strikes, this.applied)
    this.emit()
  }

  dispose() {
    this.epoch++
    this.playing = false
    if (this.staged) this.camera?.release()
    this.staged = null
    this.onChange = this.onPass = this.onPassEnd = this.onLook = this.onLookEnd = this.onSketch = () => {}
    for (const l of this.listeners) l.end?.()
    this.listeners.clear()
    for (const done of this.waiters.slice()) done()
  }

  // ---------- inside ----------

  // Asks the worker what the shown stone weighs. Between askings the batches' own removals keep the figure current.
  private async weigh() {
    const epoch = this.epoch
    this.mass = null
    try {
      const { massKg } = await this.kernel.stats(false, 'shown')
      if (epoch !== this.epoch) return
      this.mass = massKg
      this.emit()
    } catch {
      // the worker has no stone yet; the next restart asks again
    }
  }

  // The marks up to where the stone now stands are behind it: no subtitle or look is owed for them.
  // A look taken exactly where the stone stands has not happened yet, unless that is the end of the queue.
  private skipMarks() {
    const at = this.applied
    const all = at >= this.total
    this.clock = at > 0 ? this.ends[at - 1]! : 0
    while (this.cursor < this.marks.length) {
      const mark = this.marks[this.cursor]!
      if (!all && (mark.kind === 'pass' ? mark.start : mark.at) >= at) break
      if (mark.kind === 'pass') this.announced = mark.index
      this.cursor++
    }
    this.landed = 0
    while (this.landed < this.passes.length && this.passes[this.landed]!.end <= this.applied && this.passes[this.landed]!.index <= this.announced) this.landed++
    this.sinceSettle = this.unsettled = 0
  }

  // Announces the passes whose first strike is on its way and stages the look that has come due.
  private act() {
    while (this.cursor < this.marks.length) {
      const mark = this.marks[this.cursor]!
      if (mark.kind === 'pass') {
        const started = this.sent > mark.start || (mark.end === mark.start && this.applied >= mark.start)
        if (!started) break
        this.announced = mark.index
        this.cursor++
        this.onPass(mark.pass, mark.index)
        for (const l of this.listeners) l.pass?.(mark.pass, mark.index)
        this.land()
      } else {
        if (this.applied < mark.at || this.flight) break
        this.cursor++
        this.beginLook(mark.look)
        break
      }
    }
  }

  private land() {
    while (this.landed < this.passes.length) {
      const pass = this.passes[this.landed]!
      if (pass.index > this.announced || this.applied < pass.end) break
      this.landed++
      this.onPassEnd(pass.pass, pass.index)
      for (const l of this.listeners) l.passEnd?.(pass.pass, pass.index)
    }
  }

  // Strikes may be handed over up to the next look: the hand stops there.
  private limit() {
    for (let i = this.cursor; i < this.marks.length; i++) {
      const mark = this.marks[i]!
      if (mark.kind === 'look') return mark.at
    }
    return this.total
  }

  // The rate the timeline is aiming for, virtual seconds per second.
  private aim(): number {
    if (this.speed === 'max') return Infinity
    if (!this.elastic) return this.speed
    const speed = this.speed
    const backlog = (this.totalMs - this.clock) / 1000
    const drain = Math.min(DRAIN_MAX_S, DRAIN_S / speed)
    // Once nothing more can arrive there is no reason to dawdle.
    const floor = this.open ? Math.max(FLOOR, speed / 8) : speed
    return clamp(backlog / drain, floor, speed * CEILING)
  }

  // The rate for this tick: the aim, eased so that a pass landing in the queue does not jerk the hand.
  private pace(dt: number): number {
    const aim = this.aim()
    if (!this.elastic || aim === Infinity || this.rate === 0 || this.rate === Infinity) this.rate = aim
    else this.rate += (aim - this.rate) * (1 - Math.exp(-dt / EASE_S))
    return this.rate
  }

  private lookSeconds(look: L): number {
    if (this.speed === 'max') return 0
    const speed = this.speed
    // Quicker at a higher speed setting (by its square root: a walk at 60× would be a blur), and a
    // little quicker again when the hand is running at the top of its band.
    const haste = clamp(Math.sqrt(speed / 4), 0.8, 3) * (this.elastic ? clamp(this.aim() / (speed * 4), 1, 1.5) : 1)
    return Math.max(LOOK_MIN_S * Math.min(1, this.lookScale), (LOOK_WALK_S * Math.min(look.views.length, LOOK_VIEWS) + LOOK_HOLD_S) * (look.linger ?? 1) * this.lookScale / haste)
  }

  // Screen seconds the queue would take at the pace being aimed for.
  private behind(): number {
    const aim = this.aim()
    if (aim === Infinity) return 0
    let seconds = (this.totalMs - this.clock) / 1000 / Math.max(aim, 0.01)
    if (this.staged) seconds += Math.max(0, this.staged.left)
    for (let i = this.cursor; i < this.marks.length; i++) {
      const mark = this.marks[i]!
      if (mark.kind === 'look') seconds += this.lookSeconds(mark.look)
    }
    return seconds
  }

  private holding(): boolean {
    if (this.error || !this.elastic) return false
    if (!this.playing) return true
    const behind = this.behind()
    this.gated = this.gated ? behind > UNGATE_S : behind > GATE_S
    return this.gated
  }

  private release() {
    if (!this.waiters.length || this.holding()) return
    for (const done of this.waiters.slice()) done()
  }

  private beginLook(look: L) {
    // Whatever the last strikes cut free falls before the sculptor steps back.
    if (this.settles && this.unsettled > 0) {
      this.unsettled = 0
      this.sinceSettle = 0
      this.kernel.strike([], 'shown', { settle: true }).catch(() => {})
    }
    const seconds = this.lookSeconds(look)
    this.onLook(look)
    for (const l of this.listeners) l.look?.(look, seconds)
    if (seconds <= 0) {
      this.onLookEnd(look)
      for (const l of this.listeners) l.lookEnd?.(look)
      return
    }
    // The same share of a shortened look goes on walking as of a full one.
    const stops = Math.max(1, Math.min(look.views.length, LOOK_VIEWS))
    const perStop = seconds * LOOK_WALK_S / (LOOK_WALK_S * stops + LOOK_HOLD_S)
    this.camera?.walk(look.views.slice(0, LOOK_VIEWS), perStop, look.close === true, look.macro)
    this.staged = { look, left: seconds }
    this.emit()
  }

  private endLook() {
    const staged = this.staged
    if (!staged) return
    this.staged = null
    this.camera?.release()
    this.onLookEnd(staged.look)
    for (const l of this.listeners) l.lookEnd?.(staged.look)
    this.emit()
    this.release()
  }

  private async send(from: number, to: number, epoch: number) {
    this.sent = to
    const batch = this.strikes.slice(from, to)
    // A batch with one of the log's own island checks in it needs no early one: a log whose
    // passes check every couple of seconds of work (the hand does since Sprint 3) is left alone,
    // and only an older log, or a slow stretch between two checks, gets these.
    const checked = batch.some(strike => strike.kind === 'detach')
    const settle = this.settles && this.speed !== 'max' && this.sinceSettle >= SETTLE_S && !checked
    if (settle || checked) this.sinceSettle = 0
    // A line is drawn as its entry is handed over, so it is on the stone before the pass after
    // it is announced (and that pass, if it cuts, may wipe it). Once only: an entry the worker's
    // budget left out is handed over again, by which time that pass has been announced and the
    // line would be drawn back over stone that is already going.
    for (let i = Math.max(from, this.drawn); i < to; i++) {
      const strike = this.strikes[i]!
      if (strike.kind === 'sketch') this.onSketch(strike)
    }
    this.drawn = Math.max(this.drawn, to)
    try {
      const reply = await this.kernel.strike(batch, 'shown', { budgetMs: this.budgetMs, ...(settle ? { settle: true } : {}) })
      if (epoch !== this.epoch) return
      // Whatever the budget left out is offered again on the next tick.
      this.sent = this.applied = from + reply.applied
      this.rev = reply.rev
      if (this.mass !== null) this.mass -= reply.removedCm3 * DENSITY / 1000
      for (let i = 0; i < reply.applied; i++) {
        const strike = batch[i]!
        if (strike.kind === 'detach') this.unsettled = 0
        else if (strike.kind === 'cut' || strike.kind === 'saw') this.unsettled++
      }
      if (settle) this.unsettled = 0
      if (this.listeners.size) this.tell(batch, from, reply.applied, reply.removedCm3)
    } catch (e) {
      if (epoch !== this.epoch) return
      this.error = e instanceof Error ? e.message : String(e)
      this.playing = false
    }
    this.flight = null
    this.flightS = 0
    this.land()
    if (!this.open && this.caughtUp()) this.clock = this.totalMs
    this.emit()
    this.release()
  }

  // Tells the listeners which cuts and saw cuts of a batch went in. What the batch removed is
  // shared out by each cut's nominal bite; a batch with a saw in it cannot be shared (the slab is
  // in the figure), so its cuts are given their nominal bite as it stands.
  private tell(batch: Strike[], from: number, applied: number, removedCm3: number) {
    const events: StrikeEvent[] = []
    let nominal = 0
    let sawn = false
    for (let i = 0; i < applied; i++) {
      const strike = batch[i]!
      if (strike.kind === 'saw') {
        sawn = true
        events.push({ kind: 'saw', tool: 'saw', at: strike.plane.point, dir: strike.plane.normal, size: 0, depth: 0, removedCm3: 0, seed: from + i, ms: strike.ms, atMs: this.ends[from + i]!, index: from + i })
      } else if (strike.kind === 'cut') {
        const spec = TOOLS[strike.tool]
        // The rasp only takes the high spots and the polish takes nothing.
        const bite = !spec || spec.mode === 'burnish' ? 0 : spec.mode === 'abrade' ? strike.size * strike.size * strike.depth * 0.02 : nominalBiteCm3(spec, strike.size, strike.depth)
        nominal += bite
        events.push({ kind: 'cut', tool: strike.tool, at: strike.at, dir: strike.dir, size: strike.size, depth: strike.depth, removedCm3: bite, seed: strike.seed, ms: strike.ms, atMs: this.ends[from + i]!, index: from + i })
      }
    }
    if (!events.length) return
    const share = sawn || nominal <= 0 ? 0.6 : Math.min(1.5, removedCm3 / nominal)
    for (const event of events) event.removedCm3 *= share
    const rate = this.rate > 0 && this.rate !== Infinity ? this.rate : 1
    for (const l of this.listeners) l.strikes?.(events, rate)
  }

  private emit() {
    const state = this.state()
    this.onChange(state)
    for (const l of this.listeners) l.change?.(state)
  }
}
