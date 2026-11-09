/**
 * The page's end of the kernel: requests as promises, chunk geometry and offcuts as callbacks.
 * The stones themselves never leave their workers.
 *
 * There are two workers running the same script, one for each copy of the stone. The shown
 * stone's applies strikes and remeshes; the true stone's runs the Studio: the hand, the looks,
 * the reference sheet. Apart they cannot hold each other up: working out a rough-out takes the
 * true stone's worker two or three seconds, and the stone on screen goes on being struck meanwhile.
 */
import type { StudioResult, ToolCall } from '#shared/agent/types'
import type { FromKernel, ReferencedReply, StatsReply, StoneId, StruckReply, ToKernel } from '#shared/sculpt/protocol'
import type { ChunkMesh, GridInfo, GridOptions, Offcut, RayHit, Strike, Vec3 } from '#shared/sculpt/types'

type Reply = Extract<FromKernel, { id: number }>

/** ToKernel minus the id, which request() stamps. Written per variant so the union survives. */
type Request = ToKernel extends infer M ? M extends { id: number } ? Omit<M, 'id'> : never : never

export class KernelClient {
  /** Called with every remesh, in order. The arrays are this thread's to keep. */
  onChunks: (stone: StoneId, rev: number, chunks: ChunkMesh[]) => void = () => {}
  onOffcuts: (stone: StoneId, rev: number, offcuts: Offcut[]) => void = () => {}

  private workers: Record<StoneId, Worker>
  private waiting = new Map<number, { resolve: (reply: Reply) => void, reject: (e: Error) => void }>()
  private nextId = 1
  // An init in progress: how many workers have still to report, and the layout to resolve with.
  private ready: { resolve: (grid: GridInfo) => void, reject: (e: Error) => void, left: number, grid: GridInfo | null } | null = null

  constructor() {
    const start = () => {
      const worker = new Worker(new URL('../workers/kernel.worker.ts', import.meta.url), { type: 'module' })
      worker.addEventListener('message', (e: MessageEvent<FromKernel>) => this.receive(e.data))
      worker.addEventListener('error', e => this.fail(new Error(e.message || 'the kernel worker failed to start')))
      return worker
    }
    this.workers = { shown: start(), true: start() }
  }

  /**
   * Builds the block, replacing any the workers already hold: both stones fresh, no Studio, no
   * reference sheet. Resolves with its layout; the first mesh follows through onChunks at rev 0.
   */
  init(options?: Partial<GridOptions>) {
    return new Promise<GridInfo>((resolve, reject) => {
      this.ready = { resolve, reject, left: 2, grid: null }
      this.workers.shown.postMessage({ type: 'init', options, stones: ['shown'] } satisfies ToKernel)
      this.workers.true.postMessage({ type: 'init', options, stones: ['true'] } satisfies ToKernel)
    })
  }

  /** A fresh shown stone on the block the worker already holds; the true stone stays as it is. */
  reshow() {
    return new Promise<GridInfo>((resolve, reject) => {
      this.ready = { resolve, reject, left: 1, grid: null }
      this.workers.shown.postMessage({ type: 'init', only: 'shown' } satisfies ToKernel)
    })
  }

  /**
   * Applies log entries in order. Rejects if one of them threw; the ones before it stay applied.
   * With `budgetMs` the worker may stop early (see `applied`); `silent` applies without drawing;
   * `settle` drops whatever the batch cut free on screen straight away (shown stone only).
   */
  async strike(strikes: Strike[], stone: StoneId = 'shown', options: { budgetMs?: number, silent?: boolean, settle?: boolean } = {}): Promise<StruckReply> {
    const reply = await this.request({ type: 'strikes', stone, strikes, ...options })
    if (reply.type !== 'struck') throw new Error(`unexpected reply: ${reply.type}`)
    if (reply.error) throw new Error(reply.error)
    return reply
  }

  async raycast(origin: Vec3, dir: Vec3, stone: StoneId = 'shown'): Promise<RayHit | null> {
    const reply = await this.request({ type: 'raycast', stone, origin, dir })
    if (reply.type !== 'rayhit') throw new Error(`unexpected reply: ${reply.type}`)
    return reply.hit
  }

  async stats(hash = false, stone: StoneId = 'shown'): Promise<StatsReply> {
    const reply = await this.request({ type: 'stats', stone, hash })
    if (reply.type !== 'stats') throw new Error(`unexpected reply: ${reply.type}`)
    return reply
  }

  /** Hands the true stone's worker the commission's reference sheet (an image file, or null for none) to trace and keep for the Studio. */
  async reference(image: Uint8Array | null): Promise<ReferencedReply> {
    const reply = await this.request({ type: 'reference', image })
    if (reply.type !== 'referenced') throw new Error(`unexpected reply: ${reply.type}`)
    return reply
  }

  /** One validated tool call for the Studio, against the true stone. Rejects with the Studio's words if it refuses the call. */
  async run(call: ToolCall): Promise<StudioResult> {
    const reply = await this.request({ type: 'run', call })
    if (reply.type !== 'ran') throw new Error(`unexpected reply: ${reply.type}`)
    if (reply.error !== undefined || !reply.result) throw new Error(reply.error ?? 'the studio sent no result')
    return reply.result
  }

  /** Shuts the workers down. Requests still waiting are dropped unanswered: whoever asked is being torn down too. */
  dispose() {
    this.workers.shown.terminate()
    this.workers.true.terminate()
    this.ready = null
    this.waiting.clear()
  }

  private request(message: Request) {
    return new Promise<Reply>((resolve, reject) => {
      const id = this.nextId++
      this.waiting.set(id, { resolve, reject })
      // The Studio and the reference sheet live with the true stone.
      const stone: StoneId = 'stone' in message ? message.stone : 'true'
      this.workers[stone].postMessage({ ...message, id })
    })
  }

  private receive(msg: FromKernel) {
    if (msg.type === 'ready') {
      const ready = this.ready
      if (!ready) return
      if (msg.stones.includes('shown')) ready.grid = msg.grid
      if (--ready.left > 0) return
      this.ready = null
      ready.resolve(ready.grid ?? msg.grid)
    } else if (msg.type === 'chunks') {
      this.onChunks(msg.stone, msg.rev, msg.chunks)
    } else if (msg.type === 'offcuts') {
      this.onOffcuts(msg.stone, msg.rev, msg.offcuts)
    } else if (msg.type === 'error') {
      const error = new Error(msg.message)
      const waiter = msg.id === undefined ? null : this.waiting.get(msg.id)
      if (waiter) {
        this.waiting.delete(msg.id!)
        waiter.reject(error)
      } else if (this.ready) {
        this.ready.reject(error)
        this.ready = null
      } else {
        console.error('[kernel]', msg.message)
      }
    } else {
      const waiter = this.waiting.get(msg.id)
      this.waiting.delete(msg.id)
      waiter?.resolve(msg)
    }
  }

  private fail(error: Error) {
    this.ready?.reject(error)
    this.ready = null
    for (const waiter of this.waiting.values()) waiter.reject(error)
    this.waiting.clear()
  }
}
