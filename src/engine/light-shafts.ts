import * as THREE from 'three'
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js'

import { ATMOSPHERE } from '../core/themes'
import type { QualityLevel } from '../core/types'

export interface LightShaftSettings {
  /** Fraction of the device framebuffer used by the two shaft buffers. */
  scale: number
  /** Radial depth-mask taps. Zero means the pass is absent. */
  samples: number
  /** Maximum linear-HDR addition before the shared output transform. */
  strength: number
}

export const LIGHT_SHAFT_PRESETS: Record<QualityLevel, LightShaftSettings> = {
  low: { scale: 0, samples: 0, strength: 0 },
  reduced: { scale: 0, samples: 0, strength: 0 },
  medium: { scale: 0.25, samples: 6, strength: 0.012 },
  high: { scale: 0.33, samples: 8, strength: 0.016 },
  ultra: { scale: 0.4, samples: 10, strength: 0.02 },
}

/** The existing atmosphere's sun-side aerosol colour, not a second palette. */
export const LIGHT_SHAFT_COLOR = ATMOSPHERE.day.skyGlow

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** CPU mirror of the depth-derived sun-source mask used by the first pass. */
export function lightShaftSource(depth: number, sourceDistance: number): number {
  const sky = smoothstep(0.9998, 0.99998, depth)
  const source = 1 - smoothstep(0.2, 1, sourceDistance)
  return sky * source
}

/** Partial visibility is the only thing that can create a shaft edge. */
export function lightShaftContrast(visibleSource: number, idealSource: number): number {
  if (idealSource <= 1e-6) return 0
  const lit = Math.max(0, Math.min(1, visibleSource / idealSource))
  return 4 * lit * (1 - lit)
}

/** CPU mirror of the perspective-depth attenuation in the composite pass. */
export function lightShaftPathWeight(
  depth: number,
  near: number,
  far: number,
  hazeNear = 8,
  hazeFar = 260,
): number {
  if (depth >= 0.999999) return 1
  const distance = (near * far) / Math.max(1e-6, far - depth * (far - near))
  return smoothstep(hazeNear, hazeFar, distance)
}

/**
 * Screen-space is honest only while the source is in front of the eye and in
 * the viewport. A short inner fade avoids a one-pixel pop at the boundary.
 */
export function screenSpaceSunVisibility(u: number, v: number, forwardDot: number): number {
  if (forwardDot <= 0 || u <= 0 || u >= 1 || v <= 0 || v >= 1) return 0
  const edge = Math.min(u, 1 - u, v, 1 - v)
  return smoothstep(0, 0.06, edge) * smoothstep(0, 0.04, forwardDot)
}

export interface ComposerDepthSource {
  readonly sceneDepthTexture: THREE.DepthTexture | null
}

const fullscreenVertex = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`

const maskFragment = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 uSunUv;
uniform float uAspect;
varying vec2 vUv;

void main() {
  float depth = texture2D( tDepth, vUv ).x;
  float sky = smoothstep( 0.9998, 0.99998, depth );
  vec2 delta = ( vUv - uSunUv ) * vec2( uAspect, 1.0 );
  float sourceDistance = length( delta ) / 0.12;
  float source = 1.0 - smoothstep( 0.2, 1.0, sourceDistance );
  gl_FragColor = vec4( sky * source, 0.0, 0.0, 1.0 );
}
`

const blurFragment = /* glsl */ `
#ifndef PG_SHAFT_SAMPLES
#define PG_SHAFT_SAMPLES 6
#endif

uniform sampler2D tMask;
uniform vec2 uSunUv;
uniform vec2 uResolution;
uniform float uAspect;
varying vec2 vUv;

float interleavedGradientNoise( vec2 pixel ) {
  return fract( 52.9829189 * fract( dot( pixel, vec2( 0.06711056, 0.00583715 ) ) ) );
}

void main() {
  float jitter = interleavedGradientNoise( floor( gl_FragCoord.xy * 0.5 ) );
  float visibleSum = 0.0;
  float idealSum = 0.0;
  float total = 0.0;
  for ( int i = 0; i < PG_SHAFT_SAMPLES; i++ ) {
    float progress = ( float( i ) + jitter * 0.7 ) / float( PG_SHAFT_SAMPLES - 1 );
    vec2 sampleUv = mix( vUv, uSunUv, clamp( progress, 0.0, 1.0 ) );
    float weight = mix( 0.42, 1.0, progress );
    vec2 sourceDelta = ( sampleUv - uSunUv ) * vec2( uAspect, 1.0 );
    float sourceDistance = length( sourceDelta ) / 0.12;
    float idealSource = 1.0 - smoothstep( 0.2, 1.0, sourceDistance );
    visibleSum += texture2D( tMask, sampleUv ).r * weight;
    idealSum += idealSource * weight;
    total += weight;
  }

  float lit = clamp( visibleSum / max( idealSum, 1e-4 ), 0.0, 1.0 );
  float partialOcclusion = 4.0 * lit * ( 1.0 - lit );
  float radialReach = min( 1.0, idealSum / max( total, 1e-4 ) * 5.0 );
  float shaft = partialOcclusion * radialReach;
  float dust = interleavedGradientNoise( floor( vUv * uResolution / 3.0 ) );
  shaft *= mix( 0.99, 1.01, dust );
  gl_FragColor = vec4( shaft, 0.0, 0.0, 1.0 );
}
`

const compositeFragment = /* glsl */ `
uniform sampler2D tShaft;
uniform sampler2D tDepth;
uniform vec3 uColor;
uniform float uStrength;
uniform float uViewportFade;
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uHazeNear;
uniform float uHazeFar;
varying vec2 vUv;

void main() {
  float shaft = texture2D( tShaft, vUv ).r;
  float depth = texture2D( tDepth, vUv ).x;
  float distanceToSurface =
    ( uCameraNear * uCameraFar )
    / max( 1e-6, uCameraFar - depth * ( uCameraFar - uCameraNear ) );
  float airPath = depth >= 0.999999
    ? 1.0
    : smoothstep( uHazeNear, uHazeFar, distanceToSurface );
  vec3 scatter = uColor * shaft * airPath * uStrength * uViewportFade;
  gl_FragColor = vec4( scatter, 1.0 );
}
`

/**
 * A depth-occluded radial pass. It modifies the current composer read buffer
 * in place after GTAO, so the original beauty depth remains available in the
 * opposite ping-pong target without another scene render.
 */
export class LightShaftPass extends Pass {
  private readonly camera: THREE.PerspectiveCamera
  private readonly depthSource: ComposerDepthSource
  private readonly maskTarget: THREE.WebGLRenderTarget
  private readonly blurTarget: THREE.WebGLRenderTarget
  private readonly maskMaterial: THREE.ShaderMaterial
  private readonly blurMaterial: THREE.ShaderMaterial
  private readonly compositeMaterial: THREE.ShaderMaterial
  private readonly quad: FullScreenQuad
  private readonly sunDirection = new THREE.Vector3(0, 1, 0)
  private readonly sunWorld = new THREE.Vector3()
  private readonly sunClip = new THREE.Vector3()
  private readonly cameraForward = new THREE.Vector3()
  private readonly sunUv = new THREE.Vector2(0.5, 0.5)
  private fullWidth = 1
  private fullHeight = 1
  private scale = 0

  constructor(camera: THREE.PerspectiveCamera, depthSource: ComposerDepthSource) {
    super()
    this.camera = camera
    this.depthSource = depthSource
    this.needsSwap = false
    this.enabled = false

    const targetOptions: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    }
    this.maskTarget = new THREE.WebGLRenderTarget(1, 1, targetOptions)
    this.maskTarget.texture.name = 'PGSimCity.lightShaft.mask'
    this.blurTarget = new THREE.WebGLRenderTarget(1, 1, targetOptions)
    this.blurTarget.texture.name = 'PGSimCity.lightShaft.blur'

    this.maskMaterial = new THREE.ShaderMaterial({
      name: 'PGSimCity.LightShaftMask',
      uniforms: {
        tDepth: { value: null },
        uSunUv: { value: this.sunUv },
        uAspect: { value: 1 },
      },
      vertexShader: fullscreenVertex,
      fragmentShader: maskFragment,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    })
    this.blurMaterial = new THREE.ShaderMaterial({
      name: 'PGSimCity.LightShaftBlur',
      defines: { PG_SHAFT_SAMPLES: 6 },
      uniforms: {
        tMask: { value: this.maskTarget.texture },
        uSunUv: { value: this.sunUv },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uAspect: { value: 1 },
      },
      vertexShader: fullscreenVertex,
      fragmentShader: blurFragment,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    })
    this.compositeMaterial = new THREE.ShaderMaterial({
      name: 'PGSimCity.LightShaftComposite',
      uniforms: {
        tShaft: { value: this.blurTarget.texture },
        tDepth: { value: null },
        uColor: { value: new THREE.Color(LIGHT_SHAFT_COLOR) },
        uStrength: { value: 0 },
        uViewportFade: { value: 0 },
        uCameraNear: { value: camera.near },
        uCameraFar: { value: camera.far },
        uHazeNear: { value: 8 },
        uHazeFar: { value: 260 },
      },
      vertexShader: fullscreenVertex,
      fragmentShader: compositeFragment,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      toneMapped: false,
    })
    this.quad = new FullScreenQuad(this.maskMaterial)
  }

  setSunDirection(x: number, y: number, z: number): void {
    this.sunDirection.set(x, y, z).normalize()
  }

  setAtmosphere(color: number, fogNear: number): void {
    const shaftColor = this.compositeMaterial.uniforms.uColor.value as THREE.Color
    shaftColor.setHex(color)
    this.compositeMaterial.uniforms.uHazeNear.value = fogNear * 0.03
    this.compositeMaterial.uniforms.uHazeFar.value = fogNear
  }

  setQuality(level: QualityLevel, daylight: boolean): void {
    const settings = LIGHT_SHAFT_PRESETS[level]
    this.enabled = daylight && settings.scale > 0 && settings.samples > 0
    this.scale = settings.scale
    this.compositeMaterial.uniforms.uStrength.value = settings.strength
    if (this.blurMaterial.defines?.PG_SHAFT_SAMPLES !== settings.samples) {
      this.blurMaterial.defines = { PG_SHAFT_SAMPLES: Math.max(1, settings.samples) }
      this.blurMaterial.needsUpdate = true
    }
    this.setSize(this.fullWidth, this.fullHeight)
  }

  override setSize(width: number, height: number): void {
    this.fullWidth = Math.max(1, Math.round(width))
    this.fullHeight = Math.max(1, Math.round(height))
    const w = Math.max(1, Math.round(this.fullWidth * Math.max(this.scale, 0.01)))
    const h = Math.max(1, Math.round(this.fullHeight * Math.max(this.scale, 0.01)))
    this.maskTarget.setSize(w, h)
    this.blurTarget.setSize(w, h)
    const resolution = this.blurMaterial.uniforms.uResolution.value as THREE.Vector2
    resolution.set(w, h)
    this.maskMaterial.uniforms.uAspect.value = this.fullWidth / this.fullHeight
    this.blurMaterial.uniforms.uAspect.value = this.fullWidth / this.fullHeight
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const depth = this.depthSource.sceneDepthTexture
    if (!depth) return

    this.camera.getWorldDirection(this.cameraForward)
    const forwardDot = this.cameraForward.dot(this.sunDirection)
    this.sunWorld.copy(this.camera.position).addScaledVector(this.sunDirection, this.camera.far * 0.9)
    this.sunClip.copy(this.sunWorld).project(this.camera)
    this.sunUv.set(this.sunClip.x * 0.5 + 0.5, this.sunClip.y * 0.5 + 0.5)
    const viewportFade = screenSpaceSunVisibility(this.sunUv.x, this.sunUv.y, forwardDot)
    if (viewportFade <= 0) return

    this.maskMaterial.uniforms.tDepth.value = depth
    this.compositeMaterial.uniforms.tDepth.value = depth
    this.compositeMaterial.uniforms.uViewportFade.value = viewportFade
    this.compositeMaterial.uniforms.uCameraNear.value = this.camera.near
    this.compositeMaterial.uniforms.uCameraFar.value = this.camera.far

    this.quad.material = this.maskMaterial
    renderer.setRenderTarget(this.maskTarget)
    this.quad.render(renderer)

    this.quad.material = this.blurMaterial
    renderer.setRenderTarget(this.blurTarget)
    this.quad.render(renderer)

    this.quad.material = this.compositeMaterial
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.setRenderTarget(readBuffer)
    this.quad.render(renderer)
    renderer.autoClear = autoClear
  }

  override dispose(): void {
    this.maskTarget.dispose()
    this.blurTarget.dispose()
    this.maskMaterial.dispose()
    this.blurMaterial.dispose()
    this.compositeMaterial.dispose()
    this.quad.dispose()
  }
}
