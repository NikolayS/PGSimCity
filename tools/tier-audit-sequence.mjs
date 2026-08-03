import { writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

const LEVELS = ['ultra', 'high', 'medium', 'reduced', 'low']
const MODES = ['day', 'night']

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function outputPath(output, mode, level) {
  const extension = extname(output) || '.png'
  const stem = basename(output, extension)
  return join(dirname(output), `${stem}-${mode}-${level}${extension}`)
}

const MEASURE = `(() => {
  const visible = (element) => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    return style.display !== 'none'
      && style.visibility === 'visible'
      && Number(style.opacity) > 0.01
      && box.width > 0
      && box.height > 0
  }
  const describe = (element) => {
    if (element.id) return '#' + element.id
    const aria = element.getAttribute('aria-label')
    if (aria) return aria
    return element.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80)
      || element.tagName.toLowerCase()
  }
  const disclosures = Array.from(document.querySelectorAll('*')).filter((element) => (
    Number(getComputedStyle(element).getPropertyValue('--pg-disclosure')) > 0
  )).map((element) => {
    const marker = getComputedStyle(element).getPropertyValue('--pg-disclosure').trim()
    const style = getComputedStyle(element, marker === '2' ? '::after' : null)
    return {
      id: element.dataset.disclosure,
      fontSize: Number.parseFloat(style.fontSize),
      visible: visible(element),
    }
  })
  const controls = Array.from(document.querySelectorAll(
    'button, a, [role="button"], input:not([type="hidden"]), select',
  )).filter((element) => !element.closest('[hidden], [inert], [aria-hidden="true"]') && visible(element))
    .map((element) => {
      const box = element.getBoundingClientRect()
      return { label: describe(element), width: box.width, height: box.height }
    })
  // CSS2D roots are zero-sized positioning anchors; the visible chip is their
  // child, so a rectangle test on `.lbl` would incorrectly report no labels.
  const labels = Array.from(document.querySelectorAll('.lbl.is-on'))
    .map((element) => element.querySelector('.lbl__name')?.textContent || '')
  const named = []
  window.PGSIMCITY.gfx.scene.traverse((object) => {
    if (object.name && object.visible) named.push(object.name)
  })
  const renderer = window.PGSIMCITY.gfx.renderer
  return {
    quality: { ...window.PGSIMCITY.gfx.quality },
    theme: window.PGSIMCITY.themeMode(),
    fps: Number(window.PGSIMCITY.gfx.fps.toFixed(1)),
    drawingBuffer: [renderer.domElement.width, renderer.domElement.height],
    labels,
    disclosures,
    controls,
    visibleNamedObjects: named.sort(),
    rendererInfo: {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      points: renderer.info.render.points,
      lines: renderer.info.render.lines,
    },
  }
})()`

export async function runSequence({ send, logs, output }) {
  const reports = []

  await send('Runtime.evaluate', {
    expression: `(() => {
      document.querySelector('.tour-first__no')?.click()
      window.PGSIMCITY.bus.emit('select', { id: null })
      window.PGSIMCITY.bus.emit('ui:help', { open: false })
      window.PGSIMCITY.sim.setKnob('paused', true)
      window.PGSIMCITY.rig.home(true)
    })()`,
    returnByValue: true,
  })

  for (const mode of MODES) {
    for (const level of LEVELS) {
      await send('Runtime.evaluate', {
        expression: `(() => {
          window.PGSIMCITY.setThemeMode(${JSON.stringify(mode)}, { persist: false })
          window.PGSIMCITY.bus.emit('quality', { level: ${JSON.stringify(level)} })
          window.PGSIMCITY.rig.home(true)
        })()`,
        returnByValue: true,
      })
      // SwiftShader needs several frames to rebuild composer targets and shader
      // variants after both switches; nine seconds is the repository driver's
      // established post-staging settle interval.
      await sleep(9_000)
      // A deliberately slow audit machine can trigger the adaptive ladder while
      // shaders settle. Reassert the requested tier, then capture at the start
      // of its four-second grace window so the frame really represents it.
      await send('Runtime.evaluate', {
        expression: `window.PGSIMCITY.bus.emit('quality', { level: ${JSON.stringify(level)} })`,
        returnByValue: true,
      })
      await sleep(500)
      await send('Runtime.evaluate', {
        expression: `document.querySelectorAll('.hud-toast').forEach((toast) => toast.remove())`,
        returnByValue: true,
      })
      const result = await send('Runtime.evaluate', {
        expression: MEASURE,
        returnByValue: true,
      })
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      }
      if (result.result.value?.quality?.level !== level) {
        throw new Error(`requested ${level}, rendered ${result.result.value?.quality?.level ?? 'unknown'}`)
      }
      const path = outputPath(output, mode, level)
      const screenshot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(path, Buffer.from(screenshot.data, 'base64'))
      reports.push({ mode, level, screenshot: path, ...result.result.value })
      logs.push(`[TIER] ${mode}/${level} -> ${path}`)
    }
  }

  const reportPath = output.replace(/\.png$/i, '.json')
  writeFileSync(reportPath, `${JSON.stringify(reports, null, 2)}\n`)
  logs.push(`[TIER] report -> ${reportPath}`)
}
