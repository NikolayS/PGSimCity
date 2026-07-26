import type { ColorKey } from './types'

/* ============================================================================
 * PGSimCity — THE TWO PALETTES, AND THE ARITHMETIC BETWEEN THEM.
 *
 * The city ships two rendering models, not one palette with the lights turned
 * up. They differ in what carries meaning:
 *
 *   NIGHT   Structure is matte and nearly black; meaning is neon and is the
 *           only thing that clears the bloom threshold. Edges are blueprint
 *           hairlines that glow. ACES tone mapping, low key light, no sun.
 *
 *   DAY     Structure is light warm stone under a stepped toon ramp; meaning is
 *           a flat, deep, poster-print fill that needs no glow at all. Edges
 *           become the cartoon's ink line: dark, opaque, heavier. Bloom is all
 *           but off, the sun is on, and it casts real shadows.
 *
 * That inversion is why the semantic colours are RE-PICKED rather than reused.
 * The MEANINGS are fixed — WAL is amber in both modes, a dirty page is red in
 * both modes — but a value that glows against black turns into a pale wash
 * against a bright sky. Every day value below is a deeper, more saturated
 * sibling of its night counterpart, chosen so that the whole set still separates
 * against a light background. See the ladder notes on the warm family: that is
 * the group that collapses first, in either mode.
 *
 * Nothing in this file imports three.js or theme.ts — it is plain arithmetic on
 * hex integers, so it can be unit-checked and so theme.ts can consume it at
 * module-evaluation time, before any district has been built.
 * ==========================================================================*/

export type ThemeMode = 'night' | 'day'

export const THEME_MODES: readonly ThemeMode[] = ['night', 'day']

export const DEFAULT_MODE: ThemeMode = 'night'

/** localStorage key. Values are exactly the ThemeMode strings. */
export const THEME_STORAGE_KEY = 'pgsimcity.theme'

/* ---------------------------------------------------------------------------
 * NIGHT — the original city. Unchanged; this is still the default.
 * -------------------------------------------------------------------------*/

export const NIGHT_PALETTE: Record<ColorKey, number> = {
  bg: 0x04060c,
  fog: 0x070b16,
  grid: 0x16243c,
  gridBright: 0x2a4368,
  ground: 0x080d18,
  client: 0x8ecae6,
  backend: 0x5ad1ff,
  shmem: 0x7b6cff,
  bufClean: 0x3fa7ff,
  bufDirty: 0xff4d6d,
  bufPinned: 0xffd166,
  bufFree: 0x1b2740,
  wal: 0xffb03a,
  walDim: 0x7a5312,
  storage: 0x55d6a0,
  vacuum: 0xb57bff,
  checkpoint: 0xff7ac6,
  bgwriter: 0x4fe3c1,
  replication: 0xff9f1c,
  lock: 0xff5c5c,
  ok: 0x57e389,
  warn: 0xffcc55,
  crit: 0xff5f6d,
  ink: 0xe8f1ff,
  inkDim: 0x8fa5c4,
  postmaster: 0x9db4ff,
  archive: 0xc9a227,
  toast: 0xff8f5a,
  index: 0x64ffda,
}

/* ---------------------------------------------------------------------------
 * DAY — the same city at noon.
 *
 * Picked against a #d2ccbb stone ground and a #bcdcf2 sky, which is the worst
 * case: mid-lightness backgrounds eat mid-lightness colours from both ends. The
 * whole set therefore sits in the 29–62% lightness band with saturation pushed
 * up, so every swatch is darker than the sky and most are darker than the
 * pavement.
 *
 * Hue budget, walked once around the wheel so neighbours are always separated
 * by either hue or lightness, never by neither:
 *
 *   106 ok · 147 storage · 166 index · 179 bgwriter · 195 backend · 207 client
 *   217 bufClean · 244 postmaster · 250 shmem · 279 vacuum · 320 checkpoint
 *   348 crit · 351 bufDirty · 3 lock · 13 toast · 26 replication · 36 wal
 *   39 warn · 43 archive · 46 bufPinned
 *
 * The warm arc (toast → bufPinned) is the crowded one — it is crowded in the
 * night palette too, where wal and warn sit 7° apart. It is separated here on
 * lightness instead: archive 29% · wal 38% · warn 42% · toast 45% · replication
 * 47% · bufPinned 51%.
 *
 * Measured: the closest pair in this set is ΔE2000 7.0 (toast/lock) and eight
 * of the 231 pairs sit under 10. The night palette's closest pair is 2.0
 * (bufPinned/warn) with ten under 10 — so daylight separates the meanings
 * strictly better than night does, which is the opposite of what happens if you
 * simply reuse the night values on a light background.
 * -------------------------------------------------------------------------*/

export const DAY_PALETTE: Record<ColorKey, number> = {
  /* --- surfaces: warm stone under a blue sky --- */
  bg: 0xbcdcf2, // clear colour behind the sky dome
  fog: 0xcfe2f0, // pale distance haze, not a dark curtain
  grid: 0xb0a998, // 10 m survey line, drawn ON the stone
  gridBright: 0x8d8573, // 50 m block line, one step darker again
  ground: 0xd2ccbb, // the pavement itself

  /* --- the plaza: page state --- */
  bufClean: 0x1d5fcb, // clean page — deep true blue
  bufDirty: 0xe02b46, // dirty page — the one red everybody must see
  bufPinned: 0xefbc16, // pinned — the lightest of the warm ladder
  bufFree: 0xacaeb2, // an unused frame: pale, inert grey

  /* --- processes --- */
  client: 0x5f96c4, // soft steel blue: outside the server
  backend: 0x0089b5, // strong cyan-blue: one process per connection
  postmaster: 0x6a63d9, // periwinkle, the supervisor
  shmem: 0x4b2fd0, // indigo, shared memory

  /* --- durability --- */
  wal: 0xb8720a, // deep amber — pg_wal reads as ochre stone in daylight
  walDim: 0x8c7444, // a segment that is no longer current
  archive: 0x7d6018, // brass: shipped and cold
  storage: 0x17954f, // $PGDATA green
  index: 0x05a47e, // index aqua, pushed green so bgwriter can have the teal
  toast: 0xc9451f, // oversized values, burnt orange

  /* --- maintenance --- */
  vacuum: 0x8b2bc0, // violet
  checkpoint: 0xc42d92, // magenta-pink
  bgwriter: 0x0e8f8c, // teal
  replication: 0xe2690d, // orange on the wire

  /* --- status --- */
  lock: 0xc62f28, // brick red: a heavyweight lock
  ok: 0x3f9c22,
  warn: 0xd18a04,
  crit: 0xb01030,

  /* --- type --- */
  ink: 0x18222e, // near-black: this is now ink on paper
  inkDim: 0x5d6b7a,
}

export const PALETTES: Record<ThemeMode, Record<ColorKey, number>> = {
  night: NIGHT_PALETTE,
  day: DAY_PALETTE,
}

/* ---------------------------------------------------------------------------
 * Atmosphere: everything the renderer owns that is not a material.
 * -------------------------------------------------------------------------*/

export interface Atmosphere {
  /** THREE.ToneMapping constant. Kept as a number so this file stays three-free. */
  toneMapping: 'aces' | 'neutral'
  exposure: number
  /** Multipliers on the city plan's fog distances. */
  fogNearScale: number
  fogFarScale: number
  hemiSky: number
  hemiGround: number
  hemiIntensity: number
  /** Key light: the moon at night, the sun at noon. */
  keyColor: number
  keyIntensity: number
  keyPos: readonly [number, number, number]
  keyTarget: readonly [number, number, number]
  shadowBias: number
  shadowNormalBias: number
  fillColor: number
  fillIntensity: number
  fillPos: readonly [number, number, number]
  /** District mood lamps. Zero at noon — they only make sense in the dark. */
  walGlow: number
  yardGlow: number
  /** Extra light paid back when the bloom pass is unavailable ('low' quality). */
  noBloomHemi: number
  noBloomFill: number
  noBloomWalGlow: number
  noBloomYardGlow: number
  bloomStrength: number
  bloomRadius: number
  bloomThreshold: number
  /** Sky dome uniforms — see world/sky.ts. */
  skyZenith: number
  skyHorizon: number
  skyGlow: number
  stars: boolean
  /** Toon ramp on every MeshStandardMaterial. */
  toon: boolean
}

export const ATMOSPHERE: Record<ThemeMode, Atmosphere> = {
  night: {
    toneMapping: 'aces',
    exposure: 1.06,
    fogNearScale: 1,
    fogFarScale: 1,
    hemiSky: 0x2a4a7a,
    hemiGround: 0x05070c,
    hemiIntensity: 0.55,
    keyColor: 0xa8c8ff,
    keyIntensity: 1.15,
    keyPos: [322, 374, -196],
    keyTarget: [0, 0, -35],
    shadowBias: -0.0006,
    shadowNormalBias: 0.6,
    fillColor: 0x4a6fa5,
    fillIntensity: 0.35,
    fillPos: [-320, 168, 296],
    walGlow: 40,
    yardGlow: 26,
    noBloomHemi: 0.78,
    noBloomFill: 0.46,
    noBloomWalGlow: 66,
    noBloomYardGlow: 44,
    bloomStrength: 0.62,
    bloomRadius: 0.55,
    bloomThreshold: 0.85,
    skyZenith: 0x030408,
    skyHorizon: 0x19273f,
    skyGlow: 0x573c14,
    stars: true,
    toon: false,
  },
  day: {
    // ACES at a noon exposure crushes saturation into pastel — exactly the
    // "night theme with the lights turned up" failure. Khronos PBR Neutral
    // holds hue and saturation and rolls the top end off instead of clipping,
    // which is what a poster-flat city needs.
    toneMapping: 'neutral',
    exposure: 1.0,
    // Daylight sees further, and the haze is pale rather than a dark curtain.
    fogNearScale: 1.3,
    fogFarScale: 1.55,
    hemiSky: 0xdff0ff,
    hemiGround: 0xcbbf9e, // warm bounce off the stone
    hemiIntensity: 1.15,
    keyColor: 0xfff2d6, // the sun
    keyIntensity: 2.15,
    // South-east and high: the establishing shot looks north up the city axis,
    // so this lights the faces turned toward the camera and throws the shadows
    // away from it — the SimCity read.
    keyPos: [300, 430, 210],
    keyTarget: [0, 0, -20],
    shadowBias: -0.0004,
    shadowNormalBias: 0.45,
    fillColor: 0xbfd8ff, // sky bounce from behind
    fillIntensity: 0.3,
    fillPos: [-300, 150, -230],
    walGlow: 0,
    yardGlow: 0,
    noBloomHemi: 1.25,
    noBloomFill: 0.34,
    noBloomWalGlow: 0,
    noBloomYardGlow: 0,
    // Nearly off. What is left is a half-stop of air around the few surfaces
    // the sun genuinely blows out; nothing semantic reaches it.
    bloomStrength: 0.13,
    bloomRadius: 0.4,
    bloomThreshold: 1.05,
    skyZenith: 0x2f78c8,
    skyHorizon: 0xd8e9f5,
    skyGlow: 0x40300f,
    stars: false,
    toon: true,
  },
}

/* ---------------------------------------------------------------------------
 * Colour arithmetic.
 * -------------------------------------------------------------------------*/

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** sRGB hex → [hue 0..360, saturation 0..1, lightness 0..1]. */
export function hslOf(hex: number): [number, number, number] {
  const r = ((hex >> 16) & 255) / 255
  const g = ((hex >> 8) & 255) / 255
  const b = (hex & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
  else if (max === g) h = ((b - r) / d + 2) * 60
  else h = ((r - g) / d + 4) * 60
  return [h, s, l]
}

/** [hue, saturation, lightness] → sRGB hex. */
export function hexOfHsl(h: number, s: number, l: number): number {
  const hh = ((h % 360) + 360) % 360
  const sat = clamp01(s)
  const lig = clamp01(l)
  if (sat === 0) {
    const v = Math.round(lig * 255)
    return (v << 16) | (v << 8) | v
  }
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat
  const p = 2 * lig - q
  const chan = (t: number): number => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  const hk = hh / 360
  const r = Math.round(chan(hk + 1 / 3) * 255)
  const g = Math.round(chan(hk) * 255)
  const b = Math.round(chan(hk - 1 / 3) * 255)
  return (r << 16) | (g << 8) | b
}

/** Straight channel mix in sRGB space. Matches theme.mixHex. */
export function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255
  const ag = (a >> 8) & 255
  const ab = a & 255
  const br = (b >> 16) & 255
  const bg = (b >> 8) & 255
  const bb = b & 255
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  )
}

/* ---------------------------------------------------------------------------
 * NIGHT → DAY translation.
 *
 * Thirteen world modules paint with several hundred ad-hoc hex literals that no
 * table could ever enumerate. So the translation is two-layered:
 *
 *   1. An exact table, built from the two palettes plus the handful of colours
 *      the world derives from them deterministically (the sky dome, the ground
 *      sweep). Anything semantic lands here and gets its hand-picked value.
 *   2. A generic transform for everything else, which is almost entirely
 *      structural: near-black navies that have to become light warm stone.
 *
 * Every function here is pure, and the renderer always applies it to the
 * *authored night value* — never to whatever is on screen — so switching back
 * and forth is exact and idempotent.
 * -------------------------------------------------------------------------*/

/** Colours that must never be touched: multiplier bases and true black. */
export function isNeutralExtreme(hex: number): boolean {
  return hex === 0xffffff || hex === 0x000000
}

const exact = new Map<number, number>()
for (const key of Object.keys(NIGHT_PALETTE) as ColorKey[]) {
  // Later keys must not clobber earlier ones: crit and bufDirty are distinct
  // meanings that happen to be one channel apart at night.
  if (!exact.has(NIGHT_PALETTE[key])) exact.set(NIGHT_PALETTE[key], DAY_PALETTE[key])
}

/*
 * Derived night colours, mirrored here because the modules that compute them
 * (world/sky.ts, world/ground.ts) are owned by other agents and cannot yet be
 * asked for a day value. Each is a pure function of the night palette, so it is
 * a fixed number — and each of these three surfaces covers a third of the
 * screen, which is why they are worth pinning rather than leaving to the
 * generic transform.
 */
const DERIVED: readonly (readonly [number, number])[] = [
  // world/sky.ts: mix(bg, black, 0.35) / mix(fog, gridBright, 0.5) / mix(black, wal, 0.34)
  [0x030408, ATMOSPHERE.day.skyZenith],
  [0x19273f, ATMOSPHERE.day.skyHorizon],
  [0x573c14, ATMOSPHERE.day.skyGlow],
  // world/ground.ts: mix(gridBright, backend, 0.55) — the survey sweep
  [0x4491bb, 0x6f93a8],
]
for (const [night, day] of DERIVED) if (!exact.has(night)) exact.set(night, day)

/** Exact day value for a known night colour, or -1. */
export function exactDay(hex: number): number {
  const hit = exact.get(hex)
  return hit === undefined ? -1 : hit
}

/**
 * Structure — anything painted with `mat()`.
 *
 * Night structure is a near-black navy whose *lightness* carries the modelling:
 * a pylon is darker than a wall is darker than a rim. Daylight has to keep that
 * ordering while moving the whole range into warm stone, so lightness maps
 * monotonically and the original hue survives as a 32% tint. Anything already
 * light at night was an accent surface, not structure, and is deepened instead.
 */
export function daySurface(hex: number): number {
  if (isNeutralExtreme(hex)) return hex
  const hit = exact.get(hex)
  if (hit !== undefined) return hit
  const [h, s, l] = hslOf(hex)
  if (l < 0.34) {
    const lit = 0.6 + Math.min(l, 0.4) * 0.72
    const stone = hexOfHsl(36, 0.15, lit)
    const tint = hexOfHsl(h, Math.min(s, 0.55) * 0.8, lit)
    return mix(stone, tint, 0.32)
  }
  return hexOfHsl(h, Math.max(0.25, Math.min(0.8, s * 0.85)), Math.max(0.42, Math.min(0.72, 0.3 + l * 0.42)))
}

/**
 * Meaning — anything painted with `neon()`, and every accent the generic walk
 * finds. Bloom is off, so the value on screen IS the value picked here: it has
 * to be dark enough to hold against a bright sky without any halo helping it.
 */
export function dayAccent(hex: number): number {
  if (isNeutralExtreme(hex)) return hex
  const hit = exact.get(hex)
  if (hit !== undefined) return hit
  const [h, s, l] = hslOf(hex)
  return hexOfHsl(h, Math.max(0.42, Math.min(0.95, s * 0.9 + 0.1)), Math.max(0.3, Math.min(0.56, 0.3 + l * 0.34)))
}

/**
 * Ink — every line material.
 *
 * At night the blueprint edges glow, and that glow is what draws the silhouette.
 * At noon glow is invisible, so the same edges become the cartoon's ink line:
 * the hue survives as a trace, the value does not. `dayInkOpacity` is the other
 * half of "heavier" — WebGL cannot widen a line, so weight has to come from
 * opacity.
 */
export function dayInk(hex: number): number {
  const [h, s, l] = hslOf(hex)
  return hexOfHsl(h, Math.min(s, 0.6) * 0.85, 0.15 + l * 0.1)
}

export function dayInkOpacity(opacity: number): number {
  return Math.min(1, opacity * 1.6 + 0.22)
}

/**
 * Emissive. A dark emissive at night is a cheap self-illumination trick that
 * keeps unlit structure off the floor of the image; in daylight there is a sun
 * doing that job, and the trick reads as grime. A *bright* emissive is a lit
 * thing and stays lit.
 */
export function dayEmissive(hex: number): number {
  if (hex === 0x000000) return 0x000000
  const [, , l] = hslOf(hex)
  if (l < 0.28) return 0x000000
  return dayAccent(hex)
}

/** Neon intensity is a bloom lever at night; at noon it is nearly flat. */
export function dayNeonIntensity(intensity: number): number {
  return Math.max(0.88, Math.min(1.1, 0.92 + (intensity - 1) * 0.08))
}
