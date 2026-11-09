/**
 * The studio's sound, all of it synthesised with Web Audio. There are no samples: the few
 * buffers used (noise, a scatter of chips, a tumble of rubble) are filled from a seeded generator
 * when the context starts.
 *
 *   a blow     the mallet's thud (a falling sine and a knock of noise), the chisel's ring (three
 *              inharmonic partials pitched by the tool and the width of its edge: the point bright,
 *              the claw buzzing, the flat duller and shorter), a crack of stone, chips scattering
 *   a slab     a low thump with a body of filtered noise, a crack, and a tail of rubble; lower
 *              and longer when the film is in slow motion
 *   saw, rasp, pad, drill   one looped voice each, shaped by the stroke
 *   the room   brown noise under everything, breathing slowly
 *
 * No two blows are the same: the partials, the thud and the scatter each go round a small set of
 * variations, with a few per cent of detune on top. A sound is placed lightly: panned by where
 * its source is on screen and a little quieter further off (`place`).
 *
 * Density is capped, not machine-gunned: BLOWS_PER_S blows a second at most, however fast the
 * replay; MAX_VOICES one-shot voices at once; anything over is dropped. See stats().
 *
 * Browsers only start audio on a user gesture, so nothing exists until unlock() is called from
 * one (arm() listens for the first pointer or key press). Before that, and when muted, every call
 * here is a no-op. `muted` and setMuted() are for the HUD.
 */
import { createRng } from '#shared/sculpt/rng'
import type { ToolId } from '#shared/sculpt/types'
import type { StrikeEvent } from './timeline'

export interface Placement {
  /** -1 (left) to 1 (right). */
  pan: number
  /** Loudness for distance: about 1 at the opening view, more close in, less far off. */
  gain: number
}

export interface SoundOptions {
  place?: (x: number, y: number, z: number) => Placement
}

/** The caps (reported by stats()). */
export const BLOWS_PER_S = 9
export const MAX_VOICES = 28
const IMPACT_GAP_S = 0.06
const MASTER = 0.8
// A struck sound is let run this many times its decay (to a tenth) before its source is stopped: 50 dB down.
const RING_OUT = 2.5
const MUTE_KEY = 'sculptor:muted'

// The chisel's ring: fundamental for a 5 cm edge, Hz; how long it sings, s; and how loud against the thud.
const RING: Partial<Record<ToolId, { hz: number, decay: number, gain: number, wave: OscillatorType }>> = {
  point: { hz: 3350, decay: 0.17, gain: 1, wave: 'sine' },
  claw: { hz: 2550, decay: 0.1, gain: 0.55, wave: 'sawtooth' },
  flat: { hz: 2050, decay: 0.07, gain: 0.7, wave: 'triangle' },
  roundel: { hz: 2300, decay: 0.085, gain: 0.7, wave: 'sine' }
}
// Partials of a struck bar, and four ways of weighting them.
const PARTIALS = [1, 2.76, 5.4]
const WEIGHTS = [[1, 0.5, 0.22], [1, 0.34, 0.3], [0.85, 0.6, 0.16], [1, 0.42, 0.1]]
const THUDS = [1, 0.91, 1.08, 0.96, 1.03]

interface Loop {
  gain: GainNode
  filter: BiquadFilterNode
  pan: StereoPannerNode
  level: number
}

export class Sound {
  private ctx: BaseAudioContext | null = null
  private master: GainNode | null = null
  private white: AudioBuffer | null = null
  private scatters: AudioBuffer[] = []
  private rubbles: AudioBuffer[] = []
  private loops: { saw: Loop, rasp: Loop, drill: Loop, room: Loop } | null = null
  private drillTone: GainNode | null = null
  private isMuted = false
  private paused = false
  private place: (x: number, y: number, z: number) => Placement
  private tokens = 3
  private sinceBlow = 1
  private sinceImpact = 1
  private round = 0
  private voices = 0
  private nodes = 0
  private peakNodes = 0
  private persistent = 0
  private dropped = 0
  private played = 0
  private clock = 0
  private sounding: { until: number, nodes: number }[] = []
  // Continuous voices: seconds each is still wanted for, and where it is.
  private sawOn = false
  private raspHold = 0
  private raspSoft = false
  private drillHold = 0
  private at: [number, number, number] = [0, 50, 0]
  private disarm: (() => void) | null = null

  constructor(options: SoundOptions = {}) {
    this.place = options.place ?? (() => ({ pan: 0, gain: 1 }))
    try {
      this.isMuted = localStorage.getItem(MUTE_KEY) === '1'
    } catch {
      // no storage: not muted
    }
  }

  get muted() {
    return this.isMuted
  }

  /** Whether a gesture has started the audio context. */
  get unlocked() {
    return this.ctx !== null
  }

  setMuted(muted: boolean) {
    this.isMuted = muted
    try {
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0')
    } catch {
      // not remembered, then
    }
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : MASTER, this.ctx.currentTime, 0.03)
  }

  /** Starts audio on the first pointer or key press anywhere in the window. */
  arm() {
    if (this.ctx || this.disarm) return
    const go = () => this.unlock()
    window.addEventListener('pointerdown', go, { capture: true })
    window.addEventListener('keydown', go, { capture: true })
    this.disarm = () => {
      window.removeEventListener('pointerdown', go, { capture: true })
      window.removeEventListener('keydown', go, { capture: true })
      this.disarm = null
    }
  }

  /**
   * Builds the audio graph. Only does anything when called from a user gesture, unless it is
   * handed a context of its own (an OfflineAudioContext, to render the sounds for a test).
   */
  unlock(into?: BaseAudioContext) {
    this.disarm?.()
    if (this.ctx) {
      if (this.ctx instanceof AudioContext && this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    let ctx: BaseAudioContext
    try {
      ctx = into ?? new AudioContext({ latencyHint: 'interactive' })
    } catch {
      return
    }
    this.ctx = ctx
    if (ctx instanceof AudioContext) void ctx.resume()
    const squash = ctx.createDynamicsCompressor()
    squash.threshold.value = -14
    squash.ratio.value = 5
    squash.attack.value = 0.003
    squash.release.value = 0.18
    const master = ctx.createGain()
    master.gain.value = this.isMuted ? 0 : MASTER
    master.connect(squash).connect(ctx.destination)
    this.master = master
    this.fillBuffers(ctx)
    this.buildLoops(ctx, master)
  }

  stats() {
    return {
      state: this.ctx ? this.ctx.state : 'locked',
      muted: this.isMuted,
      voices: this.voices,
      nodes: this.nodes + this.persistent,
      persistentNodes: this.persistent,
      peakNodes: this.peakNodes + this.persistent,
      played: this.played,
      dropped: this.dropped,
      caps: { blowsPerS: BLOWS_PER_S, voices: MAX_VOICES }
    }
  }

  // ---------- what it is told ----------

  /** Cuts as they land. Chisel blows sound at once; the rasp, pad and drill keep their voice going. */
  strikes(events: StrikeEvent[]) {
    for (const event of events) {
      if (event.kind !== 'cut') continue
      this.at = event.at
      if (event.tool === 'rasp' || event.tool === 'polish') {
        this.raspHold = 0.35
        this.raspSoft = event.tool === 'polish'
      } else if (event.tool === 'drill') {
        this.drillHold = 0.4
      } else {
        this.blow(event)
      }
    }
  }

  /** The saw is in its cut (true, with where) or out of it. */
  saw(on: boolean, x = 0, y = 50, z = 0) {
    this.sawOn = on
    if (on) this.at = [x, y, z]
  }

  /** A piece has landed. `cm3` and `speed` (cm/s lost) say how hard; `slow` is the film's time scale. */
  impact(cm3: number, speed: number, x: number, y: number, z: number, broke: boolean, slow = 1) {
    const ctx = this.ctx
    if (!ctx || !this.master || this.isMuted) return
    if (this.sinceImpact < IMPACT_GAP_S || this.voices >= MAX_VOICES) {
      this.dropped++
      return
    }
    this.sinceImpact = 0
    const weight = Math.max(0.12, Math.min(1, cm3 / 15000)) * Math.max(0.3, Math.min(1.2, speed / 300))
    const where = this.place(x, y, z)
    const level = weight * Math.min(1.3, where.gain)
    // Slowed down, everything drops in pitch and stretches.
    const pitch = Math.pow(Math.max(0.2, slow), 0.45)
    const now = ctx.currentTime + 0.004
    const pan = ctx.createStereoPanner()
    pan.pan.value = where.pan
    pan.connect(this.master)
    let count = 1

    const thump = ctx.createOscillator()
    thump.frequency.setValueAtTime((70 + weight * 16) * pitch, now)
    thump.frequency.exponentialRampToValueAtTime(34 * pitch, now + 0.32 / pitch)
    const thumpGain = this.envelope(ctx, now, 0.004, 0.9 * level, 0.5 / pitch)
    thump.connect(thumpGain).connect(pan)
    thump.start(now)
    thump.stop(now + 0.5 * RING_OUT / pitch)
    count += 2

    count += this.burst(ctx, pan, now, 'lowpass', 240 * pitch, 0.7, 1.1 * level, 0.3 / pitch)
    count += this.burst(ctx, pan, now, 'bandpass', 1700 * pitch, 0.6, 0.7 * level, 0.07)
    if (weight > 0.2 && this.rubbles.length) {
      const tail = ctx.createBufferSource()
      tail.buffer = this.rubbles[this.round++ % this.rubbles.length]!
      tail.playbackRate.value = (0.85 + (this.round % 3) * 0.1) * pitch
      const tailGain = ctx.createGain()
      tailGain.gain.value = (broke ? 1 : 0.6) * level
      tail.connect(tailGain).connect(pan)
      tail.start(now + 0.02)
      count += 2
    }
    this.track(count, Math.min(4, 1.6 / pitch))
  }

  /** The timeline is paused: the tools fall silent, the room does not. */
  setPaused(paused: boolean) {
    this.paused = paused
    if (paused) this.sawOn = false
  }

  /** Refills the budget and shapes the continuous voices. `dt` is film time, s. */
  update(dt: number) {
    this.tokens = Math.min(3, this.tokens + BLOWS_PER_S * dt)
    this.sinceBlow += dt
    this.sinceImpact += dt
    this.clock += dt
    if (this.sounding.length) {
      this.sounding = this.sounding.filter((voice) => {
        if (voice.until > this.clock) return true
        this.voices--
        this.nodes -= voice.nodes
        return false
      })
    }
    this.raspHold -= dt
    this.drillHold -= dt
    const ctx = this.ctx
    const loops = this.loops
    if (!ctx || !loops) return
    const now = ctx.currentTime
    const where = this.place(this.at[0], this.at[1], this.at[2])
    const set = (loop: Loop, level: number, hz?: number) => {
      loop.gain.gain.setTargetAtTime(level * loop.level * Math.min(1.3, where.gain), now, 0.03)
      loop.pan.pan.setTargetAtTime(where.pan, now, 0.1)
      if (hz) loop.filter.frequency.setTargetAtTime(hz, now, 0.03)
    }
    const quiet = this.paused
    // The saw: two pushes to a stroke, the pitch of the rasping lifting on each.
    const push = Math.abs(Math.sin(this.clock * Math.PI * 2 * 1.5))
    set(loops.saw, this.sawOn && !quiet ? 0.2 + 0.8 * Math.pow(push, 0.7) : 0, 1150 + push * 650)
    const rub = Math.abs(Math.sin(this.clock * Math.PI * 2 * 2.1))
    set(loops.rasp, this.raspHold > 0 && !quiet ? (this.raspSoft ? 0.3 : 1) * (0.3 + 0.7 * rub) : 0, this.raspSoft ? 5200 : 2900 + rub * 900)
    set(loops.drill, this.drillHold > 0 && !quiet ? 0.8 + 0.2 * Math.sin(this.clock * 31) : 0)
    loops.room.gain.gain.setTargetAtTime(loops.room.level * (0.85 + 0.15 * Math.sin(this.clock * 0.43)), now, 0.5)
  }

  dispose() {
    this.disarm?.()
    if (this.ctx instanceof AudioContext) void this.ctx.close()
    this.ctx = null
    this.master = null
    this.loops = null
  }

  // ---------- inside ----------

  private blow(event: StrikeEvent) {
    const ctx = this.ctx
    if (!ctx || !this.master || this.isMuted || this.paused) return
    if (this.tokens < 1 || this.sinceBlow < 0.07 || this.voices >= MAX_VOICES) {
      this.dropped++
      return
    }
    this.tokens--
    this.sinceBlow = 0
    this.played++
    const round = this.round++
    const where = this.place(event.at[0], event.at[1], event.at[2])
    const force = Math.max(0.25, Math.min(1, event.size * 0.05 + event.depth * 0.18))
    const level = force * Math.min(1.3, where.gain)
    const now = ctx.currentTime + 0.004
    const pan = ctx.createStereoPanner()
    pan.pan.value = where.pan
    pan.connect(this.master)
    let count = 1

    // The mallet: wood on steel.
    const thud = ctx.createOscillator()
    const tune = THUDS[round % THUDS.length]!
    thud.frequency.setValueAtTime(165 * tune, now)
    thud.frequency.exponentialRampToValueAtTime(68 * tune, now + 0.07)
    const thudGain = this.envelope(ctx, now, 0.002, 0.5 * level, 0.07)
    thud.connect(thudGain).connect(pan)
    thud.start(now)
    thud.stop(now + 0.07 * RING_OUT)
    count += 2
    count += this.burst(ctx, pan, now, 'bandpass', 820 + (round % 4) * 70, 0.9, 0.8 * level, 0.03)

    // The chisel's ring.
    const ring = RING[event.tool] ?? RING.flat!
    const hz = ring.hz * Math.max(0.72, Math.min(1.45, Math.pow(5 / Math.max(1, event.size), 0.3))) * (1 + (((round * 7919) % 61) / 61 - 0.5) * 0.07)
    const weights = WEIGHTS[round % WEIGHTS.length]!
    const sings = ring.decay * (0.8 + force * 0.5)
    const ringGain = this.envelope(ctx, now, 0.001, 0.11 * ring.gain * level, sings)
    ringGain.connect(pan)
    count += 1
    for (let i = 0; i < PARTIALS.length; i++) {
      const partial = ctx.createOscillator()
      partial.type = i === 0 ? ring.wave : 'sine'
      partial.frequency.value = hz * PARTIALS[i]!
      const weight = ctx.createGain()
      weight.gain.value = weights[i]!
      partial.connect(weight).connect(ringGain)
      partial.start(now)
      partial.stop(now + sings * RING_OUT)
      count += 2
    }

    // Stone giving, and what flies off it.
    count += this.burst(ctx, pan, now, 'highpass', 4200, 0.5, 0.4 * level, 0.012)
    if (event.removedCm3 > 1.5 && this.scatters.length) {
      const scatter = ctx.createBufferSource()
      scatter.buffer = this.scatters[round % this.scatters.length]!
      scatter.playbackRate.value = 0.9 + ((round * 31) % 7) * 0.035
      const scatterGain = ctx.createGain()
      scatterGain.gain.value = 0.5 * Math.min(1, event.removedCm3 / 45 + 0.25) * Math.min(1.3, where.gain)
      scatter.connect(scatterGain).connect(pan)
      scatter.start(now + 0.03)
      count += 2
    }
    this.track(count, Math.max(0.5, sings * RING_OUT))
  }

  // A gain that jumps to `peak` and dies away: the shape of everything that is hit. `decay` is
  // how long it takes to fall to a tenth; whatever feeds it should run for RING_OUT times that.
  private envelope(ctx: BaseAudioContext, at: number, attack: number, peak: number, decay: number) {
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(peak, at + attack)
    gain.gain.setTargetAtTime(0, at + attack, decay / 2.3)
    return gain
  }

  // A burst of filtered noise; returns how many nodes it made.
  private burst(ctx: BaseAudioContext, to: AudioNode, at: number, type: BiquadFilterType, hz: number, q: number, peak: number, decay: number) {
    const source = ctx.createBufferSource()
    source.buffer = this.white
    const filter = ctx.createBiquadFilter()
    filter.type = type
    filter.frequency.value = hz
    filter.Q.value = q
    source.connect(filter).connect(this.envelope(ctx, at, 0.001, peak, decay)).connect(to)
    // Somewhere different in the noise each time.
    source.start(at, (this.round * 0.137) % 1.2, decay * RING_OUT + 0.02)
    return 3
  }

  // Counts a one-shot voice and its nodes for as long as it sounds, by this file's own clock
  // (the audio graph lets go of the nodes itself once their sources have stopped).
  private track(nodes: number, seconds: number) {
    this.voices++
    this.nodes += nodes
    if (this.nodes > this.peakNodes) this.peakNodes = this.nodes
    this.sounding.push({ until: this.clock + seconds, nodes })
  }

  private fillBuffers(ctx: BaseAudioContext) {
    const rate = ctx.sampleRate
    const rng = createRng(1508)
    const white = ctx.createBuffer(1, rate * 2, rate)
    const w = white.getChannelData(0)
    for (let i = 0; i < w.length; i++) w[i] = rng.range(-1, 1)
    this.white = white

    // Ticks of stone on stone: `ticks` short decaying bursts spread over the buffer, thick at
    // the start. `dull` low-passes them (rubble) where chips are left bright.
    const tumble = (seconds: number, ticks: number, shortest: number, longest: number, dull: number, fade: number) => {
      const buffer = ctx.createBuffer(1, Math.ceil(rate * seconds), rate)
      const data = buffer.getChannelData(0)
      for (let t = 0; t < ticks; t++) {
        const start = Math.floor(rng.next() ** 1.8 * (seconds - longest) * rate)
        const tau = rng.range(shortest, longest) * rate
        const loud = rng.range(0.25, 1) * Math.exp(-start / rate / fade)
        let last = 0
        let low = 0
        for (let i = 0; i < tau * 5 && start + i < data.length; i++) {
          const noise = rng.range(-1, 1)
          // Bright: the difference of successive samples. Dull: a running average.
          low += (noise - low) * dull
          const sample = dull < 1 ? low * 2.2 : noise - last * 0.92
          last = noise
          data[start + i] = data[start + i]! + sample * loud * Math.exp(-i / tau)
        }
      }
      return buffer
    }
    for (let i = 0; i < 6; i++) this.scatters.push(tumble(0.45, 5 + rng.int(8), 0.0012, 0.004, 1, 0.2))
    for (let i = 0; i < 3; i++) this.rubbles.push(tumble(1.5, 34 + rng.int(20), 0.004, 0.018, 0.22, 0.45))
  }

  private buildLoops(ctx: BaseAudioContext, master: GainNode) {
    // One looping noise source feeds every continuous voice.
    const noise = ctx.createBufferSource()
    noise.buffer = this.white
    noise.loop = true
    noise.start()
    const loop = (type: BiquadFilterType, hz: number, q: number, level: number, from: AudioNode = noise): Loop => {
      const filter = ctx.createBiquadFilter()
      filter.type = type
      filter.frequency.value = hz
      filter.Q.value = q
      const gain = ctx.createGain()
      gain.gain.value = 0
      const pan = ctx.createStereoPanner()
      from.connect(filter).connect(gain).connect(pan).connect(master)
      return { gain, filter, pan, level }
    }
    // Brown-ish noise for the room: white through a very low filter, then the band the air sits in.
    const rumble = ctx.createBiquadFilter()
    rumble.type = 'lowpass'
    rumble.frequency.value = 90
    noise.connect(rumble)
    const boost = ctx.createGain()
    boost.gain.value = 9
    rumble.connect(boost)
    const room = loop('lowpass', 420, 0.3, 0.03, boost)
    room.gain.gain.value = room.level

    const saw = loop('bandpass', 1400, 1.2, 0.55)
    const rasp = loop('bandpass', 3000, 0.7, 0.2)
    // The drill: a low buzz and the grind of the bit.
    const buzz = ctx.createOscillator()
    buzz.type = 'sawtooth'
    buzz.frequency.value = 94
    buzz.start()
    const drill = loop('bandpass', 2100, 0.8, 0.12)
    const tone = ctx.createGain()
    tone.gain.value = 0.5
    const soften = ctx.createBiquadFilter()
    soften.type = 'lowpass'
    soften.frequency.value = 700
    buzz.connect(soften).connect(tone).connect(drill.gain)
    this.drillTone = tone
    this.loops = { saw, rasp, drill, room }
    // noise, rumble, boost, buzz, soften, tone, four loops of three, the master and the compressor.
    this.persistent = 6 + 4 * 3 + 2
  }
}
