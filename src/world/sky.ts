import * as THREE from 'three'
import { COLOR, mixHex } from '../core/theme'
import type { Atmosphere } from '../core/theme'
import { makeRng } from '../core/util'
import type { QualityLevel, ThemeApi } from '../core/types'

/* ============================================================================
 * SKY — one procedural atmosphere, with deliberately different day and night.
 *
 * Everything is procedural: a Preetham day atmosphere, the established night
 * dome, one instanced cloud draw, and one Points starfield. The dome is pinned
 * to the camera every frame so the atmosphere stays at infinity.
 *
 * Both shaders end with three's own tonemapping + colorspace chunks so they sit
 * in exactly the same colour pipeline as the city. The solar disc is the only
 * HDR part of the dome; its colour and horizon dimming come from the same
 * atmospheric extinction as the surrounding scattering.
 * ==========================================================================*/

const SKY_RADIUS = 1800
const STAR_RADIUS = 1720
const N_STARS = 1400
const CLOUD_RADIUS = 1500

/** 2.8× the real 0.53° sun: compact, but legible at both supported viewports. */
export const SUN_ANGULAR_DIAMETER_DEG = 1.5
const SUN_ANGULAR_RADIUS_RAD = THREE.MathUtils.degToRad(SUN_ANGULAR_DIAMETER_DEG / 2)
const SUN_DISC_OUTER_COS = Math.cos(SUN_ANGULAR_RADIUS_RAD)
const SUN_DISC_INNER_COS = Math.cos(SUN_ANGULAR_RADIUS_RAD * 0.82)
const SUN_RADIANCE = 8

/*
 * Preetham's analytic daylight model. Rayleigh gives wavelength-dependent sky
 * colour; Henyey-Greenstein Mie phase gives the low sun its forward halo.
 */
const SCATTERING = {
  turbidity: 4.5,
  rayleigh: 1.75,
  mieCoefficient: 0.0035,
  mieDirectionalG: 0.95,
} as const
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5] as const
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14] as const

const BETA_R = TOTAL_RAYLEIGH.map((channel) => channel * SCATTERING.rayleigh)
const mieC = 0.2 * SCATTERING.turbidity * 1e-17
const BETA_M = MIE_CONST.map((channel) => 0.434 * mieC * channel * SCATTERING.mieCoefficient)

/** CPU mirror of the shader's wavelength-dependent optical extinction. */
export function solarTransmittance(elevationDeg: number): readonly [number, number, number] {
  const elevation = THREE.MathUtils.degToRad(elevationDeg)
  const zenithAngle = Math.acos(Math.max(0, Math.sin(elevation)))
  const inverse = 1 / (
    Math.cos(zenithAngle)
    + 0.15 * Math.pow(93.885 - THREE.MathUtils.radToDeg(zenithAngle), -1.253)
  )
  const channel = (i: number): number =>
    Math.exp(-(BETA_R[i] * 8.4e3 * inverse + BETA_M[i] * 1.25e3 * inverse))
  return [channel(0), channel(1), channel(2)]
}

/** Fraction of the apparent disc geometrically above the mathematical horizon. */
export function sunDiscHorizonFraction(elevationDeg: number): number {
  const radius = SUN_ANGULAR_DIAMETER_DEG / 2
  if (elevationDeg >= radius) return 1
  if (elevationDeg <= -radius) return 0
  const offset = elevationDeg / radius
  return (Math.acos(-offset) + offset * Math.sqrt(1 - offset * offset)) / Math.PI
}

export interface DayScatteringPhase {
  rayleigh: number
  rayleighRed: number
  rayleighBlue: number
  mie: number
}

/** CPU mirror of the shader phase terms, used to pin their physical behavior. */
export function dayScatteringPhase(cosTheta: number): DayScatteringPhase {
  const c = Math.max(-1, Math.min(1, cosTheta))
  const rayleigh = (3 / (16 * Math.PI)) * (1 + c * c)
  const g2 = SCATTERING.mieDirectionalG * SCATTERING.mieDirectionalG
  const inverse = 1 / Math.pow(1 - 2 * SCATTERING.mieDirectionalG * c + g2, 1.5)
  const mie = ((1 - g2) * inverse) / (4 * Math.PI)
  return {
    rayleigh,
    rayleighRed: rayleigh * TOTAL_RAYLEIGH[0],
    rayleighBlue: rayleigh * TOTAL_RAYLEIGH[2],
    mie,
  }
}

/** Rescue tiers and the established night retain the cheaper legacy dome. */
export function skyScatteringEnabled(air: Atmosphere, quality: QualityLevel): boolean {
  return air.daylight && quality !== 'low' && quality !== 'reduced'
}

/* ---------------------------------------------------------------------------
 * THE BAND THAT DECIDES THE DAY SKY.
 *
 * engine/camera.ts puts the establishing shot at a 29.46° downward pitch
 * against a 26° vertical half-FOV, so the top of the frame is already 3.46°
 * BELOW the mathematical horizon. Two more things then eat into that:
 *
 *   - the HUD. Its opaque bar covers the top of the canvas — 118 px of 760 on
 *     the desktop, 60 px of 844 on the phone — and that is the part of the
 *     frame nearest the horizon;
 *   - the plate. It is finite and Slonik-shaped, so the skyline it cuts is not
 *     at one elevation; measured column by column it runs -12.4° to -16.1°.
 *
 * Measured off rendered frames, not derived: the visitor's sky is -11.5° to
 * -16.1° on the desktop and -7.2° to -18.7° on the phone. NOTHING above the
 * horizon is ever on screen until they orbit.
 *
 * So the whole gradient has to live below h = 0, and it has to run the right
 * way. Darkening downward is the night idiom — correct when below the horizon
 * really is ground — and applying it to daylight is what made this read as a
 * flat grey plate. In daylight, below the horizon is DISTANCE: paler, warmer,
 * lower in contrast, never darker.
 * -------------------------------------------------------------------------*/
export const ESTABLISHING_BAND = {
  /** Phone, 390x844: between the HUD bar and the widest gap to the plate edge. */
  topDeg: -7.2,
  bottomDeg: -18.7,
  /** Desktop, 1280x760: the tighter slice, and the one clouds must land in. */
  desktopTopDeg: -11.5,
  desktopBottomDeg: -16.1,
} as const

/* ---------------------------------------------------------------------------
 * Day gradient shape. These numbers are shared: `skyFrag` is built from them by
 * interpolation and `daySkyRamp` / `dayHazeMix` read the same object, so the
 * testable model and the GLSL cannot drift apart.
 * -------------------------------------------------------------------------*/
const DAY = {
  /** Fast rise off the horizon: real saturation inside the first ~17°. */
  riseFrom: -0.02,
  riseTo: 0.3,
  /** Share of the ramp the fast rise owns; the rest is a linear tail. */
  riseWeight: 0.62,
  /** Where the linear tail starts. Linear, so the zenith never plateaus. */
  deepFrom: 0.26,
  /**
   * Haze blend across and below the horizon. Note hazeTo < hazeFrom: it runs
   * DOWNWARD, and it is fitted to ESTABLISHING_BAND — 0.50 of the way at the
   * top of the desktop slice, 0.77 at the bottom of it, 0.91 by the phone's.
   */
  hazeFrom: 0.0,
  hazeTo: -0.4,
  /**
   * Low sun-side warmth, centred just below the horizon. Cubed in azimuth, so the
   * frame is warm-grey on the sun's side and stays blue away from it. Vertical
   * range is only a few degrees on the desktop, so this LATERAL shift is half
   * of what stops the band reading as one flat wash.
   */
  glowCentre: -0.12,
  glowFalloff: 5.5,
  glowWeight: 0.62,
} as const

const g = (v: number): string => v.toFixed(4)
const sci = (v: number): string => v.toExponential(12)

/** Horizon→zenith mix for a dome height. Mirrors the ramp in `skyFrag`. */
export function daySkyRamp(h: number): number {
  const t = Math.max(0, Math.min(1, (h - DAY.riseFrom) / (DAY.riseTo - DAY.riseFrom)))
  const rise = t * t * (3 - 2 * t)
  const deep = Math.max(0, Math.min(1, (h - DAY.deepFrom) / (1 - DAY.deepFrom)))
  return rise * DAY.riseWeight + deep * (1 - DAY.riseWeight)
}

/** How much below-horizon haze is blended over the ramp. Mirrors `skyFrag`. */
export function dayHazeMix(h: number): number {
  const t = Math.max(0, Math.min(1, (h - DAY.hazeFrom) / (DAY.hazeTo - DAY.hazeFrom)))
  return t * t * (3 - 2 * t)
}

/* ---------------------------------------------------------------------------
 * SLONIK, the asterism.
 *
 * Fourteen stars in the eastern sky, above the WAL district — which is where a
 * visitor at the establishing shot is already looking. It is deliberately a
 * *sparse* reading of the outline, not a tracing of it: the points sit on the
 * strong corners (brow, crown, ear, notch, jaw, trunk, curl) with the spacing
 * left irregular, the magnitudes uneven, and only some of the links drawn. An
 * asterism you have to finish yourself is the only kind that reads as one.
 *
 * Coordinates are in the constellation's own plane, x right, y up, degrees.
 * -------------------------------------------------------------------------*/

/** Where the figure sits: azimuth in the XZ plane, then elevation. */
const ASTERISM_AZ = Math.atan2(0.851, 0.522)
const ASTERISM_EL = 0.42 // ~24°, high enough to clear the skyline
/** Degrees of sky per unit of the figure below. */
const ASTERISM_SCALE = 1.42
/** Faint but deliberately visible against the night dome. */
export const SLONIK_LINK_OPACITY = 0.22

/** x, y, magnitude 0..1. */
const ASTERISM: readonly (readonly [number, number, number])[] = [
  [-11.4, 1.0, 0.55], // the face, low
  [-12.2, 9.6, 0.85], // the brow
  [-7.6, 15.2, 0.5], // the forehead
  [-1.4, 17.0, 0.95], // the crown — the bright one
  [3.2, 14.6, 0.45], // the temple dip
  [8.6, 16.4, 0.7], // the top of the ear
  [15.4, 8.0, 0.9], // the ear, outer
  [13.6, -1.4, 0.5],
  [10.2, -8.4, 0.65], // the bottom of the ear
  [6.4, -5.6, 0.4], // the notch
  [1.0, -10.2, 0.6], // the jaw
  [-4.4, -13.4, 0.5], // the trunk leaves the jaw
  [-10.6, -16.8, 0.75], // the trunk
  [-15.8, -14.2, 0.85], // the curl
]

/** Which stars are joined. Gaps are on purpose. */
const ASTERISM_LINKS: readonly (readonly [number, number])[] = [
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 6],
  [6, 7],
  [8, 9],
  [10, 11],
  [11, 12],
  [12, 13],
  [0, 1],
]

const skyVert = /* glsl */ `
uniform vec3 uSunDirection;
varying vec3 vDir;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;

const float SKY_PI = 3.1415926535897932384626433832795;
const vec3 TOTAL_RAYLEIGH = vec3(
  ${sci(TOTAL_RAYLEIGH[0])},
  ${sci(TOTAL_RAYLEIGH[1])},
  ${sci(TOTAL_RAYLEIGH[2])}
);
const vec3 MIE_CONST = vec3( 1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14 );

float sunIntensity( float zenithCos ) {
  float cutoffAngle = 1.6110731556870734;
  float steepness = 1.5;
  return 1000.0 * max( 0.0, 1.0 - exp( -( ( cutoffAngle - acos( clamp( zenithCos, -1.0, 1.0 ) ) ) / steepness ) ) );
}

void main() {
  vDir = position;
  vSunE = sunIntensity( uSunDirection.y );
  vBetaR = TOTAL_RAYLEIGH * ${g(SCATTERING.rayleigh)};
  float mieC = ( 0.2 * ${g(SCATTERING.turbidity)} ) * 10E-18;
  vBetaM = 0.434 * mieC * MIE_CONST * ${g(SCATTERING.mieCoefficient)};
  vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  // Pin to the far plane. The dome can then never be clipped by whatever the
  // camera's far distance happens to be, and it never occludes anything.
  gl_Position = vec4( p.xy, p.w, p.w );
}
`

const skyFrag = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uGlow;
uniform vec3 uSunDirection;
uniform vec2 uSunFlat;
uniform float uDaylight;
uniform float uScattering;
uniform float uSunVisible;
varying vec3 vDir;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;

const float SKY_PI = 3.1415926535897932384626433832795;
const float RAYLEIGH_ZENITH_LENGTH = 8.4E3;
const float MIE_ZENITH_LENGTH = 1.25E3;
const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
const float ONE_OVER_FOURPI = 0.07957747154594767;

float rayleighPhase( float cosTheta ) {
  return THREE_OVER_SIXTEENPI * ( 1.0 + cosTheta * cosTheta );
}

float hgPhase( float cosTheta ) {
  float g = ${g(SCATTERING.mieDirectionalG)};
  float g2 = g * g;
  float inverse = 1.0 / pow( max( 1.0 - 2.0 * g * cosTheta + g2, 1e-4 ), 1.5 );
  return ONE_OVER_FOURPI * ( 1.0 - g2 ) * inverse;
}

vec3 atmosphereExtinction( float elevation ) {
  float zenithAngle = acos( max( 0.0, elevation ) );
  float inverse = 1.0 / (
    cos( zenithAngle )
    + 0.15 * pow( 93.885 - zenithAngle * 180.0 / SKY_PI, -1.253 )
  );
  float sR = RAYLEIGH_ZENITH_LENGTH * inverse;
  float sM = MIE_ZENITH_LENGTH * inverse;
  return exp( -( vBetaR * sR + vBetaM * sM ) );
}

void main() {
  vec3 d = normalize( vDir );
  float h = d.y;

  vec3 col;
  if ( uDaylight > 0.5 ) {
    if ( uScattering > 0.5 ) {
      // The finite ground plate exposes a little dome below the mathematical
      // horizon. Continue the tangent atmosphere there, then meet scene fog.
      vec3 scatterDirection = normalize( vec3( d.x, max( d.y, 0.015 ), d.z ) );
      vec3 extinction = atmosphereExtinction( scatterDirection.y );

      float cosTheta = dot( scatterDirection, uSunDirection );
      vec3 betaRTheta = vBetaR * rayleighPhase( cosTheta );
      vec3 betaMTheta = vBetaM * hgPhase( cosTheta );
      vec3 scatter = vSunE * ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM );
      vec3 inscatter = pow( scatter * ( 1.0 - extinction ), vec3( 1.5 ) );
      float lowSun = clamp( pow( 1.0 - uSunDirection.y, 5.0 ), 0.0, 1.0 );
      inscatter *= mix( vec3( 1.0 ), pow( scatter * extinction, vec3( 0.5 ) ), lowSun );

      vec3 direct = vec3( 0.1 ) * extinction;
      col = ( inscatter + direct ) * 0.018 + vec3( 0.0, 0.0003, 0.00075 );
      // Compress the broad atmosphere before the application's shared output
      // transform. The compact solar radiance is added below in HDR.
      col = col / ( vec3( 1.0 ) + col );
      col = mix( col, uHaze, smoothstep( ${g(DAY.hazeFrom)}, ${g(DAY.hazeTo)}, h ) );
      // The atmosphere is a backdrop, not a semantic light source.
      col = min( col, vec3( 0.98 ) );
    } else {
      // The original ramp is the rescue-tier path.
      float rise = smoothstep( ${g(DAY.riseFrom)}, ${g(DAY.riseTo)}, h );
      float deep = clamp( ( h - ${g(DAY.deepFrom)} ) / ${g(1 - DAY.deepFrom)}, 0.0, 1.0 );
      col = mix( uHorizon, uZenith, rise * ${g(DAY.riseWeight)} + deep * ${g(1 - DAY.riseWeight)} );
      col = mix( col, uHaze, smoothstep( ${g(DAY.hazeFrom)}, ${g(DAY.hazeTo)}, h ) );

      vec2 fxz = vec2( d.x, d.z );
      float toward = max( 0.0, dot( fxz / max( length( fxz ), 1e-4 ), uSunFlat ) );
      float low = exp( - abs( h - ${g(DAY.glowCentre)} ) * ${g(DAY.glowFalloff)} );
      col = mix( col, uGlow, low * toward * toward * toward * ${g(DAY.glowWeight)} );
    }
  } else {
    // The established night gradient and restrained eastern warmth.
    col = mix( uHorizon, uZenith, smoothstep( -0.04, 0.62, h ) );
    float band = exp( - abs( h ) * 8.5 );
    col += uHorizon * band * 0.30;
    float east = clamp( d.x, 0.0, 1.0 );
    col += uGlow * band * pow( east, 2.4 );
    col *= mix( 0.18, 1.0, smoothstep( -0.30, -0.01, h ) );
  }

  // The horizon clips the disc itself, so a centre one radius below it leaves
  // no bright sliver behind. Extinction supplies both reddening and dimming;
  // there is no separately art-directed sunset tint.
  float sunDot = dot( d, uSunDirection );
  float disc = smoothstep( ${sci(SUN_DISC_OUTER_COS)}, ${sci(SUN_DISC_INNER_COS)}, sunDot );
  float aboveHorizon = step( 0.0, h );
  vec3 sunTransmittance = atmosphereExtinction( uSunDirection.y );
  col += sunTransmittance * ${g(SUN_RADIANCE)} * disc * aboveHorizon * uSunVisible;

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const starVert = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aPhase;
uniform float uTime;
uniform float uScale;
varying vec3 vColor;
varying float vTw;

void main() {
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  // twinkle: a slow per-star sine, evaluated on the GPU — the CPU never touches a star
  float rate = 0.55 + fract( aPhase * 7.31 ) * 1.15;
  vTw = 0.62 + 0.38 * sin( uTime * rate + aPhase * 6.2831853 );
  vColor = aColor;
  gl_PointSize = aSize * ( uScale / max( 1.0, - mv.z ) ) * ( 0.86 + 0.14 * vTw );
  vec4 p = projectionMatrix * mv;
  gl_Position = vec4( p.xy, p.w, p.w );
}
`

const starFrag = /* glsl */ `
varying vec3 vColor;
varying float vTw;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot( d, d );
  float a = exp( - r2 * 17.0 ) * ( 1.0 - smoothstep( 0.15, 0.25, r2 ) );
  gl_FragColor = vec4( vColor * vTw, a * 0.92 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const cloudVert = /* glsl */ `
attribute vec3 aCenter;
attribute vec2 aSize;
attribute float aShape;
attribute float aSpeed;
uniform float uTime;
uniform vec3 uSunDirection;
varying vec2 vUv;
varying float vShape;
varying float vHaze;
varying vec2 vSunScreen;

void main() {
  float angle = uTime * aSpeed;
  float ca = cos( angle );
  float sa = sin( angle );
  vec3 center = aCenter;
  center.xz = mat2( ca, -sa, sa, ca ) * center.xz;

  // The low bank sits in the horizon haze and must not read as cut-out white
  // against it; the high bank stays crisp. One instanced draw, both reads.
  vHaze = 1.0 - smoothstep( -0.10, 0.24, normalize( aCenter ).y );

  // Offset in view space: every instance is a camera-facing patch of sky.
  vec4 mv = modelViewMatrix * vec4( center, 1.0 );
  mv.xy += position.xy * aSize;
  gl_Position = projectionMatrix * mv;
  vUv = uv * 2.0 - 1.0;
  vShape = aShape;
  vec2 sunScreen = ( viewMatrix * vec4( uSunDirection, 0.0 ) ).xy;
  vSunScreen = sunScreen / max( length( sunScreen ), 1e-4 );
}
`

const cloudFrag = /* glsl */ `
uniform vec3 uCloudLight;
uniform vec3 uCloudShade;
uniform vec3 uCloudHaze;
varying vec2 vUv;
varying float vShape;
varying float vHaze;
varying vec2 vSunScreen;

float circle( vec2 p, vec2 center, float radius ) {
  return length( p - center ) - radius;
}

void main() {
  vec2 p = vUv;
  float spread = ( vShape - 0.5 ) * 0.16;

  // The horizontal cut is what makes these read as cumulus, not smoke puffs.
  float base = -0.31 + spread * 0.25;
  // Reject the empty margin of the quad BEFORE the five length() calls. Around
  // a third of the quad carries no silhouette, and this is a transparent draw
  // over the largest thing in frame on a software rasteriser.
  if ( p.y < base - 0.13 || p.y > 0.84 ) discard;

  float d = circle( p, vec2( -0.62 - spread, -0.06 ), 0.31 );
  d = min( d, circle( p, vec2( -0.34, 0.10 + spread ), 0.38 ) );
  d = min( d, circle( p, vec2( -0.03, 0.31 ), 0.44 ) );
  d = min( d, circle( p, vec2( 0.34, 0.14 - spread ), 0.37 ) );
  d = min( d, circle( p, vec2( 0.63 + spread, -0.07 ), 0.29 ) );
  d = max( d, base - p.y );
  // The low bank is farther through more air, but the previous 44% haze mix at
  // 0.62 alpha erased it into the exact band behind it. Distance now softens
  // the edge without surrendering the warm top / cool underside value split.
  float edge = mix( 0.085, 0.145, vHaze );
  float alpha = ( 1.0 - smoothstep( -0.020, edge, d ) ) * mix( 0.86, 0.74, vHaze );
  if ( alpha < 0.006 ) discard;

  float heightLight = smoothstep( base, 0.62, p.y );
  float rake = dot( p, vSunScreen );
  float sideLight = smoothstep( -0.72, 0.78, rake );
  vec3 col = mix( uCloudShade, uCloudLight, 0.16 + heightLight * 0.28 + sideLight * 0.56 );
  // The sunward lobe catches a narrow edge; the opposite lobe stays blue-grey.
  float brightEdge = smoothstep( -0.14, -0.008, d ) * smoothstep( 0.08, 0.82, rake );
  col = mix( col, uCloudLight * 1.06, brightEdge * 0.34 );
  col = mix( col, uCloudHaze, vHaze * 0.28 );
  gl_FragColor = vec4( col, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/** Cool white, a few amber, a few pale blue — no green, nothing saturated. */
const STAR_TINTS: readonly number[] = [
  0xdfe9ff, 0xdfe9ff, 0xdfe9ff, 0xdfe9ff, 0xc9d8ff, 0xffffff, 0xffd9a8, 0xa9c8ff,
]

/** Azimuth°, elevation°, width, height, silhouette variant, radians/second. */
const CLOUDS: readonly (readonly [number, number, number, number, number, number])[] = [
  [-82, 18, 300, 96, 0.15, 0.00016],
  [-52, 31, 340, 104, 0.72, 0.00012],
  [-22, 14, 300, 92, 0.38, 0.00019],
  [8, 8, 350, 108, 0.9, 0.00014],
  [39, 12, 305, 94, 0.52, 0.00021],
  [70, 30, 420, 118, 0.64, 0.00013],
  [105, 18, 300, 92, 0.27, 0.00017],
  [142, 27, 360, 108, 0.78, 0.00011],
  [178, 16, 310, 96, 0.48, 0.0002],
  /* The low bank. Home looks down toward azimuth 149° with a 39° horizontal
   * half-angle, so 110°–188° is what is on screen, and ESTABLISHING_BAND is
   * the only elevation strip that is sky rather than plate or HUD. A cloud
   * outside those two windows is a cloud nobody sees until they orbit — which
   * is what the whole table above was. These sit BEYOND the plate edge, so the
   * plate correctly draws over them as the viewer descends toward it. */
  [116, -12.8, 300, 78, 0.44, 0.00009],
  [140, -14.0, 320, 82, 0.81, 0.00007],
  [154, -13.3, 330, 86, 0.22, 0.00011],
  [178, -12.4, 295, 76, 0.61, 0.00008],
]

/** Elevation of every cloud instance, in degrees. */
export function cloudElevations(): number[] {
  return CLOUDS.map((c) => c[1])
}

/** Apparent horizontal footprint of every existing cloud billboard. */
export function cloudAngularWidths(): number[] {
  return CLOUDS.map((c) => THREE.MathUtils.radToDeg(2 * Math.atan(c[2] / (2 * CLOUD_RADIUS))))
}

/**
 * Clouds are one instanced draw but they are TRANSPARENT FILL over the largest
 * thing in frame, and this renderer is fill-bound. The fragment shader rejects
 * each quad's empty margin before evaluating its silhouette, but the two tiers
 * that exist to rescue a struggling machine still do without the entire layer.
 * The dome carries those tiers; clouds are the higher-tier weather pass.
 */
export function skyCloudsVisible(air: Atmosphere, quality: QualityLevel): boolean {
  return air.clouds && quality !== 'low' && quality !== 'reduced'
}

/**
 * Repaint the procedural atmosphere through the renderer's live theme path.
 * The light-to-target vector is the apparent direction toward the sun.
 */
export function applySkyAtmosphere(sky: THREE.Object3D, air: Atmosphere, quality: QualityLevel): void {
  const dome = sky.getObjectByName('sky.dome') as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | undefined
  const uniforms = dome?.material.uniforms
  if (uniforms) {
    const zenith = uniforms.uZenith?.value as THREE.Color | undefined
    const horizon = uniforms.uHorizon?.value as THREE.Color | undefined
    const haze = uniforms.uHaze?.value as THREE.Color | undefined
    const glow = uniforms.uGlow?.value as THREE.Color | undefined
    zenith?.setHex(air.skyZenith)
    horizon?.setHex(air.skyHorizon)
    haze?.setHex(air.skyHaze)
    glow?.setHex(air.skyGlow)
    const sun = uniforms.uSunDirection?.value as THREE.Vector3 | undefined
    const x = air.sunDirection[0]
    const y = air.sunDirection[1]
    const z = air.sunDirection[2]
    if (sun) {
      const invLength = 1 / Math.hypot(x, y, z)
      sun.set(x * invLength, y * invLength, z * invLength)
    }
    const sunFlat = uniforms.uSunFlat?.value as THREE.Vector2 | undefined
    if (sunFlat) {
      // Flattened once here rather than per fragment; the sun's azimuth is what
      // the low horizon glow needs and it only changes when the theme does.
      const invFlat = 1 / Math.max(1e-6, Math.hypot(x, z))
      sunFlat.set(x * invFlat, z * invFlat)
    }
    if (uniforms.uDaylight) uniforms.uDaylight.value = air.daylight ? 1 : 0
    if (uniforms.uScattering) uniforms.uScattering.value = skyScatteringEnabled(air, quality) ? 1 : 0
    if (uniforms.uSunVisible) {
      uniforms.uSunVisible.value = sunDiscHorizonFraction(air.sunElevationDeg) > 0 ? 1 : 0
    }
  }

  const clouds = sky.getObjectByName('sky.clouds') as
    | THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
    | undefined
  if (clouds) {
    clouds.visible = skyCloudsVisible(air, quality)
    const cloudHaze = clouds.material.uniforms.uCloudHaze?.value as THREE.Color | undefined
    cloudHaze?.setHex(air.skyHaze)
    const cloudSun = clouds.material.uniforms.uSunDirection?.value as THREE.Vector3 | undefined
    if (cloudSun) {
      const x = air.sunDirection[0]
      const y = air.sunDirection[1]
      const z = air.sunDirection[2]
      const invLength = 1 / Math.hypot(x, y, z)
      cloudSun.set(x * invLength, y * invLength, z * invLength)
    }
  }

  const stars = sky.getObjectByName('sky.stars')
  if (stars) stars.visible = air.stars
}

/**
 * Build the sky. Add the returned object straight to the scene; it owns its
 * per-frame clock and camera pinning and never needs an external tick.
 */
export function createSky(theme: ThemeApi): THREE.Object3D {
  const group = new THREE.Group()
  group.name = 'sky'
  group.matrixAutoUpdate = true

  /* ---- dome ---- */

  // Palette-derived so the dome, the fog and the ground clear colour agree.
  const zenith = mixHex(COLOR.bg, 0x000000, 0.35)
  const horizon = mixHex(COLOR.fog, COLOR.gridBright, 0.5)
  const glow = mixHex(0x000000, COLOR.wal, 0.34)

  const domeGeo = new THREE.SphereGeometry(SKY_RADIUS, 32, 20)
  const domeMat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color(zenith) },
      uHorizon: { value: new THREE.Color(horizon) },
      uHaze: { value: new THREE.Color(horizon) },
      uGlow: { value: new THREE.Color(glow) },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uSunFlat: { value: new THREE.Vector2(0, -1) },
      uDaylight: { value: 0 },
      uScattering: { value: 0 },
      uSunVisible: { value: 0 },
    },
    vertexShader: skyVert,
    fragmentShader: skyFrag,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })
  const dome = new THREE.Mesh(domeGeo, domeMat)
  dome.name = 'sky.dome'
  dome.frustumCulled = false
  dome.renderOrder = -1000
  dome.raycast = () => {}
  group.add(dome)

  /* ---- clouds: one instanced draw, no texture -------------------------- */

  const cloudGeo = new THREE.InstancedBufferGeometry()
  cloudGeo.setIndex([0, 1, 2, 0, 2, 3])
  cloudGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
  )
  cloudGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))

  const cloudCenters = new Float32Array(CLOUDS.length * 3)
  const cloudSizes = new Float32Array(CLOUDS.length * 2)
  const cloudShapes = new Float32Array(CLOUDS.length)
  const cloudSpeeds = new Float32Array(CLOUDS.length)
  for (let i = 0; i < CLOUDS.length; i++) {
    const [azimuth, elevation, width, height, shape, speed] = CLOUDS[i]
    const az = THREE.MathUtils.degToRad(azimuth)
    const el = THREE.MathUtils.degToRad(elevation)
    const horizontal = Math.cos(el) * CLOUD_RADIUS
    cloudCenters[i * 3] = Math.sin(az) * horizontal
    cloudCenters[i * 3 + 1] = Math.sin(el) * CLOUD_RADIUS
    cloudCenters[i * 3 + 2] = -Math.cos(az) * horizontal
    cloudSizes[i * 2] = width
    cloudSizes[i * 2 + 1] = height
    cloudShapes[i] = shape
    cloudSpeeds[i] = speed
  }
  cloudGeo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(cloudCenters, 3))
  cloudGeo.setAttribute('aSize', new THREE.InstancedBufferAttribute(cloudSizes, 2))
  cloudGeo.setAttribute('aShape', new THREE.InstancedBufferAttribute(cloudShapes, 1))
  cloudGeo.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(cloudSpeeds, 1))
  cloudGeo.instanceCount = CLOUDS.length
  cloudGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), CLOUD_RADIUS * 1.2)

  const skyTime = { value: 0 }
  const cloudMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: skyTime,
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uCloudLight: { value: new THREE.Color(0xffd7a4) },
      uCloudShade: { value: new THREE.Color(0x7891ac) },
      uCloudHaze: { value: new THREE.Color(0xb7c5d3) },
    },
    vertexShader: cloudVert,
    fragmentShader: cloudFrag,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: false,
  })
  const clouds = new THREE.Mesh(cloudGeo, cloudMat)
  clouds.name = 'sky.clouds'
  clouds.visible = false
  clouds.frustumCulled = false
  clouds.renderOrder = -997
  clouds.raycast = () => {}
  group.add(clouds)

  /* ---- stars ---- */

  const nTotal = N_STARS + ASTERISM.length
  const pos = new Float32Array(nTotal * 3)
  const col = new Float32Array(nTotal * 3)
  const siz = new Float32Array(nTotal)
  const pha = new Float32Array(nTotal)
  const rng = makeRng(0x51a2b7)
  const c = new THREE.Color()

  for (let i = 0; i < N_STARS; i++) {
    // uniform on the sphere, then pushed above the horizon: the ground eats the rest
    const u = rng() * 2 - 1
    const y = Math.abs(u) * 0.94 + 0.02
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const a = rng() * Math.PI * 2
    pos[i * 3] = Math.cos(a) * r * STAR_RADIUS
    pos[i * 3 + 1] = y * STAR_RADIUS
    pos[i * 3 + 2] = Math.sin(a) * r * STAR_RADIUS

    c.setHex(STAR_TINTS[Math.floor(rng() * STAR_TINTS.length)] ?? 0xdfe9ff)
    // dim most of them so a handful of bright ones can carry the composition
    const mag = 0.30 + Math.pow(rng(), 3.2) * 0.62
    col[i * 3] = c.r * mag
    col[i * 3 + 1] = c.g * mag
    col[i * 3 + 2] = c.b * mag

    siz[i] = 1.0 + Math.pow(rng(), 3.5) * 3.4
    pha[i] = rng()
  }

  /* ---- the asterism ----
   * Laid out in its own tangent plane and pushed onto the star sphere. The
   * stars ride in the same buffer as every other star, so the figure costs one
   * extra draw call for its links and nothing at all for its points. */
  const aF = new THREE.Vector3(
    Math.cos(ASTERISM_AZ) * Math.cos(ASTERISM_EL),
    Math.sin(ASTERISM_EL),
    Math.sin(ASTERISM_AZ) * Math.cos(ASTERISM_EL),
  ).normalize()
  const aRight = new THREE.Vector3().crossVectors(aF, new THREE.Vector3(0, 1, 0)).normalize()
  const aUp = new THREE.Vector3().crossVectors(aRight, aF).normalize()
  const aDir = new THREE.Vector3()
  const DEG = (Math.PI / 180) * ASTERISM_SCALE

  const linkPos = new Float32Array(ASTERISM_LINKS.length * 6)
  const starAt = (k: number, out: THREE.Vector3): THREE.Vector3 => {
    const s = ASTERISM[k]
    return out
      .copy(aF)
      .addScaledVector(aRight, s[0] * DEG)
      .addScaledVector(aUp, s[1] * DEG)
      .normalize()
      .multiplyScalar(STAR_RADIUS)
  }

  for (let k = 0; k < ASTERISM.length; k++) {
    const i = N_STARS + k
    const mag = ASTERISM[k][2]
    starAt(k, aDir)
    pos[i * 3] = aDir.x
    pos[i * 3 + 1] = aDir.y
    pos[i * 3 + 2] = aDir.z
    // Cool white, a shade brighter than the field they sit in — but still under
    // the bloom threshold, because the sky is a backdrop and never a light.
    c.setHex(0xdce9ff)
    // Brighter than the field so the figure carries, still under the bloom
    // threshold so it stays a backdrop.
    const b = 0.45 + mag * 0.5
    col[i * 3] = c.r * b
    col[i * 3 + 1] = c.g * b
    col[i * 3 + 2] = c.b * b
    siz[i] = 2.0 + mag * 4.4
    pha[i] = (k * 0.37) % 1
  }
  for (let l = 0; l < ASTERISM_LINKS.length; l++) {
    starAt(ASTERISM_LINKS[l][0], aDir).toArray(linkPos, l * 6)
    starAt(ASTERISM_LINKS[l][1], aDir).toArray(linkPos, l * 6 + 3)
  }

  const linkGeo = new THREE.BufferGeometry()
  linkGeo.setAttribute('position', new THREE.BufferAttribute(linkPos, 3))
  linkGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), STAR_RADIUS * 1.02)
  const linkMat = new THREE.LineBasicMaterial({
    color: 0x9fb8e6,
    // Same queue trick as the stars: opaque queue, additive blend, no depth.
    transparent: false,
    blending: THREE.AdditiveBlending,
    opacity: SLONIK_LINK_OPACITY,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    fog: false,
  })
  const links = new THREE.LineSegments(linkGeo, linkMat)
  links.name = 'sky.slonik'
  links.frustumCulled = false
  links.renderOrder = -998
  links.raycast = () => {}

  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  starGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1))
  starGeo.setAttribute('aPhase', new THREE.BufferAttribute(pha, 1))
  starGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), STAR_RADIUS * 1.02)

  const starUniforms = {
    uTime: skyTime,
    uScale: { value: STAR_RADIUS },
  }
  const starMat = new THREE.ShaderMaterial({
    uniforms: starUniforms,
    vertexShader: starVert,
    fragmentShader: starFrag,
    // transparent:false keeps the stars in the *opaque* queue so they are drawn
    // before the city; three still honours a non-Normal blending mode there
    // (WebGLState.setMaterial), which is what makes additive stars possible
    // without them floating in front of the buildings.
    transparent: false,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })
  const stars = new THREE.Points(starGeo, starMat)
  stars.name = 'sky.stars'
  stars.frustumCulled = false
  stars.renderOrder = -999
  stars.raycast = () => {}
  // The renderer hides the starfield in daylight. Parenting the asterism here
  // gives its links the same night-only lifecycle without a second theme hook.
  stars.add(links)
  group.add(stars)

  /* ---- self-driving: pin to the camera, advance the twinkle clock ----
   * onBeforeRender runs before three computes modelViewMatrix (WebGLRenderer
   * .renderObject), so updating the transform here is safe for this same frame. */
  dome.onBeforeRender = (_r, _s, camera) => {
    group.position.copy(camera.position)
    group.updateMatrixWorld(true)
    skyTime.value = performance.now() * 0.001
  }

  group.userData.dispose = () => {
    domeGeo.dispose()
    domeMat.dispose()
    cloudGeo.dispose()
    cloudMat.dispose()
    starGeo.dispose()
    starMat.dispose()
    linkGeo.dispose()
    linkMat.dispose()
  }

  // The sky reads the palette but deliberately holds no *cached* theme material:
  // it must never be recoloured by a district that grabs the same key.
  void theme

  return group
}
