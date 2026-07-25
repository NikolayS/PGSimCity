import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { COLOR } from '../core/theme'
import { clamp, damp } from '../core/util'
import { ANCHOR, CITY } from '../world/layout'
import type { Bus, QualityLevel, QualitySettings } from '../core/types'

/* ============================================================================
 * THE RENDERER
 *
 * Night city, lit by its own data. Structure is matte PBR lit by a cold key +
 * fill; meaning is neon (toneMapped:false, emissive > 1) and is the only thing
 * that clears the bloom threshold.
 *
 * COLOUR PIPELINE — the part everybody gets wrong.
 *   Direct path ('low'): renderer.render() draws to the default framebuffer, so
 *     WebGLRenderer applies ACES tone mapping + sRGB encode itself. Correct.
 *   Composer path: RenderPass draws into a HalfFloat render target. When the
 *     current render target is not null, WebGLRenderer forces NoToneMapping and
 *     LinearSRGB output (see WebGLPrograms / getParameters: `toneMapping` is
 *     only taken from the renderer when `_currentRenderTarget === null`). So the
 *     buffer stays linear HDR — which is exactly what UnrealBloomPass needs to
 *     threshold against — and OutputPass at the end of the chain re-reads
 *     renderer.toneMapping / toneMappingExposure / outputColorSpace and applies
 *     them once. Nothing is double-applied, nothing is washed out.
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
  render(dt: number): void
  resize(): void
  setQuality(level: QualityLevel): void
  dispose(): void
}

/* --------------------------------------------------------------------------
 * Quality presets.
 * ------------------------------------------------------------------------*/

const LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high', 'ultra']

/** Device-pixel-ratio ceiling per level. Re-evaluated on every resize. */
const DPR_CAP: Record<QualityLevel, number> = { low: 1, medium: 1.5, high: 2, ultra: 2 }

function deviceDpr(): number {
  return typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
}
function dprFor(level: QualityLevel): number {
  return Math.min(DPR_CAP[level], deviceDpr())
}
/** SMAA is a full extra pass — only worth it once we can afford shadows too. */
function wantsSmaa(level: QualityLevel): boolean {
  return level === 'high' || level === 'ultra'
}

export const QUALITY_PRESETS: Record<QualityLevel, QualitySettings> = {
  low: {
    level: 'low',
    pixelRatio: dprFor('low'),
    bloom: false,
    shadows: false,
    maxParticles: 700,
    maxLabels: 18,
    // No composer at 'low', so the default framebuffer is the only place AA
    // could happen — and 'low' exists precisely because we can't afford it.
    antialias: false,
  },
  medium: {
    level: 'medium',
    pixelRatio: dprFor('medium'),
    bloom: true,
    shadows: false,
    maxParticles: 1500,
    maxLabels: 26,
    antialias: true,
  },
  high: {
    level: 'high',
    pixelRatio: dprFor('high'),
    bloom: true,
    shadows: true,
    maxParticles: 2600,
    maxLabels: 34,
    antialias: true,
  },
  ultra: {
    level: 'ultra',
    pixelRatio: dprFor('ultra'),
    bloom: true,
    shadows: true,
    maxParticles: 4200,
    maxLabels: 44,
    antialias: true,
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

/* Bloom tuning — high threshold so ONLY neon (emissive > 1) blooms. */
const BLOOM_STRENGTH = 0.62
const BLOOM_RADIUS = 0.55
const BLOOM_THRESHOLD = 0.85

/* Module-scope scratch — nothing is allocated inside render(). */
const _size = new THREE.Vector2()

export function createRenderer(container: HTMLElement, bus: Bus): RendererApi {
  const quality: QualitySettings = { ...QUALITY_PRESETS[DEFAULT_LEVEL] }

  /* ---- renderer ---------------------------------------------------------*/

  const renderer = new THREE.WebGLRenderer({
    antialias: quality.antialias,
    powerPreference: 'high-performance',
    stencil: false,
    alpha: false,
    logarithmicDepthBuffer: false,
  })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.06
  renderer.setClearColor(COLOR.bg, 1)
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.shadowMap.enabled = quality.shadows
  renderer.info.autoReset = true

  const dom = renderer.domElement
  dom.style.display = 'block'
  dom.style.touchAction = 'none'
  dom.style.outline = 'none'
  container.appendChild(dom)

  /* ---- scene & camera ---------------------------------------------------*/

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(COLOR.bg)
  scene.fog = new THREE.Fog(COLOR.fog, CITY.fog.near, CITY.fog.far)

  const camera = new THREE.PerspectiveCamera(52, measureAspect(), 0.5, 4000)
  // Establishing shot: high above the plaza, looking north up the city axis.
  // engine/camera.ts takes over on its first update.
  camera.position.set(0, 205, 415)
  camera.lookAt(ANCHOR.cityCenter[0], ANCHOR.cityCenter[1], ANCHOR.cityCenter[2])

  /* ---- lighting rig -----------------------------------------------------*/

  // Sky/ground bounce. Cheap, and it keeps north-facing walls from going black.
  const hemi = new THREE.HemisphereLight(0x2a4a7a, 0x05070c, 0.55)
  scene.add(hemi)

  // Key: cold moonlight from high north-east. Casts the only shadow in the city.
  const key = new THREE.DirectionalLight(0xa8c8ff, 1.15)
  key.position.set(322, 374, -196)
  key.target.position.set(0, 0, -35)
  scene.add(key)
  scene.add(key.target)

  // Shadow frustum is deliberately tight: it only has to cover the plaza and the
  // backend row (x ±150, z -160..90). Anything outside simply doesn't cast.
  const sc = key.shadow.camera
  sc.left = -200
  sc.right = 200
  sc.top = 185
  sc.bottom = -185
  sc.near = 200
  sc.far = 900
  sc.updateProjectionMatrix()
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.bias = -0.0006
  key.shadow.normalBias = 0.6
  key.castShadow = quality.shadows

  // Fill from the south-west: colder, no shadow, just shapes the dark side.
  const fill = new THREE.DirectionalLight(0x4a6fa5, 0.35)
  fill.position.set(-320, 168, 296)
  fill.target.position.set(0, 0, 20)
  scene.add(fill)
  scene.add(fill.target)

  // District identity lights. decay = 1 (not physical): these are mood lights
  // covering a ~250-unit district, and inverse-square would make them invisible
  // at any intensity a human would type.
  const walGlow = new THREE.PointLight(0xffb03a, 40, 260, 1)
  walGlow.position.set(ANCHOR.walVault[0], 44, ANCHOR.walVault[2])
  scene.add(walGlow)

  const yardGlow = new THREE.PointLight(0xb57bff, 26, 240, 1)
  yardGlow.position.set((ANCHOR.checkpointer[0] + ANCHOR.autovacLauncher[0]) / 2, 40, 12)
  scene.add(yardGlow)

  /* ---- post-processing --------------------------------------------------*/

  let composer: EffectComposer | null = null
  let renderPass: RenderPass | null = null
  let bloomPass: UnrealBloomPass | null = null
  let smaaPass: SMAAPass | null = null
  let outputPass: OutputPass | null = null

  function buildComposer(): void {
    if (composer) return
    const w = viewW
    const h = viewH
    const pr = quality.pixelRatio

    composer = new EffectComposer(renderer)
    composer.setPixelRatio(pr)
    composer.setSize(w, h)

    renderPass = new RenderPass(scene, camera)
    composer.addPass(renderPass)

    // Half-resolution bloom chain: UnrealBloomPass halves again internally for
    // mip 0, so the blur runs at a quarter of the framebuffer. Bloom is a wide
    // soft signal; nobody can tell, and it is ~4x cheaper.
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.max(1, (w * pr) / 2), Math.max(1, (h * pr) / 2)),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    )
    composer.addPass(bloomPass)

    // SMAAPass takes no constructor args in r185 and MUST run before OutputPass:
    // it expects linear-srgb input.
    smaaPass = new SMAAPass()
    composer.addPass(smaaPass)

    // Tone mapping + colour conversion happen here, exactly once.
    outputPass = new OutputPass()
    composer.addPass(outputPass)

    applyPassToggles()
    sizeBloom()
  }

  function applyPassToggles(): void {
    if (bloomPass) bloomPass.enabled = quality.bloom
    if (smaaPass) smaaPass.enabled = wantsSmaa(quality.level)
  }

  /** Bloom runs at half the composer's device resolution; call after setSize. */
  function sizeBloom(): void {
    if (!bloomPass) return
    const w = Math.max(1, Math.round((viewW * quality.pixelRatio) / 2))
    const h = Math.max(1, Math.round((viewH * quality.pixelRatio) / 2))
    bloomPass.resolution.set(w, h)
    bloomPass.setSize(w, h)
  }

  /** 'low' bypasses post-processing entirely. */
  function useComposer(): boolean {
    return quality.level !== 'low'
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

    // Shadow maps: toggling shadowMap.enabled changes shader defines, so every
    // material in the scene has to be recompiled. Once per quality change only.
    const shadowsChanged = renderer.shadowMap.enabled !== quality.shadows
    renderer.shadowMap.enabled = quality.shadows
    key.castShadow = quality.shadows
    if (shadowsChanged) {
      invalidateMaterials()
      renderer.shadowMap.needsUpdate = true
    }

    if (useComposer()) buildComposer()
    applyPassToggles()

    // Force a full re-size so pixel ratio / composer targets follow the level.
    viewW = -1
    resize()

    settleT = 0
    slowT = 0
    fastT = 0
  }

  function invalidateMaterials(): void {
    scene.traverse(markMaterialDirty)
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
    if (level === quality.level) return
    applyQuality(level)
    bus.emit('quality', { level })
  }

  function stepDown(): void {
    const i = levelIndex(quality.level)
    if (i <= 0) return
    const next = LEVELS[i - 1]
    autoDowngrades++
    applyQuality(next)
    bus.emit('quality', { level: next })
    bus.emit('toast', {
      text: `Frame rate low — graphics quality reduced to ${next}.`,
      kind: 'warn',
      ms: 4200,
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

  function render(dt: number): void {
    // Tab-switch / breakpoint deltas must not poison the fps estimate.
    const d = clamp(dt, 1 / 1000, 0.25)
    fps = damp(fps, 1 / d, 2.5, d)

    if (useComposer() && composer) composer.render(d)
    else renderer.render(scene, camera)

    adapt(d)
  }

  /* ---- context loss -----------------------------------------------------*/

  function onContextLost(e: Event): void {
    // preventDefault() is what allows the browser to hand the context back.
    e.preventDefault()
    bus.emit('toast', { text: 'WebGL context lost — restoring the city…', kind: 'warn', ms: 6000 })
  }

  function onContextRestored(): void {
    renderer.shadowMap.enabled = quality.shadows
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
    if (smaaPass) smaaPass.dispose()
    if (outputPass) outputPass.dispose()
    if (composer) composer.dispose()
    composer = null
    renderPass = null
    bloomPass = null
    smaaPass = null
    outputPass = null

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
