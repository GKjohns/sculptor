/**
 * The page's end of the kernel worker: requests as promises, chunk geometry and offcuts as callbacks.
 * The stone itself never leaves the worker.
 */
import type { FromKernel, StatsReply, StoneId, StruckReply, ToKernel } from '#shared/sculpt/protocol'
import type { ChunkMesh, GridInfo, GridOptions, Offcut, RayHit, Strike, Vec3 } from '#shared/sculpt/types'

type Reply = Extract<FromKernel, { id: number }>

/** ToKernel minus the id, which request() stamps. Written per variant so the union survives. */
type Request = ToKernel extends infer M ? M extends { id: number } ? Omit<M, 'id'> : never : never

export class KernelClient {
  /** Called with every remesh, in order. The arrays are this thread's to keep. */
  onChunks: (stone: StoneId, rev: number, chunks: ChunkMesh[]) => void = () => {}
  onOffcuts: (stone: StoneId, rev: number, offcuts: Offcut[]) => void = () => {}

  private worker: Worker
  private waiting = new Map<number, { resolve: (reply: Reply) => void, reject: (e: Error) => void }>()
  private nextId = 1
  private ready: { resolve: (grid: GridInfo) => void, reject: (e: Error) => void } | null = null

  constructor() {
    this.worker = new Worker(new URL('../workers/kernel.worker.ts', import.meta.url), { type: 'module' })
    this.worker.addEventListener('message', (e: MessageEvent<FromKernel>) => this.receive(e.data))
    this.worker.addEventListener('error', e => this.fail(new Error(e.message || 'the kernel worker failed to start')))
  }

  /** Builds the block. Resolves with its layout; the first mesh follows through onChunks at rev 0. */
  init(options?: Partial<GridOptions>) {
    return new Promise<GridInfo>((resolve, reject) => {
      this.ready = { resolve, reject }
      this.post({ type: 'init', options })
    })
  }

  /** Applies log entries in order. Rejects if one of them threw; the ones before it stay applied. */
  async strike(strikes: Strike[], stone: StoneId = 'shown'): Promise<StruckReply> {
    const reply = await this.request({ type: 'strikes', stone, strikes })
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

  dispose() {
    this.worker.terminate()
    this.fail(new Error('the kernel worker was shut down'))
  }

  private post(message: ToKernel) {
    this.worker.postMessage(message)
  }

  private request(message: Request) {
    return new Promise<Reply>((resolve, reject) => {
      const id = this.nextId++
      this.waiting.set(id, { resolve, reject })
      this.post({ ...message, id })
    })
  }

  private receive(msg: FromKernel) {
    if (msg.type === 'ready') {
      this.ready?.resolve(msg.grid)
      this.ready = null
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
