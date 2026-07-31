import type { Bus } from '../core/types'
import { clamp, makeRng } from '../core/util'

export type Surface = 'ground' | 'deck' | 'metal' | 'stair' | 'water'
export type Gait = 'walk' | 'run' | 'crouch' | 'swim'

export interface AudioApi {
  /** Lazily creates the AudioContext. Must be called from a user gesture. */
  enable(): Promise<void>
  disable(): void
  /** The persisted opt-in, even while the AudioContext is still gesture-gated. */
  readonly preferred: boolean
  readonly enabled: boolean
  /** 0..1 */
  volume: number
  /** Called every frame by the walk controller. */
  step(dt: number, opts: {
    distance: number
    speed: number
    gait: Gait
    grounded: boolean
    surface: Surface
    submerged: boolean
  }): void
  /** One-shot events. */
  land(impactSpeed: number): void
  jump(): void
  splash(intensity: number): void
  dispose(): void
}

interface SurfaceVoice {
  type: BiquadFilterType
  frequency: number
  q: number
  attack: number
  decay: number
  level: number
  rate: number
}

interface Voice {
  filter: BiquadFilterNode
  gain: GainNode
}

interface StoredPreference {
  enabled: boolean
  volume: number
}

const STORAGE_KEY = 'pgsimcity.audio'
const DEFAULT_VOLUME = 0.35
const OPEN_FREQUENCY = 5600
const SUBMERGED_FREQUENCY = 620
/** The low-pass removes brightness; this gain drop makes the dry world recede. */
const SUBMERGED_LEVEL = 0.48
const VOICE_COUNT = 8
const NOISE_SECONDS = 1
const SILENCE = 0.0001

/**
 * The filter is the material:
 * - ground is a low, broad knock: damp outdoor concrete with no bright edge;
 * - deck is harder and a little more sustained, like the plaza's poured slab;
 * - metal is a bright, narrow peak whose filtered noise leaves a restrained ring;
 * - stair is a short, sharp contact from the excavation's close hard surfaces;
 * - water has a slow attack through a low-pass, so it swishes without a click.
 */
const SURFACE_VOICES: Record<Surface, SurfaceVoice> = {
  ground: { type: 'bandpass', frequency: 480, q: 0.55, attack: 0.004, decay: 0.075, level: 0.19, rate: 0.92 },
  deck: { type: 'bandpass', frequency: 920, q: 1.25, attack: 0.003, decay: 0.105, level: 0.21, rate: 1 },
  metal: { type: 'bandpass', frequency: 2050, q: 4.2, attack: 0.002, decay: 0.145, level: 0.16, rate: 1.08 },
  stair: { type: 'bandpass', frequency: 1500, q: 1.1, attack: 0.002, decay: 0.055, level: 0.2, rate: 1.04 },
  water: { type: 'lowpass', frequency: 690, q: 0.65, attack: 0.022, decay: 0.22, level: 0.17, rate: 0.72 },
}

function strideFor(gait: Gait): number {
  switch (gait) {
    case 'walk':
      return 0.75
    case 'run':
      return 1.35
    case 'crouch':
      return 0.55
    case 'swim':
      return 1.2
  }
}

function readPreference(): StoredPreference {
  const fallback = { enabled: false, volume: DEFAULT_VOLUME }
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === '1') return { enabled: true, volume: DEFAULT_VOLUME }
    if (raw === '0' || raw === null) return fallback
    const value = JSON.parse(raw) as Partial<StoredPreference>
    return {
      enabled: value.enabled === true,
      volume:
        typeof value.volume === 'number' && Number.isFinite(value.volume)
          ? clamp(value.volume, 0, 1)
          : DEFAULT_VOLUME,
    }
  } catch {
    // localStorage is allowed to throw in private browsing and file:// builds.
    return fallback
  }
}

function writePreference(enabled: boolean, volume: number): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled, volume }))
  } catch {
    // Audio still works when persistence is unavailable.
  }
}

function audioContextConstructor(): (new () => AudioContext) | null {
  if (typeof window === 'undefined') return null
  const legacyWindow = window as Window & { webkitAudioContext?: new () => AudioContext }
  return window.AudioContext ?? legacyWindow.webkitAudioContext ?? null
}

/**
 * Procedural movement audio. The AudioContext and every Web Audio node are
 * deliberately absent until enable() is called from a real interaction.
 */
export function createAudio(bus: Bus): AudioApi {
  const stored = readPreference()
  const rng = makeRng(0xa0d10)

  // Reduced motion and sound are independent accessibility preferences. A
  // visitor who asks the camera not to fly must not get silently zeroed audio.
  let volume = stored.volume
  let preferenceEnabled = stored.enabled
  let wanted = false
  let live = false
  let disposed = false
  let submerged = false

  let context: AudioContext | null = null
  let noise: AudioBuffer | null = null
  let masterFilter: BiquadFilterNode | null = null
  let masterGain: GainNode | null = null
  const voices: Voice[] = []
  let voiceCursor = 0

  let lastDistance = Number.NaN
  let stepDistance = 0
  let foot = -1
  let currentSurface: Surface = 'ground'
  let currentGait: Gait = 'walk'
  let enablePending: Promise<void> | null = null
  let suspendPending: Promise<void> | null = null

  function audible(): boolean {
    return live && context?.state === 'running' && volume > 0
  }

  function notifyFailure(): void {
    bus.emit('toast', {
      text: 'Audio could not start. Your browser may still be waiting for a user gesture.',
      kind: 'warn',
      ms: 4200,
    })
  }

  function buildGraph(): AudioContext {
    const AudioContextClass = audioContextConstructor()
    if (!AudioContextClass) throw new Error('Web Audio is not available in this browser')

    const ctx = new AudioContextClass()
    const masterLowPass = ctx.createBiquadFilter()
    masterLowPass.type = 'lowpass'
    masterLowPass.frequency.value = submerged ? SUBMERGED_FREQUENCY : OPEN_FREQUENCY
    masterLowPass.Q.value = 0.55

    const output = ctx.createGain()
    output.gain.value = 0
    masterLowPass.connect(output)
    output.connect(ctx.destination)

    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate)
    const samples = buffer.getChannelData(0)
    for (let i = 0; i < samples.length; i++) samples[i] = rng() * 2 - 1

    for (let i = 0; i < VOICE_COUNT; i++) {
      const filter = ctx.createBiquadFilter()
      const gain = ctx.createGain()
      gain.gain.value = 0
      filter.connect(gain)
      gain.connect(masterLowPass)
      voices.push({ filter, gain })
    }

    context = ctx
    noise = buffer
    masterFilter = masterLowPass
    masterGain = output
    return ctx
  }

  function setMasterLevel(value: number, immediate = false): void {
    const ctx = context
    const output = masterGain
    if (!ctx || !output || ctx.state === 'closed') return
    const now = ctx.currentTime
    const target = value * (submerged ? SUBMERGED_LEVEL : 1)
    output.gain.cancelScheduledValues(now)
    output.gain.setValueAtTime(output.gain.value, now)
    if (immediate) output.gain.setValueAtTime(target, now)
    else output.gain.linearRampToValueAtTime(target, now + 0.025)
  }

  function setSubmerged(next: boolean, dt: number): void {
    if (next === submerged) return
    submerged = next
    const ctx = context
    const filter = masterFilter
    const output = masterGain
    if (!ctx || !filter || !output || ctx.state === 'closed') return
    const now = ctx.currentTime
    const settle = clamp(Number.isFinite(dt) ? dt * 2 : 0.08, 0.04, 0.16)
    filter.frequency.cancelScheduledValues(now)
    filter.frequency.setTargetAtTime(
      submerged ? SUBMERGED_FREQUENCY : OPEN_FREQUENCY,
      now,
      settle,
    )
    output.gain.cancelScheduledValues(now)
    output.gain.setTargetAtTime(
      live ? volume * (submerged ? SUBMERGED_LEVEL : 1) : 0,
      now,
      settle,
    )
  }

  function onSourceEnded(this: AudioScheduledSourceNode, _event: Event): void {
    this.disconnect()
  }

  /**
   * AudioBufferSourceNode is one-shot by Web Audio design, so it is the only
   * node created for a hit. The noise buffer and eight filter/envelope voices
   * are reused; the finished source disconnects itself and is then collectible.
   */
  function burst(
    type: BiquadFilterType,
    frequency: number,
    q: number,
    attack: number,
    decay: number,
    level: number,
    playbackRate: number,
  ): void {
    const ctx = context
    const buffer = noise
    if (!ctx || !buffer || !audible()) return

    const voice = voices[voiceCursor]
    voiceCursor = (voiceCursor + 1) % voices.length

    const now = ctx.currentTime
    const end = now + attack + decay
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.setValueAtTime(playbackRate, now)

    voice.filter.type = type
    voice.filter.frequency.cancelScheduledValues(now)
    voice.filter.frequency.setValueAtTime(frequency, now)
    voice.filter.Q.cancelScheduledValues(now)
    voice.filter.Q.setValueAtTime(q, now)

    voice.gain.gain.cancelScheduledValues(now)
    voice.gain.gain.setValueAtTime(SILENCE, now)
    voice.gain.gain.exponentialRampToValueAtTime(Math.max(SILENCE, level), now + attack)
    voice.gain.gain.exponentialRampToValueAtTime(SILENCE, end)
    voice.gain.gain.setValueAtTime(0, end + 0.012)

    source.connect(voice.filter)
    source.onended = onSourceEnded
    source.start(now, rng() * 0.54)
    source.stop(end + 0.015)
  }

  function footstep(surface: Surface, gait: Gait, speed: number): void {
    const shape = gait === 'swim' ? SURFACE_VOICES.water : SURFACE_VOICES[surface]
    let frequencyScale = 1
    let decayScale = 1
    let levelScale = 1
    let rateScale = 1

    switch (gait) {
      case 'walk':
        break
      case 'run':
        // A run lands through more of the sole: lower, heavier, and longer.
        frequencyScale = 0.86
        decayScale = 1.28
        levelScale = 1.35
        rateScale = 0.96
        break
      case 'crouch':
        // Crouching turns the same contact into a quiet, dull placement.
        frequencyScale = 0.68
        decayScale = 0.82
        levelScale = 0.43
        rateScale = 0.88
        break
      case 'swim':
        frequencyScale = 0.78
        decayScale = 1.35
        levelScale = 0.72
        rateScale = 0.78
        break
    }

    foot = -foot
    const sidePitch = foot > 0 ? 1.018 : 0.982
    const pitchJitter = 0.955 + rng() * 0.09
    const levelJitter = 0.9 + rng() * 0.18
    const speedWeight = clamp(0.82 + speed * 0.035, 0.82, 1.06)
    burst(
      shape.type,
      shape.frequency * frequencyScale * pitchJitter,
      shape.q,
      shape.attack,
      shape.decay * decayScale,
      shape.level * levelScale * levelJitter * speedWeight,
      shape.rate * rateScale * sidePitch * pitchJitter,
    )
  }

  async function start(): Promise<void> {
    if (disposed) throw new Error('Cannot enable disposed audio')
    wanted = true

    if (suspendPending) await suspendPending
    if (!wanted) return

    const ctx = context ?? buildGraph()
    if (ctx.state === 'suspended') await ctx.resume()
    if (!wanted) {
      if (ctx.state === 'running') {
        const pending = ctx.suspend().catch(() => {})
        suspendPending = pending
        void pending.finally(() => {
          if (suspendPending === pending) suspendPending = null
        })
      }
      return
    }
    if (ctx.state !== 'running') throw new Error(`AudioContext is ${ctx.state}`)

    live = true
    preferenceEnabled = true
    setMasterLevel(volume)
    writePreference(true, volume)
  }

  function enable(): Promise<void> {
    if (enablePending) return enablePending
    const pending = start()
      .catch((error: unknown) => {
        live = false
        wanted = false
        notifyFailure()
        throw error
      })
      .finally(() => {
        if (enablePending === pending) enablePending = null
      })
    enablePending = pending
    return pending
  }

  function disable(): void {
    wanted = false
    live = false
    preferenceEnabled = false
    writePreference(false, volume)

    const ctx = context
    if (!ctx || ctx.state === 'closed') return
    setMasterLevel(0, true)
    if (ctx.state === 'running') {
      const pending = ctx.suspend().catch(() => {})
      suspendPending = pending
      void pending.finally(() => {
        if (suspendPending === pending) suspendPending = null
      })
    }
  }

  function step(
    dt: number,
    opts: {
      distance: number
      speed: number
      gait: Gait
      grounded: boolean
      surface: Surface
      submerged: boolean
    },
  ): void {
    setSubmerged(opts.submerged, dt)
    currentSurface = opts.surface
    currentGait = opts.gait

    const distance = opts.distance
    if (!Number.isFinite(distance)) return
    if (!Number.isFinite(lastDistance)) {
      lastDistance = distance
      return
    }

    const travelled = distance - lastDistance
    lastDistance = distance
    if (travelled < 0) {
      // A controller reset/respawn establishes a new origin, not a giant step.
      stepDistance = 0
      return
    }

    const moving = opts.speed > 0.035
    const canStep = opts.gait === 'swim' || opts.grounded
    if (!moving || !canStep || travelled === 0) return

    const stride = strideFor(opts.gait)
    stepDistance += travelled
    while (stepDistance >= stride) {
      stepDistance -= stride
      footstep(opts.surface, opts.gait, opts.speed)
    }
  }

  function land(impactSpeed: number): void {
    const impact = clamp((impactSpeed - 1.5) / 11.5, 0, 1)
    if (impact <= 0) return
    const shape = currentSurface === 'water' ? SURFACE_VOICES.water : SURFACE_VOICES[currentSurface]
    const water = currentSurface === 'water' || currentGait === 'swim'
    burst(
      water ? 'lowpass' : 'bandpass',
      water ? 610 : Math.min(shape.frequency, 670) * (0.92 + rng() * 0.1),
      water ? 0.6 : 0.72,
      water ? 0.018 : 0.003,
      (water ? 0.2 : 0.085) + impact * (water ? 0.2 : 0.105),
      (water ? 0.09 : 0.075) + impact * (water ? 0.2 : 0.24),
      water ? 0.68 : 0.78 + rng() * 0.08,
    )
  }

  function jump(): void {
    // A small low-passed scuff/exhale: effort, without a pitched "boing".
    burst('lowpass', 430 + rng() * 55, 0.55, 0.007, 0.105, 0.07, 0.68 + rng() * 0.07)
  }

  function splash(intensity: number): void {
    const amount = clamp(intensity, 0, 1)
    if (amount <= 0) return
    burst(
      'lowpass',
      570 + amount * 190,
      0.62,
      0.022,
      0.16 + amount * 0.24,
      0.075 + amount * 0.2,
      0.62 + rng() * 0.12,
    )
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    wanted = false
    live = false

    const ctx = context
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {})
    for (let i = 0; i < voices.length; i++) {
      voices[i].filter.disconnect()
      voices[i].gain.disconnect()
    }
    voices.length = 0
    masterFilter?.disconnect()
    masterGain?.disconnect()
    context = null
    noise = null
    masterFilter = null
    masterGain = null
  }

  return {
    enable,
    disable,
    get preferred(): boolean {
      return preferenceEnabled
    },
    get enabled(): boolean {
      return live && context?.state === 'running'
    },
    get volume(): number {
      return volume
    },
    set volume(value: number) {
      volume = clamp(Number.isFinite(value) ? value : 0, 0, 1)
      writePreference(preferenceEnabled, volume)
      if (live) setMasterLevel(volume)
    },
    step,
    land,
    jump,
    splash,
    dispose,
  }
}
