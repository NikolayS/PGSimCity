import * as THREE from 'three'
import type { ColorKey, MatOpts, TextTexOpts, ThemeApi } from './types'

/**
 * PGSimCity palette. Mirrors src/styles/tokens.css.
 *
 * Rendering model: the renderer uses ACESFilmic tone mapping and the bloom pass
 * runs with a high threshold, so *only* surfaces whose output exceeds ~1.0 will
 * glow. Paint structure with `mat()` (PBR, no glow); paint meaning — data,
 * state, energy — with `neon()`.
 */
export const COLOR: Record<ColorKey, number> = {
  bg: 0x04060c,
  fog: 0x070b16,
  grid: 0x16243c,
  gridBright: 0x2a4368,
  ground: 0x080d18,
  client: 0x8ecae6,
  backend: 0x5ad1ff,
  shmem: 0x7b6cff,
  bufClean: 0x3fa7ff,
  bufDirty: 0xff4d6d,
  bufPinned: 0xffd166,
  bufFree: 0x1b2740,
  wal: 0xffb03a,
  walDim: 0x7a5312,
  storage: 0x55d6a0,
  vacuum: 0xb57bff,
  checkpoint: 0xff7ac6,
  bgwriter: 0x4fe3c1,
  replication: 0xff9f1c,
  lock: 0xff5c5c,
  ok: 0x57e389,
  warn: 0xffcc55,
  crit: 0xff5f6d,
  ink: 0xe8f1ff,
  inkDim: 0x8fa5c4,
  postmaster: 0x9db4ff,
  archive: 0xc9a227,
  toast: 0xff8f5a,
  index: 0x64ffda,
}

/** CSS string for a palette entry, e.g. `cssColor('wal')` → "#ffb03a". */
export function cssColor(key: ColorKey): string {
  return '#' + COLOR[key].toString(16).padStart(6, '0')
}

/** Mix two hex ints in linear-ish space. */
export function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255,
    ag = (a >> 8) & 255,
    ab = a & 255
  const br = (b >> 16) & 255,
    bg = (b >> 8) & 255,
    bb = b & 255
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bl = Math.round(ab + (bb - ab) * t)
  return (r << 16) | (g << 8) | bl
}

/**
 * Shared material / geometry cache.
 *
 * IMPORTANT for world modules: never mutate a material returned by `mat()` or
 * `neon()` — they are shared. If you need per-object state, either ask for a
 * unique cache key or clone it.
 */
export function createTheme(): ThemeApi {
  const mats = new Map<string, THREE.MeshStandardMaterial>()
  const neons = new Map<string, THREE.MeshBasicMaterial>()
  const lines = new Map<string, THREE.LineBasicMaterial>()
  const boxes = new Map<string, THREE.BoxGeometry>()
  const cyls = new Map<string, THREE.CylinderGeometry>()
  const texts = new Map<string, THREE.Texture>()

  function mat(key: string, opts: MatOpts = {}): THREE.MeshStandardMaterial {
    let m = mats.get(key)
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color: opts.color ?? 0x223049,
        roughness: opts.roughness ?? 0.62,
        metalness: opts.metalness ?? 0.28,
        emissive: opts.emissive ?? 0x000000,
        emissiveIntensity: opts.emissiveIntensity ?? 1,
        transparent: opts.transparent ?? false,
        opacity: opts.opacity ?? 1,
        flatShading: opts.flatShading ?? false,
        side: opts.side ?? THREE.FrontSide,
      })
      m.name = key
      mats.set(key, m)
    }
    return m
  }

  function neon(color: number, intensity = 1.6, opts: { transparent?: boolean; opacity?: number } = {}) {
    const key = `${color}|${intensity}|${opts.transparent ? 1 : 0}|${opts.opacity ?? 1}`
    let m = neons.get(key)
    if (!m) {
      const c = new THREE.Color(color)
      c.multiplyScalar(intensity)
      m = new THREE.MeshBasicMaterial({
        color: c,
        toneMapped: false,
        transparent: opts.transparent ?? false,
        opacity: opts.opacity ?? 1,
        depthWrite: opts.transparent ? false : true,
      })
      m.name = `neon:${key}`
      neons.set(key, m)
    }
    return m
  }

  function line(color: number, opacity = 0.5): THREE.LineBasicMaterial {
    const key = `${color}|${opacity}`
    let m = lines.get(key)
    if (!m) {
      m = new THREE.LineBasicMaterial({
        color,
        transparent: opacity < 1,
        opacity,
        toneMapped: false,
        depthWrite: false,
      })
      lines.set(key, m)
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
    const ctx = cv.getContext('2d')!
    if (opts.bg) {
      ctx.fillStyle = opts.bg
      ctx.fillRect(0, 0, cv.width, cv.height)
    }
    ctx.font = font
    ctx.textAlign = opts.align ?? 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = opts.color ?? '#dbe7ff'
    if ('letterSpacing' in ctx && opts.letterSpacing) {
      ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = opts.letterSpacing
    }
    const x = ctx.textAlign === 'center' ? cv.width / 2 : ctx.textAlign === 'right' ? cv.width - pad : pad
    ctx.fillText(text, x, cv.height / 2)

    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    tex.needsUpdate = true
    texts.set(key, tex)
    return tex
  }

  function dispose() {
    for (const m of mats.values()) m.dispose()
    for (const m of neons.values()) m.dispose()
    for (const m of lines.values()) m.dispose()
    for (const g of boxes.values()) g.dispose()
    for (const g of cyls.values()) g.dispose()
    for (const t of texts.values()) t.dispose()
    mats.clear()
    neons.clear()
    lines.clear()
    boxes.clear()
    cyls.clear()
    texts.clear()
  }

  return { color: COLOR, mat, neon, line, edges, textTexture, box, cyl, dispose }
}

function nextPow2(v: number): number {
  let p = 1
  while (p < v) p <<= 1
  return p
}
