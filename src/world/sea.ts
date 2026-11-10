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
/** Beyond the far fog distance in both modes, so no edge is ever visible. */
export const SEA_RADIUS = 3800
/** Deep-water body colour, sRGB. Low chroma by construction. */
export const SEA_DEEP = { day: 0x1f3440, night: 0x070a10 } as const

/** Metres the water reaches in under the kerb before the island cuts it away. */
export const SEA_UNDERCUT = 3

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
uniform float uTime;
uniform float uWaves;
uniform sampler2D uEdge;
uniform vec4 uEdgeMap;
uniform float uEdgeMax;
varying vec3 vWorld;
#include <fog_pars_fragment>

${WET_FIELD_GLSL}

// Two crossing swells on rotated axes, so no lattice lines up with the coast.
float seaHeight( vec2 p ) {
  vec2 a = mat2( 0.8, 0.6, -0.6, 0.8 ) * p;
  vec2 b = mat2( 0.28, -0.96, 0.96, 0.28 ) * p;
  return wetNoise( a * 0.045 + vec2( uTime * 0.035, uTime * 0.021 ) )
       + 0.5 * wetNoise( b * 0.13 - vec2( uTime * 0.05, -uTime * 0.03 ) );
}

void main() {
  // No water under the island: every excavation in the plate must stay open
  // down to its own floor, or the storage districts drown.
  vec2 euv = ( vWorld.xz - uEdgeMap.xy ) * uEdgeMap.zw;
  // Metres offshore; large where the edge field has no opinion.
  float offshore = 1000.0;
  if ( euv.x > 0.0 && euv.x < 1.0 && euv.y > 0.0 && euv.y < 1.0 ) {
    float inside = ( texture2D( uEdge, euv ).r - 0.5 ) * 2.0 * uEdgeMax;
    if ( inside > SEA_UNDERCUT ) discard;
    offshore = - inside;
  }
  vec3 toEye = normalize( cameraPosition - vWorld );
  float range = distance( cameraPosition, vWorld );
  vec3 normal = vec3( 0.0, 1.0, 0.0 );
  if ( uWaves > 0.5 ) {
    vec2 p = vWorld.xz;
    float h = seaHeight( p );
    vec2 slope = vec2( seaHeight( p + vec2( 1.5, 0.0 ) ) - h, seaHeight( p + vec2( 0.0, 1.5 ) ) - h );
    if ( uWaves > 1.5 ) {
      // Chop is a near-field detail; past a few hundred metres it only aliases.
      vec2 q = mat2( 0.54, 0.84, -0.84, 0.54 ) * p * 0.6 + uTime * 0.11;
      float chop = wetNoise( q );
      float near = 1.0 - smoothstep( 80.0, 520.0, range );
      slope += vec2( wetNoise( q + vec2( 0.4, 0.0 ) ) - chop, wetNoise( q + vec2( 0.0, 0.4 ) ) - chop ) * 0.35 * near;
    }
    // Waves flatten toward the horizon, or the far sea boils with aliasing.
    float calm = 1.0 - 0.85 * smoothstep( 250.0, 1800.0, range );
    normal = normalize( vec3( - slope.x * 0.9 * calm, 1.0, - slope.y * 0.9 * calm ) );
  }
  vec3 mirror = reflect( - toEye, normal );
  mirror.y = abs( mirror.y );
  float fresnel = 0.02 + 0.98 * pow( 1.0 - clamp( dot( toEye, normal ), 0.0, 1.0 ), 5.0 );
  vec3 sky = wetSky( mirror, uSunDirection, uSkyZenith, uSkyHorizon, uSkyGlow );
  float sunward = max( dot( mirror, uSunDirection ), 0.0 );
  vec3 col = mix( uDeep, sky, fresnel );
  col += uSunColor * uGlint * ( pow( sunward, 260.0 ) + uSheen * pow( sunward, 28.0 ) );
  if ( uWaves > 0.5 && offshore < 26.0 ) {
    // Wash against the retaining wall: broken, drifting, and lit only by the
    // sky it sits under, so it is grey at night and can never read as a signal.
    float surge = wetNoise( vWorld.xz * 0.21 + uTime * 0.16 ) * 0.6 + wetNoise( vWorld.xz * 0.9 - uTime * 0.23 ) * 0.4;
    float band = 1.0 - smoothstep( 1.0, 9.0 + 14.0 * surge, offshore + 3.0 );
    float foam = band * smoothstep( 0.34, 0.62, surge );
    vec3 foamColor = ( uSkyHorizon * 0.9 + uSunColor * uGlint * 0.16 );
    col = mix( col, min( foamColor, vec3( 0.8 ) ), foam * 0.8 );
  }
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
    defines: { SEA_UNDERCUT: SEA_UNDERCUT.toFixed(1) },
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
    // Night stays under the bloom threshold: a moon path is weather, not signal.
    uniforms.uGlint.value = 0.5 + 1.6 * light
    // A moon path is broad and faint; a sun path is tight and bright.
    uniforms.uSheen.value = 0.2 - 0.14 * light
    uniforms.uWaves.value = seaWaveDetail(quality)
    if (!reduceMotion()) uniforms.uTime.value = (uniforms.uTime.value + dt) % 4096
  }

  function dispose(): void {
    geometry.dispose()
    material.dispose()
  }

  return { mesh, update, dispose }
}
