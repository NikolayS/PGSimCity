import * as THREE from 'three'
import { Reflector } from 'three/examples/jsm/objects/Reflector.js'
import { atmosphere } from '../core/theme'
import type { QualityLevel, QualitySettings } from '../core/types'
import { damp, makeRng } from '../core/util'
import { CITY } from '../world/layout'

export interface BufferWaterApi {
  group: THREE.Group
  /** Advances the fixed ripple pool and the underwater atmosphere. */
  update(dt: number, submerged: boolean): void
  /** Surface-space one-shot. Uses a preallocated ripple slot. */
  splash(x: number, z: number, intensity: number): void
  dispose(): void
}

export interface BufferWaterOptions {
  /** Test override; production reads prefers-reduced-motion once at creation. */
  reducedMotion?: boolean
  /** Keeps the fixed particulate field close enough to give a swimmer parallax. */
  camera?: THREE.Camera
}

const SPAN = (CITY.buf.grid - 1) * CITY.buf.pitch + CITY.buf.tile
const SURFACE_Y = CITY.buf.baseY + CITY.buf.maxRise + 0.4
const BOTTOM_Y = CITY.buf.baseY
const DEPTH = SURFACE_Y - BOTTOM_Y
const RIPPLE_COUNT = 6
const RIPPLE_SECONDS = 1.15
const PARTICULATE_COUNT = 192
const PARTICULATE_FIELD = 18
const PARTICULATE_OPACITY = 0.22
const PARTICULATE_TEXTURE_SIZE = 16
const WATER_COLOR = 0x5aa9e8
const UNDERWATER_FOG = 0x163a66
const UNDERWATER_NEAR = 3
const UNDERWATER_FAR = 55
const FOG_SETTLE = 8
const DEFAULT_QUALITY: Pick<QualitySettings, 'level'> = { level: 'reduced' }

const REFLECTION_SCALE: Record<QualityLevel, number> = {
  low: 0,
  reduced: 0,
  medium: 0.25,
  high: 0.5,
  ultra: 0.5,
}

/** Fraction of the drawing buffer spent on the planar water pass. */
export function waterReflectionScale(level: QualityLevel): number {
  return REFLECTION_SCALE[level]
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

const waterVertex = /* glsl */ `
uniform mat4 textureMatrix;
varying vec4 vReflectionCoord;
varying vec2 vPoolUv;
varying vec3 vWorldPosition;

#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>

void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vWorldPosition = world.xyz;
  vPoolUv = uv;
  vReflectionCoord = textureMatrix * vec4( position, 1.0 );
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
  #include <logdepthbuf_vertex>
}
`

const waterFragment = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uTexelSize;
uniform vec3 uBaseColor;
uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform float uOpacity;
uniform float uReflectionStrength;
uniform float uRoughness;
uniform float uTime;
varying vec4 vReflectionCoord;
varying vec2 vPoolUv;
varying vec3 vWorldPosition;

#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>

void main() {
  #include <logdepthbuf_fragment>

  vec3 col = uBaseColor;
  float alpha = uOpacity;
  if ( uReflectionStrength > 0.001 ) {
    float a = uTime * 0.72;
    vec2 wave = vec2(
      cos( vPoolUv.x * 47.0 + vPoolUv.y * 19.0 + a )
        + cos( vPoolUv.y * 73.0 - a * 1.37 ),
      sin( vPoolUv.y * 43.0 - vPoolUv.x * 17.0 - a * 0.83 )
        + sin( vPoolUv.x * 61.0 + a * 1.19 )
    ) * 0.5;

    vec3 viewDirection = normalize( cameraPosition - vWorldPosition );
    vec3 waveNormal = normalize( vec3( wave.x * 0.055, 1.0, wave.y * 0.055 ) );
    float facing = clamp( dot( viewDirection, waveNormal ), 0.0, 1.0 );
    float oneMinusFacing = 1.0 - facing;
    float fresnel = 0.025 + 0.975 * oneMinusFacing * oneMinusFacing
      * oneMinusFacing * oneMinusFacing * oneMinusFacing;

    float viewDistance = distance( cameraPosition, vWorldPosition );
    float farBlur = smoothstep( 26.0, 240.0, viewDistance );
    vec2 projected = vReflectionCoord.xy / max( vReflectionCoord.w, 1e-5 );
    projected += wave * mix( 0.0007, 0.0018, farBlur );
    projected = clamp( projected, uTexelSize * 2.0, vec2( 1.0 ) - uTexelSize * 2.0 );
    vec2 blur = uTexelSize * mix( 1.3, 5.2, farBlur ) * uRoughness;

    vec3 reflected = texture2D( tDiffuse, projected ).rgb * 0.36;
    reflected += texture2D( tDiffuse, projected + vec2( blur.x, 0.0 ) ).rgb * 0.16;
    reflected += texture2D( tDiffuse, projected - vec2( blur.x, 0.0 ) ).rgb * 0.16;
    reflected += texture2D( tDiffuse, projected + vec2( 0.0, blur.y ) ).rgb * 0.16;
    reflected += texture2D( tDiffuse, projected - vec2( 0.0, blur.y ) ).rgb * 0.16;

    float edge = min( min( vPoolUv.x, 1.0 - vPoolUv.x ), min( vPoolUv.y, 1.0 - vPoolUv.y ) );
    float opticalDepth = smoothstep( 0.0, 0.28, edge );
    vec3 waterTint = mix( uShallowColor, uDeepColor, 0.28 + opticalDepth * 0.72 );
    float reflectionMix = uReflectionStrength * mix( 0.14, 0.74, fresnel );
    col = mix( waterTint, reflected, reflectionMix );
    alpha += reflectionMix * 0.55;
  }

  gl_FragColor = vec4( col, alpha );
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const WATER_SHADER = {
  name: 'PGSimCityWater',
  uniforms: THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      color: { value: new THREE.Color(WATER_COLOR) },
      tDiffuse: { value: null },
      textureMatrix: { value: new THREE.Matrix4() },
      uTexelSize: { value: new THREE.Vector2(1, 1) },
      uBaseColor: { value: new THREE.Color(WATER_COLOR) },
      uShallowColor: { value: new THREE.Color(0x69b9df) },
      uDeepColor: { value: new THREE.Color(0x1f5f9d) },
      uOpacity: { value: 0.18 },
      uReflectionStrength: { value: 0 },
      uRoughness: { value: 0.74 },
      uTime: { value: 0 },
    },
  ]),
  vertexShader: waterVertex,
  fragmentShader: waterFragment,
}

interface Ripple {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
  age: number
  strength: number
}

/**
 * The buffer columns remain data and remain non-solid. This is a separate,
 * purely visual volume spanning the already-defined swim region above the
 * plaza deck.
 */
export function createBufferWater(
  scene: THREE.Scene,
  quality: Pick<QualitySettings, 'level'> = DEFAULT_QUALITY,
  opts: BufferWaterOptions = {},
): BufferWaterApi {
  const reducedMotion = opts.reducedMotion ?? prefersReducedMotion()
  const particulateCamera = opts.camera
  const group = new THREE.Group()
  group.name = 'buffer.water'

  const surfaceGeometry = new THREE.PlaneGeometry(SPAN, SPAN)
  const surface = new Reflector(surfaceGeometry, {
    clipBias: 0.002,
    textureWidth: 1,
    textureHeight: 1,
    multisample: 0,
    shader: WATER_SHADER,
  })
  const surfaceMaterial = surface.material as THREE.ShaderMaterial
  surfaceMaterial.transparent = true
  surfaceMaterial.depthWrite = false
  surfaceMaterial.side = THREE.DoubleSide
  surfaceMaterial.fog = true
  surface.name = 'buffer.water.surface'
  surface.rotation.x = -Math.PI / 2
  surface.position.y = SURFACE_Y
  surface.renderOrder = 3
  surface.raycast = () => {}
  surface.userData.pgPlanarReflection = true
  group.add(surface)

  const reflectionTarget = surface.getRenderTarget()
  reflectionTarget.texture.name = 'PGSimCity.water.planar-reflection'
  reflectionTarget.texture.generateMipmaps = false
  const reflectionSize = new THREE.Vector2()
  const texelSize = surfaceMaterial.uniforms.uTexelSize.value as THREE.Vector2
  const renderReflection = surface.onBeforeRender
  surface.onBeforeRender = (renderer, activeScene, camera, geometry, material, renderGroup): void => {
    const scale = waterReflectionScale(quality.level)
    const enabled =
      scale > 0 &&
      atmosphere().daylight &&
      camera.position.y > SURFACE_Y + 0.05
    surfaceMaterial.uniforms.uReflectionStrength.value = enabled ? 0.9 : 0
    if (!enabled) return

    renderer.getDrawingBufferSize(reflectionSize)
    const width = Math.max(1, Math.round(reflectionSize.x * scale))
    const height = Math.max(1, Math.round(reflectionSize.y * scale))
    if (reflectionTarget.width !== width || reflectionTarget.height !== height) {
      reflectionTarget.setSize(width, height)
      texelSize.set(1 / width, 1 / height)
    }
    renderReflection.call(surface, renderer, activeScene, camera, geometry, material, renderGroup)
  }

  // A faint inside face gives the volume a boundary at grazing angles without
  // changing collision or hiding the live-height buffer columns.
  const volumeGeometry = new THREE.BoxGeometry(SPAN, DEPTH, SPAN)
  const volumeMaterial = new THREE.MeshBasicMaterial({
    color: 0x356fd0,
    transparent: true,
    opacity: 0.025,
    depthWrite: false,
    side: THREE.BackSide,
  })
  const volume = new THREE.Mesh(volumeGeometry, volumeMaterial)
  volume.name = 'buffer.water.volume'
  volume.position.y = BOTTOM_Y + DEPTH * 0.5
  volume.renderOrder = 2
  volume.raycast = () => {}
  group.add(volume)

  const grid = new THREE.GridHelper(SPAN, 16, 0x8fd6ff, 0x477ed0)
  grid.name = 'buffer.water.surface-grid'
  grid.position.y = SURFACE_Y + 0.025
  const gridMaterial = grid.material as THREE.LineBasicMaterial
  gridMaterial.transparent = true
  gridMaterial.opacity = 0.16
  gridMaterial.depthWrite = false
  grid.raycast = () => {}
  group.add(grid)

  /*
   * World-space motes create parallax around a moving swimmer without painting
   * over the buffer tiles. Normal blending and depth testing preserve every
   * semantic tile colour; one fixed buffer is rewritten only while submerged.
   */
  const particulateGeometry = new THREE.BufferGeometry()
  const particulatePositions = new Float32Array(PARTICULATE_COUNT * 3)
  const particulateRng = makeRng(0x51a11)
  for (let i = 0; i < PARTICULATE_COUNT; i++) {
    const offset = i * 3
    particulatePositions[offset] = (particulateRng() - 0.5) * PARTICULATE_FIELD
    particulatePositions[offset + 1] = BOTTOM_Y + 0.12 + particulateRng() * (DEPTH - 0.24)
    particulatePositions[offset + 2] = (particulateRng() - 0.5) * PARTICULATE_FIELD
  }
  const particulatePosition = new THREE.BufferAttribute(particulatePositions, 3)
  particulatePosition.setUsage(THREE.DynamicDrawUsage)
  particulateGeometry.setAttribute('position', particulatePosition)
  const particulateTexels = new Uint8Array(
    PARTICULATE_TEXTURE_SIZE * PARTICULATE_TEXTURE_SIZE * 4,
  )
  for (let y = 0; y < PARTICULATE_TEXTURE_SIZE; y++) {
    for (let x = 0; x < PARTICULATE_TEXTURE_SIZE; x++) {
      const tx = (x + 0.5) / PARTICULATE_TEXTURE_SIZE - 0.5
      const ty = (y + 0.5) / PARTICULATE_TEXTURE_SIZE - 0.5
      const edge = Math.max(0, Math.min(1, (0.5 - Math.hypot(tx, ty)) * 8))
      const offset = (y * PARTICULATE_TEXTURE_SIZE + x) * 4
      particulateTexels[offset] = 255
      particulateTexels[offset + 1] = 255
      particulateTexels[offset + 2] = 255
      particulateTexels[offset + 3] = Math.round(edge * edge * 255)
    }
  }
  const particulateTexture = new THREE.DataTexture(
    particulateTexels,
    PARTICULATE_TEXTURE_SIZE,
    PARTICULATE_TEXTURE_SIZE,
    THREE.RGBAFormat,
  )
  particulateTexture.name = 'PGSimCity.water.particulate'
  particulateTexture.needsUpdate = true
  const particulateMaterial = new THREE.PointsMaterial({
    color: 0xd9efff,
    map: particulateTexture,
    alphaTest: 0.02,
    size: 0.035,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  })
  const particulate = new THREE.Points(particulateGeometry, particulateMaterial)
  particulate.name = 'buffer.water.particulate'
  particulate.visible = false
  particulate.frustumCulled = false
  particulate.renderOrder = 4
  particulate.raycast = () => {}
  group.add(particulate)

  const rippleGeometry = new THREE.RingGeometry(0.78, 1, 32)
  const ripples: Ripple[] = []
  for (let i = 0; i < RIPPLE_COUNT; i++) {
    const material = new THREE.MeshBasicMaterial({
      color: 0xb9e7ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(rippleGeometry, material)
    mesh.name = 'buffer.water.ripple'
    mesh.rotation.x = -Math.PI / 2
    mesh.position.y = SURFACE_Y + 0.055 + i * 0.002
    mesh.visible = false
    mesh.renderOrder = 4
    mesh.raycast = () => {}
    group.add(mesh)
    ripples.push({ mesh, age: RIPPLE_SECONDS, strength: 0 })
  }
  let rippleCursor = 0

  const fog = scene.fog instanceof THREE.Fog ? scene.fog : null
  let airFog = fog?.color.getHex() ?? 0
  let airNear = fog?.near ?? 0
  let airFar = fog?.far ?? 0
  let fogAmount = 0
  let wasSubmerged = false
  let waterTime = 0

  function splash(x: number, z: number, intensity: number): void {
    const strength = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity
    if (strength <= 0) return
    const ripple = ripples[rippleCursor]
    rippleCursor = (rippleCursor + 1) % ripples.length
    ripple.age = 0
    ripple.strength = strength
    ripple.mesh.position.x = x
    ripple.mesh.position.z = z
    ripple.mesh.scale.setScalar(0.65 + strength * 0.35)
    ripple.mesh.material.opacity = 0.42 + strength * 0.3
    ripple.mesh.visible = true
  }

  function update(dt: number, submerged: boolean): void {
    const d = dt > 0 ? dt : 0
    if (!reducedMotion) waterTime += d
    surfaceMaterial.uniforms.uTime.value = waterTime
    for (let i = 0; i < ripples.length; i++) {
      const ripple = ripples[i]
      if (!ripple.mesh.visible) continue
      ripple.age += d
      if (ripple.age >= RIPPLE_SECONDS) {
        ripple.mesh.visible = false
        ripple.mesh.material.opacity = 0
        continue
      }
      const t = ripple.age / RIPPLE_SECONDS
      const spread = reducedMotion ? 0 : t * (5.5 + ripple.strength * 3)
      const scale = 0.65 + ripple.strength * 0.35 + spread
      ripple.mesh.scale.setScalar(scale)
      ripple.mesh.material.opacity = (1 - t) * (0.34 + ripple.strength * 0.34)
    }

    if (submerged && !reducedMotion && d > 0) {
      const fieldHalf = PARTICULATE_FIELD * 0.5
      const centreX = particulateCamera
        ? Math.max(
            -SPAN * 0.5 + fieldHalf,
            Math.min(SPAN * 0.5 - fieldHalf, particulateCamera.position.x),
          )
        : 0
      const centreZ = particulateCamera
        ? Math.max(
            -SPAN * 0.5 + fieldHalf,
            Math.min(SPAN * 0.5 - fieldHalf, particulateCamera.position.z),
          )
        : 0
      for (let i = 0; i < PARTICULATE_COUNT; i++) {
        const offset = i * 3
        particulatePositions[offset] += ((i % 3) - 1) * 0.013 * d
        particulatePositions[offset + 1] += (0.045 + (i % 7) * 0.009) * d
        particulatePositions[offset + 2] += (((i * 5) % 3) - 1) * 0.009 * d
        while (particulatePositions[offset] > centreX + fieldHalf) {
          particulatePositions[offset] -= PARTICULATE_FIELD
        }
        while (particulatePositions[offset] < centreX - fieldHalf) {
          particulatePositions[offset] += PARTICULATE_FIELD
        }
        if (particulatePositions[offset + 1] > SURFACE_Y - 0.08) {
          particulatePositions[offset + 1] = BOTTOM_Y + 0.08
        }
        while (particulatePositions[offset + 2] > centreZ + fieldHalf) {
          particulatePositions[offset + 2] -= PARTICULATE_FIELD
        }
        while (particulatePositions[offset + 2] < centreZ - fieldHalf) {
          particulatePositions[offset + 2] += PARTICULATE_FIELD
        }
      }
      particulatePosition.needsUpdate = true
    }

    if (!fog) return
    if (submerged && !wasSubmerged) {
      airFog = fog.color.getHex()
      airNear = fog.near
      airFar = fog.far
    } else if (!submerged && fogAmount < 0.001) {
      // Theme changes are free to repaint the atmosphere while the swimmer is
      // in air; capture that current state instead of restoring an old palette.
      airFog = fog.color.getHex()
      airNear = fog.near
      airFar = fog.far
    }
    wasSubmerged = submerged
    fogAmount = damp(fogAmount, submerged ? 1 : 0, FOG_SETTLE, d)
    if (!submerged && fogAmount < 0.001) fogAmount = 0

    const ar = ((airFog >> 16) & 255) / 255
    const ag = ((airFog >> 8) & 255) / 255
    const ab = (airFog & 255) / 255
    const wr = ((UNDERWATER_FOG >> 16) & 255) / 255
    const wg = ((UNDERWATER_FOG >> 8) & 255) / 255
    const wb = (UNDERWATER_FOG & 255) / 255
    fog.color.setRGB(
      ar + (wr - ar) * fogAmount,
      ag + (wg - ag) * fogAmount,
      ab + (wb - ab) * fogAmount,
      THREE.SRGBColorSpace,
    )
    fog.near = airNear + (UNDERWATER_NEAR - airNear) * fogAmount
    fog.far = airFar + (UNDERWATER_FAR - airFar) * fogAmount
    surfaceMaterial.uniforms.uOpacity.value = 0.18 + fogAmount * 0.13
    volumeMaterial.opacity = 0.025 + fogAmount * 0.055
    particulateMaterial.opacity = PARTICULATE_OPACITY * fogAmount
    particulate.visible = fogAmount > 0.002
  }

  function dispose(): void {
    if (fog) {
      fog.color.setHex(airFog)
      fog.near = airNear
      fog.far = airFar
    }
    group.removeFromParent()
    surfaceGeometry.dispose()
    surface.dispose()
    volumeGeometry.dispose()
    volumeMaterial.dispose()
    grid.geometry.dispose()
    gridMaterial.dispose()
    particulateGeometry.dispose()
    particulateMaterial.dispose()
    particulateTexture.dispose()
    rippleGeometry.dispose()
    for (let i = 0; i < ripples.length; i++) ripples[i].mesh.material.dispose()
    ripples.length = 0
  }

  return { group, update, splash, dispose }
}
