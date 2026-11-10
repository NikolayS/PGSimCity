import * as THREE from 'three'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

export const GOLDEN_HOUR_GRADE = {
  lift: 0.008,
  gamma: 0.96,
  gain: 1.035,
  midtoneSaturation: 1.07,
  vignette: 0.075,
  /** Filmic contrast about scene grey: deepens shade, opens sunlit stone. */
  contrast: 1.22,
  pivot: 0.18,
} as const

/**
 * Lens response applied after tone mapping and display encoding, in both modes.
 * It is spatial only: the centre of the frame, where the palette is read, keeps
 * the exact graded value, so no semantic colour moves.
 */
export const FILM_LENS = {
  /** Peak-to-peak display-space luminance noise in the midtones. */
  grain: 0.034,
  /** Corner darkening added to night, which has no golden-hour vignette. */
  nightVignette: 0.3,
  dayVignette: 0.12,
} as const

/** Display-space multiplier of the lens falloff; `edge` is 0 at centre, 1 in the corner. */
export function filmVignette(edge: number, strength: number): number {
  const t = Math.max(0, Math.min(1, (edge - 0.18) / (1.0 - 0.18)))
  return 1 - strength * t * t * (3 - 2 * t)
}

/** Extra ground-layer haze never replaces more than this much scene colour. */
export const HEIGHT_FOG_MAX = 0.2

export function heightFogAmount(
  distance: number,
  cameraHeight: number,
  surfaceHeight: number,
  density: number,
  falloff: number,
  maximum = HEIGHT_FOG_MAX,
): number {
  const eyeDensity = Math.exp(-Math.max(0, cameraHeight) * falloff)
  const surfaceDensity = Math.exp(-Math.max(0, surfaceHeight) * falloff)
  const averageDensity = (eyeDensity + surfaceDensity * 2) / 3
  return Math.min(maximum, Math.max(0, 1 - Math.exp(-Math.max(0, distance) * density * averageDensity)))
}

const GRADE_UNIFORMS = /* glsl */ `
uniform float pgGradeEnabled;
uniform float pgGradeLift;
uniform float pgGradeGamma;
uniform float pgGradeGain;
uniform float pgGradeSaturation;
uniform float pgGradeVignette;
uniform float pgGradeContrast;
uniform float pgGradePivot;

vec3 pgGoldenHourGrade( vec3 color, vec2 uv ) {
	color = max( color + vec3( pgGradeLift ), vec3( 0.0 ) );
	color = pow( color, vec3( 1.0 / pgGradeGamma ) ) * pgGradeGain;
	// Luminance-only power about the pivot: scene grey is fixed and every
	// channel scales together, so two close semantic hues cannot converge.
	float tone = max( dot( color, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.00001 );
	color *= pgGradePivot * pow( tone / pgGradePivot, pgGradeContrast ) / tone;

	float luma = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
	float mids = smoothstep( 0.02, 0.18, luma ) * ( 1.0 - smoothstep( 0.65, 1.20, luma ) );
	color = mix( vec3( luma ), color, mix( 1.0, pgGradeSaturation, mids ) );

	vec2 frame = uv * 2.0 - 1.0;
	float edge = smoothstep( 0.30, 1.35, dot( frame, frame ) );
	return max( color * ( 1.0 - pgGradeVignette * edge ), vec3( 0.0 ) );
}
`

const AERIAL_UNIFORMS = /* glsl */ `
uniform sampler2D pgSceneDepth;
uniform float pgAerialEnabled;
uniform float pgHeightFogDensity;
uniform float pgHeightFogFalloff;
uniform float pgHeightFogMax;
uniform vec3 pgHeightFogColor;
uniform vec3 pgCameraPosition;
uniform mat4 pgProjectionInverse;
uniform mat4 pgCameraWorld;

float pgHeightFogAmount( float distanceToEye, float eyeY, float surfaceY ) {
  float eyeDensity = exp( - max( 0.0, eyeY ) * pgHeightFogFalloff );
  float surfaceDensity = exp( - max( 0.0, surfaceY ) * pgHeightFogFalloff );
  float averageDensity = ( eyeDensity + surfaceDensity * 2.0 ) / 3.0;
  return min( pgHeightFogMax, 1.0 - exp( - distanceToEye * pgHeightFogDensity * averageDensity ) );
}

vec3 pgApplyHeightFog( vec3 color, vec2 uv ) {
  float depth = texture2D( pgSceneDepth, uv ).x;
  if ( depth >= 0.999999 ) return color;
  vec4 clip = vec4( uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
  vec4 view = pgProjectionInverse * clip;
  view /= max( view.w, 0.000001 );
  vec3 world = ( pgCameraWorld * view ).xyz;
  float amount = pgHeightFogAmount( length( world - pgCameraPosition ), pgCameraPosition.y, world.y );
  return mix( color, pgHeightFogColor, amount );
}
`

const FILM_UNIFORMS = /* glsl */ `
uniform float pgFilmGrain;
uniform float pgFilmVignette;
uniform float pgFilmTime;

vec3 pgFilmLens( vec3 color, vec2 uv ) {
	vec2 frame = uv * 2.0 - 1.0;
	float edge = smoothstep( 0.18, 1.0, dot( frame, frame ) * 0.5 );
	color *= 1.0 - pgFilmVignette * edge;
	// Interleaved gradient noise: no texture, stable per pixel, re-seeded in time.
	vec2 cell = gl_FragCoord.xy + fract( pgFilmTime * vec2( 7.13, 3.71 ) ) * 289.0;
	float noise = fract( 52.9829189 * fract( dot( cell, vec2( 0.06711056, 0.00583715 ) ) ) ) - 0.5;
	float luma = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
	// Grain lives in the midtones; clean blacks keep night neon crisp.
	float weight = smoothstep( 0.0, 0.12, luma ) * ( 1.0 - 0.55 * smoothstep( 0.55, 1.0, luma ) );
	return max( color + noise * pgFilmGrain * weight, vec3( 0.0 ) );
}
`

/**
 * Night haze lit by the city. The source is the bloom chain's widest blur,
 * which holds only what already cleared the bloom threshold, so the haze can
 * glow only where a semantic signal is: it spreads meaning, it adds none.
 */
export const LIGHT_SCATTER = {
  /** Linear-HDR gain on the wide blur at full path length. */
  strength: 0.42,
  /** Share present even at arm's length, so near lamps are not haloless. */
  nearShare: 0.3,
  nearMetres: 40,
  farMetres: 700,
  /** Gain on the tighter blur where it falls on the wet plate: a pool of light under its source. */
  groundPool: 2.2,
  /** Paving and the district platforms standing on it, which is where lamps are. */
  plateBand: 0.25,
} as const

/** Fraction of the scatter gain a surface at `distance` metres receives. */
export function lightScatterShare(distance: number): number {
  const t = Math.max(0, Math.min(1, (distance - LIGHT_SCATTER.nearMetres) / (LIGHT_SCATTER.farMetres - LIGHT_SCATTER.nearMetres)))
  return LIGHT_SCATTER.nearShare + (1 - LIGHT_SCATTER.nearShare) * t * t * (3 - 2 * t)
}

const SCATTER_UNIFORMS = /* glsl */ `
uniform sampler2D pgScatterWide;
uniform sampler2D pgScatterMid;
uniform float pgScatterStrength;
uniform float pgGroundPool;

vec3 pgLightScatter( vec3 color, vec2 uv ) {
	float depth = texture2D( pgSceneDepth, uv ).x;
	float path = 1.0;
	if ( depth < 0.999999 ) {
		vec4 view = pgProjectionInverse * vec4( uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
		view /= max( view.w, 0.000001 );
		path = smoothstep( ${LIGHT_SCATTER.nearMetres.toFixed(1)}, ${LIGHT_SCATTER.farMetres.toFixed(1)}, length( view.xyz ) );
		// Wet paving under a lamp is lit by it. Screen-space, so a source out of
		// frame lights nothing, which errs dark rather than inventing a glow.
		if ( pgGroundPool > 0.0 && abs( ( pgCameraWorld * view ).y ) < ${LIGHT_SCATTER.plateBand.toFixed(3)} ) {
			color += texture2D( pgScatterMid, uv ).rgb * pgGroundPool;
		}
	}
	float share = ${LIGHT_SCATTER.nearShare.toFixed(3)} + ${(1 - LIGHT_SCATTER.nearShare).toFixed(3)} * path;
	return color + texture2D( pgScatterWide, uv ).rgb * pgScatterStrength * share;
}
`

const FILM_ANCHOR = '\n\t\t}'

const SAMPLE_ANCHOR = 'uniform sampler2D tDiffuse;'
const GRADE_ANCHOR = '\n\t\t\t// tone mapping'

interface SceneDepthSource {
  sceneDepthTexture: THREE.DepthTexture | null
}

/**
 * OutputPass with mode-aware aerial perspective and the daylight grade fused
 * ahead of tone mapping. It costs no second fullscreen pass or render target.
 */
export class GoldenHourOutputPass extends OutputPass {
  private readonly camera: THREE.PerspectiveCamera | null
  private readonly depthSource: SceneDepthSource | null
  private filmAnimated = true
  private scatterStrength = 0

  constructor(camera: THREE.PerspectiveCamera | null = null, depthSource: SceneDepthSource | null = null) {
    super()
    this.camera = camera
    this.depthSource = depthSource
    this.uniforms.pgGradeEnabled = { value: 0 }
    this.uniforms.pgGradeLift = { value: GOLDEN_HOUR_GRADE.lift }
    this.uniforms.pgGradeGamma = { value: GOLDEN_HOUR_GRADE.gamma }
    this.uniforms.pgGradeGain = { value: GOLDEN_HOUR_GRADE.gain }
    this.uniforms.pgGradeSaturation = { value: GOLDEN_HOUR_GRADE.midtoneSaturation }
    this.uniforms.pgGradeVignette = { value: GOLDEN_HOUR_GRADE.vignette }
    this.uniforms.pgGradeContrast = { value: GOLDEN_HOUR_GRADE.contrast }
    this.uniforms.pgGradePivot = { value: GOLDEN_HOUR_GRADE.pivot }
    this.uniforms.pgScatterWide = { value: null }
    this.uniforms.pgScatterMid = { value: null }
    this.uniforms.pgGroundPool = { value: 0 }
    this.uniforms.pgScatterStrength = { value: 0 }
    this.uniforms.pgFilmGrain = { value: 0 }
    this.uniforms.pgFilmVignette = { value: 0 }
    this.uniforms.pgFilmTime = { value: 0 }
    this.uniforms.pgSceneDepth = { value: null }
    this.uniforms.pgAerialEnabled = { value: 0 }
    this.uniforms.pgHeightFogDensity = { value: 0 }
    this.uniforms.pgHeightFogFalloff = { value: 0.02 }
    this.uniforms.pgHeightFogMax = { value: 0 }
    this.uniforms.pgHeightFogColor = { value: new THREE.Color() }
    this.uniforms.pgCameraPosition = { value: new THREE.Vector3() }
    this.uniforms.pgProjectionInverse = { value: new THREE.Matrix4() }
    this.uniforms.pgCameraWorld = { value: new THREE.Matrix4() }
    this.material.fragmentShader = this.material.fragmentShader
      .replace(SAMPLE_ANCHOR, `${SAMPLE_ANCHOR}\n${GRADE_UNIFORMS}\n${AERIAL_UNIFORMS}\n${SCATTER_UNIFORMS}\n${FILM_UNIFORMS}`)
      .replace(
        GRADE_ANCHOR,
        '\n\t\t\tif ( pgAerialEnabled > 0.5 ) gl_FragColor.rgb = pgApplyHeightFog( gl_FragColor.rgb, vUv );' +
          '\n\t\t\tif ( pgScatterStrength > 0.0 ) gl_FragColor.rgb = pgLightScatter( gl_FragColor.rgb, vUv );' +
          '\n\t\t\tif ( pgGradeEnabled > 0.5 ) gl_FragColor.rgb = pgGoldenHourGrade( gl_FragColor.rgb, vUv );' +
          GRADE_ANCHOR,
      )
    const body = this.material.fragmentShader
    const end = body.lastIndexOf(FILM_ANCHOR)
    this.material.fragmentShader =
      body.slice(0, end) + '\n\t\t\tgl_FragColor.rgb = pgFilmLens( gl_FragColor.rgb, vUv );' + body.slice(end)
    this.material.name = 'PGSimCity.GoldenHourOutput'
  }

  setDaylight(enabled: boolean): void {
    this.uniforms.pgGradeEnabled.value = enabled ? 1 : 0
  }

  /** Grain is frozen for reduced motion: a static texture, never a flicker. */
  setFilm(grain: number, vignette: number, animated: boolean): void {
    this.uniforms.pgFilmGrain.value = grain
    this.uniforms.pgFilmVignette.value = vignette
    this.filmAnimated = animated
    if (!animated) this.uniforms.pgFilmTime.value = 0
  }

  /** `wide` is the bloom chain's widest blur; null or zero strength disables the term. */
  setLightScatter(wide: THREE.Texture | null, strength: number, mid: THREE.Texture | null = null, groundPool = 0): void {
    this.uniforms.pgScatterWide.value = wide
    this.uniforms.pgScatterMid.value = mid ?? wide
    this.scatterStrength = wide ? strength : 0
    this.uniforms.pgGroundPool.value = wide && mid ? groundPool : 0
  }

  setAerialPerspective(color: number, density: number, falloff: number, strength: number): void {
    this.uniforms.pgHeightFogColor.value.setHex(color)
    this.uniforms.pgHeightFogDensity.value = density * strength
    this.uniforms.pgHeightFogFalloff.value = falloff
    this.uniforms.pgHeightFogMax.value = HEIGHT_FOG_MAX * strength
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    const depth = this.depthSource?.sceneDepthTexture ?? null
    const camera = this.camera
    this.uniforms.pgAerialEnabled.value = depth && camera && this.uniforms.pgHeightFogDensity.value > 0 ? 1 : 0
    if (depth && camera) {
      this.uniforms.pgSceneDepth.value = depth
      this.uniforms.pgCameraPosition.value.copy(camera.position)
      this.uniforms.pgProjectionInverse.value.copy(camera.projectionMatrixInverse)
      this.uniforms.pgCameraWorld.value.copy(camera.matrixWorld)
    }
    // Scatter needs the path length; without scene depth it would glow uniformly.
    this.uniforms.pgScatterStrength.value = depth && camera ? this.scatterStrength : 0
    if (this.filmAnimated) this.uniforms.pgFilmTime.value = (this.uniforms.pgFilmTime.value + deltaTime) % 64
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive)
  }
}

type Rgb = readonly [number, number, number]

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
}

function linearToSrgb(value: number): number {
  const v = Math.max(0, value)
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

function hexToLinear(hex: number): Rgb {
  return [
    srgbToLinear(((hex >> 16) & 255) / 255),
    srgbToLinear(((hex >> 8) & 255) / 255),
    srgbToLinear((hex & 255) / 255),
  ]
}

function linearToHex(rgb: Rgb): number {
  const r = Math.round(clamp01(linearToSrgb(rgb[0])) * 255)
  const g = Math.round(clamp01(linearToSrgb(rgb[1])) * 255)
  const b = Math.round(clamp01(linearToSrgb(rgb[2])) * 255)
  return (r << 16) | (g << 8) | b
}

function gradeLinear(rgb: Rgb, edge: number): Rgb {
  const graded: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    graded[i] =
      Math.pow(Math.max(0, rgb[i] + GOLDEN_HOUR_GRADE.lift), 1 / GOLDEN_HOUR_GRADE.gamma) *
      GOLDEN_HOUR_GRADE.gain
  }
  const tone = Math.max(0.00001, 0.2126 * graded[0] + 0.7152 * graded[1] + 0.0722 * graded[2])
  const toneScale =
    (GOLDEN_HOUR_GRADE.pivot * Math.pow(tone / GOLDEN_HOUR_GRADE.pivot, GOLDEN_HOUR_GRADE.contrast)) / tone
  for (let i = 0; i < 3; i++) graded[i] *= toneScale
  const luma = 0.2126 * graded[0] + 0.7152 * graded[1] + 0.0722 * graded[2]
  const smoothstep = (a: number, b: number, value: number): number => {
    const t = clamp01((value - a) / (b - a))
    return t * t * (3 - 2 * t)
  }
  const mids = smoothstep(0.02, 0.18, luma) * (1 - smoothstep(0.65, 1.2, luma))
  const saturation = 1 + (GOLDEN_HOUR_GRADE.midtoneSaturation - 1) * mids
  const vignette = 1 - GOLDEN_HOUR_GRADE.vignette * clamp01(edge)
  return [
    Math.max(0, (luma + (graded[0] - luma) * saturation) * vignette),
    Math.max(0, (luma + (graded[1] - luma) * saturation) * vignette),
    Math.max(0, (luma + (graded[2] - luma) * saturation) * vignette),
  ]
}

/** CPU mirror of three r185's NeutralToneMapping at the daylight exposure. */
function neutralToneMap(rgb: Rgb): Rgb {
  const color: [number, number, number] = [rgb[0], rgb[1], rgb[2]]
  const x = Math.min(color[0], color[1], color[2])
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04
  for (let i = 0; i < 3; i++) color[i] -= offset
  const peak = Math.max(color[0], color[1], color[2])
  const startCompression = 0.76
  if (peak < startCompression) return color
  const d = 1 - startCompression
  const newPeak = 1 - (d * d) / (peak + d - startCompression)
  const scale = newPeak / peak
  for (let i = 0; i < 3; i++) color[i] *= scale
  const desaturate = 1 - 1 / (0.15 * (peak - newPeak) + 1)
  return [
    color[0] + (newPeak - color[0]) * desaturate,
    color[1] + (newPeak - color[1]) * desaturate,
    color[2] + (newPeak - color[2]) * desaturate,
  ]
}

/** Palette readout after the actual day grade, Neutral tone map and sRGB encode. */
export function gradeDaylightHex(hex: number, vignetteEdge = 0): number {
  return linearToHex(neutralToneMap(gradeLinear(hexToLinear(hex), vignetteEdge)))
}

/** Palette readout at the brightest point of the pre-grade shaft composite. */
export function gradeDaylightHexWithScatter(hex: number, scatterHex: number, strength: number): number {
  const base = hexToLinear(hex)
  const scatter = hexToLinear(scatterHex)
  const lit: Rgb = [
    base[0] + scatter[0] * strength,
    base[1] + scatter[1] * strength,
    base[2] + scatter[2] * strength,
  ]
  return linearToHex(neutralToneMap(gradeLinear(lit, 0)))
}

/** Palette readout through the strongest fused height-haze path. */
export function gradeDaylightHexWithHeightFog(hex: number, fogHex: number, amount: number): number {
  return gradeDaylightHexWithEffects(hex, fogHex, amount, 0, 0)
}

/** Palette readout through the tier's combined shaft and height-haze path. */
export function gradeDaylightHexWithEffects(
  hex: number,
  fogHex: number,
  fogAmount: number,
  scatterHex: number,
  scatterStrength: number,
): number {
  const base = hexToLinear(hex)
  const fog = hexToLinear(fogHex)
  const scatter = hexToLinear(scatterHex)
  const lit: Rgb = [
    base[0] + scatter[0] * scatterStrength,
    base[1] + scatter[1] * scatterStrength,
    base[2] + scatter[2] * scatterStrength,
  ]
  const t = clamp01(fogAmount)
  const hazed: Rgb = [
    lit[0] + (fog[0] - lit[0]) * t,
    lit[1] + (fog[1] - lit[1]) * t,
    lit[2] + (fog[2] - lit[2]) * t,
  ]
  return linearToHex(neutralToneMap(gradeLinear(hazed, 0)))
}

/** Semantic palette readout after the linear height-haze blend used at night. */
export function foggedNightHex(hex: number, fogHex: number, amount: number): number {
  const base = hexToLinear(hex)
  const fog = hexToLinear(fogHex)
  const t = clamp01(amount)
  return linearToHex([
    base[0] + (fog[0] - base[0]) * t,
    base[1] + (fog[1] - base[1]) * t,
    base[2] + (fog[2] - base[2]) * t,
  ])
}

/** Palette readout through the same output path with the grade disabled. */
export function ungradedDaylightHex(hex: number): number {
  return linearToHex(neutralToneMap(hexToLinear(hex)))
}

function oklab(hex: number): Rgb {
  const [r, g, b] = hexToLinear(hex)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** Euclidean OKLab distance; 0.045 is a conservative just-noticeable margin. */
export function perceptualColorDistance(a: number, b: number): number {
  const aa = oklab(a)
  const bb = oklab(b)
  return Math.hypot(aa[0] - bb[0], aa[1] - bb[1], aa[2] - bb[2])
}
