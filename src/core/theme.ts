import * as THREE from 'three'
import { pairBoxGeometries } from './beveled-box'
import type { ColorKey, MatOpts, NeonOpts, TextTexOpts, ThemeApi } from './types'
import {
  ATMOSPHERE,
  BAKED_BOUNCE_GAIN,
  BAKED_SKY_COLOR,
  DEFAULT_MODE,
  PALETTES,
  THEME_STORAGE_KEY,
  BOUNCE_PALETTE_KEYS,
  clockAccent,
  clockAtmosphereAt,
  clockEnvironmentKeyAt,
  clockEmissive,
  clockInk,
  clockInkOpacity,
  clockNeonIntensity,
  clockPaletteForDaylight,
  clockSunAt,
  clockSurface,
  dayAccent,
  dayEmissive,
  dayInk,
  dayInkOpacity,
  dayNeonIntensity,
  daySurface,
  isNeutralExtreme,
  mix,
  nightSurface,
} from './themes'
import type { Atmosphere, CuratedThemeMode, ThemeMode } from './themes'

export type { Atmosphere, ThemeMode } from './themes'
export { ATMOSPHERE, DAY_PALETTE, NIGHT_PALETTE, PALETTES } from './themes'

/**
 * PGSimCity palette — LIVE. Three modes share one object.
 *
 * NIGHT (the authoring baseline): the renderer uses ACESFilmic tone mapping and
 * the bloom pass runs with a high threshold, so *only* surfaces whose output
 * exceeds ~1.0 will glow. Paint structure with `mat()` (PBR, no glow); paint
 * meaning — data, state, energy — with `neon()`.
 *
 * DAY: the same call sites, a different rendering model. `mat()` becomes light
 * pale stone under a stepped toon ramp lit by a low warm sun; `neon()` becomes a
 * flat poster fill that carries meaning without any glow, because bloom is off;
 * `line()` becomes the cartoon's ink. Nothing in src/world has to know.
 *
 * LOCAL TIME: the same night-to-day translations follow an approximate local
 * clock sun path. It deliberately has no geolocation, latitude or season.
 *
 * IMPORTANT: this object is MUTATED IN PLACE by setThemeMode(). It always
 * *starts* on the night palette, even when the viewer's stored preference is
 * day — src/world is authored in night values, and every night value has a
 * day translation, but the reverse is not true (the translation clamps). So the
 * city is always built in night and then translated, which is what makes the
 * switch exact and reversible in both directions. See the note on
 * applyStoredThemeMode().
 *
 * A module that snapshots a colour at import time ("const RED =
 * COLOR.bufDirty") therefore holds a NIGHT value forever and will not follow
 * the mode. Read COLOR.* per frame instead, or paint through the theme cache,
 * or subscribe with onThemeMode().
 */
export const COLOR: Record<ColorKey, number> = { ...PALETTES.night }

/* ============================================================================
 * MODE
 * ==========================================================================*/

function readStoredMode(): ThemeMode {
  try {
    if (typeof window === 'undefined') return DEFAULT_MODE
    const v = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (v === 'day' || v === 'night' || v === 'clock') return v
  } catch {
    // Private browsing and file:// both throw on localStorage. Not fatal.
  }
  return DEFAULT_MODE
}

function writeStoredMode(m: ThemeMode): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(THEME_STORAGE_KEY, m)
  } catch {
    // Nothing to do: the choice simply will not survive a reload.
  }
}

/** Always night at import — see the note on COLOR. */
let mode: ThemeMode = 'night'

function localMinutes(now: Date): number {
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60
}

let clockMinutes = localMinutes(new Date())
let clockSun = clockSunAt(clockMinutes)
let clockAir = clockAtmosphereAt(clockMinutes)
let clockPalette = clockPaletteForDaylight(clockSun.daylight)
let clockPinned = false

function airFor(target: ThemeMode): Atmosphere {
  return target === 'clock' ? clockAir : ATMOSPHERE[target]
}

function daylightFor(target: ThemeMode): number {
  return target === 'clock' ? clockSun.daylight : target === 'day' ? 1 : 0
}

function curatedFor(target: ThemeMode): CuratedThemeMode {
  return airFor(target).toon ? 'day' : 'night'
}

function paletteFor(target: ThemeMode): Record<ColorKey, number> {
  return target === 'clock' ? clockPalette : PALETTES[target]
}

/** Whether night-mode semantic materials can rely on a bloom pass. */
let bloomAvailable = true

/** The viewer's remembered choice. Daylight unless they have asked for night. */
export function storedThemeMode(): ThemeMode {
  return readStoredMode()
}

/** The mode the city is painted in right now. */
export function themeMode(): ThemeMode {
  return mode
}

/** Light rig, tone mapping, fog and sky for the current mode. */
export function atmosphere(): Atmosphere {
  return airFor(mode)
}

/** Cache identity for the expensive prefiltered sky environment. */
export function themeEnvironmentKey(): string {
  return mode === 'clock' ? `clock:${clockEnvironmentKeyAt(clockMinutes)}` : mode
}

/** Daylight blend in [0, 1], including the local-clock twilight continuum. */
export function themeDaylight(): number {
  return daylightFor(mode)
}

type ModeListener = (m: ThemeMode) => void
const listeners = new Set<ModeListener>()

/** Subscribe to mode changes. Returns an unsubscribe function. */
export function onThemeMode(fn: ModeListener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Every live theme cache, so a mode change can repaint all of them. */
const caches = new Set<{ repaint(m: ThemeMode): void }>()

/**
 * Repaint semantic materials when the renderer adds or removes bloom.
 *
 * Returns whether availability changed so the renderer can repaint uncached
 * scene materials in the same quality-change transaction.
 */
export function setBloomAvailable(available: boolean): boolean {
  if (available === bloomAvailable) return false
  bloomAvailable = available
  for (const c of caches) c.repaint(mode)
  return true
}

function applyPalette(m: ThemeMode): void {
  const p = paletteFor(m)
  for (const key of Object.keys(p) as ColorKey[]) COLOR[key] = p[key]
}

function applyDocument(m: ThemeMode): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const visual = curatedFor(m)
  root.dataset.theme = visual
  root.dataset.themeMode = m
  // A colour-scheme hint is what makes native form controls, scrollbars and the
  // browser's own overscroll background follow the city instead of fighting it.
  root.style.colorScheme = visual === 'day' ? 'light' : 'dark'
}

function updateClock(minutes: number, notify: boolean): void {
  clockMinutes = ((minutes % 1440) + 1440) % 1440
  clockSun = clockSunAt(clockMinutes)
  clockAir = clockAtmosphereAt(clockMinutes)
  clockPalette = clockPaletteForDaylight(clockSun.daylight)
  if (mode !== 'clock' || !notify) return
  applyPalette(mode)
  applyDocument(mode)
  for (const c of caches) c.repaint(mode)
  for (const fn of listeners) fn(mode)
}

/** Deterministic clock staging for tests and the browser debugging surface. */
export function setThemeClockMinutes(minutes: number): void {
  clockPinned = true
  updateClock(minutes, true)
}

export function refreshThemeClock(now = new Date()): void {
  clockPinned = false
  updateClock(localMinutes(now), true)
}

/** Live clock costs one update per minute and no work in the frame loop. */
export function startThemeClock(): () => void {
  if (typeof window === 'undefined') return () => {}
  const timer = window.setInterval(() => {
    if (!clockPinned) refreshThemeClock()
  }, 60_000)
  return () => window.clearInterval(timer)
}

/**
 * Switch the whole city among night, golden hour and local-clock light.
 *
 * No geometry is rebuilt and nothing is reloaded: the palette object is mutated
 * in place, every cached material is repainted from the value it was authored
 * with, and the renderer answers the same notification by swapping the light
 * rig, the tone mapping curve and the bloom settings. One frame, whole city.
 */
export function setThemeMode(next: ThemeMode, opts: { persist?: boolean } = {}): ThemeMode {
  if (next === 'clock' && next !== mode) {
    clockPinned = false
    updateClock(localMinutes(new Date()), false)
  }
  if (next === mode) return mode
  mode = next
  applyPalette(mode)
  applyDocument(mode)
  for (const c of caches) c.repaint(mode)
  if (opts.persist !== false) writeStoredMode(mode)
  for (const fn of listeners) fn(mode)
  return mode
}

export function toggleThemeMode(): ThemeMode {
  return setThemeMode(mode === 'night' ? 'day' : mode === 'day' ? 'clock' : 'night')
}

/**
 * Restore the remembered mode, once — call it when the scene is complete.
 *
 * This deliberately does NOT run at module-evaluation time. The city has to be
 * BUILT in night and then translated, because the translation is one-way: a
 * night navy has exactly one day stone, but several night navies map to the
 * same stone, so a city built in day could never be turned back into a correct
 * night. Building in night and translating keeps both directions exact.
 *
 * engine/renderer.ts calls it on its first frame, which is the first moment at
 * which every district, road and label is in the scene graph — and still before
 * anything has been presented, so there is no flash of the wrong theme.
 */
export function applyStoredThemeMode(): ThemeMode {
  return setThemeMode(readStoredMode(), { persist: false })
}

// The CSS side of the stored choice IS applied at module evaluation: it costs
// one attribute write, it cannot get the 3D city wrong, and it means the boot
// screen already comes up in the right theme.
applyDocument(readStoredMode())

/* ============================================================================
 * THE DAY SHADER — two injections, one hook.
 *
 * 1. TOON SHADING.
 *    Day mode needs a cel read, and it needs it on materials that already exist
 *    and are already referenced by a thousand meshes — so swapping the class for
 *    MeshToonMaterial is off the table. Instead the standard material's direct
 *    lighting term is replaced at compile time: RE_Direct is redefined to a
 *    two-value sun/shade split, and GGX is clipped into one hard highlight.
 *
 *    The ramp edge is widened by fwidth(), so the terminator stays a clean curve
 *    at every distance instead of stair-stepping across a roof. Shadows come for
 *    free: lights_fragment_begin has already multiplied directLight.color by the
 *    shadow term before RE_Direct sees it, so a shadowed face simply drops to
 *    the ambient floor — which is exactly what a cartoon shadow is.
 *
 * 2. PER-INSTANCE COLOUR.
 *    The plaza's 1024 page frames, the WAL insert ring, the lock partitions, the
 *    CLOG bits and every flow particle are drawn from per-instance colour
 *    buffers that their districts fill each frame from values snapshotted at
 *    import. Those are night values and this module cannot reach them — but it
 *    can reach the one material they all flow through.
 *
 *    The remap is the same inversion the palette performs by hand. At night
 *    brightness means "hot" because the background is black and an empty frame
 *    is nearly invisible; in daylight the background is pale, so *ink* means hot
 *    and an empty frame has to be the light thing. Luminance is therefore
 *    inverted into a printable band, chroma is normalised so a saturated hue
 *    survives the move, and colours that were merely dim collapse toward grey
 *    rather than becoming saturated — an unused buffer must read as empty, not
 *    as blue.
 *
 * customProgramCacheKey() returns the mode, so three recompiles once per switch
 * and never confuses the two programs.
 * ==========================================================================*/

const TOON_GLSL = /* glsl */ `
void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );

	// The high threshold isolates the one wall aimed at the low sun. Roofs and
	// crossing walls catch the middle band; the return side stays genuinely cool.
	//
	// The edge width follows the screen-space gradient of dotNL so each
	// terminator stays about one pixel wide instead of aliasing at distance.
	float w = fwidth( dotNL ) * 0.9 + 0.012;
	float sun = 0.55 * smoothstep( 0.14 - w, 0.14 + w, dotNL )
	          + 0.45 * smoothstep( 0.68 - w, 0.68 + w, dotNL );

	// The third tone a drawn city needs is the roof, and no N·L threshold can
	// find it — a roof and a wall can share a dot product. This lifts faces that
	// point at the sky, in WORLD space: the fragment prefix declares viewMatrix,
	// and multiplying a vector from the left by a matrix is multiplying by its
	// transpose, which for the orthonormal rotation of a view matrix is its
	// inverse. So this is the world normal for one mat4 multiply.
	vec3 worldN = normalize( ( vec4( geometryNormal, 0.0 ) * viewMatrix ).xyz );
	float up = smoothstep( 0.55, 0.85, worldN.y );

	float graze = 0.14 * smoothstep( 0.02, 0.14, dotNL );
	vec3 irradiance = ( graze + 0.66 * sun + 0.20 * sun * up ) * directLight.color;

	// One clipped highlight instead of a smooth lobe: glass and metal still read
	// as glass and metal, but as a cartoon would draw them. Gated on roughness,
	// because without the gate matte stone gets a blown-white rim that reads as
	// neon — it was the highest-contrast feature on every wall in the city.
	vec3 spec = irradiance * BRDF_GGX_Multiscatter( directLight.direction, geometryViewDir, geometryNormal, material );
	float specLum = dot( spec, vec3( 0.2126, 0.7152, 0.0722 ) );
	float gloss = 1.0 - smoothstep( 0.35, 0.75, material.roughness );
	reflectedLight.directSpecular += spec * smoothstep( 0.035, 0.09, specLum ) * gloss;

	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Toon
`

const TOON_ANCHOR = '#include <lights_physical_pars_fragment>'
const VCOLOR_ANCHOR = '#include <color_fragment>'

/* ============================================================================
 * THE SURFACE TERM — masonry response in both modes, for zero draw calls/bytes.
 *
 * From five metres a thirty-metre wall was one unbroken field of a single RGB
 * value: no course, no joint, no gradient, no noise, and therefore no way for a
 * viewer to know it was thirty metres and not three. This is what fixes that,
 * and it lives here rather than in the districts because this hook already owns
 * onBeforeCompile for every mat() material in the city.
 *
 * WHAT IT MAY DO. The one height signal affects albedo, roughness, and the
 * standard material's lighting normal. It never writes emissive or adds a
 * bright seam. Albedo contrast stays below eight percent and relief below
 * 1.2 cm, so structure acquires material response without acquiring meaning.
 *
 * WHERE IT MAY GO. Injection is guarded on <roughnessmap_fragment>, an anchor
 * that exists only in the standard/physical fragment shader — which is exactly
 * the set of materials mat() paints. Every neon() (MeshBasicMaterial), every
 * line(), the plaza's per-instance deck, the ground plate, the sky dome and the
 * backend window bands are ShaderMaterials or basic materials and are excluded
 * by construction, not by a list somebody has to maintain.
 *
 * PROJECTION. World-space triplanar, never UV: theme.box(1,1,1) is shared and
 * instances are scaled from 0.12 x 0.6 x 9 up to 38 x 0.2 x 42, a 300:1 stretch
 * that no UV scheme survives. The world face normal is recovered from the
 * screen-space derivatives of the world position, which is exact for the
 * faceted boxes this city is built from and saves carrying a second varying.
 *
 * BOTH MODES. Night gets it too. The term is multiplicative, so seven percent
 * of a near-black navy is seven percent — a whisper that only appears where a
 * district mood lamp grazes a wall, which is correct: night's job is silhouette
 * and neon.
 * ==========================================================================*/

const SURFACE_ANCHOR = '#include <roughnessmap_fragment>'
const SURFACE_VERT_ANCHOR = '#include <worldpos_vertex>'
const SURFACE_NORMAL_ANCHOR = '#include <normal_fragment_maps>'
const BAKED_NORMAL_VERT_ANCHOR = '#include <normal_vertex>'
const BAKED_LIGHT_ANCHOR = '#include <lights_fragment_end>'

const BAKED_VERT_ATTRIBUTES = /* glsl */ `
#ifdef USE_INSTANCING
attribute vec3 pgBakeSkyA;
attribute vec3 pgBakeSkyB;
attribute vec3 pgBakeTransferA;
attribute vec3 pgBakeTransferB;
#else
attribute float pgBakeSky;
attribute float pgBakeTransfer;
#endif
varying vec3 pgBakedIndirect;
`

function linearChannel(byte: number): number {
  const value = byte / 255
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
}

function glslColor(hex: number): string {
  return [
    linearChannel((hex >> 16) & 255),
    linearChannel((hex >> 8) & 255),
    linearChannel(hex & 255),
  ].map((value) => value.toFixed(6)).join(', ')
}

function bakedVertexDecls(target: ThemeMode): string {
  const curated = curatedFor(target)
  const palette = BOUNCE_PALETTE_KEYS
    .map(
      (key, index) =>
        `\tif ( source < ${index + 0.5} ) return vec3( ${glslColor(PALETTES[curated][key])} );`,
    )
    .join('\n')
  const sky = BAKED_SKY_COLOR[curated].map((value) => value.toFixed(6)).join(', ')
  const bounce = BAKED_BOUNCE_GAIN[curated].toFixed(6)
  return /* glsl */ `
${BAKED_VERT_ATTRIBUTES}
const vec3 pgBakeSkyColor = vec3( ${sky} );
const float pgBakeBounceGain = ${bounce};

vec3 pgBakedPalette( float source ) {
${palette}
	return vec3( ${glslColor(PALETTES[curated].shmem)} );
}

vec3 pgBakedTransport( float sky, float packed ) {
	float byteValue = floor( packed * 255.0 + 0.5 );
	float source = floor( byteValue / 16.0 );
	float weight = mod( byteValue, 16.0 ) * ( 0.08 / 15.0 );
	return pgBakeSkyColor * sky + pgBakedPalette( source ) * weight * pgBakeBounceGain;
}
`
}

const BAKED_VERT = /* glsl */ `
{
	#ifdef USE_INSTANCING
		vec3 pgN = normalize( ( vec4( transformedNormal, 0.0 ) * viewMatrix ).xyz );
		vec3 pgA = abs( pgN );
		float pgSky;
		float pgTransfer;
		if ( pgA.x >= pgA.y && pgA.x >= pgA.z ) {
			if ( pgN.x >= 0.0 ) {
				pgSky = pgBakeSkyA.x;
				pgTransfer = pgBakeTransferA.x;
			} else {
				pgSky = pgBakeSkyA.y;
				pgTransfer = pgBakeTransferA.y;
			}
		} else if ( pgA.y >= pgA.z ) {
			if ( pgN.y >= 0.0 ) {
				pgSky = pgBakeSkyA.z;
				pgTransfer = pgBakeTransferA.z;
			} else {
				pgSky = pgBakeSkyB.x;
				pgTransfer = pgBakeTransferB.x;
			}
		} else if ( pgN.z >= 0.0 ) {
			pgSky = pgBakeSkyB.y;
			pgTransfer = pgBakeTransferB.y;
		} else {
			pgSky = pgBakeSkyB.z;
			pgTransfer = pgBakeTransferB.z;
		}
		pgBakedIndirect = pgBakedTransport( pgSky, pgTransfer );
	#else
		pgBakedIndirect = pgBakedTransport( pgBakeSky, pgBakeTransfer );
	#endif
}
`

const BAKED_FRAG_DECLS = /* glsl */ `
varying vec3 pgBakedIndirect;
`

const BAKED_LIGHT = /* glsl */ `
// Transport is irradiance, not albedo or self-light; the physical material still
// owns the diffuse response and GTAO can still darken the combined indirect term.
irradiance += pgBakedIndirect;
`

const SURFACE_VARYINGS = /* glsl */ `
varying vec3 pgWorld;
varying vec2 pgSeed;
`

const SURFACE_FRAG_DECLS = /* glsl */ `
varying vec3 pgWorld;
varying vec2 pgSeed;
float pgSurfaceHeight;
`

const SURFACE_VERT = /* glsl */ `
{
	vec4 pgP = vec4( transformed, 1.0 );
	vec3 pgO;
	#ifdef USE_INSTANCING
		pgP = instanceMatrix * pgP;
		pgO = ( modelMatrix * vec4( instanceMatrix[ 3 ].xyz, 1.0 ) ).xyz;
	#else
		pgO = modelMatrix[ 3 ].xyz;
	#endif
	pgWorld = ( modelMatrix * pgP ).xyz;
	/* The object's own world origin, hashed. instanceMatrix[3] is already in
	 * every instanced draw, so all 11,570 instances in the city get their own
	 * tone and their own joint phase for no attribute, no buffer and no CPU
	 * work at all. Quantising first keeps the hash stable under float drift. */
	float pgA = fract( sin( dot( floor( pgO * 2.0 ) + 0.5, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
	pgSeed = vec2( pgA, fract( pgA * 733.17 + 0.371 ) );
}
`

const SURFACE_FRAG = /* glsl */ `
{
	vec3 pgDX = dFdx( pgWorld );
	vec3 pgDY = dFdy( pgWorld );
	vec3 pgFN = abs( normalize( cross( pgDX, pgDY ) ) );
	// World metres covered by one pixel, used to retire the pattern before it
	// can alias instead of letting it turn into a flat grey wash at distance.
	float pgPx = max( dot( abs( pgDX ), vec3( 1.0 ) ), dot( abs( pgDY ), vec3( 1.0 ) ) );

	float pgFlat = smoothstep( 0.55, 0.82, pgFN.y );
	// Dominant-axis select, one mix rather than three planar evaluations: a wall
	// whose normal runs along X is coursed along Z, and the other way round. The
	// select flips only at a 45 degree corner, where it is a silhouette edge.
	float pgU = mix( pgWorld.x, pgWorld.z, step( pgFN.z, pgFN.x ) );

	// Courses first, joints second, and the alternate row offset half a stone.
	// Running bond is what stops this reading as a panel grid.
	float pgCourse = pgWorld.y / 1.15 + pgSeed.y * 0.7;
	float pgHead = pgU / 2.6 + fract( floor( pgCourse ) * 0.5 ) + pgSeed.x * 0.9;
	float pgBed = 1.0 - smoothstep( 0.0, fwidth( pgCourse ) * 1.5 + 0.03, 0.5 - abs( fract( pgCourse ) - 0.5 ) );
	float pgPerp = 1.0 - smoothstep( 0.0, fwidth( pgHead ) * 1.5 + 0.03, 0.5 - abs( fract( pgHead ) - 0.5 ) );
	float pgJoint = pgBed * 0.050 + pgPerp * 0.025;

	// A roof or a deck is paved, not coursed: bigger slabs, both directions,
	// and weaker, because a roof is mostly seen from above and far away.
	float pgSu = pgWorld.x / 3.7 + pgSeed.x * 0.5;
	float pgSv = pgWorld.z / 3.7 + pgSeed.y * 0.5;
	float pgSlab = ( 1.0 - smoothstep( 0.0, fwidth( pgSu ) * 1.5 + 0.03, 0.5 - abs( fract( pgSu ) - 0.5 ) ) )
	             + ( 1.0 - smoothstep( 0.0, fwidth( pgSv ) * 1.5 + 0.03, 0.5 - abs( fract( pgSv ) - 0.5 ) ) );
	pgJoint = mix( pgJoint, pgSlab * 0.032, pgFlat ) * ( 1.0 - smoothstep( 0.2, 0.55, pgPx ) );

	// Weathering. Three incommensurate waves with one warped argument, so it
	// never settles into a repeat, at four percent — below the joints, which is
	// the order a real wall reads in.
	float pgMu = mix( pgU, pgWorld.x, pgFlat );
	float pgMv = mix( pgWorld.y, pgWorld.z, pgFlat );
	float pgN = sin( pgMu * 0.61 + pgMv * 0.29 + sin( pgMv * 0.19 ) * 2.2 )
	          + 0.55 * sin( pgMu * 1.37 - pgMv * 0.91 )
	          + 0.30 * sin( pgMu * 2.9 + pgMv * 2.2 );
	pgN *= 0.54 * ( 1.0 - smoothstep( 1.2, 4.5, pgPx ) );

	// Relief retires sooner than albedo. At orbit range a one-pixel normal
	// variation shimmers even when the colour variation still reads as tone.
	float pgNormalFade = 1.0 - smoothstep( 0.12, 0.42, pgPx );
	pgSurfaceHeight = ( pgN * 0.008 - pgJoint * 0.16 ) * pgNormalFade;
	roughnessFactor = clamp( roughnessFactor + pgN * 0.025 + pgJoint * 0.42, 0.38, 1.0 );

	// Grade and rain: dirt collects in the first two metres above the pavement,
	// and the top of a tall building is washed cleaner than its middle.
	float pgGrade = 1.0 - 0.055 * ( 1.0 - smoothstep( 0.0, 1.8, pgWorld.y ) );
	float pgRain = 1.0 + 0.030 * smoothstep( 4.0, 34.0, pgWorld.y );

	// Per-object tone and a trace of temperature. Without this every backend
	// tower, every WAL silo and every lease post is a clone of its neighbour.
	float pgTone = 1.0 + ( pgSeed.x - 0.5 ) * 0.07;
	float pgWarm = ( pgSeed.y - 0.5 ) * 0.05;

	diffuseColor.rgb *= ( 1.0 - pgJoint ) * pgGrade * pgRain * pgTone * ( 1.0 + pgN * 0.038 );
	diffuseColor.rgb *= vec3( 1.0 + pgWarm, 1.0, 1.0 - pgWarm );
}
`

const SURFACE_NORMAL_FRAG = /* glsl */ `
{
	// Mikkelsen's derivative-space perturbation, fed by the height already used
	// above. No UV, tangent, texture fetch, or per-frame state is introduced.
	// Keep the surface derivatives in metres: unlike a UV bump map, this height
	// is authored in world metres, so normalising them would make a 1 cm joint
	// almost flat at walking distance.
	vec3 pgSigmaX = dFdx( - vViewPosition );
	vec3 pgSigmaY = dFdy( - vViewPosition );
	vec3 pgR1 = cross( pgSigmaY, normal );
	vec3 pgR2 = cross( normal, pgSigmaX );
	float pgDet = dot( pgSigmaX, pgR1 ) * faceDirection;
	// A 0.65 response keeps the mortar legible without turning weathering into
	// orange-peel. Distance retirement above handles the orbit case separately.
	vec2 pgDH = vec2( dFdx( pgSurfaceHeight ), dFdy( pgSurfaceHeight ) ) * 0.65;
	vec3 pgGrad = sign( pgDet ) * ( pgDH.x * pgR1 + pgDH.y * pgR2 );
	normal = normalize( abs( pgDet ) * normal - pgGrad );
}
`

/*
 * Written inline rather than as a function called from the chunk. A helper
 * declared at the top of the shader is not reliably in scope by the time the
 * colour chunk runs — three assembles the fragment source from a prefix, the
 * material shader and resolved includes, and a hoisted definition put in front
 * of that lot fails to link. A brace-scoped block substituted for the chunk
 * itself has no such problem and needs nothing declared anywhere else.
 *
 * `vColor.rgb` is valid whether vColor is a vec3 or (with alpha) a vec4.
 */
const VCOLOR_BODY = /* glsl */ `
#if defined( USE_COLOR_ALPHA ) || defined( USE_COLOR )
	{
		vec3 pgC = vColor.rgb;
		float pgM = max( max( pgC.r, pgC.g ), max( pgC.b, 1e-4 ) );
		float pgL = clamp( dot( pgC, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.0, 1.0 );
		// Bright at night becomes deep in daylight, and dark becomes pale. The
		// 0.45 exponent spends most of the band on the dim half, where the
		// buffer grid actually lives.
		float pgV = mix( 0.46, 0.04, pow( pgL, 0.45 ) );
		// Normalising by the largest channel keeps the hue and the saturation
		// while throwing away the magnitude, which is the part being re-decided
		// — but only for colours that had a magnitude to begin with. A
		// near-black navy means "this frame is empty", not "this frame is blue".
		//
		// The blend has to reach zero. With a floor under it, an instance set
		// to pure black — which is how a district says "this lamp is off" —
		// came out a flat mid-dark slab instead of an inert pale grey, and a
		// dark slab on a sunlit roof reads as something rather than nothing.
		vec3 pgOut = mix( vec3( pgV ), ( pgC / pgM ) * pgV, clamp( ( pgM - 0.02 ) * 6.0, 0.0, 1.0 ) );
		#if defined( USE_COLOR_ALPHA )
			diffuseColor *= vec4( pgOut, vColor.a );
		#else
			diffuseColor.rgb *= pgOut;
		#endif
	}
#endif
`

export interface ThemeShaderSource {
  vertexShader: string
  fragmentShader: string
}

/**
 * Patch one material's source for the current mode.
 *
 * The toon ramp and the per-instance colour remap are daylight devices and are
 * skipped at night. The surface term is not: it is multiplicative, so it is
 * correct in both modes, and night is the only mode that has no other way to
 * tell a wall from a slab once the neon is off.
 */
function patchThemeShader(shader: ThemeShaderSource, surface: boolean): void {
  let f = shader.fragmentShader
  if (airFor(mode).toon) {
    if (f.indexOf(TOON_ANCHOR) >= 0) f = f.replace(TOON_ANCHOR, TOON_ANCHOR + '\n' + TOON_GLSL)
    // The replacement is inert unless the material declares vertex colours: the
    // body it substitutes carries the same #if guards as the chunk it replaces.
    if (f.indexOf(VCOLOR_ANCHOR) >= 0) f = f.replace(VCOLOR_ANCHOR, VCOLOR_BODY)
  }
  // The anchor IS the guard. It exists only in the standard/physical fragment
  // shader, so meaning — every basic, line and ShaderMaterial in the city —
  // cannot receive this even by accident.
  if (surface && f.indexOf(SURFACE_ANCHOR) >= 0) {
    f = BAKED_FRAG_DECLS + SURFACE_FRAG_DECLS + f
      .replace(SURFACE_ANCHOR, SURFACE_ANCHOR + '\n' + SURFACE_FRAG)
      .replace(BAKED_LIGHT_ANCHOR, BAKED_LIGHT + '\n' + BAKED_LIGHT_ANCHOR)
    if (f.indexOf(SURFACE_NORMAL_ANCHOR) >= 0) {
      f = f.replace(SURFACE_NORMAL_ANCHOR, SURFACE_NORMAL_ANCHOR + '\n' + SURFACE_NORMAL_FRAG)
    }
    shader.vertexShader =
      bakedVertexDecls(mode) +
      SURFACE_VARYINGS +
      shader.vertexShader
        .replace(BAKED_NORMAL_VERT_ANCHOR, BAKED_NORMAL_VERT_ANCHOR + '\n' + BAKED_VERT)
        .replace(SURFACE_VERT_ANCHOR, SURFACE_VERT_ANCHOR + '\n' + SURFACE_VERT)
  }
  shader.fragmentShader = f
}

/*
 * Two stable hook references, not one closure per material: three compares the
 * function by identity when deciding whether a compiled program can be reused,
 * and customProgramCacheKey has to separate the two variants or a plain
 * material would be handed a surfaced material's program.
 */
function themeHook(shader: ThemeShaderSource): void {
  patchThemeShader(shader, true)
}

function themeHookPlain(shader: ThemeShaderSource): void {
  patchThemeShader(shader, false)
}

function themeCacheKey(): string {
  return airFor(mode).toon ? 'pg-day-s' : 'pg-night-s'
}

function themeCacheKeyPlain(): string {
  return airFor(mode).toon ? 'pg-day' : 'pg-night'
}

function isStandard(m: THREE.Material): m is THREE.MeshStandardMaterial {
  return (m as THREE.MeshStandardMaterial).isMeshStandardMaterial === true
}

/**
 * Wire the day shader into one material. Idempotent, and deliberately stingy
 * with `needsUpdate`: that flag costs a shader recompile, and a mode switch
 * touches every material in the city at once. Only a real change of mode pays
 * for one.
 *
 * ShaderMaterials are skipped — they carry no three chunks to replace, and
 * their colours are handled through their uniforms instead.
 */
function installThemeShader(m: THREE.Material, target: ThemeMode, surface: boolean): void {
  if ((m as THREE.ShaderMaterial).isShaderMaterial === true) return
  const ud = m.userData as ThemeUserData
  ud.pgSurface = surface
  const hook = surface ? themeHook : themeHookPlain
  if (m.onBeforeCompile !== hook) {
    m.onBeforeCompile = hook
    m.customProgramCacheKey = surface ? themeCacheKey : themeCacheKeyPlain
    ud.pgProgram = undefined
  }
  /* The compiled variant is (mode, surface), so the gate has to track both. A
   * gate that watched the toon flag alone would leave a material that changed
   * variant running its previous program until the next mode toggle. */
  const want = (airFor(target).toon ? 2 : 0) + (surface ? 1 : 0)
  if (ud.pgProgram === want) return
  ud.pgProgram = want
  m.needsUpdate = true
}

/* ============================================================================
 * COLOUR HELPERS
 * ==========================================================================*/

/** CSS string for a palette entry, e.g. `cssColor('wal')` → "#ffb03a". */
export function cssColor(key: ColorKey): string {
  return '#' + COLOR[key].toString(16).padStart(6, '0')
}

/** Mix two hex ints in linear-ish space. */
export function mixHex(a: number, b: number, t: number): number {
  return mix(a, b, t)
}

/**
 * Translate one AUTHORED (night) colour into the mode the city is in right now.
 *
 * For anything painted through `mat()`, `neon()` or `line()` this happens
 * automatically. This is the escape hatch for the places that cannot: a colour
 * snapshotted at import time into a typed array (the plaza's per-instance tints),
 * a route colour baked into a particle buffer, a registry entry's outline colour.
 * Wrap the night value at the point of use and subscribe to onThemeMode() to
 * re-derive, and that surface follows the switch too.
 */
export function modeColor(nightHex: number): number {
  return mode === 'day'
    ? dayAccent(nightHex)
    : mode === 'clock'
      ? clockAccent(nightHex, clockSun.daylight)
      : nightHex
}

const HEX6 = /^#([0-9a-f]{6})$/i

/**
 * Day value for a colour that was authored as CSS text (canvas decals, floor
 * signage, fingerposts). Deeper than the 3D accent so small type still holds
 * against pale stone, but still hued — the signage is colour-coded and has to
 * stay that way.
 */
function dayCssColor(css: string): string {
  const m = HEX6.exec(css.trim())
  if (!m) return css
  const hex = parseInt(m[1], 16)
  if (isNeutralExtreme(hex)) return css
  return '#' + mix(dayAccent(hex), 0x0e141c, 0.35).toString(16).padStart(6, '0')
}

function clockCssColor(css: string, daylight: number): string {
  const m = HEX6.exec(css.trim())
  if (!m) return css
  const night = parseInt(m[1], 16)
  if (isNeutralExtreme(night)) return css
  const day = parseInt(dayCssColor(css).slice(1), 16)
  return '#' + mix(night, day, daylight).toString(16).padStart(6, '0')
}

/* ============================================================================
 * MATERIAL PAINTING
 *
 * Every paint function takes the value the caller AUTHORED — always a night
 * value, because that is the mode src/world is written in — and derives the
 * current mode from it. Nothing ever reads the colour that happens to be on the
 * material, so switching back and forth is exact and idempotent.
 * ==========================================================================*/

interface MatSpec {
  /** The mat() cache key. Namespaced by district, and that is how it picks a stone. */
  key: string
  color: number
  roughness: number
  metalness: number
  emissive: number
  emissiveIntensity: number
  surface: boolean
}

function paintMat(m: THREE.MeshStandardMaterial, s: MatSpec, target: ThemeMode): void {
  const daylight = daylightFor(target)
  if (daylight > 0) {
    m.color.setHex(target === 'day' ? daySurface(s.color, s.key) : clockSurface(s.color, daylight, s.key))
    // A cel-shaded surface is matte by definition; what little variation is left
    // drives the size of the single highlight, so roughness is compressed rather
    // than flattened. Metal has no place in a cartoon and is nearly removed.
    m.roughness = THREE.MathUtils.lerp(s.roughness, Math.min(1, s.roughness * 0.55 + 0.42), daylight)
    m.metalness = THREE.MathUtils.lerp(s.metalness, s.metalness * 0.25, daylight)
    m.emissive.setHex(target === 'day' ? dayEmissive(s.emissive) : clockEmissive(s.emissive, daylight))
  } else {
    m.color.setHex(s.surface ? nightSurface(s.color) : s.color)
    m.roughness = s.roughness
    m.metalness = s.metalness
    m.emissive.setHex(s.emissive)
  }
  m.emissiveIntensity = s.emissiveIntensity
  installThemeShader(m, target, s.surface)
}

interface NeonSpec {
  color: number
  intensity: number
}

/** Linear luminance floor for semantic colour when no halo can carry it. */
const NO_BLOOM_NEON_LUMINANCE = 0.24

function colorLuminance(c: THREE.Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
}

/**
 * Bloom-off night neon is a saturated fill. Preserve the authored hue, but
 * stop low intensity from turning semantic state into a near-black surface.
 */
function paintNightNeonColor(color: THREE.Color, hex: number, intensity: number): void {
  color.setHex(hex)
  if (bloomAvailable) {
    color.multiplyScalar(intensity)
    return
  }

  const luminance = colorLuminance(color)
  if (luminance <= 0) return
  const maxChannel = Math.max(color.r, color.g, color.b)
  const target = Math.max(
    NO_BLOOM_NEON_LUMINANCE,
    luminance * Math.min(1.35, Math.max(1, intensity)),
  )
  color.multiplyScalar(Math.min(target / luminance, 1 / maxChannel))
}

function paintNeon(m: THREE.MeshBasicMaterial, s: NeonSpec, target: ThemeMode): void {
  const daylight = daylightFor(target)
  if (airFor(target).daylight) {
    const color = target === 'day' ? dayAccent(s.color) : clockAccent(s.color, daylight)
    const intensity = target === 'day'
      ? dayNeonIntensity(s.intensity)
      : clockNeonIntensity(s.intensity, daylight)
    m.color.setHex(color).multiplyScalar(intensity)
  } else {
    paintNightNeonColor(
      m.color,
      target === 'clock' ? clockAccent(s.color, daylight) : s.color,
      target === 'clock' ? clockNeonIntensity(s.intensity, daylight) : s.intensity,
    )
  }
  installThemeShader(m, target, false)
}

interface LineSpec {
  color: number
  opacity: number
}

function paintLine(m: THREE.LineBasicMaterial, s: LineSpec, target: ThemeMode): void {
  const daylight = daylightFor(target)
  const hex = target === 'day'
    ? dayInk(s.color)
    : target === 'clock'
      ? clockInk(s.color, daylight)
      : s.color
  const o = target === 'day'
    ? dayInkOpacity(s.opacity)
    : target === 'clock'
      ? clockInkOpacity(s.opacity, daylight)
      : s.opacity
  m.color.setHex(hex)
  m.opacity = o
  const wantsTransparent = o < 1
  if (m.transparent !== wantsTransparent) {
    m.transparent = wantsTransparent
    m.needsUpdate = true
  }
  installThemeShader(m, target, false)
}

/* ---------------------------------------------------------------------------
 * The generic pass, for materials the theme cache never saw.
 *
 * Thirteen world districts also build materials of their own, and between them
 * they own the ground plate, the pit, the light cones and every ShaderMaterial
 * in the city. Those cannot be enumerated, so they are translated structurally:
 * the authored night value is captured once into userData and every later
 * repaint derives from that capture. `vertexColors` materials are skipped — for
 * those `color` is a multiplier, not a colour, and moving it would recolour a
 * thousand instances at once.
 * -------------------------------------------------------------------------*/

interface CapturedNight {
  color?: number
  emissive?: number
  roughness?: number
  metalness?: number
  opacity?: number
  blending?: THREE.Blending
  uniforms?: Record<string, number>
}

interface ThemeUserData {
  /** Set on materials the theme cache owns: the generic pass must skip them. */
  pgTheme?: boolean
  /** Which (mode, surface) program variant is currently compiled in. */
  pgProgram?: number
  /** Stable bake eligibility, including explicit `surface: false`. */
  pgSurface?: boolean
  pgNight?: CapturedNight
  /** Exact daylight albedo for semantic zone surfaces. */
  pgDayColor?: number
  /**
   * Opt a scene material out of the masonry term. Set it on anything whose
   * albedo is carrying meaning rather than describing a material — the day
   * zoning plates are the case that exists today.
   */
  pgNoSurface?: boolean
}

function userData(m: THREE.Material): ThemeUserData {
  return m.userData as ThemeUserData
}

function colorUniforms(m: THREE.ShaderMaterial): Record<string, THREE.Color> | null {
  const out: Record<string, THREE.Color> = {}
  let any = false
  for (const name of Object.keys(m.uniforms)) {
    const v = m.uniforms[name]?.value as THREE.Color | undefined
    if (v && (v as THREE.Color).isColor) {
      out[name] = v
      any = true
    }
  }
  return any ? out : null
}

/**
 * Repaint one material that the theme cache does not own.
 *
 * Call it for every material in the scene on a mode change; it captures the
 * night value on first sight and is idempotent from then on.
 */
export function paintSceneMaterial(m: THREE.Material, target: ThemeMode): void {
  const ud = userData(m)
  if (ud.pgTheme) return // the cache repaints these itself, with better data

  let night = ud.pgNight
  const first = night === undefined
  if (night === undefined) night = ud.pgNight = {}

  const line = m as THREE.LineBasicMaterial
  const shader = m as THREE.ShaderMaterial
  const std = m as THREE.MeshStandardMaterial
  const basic = m as THREE.MeshBasicMaterial
  const daylight = daylightFor(target)

  if (shader.isShaderMaterial === true && shader.uniforms) {
    const cols = colorUniforms(shader)
    if (cols) {
      if (first) {
        const snap: Record<string, number> = {}
        for (const name of Object.keys(cols)) snap[name] = cols[name].getHex()
        night.uniforms = snap
      }
      const snap = night.uniforms
      if (snap) {
        for (const name of Object.keys(cols)) {
          const src = snap[name]
          if (src === undefined) continue
          cols[name].setHex(
            target === 'day'
              ? dayAccent(src)
              : target === 'clock'
                ? clockAccent(src, daylight)
                : src,
          )
        }
      }
    }
    return
  }

  if (line.isLineBasicMaterial === true) {
    installThemeShader(line, target, false)
    // A white line material is either a per-vertex multiplier (the shared-memory
    // beams, which the shader remap handles instead) or a chrome marker the
    // picker recolours on every selection. Either way its colour is not ours to
    // move.
    if (line.vertexColors === true) return
    if (first) {
      night.color = line.color.getHex()
      night.opacity = line.opacity
    }
    if (night.color !== undefined && night.opacity !== undefined && !isNeutralExtreme(night.color)) {
      paintLine(line, { color: night.color, opacity: night.opacity }, target)
    }
    return
  }

  // Additive blending is a night device: a halo only exists because there is
  // darkness for it to sit in. Added to a sunlit street it is white haze, and
  // the light cones, spill bands and lamp glows across the districts turn the
  // whole city into fog. Keep them — they still say "this thing is emitting" —
  // but at a fraction of the weight.
  if (first) night.blending = m.blending
  if (night.blending === THREE.AdditiveBlending) {
    if (first) night.opacity = m.opacity
    if (night.opacity !== undefined) m.opacity = THREE.MathUtils.lerp(night.opacity, night.opacity * 0.1, daylight)
    const blending = airFor(target).daylight ? THREE.NormalBlending : THREE.AdditiveBlending
    if (m.blending !== blending) {
      m.blending = blending
      m.needsUpdate = true
    }
  }

  const lit = isStandard(m)
  // Only lit structure is masonry. An unlit basic material is either meaning or
  // a decal, and a module can opt out of the term explicitly.
  const surface = lit && ud.pgNoSurface !== true && basic.vertexColors !== true
  installThemeShader(m, target, surface)

  const hasColor = (basic.color as THREE.Color | undefined) !== undefined
  // vertexColors means `color` is a per-instance multiplier; leave it white.
  const paintable = hasColor && basic.vertexColors !== true

  if (paintable) {
    if (first) night.color = basic.color.getHex()
    const src = night.color
    if (src !== undefined && !isNeutralExtreme(src)) {
      /* Two independent overrides meet here. Day takes an explicit
       * pgDayColor when a module has picked one, falling back to the derived
       * surface/accent. Night routes unlit basic materials through the neon
       * repaint so meaning survives when bloom is unavailable. */
      if (target === 'day') {
        basic.color.setHex(ud.pgDayColor ?? (lit ? daySurface(src, m.name) : dayAccent(src)))
      } else if (target === 'clock') {
        const translated = ud.pgDayColor === undefined
          ? lit
            ? clockSurface(src, daylight, m.name)
            : clockAccent(src, daylight)
          : mix(src, ud.pgDayColor, daylight)
        if (basic.isMeshBasicMaterial === true && basic.toneMapped === false && !airFor(target).daylight) {
          paintNightNeonColor(basic.color, translated, 1)
        } else {
          basic.color.setHex(translated)
        }
      } else if (basic.isMeshBasicMaterial === true && basic.toneMapped === false) {
        paintNightNeonColor(basic.color, src, 1)
      } else {
        basic.color.setHex(surface ? nightSurface(src) : src)
      }
    }
  }

  if (lit) {
    if (first) {
      night.emissive = std.emissive.getHex()
      night.roughness = std.roughness
      night.metalness = std.metalness
    }
    if (night.emissive !== undefined) {
      std.emissive.setHex(
        target === 'day'
          ? dayEmissive(night.emissive)
          : target === 'clock'
            ? clockEmissive(night.emissive, daylight)
            : night.emissive,
      )
    }
    if (night.roughness !== undefined) {
      std.roughness = THREE.MathUtils.lerp(
        night.roughness,
        Math.min(1, night.roughness * 0.55 + 0.42),
        daylight,
      )
    }
    if (night.metalness !== undefined) {
      std.metalness = THREE.MathUtils.lerp(night.metalness, night.metalness * 0.25, daylight)
    }
  }
}

/* ============================================================================
 * THE CACHE
 *
 * Shared material / geometry cache.
 *
 * IMPORTANT for world modules: never mutate a material returned by `mat()` or
 * `neon()` — they are shared, and a theme switch will overwrite you. If you need
 * per-object state, either ask for a unique cache key or clone it.
 * ==========================================================================*/

export function createTheme(): ThemeApi {
  const mats = new Map<string, THREE.MeshStandardMaterial>()
  const matSpecs = new Map<string, MatSpec>()
  const neons = new Map<string, THREE.MeshBasicMaterial>()
  const neonSpecs = new Map<string, NeonSpec>()
  const lines = new Map<string, THREE.LineBasicMaterial>()
  const lineSpecs = new Map<string, LineSpec>()
  const boxes = new Map<string, ReturnType<typeof pairBoxGeometries>>()
  const cyls = new Map<string, THREE.CylinderGeometry>()
  const texts = new Map<string, THREE.Texture>()
  const textSpecs = new Map<string, { text: string; opts: TextTexOpts; canvas: HTMLCanvasElement }>()

  function mat(key: string, opts: MatOpts = {}): THREE.MeshStandardMaterial {
    let m = mats.get(key)
    if (!m) {
      const metalness = opts.metalness ?? 0.28
      const spec: MatSpec = {
        key,
        color: opts.color ?? 0x223049,
        roughness: opts.roughness ?? 0.62,
        metalness,
        emissive: opts.emissive ?? 0x000000,
        emissiveIntensity: opts.emissiveIntensity ?? 1,
        /* Structure is masonry by default, machinery is not. Metalness is
         * already how this city says "this is a steel thing": a flywheel, a
         * vault door, a pressure vessel. Coursed joints on any of them claim
         * the wrong material, so the default follows the metal. */
        surface: opts.surface ?? metalness < 0.45,
      }
      m = new THREE.MeshStandardMaterial({
        transparent: opts.transparent ?? false,
        opacity: opts.opacity ?? 1,
        flatShading: opts.flatShading ?? false,
        side: opts.side ?? THREE.FrontSide,
        polygonOffset: opts.polygonOffset ?? false,
        polygonOffsetFactor: opts.polygonOffsetFactor ?? 0,
        polygonOffsetUnits: opts.polygonOffsetUnits ?? 0,
      })
      m.name = key
      userData(m).pgTheme = true
      matSpecs.set(key, spec)
      mats.set(key, m)
      paintMat(m, spec, mode)
    }
    return m
  }

  function neon(color: number, intensity = 1.6, opts: NeonOpts = {}) {
    const key = [
      color,
      intensity,
      opts.transparent ? 1 : 0,
      opts.opacity ?? 1,
      opts.polygonOffset ? 1 : 0,
      opts.polygonOffsetFactor ?? 0,
      opts.polygonOffsetUnits ?? 0,
    ].join('|')
    let m = neons.get(key)
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        toneMapped: false,
        transparent: opts.transparent ?? false,
        opacity: opts.opacity ?? 1,
        depthWrite: opts.transparent ? false : true,
        polygonOffset: opts.polygonOffset ?? false,
        polygonOffsetFactor: opts.polygonOffsetFactor ?? 0,
        polygonOffsetUnits: opts.polygonOffsetUnits ?? 0,
      })
      m.name = `neon:${key}`
      userData(m).pgTheme = true
      const spec: NeonSpec = { color, intensity }
      neonSpecs.set(key, spec)
      neons.set(key, m)
      paintNeon(m, spec, mode)
    }
    return m
  }

  function line(color: number, opacity = 0.5): THREE.LineBasicMaterial {
    const key = `${color}|${opacity}`
    let m = lines.get(key)
    if (!m) {
      m = new THREE.LineBasicMaterial({
        toneMapped: false,
        depthWrite: false,
      })
      m.name = `line:${key}`
      userData(m).pgTheme = true
      const spec: LineSpec = { color, opacity }
      lineSpecs.set(key, spec)
      lines.set(key, m)
      paintLine(m, spec, mode)
    }
    return m
  }

  function edges(geo: THREE.BufferGeometry, color: number, opacity = 0.55): THREE.LineSegments {
    const e = new THREE.EdgesGeometry(geo, 25)
    const ls = new THREE.LineSegments(e, line(color, opacity))
    ls.renderOrder = 2
    ls.raycast = () => {}
    return ls
  }

  function box(w: number, h: number, d: number): THREE.BufferGeometry {
    const key = `${w}|${h}|${d}`
    let pair = boxes.get(key)
    if (!pair) boxes.set(key, (pair = pairBoxGeometries(w, h, d)))
    return pair.beveled
  }

  function cyl(rt: number, rb: number, h: number, seg = 16): THREE.CylinderGeometry {
    const key = `${rt}|${rb}|${h}|${seg}`
    let g = cyls.get(key)
    if (!g) cyls.set(key, (g = new THREE.CylinderGeometry(rt, rb, h, seg)))
    return g
  }

  /**
   * Draw one text texture into an existing canvas. Split out of textTexture()
   * because a mode change re-draws it in place: the THREE.Texture object is
   * kept, so every decal and fingerpost in the city follows the switch without
   * anybody re-registering a material.
   */
  function drawText(cv: HTMLCanvasElement, text: string, opts: TextTexOpts, target: ThemeMode): void {
    const size = opts.size ?? 64
    const pad = opts.padding ?? size * 0.4
    const font = opts.font ?? `600 ${size}px ${'ui-monospace, SFMono-Regular, Menlo, monospace'}`
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, cv.width, cv.height)
    if (opts.bg) {
      ctx.fillStyle = target === 'day'
        ? dayCssColor(opts.bg)
        : target === 'clock'
          ? clockCssColor(opts.bg, daylightFor(target))
          : opts.bg
      ctx.fillRect(0, 0, cv.width, cv.height)
    }
    ctx.font = font
    ctx.textAlign = opts.align ?? 'center'
    ctx.textBaseline = 'middle'
    const ink = opts.color ?? '#dbe7ff'
    ctx.fillStyle = target === 'day'
      ? dayCssColor(ink)
      : target === 'clock'
        ? clockCssColor(ink, daylightFor(target))
        : ink
    if ('letterSpacing' in ctx && opts.letterSpacing) {
      ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = opts.letterSpacing
    }
    const x = ctx.textAlign === 'center' ? cv.width / 2 : ctx.textAlign === 'right' ? cv.width - pad : pad
    ctx.fillText(text, x, cv.height / 2)
  }

  function textTexture(text: string, opts: TextTexOpts = {}): THREE.Texture {
    const key = `${text}|${JSON.stringify(opts)}`
    const hit = texts.get(key)
    if (hit) return hit

    const size = opts.size ?? 64
    const pad = opts.padding ?? size * 0.4
    const font = opts.font ?? `600 ${size}px ${'ui-monospace, SFMono-Regular, Menlo, monospace'}`
    const measure = document.createElement('canvas').getContext('2d')!
    measure.font = font
    const w = Math.ceil(measure.measureText(text).width + pad * 2)
    const h = Math.ceil(size * 1.6 + pad)

    const cv = document.createElement('canvas')
    cv.width = Math.max(2, nextPow2(w))
    cv.height = Math.max(2, nextPow2(h))
    drawText(cv, text, opts, mode)

    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    tex.needsUpdate = true
    texts.set(key, tex)
    textSpecs.set(key, { text, opts, canvas: cv })
    return tex
  }

  /** Repaint every cached material for `target`. No geometry is touched. */
  function repaint(target: ThemeMode): void {
    for (const [key, m] of mats) {
      const s = matSpecs.get(key)
      if (s) paintMat(m, s, target)
    }
    for (const [key, m] of neons) {
      const s = neonSpecs.get(key)
      if (s) paintNeon(m, s, target)
    }
    for (const [key, m] of lines) {
      const s = lineSpecs.get(key)
      if (s) paintLine(m, s, target)
    }
    for (const [key, tex] of texts) {
      const s = textSpecs.get(key)
      if (!s) continue
      drawText(s.canvas, s.text, s.opts, target)
      tex.needsUpdate = true
    }
  }

  const self = { repaint }
  caches.add(self)

  function dispose() {
    caches.delete(self)
    for (const m of mats.values()) m.dispose()
    for (const m of neons.values()) m.dispose()
    for (const m of lines.values()) m.dispose()
    for (const pair of boxes.values()) {
      pair.plain.dispose()
      pair.beveled.dispose()
    }
    for (const g of cyls.values()) g.dispose()
    for (const t of texts.values()) t.dispose()
    mats.clear()
    matSpecs.clear()
    neons.clear()
    neonSpecs.clear()
    lines.clear()
    lineSpecs.clear()
    boxes.clear()
    cyls.clear()
    texts.clear()
    textSpecs.clear()
  }

  return { color: COLOR, mat, neon, line, edges, textTexture, box, cyl, dispose }
}

function nextPow2(v: number): number {
  let p = 1
  while (p < v) p <<= 1
  return p
}
