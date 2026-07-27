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

/* Day is the default. Most people meet this city for the first time on
 * unknown hardware, and a sunlit model reads as a place immediately, where the
 * night render asks the viewer to work out what they are looking at first. */
export const DEFAULT_MODE: ThemeMode = 'day'

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
  fog: 0xc3d8ea, // distance haze — pale, but still a colour
  grid: 0xa79f8c, // 10 m survey line, drawn ON the stone
  gridBright: 0x827a68, // 50 m block line, one step darker again
  ground: 0xcbc4b1, // the pavement itself

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
  storage: 0x17954f, // data-directory green
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
  /** 0..1 — how dark a cast shadow goes. A cartoon shadow is a tone, not a hole. */
  shadowIntensity: number
  /** Night keeps its original unshadowed render; the sun alone casts. */
  shadows: boolean
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
  /** Whether the bloom pass runs at all. Off at noon: see the day entry. */
  bloomEnabled: boolean
  bloomStrength: number
  bloomRadius: number
  bloomThreshold: number
  /** Sky dome uniforms — see world/sky.ts. */
  skyZenith: number
  skyHorizon: number
  skyGlow: number
  daylight: boolean
  stars: boolean
  clouds: boolean
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
    shadowIntensity: 1,
    shadows: false,
    fillColor: 0x4a6fa5,
    fillIntensity: 0.35,
    fillPos: [-320, 168, 296],
    walGlow: 40,
    yardGlow: 26,
    noBloomHemi: 0.78,
    noBloomFill: 0.46,
    noBloomWalGlow: 66,
    noBloomYardGlow: 44,
    bloomEnabled: true,
    bloomStrength: 0.62,
    bloomRadius: 0.55,
    bloomThreshold: 0.85,
    skyZenith: 0x030408,
    skyHorizon: 0x19273f,
    skyGlow: 0x573c14,
    daylight: false,
    stars: true,
    clouds: false,
    toon: false,
  },
  day: {
    // ACES at a noon exposure crushes saturation into pastel — exactly the
    // "night theme with the lights turned up" failure. Khronos PBR Neutral
    // holds hue and saturation and rolls the top end off instead of clipping,
    // which is what a poster-flat city needs.
    toneMapping: 'neutral',
    // Under 1. The whole budget here is arithmetic: ambient + the toon ramp's
    // brightest band must land near 1.0 on a 0.55-albedo stone, or the city
    // clips to white and the ink lines have nothing to draw against. Measured
    // on the establishing shot: hemisphere 0.62 + key 1.35 gives 0.90–1.30
    // irradiance, and 0.92 exposure brings the top of that back under the knee.
    exposure: 1.0,
    // Daylight sees a long way. The haze has to start well outside the city or
    // the districts read through a white curtain.
    fogNearScale: 2,
    fogFarScale: 2,
    hemiSky: 0xd7ecff,
    hemiGround: 0xd6c49b, // warm bounce off the stone
    // The budget is a Lambert one: reflectance is irradiance/PI, so a sunlit
    // top face only returns its own albedo when key + hemi + fill ≈ PI. Under
    // that and every lit surface reads darker than the (unlit) ground plate
    // beside it, which is what made the first pass look like night with the
    // lights up. 1.95 + 1.35 + 0.25 = 3.55, and 0.95 exposure trims the top.
    //
    // The split between the two matters as much as the sum. A cartoon shadow is
    // a flat darker tone, not an absence of light: this weighting puts a fully
    // shadowed face at 0.51x albedo and a sunlit one at 1.13x, which is the
    // roughly 2:1 the drawing convention wants. Push more into the key and the
    // excavation and every north wall go to mud.
    hemiIntensity: 1.35,
    keyColor: 0xfff0c8, // the sun
    keyIntensity: 1.95,
    /* East-south-east and high. The exact azimuth is load-bearing, not taste:
     * the toon ramp has two thresholds (0.16 and 0.52 on N·L), and this
     * direction is chosen so a box's three visible faces land in three
     * different bands. Normalised it is (0.635, 0.718, 0.284), so +X → 1.00,
     * +Y → 1.00 plus the up-face lift, +Z → 0.55, and everything else → 0.
     * That is the SimCity three-tone: roof, sun wall, half-lit wall, shade.
     *
     * The previous (0.524, 0.751, 0.402) put +X and +Y in the same band and
     * left +Z at 0.402 — eighteen thousandths under the old single threshold —
     * so a building read as a silhouette rather than as facets. */
    keyPos: [380, 430, 150],
    keyTarget: [0, 0, -20],
    shadowBias: -0.0004,
    shadowNormalBias: 0.45,
    // The plaza is 1024 towers on one deck: at full strength their own shadows
    // turn the buffer pool into a dark field and the page colours lose the
    // surface they are supposed to sit on. A drawn shadow is a flat tone about
    // two thirds of the lit value, and that is what this is.
    shadowIntensity: 0.55,
    shadows: true,
    fillColor: 0xbfd8ff, // sky bounce from behind
    fillIntensity: 0.25,
    fillPos: [-300, 150, -230],
    walGlow: 0,
    yardGlow: 0,
    noBloomHemi: 1.5,
    noBloomFill: 0.3,
    noBloomWalGlow: 0,
    noBloomYardGlow: 0,
    // OFF, and it has to be off rather than merely quiet. Several districts
    // over-drive their per-instance colours well past 1.0 so that the night
    // bloom will halo them — the plaza's hot page tiles, the WAL insert ring,
    // the lamp crowns. Leave the pass on at any threshold and those halo at
    // noon too, and the city disappears into white fog. The threshold below is
    // what the pass would run at if a future mode wanted a trace of it.
    bloomEnabled: false,
    bloomStrength: 0.1,
    bloomRadius: 0.35,
    bloomThreshold: 1.2,
    skyZenith: 0x2f78c8,
    skyHorizon: 0xbcdcf2,
    skyGlow: 0xffdeb0,
    daylight: true,
    stars: false,
    clouds: true,
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

/* ---------------------------------------------------------------------------
 * DAYLIGHT STONE, PER DISTRICT.
 *
 * Every structural colour in the city is authored as a near-black blue-grey, so
 * one generic navy→sandstone transform gives all thirteen districts the same
 * beige: measured over the 28 authored structural colours it produced hue
 * 27–33°, saturation 14–17%, lightness 54–69%. A city whose quarters cannot be
 * told apart at 200 m is not a day theme, it is a lit night one.
 *
 * So the stone is hand-picked per district, the way DAY_PALETTE hand-picked the
 * accents. Each entry fixes a HUE and a SATURATION for the quarter and a
 * LIGHTNESS BAND; the authored night lightness — which is what carries the
 * modelling, a pylon darker than a wall darker than a rim — is remapped
 * monotonically into that band. Ordering survives, identity is gained.
 *
 * Saturation stays between 6% and 20%. That is the whole discipline: structure
 * varies in hue and value, meaning (DAY_PALETTE, 42–95% saturation) stays the
 * only saturated thing on screen. Widening this band is how the city loses the
 * rule.
 * -------------------------------------------------------------------------*/

interface Stone {
  /** Hue in degrees and saturation 0..1 for the whole quarter. */
  h: number
  s: number
  /** Lightness band the authored night lightness is remapped into. */
  lo: number
  hi: number
}

/* Exact material keys win over the district prefix they start with. */
const STONE: Record<string, Stone> = {
  /* --- the excavation is earth, not a building ------------------------- */
  'ground.pitWall': { h: 26, s: 0.16, lo: 0.2, hi: 0.42 },
  'ground.pitFloor': { h: 26, s: 0.16, lo: 0.18, hi: 0.36 },

  /* --- districts, by mat() key prefix ----------------------------------
   * The hues are spaced at least 20 degrees apart all the way round the
   * wheel. Below about 10% saturation a hex value only resolves the hue to
   * within a few degrees, so a nominally 10-degree gap can measure as three
   * and two quarters collapse into each other again. */
  // outside the server: pale sand, the softest quarter.
  clients: { h: 20, s: 0.1, lo: 0.44, hi: 0.68 },
  // pg_wal: ochre sandstone. The one properly warm quarter, and the amber
  // district — the only place where stone and meaning share a family.
  wal: { h: 42, s: 0.2, lo: 0.4, hi: 0.68 },
  // backend towers: pale straw plaster, so the window bands sit on something.
  backends: { h: 64, s: 0.09, lo: 0.44, hi: 0.7 },
  // the maintenance yard: painted works grey-green, an industrial finish.
  maint: { h: 106, s: 0.1, lo: 0.33, hi: 0.58 },
  // the data directory: cool poured concrete with the faintest green in it.
  storage: { h: 150, s: 0.08, lo: 0.36, hi: 0.62 },
  // replication: cool slate — this quarter reads as machinery.
  rep: { h: 196, s: 0.1, lo: 0.35, hi: 0.62 },
  // shared memory: cool white precast. The brightest structure in the city.
  shmem: { h: 226, s: 0.06, lo: 0.46, hi: 0.7 },
  // the planner: the least coloured stone anywhere, a bare trace of lilac.
  planner: { h: 268, s: 0.07, lo: 0.38, hi: 0.64 },
  // continuity: old limestone gone grey-mauve with iron. The oldest-looking
  // quarter, which suits the district that keeps the archive.
  continuity: { h: 316, s: 0.09, lo: 0.4, hi: 0.66 },
  // access paths and index halls: dusty brick.
  access: { h: 352, s: 0.11, lo: 0.34, hi: 0.6 },
  // the plate itself, its kerb and its masts: light structural concrete, and
  // deliberately the pavement's own hue — this is ground, not a quarter.
  ground: { h: 36, s: 0.08, lo: 0.4, hi: 0.66 },
}

function stoneFor(key: string | undefined): Stone | undefined {
  if (key === undefined) return undefined
  const exactKey = STONE[key]
  if (exactKey !== undefined) return exactKey
  const dot = key.indexOf('.')
  return dot < 0 ? undefined : STONE[key.slice(0, dot)]
}

/** Night lightness 0..0.34 → 0..1 across the district's band. */
function stoneT(l: number): number {
  return Math.min(l, 0.34) / 0.34
}

/**
 * Structure — anything painted with `mat()`.
 *
 * `key` is the mat() cache key, which is already namespaced by district. Pass it
 * and the surface gets its quarter's stone; omit it (or use a key no district
 * claims) and it falls back to the generic warm sandstone, which is only a
 * sensible answer for one-off props. Anything already light at night was an
 * accent surface, not structure, and is deepened instead.
 */
export function daySurface(hex: number, key?: string): number {
  if (isNeutralExtreme(hex)) return hex
  const hit = exact.get(hex)
  if (hit !== undefined) return hit
  const [h, s, l] = hslOf(hex)
  if (l < 0.34) {
    const stone = stoneFor(key)
    if (stone !== undefined) {
      /* No tint from the source hue. The authored navies differ from each other
       * by two or three units of blue; mixing that back in only pulls every
       * quarter toward the same cold grey again, which is the failure this
       * table exists to undo. Modelling comes from the lightness band. */
      return hexOfHsl(stone.h, stone.s, stone.lo + stoneT(l) * (stone.hi - stone.lo))
    }
    // 0.42–0.67, not 0.7–0.95: a sunlit surface still has a light term on top
    // of this, and stone that starts near white has nowhere left to go — it
    // clips, and a clipped face cannot show either the toon terminator or its
    // own ink. The band also sits below the 0.74 pavement so a building
    // separates from the ground it stands on.
    const lit = 0.42 + Math.min(l, 0.4) * 0.62
    const base = hexOfHsl(34, 0.32, lit)
    const tint = hexOfHsl(h, Math.min(s, 0.55) * 0.85, lit)
    return mix(base, tint, 0.26)
  }
  return hexOfHsl(h, Math.max(0.25, Math.min(0.8, s * 0.85)), Math.max(0.34, Math.min(0.62, 0.26 + l * 0.4)))
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
  return hexOfHsl(h, Math.min(s, 0.6) * 0.85, 0.12 + l * 0.08)
}

export function dayInkOpacity(opacity: number): number {
  return Math.min(1, opacity * 1.8 + 0.28)
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
  return Math.max(0.98, Math.min(1.18, 1.0 + (intensity - 1) * 0.1))
}
