import * as THREE from 'three'

import { atmosphere, themeDaylight } from '../core/theme'
import type { QualityLevel } from '../core/types'
import { reduceMotion } from '../core/util'
import { WET_FIELD_GLSL } from './ground-surface'

/* ============================================================================
 * THE SEA — what the island stands in.
 *
 * Setting, not model: it is registered nowhere, carries no label and answers
 * no pick. It replaces a pale void under the plate with a horizon, so the city
 * has a scale and the sky has something to be mirrored in.
 *
 * It is deliberately a grey steel sea. The buffer pool's water is semantic
 * (occupancy) and clean-page blue is semantic; open water must be neither.
 * ==========================================================================*/

/** Metres below the paving. The retaining skirt continues well beneath it. */
export const SEA_LEVEL = -9
/**
 * The rim must be past the fog's far distance from the furthest the camera can
 * orbit, in both modes, so no edge is ever in frame.
 */
export const SEA_RADIUS = 5200
/** Deep-water body colour, sRGB. Low chroma by construction. */
export const SEA_DEEP = { day: 0x1f3440, night: 0x070a10 } as const

/** Metres the water reaches in under the kerb before the island cuts it away. */
export const SEA_UNDERCUT = 3

/** Shelf water colour, sRGB: paler and slightly green, still low in chroma. */
export const SEA_SHELF = { day: 0x4f6458, night: 0x0c1210 } as const

/**
 * Surf against the retaining wall. Lines form `reach` metres out, one every
 * `wavelength` metres, and run in at `speed` metres a second.
 */
export const SURF = { reach: 58, wavelength: 13, speed: 2.4 } as const

/** Seconds before the sea's clock wraps: a whole number of surf periods, so no line jumps. */
export const SEA_TIME_WRAP = (756 * SURF.wavelength) / SURF.speed

/** Metres offshore of the surf line that was at `shore0` metres `seconds` ago. */
export function surfLinePosition(shore0: number, seconds: number): number {
  return shore0 - SURF.speed * seconds
}

/** Wave octaves: rescue tiers get a flat mirror, which costs nothing. */
export function seaWaveDetail(quality: QualityLevel): 0 | 1 | 2 {
  if (quality === 'low' || quality === 'reduced') return 0
  return quality === 'medium' ? 1 : 2
}

const vertex = /* glsl */ `
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`

const fragment = /* glsl */ `
uniform vec3 uDeep;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGlow;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uGlint;
uniform float uSheen;
uniform float uCloud;
uniform vec3 uCloudColor;
uniform vec3 uShelf;
uniform float uFoamKey;
uniform float uFoamCap;
uniform float uTime;
uniform float uWaves;
uniform sampler2D uEdge;
uniform vec4 uEdgeMap;
uniform float uEdgeMax;
varying vec3 vWorld;
#include <fog_pars_fragment>

${WET_FIELD_GLSL}

// One directional wave train: xy is its slope, z its height. Analytic, so
// crests stay crisp at any distance instead of smearing like sampled noise.
vec3 seaTrain( vec2 p, vec2 dir, float len, float steep, float t ) {
  float k = 6.2831853 / len;
  // Deep-water dispersion: longer waves run faster, which is why a real sea
  // never repeats.
  float phase = dot( dir, p ) * k + t * sqrt( 9.81 * k );
  float amp = steep / k;
  return vec3( dir * ( steep * cos( phase ) ), amp * sin( phase ) );
}

// Slope of two rotated octaves of noise. One octave of value noise shows its
// own lattice as square facets; the second, turned, hides it.
vec2 seaChop( vec2 c ) {
  vec2 d = mat2( 0.6, 0.8, -0.8, 0.6 ) * c * 2.07 + 5.3;
  float a = wetNoise( c ) + 0.5 * wetNoise( d );
  return vec2(
    wetNoise( c + vec2( 0.22, 0.0 ) ) + 0.5 * wetNoise( d + vec2( 0.132, -0.176 ) ) - a,
    wetNoise( c + vec2( 0.0, 0.22 ) ) + 0.5 * wetNoise( d + vec2( 0.176, 0.132 ) ) - a
  );
}

// Slope in xy, height in z. Each train retires before its own wavelength
// falls under two pixels, so the far sea calms instead of boiling.
vec3 seaSurface( vec2 p, float range, float detail ) {
  // A slow warp breaks the long crests so trains never line up into a grid.
  vec2 q = p + 26.0 * ( vec2( wetNoise( p * 0.007 ), wetNoise( p * 0.007 + 31.0 ) ) - 0.5 );
  vec3 sum = vec3( 0.0 );
  // Swell from a spread of bearings; trains from one quarter alone read as
  // ruled lines from the far side of the island.
  sum += seaTrain( q, vec2( 0.961, 0.276 ), 71.0, 0.045, uTime ) * ( 1.0 - smoothstep( 1500.0, 3400.0, range ) );
  sum += seaTrain( q, vec2( 0.326, 0.945 ), 47.0, 0.045, uTime ) * ( 1.0 - smoothstep( 1100.0, 2600.0, range ) );
  sum += seaTrain( q, vec2( 0.707, -0.707 ), 29.0, 0.050, uTime ) * ( 1.0 - smoothstep( 700.0, 1700.0, range ) );
  if ( detail > 1.5 ) {
    sum += seaTrain( q, vec2( -0.342, 0.940 ), 17.0, 0.050, uTime ) * ( 1.0 - smoothstep( 400.0, 1000.0, range ) );
    sum += seaTrain( q, vec2( 0.940, -0.342 ), 9.5, 0.050, uTime ) * ( 1.0 - smoothstep( 220.0, 560.0, range ) );
    /* Below a few metres the sea is not trains at all but chop: irregular,
     * short-lived and directionless. Sines at that scale interfere into
     * rings and lattices, so it is noise, differenced for its slope. */
    float near = 1.0 - smoothstep( 90.0, 420.0, range );
    float close = 1.0 - smoothstep( 30.0, 140.0, range );
    vec2 c1 = mat2( 0.54, 0.84, -0.84, 0.54 ) * p * 0.42 + vec2( uTime * 0.31, uTime * 0.12 );
    vec2 c2 = mat2( 0.91, -0.41, 0.41, 0.91 ) * p * 1.3 - vec2( uTime * 0.44, - uTime * 0.27 );
    // Most of an overview frame is far water: pay for chop only where it shows.
    if ( near > 0.0 ) {
      sum.xy += seaChop( c1 ) * 0.5 * near;
      sum.z += ( wetNoise( c1 ) - 0.5 ) * 0.5 * near;
    }
    if ( close > 0.0 ) {
      sum.xy += seaChop( c2 ) * 0.26 * close;
    }
  }
  // Swell seen edge-on near the horizon stacks into ruled lines; let it lie down.
  sum.xy *= 1.0 - 0.7 * smoothstep( 350.0, 1600.0, range );
  return sum;
}

void main() {
  // No water under the island: every excavation in the plate must stay open
  // down to its own floor, or the storage districts drown.
  vec2 euv = ( vWorld.xz - uEdgeMap.xy ) * uEdgeMap.zw;
  vec2 held = clamp( euv, 0.0, 1.0 );
  float inside = ( texture2D( uEdge, held ).r - 0.5 ) * 2.0 * uEdgeMax;
  // Past the field's own rectangle the coast is further away by the overshoot.
  float beyond = length( ( euv - held ) / uEdgeMap.zw );
  if ( beyond < 0.001 && inside > SEA_UNDERCUT ) discard;
  // Metres of open water between this fragment and the retaining wall.
  float shore = max( beyond - inside, - SEA_UNDERCUT ) + SEA_UNDERCUT;

  vec3 toEye = normalize( cameraPosition - vWorld );
  float range = distance( cameraPosition, vWorld );
  vec2 p = vWorld.xz;
  vec3 normal = vec3( 0.0, 1.0, 0.0 );
  float height = 0.0;
  float crest = 0.0;
  float trail = 0.0;
  float wash = 0.0;
  if ( uWaves > 0.5 ) {
    vec3 surface = seaSurface( p, range, uWaves );
    height = surface.z;

    if ( shore < SURF_REACH ) {
      /* Surf. Swell that feels the wall steepens into lines that run in,
       * break and leave lace behind them. Phase rises with time and with
       * distance out, so a crest's position falls: it travels shoreward. */
      float ragged = wetNoise( p * 0.045 ) * 1.7 + wetNoise( p * 0.21 + 7.0 ) * 0.35;
      float phase = shore / SURF_LENGTH + uTime * ( SURF_SPEED / SURF_LENGTH ) + ragged;
      float w = fract( phase );
      // Lines sharpen and their foam thickens as the water shoals.
      float shoal = 1.0 - smoothstep( SURF_REACH * 0.2, SURF_REACH, shore );
      /* From the far side of the island a crest is thinner than a pixel and
       * crawls. Widen it and thin it with range so it stays a line. */
      float afar = smoothstep( 220.0, 900.0, range );
      float front = 1.0 - smoothstep( 0.0, 0.035 + 0.05 * shoal + 0.2 * afar, w );
      // The breaking edge leads the crest by a short ramp, not a one-pixel step.
      front = max( front, smoothstep( 1.0 - ( 0.02 + 0.1 * afar ), 1.0, w ) );
      float face = smoothstep( 0.72, 1.0, w );
      crest = front * shoal * ( 1.0 - 0.5 * afar );
      float lace = smoothstep( 0.42, 0.72, wetNoise( p * 0.62 + vec2( uTime * 0.21, - uTime * 0.13 ) ) * 0.6
                                        + wetNoise( p * 1.9 - uTime * 0.17 ) * 0.4 );
      // Half-metre lace cells alias long before the surf zone leaves the frame.
      lace = mix( lace, 0.4, afar );
      trail = ( 1.0 - smoothstep( 0.03, 0.62, w ) ) * lace * shoal * shoal;
      // The swash: where each line dies against the wall and slides back.
      float pulse = 0.5 + 0.5 * sin( 6.2831853 * ( uTime * ( SURF_SPEED / SURF_LENGTH ) + ragged ) );
      wash = ( 1.0 - smoothstep( 0.4, 2.2 + 4.5 * pulse, shore ) ) * ( 0.55 + 0.45 * lace );
      // The rising face ahead of a crest stands proud and is lit from within.
      height += face * shoal * 0.5;
      // Broken water is flatter than swell: the glitter dies in the surf zone.
      surface.xy *= 1.0 - 0.6 * shoal;
    }
    normal = normalize( vec3( - surface.x, 1.0, - surface.y ) );
  }

  vec3 mirror = reflect( - toEye, normal );
  mirror.y = abs( mirror.y );
  float fresnel = 0.02 + 0.98 * pow( 1.0 - clamp( dot( toEye, normal ), 0.0, 1.0 ), 5.0 );
  vec3 sky = wetSky( mirror, uSunDirection, uSkyZenith, uSkyHorizon, uSkyGlow );
  if ( uWaves > 1.5 && uCloud > 0.0 ) {
    // The same deck the dome draws, seen in the water.
    // Cloud is a soft, distant thing: mirror it off the mean surface, or each
    // ripple shreds it into bars.
    vec3 calm = reflect( - toEye, normalize( mix( vec3( 0.0, 1.0, 0.0 ), normal, 0.25 ) ) );
    calm.y = abs( calm.y );
    vec2 deck = calm.xz / ( calm.y + 0.11 ) * 1.35;
    float cover = smoothstep( 0.5, 0.7, wetFbm( deck + 3.7 ) );
    sky = mix( sky, uCloudColor, cover * uCloud * smoothstep( 0.012, 0.16, calm.y ) );
  }

  // Water is paler and greener over the shelf, and lit from inside where a
  // crest thins toward the sun.
  float shelf = exp( - shore / 34.0 );
  vec3 body = mix( uDeep, uShelf, shelf * 0.7 );
  body += uShelf * clamp( height * 0.55, 0.0, 0.6 ) * ( 0.25 + 0.75 * max( dot( normalize( uSunDirection.xz + 1e-5 ), - toEye.xz ), 0.0 ) );
  vec3 col = mix( body, sky, fresnel );

  float sunward = max( dot( mirror, uSunDirection ), 0.0 );
  col += uSunColor * uGlint * ( pow( sunward, 420.0 ) + uSheen * pow( sunward, 36.0 ) );

  // Foam is lit, never luminous: sky from above, key light across it.
  vec3 foamColor = min( uSkyHorizon * 0.85 + uSunColor * uFoamKey, vec3( uFoamCap ) );
  float whitecap = 0.0;
  if ( uWaves > 1.5 ) {
    float broken = wetNoise( p * 0.37 + vec2( uTime * 0.19, uTime * 0.07 ) );
    whitecap = smoothstep( 0.62, 1.05, height ) * smoothstep( 0.45, 0.8, broken ) * ( 1.0 - smoothstep( 300.0, 900.0, range ) ) * 0.7;
  }
  float foam = clamp( max( max( crest, wash ), max( trail * 0.85, whitecap ) ), 0.0, 1.0 );
  col = mix( col, foamColor, foam );

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`

export interface SeaApi {
  mesh: THREE.Mesh
  update(dt: number, quality: QualityLevel): void
  dispose(): void
}

export interface SeaEdgeField {
  texture: THREE.Texture
  /** x0, z0, 1/width, 1/depth of the island's signed edge field. */
  map: THREE.Vector4
  /** Metres encoded across the signed field. */
  max: number
}

export function createSea(edge: SeaEdgeField): SeaApi {
  const geometry = new THREE.CircleGeometry(SEA_RADIUS, 48)
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uDeep: { value: new THREE.Vector3() },
      uSkyZenith: { value: new THREE.Vector3() },
      uSkyHorizon: { value: new THREE.Vector3() },
      uSkyGlow: { value: new THREE.Vector3() },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Vector3(1, 1, 1) },
      uGlint: { value: 0 },
      uSheen: { value: 0.06 },
      uCloud: { value: 0 },
      uCloudColor: { value: new THREE.Vector3(0.9, 0.9, 0.9) },
      uShelf: { value: new THREE.Vector3() },
      uFoamKey: { value: 0 },
      uFoamCap: { value: 0.8 },
      uTime: { value: 0 },
      uWaves: { value: 0 },
      uEdge: { value: null },
      uEdgeMap: { value: edge.map.clone() },
      uEdgeMax: { value: edge.max },
    },
  ])
  // merge() clones values; the texture has to be handed over by reference.
  ;(uniforms.uEdge as { value: THREE.Texture | null }).value = edge.texture
  const material = new THREE.ShaderMaterial({
    name: 'world.sea',
    defines: {
      SEA_UNDERCUT: SEA_UNDERCUT.toFixed(1),
      SURF_REACH: SURF.reach.toFixed(1),
      SURF_LENGTH: SURF.wavelength.toFixed(1),
      SURF_SPEED: SURF.speed.toFixed(2),
    },
    uniforms,
    vertexShader: vertex,
    fragmentShader: fragment,
    fog: true,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'world.sea'
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = SEA_LEVEL
  mesh.frustumCulled = false
  mesh.raycast = () => {}
  mesh.userData.pgNoShadow = true

  const scratch = new THREE.Color()
  const night = new THREE.Color(SEA_DEEP.night)
  const day = new THREE.Color(SEA_DEEP.day)
  const shelfNight = new THREE.Color(SEA_SHELF.night)
  const shelfDay = new THREE.Color(SEA_SHELF.day)
  const linear = (target: THREE.Vector3, hex: number): void => {
    scratch.setHex(hex)
    target.set(scratch.r, scratch.g, scratch.b)
  }

  function update(dt: number, quality: QualityLevel): void {
    const air = atmosphere()
    const light = themeDaylight()
    scratch.copy(night).lerp(day, light)
    ;(uniforms.uDeep.value as THREE.Vector3).set(scratch.r, scratch.g, scratch.b)
    linear(uniforms.uSkyZenith.value as THREE.Vector3, air.skyZenith)
    linear(uniforms.uSkyHorizon.value as THREE.Vector3, air.skyHorizon)
    linear(uniforms.uSkyGlow.value as THREE.Vector3, air.skyGlow)
    linear(uniforms.uSunColor.value as THREE.Vector3, air.keyColor)
    ;(uniforms.uSunDirection.value as THREE.Vector3)
      .set(air.keyPos[0] - air.keyTarget[0], air.keyPos[1] - air.keyTarget[1], air.keyPos[2] - air.keyTarget[2])
      .normalize()
    // Wherever bloom runs the path stays under its threshold, dusk included: a
    // moon path is weather, not signal.
    uniforms.uGlint.value = air.bloomEnabled ? 0.5 : 2.1
    // A moon path is broad and faint; a sun path is tight and bright.
    uniforms.uSheen.value = 0.2 - 0.14 * light
    uniforms.uWaves.value = seaWaveDetail(quality)
    scratch.copy(shelfNight).lerp(shelfDay, light)
    ;(uniforms.uShelf.value as THREE.Vector3).set(scratch.r, scratch.g, scratch.b)
    // The deck is on the dome at these tiers only; mirror it only where it is.
    const decked = quality === 'high' || quality === 'ultra'
    uniforms.uCloud.value = decked ? (air.daylight ? 0.85 : 0.4) : 0
    if (air.daylight) (uniforms.uCloudColor.value as THREE.Vector3).set(0.9, 0.88, 0.86)
    else linear(uniforms.uCloudColor.value as THREE.Vector3, air.skyHorizon)
    uniforms.uFoamKey.value = air.bloomEnabled ? 0.12 : 0.62
    // Under a bloom pass foam stays below its threshold; daylight has none.
    uniforms.uFoamCap.value = air.bloomEnabled ? 0.8 : 1.4
    if (!reduceMotion()) uniforms.uTime.value = (uniforms.uTime.value + dt) % SEA_TIME_WRAP
  }

  function dispose(): void {
    geometry.dispose()
    material.dispose()
  }

  return { mesh, update, dispose }
}
