import * as THREE from 'three'
import { applyBoxBevelDetail } from '../core/beveled-box'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js'
import {
  COLOR,
  applyStoredThemeMode,
  atmosphere,
  onThemeMode,
  paintSceneMaterial,
  setBloomAvailable,
  startThemeClock,
  themeEnvironmentKey,
  themeMode,
} from '../core/theme'
import type { Atmosphere, ThemeMode } from '../core/theme'
import { clamp, damp } from '../core/util'
import { ANCHOR, CITY } from '../world/layout'
import { applyGroundAtmosphere } from '../world/plate-fog'
import { applySkyAtmosphere } from '../world/sky'
import type { Bus, QualityLevel, QualitySettings } from '../core/types'
import { GoldenHourOutputPass } from './color-grade'
import { LIGHT_SHAFT_PRESETS, LightShaftPass } from './light-shafts'
import { waterReflectionScale } from './water'

/* ============================================================================
 * THE RENDERER
 *
 * Two rendering models, one pipeline.
 *
 * NIGHT — a city lit by its own data. Structure is matte PBR lit by a cold key
 * + fill; meaning is neon (toneMapped:false, emissive > 1) and is the only
 * thing that clears the bloom threshold.
 *
 * DAY — the same city at golden hour, and deliberately NOT the night rig turned
 * up. A low warm sun casts long shadows, cool sky bounce fills the shade,
 * bloom is all but switched off (nothing semantic is allowed to glow, because
 * a glow is invisible against a bright sky), and tone mapping moves from ACES
 * to Khronos PBR Neutral — ACES at a daylight exposure washes saturated colour into
 * pastel, which is precisely the failure this mode exists to avoid. Structure
 * is cel-shaded by core/theme.ts and outlined in ink. See core/themes.ts.
 *
 * COLOUR PIPELINE — the part everybody gets wrong.
 *   Direct path ('low' night): renderer.render() draws to the default framebuffer,
 *     so WebGLRenderer applies ACES tone mapping + sRGB encode itself. Correct.
 *   Composer path: RenderPass draws into a HalfFloat render target. When the
 *     current render target is not null, WebGLRenderer forces NoToneMapping and
 *     LinearSRGB output (see WebGLPrograms / getParameters: `toneMapping` is
 *     only taken from the renderer when `_currentRenderTarget === null`). So the
 *     buffer stays linear HDR — which is exactly what UnrealBloomPass needs to
 *     threshold against — and OutputPass at the end of the chain re-reads
 *     renderer.toneMapping / toneMappingExposure / outputColorSpace and applies
 *     them once. Daylight's lift/gamma/gain, saturation curve and vignette are
 *     fused into that OutputPass, so the grade adds no second fullscreen pass.
 *   Consequence: the SAME renderer settings are valid on both paths. Never
 *   toggle renderer.toneMapping when switching quality.
 * ==========================================================================*/

export interface RendererApi {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  /** Live object — mutated in place by setQuality so consumers can hold a ref. */
  quality: QualitySettings
  dom: HTMLCanvasElement
  /** Smoothed frames per second. */
  readonly fps: number
  /**
   * `dt` is the clamped delta used for animation; `rawDt` is real wall-clock
   * time and is what the fps readout and the adaptive-quality timers measure.
   */
  render(dt: number, rawDt?: number): void
  resize(): void
  setQuality(level: QualityLevel): void
  dispose(): void
}

/* --------------------------------------------------------------------------
 * Quality presets.
 * ------------------------------------------------------------------------*/

const LEVELS: readonly QualityLevel[] = ['low', 'reduced', 'medium', 'high', 'ultra']

/** Device-pixel-ratio ceiling per level. Re-evaluated on every resize. */
const DPR_CAP: Record<QualityLevel, number> = {
  low: 1,
  reduced: 1,
  medium: 1.5,
  high: 2,
  ultra: 2,
}

function deviceDpr(): number {
  return typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
}
/** SMAA is a full extra pass — only worth it once we can afford shadows too. */
function wantsSmaa(level: QualityLevel): boolean {
  return level === 'high' || level === 'ultra'
}

export const QUALITY_PRESETS: Record<QualityLevel, QualitySettings> = {
  low: {
    level: 'low',
    pixelRatio: DPR_CAP.low,
    bloom: false,
    shadows: false,
    maxParticles: 700,
    maxLabels: 18,
    // No composer at 'low', so the default framebuffer is the only place AA
    // could happen — and 'low' exists precisely because we can't afford it.
    antialias: false,
  },
  reduced: {
    level: 'reduced',
    pixelRatio: DPR_CAP.reduced,
    bloom: true,
    shadows: false,
    maxParticles: 700,
    maxLabels: 18,
    antialias: false,
  },
  medium: {
    level: 'medium',
    pixelRatio: DPR_CAP.medium,
    bloom: true,
    shadows: false,
    maxParticles: 1500,
    maxLabels: 26,
    antialias: false,
  },
  high: {
    level: 'high',
    pixelRatio: DPR_CAP.high,
    bloom: true,
    shadows: true,
    maxParticles: 2600,
    maxLabels: 34,
    antialias: true,
  },
  ultra: {
    level: 'ultra',
    pixelRatio: DPR_CAP.ultra,
    bloom: true,
    shadows: true,
    maxParticles: 4200,
    maxLabels: 44,
    antialias: true,
  },
}

export interface FidelitySettings {
  environment: boolean
  /** Fraction of the drawing buffer used by the planar water pass. */
  reflectionScale: number
  ambientOcclusion: boolean
  /** Strength of the fused depth/height aerial perspective. */
  aerialPerspective: number
  /** Fraction of the device framebuffer used by GTAO's normal/depth buffers. */
  aoScale: number
  aoSamples: number
  aoDenoiseSamples: number
  shadowMapSize: number
  shadowRadius: number
}

/**
 * Fidelity is a separate ladder so low/reduced skip every optional texture
 * sample and scene pass added here.
 */
export const FIDELITY_PRESETS: Record<QualityLevel, FidelitySettings> = {
  low: {
    environment: false,
    reflectionScale: waterReflectionScale('low'),
    ambientOcclusion: false,
    aerialPerspective: 0,
    aoScale: 0,
    aoSamples: 0,
    aoDenoiseSamples: 0,
    shadowMapSize: 1024,
    shadowRadius: 1,
  },
  reduced: {
    environment: false,
    reflectionScale: waterReflectionScale('reduced'),
    ambientOcclusion: false,
    aerialPerspective: 0,
    aoScale: 0,
    aoSamples: 0,
    aoDenoiseSamples: 0,
    shadowMapSize: 1024,
    shadowRadius: 1,
  },
  medium: {
    environment: true,
    reflectionScale: waterReflectionScale('medium'),
    ambientOcclusion: true,
    aerialPerspective: 0.55,
    aoScale: 0.25,
    aoSamples: 3,
    aoDenoiseSamples: 4,
    shadowMapSize: 1024,
    shadowRadius: 1,
  },
  high: {
    environment: true,
    reflectionScale: waterReflectionScale('high'),
    ambientOcclusion: true,
    aerialPerspective: 0.82,
    aoScale: 0.35,
    aoSamples: 4,
    aoDenoiseSamples: 6,
    shadowMapSize: 1536,
    shadowRadius: 1.7,
  },
  ultra: {
    environment: true,
    reflectionScale: waterReflectionScale('ultra'),
    ambientOcclusion: true,
    aerialPerspective: 1,
    aoScale: 0.5,
    aoSamples: 6,
    aoDenoiseSamples: 8,
    shadowMapSize: 2048,
    shadowRadius: 2.5,
  },
}

/** Where we start before adaptive quality has an opinion. */
const DEFAULT_LEVEL: QualityLevel = 'high'

/* Adaptive-quality thresholds. */
const FPS_FLOOR = 45
const FPS_FLOOR_SECONDS = 3
const FPS_CEIL = 58
const FPS_CEIL_SECONDS = 12
const WARMUP_SECONDS = 3 // shader compilation + first-frame uploads: ignore
const SETTLE_SECONDS = 4 // grace period after any quality change

/* Bloom, the light rig, tone mapping and the sky all come from the palette
 * module now — one table per mode, in core/themes.ts. */
function toneMappingFor(a: Atmosphere): THREE.ToneMapping {
  return a.toneMapping === 'neutral' ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping
}

/* Module-scope scratch — nothing is allocated inside render(). */
const _size = new THREE.Vector2()
const AO_SCENE_BOX = new THREE.Box3(new THREE.Vector3(-540, -90, -430), new THREE.Vector3(540, 150, 430))

/** Existing GTAO samples, weighted for grounding without flattening night neon. */
export const AO_BLEND_INTENSITY = {
  night: 0.34,
  day: 0.9,
} as const

/**
 * The beauty pass already rasterises every opaque mesh and writes depth.
 * Reusing that texture avoids GTAOPass's otherwise redundant normal/depth
 * scene render; screen-space normals are reconstructed from depth instead.
 */
class ComposerDepthGTAOPass extends GTAOPass {
  sceneDepthTexture: THREE.DepthTexture | null = null

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    const depth = readBuffer.depthTexture as THREE.DepthTexture | null
    this.sceneDepthTexture = depth
    if (depth && this.depthTexture !== depth) this.setGBuffer(depth)
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive)
  }
}

export function createRenderer(container: HTMLElement, bus: Bus): RendererApi {
  const quality: QualitySettings = { ...QUALITY_PRESETS[DEFAULT_LEVEL] }
  let air: Atmosphere = atmosphere()

  /* ---- renderer ---------------------------------------------------------*/

  const renderer = new THREE.WebGLRenderer({
    // The default framebuffer is the low-tier path, so keep its context cheap.
    // High tiers get SMAA in the composer instead.
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
    alpha: false,
    logarithmicDepthBuffer: false,
  })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = toneMappingFor(air)
  renderer.toneMappingExposure = air.exposure
  renderer.setClearColor(COLOR.bg, 1)
  // PCFSoft is deprecated in r185 and silently substituted with PCF — ask for
  // what we actually get, so the console stays clean and the code stays honest.
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.shadowMap.enabled = quality.shadows && air.shadows
  renderer.info.autoReset = true

  const dom = renderer.domElement
  dom.style.display = 'block'
  dom.style.touchAction = 'none'
  dom.style.outline = 'none'
  container.appendChild(dom)

  /* ---- scene & camera ---------------------------------------------------*/

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(COLOR.bg)
  // Distance dissolves onto the sky's own below-horizon haze, not onto a third
  // colour of its own; the ground plate then reads the same fog at air.plateFogScale.
  const fog = new THREE.Fog(air.fogColor, CITY.fog.near * air.fogNearScale, CITY.fog.far * air.fogFarScale)
  scene.fog = fog
  applyGroundAtmosphere(air)

  /*
   * The visible dome is also the lighting source. PMREM captures it six times
   * only when the sky model changes. Local-clock keys advance at most every
   * fifteen minutes (and not at all through deep night), then standard
   * materials sample the prefiltered result without another pass per frame.
   */
  const environmentScene = new THREE.Scene()
  const environmentBackground = new THREE.Color(COLOR.bg)
  environmentScene.background = environmentBackground
  let pmremGenerator: THREE.PMREMGenerator | null = null
  let environmentTarget: THREE.WebGLRenderTarget | null = null
  let environmentKey: string | null = null

  function applyEnvironmentIntensity(): void {
    // Day keeps the poster-flat cel bands; night gives glossy machinery enough
    // sky response to read without making matte structure luminous.
    scene.environmentIntensity = air.daylight ? 0.18 : 0.55
  }

  function refreshEnvironment(force = false): void {
    const fidelity = FIDELITY_PRESETS[quality.level]
    applyEnvironmentIntensity()
    if (!fidelity.environment) {
      scene.environment = null
      return
    }

    const sky = scene.getObjectByName('sky')
    if (!sky?.parent) return
    const targetKey = themeEnvironmentKey()
    if (!force && environmentTarget && environmentKey === targetKey) {
      scene.environment = environmentTarget.texture
      return
    }

    if (!pmremGenerator) pmremGenerator = new THREE.PMREMGenerator(renderer)
    environmentBackground.setHex(COLOR.bg)
    const parent = sky.parent
    environmentScene.add(sky)
    let nextTarget: THREE.WebGLRenderTarget
    try {
      nextTarget = pmremGenerator.fromScene(environmentScene, 0, 0.1, 2200)
    } finally {
      parent.add(sky)
    }
    nextTarget.texture.name = `pgsimcity.environment.${targetKey}`
    const previous = environmentTarget
    environmentTarget = nextTarget
    environmentKey = targetKey
    scene.environment = nextTarget.texture
    previous?.dispose()
  }

  const camera = new THREE.PerspectiveCamera(52, measureAspect(), 0.5, 4000)
  // Establishing shot: high above the plaza, looking north up the city axis.
  // engine/camera.ts takes over on its first update.
  camera.position.set(0, 205, 415)
  camera.lookAt(ANCHOR.cityCenter[0], ANCHOR.cityCenter[1], ANCHOR.cityCenter[2])

  /* ---- lighting rig -----------------------------------------------------*/

  // Sky/ground bounce. Cheap, and it keeps north-facing walls from going black.
  // In daylight it is doing most of the work: it is the cool ambient floor the toon
  // ramp's darkest band lands on, which is what stops cel shadows going to mud.
  const hemi = new THREE.HemisphereLight(air.hemiSky, air.hemiGround, air.hemiIntensity)
  scene.add(hemi)

  // Key: cold moonlight from high north-east at night, the low sun from the
  // north-west in daylight. Only the sun casts; night keeps its original render.
  const key = new THREE.DirectionalLight(air.keyColor, air.keyIntensity)
  key.position.set(air.keyPos[0], air.keyPos[1], air.keyPos[2])
  key.target.position.set(air.keyTarget[0], air.keyTarget[1], air.keyTarget[2])
  scene.add(key)
  scene.add(key.target)

  // Tiered maps, fitted to the actual built city rather than to the whole
  // Slonik plate. Medium keeps the original 1024² budget; high and ultra spend
  // their headroom on 1536² and 2048² with a progressively softer penumbra.
  const sc = key.shadow.camera
  const initialFidelity = FIDELITY_PRESETS[quality.level]
  key.shadow.mapSize.set(initialFidelity.shadowMapSize, initialFidelity.shadowMapSize)
  key.shadow.radius = initialFidelity.shadowRadius
  key.shadow.bias = air.shadowBias
  key.shadow.normalBias = air.shadowNormalBias
  key.shadow.intensity = air.shadowIntensity
  key.castShadow = quality.shadows && air.shadows

  const shadowPoint = new THREE.Vector3()
  const shadowLo = new THREE.Vector3(-330, -78, -390)
  const shadowHi = new THREE.Vector3(330, 118, 370)

  /* ---------------------------------------------------------------------
   * ONE ADAPTIVE CASCADE.
   *
   * Fitted to the whole city, a 1024² map is 1.02 m per texel: a gantry beam,
   * a cornice, a parapet and a walkway rail all cast nothing at all, and the
   * only shadows on a wall are soft grey blobs with no relationship to any
   * object. Fitting it to what the CAMERA can see instead costs the same 171
   * caster draws and gets to about 12 cm per texel at street range, which is
   * where a beam finally casts a beam-shaped shadow.
   *
   * Three things keep that from costing frames. The whole mechanism is inert
   * unless key.castShadow is on, which is high and ultra only. The centre is
   * snapped to the shadow map's own texel grid, without which the shadows
   * crawl over every static surface as the camera moves. And the refit — and
   * with it the extra shadow pass — only happens when that snapped centre
   * actually changes, so a camera standing still pays nothing.
   * -------------------------------------------------------------------*/

  /** Half-width, in metres, of the box the near cascade covers. */
  const NEAR_SPAN_MIN = 90
  const NEAR_SPAN_MAX = 300
  /** Above this eye height the city box is already dense enough; stop paying. */
  const NEAR_SPAN_CEILING = 340

  const shadowFwd = new THREE.Vector3()
  const shadowFocus = new THREE.Vector3()
  const shadowSnapped = new THREE.Vector3(Infinity, Infinity, Infinity)
  let shadowSpan = 0

  function fitShadowCamera(cx = 0, cz = 0, span = 0): void {
    // Mirror DirectionalLightShadow.updateMatrices() so the fit is expressed in
    // the shadow camera's own axes. With no span the box covers every district,
    // including the excavation floor, and excludes the empty plate lobes.
    sc.position.copy(key.position)
    sc.lookAt(key.target.position)
    sc.updateMatrixWorld(true)
    sc.matrixWorldInverse.copy(sc.matrixWorld).invert()

    const lox = span > 0 ? cx - span : shadowLo.x
    const hix = span > 0 ? cx + span : shadowHi.x
    const loz = span > 0 ? cz - span : shadowLo.z
    const hiz = span > 0 ? cz + span : shadowHi.z

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    let minD = Infinity
    let maxD = -Infinity
    for (let ix = 0; ix < 2; ix++) {
      for (let iy = 0; iy < 2; iy++) {
        for (let iz = 0; iz < 2; iz++) {
          shadowPoint
            .set(ix ? hix : lox, iy ? shadowHi.y : shadowLo.y, iz ? hiz : loz)
            .applyMatrix4(sc.matrixWorldInverse)
          minX = Math.min(minX, shadowPoint.x)
          maxX = Math.max(maxX, shadowPoint.x)
          minY = Math.min(minY, shadowPoint.y)
          maxY = Math.max(maxY, shadowPoint.y)
          const depth = -shadowPoint.z
          minD = Math.min(minD, depth)
          maxD = Math.max(maxD, depth)
        }
      }
    }
    sc.left = minX - 18
    sc.right = maxX + 18
    sc.bottom = minY - 24
    sc.top = maxY + 24
    // The near plane still has to start behind the tallest caster outside the
    // box, or a tower just off screen stops shadowing the street inside it.
    sc.near = Math.max(1, minD - 260)
    sc.far = maxD + 70
    sc.updateProjectionMatrix()
  }

  /** Re-aim the cascade at what the camera is looking at. Cheap when still. */
  function updateShadowFit(): void {
    if (!key.castShadow) return

    const eye = Math.max(2, camera.position.y)
    if (eye > NEAR_SPAN_CEILING) {
      if (shadowSpan === 0) return
      shadowSpan = 0
      shadowSnapped.set(Infinity, Infinity, Infinity)
      key.shadow.normalBias = air.shadowNormalBias
      fitShadowCamera()
      renderer.shadowMap.needsUpdate = true
      return
    }

    camera.getWorldDirection(shadowFwd)
    // Where the eye is actually pointed: the ground hit when it looks down,
    // and a fixed reach ahead when it does not.
    const reach = shadowFwd.y < -0.02 ? Math.min(eye / -shadowFwd.y, 420) : 220
    shadowFocus.copy(camera.position).addScaledVector(shadowFwd, reach * 0.6)

    /* Quantised. An un-stepped span changes on every frame the camera moves at
     * all, and each change is a full extra shadow pass. */
    const wanted = clamp(Math.max(eye * 1.6, reach * 0.75), NEAR_SPAN_MIN, NEAR_SPAN_MAX)
    const span = Math.min(NEAR_SPAN_MAX, Math.ceil(wanted / 30) * 30)
    // Snap to the texel the map will actually sample, or every static shadow
    // in the scene crawls as the camera walks.
    const texel = (span * 2) / key.shadow.mapSize.x
    const sx = Math.round(shadowFocus.x / texel) * texel
    const sz = Math.round(shadowFocus.z / texel) * texel

    if (sx === shadowSnapped.x && sz === shadowSnapped.z && span === shadowSpan) return
    shadowSnapped.set(sx, 0, sz)
    shadowSpan = span
    /* Normal bias is measured in world units and is only ever there to push a
     * sample off its own surface by about a texel. The authored 0.45 is right
     * for the whole-city fit; leave it there under a cascade eight times
     * denser and every shadow detaches from the object casting it. */
    key.shadow.normalBias = Math.max(0.06, Math.min(air.shadowNormalBias, texel * 0.6))
    fitShadowCamera(sx, sz, span)
    renderer.shadowMap.needsUpdate = true
  }

  fitShadowCamera()

  // Fill: colder and from the south-west at night, sky bounce from behind at
  // daylight. No shadow either way — it only shapes the dark side.
  const fill = new THREE.DirectionalLight(air.fillColor, air.fillIntensity)
  fill.position.set(air.fillPos[0], air.fillPos[1], air.fillPos[2])
  fill.target.position.set(0, 0, 20)
  scene.add(fill)
  scene.add(fill.target)

  // District identity lights. decay = 1 (not physical): these are mood lights
  // covering a ~250-unit district, and inverse-square would make them invisible
  // at any intensity a human would type.
  const walGlow = new THREE.PointLight(0xffb03a, air.walGlow, 260, 1)
  walGlow.position.set(ANCHOR.walVault[0], 44, ANCHOR.walVault[2])
  scene.add(walGlow)

  const yardGlow = new THREE.PointLight(0xb57bff, air.yardGlow, 240, 1)
  yardGlow.position.set((ANCHOR.checkpointer[0] + ANCHOR.autovacLauncher[0]) / 2, 40, 12)
  scene.add(yardGlow)

  /* ---- post-processing --------------------------------------------------*/

  let composer: EffectComposer | null = null
  let renderPass: RenderPass | null = null
  let gtaoPass: ComposerDepthGTAOPass | null = null
  let lightShaftPass: LightShaftPass | null = null
  let bloomPass: UnrealBloomPass | null = null
  let smaaPass: SMAAPass | null = null
  let outputPass: GoldenHourOutputPass | null = null
  let composerDepthEnabled = false

  function buildComposer(): void {
    if (composer) return
    const w = viewW
    const h = viewH
    const pr = quality.pixelRatio

    const composerTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType),
    })
    composerTarget.texture.name = 'PGSimCity.composer.hdr'
    composerTarget.depthTexture!.name = 'PGSimCity.composer.depth'
    composer = new EffectComposer(renderer, composerTarget)
    composerDepthEnabled = true
    composer.setPixelRatio(pr)
    composer.setSize(w, h)

    renderPass = new RenderPass(scene, camera)
    composer.addPass(renderPass)

    gtaoPass = new ComposerDepthGTAOPass(scene, camera, 1, 1)
    gtaoPass.setSceneClipBox(AO_SCENE_BOX)
    gtaoPass.updateGtaoMaterial({
      radius: 0.28,
      distanceExponent: 1.5,
      thickness: 0.8,
      distanceFallOff: 0.7,
      scale: 3.2,
      screenSpaceRadius: true,
    })
    gtaoPass.updatePdMaterial({
      lumaPhi: 8,
      depthPhi: 3,
      normalPhi: 4,
      radius: 5,
      radiusExponent: 1.8,
      rings: 2,
    })
    composer.addPass(gtaoPass)

    lightShaftPass = new LightShaftPass(camera, gtaoPass)
    composer.addPass(lightShaftPass)

    // Half-resolution bloom chain: UnrealBloomPass halves again internally for
    // mip 0, so the blur runs at a quarter of the framebuffer. Bloom is a wide
    // soft signal; nobody can tell, and it is ~4x cheaper.
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.max(1, (w * pr) / 2), Math.max(1, (h * pr) / 2)),
      air.bloomStrength,
      air.bloomRadius,
      air.bloomThreshold,
    )
    composer.addPass(bloomPass)

    // SMAAPass takes no constructor args in r185 and MUST run before OutputPass:
    // it expects linear-srgb input.
    smaaPass = new SMAAPass()
    composer.addPass(smaaPass)

    // Day grade, tone mapping and colour conversion happen here, exactly once.
    outputPass = new GoldenHourOutputPass(camera, gtaoPass)
    composer.addPass(outputPass)

    applyPassToggles()
    sizeBloom()
    sizeAmbientOcclusion()
  }

  function applyPassToggles(): void {
    const fidelity = FIDELITY_PRESETS[quality.level]
    const shaftsEnabled = air.daylight && LIGHT_SHAFT_PRESETS[quality.level].scale > 0
    if (gtaoPass) {
      configureComposerDepth(fidelity.ambientOcclusion || shaftsEnabled)
      gtaoPass.enabled = fidelity.ambientOcclusion
      // AO is a solidity cue, not a new night-time black channel. Keeping the
      // night blend restrained preserves neon value and its bloom threshold.
      gtaoPass.blendIntensity = air.daylight ? AO_BLEND_INTENSITY.day : AO_BLEND_INTENSITY.night
      if (fidelity.ambientOcclusion) {
        gtaoPass.updateGtaoMaterial({ samples: fidelity.aoSamples })
        gtaoPass.updatePdMaterial({ samples: fidelity.aoDenoiseSamples })
      }
    }
    if (lightShaftPass) {
      const x = air.keyPos[0] - air.keyTarget[0]
      const y = air.keyPos[1] - air.keyTarget[1]
      const z = air.keyPos[2] - air.keyTarget[2]
      lightShaftPass.setSunDirection(x, y, z)
      lightShaftPass.setAtmosphere(air.skyGlow, fog.near)
      lightShaftPass.setQuality(quality.level, air.daylight)
    }
    if (bloomPass) {
      bloomPass.enabled = quality.bloom && air.bloomEnabled
      bloomPass.strength = air.bloomStrength
      bloomPass.radius = air.bloomRadius
      bloomPass.threshold = air.bloomThreshold
    }
    if (smaaPass) smaaPass.enabled = wantsSmaa(quality.level)
    if (outputPass) {
      outputPass.setDaylight(air.daylight)
      outputPass.setAerialPerspective(
        air.fogColor,
        air.heightFogDensity,
        air.heightFogFalloff,
        fidelity.aerialPerspective,
      )
    }
  }

  /**
   * Depth textures are an AO and shaft-occlusion input, not a tax on the
   * composer. Restore depth renderbuffers when both effects are tiered off.
   */
  function configureComposerDepth(enabled: boolean): void {
    if (!composer || enabled === composerDepthEnabled) return
    const targets = [composer.renderTarget1, composer.renderTarget2]
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]
      target.dispose()
      target.depthTexture = enabled
        ? new THREE.DepthTexture(target.width, target.height, THREE.UnsignedIntType)
        : null
      if (target.depthTexture) target.depthTexture.name = `PGSimCity.composer.depth${i + 1}`
    }
    composerDepthEnabled = enabled
  }

  /**
   * At night the WAL vault and the maintenance yard are lit almost entirely by
   * emissive neon, and their form is carried by the bloom halo around it. 'low'
   * drops the whole post chain, which is right for a weak GPU but leaves those
   * districts as near-black silhouettes. Paying it back with real lights costs
   * nothing. In daylight there is no halo to lose, so the compensation is only the
   * half-stop of hemisphere that the (barely-there) bloom would have added.
   */
  function applyLightCompensation(): void {
    const noBloom = !quality.bloom
    hemi.intensity = noBloom ? air.noBloomHemi : air.hemiIntensity
    fill.intensity = noBloom ? air.noBloomFill : air.fillIntensity
    walGlow.intensity = noBloom ? air.noBloomWalGlow : air.walGlow
    yardGlow.intensity = noBloom ? air.noBloomYardGlow : air.yardGlow
  }

  /* ---- light modes ------------------------------------------------------*/

  function paintObject(obj: THREE.Object3D, target: ThemeMode): void {
    const flags = obj.userData as {
      pgDayOnly?: boolean
      pgNoShadow?: boolean
      pgShadowReceiver?: boolean
    }
    if (flags.pgDayOnly) obj.visible = air.daylight

    // The sky owns custom shader uniforms; district material translation must
    // never reinterpret its colors. applySkyAtmosphere handles every child.
    if (obj.name.startsWith('sky.')) return
    const m = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
    if (!m) return
    if (Array.isArray(m)) {
      for (let i = 0; i < m.length; i++) paintSceneMaterial(m[i], target)
    } else {
      paintSceneMaterial(m, target)
    }

    const mesh = obj as THREE.Mesh
    if (mesh.isMesh !== true) return
    const materials = Array.isArray(m) ? m : [m]
    const standard = materials.some((mat) => {
      const sm = mat as THREE.MeshStandardMaterial
      return sm.isMeshStandardMaterial === true && !sm.transparent && sm.opacity >= 0.99
    })
    const count = (mesh as THREE.InstancedMesh).isInstancedMesh === true ? (mesh as THREE.InstancedMesh).count : 1
    const day = air.daylight && air.shadows
    // Large state fields (notably the 1,024 buffer frames) carry meaning through
    // colour. Letting every cell cast turns the zone into a dark checkerboard
    // and spends the shadow budget on noise instead of architectural massing.
    mesh.castShadow = day && standard && count <= 256 && !flags.pgNoShadow
    mesh.receiveShadow =
      day &&
      (standard || flags.pgShadowReceiver === true || (materials[0] as THREE.ShadowMaterial).isShadowMaterial === true)
  }

  /**
   * Swap the whole rendering model. Nothing is rebuilt: the palette module has
   * already repainted every cached material in place, and this walks the scene
   * once for the materials the cache never saw — the ground plate's shader
   * uniforms, the pit, the light cones, every district's own ad-hoc material.
   * The walk captures each material's authored night value on first sight, so
   * it is exact in both directions and idempotent.
   */
  function applyThemeMode(target: ThemeMode): void {
    air = atmosphere()

    renderer.toneMapping = toneMappingFor(air)
    renderer.toneMappingExposure = air.exposure
    renderer.setClearColor(COLOR.bg, 1)
    if (scene.background instanceof THREE.Color) scene.background.setHex(COLOR.bg)

    fog.color.setHex(air.fogColor)
    fog.near = CITY.fog.near * air.fogNearScale
    fog.far = CITY.fog.far * air.fogFarScale
    applyGroundAtmosphere(air)

    hemi.color.setHex(air.hemiSky)
    hemi.groundColor.setHex(air.hemiGround)

    key.color.setHex(air.keyColor)
    key.position.set(air.keyPos[0], air.keyPos[1], air.keyPos[2])
    key.target.position.set(air.keyTarget[0], air.keyTarget[1], air.keyTarget[2])
    key.target.updateMatrixWorld()
    // The sun moves between modes, so the cascade's cached aim is stale.
    shadowSpan = 0
    shadowSnapped.set(Infinity, Infinity, Infinity)
    fitShadowCamera()
    key.shadow.bias = air.shadowBias
    key.shadow.normalBias = air.shadowNormalBias
    key.shadow.intensity = air.shadowIntensity

    fill.color.setHex(air.fillColor)
    fill.position.set(air.fillPos[0], air.fillPos[1], air.fillPos[2])
    fill.target.updateMatrixWorld()

    applyLightCompensation()
    applyPassToggles()

    const sky = scene.getObjectByName('sky')
    if (sky) applySkyAtmosphere(sky, air, quality.level)
    scene.traverse((obj) => paintObject(obj, target))
    applyShadowRenderer()
    renderer.shadowMap.needsUpdate = true
    refreshEnvironment()
  }

  const offTheme = onThemeMode(applyThemeMode)
  const offClock = startThemeClock()

  /** Bloom runs at half the composer's device resolution; call after setSize. */
  function sizeBloom(): void {
    if (!bloomPass) return
    const w = Math.max(1, Math.round((viewW * quality.pixelRatio) / 2))
    const h = Math.max(1, Math.round((viewH * quality.pixelRatio) / 2))
    bloomPass.resolution.set(w, h)
    bloomPass.setSize(w, h)
  }

  /** GTAO is deliberately sub-resolution; its bilateral denoise restores edges. */
  function sizeAmbientOcclusion(): void {
    if (!gtaoPass) return
    const scale = FIDELITY_PRESETS[quality.level].aoScale
    const w = Math.max(1, Math.round(viewW * quality.pixelRatio * Math.max(scale, 0.01)))
    const h = Math.max(1, Math.round(viewH * quality.pixelRatio * Math.max(scale, 0.01)))
    gtaoPass.setSize(w, h)
  }

  /** Low night keeps its exact direct path; daylight pays one fused output pass. */
  function useComposer(): boolean {
    return quality.level !== 'low' || air.daylight
  }

  /* ---- sizing -----------------------------------------------------------*/

  let viewW = 1
  let viewH = 1
  let lastDpr = deviceDpr()

  function measureAspect(): number {
    const w = container.clientWidth || window.innerWidth || 1
    const h = container.clientHeight || window.innerHeight || 1
    return w / h
  }

  function resize(): void {
    // A hidden or unstyled container reports 0 — fall back to the viewport
    // rather than building 0x0 render targets.
    const w = Math.max(1, Math.floor(container.clientWidth || window.innerWidth || 1))
    const h = Math.max(1, Math.floor(container.clientHeight || window.innerHeight || 1))
    const dpr = deviceDpr()

    quality.pixelRatio = Math.min(DPR_CAP[quality.level], dpr)

    renderer.getSize(_size)
    const unchanged =
      w === viewW && h === viewH && _size.x === w && _size.y === h && renderer.getPixelRatio() === quality.pixelRatio
    if (unchanged) {
      lastDpr = dpr
      return
    }

    viewW = w
    viewH = h
    lastDpr = dpr

    camera.aspect = w / h
    camera.updateProjectionMatrix()

    renderer.setPixelRatio(quality.pixelRatio)
    renderer.setSize(w, h, true)

    if (composer) {
      composer.setPixelRatio(quality.pixelRatio)
      composer.setSize(w, h)
      sizeBloom() // must follow composer.setSize — it overwrites every pass size
      sizeAmbientOcclusion()
    }
  }

  /* ---- adaptive quality -------------------------------------------------*/

  let fps = 60
  let elapsed = 0
  let settleT = 0
  let slowT = 0
  let fastT = 0
  let autoDowngrades = 0
  let autoUpgrades = 0
  let manualOverride = false
  /** Downgrades spent after the user picked a level by hand. Capped at one. */
  let courtesyDowngrades = 0

  function levelIndex(l: QualityLevel): number {
    const i = LEVELS.indexOf(l)
    return i < 0 ? 2 : i
  }

  function applyQuality(level: QualityLevel): void {
    const preset = QUALITY_PRESETS[level]
    quality.level = preset.level
    quality.bloom = preset.bloom
    quality.shadows = preset.shadows
    quality.maxParticles = preset.maxParticles
    quality.maxLabels = preset.maxLabels
    quality.antialias = preset.antialias
    quality.pixelRatio = Math.min(DPR_CAP[level], deviceDpr())
    scene.userData.boxBevel = applyBoxBevelDetail(scene, level)
    const sky = scene.getObjectByName('sky')
    if (sky) applySkyAtmosphere(sky, air, level)
    applyFidelityQuality()

    // Shadow maps: toggling shadowMap.enabled changes shader defines, so every
    // material in the scene has to be recompiled. Once per quality change only.
    applyShadowRenderer()

    if (useComposer()) buildComposer()
    applyPassToggles()
    applyLightCompensation()
    if (setBloomAvailable(quality.bloom)) {
      scene.traverse((obj) => paintObject(obj, themeMode()))
    }

    // Force a full re-size so pixel ratio / composer targets follow the level.
    viewW = -1
    resize()
    refreshEnvironment()

    settleT = 0
    slowT = 0
    fastT = 0
  }

  function invalidateMaterials(): void {
    scene.traverse(markMaterialDirty)
  }

  function applyFidelityQuality(): void {
    const fidelity = FIDELITY_PRESETS[quality.level]
    const sizeChanged = key.shadow.mapSize.x !== fidelity.shadowMapSize
    if (sizeChanged) {
      key.shadow.mapSize.set(fidelity.shadowMapSize, fidelity.shadowMapSize)
      if (key.shadow.map) {
        key.shadow.map.dispose()
        key.shadow.map = null
      }
    }
    key.shadow.radius = fidelity.shadowRadius
  }

  function applyShadowRenderer(): void {
    const enabled = quality.shadows && air.shadows
    const changed = renderer.shadowMap.enabled !== enabled
    renderer.shadowMap.enabled = enabled
    key.castShadow = enabled
    if (changed) invalidateMaterials()
    renderer.shadowMap.needsUpdate = true
  }

  function markMaterialDirty(obj: THREE.Object3D): void {
    const mesh = obj as THREE.Mesh
    const m = mesh.material as THREE.Material | THREE.Material[] | undefined
    if (!m) return
    if (Array.isArray(m)) {
      for (let i = 0; i < m.length; i++) m[i].needsUpdate = true
    } else {
      m.needsUpdate = true
    }
  }

  function setQuality(level: QualityLevel): void {
    manualOverride = true
    courtesyDowngrades = 0
    if (level === quality.level) return
    applyQuality(level)
    bus.emit('quality', { level })
  }

  function stepDown(): void {
    const i = levelIndex(quality.level)
    if (i <= 0) return
    const previous = quality.level
    const next = LEVELS[i - 1]
    const losesBloom = quality.bloom && !QUALITY_PRESETS[next].bloom
    const preset = QUALITY_PRESETS[next]
    const reductions: string[] = []
    if (preset.pixelRatio < quality.pixelRatio) reductions.push('render scale')
    if (preset.maxParticles < quality.maxParticles) reductions.push('particles')
    if (preset.maxLabels < quality.maxLabels) reductions.push('labels')
    if (quality.antialias && !preset.antialias) reductions.push('antialiasing')
    if (quality.shadows && !preset.shadows) reductions.push('shadows')
    autoDowngrades++
    applyQuality(next)
    bus.emit('quality', { level: next })
    bus.emit('toast', {
      text: losesBloom
        ? 'Frame rate stayed low — bloom lighting disabled. Bright-colour fallback is active.'
        : `Frame rate stayed low — reduced ${reductions.join(', ')}; quality is now ${next}.`,
      kind: 'warn',
      ms: 7000,
      action: { label: `Restore ${previous}`, quality: previous },
    })
  }

  function stepUp(): void {
    const i = levelIndex(quality.level)
    if (i >= LEVELS.length - 1) return
    const next = LEVELS[i + 1]
    autoUpgrades++
    applyQuality(next)
    bus.emit('quality', { level: next })
    bus.emit('toast', { text: `Headroom available — graphics quality raised to ${next}.`, kind: 'good', ms: 3200 })
  }

  function adapt(dt: number): void {
    elapsed += dt
    settleT += dt
    if (elapsed < WARMUP_SECONDS || settleT < SETTLE_SECONDS) return

    if (fps < FPS_FLOOR) {
      slowT += dt
      fastT = 0
    } else if (fps > FPS_CEIL) {
      fastT += dt
      slowT = 0
    } else {
      slowT = 0
      fastT = 0
    }

    if (slowT >= FPS_FLOOR_SECONDS && quality.level !== 'low') {
      // An explicit choice from the top bar gets one courtesy rescue, then we
      // stop and leave the user in charge of their own machine.
      if (manualOverride && courtesyDowngrades >= 1) {
        slowT = 0
        return
      }
      if (manualOverride) courtesyDowngrades++
      stepDown()
      return
    }
    // Climb back at most once, and only out of a hole we dug ourselves — this is
    // what stops the classic quality oscillation.
    if (
      fastT >= FPS_CEIL_SECONDS &&
      autoDowngrades > 0 &&
      autoUpgrades < 1 &&
      !manualOverride &&
      levelIndex(quality.level) < levelIndex(DEFAULT_LEVEL)
    ) {
      stepUp()
    }
  }

  /* ---- frame ------------------------------------------------------------*/

  /**
   * The remembered theme is restored on the first frame, not at construction:
   * this is the first moment at which every district is in the scene graph, and
   * it is still before anything has been presented, so a viewer who chose
   * daylight never sees a frame of night.
   */
  let themeRestored = false

  function render(dt: number, rawDt?: number): void {
    if (!themeRestored) {
      themeRestored = true
      applyStoredThemeMode()
      refreshEnvironment()
    }
    const d = clamp(dt, 1 / 1000, 0.25)
    // The fps readout and the adapt timers run on real time, not on the delta
    // the simulation was given. A machine drawing 1 frame a second must be able
    // to say so — clamping here is what used to floor the readout at 10 fps.
    // The upper bound only exists so a tab-switch or a breakpoint cannot poison
    // the estimate with a multi-second gap.
    const real = clamp(rawDt ?? dt, 1 / 1000, 4)
    fps = damp(fps, 1 / real, 2.5, Math.min(real, 0.5))

    updateShadowFit()

    if (useComposer() && composer) composer.render(d)
    else renderer.render(scene, camera)

    adapt(Math.min(real, 1))
  }

  /* ---- context loss -----------------------------------------------------*/

  function onContextLost(e: Event): void {
    // preventDefault() is what allows the browser to hand the context back.
    e.preventDefault()
    bus.emit('toast', { text: 'WebGL context lost — restoring the city…', kind: 'warn', ms: 6000 })
  }

  function onContextRestored(): void {
    renderer.shadowMap.enabled = quality.shadows && air.shadows
    key.castShadow = renderer.shadowMap.enabled
    renderer.shadowMap.needsUpdate = true
    invalidateMaterials()
    viewW = -1
    resize()
    bus.emit('toast', { text: 'WebGL context restored.', kind: 'good', ms: 2600 })
  }

  /* ---- listeners --------------------------------------------------------*/

  function onWindowResize(): void {
    resize()
  }

  let ro: ResizeObserver | null = null
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(onWindowResize)
    ro.observe(container)
  }
  window.addEventListener('resize', onWindowResize, { passive: true })
  dom.addEventListener('webglcontextlost', onContextLost, false)
  dom.addEventListener('webglcontextrestored', onContextRestored, false)

  // devicePixelRatio changes (browser zoom, drag to a second monitor) do not
  // always fire a resize event; a resolution media query does.
  let dprMedia: MediaQueryList | null = null
  function onDprChange(): void {
    if (deviceDpr() !== lastDpr) {
      viewW = -1
      resize()
    }
    watchDpr()
  }
  function watchDpr(): void {
    if (dprMedia) dprMedia.removeEventListener('change', onDprChange)
    dprMedia = null
    try {
      dprMedia = window.matchMedia(`(resolution: ${deviceDpr()}dppx)`)
      dprMedia.addEventListener('change', onDprChange)
    } catch {
      dprMedia = null
    }
  }
  watchDpr()

  /* ---- boot -------------------------------------------------------------*/

  // Size first (so the composer's render targets are born at the right size),
  // then apply the starting preset — which builds the chain and re-sizes.
  resize()
  applyQuality(quality.level)

  /* ---- teardown ---------------------------------------------------------*/

  function dispose(): void {
    offTheme()
    offClock()
    window.removeEventListener('resize', onWindowResize)
    dom.removeEventListener('webglcontextlost', onContextLost)
    dom.removeEventListener('webglcontextrestored', onContextRestored)
    if (ro) {
      ro.disconnect()
      ro = null
    }
    if (dprMedia) {
      dprMedia.removeEventListener('change', onDprChange)
      dprMedia = null
    }

    if (bloomPass) bloomPass.dispose()
    if (gtaoPass) gtaoPass.dispose()
    if (lightShaftPass) lightShaftPass.dispose()
    if (smaaPass) smaaPass.dispose()
    if (outputPass) outputPass.dispose()
    if (composer) composer.dispose()
    composer = null
    composerDepthEnabled = false
    renderPass = null
    gtaoPass = null
    lightShaftPass = null
    bloomPass = null
    smaaPass = null
    outputPass = null

    scene.environment = null
    environmentTarget?.dispose()
    environmentTarget = null
    pmremGenerator?.dispose()
    pmremGenerator = null

    if (key.shadow.map) {
      key.shadow.map.dispose()
      key.shadow.map = null
    }
    scene.remove(hemi, key, key.target, fill, fill.target, walGlow, yardGlow)
    hemi.dispose()
    key.dispose()
    fill.dispose()
    walGlow.dispose()
    yardGlow.dispose()

    renderer.dispose()
    if (dom.parentNode) dom.parentNode.removeChild(dom)
  }

  return {
    renderer,
    scene,
    camera,
    quality,
    dom,
    get fps() {
      return fps
    },
    render,
    resize,
    setQuality,
    dispose,
  }
}
