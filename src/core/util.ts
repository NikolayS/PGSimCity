/** Small math / formatting helpers shared across the whole app. */

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
export const clamp01 = (v: number) => clamp(v, 0, 1)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const invLerp = (a: number, b: number, v: number) => (b === a ? 0 : (v - a) / (b - a))
export const remap = (v: number, a: number, b: number, c: number, d: number) => lerp(c, d, clamp01(invLerp(a, b, v)))
export const smoothstep = (t: number) => {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}
export const smootherstep = (t: number) => {
  const x = clamp01(t)
  return x * x * x * (x * (x * 6 - 15) + 10)
}
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3)
export const easeInOutCubic = (t: number) => {
  const x = clamp01(t)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp01(t)))

/** Frame-rate independent exponential approach. `rate` ~ how much closes per second. */
export const damp = (current: number, target: number, rate: number, dt: number) =>
  lerp(current, target, 1 - Math.exp(-rate * dt))

/** Deterministic 32-bit PRNG (mulberry32) — same city every reload. */
export function makeRng(seed = 0x5eed1e) {
  let a = seed >>> 0
  return function rng(): number {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const rand = makeRng()
export const randRange = (lo: number, hi: number, r = rand) => lo + (hi - lo) * r()
export const randInt = (lo: number, hi: number, r = rand) => Math.floor(lo + (hi - lo + 1) * r())
export const pick = <T,>(arr: readonly T[], r = rand): T => arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))]

/** Weighted pick: weights need not be normalised. */
export function weightedPick(weights: readonly number[], r = rand): number {
  let total = 0
  for (const w of weights) total += w
  let x = r() * total
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i]
    if (x <= 0) return i
  }
  return weights.length - 1
}

/** Exponential inter-arrival time for a Poisson process of given rate (events/sec). */
export const expDelay = (ratePerSec: number, r = rand) =>
  ratePerSec <= 0 ? Infinity : -Math.log(1 - r()) / ratePerSec

/* ------------------------------ accessibility ---------------------------- */

/**
 * Live "the visitor asked for less motion" flag.
 *
 * CSS already honours the preference for transitions, but the camera flights,
 * the tour's fly-throughs and the particle streams are all JavaScript and were
 * ignoring it. Read once, kept current by the media query's change event, so
 * callers can consult it every frame for free.
 */
let _reduceMotion = false
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
  _reduceMotion = mq.matches
  const onChange = (e: MediaQueryListEvent) => {
    _reduceMotion = e.matches
  }
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange)
}

export const reduceMotion = (): boolean => _reduceMotion

/* ------------------------------ formatting ------------------------------ */

export function fmtBytes(b: number, digits = 1): string {
  const neg = b < 0
  let v = Math.abs(b)
  // Binary units: the arithmetic below is 1024-based, so the names must be too.
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${neg ? '-' : ''}${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`
}

export function fmtNum(n: number, digits = 0): string {
  if (!isFinite(n)) return '∞'
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}k`
  return n.toLocaleString(undefined, { maximumFractionDigits: digits })
}

export function fmtPct(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits)}%`
}

export function fmtDuration(sec: number): string {
  if (sec < 1) return `${(sec * 1000).toFixed(0)} ms`
  if (sec < 60) return `${sec.toFixed(1)} s`
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

/** Format a byte offset the way Postgres shows an LSN: XXXXXXXX/XXXXXXXX */
export function fmtLsn(bytes: number): string {
  const hi = Math.floor(bytes / 0x100000000)
  const lo = Math.floor(bytes % 0x100000000)
  return `${hi.toString(16).toUpperCase().padStart(1, '0')}/${lo.toString(16).toUpperCase().padStart(8, '0')}`
}

/** WAL segment file name from a segment number (16 MiB segments, timeline 1). */
export function walSegName(seg: number, timeline = 1): string {
  const logId = Math.floor(seg / 256)
  const segId = seg % 256
  return (
    timeline.toString(16).toUpperCase().padStart(8, '0') +
    logId.toString(16).toUpperCase().padStart(8, '0') +
    segId.toString(16).toUpperCase().padStart(8, '0')
  )
}

/** Push a value onto a fixed-length rolling history array. */
export function pushHistory(arr: number[], v: number, max = 120): void {
  if (max <= 0) {
    arr.length = 0
    return
  }
  if (arr.length < max) {
    arr.push(v)
    return
  }
  arr.copyWithin(0, arr.length - max + 1)
  arr.length = max
  arr[max - 1] = v
}

/** Rolling average helper. */
export class Ema {
  value: number
  constructor(initial = 0, private readonly rate = 3) {
    this.value = initial
  }
  push(v: number, dt: number): number {
    this.value = damp(this.value, v, this.rate, dt)
    return this.value
  }
}
