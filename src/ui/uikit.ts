import type { Bus, QualitySettings, SimApi } from '../core/types'
import type { Registry } from '../core/registry'

/* ============================================================================
 * Shared UI plumbing. Every HUD module takes a UiContext and builds DOM with
 * these helpers, so the whole interface stays one consistent object.
 * ==========================================================================*/

export interface UiContext {
  bus: Bus
  sim: SimApi
  registry: Registry
  getFps(): number
  getQuality(): QualitySettings
  getFlowStats(): { active: number; dropped: number }
  /** Optional so isolated UI instruments do not need to construct Web Audio. */
  getAudioState?(): { enabled: boolean; preferred: boolean; volume: number }
}

export interface UiModule {
  /**
   * Called every frame. `dt` is animation-safe; `elapsed` is accepted wall time
   * for clocks that must agree with the viewer's watch.
   */
  update(dt: number, elapsed?: number): void
  dispose(): void
}

/* ------------------------------ DOM helpers ------------------------------ */

type Attrs = Record<string, unknown> & {
  class?: string
  text?: string
  html?: string
  style?: Partial<CSSStyleDeclaration> | string
  on?: Record<string, EventListenerOrEventListenerObject>
  data?: Record<string, string>
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') node.className = String(v)
    else if (k === 'text') node.textContent = String(v)
    else if (k === 'html') node.innerHTML = String(v)
    else if (k === 'style') {
      if (typeof v === 'string') node.setAttribute('style', v)
      else Object.assign(node.style, v)
    } else if (k === 'on') {
      for (const [ev, fn] of Object.entries(v as Record<string, EventListener>)) node.addEventListener(ev, fn)
    } else if (k === 'data') {
      for (const [dk, dv] of Object.entries(v as Record<string, string>)) node.dataset[dk] = dv
    } else if (k in node) {
      // property assignment (value, checked, disabled, …)
      ;(node as unknown as Record<string, unknown>)[k] = v
    } else {
      node.setAttribute(k, String(v))
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue
    node.append(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return node
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

/** Set textContent only when it actually changed — avoids layout thrash at 60fps. */
export function setText(node: { textContent: string | null }, value: string): void {
  if (node.textContent !== value) node.textContent = value
}

/** Toggle a class only on change. */
export function setClass(node: Element, cls: string, on: boolean): void {
  if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on)
}

export function throttle<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let last = 0
  let pending: number | null = null
  return function throttled(this: unknown, ...args: never[]) {
    const now = performance.now()
    if (now - last >= ms) {
      last = now
      fn.apply(this, args)
    } else if (pending == null) {
      pending = window.setTimeout(() => {
        pending = null
        last = performance.now()
        fn.apply(this, args)
      }, ms - (now - last))
    }
  } as T
}

/* --------------------------------- icons --------------------------------- */

const ICON_PATHS: Record<string, string> = {
  play: 'M5 3.5v9l8-4.5z',
  pause: 'M5.5 3.5h2.2v9H5.5zm4.8 0h2.2v9h-2.2z',
  reset: 'M8 3a5 5 0 1 0 4.6 3M12.8 2.4v3.4H9.4',
  tour: 'M3.2 14V2.2M3.5 3h8l-1.8 2.4 1.8 2.4h-8',
  help: 'M6 6a2 2 0 1 1 2.6 1.9c-.5.2-.6.6-.6 1v.4M8 12.1h.01',
  search: 'M7.2 11.4a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4zm3.2-1 3.1 3.1',
  close: 'M4 4l8 8M12 4l-8 8',
  chevron: 'M6 4l4 4-4 4',
  camera: 'M2.5 5.5h2l1-1.5h5l1 1.5h2v7h-11zM8 11a2.2 2.2 0 1 0 0-4.4A2.2 2.2 0 0 0 8 11z',
  walk: 'M8 3.4a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8zM6.2 6.2 8 4.2l2.2 2.3M8 4.4v4l-2.4 2.4M8 8.4l2.6 3.3M5.2 14l1.3-1.3M10.2 14h2.4',
  eye: 'M1.5 8S4 4 8 4s6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4zm6.5 1.7a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4z',
  gear: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.6v1.6M8 12.8v1.6M2.5 4.8l1.4.8M12.1 10.4l1.4.8M2.5 11.2l1.4-.8M12.1 5.6l1.4-.8',
  layers: 'M8 2 1.8 5.4 8 8.8l6.2-3.4zM2 8.6 8 12l6-3.4M2 11.4 8 14.8l6-3.4',
  warn: 'M8 2 1.5 13.5h13zM8 6.4v3.2M8 11.6h.01',
  next: 'M4 3.5l6 4.5-6 4.5zM11.5 3.5v9',
  prev: 'M12 3.5l-6 4.5 6 4.5zM4.5 3.5v9',
  pin: 'M8 1.8v5M5 6.8h6l1 3H4zM8 9.8v4.4',
  home: 'M2.5 7.5 8 2.8l5.5 4.7M4 7v6.2h8V7',
  diagnose: 'M1.5 8h2.2l1.2-3.4 2.2 7 1.8-5.2 1.1 3h4.5M11.8 12.2l2.3 2.3',
  sound: 'M2.2 6.2h2.7L8.1 3v10L4.9 9.8H2.2zM10.6 5.5a3.4 3.4 0 0 1 0 5M12.3 3.7a5.9 5.9 0 0 1 0 8.6',
  sun: 'M8 3.2V1.5M8 14.5v-1.7M3.2 8H1.5M14.5 8h-1.7M4.6 4.6 3.4 3.4M12.6 12.6l-1.2-1.2M11.4 4.6l1.2-1.2M3.4 12.6l1.2-1.2M11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  moon: 'M12.8 10.5A5.8 5.8 0 0 1 5.5 3.2 5.8 5.8 0 1 0 12.8 10.5z',
  clock: 'M8 2.1a5.9 5.9 0 1 1 0 11.8A5.9 5.9 0 0 1 8 2.1zM8 4.7v3.6l2.5 1.5',
}

export function icon(name: keyof typeof ICON_PATHS | string, size = 14): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  svg.dataset.icon = name
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  p.setAttribute('d', ICON_PATHS[name] ?? ICON_PATHS.help)
  p.setAttribute('stroke', 'currentColor')
  p.setAttribute('stroke-width', '1.4')
  p.setAttribute('stroke-linecap', 'round')
  p.setAttribute('stroke-linejoin', 'round')
  if (name === 'play' || name === 'pause' || name === 'next' || name === 'prev') {
    p.setAttribute('fill', 'currentColor')
    p.setAttribute('stroke-width', '0.8')
  }
  svg.append(p)
  return svg
}

/* ------------------------------ sparklines ------------------------------- */

export interface SparkOpts {
  color?: string
  fill?: boolean
  min?: number
  max?: number
  /** draw a dashed baseline at this value */
  baseline?: number
}

/**
 * Draw a rolling-history sparkline. Sizes the backing store to the element's
 * box exactly once per size change, so it stays crisp on HiDPI without
 * reallocating every frame.
 */
export function sparkline(canvas: HTMLCanvasElement, data: readonly number[], opts: SparkOpts = {}): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = canvas.clientWidth || 120
  const h = canvas.clientHeight || 26
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (data.length < 2) return

  let lo = opts.min ?? Infinity
  let hi = opts.max ?? -Infinity
  if (opts.min == null || opts.max == null) {
    for (const v of data) {
      if (opts.min == null && v < lo) lo = v
      if (opts.max == null && v > hi) hi = v
    }
  }
  if (!isFinite(lo)) lo = 0
  if (!isFinite(hi)) hi = 1
  if (hi - lo < 1e-6) hi = lo + 1

  const pad = 2
  const color = opts.color ?? '#5ad1ff'
  const x = (i: number) => (i / (data.length - 1)) * w
  const y = (v: number) => h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2)

  if (opts.baseline != null && opts.baseline >= lo && opts.baseline <= hi) {
    ctx.strokeStyle = 'rgba(120,170,235,0.22)'
    ctx.setLineDash([2, 3])
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, y(opts.baseline))
    ctx.lineTo(w, y(opts.baseline))
    ctx.stroke()
    ctx.setLineDash([])
  }

  ctx.beginPath()
  ctx.moveTo(x(0), y(data[0]))
  for (let i = 1; i < data.length; i++) ctx.lineTo(x(i), y(data[i]))

  if (opts.fill) {
    ctx.save()
    ctx.lineTo(w, h)
    ctx.lineTo(0, h)
    ctx.closePath()
    const g = ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, color + '44')
    g.addColorStop(1, color + '00')
    ctx.fillStyle = g
    ctx.fill()
    ctx.restore()
    ctx.beginPath()
    ctx.moveTo(x(0), y(data[0]))
    for (let i = 1; i < data.length; i++) ctx.lineTo(x(i), y(data[i]))
  }

  ctx.strokeStyle = color
  ctx.lineWidth = 1.4
  ctx.lineJoin = 'round'
  ctx.stroke()

  // head dot
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(x(data.length - 1), y(data[data.length - 1]), 1.9, 0, Math.PI * 2)
  ctx.fill()
}

/* ------------------------------ small bits ------------------------------- */

/** A labelled metric tile that only rewrites the DOM when the value changes. */
export function metricTile(label: string): { root: HTMLElement; set(v: string, state?: '' | 'ok' | 'warn' | 'crit'): void } {
  const v = el('div', { class: 'pg-metric__v' })
  const root = el('div', { class: 'pg-metric' }, el('div', { class: 'pg-metric__k', text: label }), v)
  let lastState = ''
  return {
    root,
    set(value: string, state: '' | 'ok' | 'warn' | 'crit' = '') {
      setText(v, value)
      if (state !== lastState) {
        v.className = 'pg-metric__v' + (state ? ` is-${state}` : '')
        lastState = state
      }
    },
  }
}

/** Keep a range input's CSS --fill custom property in sync for the gradient track. */
export function syncRangeFill(input: HTMLInputElement): void {
  const min = Number(input.min || 0)
  const max = Number(input.max || 100)
  const val = Number(input.value)
  const pct = max === min ? 0 : ((val - min) / (max - min)) * 100
  input.style.setProperty('--fill', `${pct}%`)
}

/** Log-scaled slider mapping, for things like tps that span three orders of magnitude. */
export const logToLinear = (v: number, min: number, max: number) =>
  (Math.log(Math.max(v, min)) - Math.log(min)) / (Math.log(max) - Math.log(min))
export const linearToLog = (t: number, min: number, max: number) =>
  Math.exp(Math.log(min) + t * (Math.log(max) - Math.log(min)))
