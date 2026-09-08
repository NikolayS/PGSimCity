import { BUILD_LABEL } from '../core/build'
import { CLAIM_VALUES } from '../core/claims'
import type { RendererApi } from '../engine/renderer'
import { exportDimensions, pngBlob, withPresentationPause } from '../engine/presentation'
import { el, type UiContext, type UiModule } from './uikit'
import '../styles/presentation.css'

export interface PresentationModule extends UiModule {
  open(): void
  close(): void
  isOpen(): boolean
}

/** Wrap even long component names, so qualifications cannot escape the image. */
export function wrapPresentationText(text: string, width: number, measure: (value: string) => number): string[] {
  const lines: string[] = []
  let line = ''
  for (const char of text) {
    if (line && measure(line + char) > width) {
      const space = line.lastIndexOf(' ')
      if (space > 0) {
        lines.push(line.slice(0, space))
        line = line.slice(space + 1)
      } else {
        lines.push(line)
        line = ''
      }
    }
    line += char
  }
  if (line.trim()) lines.push(line.trim())
  return lines
}

export function createPresentationExport(ctx: UiContext, gfx: RendererApi): PresentationModule {
  let opened = false
  let busy = false
  let disposed = false
  let previouslyPaused = false
  let previousFocus: HTMLElement | null = null
  let selected: string | null = null
  let downloadUrl: string | null = null
  const offSelect = ctx.bus.on('select', ({ id }) => { selected = id })
  const scale = el('select', { 'aria-label': 'Image resolution' },
    el('option', { value: '1', text: '1× viewport' }), el('option', { value: '2', text: '2× viewport (up to 4 megapixels)' }),
    el('option', { value: '4k', text: '4K scene (plus model footer)' }))
  scale.value = '2'
  const names = el('input', { type: 'checkbox', checked: true })
  const status = el('p', { class: 'pg-presentation__status', role: 'status', 'aria-live': 'polite' })
  const save = el('button', { type: 'button', text: 'Download PNG', on: { click: () => { void capture() } } })
  const closeButton = el('button', { type: 'button', text: 'Return to city', on: { click: close } })
  const retry = el('a', { text: 'Save prepared image', class: 'pg-presentation__download', hidden: true })
  const dialog = el('dialog', { class: 'pg-presentation', 'aria-labelledby': 'pg-presentation-title' },
    el('h2', { id: 'pg-presentation-title', text: 'Export this view' }),
    el('p', { text: 'The model is paused. The image keeps this camera and graphics quality; it does not run another experiment.' }),
    el('label', { class: 'pg-presentation__field' }, 'Image resolution', scale),
    el('label', { class: 'pg-presentation__field' }, names, 'Include visible object names'),
    el('p', { class: 'pg-presentation__disclosure', text: 'Every image retains the version, model clock and representative-model disclosure. City graphics are modelled, not PostgreSQL measurements.' }),
    el('p', { text: 'The default caps the scene at 4 megapixels. Optional 4K needs roughly 380 MiB of extra render-target memory; actual use varies. Both keep your camera aspect and respect GPU limits. If export fails, try 1×.' }),
    status, retry, el('div', { class: 'pg-presentation__actions' }, save, closeButton))
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close() })
  // Native modal focus does not stop the city's window-level shortcuts.
  dialog.addEventListener('keydown', (event) => event.stopPropagation())
  dialog.addEventListener('keyup', (event) => event.stopPropagation())
  document.body.append(dialog)

  function open(): void {
    if (disposed || opened) return
    opened = true
    previouslyPaused = ctx.sim.state.knobs.paused
    ctx.sim.setKnob('paused', true)
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
    status.textContent = ''
    scale.focus()
  }

  function close(): void {
    if (!opened || busy) return
    opened = false
    if (typeof dialog.close === 'function') dialog.close()
    else dialog.removeAttribute('open')
    ctx.sim.setKnob('paused', previouslyPaused)
    previousFocus?.focus()
  }

  function clearDownload(): void {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl)
    downloadUrl = null
    retry.hidden = true
    retry.removeAttribute('href')
  }

  async function capture(): Promise<void> {
    if (busy || disposed) return
    busy = true
    save.disabled = true
    closeButton.disabled = true
    clearDownload()
    status.textContent = 'Preparing image…'
    try {
      const image = await withPresentationPause(() => ctx.sim.state.knobs.paused,
        (value) => ctx.sim.setKnob('paused', value), async () => {
          const viewport = gfx.dom.getBoundingClientRect()
          const gl = gfx.renderer.getContext()
          if (gl.isContextLost()) throw new Error('WebGL context is unavailable. Wait for the city to recover.')
          const maxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
          const maxDimension = Math.min(gfx.renderer.capabilities.maxTextureSize,
            gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, maxViewport[0], maxViewport[1])
          const size = exportDimensions(viewport.width, viewport.height,
            scale.value === '4k' ? '4k' : scale.value === '1' ? 1 : 2, maxDimension)
          const scene = gfx.captureFrame(size.width, size.height)
          const canvas = document.createElement('canvas')
          const context = canvas.getContext('2d')
          if (!context) throw new Error('Presentation canvas is unavailable')
          const fontSize = Math.max(14, Math.round(size.width / 110))
          const padding = fontSize
          const font = `${fontSize}px system-ui, sans-serif`
          context.font = font
          const selection = selected ? ctx.registry.get(selected)?.name : null
          const footer = [
            `PGSimCity ${BUILD_LABEL} · ${CLAIM_VALUES.postgresqlVersion.referenceLabel} model reference`,
            `Representative educational model, not measured PostgreSQL. Time: ${ctx.sim.state.t.toFixed(2)} model seconds.`,
            ...(selection ? [`Selected: ${selection}`] : []),
            ...(ctx.sim.state.scenario ? [`Scenario: ${ctx.sim.state.scenario}`] : []),
          ]
          const lines = footer.flatMap((line) => wrapPresentationText(line, Math.max(1, size.width - padding * 2),
            (value) => context.measureText(value).width))
          canvas.width = size.width
          canvas.height = size.height + Math.ceil(lines.length * fontSize * 1.5 + padding * 2)
          context.drawImage(scene, 0, 0)
          if (names.checked) {
            const ratio = size.width / viewport.width
            context.font = font
            context.textBaseline = 'top'
            for (const node of document.querySelectorAll<HTMLElement>('.lbl__name')) {
              const bounds = node.getBoundingClientRect()
              const parent = node.closest<HTMLElement>('.lbl')
              if (!bounds.width || !bounds.height || (parent && getComputedStyle(parent).opacity === '0')) continue
              const text = node.textContent?.trim()
              if (!text) continue
              const x = (bounds.left - viewport.left) * ratio
              const y = (bounds.top - viewport.top) * ratio
              const width = context.measureText(text).width + 12
              if (x < 0 || y < 0 || x + width > size.width || y + fontSize + 8 > size.height) continue
              context.fillStyle = '#111a2b'
              context.fillRect(x - 4, y - 4, width, fontSize + 8)
              context.fillStyle = '#f3f6fc'
              context.fillText(text, x, y)
            }
          }
          context.fillStyle = '#111a2b'
          context.fillRect(0, size.height, canvas.width, canvas.height - size.height)
          context.font = font
          context.textBaseline = 'top'
          context.fillStyle = '#f3f6fc'
          lines.forEach((line, i) => context.fillText(line, padding, size.height + padding + i * fontSize * 1.5))
          try {
            return await pngBlob(canvas)
          } finally {
            scene.width = scene.height = canvas.width = canvas.height = 1
          }
        })
      if (disposed) return
      downloadUrl = URL.createObjectURL(image)
      retry.href = downloadUrl
      retry.download = `pgsimcity-${ctx.sim.state.t.toFixed(2)}-model-seconds.png`
      retry.hidden = false
      retry.click()
      status.textContent = 'Image ready. If your browser did not save it, use “Save prepared image”.'
    } catch (error) {
      if (!disposed) status.textContent = error instanceof Error ? error.message : 'Image export failed. Try 1×.'
    } finally {
      busy = false
      save.disabled = false
      closeButton.disabled = false
      if (disposed && opened) close()
    }
  }

  return { open, close, isOpen: () => opened, update() {}, dispose() {
    disposed = true
    if (!busy) close()
    offSelect()
    clearDownload()
    dialog.remove()
  } }
}
