import * as THREE from 'three'
import type { ColorKey, MatOpts, TextTexOpts, ThemeApi } from './types'
import {
  ATMOSPHERE,
  DEFAULT_MODE,
  PALETTES,
  THEME_STORAGE_KEY,
  dayAccent,
  dayEmissive,
  dayInk,
  dayInkOpacity,
  dayNeonIntensity,
  daySurface,
  isNeutralExtreme,
  mix,
} from './themes'
import type { Atmosphere, ThemeMode } from './themes'

export type { Atmosphere, ThemeMode } from './themes'
export { ATMOSPHERE, DAY_PALETTE, NIGHT_PALETTE, PALETTES } from './themes'

/**
 * PGSimCity palette — LIVE. Two modes share one object.
 *
 * NIGHT (the default): the renderer uses ACESFilmic tone mapping and the bloom
 * pass runs with a high threshold, so *only* surfaces whose output exceeds ~1.0
 * will glow. Paint structure with `mat()` (PBR, no glow); paint meaning — data,
 * state, energy — with `neon()`.
 *
 * DAY: the same call sites, a different rendering model. `mat()` becomes light
 * warm stone under a stepped toon ramp lit by a real sun; `neon()` becomes a
 * flat poster fill that carries meaning without any glow, because bloom is off;
 * `line()` becomes the cartoon's ink. Nothing in src/world has to know.
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
export const COLOR: Record<ColorKey, number> = { ...PALETTES[DEFAULT_MODE] }

/* ============================================================================
 * MODE
 * ==========================================================================*/

function readStoredMode(): ThemeMode {
  try {
    if (typeof window === 'undefined') return DEFAULT_MODE
    const v = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (v === 'day' || v === 'night') return v
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
let mode: ThemeMode = DEFAULT_MODE

/** The viewer's remembered choice. Night unless they have asked for daylight. */
export function storedThemeMode(): ThemeMode {
  return readStoredMode()
}

/** The mode the city is painted in right now. */
export function themeMode(): ThemeMode {
  return mode
}

/** Light rig, tone mapping, fog and sky for the current mode. */
export function atmosphere(): Atmosphere {
  return ATMOSPHERE[mode]
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

function applyPalette(m: ThemeMode): void {
  const p = PALETTES[m]
  for (const key of Object.keys(p) as ColorKey[]) COLOR[key] = p[key]
}

function applyDocument(m: ThemeMode): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = m
  // A colour-scheme hint is what makes native form controls, scrollbars and the
  // browser's own overscroll background follow the city instead of fighting it.
  root.style.colorScheme = m === 'day' ? 'light' : 'dark'
}

/**
 * Switch the whole city between night and day.
 *
 * No geometry is rebuilt and nothing is reloaded: the palette object is mutated
 * in place, every cached material is repainted from the value it was authored
 * with, and the renderer answers the same notification by swapping the light
 * rig, the tone mapping curve and the bloom settings. One frame, whole city.
 */
export function setThemeMode(next: ThemeMode, opts: { persist?: boolean } = {}): ThemeMode {
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
  return setThemeMode(mode === 'day' ? 'night' : 'day')
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
 * TOON SHADING
 *
 * Day mode needs a cel read, and it needs it on materials that already exist
 * and are already referenced by a thousand meshes — so swapping the class for
 * MeshToonMaterial is off the table. Instead the standard material's direct
 * lighting term is replaced at compile time: RE_Direct is redefined to a
 * three-band ramp, and the GGX lobe is clipped into a single hard highlight.
 *
 * The ramp edge is widened by fwidth(), so the terminator stays a clean curve
 * at every distance instead of stair-stepping across a roof. Shadows come for
 * free: lights_fragment_begin has already multiplied directLight.color by the
 * shadow term before RE_Direct sees it, so a shadowed face simply drops to the
 * ambient floor — which is exactly what a cartoon shadow is.
 *
 * customProgramCacheKey() returns the mode, so three recompiles once per switch
 * and never confuses the two programs.
 * ==========================================================================*/

const TOON_GLSL = /* glsl */ `
void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );

	// Three bands: shade, mid, light. The edge width follows the screen-space
	// gradient of dotNL so it is always about a pixel wide.
	float w = fwidth( dotNL ) * 0.9 + 0.01;
	float b1 = smoothstep( 0.20 - w, 0.20 + w, dotNL );
	float b2 = smoothstep( 0.62 - w, 0.62 + w, dotNL );
	vec3 irradiance = ( 0.40 + 0.32 * b1 + 0.28 * b2 ) * directLight.color;

	// One clipped highlight instead of a smooth lobe: glass and metal still read
	// as glass and metal, but as a cartoon would draw them.
	vec3 spec = irradiance * BRDF_GGX_Multiscatter( directLight.direction, geometryViewDir, geometryNormal, material );
	float specLum = dot( spec, vec3( 0.2126, 0.7152, 0.0722 ) );
	reflectedLight.directSpecular += spec * smoothstep( 0.035, 0.09, specLum );

	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Toon
`

const TOON_ANCHOR = '#include <lights_physical_pars_fragment>'

function toonHook(shader: { fragmentShader: string }): void {
  if (!ATMOSPHERE[mode].toon) return
  if (shader.fragmentShader.indexOf(TOON_ANCHOR) < 0) return
  shader.fragmentShader = shader.fragmentShader.replace(TOON_ANCHOR, TOON_ANCHOR + '\n' + TOON_GLSL)
}

function toonCacheKey(): string {
  return ATMOSPHERE[mode].toon ? 'pg-toon' : 'pg-flat'
}

function isStandard(m: THREE.Material): m is THREE.MeshStandardMaterial {
  return (m as THREE.MeshStandardMaterial).isMeshStandardMaterial === true
}

/** Wire the ramp into one standard material. Idempotent. */
function installToon(m: THREE.MeshStandardMaterial): void {
  if (m.onBeforeCompile !== toonHook) {
    m.onBeforeCompile = toonHook
    m.customProgramCacheKey = toonCacheKey
  }
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

/* ============================================================================
 * MATERIAL PAINTING
 *
 * Every paint function takes the value the caller AUTHORED — always a night
 * value, because that is the mode src/world is written in — and derives the
 * current mode from it. Nothing ever reads the colour that happens to be on the
 * material, so switching back and forth is exact and idempotent.
 * ==========================================================================*/

interface MatSpec {
  color: number
  roughness: number
  metalness: number
  emissive: number
  emissiveIntensity: number
}

function paintMat(m: THREE.MeshStandardMaterial, s: MatSpec, target: ThemeMode): void {
  if (target === 'day') {
    m.color.setHex(daySurface(s.color))
    // A cel-shaded surface is matte by definition; what little variation is left
    // drives the size of the single highlight, so roughness is compressed rather
    // than flattened. Metal has no place in a cartoon and is nearly removed.
    m.roughness = Math.min(1, s.roughness * 0.55 + 0.42)
    m.metalness = s.metalness * 0.25
    m.emissive.setHex(dayEmissive(s.emissive))
  } else {
    m.color.setHex(s.color)
    m.roughness = s.roughness
    m.metalness = s.metalness
    m.emissive.setHex(s.emissive)
  }
  m.emissiveIntensity = s.emissiveIntensity
  installToon(m)
}

interface NeonSpec {
  color: number
  intensity: number
}

function paintNeon(m: THREE.MeshBasicMaterial, s: NeonSpec, target: ThemeMode): void {
  const hex = target === 'day' ? dayAccent(s.color) : s.color
  const k = target === 'day' ? dayNeonIntensity(s.intensity) : s.intensity
  m.color.setHex(hex).multiplyScalar(k)
}

interface LineSpec {
  color: number
  opacity: number
}

function paintLine(m: THREE.LineBasicMaterial, s: LineSpec, target: ThemeMode): void {
  const hex = target === 'day' ? dayInk(s.color) : s.color
  const o = target === 'day' ? dayInkOpacity(s.opacity) : s.opacity
  m.color.setHex(hex)
  m.opacity = o
  const wantsTransparent = o < 1
  if (m.transparent !== wantsTransparent) {
    m.transparent = wantsTransparent
    m.needsUpdate = true
  }
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
  uniforms?: Record<string, number>
}

interface ThemeUserData {
  /** Set on materials the theme cache owns: the generic pass must skip them. */
  pgTheme?: boolean
  pgNight?: CapturedNight
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
          cols[name].setHex(target === 'day' ? dayAccent(src) : src)
        }
      }
    }
    return
  }

  if (line.isLineBasicMaterial === true) {
    if (first) {
      night.color = line.color.getHex()
      night.opacity = line.opacity
    }
    if (night.color !== undefined && night.opacity !== undefined) {
      paintLine(line, { color: night.color, opacity: night.opacity }, target)
    }
    return
  }

  const lit = isStandard(m)
  const hasColor = (basic.color as THREE.Color | undefined) !== undefined
  // vertexColors means `color` is a per-instance multiplier; leave it white.
  const paintable = hasColor && basic.vertexColors !== true

  if (paintable) {
    if (first) night.color = basic.color.getHex()
    const src = night.color
    if (src !== undefined && !isNeutralExtreme(src)) {
      basic.color.setHex(target === 'day' ? (lit ? daySurface(src) : dayAccent(src)) : src)
    }
  }

  if (lit) {
    if (first) {
      night.emissive = std.emissive.getHex()
      night.roughness = std.roughness
      night.metalness = std.metalness
    }
    if (night.emissive !== undefined) {
      std.emissive.setHex(target === 'day' ? dayEmissive(night.emissive) : night.emissive)
    }
    if (night.roughness !== undefined) {
      std.roughness = target === 'day' ? Math.min(1, night.roughness * 0.55 + 0.42) : night.roughness
    }
    if (night.metalness !== undefined) {
      std.metalness = target === 'day' ? night.metalness * 0.25 : night.metalness
    }
    installToon(std)
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
  const boxes = new Map<string, THREE.BoxGeometry>()
  const cyls = new Map<string, THREE.CylinderGeometry>()
  const texts = new Map<string, THREE.Texture>()
  const textSpecs = new Map<string, { text: string; opts: TextTexOpts; canvas: HTMLCanvasElement }>()

  function mat(key: string, opts: MatOpts = {}): THREE.MeshStandardMaterial {
    let m = mats.get(key)
    if (!m) {
      const spec: MatSpec = {
        color: opts.color ?? 0x223049,
        roughness: opts.roughness ?? 0.62,
        metalness: opts.metalness ?? 0.28,
        emissive: opts.emissive ?? 0x000000,
        emissiveIntensity: opts.emissiveIntensity ?? 1,
      }
      m = new THREE.MeshStandardMaterial({
        transparent: opts.transparent ?? false,
        opacity: opts.opacity ?? 1,
        flatShading: opts.flatShading ?? false,
        side: opts.side ?? THREE.FrontSide,
      })
      m.name = key
      userData(m).pgTheme = true
      matSpecs.set(key, spec)
      mats.set(key, m)
      paintMat(m, spec, mode)
    }
    return m
  }

  function neon(color: number, intensity = 1.6, opts: { transparent?: boolean; opacity?: number } = {}) {
    const key = `${color}|${intensity}|${opts.transparent ? 1 : 0}|${opts.opacity ?? 1}`
    let m = neons.get(key)
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        toneMapped: false,
        transparent: opts.transparent ?? false,
        opacity: opts.opacity ?? 1,
        depthWrite: opts.transparent ? false : true,
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

  function box(w: number, h: number, d: number): THREE.BoxGeometry {
    const key = `${w}|${h}|${d}`
    let g = boxes.get(key)
    if (!g) boxes.set(key, (g = new THREE.BoxGeometry(w, h, d)))
    return g
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
      ctx.fillStyle = target === 'day' ? dayCssColor(opts.bg) : opts.bg
      ctx.fillRect(0, 0, cv.width, cv.height)
    }
    ctx.font = font
    ctx.textAlign = opts.align ?? 'center'
    ctx.textBaseline = 'middle'
    const ink = opts.color ?? '#dbe7ff'
    ctx.fillStyle = target === 'day' ? dayCssColor(ink) : ink
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
    for (const g of boxes.values()) g.dispose()
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
