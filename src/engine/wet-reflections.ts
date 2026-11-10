import * as THREE from 'three'
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js'

import type { Atmosphere } from '../core/themes'
import type { QualityLevel } from '../core/types'
import { WET_FIELD_GLSL, groundWetness } from '../world/ground-surface'

/* ============================================================================
 * WET-GROUND REFLECTIONS — the city mirrored in its own standing water.
 *
 * Screen-space, not planar: a second scene render would double every draw in a
 * renderer that is already frame-starved, while this is one fullscreen pass
 * that marches only on pixels the shared wetness field marks as water.
 *
 * It mirrors what the beauty pass already drew, so it cannot invent a signal.
 * A reflected neon is the same fact seen twice; it is capped below the bloom
 * threshold so that only the original glows.
 * ==========================================================================*/

export interface WetReflectionSettings {
  /** Ray-march taps along the mirrored ray. Zero means the pass is absent. */
  steps: number
  /** Fraction of the device framebuffer the march runs at. */
  scale: number
}

export const WET_REFLECTION_PRESETS: Record<QualityLevel, WetReflectionSettings> = {
  low: { steps: 0, scale: 0 },
  reduced: { steps: 0, scale: 0 },
  medium: { steps: 0, scale: 0 },
  high: { steps: 16, scale: 0.5 },
  ultra: { steps: 24, scale: 0.75 },
}

/** First march step in metres and the geometric growth of each later one. */
export const WET_MARCH_START = 0.6
export const WET_MARCH_GROWTH = 1.22
/** Mirrored radiance ceiling at night, kept under the bloom threshold. */
export const WET_NIGHT_RADIANCE_CAP = 0.8
/** Paving, plinth tops and decals sit within this band of the plate. */
export const WET_PLATE_BAND = 0.07

/** CPU mirror of the pass's radiance cap: the peak channel is limited, the ratios are kept. */
export function capMirroredRadiance(
  rgb: readonly [number, number, number],
  cap: number,
): [number, number, number] {
  const scale = Math.min(1, cap / Math.max(rgb[0], rgb[1], rgb[2], 0.00001))
  return [rgb[0] * scale, rgb[1] * scale, rgb[2] * scale]
}

/** Metres of mirrored ray a tier can resolve before the reflection fades to sky. */
export function wetReflectionReach(steps: number): number {
  if (steps <= 0) return 0
  return (WET_MARCH_START * (Math.pow(WET_MARCH_GROWTH, steps) - 1)) / (WET_MARCH_GROWTH - 1)
}

interface ComposerDepthSource {
  sceneDepthTexture: THREE.DepthTexture | null
}

const vertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`

const fragment = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform mat4 uProjectionInverse;
uniform mat4 uCameraWorld;
uniform mat4 uViewProjection;
uniform vec3 uCameraPosition;
uniform float uNear;
uniform float uFar;
uniform float uReach;
uniform float uRadianceCap;
varying vec2 vUv;

${WET_FIELD_GLSL}

float viewDepth( float depth ) {
  float ndc = depth * 2.0 - 1.0;
  return ( 2.0 * uNear * uFar ) / ( uFar + uNear - ndc * ( uFar - uNear ) );
}

void main() {
  // Premultiplied mirror: rgb is added, alpha is how much paving it replaces.
  gl_FragColor = vec4( 0.0 );
  float depth = texture2D( tDepth, vUv ).x;
  if ( depth >= 0.999999 ) return;

  vec4 view = uProjectionInverse * vec4( vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
  view /= max( view.w, 0.000001 );
  vec3 world = ( uCameraWorld * view ).xyz;
  if ( abs( world.y ) > __PLATE_BAND__ ) return;

  float viewDistance = distance( world, uCameraPosition );
  vec4 field = wetField( world.xz, viewDistance );
  float amount = wetMirror( field.z, field.w );
  if ( amount < 0.02 ) return;

  vec3 toEye = normalize( uCameraPosition - world );
  if ( toEye.y <= 0.0 ) return;
  vec3 mirror = reflect( - toEye, vec3( 0.0, 1.0, 0.0 ) );

  float travelled = __MARCH_START__;
  float stride = __MARCH_START__;
  float previous = 0.0;
  float found = -1.0;
  for ( int i = 0; i < PG_WET_STEPS; i++ ) {
    vec4 clip = uViewProjection * vec4( world + mirror * travelled, 1.0 );
    if ( clip.w <= 0.0 ) break;
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) break;
    float behind = clip.w - viewDepth( texture2D( tDepth, uv ).x );
    // Thickness follows the stride: a far tap may skip a wall, never pass through one.
    if ( behind > 0.0 && behind < stride * 2.0 + 1.5 ) {
      found = travelled;
      break;
    }
    previous = travelled;
    stride *= __MARCH_GROWTH__;
    travelled += stride;
  }
  if ( found < 0.0 ) return;

  float lo = previous;
  float hi = found;
  for ( int i = 0; i < 5; i++ ) {
    float mid = ( lo + hi ) * 0.5;
    vec4 clip = uViewProjection * vec4( world + mirror * mid, 1.0 );
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    if ( clip.w - viewDepth( texture2D( tDepth, uv ).x ) > 0.0 ) hi = mid; else lo = mid;
  }
  vec4 hitClip = uViewProjection * vec4( world + mirror * hi, 1.0 );
  vec2 hitUv = hitClip.xy / hitClip.w * 0.5 + 0.5;

  vec2 border = smoothstep( vec2( 0.0 ), vec2( 0.08 ), hitUv ) * ( 1.0 - smoothstep( vec2( 0.92 ), vec2( 1.0 ), hitUv ) );
  float fade = border.x * border.y * ( 1.0 - smoothstep( uReach * 0.6, uReach, hi ) );
  // Scale, never clamp per channel: a clamp turns WAL amber into warn yellow.
  vec3 mirrored = texture2D( tDiffuse, hitUv ).rgb;
  mirrored *= min( 1.0, uRadianceCap / max( max( mirrored.r, mirrored.g ), max( mirrored.b, 0.00001 ) ) );
  float weight = wetFresnel( toEye.y ) * amount * fade;
  gl_FragColor = vec4( mirrored * weight, weight );
}
`
  .replace('__PLATE_BAND__', WET_PLATE_BAND.toFixed(3))
  .replaceAll('__MARCH_START__', WET_MARCH_START.toFixed(3))
  .replace('__MARCH_GROWTH__', WET_MARCH_GROWTH.toFixed(3))

const compositeFragment = /* glsl */ `
uniform sampler2D tMirror;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D( tMirror, vUv );
}
`

export class WetReflectionPass extends Pass {
  private readonly camera: THREE.PerspectiveCamera
  private readonly depthSource: ComposerDepthSource
  private readonly material: THREE.ShaderMaterial
  private readonly composite: THREE.ShaderMaterial
  private readonly target: THREE.WebGLRenderTarget
  private readonly quad: FullScreenQuad
  private fullWidth = 1
  private fullHeight = 1
  private scale = 0.5

  constructor(camera: THREE.PerspectiveCamera, depthSource: ComposerDepthSource) {
    super()
    this.camera = camera
    this.depthSource = depthSource
    this.enabled = false
    // Sampling scene depth while writing its own framebuffer is a feedback loop,
    // so the march owns a target and blends back onto the buffer being read.
    this.needsSwap = false
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    })
    this.target.texture.name = 'PGSimCity.wetReflection'
    this.material = new THREE.ShaderMaterial({
      name: 'PGSimCity.WetReflection',
      defines: { PG_WET_STEPS: 16 },
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uProjectionInverse: { value: new THREE.Matrix4() },
        uCameraWorld: { value: new THREE.Matrix4() },
        uViewProjection: { value: new THREE.Matrix4() },
        uCameraPosition: { value: new THREE.Vector3() },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
        uReach: { value: 1 },
        uRadianceCap: { value: WET_NIGHT_RADIANCE_CAP },
      },
      vertexShader: vertex,
      fragmentShader: fragment,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    })
    this.composite = new THREE.ShaderMaterial({
      name: 'PGSimCity.WetReflectionComposite',
      uniforms: { tMirror: { value: this.target.texture } },
      vertexShader: vertex,
      fragmentShader: compositeFragment,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      toneMapped: false,
    })
    this.quad = new FullScreenQuad(this.material)
  }

  /** Daylight has no bloom pass, so the sunlit city may mirror at full value. */
  setAtmosphere(air: Atmosphere): void {
    this.material.uniforms.uRadianceCap.value = air.bloomEnabled ? WET_NIGHT_RADIANCE_CAP : 8
  }

  setQuality(level: QualityLevel, depthAvailable: boolean): void {
    const { steps, scale } = WET_REFLECTION_PRESETS[level]
    this.enabled = depthAvailable && steps > 0 && groundWetness(level) > 0
    if (!this.enabled) return
    this.scale = scale
    this.setSize(this.fullWidth, this.fullHeight)
    this.material.uniforms.uReach.value = wetReflectionReach(steps)
    if (this.material.defines.PG_WET_STEPS !== steps) {
      this.material.defines.PG_WET_STEPS = steps
      this.material.needsUpdate = true
    }
  }

  override setSize(width: number, height: number): void {
    this.fullWidth = Math.max(1, Math.round(width))
    this.fullHeight = Math.max(1, Math.round(height))
    this.target.setSize(
      Math.max(1, Math.round(this.fullWidth * this.scale)),
      Math.max(1, Math.round(this.fullHeight * this.scale)),
    )
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    if (!this.depthSource.sceneDepthTexture) return
    const u = this.material.uniforms
    const camera = this.camera
    u.tDiffuse.value = readBuffer.texture
    u.tDepth.value = this.depthSource.sceneDepthTexture
    u.uNear.value = camera.near
    u.uFar.value = camera.far
    ;(u.uCameraPosition.value as THREE.Vector3).copy(camera.position)
    ;(u.uProjectionInverse.value as THREE.Matrix4).copy(camera.projectionMatrixInverse)
    ;(u.uCameraWorld.value as THREE.Matrix4).copy(camera.matrixWorld)
    ;(u.uViewProjection.value as THREE.Matrix4).multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.quad.material = this.material
    renderer.setRenderTarget(this.target)
    this.quad.render(renderer)
    this.quad.material = this.composite
    renderer.setRenderTarget(readBuffer)
    // The composite blends over the beauty pass; a clear here would erase it.
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    this.quad.render(renderer)
    renderer.autoClear = autoClear
  }

  override dispose(): void {
    this.material.dispose()
    this.composite.dispose()
    this.target.dispose()
    this.quad.dispose()
  }
}
