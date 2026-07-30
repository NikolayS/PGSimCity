#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { acquireCdpProfile } from './cdp-profile.mjs'
import { createCdpRunCleanup, installProcessCleanup } from './cdp-run.mjs'

const APP_URL = process.argv[2] ?? 'http://localhost:5173/'
const PORT = Number(process.env.CDP_PORT ?? 9571)
const profile = acquireCdpProfile({
  explicitProfile: process.env.CDP_PROFILE,
  port: PORT,
})
const VIEWPORTS = [
  { width: 1280, height: 760, expectedVitals: 5 },
  { width: 1024, height: 760, expectedVitals: 5 },
  { width: 768, height: 760, expectedVitals: 5 },
  { width: 390, height: 844, expectedVitals: 2 },
]
const THEMES = ['night', 'day']
const LABEL_DESKTOP_AREA_BUDGET_PERCENT = 4
const LABEL_PHONE_AREA_BUDGET_PERCENT = 2
const LABEL_VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]
const LABEL_CAMERAS = [
  { name: 'close', distance: 120 },
  { name: 'default', distance: null },
  { name: 'far', distance: 900 },
  { name: 'max', distance: 1650 },
]
const LABEL_SETTLE_MS = 9000
const failures = []
const measurements = []
const run = createCdpRunCleanup({ profile })
const removeProcessCleanup = installProcessCleanup(() => run.cleanup())

const chrome = spawn(
  process.env.CHROME_BIN ?? 'google-chrome',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ozone-platform=headless',
    '--no-proxy-server',
    '--password-store=basic',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1280,844',
    '--no-first-run',
    '--disable-extensions',
    '--js-flags=--max-old-space-size=512',
    '--disable-gpu-shader-disk-cache',
    '--renderer-process-limit=1',
    '--disable-background-networking',
    `--user-data-dir=${profile.path}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
)
run.trackChild(chrome)
profile.setOwner(chrome.pid)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function targetWebSocket() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const page = (await response.json()).find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      // Chrome is still starting.
    }
    await sleep(250)
  }
  throw new Error('Chrome DevTools did not become available')
}

const socket = new WebSocket(await targetWebSocket())
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})
run.trackSocket(socket)

let commandId = 0
const pending = new Map()
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  if (message.error) request.reject(new Error(JSON.stringify(message.error)))
  else request.resolve(message.result)
}

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++commandId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  }
  return response.result.value
}

async function waitForHud() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if (await evaluate("document.querySelectorAll('.hud-vital').length === 5")) return
    } catch {
      // Navigation replaces the initial about:blank execution context.
    }
    await sleep(250)
  }
  throw new Error('HUD did not mount')
}

const measureExpression = (theme) => `(() => {
  document.documentElement.dataset.theme = ${JSON.stringify(theme)}
  const round = (value) => Number(value.toFixed(1))
  const rect = (element) => {
    const box = element.getBoundingClientRect()
    return {
      x: round(box.x),
      y: round(box.y),
      width: round(box.width),
      height: round(box.height),
      right: round(box.right),
      bottom: round(box.bottom),
    }
  }
  const visible = (element) => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
  }
  const overlaps = (a, b) =>
    a.left < b.right - 0.5 &&
    a.right > b.left + 0.5 &&
    a.top < b.bottom - 0.5 &&
    a.bottom > b.top + 0.5
  const contained = (child, parent) =>
    child.left >= parent.left - 0.5 &&
    child.right <= parent.right + 0.5 &&
    child.top >= parent.top - 0.5 &&
    child.bottom <= parent.bottom + 0.5
  const vitalViewport = document.querySelector('.hud-vitals')
  const vitalViewportRect = vitalViewport.getBoundingClientRect()
  const brand = document.querySelector('.hud-brand')
  const checkpoint = document.querySelector('.hud-ckpt')
  const controls = Array.from(
    document.querySelectorAll('.hud-ckpt, .hud-tools button, .hud-tools a, .hud-tools select'),
  ).filter(visible)
  const vitals = Array.from(document.querySelectorAll('.hud-vital'))
    .filter(visible)
    .map((element) => {
      const box = element.getBoundingClientRect()
      const key = element.querySelector('.hud-vital__k')
      const value = element.querySelector('.hud-vital__v')
      return {
        name: element.dataset.vital,
        rect: rect(element),
        insideViewport: contained(box, vitalViewportRect),
        textClipped:
          key.scrollWidth > key.clientWidth + 1 ||
          key.scrollHeight > key.clientHeight + 1 ||
          value.scrollWidth > value.clientWidth + 1 ||
          value.scrollHeight > value.clientHeight + 1,
        overlaps: controls
          .filter((control) => overlaps(box, control.getBoundingClientRect()))
          .map((control) => control.getAttribute('aria-label') || control.textContent.trim()),
      }
    })
  const controlRects = controls.map((element) => ({
    name: element.getAttribute('aria-label') || element.textContent.trim().replace(/\\s+/g, ' '),
    rect: rect(element),
  }))
  const visibleTargets = Array.from(
    document.querySelectorAll('#hud button, #hud input, #hud select, #hud a'),
  ).filter(visible)
  const badTargets = visibleTargets
    .map((element) => ({
      name: element.getAttribute('aria-label') || element.textContent.trim().slice(0, 28),
      rect: rect(element),
    }))
    .filter(({ rect: box }) => box.width < 44 || box.height < 44)
  let covered = 0
  let samples = 0
  if (${JSON.stringify(theme)} === 'night') {
    const sampleStep = innerWidth <= 700 ? 2 : 8
    for (let y = 1; y < innerHeight; y += sampleStep) {
      for (let x = 1; x < innerWidth; x += sampleStep) {
        samples++
        if (
          document
            .elementsFromPoint(x, y)
            .some((element) =>
              element.matches?.(
                '.pg-panel, .pgc-tab, .hud-toast, .touchpad__action, .touchpad__exit',
              ),
            )
        ) {
          covered++
        }
      }
    }
  }
  return {
    theme: ${JSON.stringify(theme)},
    viewport: [innerWidth, innerHeight],
    vitalViewport: rect(vitalViewport),
    vitals,
    controls: controlRects,
    horizontalOverflow:
      Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
    badTargets,
    chromeCoverage: samples ? round((covered / samples) * 100) : null,
    brandCheckpointOverlap:
      visible(brand) &&
      visible(checkpoint) &&
      overlaps(brand.getBoundingClientRect(), checkpoint.getBoundingClientRect()),
  }
})()`

const scenarioExpression = `(() => {
  const round = (value) => Number(value.toFixed(1))
  const rect = (element) => {
    const box = element.getBoundingClientRect()
    return {
      x: round(box.x),
      y: round(box.y),
      width: round(box.width),
      height: round(box.height),
      right: round(box.right),
      bottom: round(box.bottom),
    }
  }
  const visible = (element) => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
  }
  const overlaps = (a, b) =>
    a.left < b.right - 0.5 &&
    a.right > b.left + 0.5 &&
    a.top < b.bottom - 0.5 &&
    a.bottom > b.top + 0.5
  const containedX = (child, parent) =>
    child.left >= parent.left - 0.5 && child.right <= parent.right + 0.5
  const transport = document.querySelector('.hud-transport')
  const toggle = document.querySelector('.hud-scn__toggle')
  if (visible(toggle) && !transport.classList.contains('is-scn-open')) toggle.click()
  const rail = document.querySelector('.hud-chips')
  const status = document.querySelector('.hud-now')
  const cue = document.querySelector('.hud-scn__cue')
  const chips = Array.from(document.querySelectorAll('.hud-chip'))
  const railRect = rail.getBoundingClientRect()
  const statusRect = visible(status) ? status.getBoundingClientRect() : null
  const statusOverlaps = statusRect
    ? chips
        .filter((chip) => overlaps(chip.getBoundingClientRect(), statusRect))
        .map((chip) => chip.textContent.trim())
    : []
  const last = chips.at(-1)
  last.scrollIntoView({ block: 'nearest', inline: 'end' })
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      rail.scrollLeft = rail.scrollWidth - rail.clientWidth
      requestAnimationFrame(() => {
        resolve({
          rail: rect(rail),
          clientWidth: rail.clientWidth,
          scrollWidth: rail.scrollWidth,
          status: visible(status) ? rect(status) : null,
          statusBeforeRail: !statusRect || statusRect.right <= railRect.left + 0.5,
          cue: cue && visible(cue) ? { text: cue.textContent.trim(), rect: rect(cue) } : null,
          statusOverlaps,
          lastChip: rect(last),
          lastChipReachable: containedX(last.getBoundingClientRect(), rail.getBoundingClientRect()),
        })
      })
    })
  })
})()`

const helpExpression = `(async () => {
  const round = (value) => Number(value.toFixed(1))
  const rect = (element) => {
    const box = element.getBoundingClientRect()
    return {
      x: round(box.x),
      y: round(box.y),
      width: round(box.width),
      height: round(box.height),
      right: round(box.right),
      bottom: round(box.bottom),
    }
  }
  const containedY = (child, parent) =>
    child.top >= parent.top - 1 && child.bottom <= parent.bottom + 1
  window.PGSIMCITY.bus.emit('ui:help', { open: true })
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const body = document.querySelector('.help-body')
  const nav = document.querySelector('.help-nav')
  const targets = {}
  for (const name of ['legend', 'reading']) {
    const button = document.querySelector('[data-help-target="' + name + '"]')
    button?.click()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const heading = document.querySelector('[data-help-section="' + name + '"]')
    targets[name] = {
      button: button ? rect(button) : null,
      heading: heading ? rect(heading) : null,
      reachable: Boolean(heading && containedY(heading.getBoundingClientRect(), body.getBoundingClientRect())),
    }
  }
  return {
    dialog: rect(document.querySelector('.help-dialog')),
    body: rect(body),
    clientHeight: body.clientHeight,
    scrollHeight: body.scrollHeight,
    nav: nav ? rect(nav) : null,
    targets,
  }
})()`

const panelOverlayExpression = `(async () => {
  const round = (value) => Number(value.toFixed(1))
  const rect = (element) => {
    const box = element.getBoundingClientRect()
    return {
      x: round(box.x),
      y: round(box.y),
      width: round(box.width),
      height: round(box.height),
      right: round(box.right),
      bottom: round(box.bottom),
    }
  }
  const visible = (element) => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
  }
  const overlaps = (a, b) =>
    a.left < b.right - 0.5 &&
    a.right > b.left + 0.5 &&
    a.top < b.bottom - 0.5 &&
    a.bottom > b.top + 0.5

  window.PGSIMCITY.rig.focusOn(
    { target: [-95, -24, -65], distance: 24, dir: [0, 1, 0.01] },
    { instant: true },
  )
  const panel = document.querySelector('.pgc-host--right .pgc-panel')
  panel.style.transition = 'none'
  window.PGSIMCITY.bus.emit('select', { id: 'storage.datadir' })
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

  const panelRect = panel.getBoundingClientRect()
  const panelMeasurement = rect(panel)
  const overlays = Array.from(document.querySelectorAll('.zoom-context, .zoom-context__exit'))
    .filter(visible)
    .map((element) => ({
      name: element.className,
      rect: rect(element),
      intersectsPanel: overlaps(element.getBoundingClientRect(), panelRect),
    }))

  window.PGSIMCITY.bus.emit('select', { id: null })
  panel.style.removeProperty('transition')
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const zoomContext = document.querySelector('.zoom-context')

  return {
    panel: panelMeasurement,
    overlays,
    overlayVisibleAfterClose: visible(zoomContext),
  }
})()`

const labelCameraExpression = (camera) => `(() => {
  document.querySelector('.tour-first__no')?.click()
  window.PGSIMCITY.bus.emit('select', { id: null })
  window.PGSIMCITY.bus.emit('ui:help', { open: false })
  ${
    camera.distance === null
      ? 'window.PGSIMCITY.rig.home(true)'
      : `window.PGSIMCITY.rig.focusOn(
          { target: [-18, 0, -16], distance: ${camera.distance}, dir: [-200, 216, -326] },
          { instant: true },
        )`
  }
})()`

const labelAreaExpression = (theme, state) => `(() => {
  window.PGSIMCITY.setThemeMode(${JSON.stringify(theme)})

  const chips = Array.from(document.querySelectorAll('.lbl__chip')).filter((chip) => {
    const host = chip.closest('.lbl')
    const style = getComputedStyle(host)
    const box = chip.getBoundingClientRect()
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) > 0.01 &&
      box.width > 0 &&
      box.height > 0
    )
  })
  const destinations = chips
    .map((chip) => chip.closest('.lbl'))
    .filter((host) => host?.dataset.destination)
    .map((host) => host.querySelector('.lbl__name')?.textContent)
  let area = 0
  let maxWidth = 0
  let minFont = Infinity
  let clippedChips = 0
  let overlapPairs = 0
  let overlapArea = 0
  const boxes = []
  for (const chip of chips) {
    const box = chip.getBoundingClientRect()
    area += box.width * box.height
    maxWidth = Math.max(maxWidth, box.width)
    boxes.push(box)
    if (chip.scrollWidth > chip.clientWidth + 1 || chip.scrollHeight > chip.clientHeight + 1) {
      clippedChips++
    }
    const scale = box.width / chip.offsetWidth
    for (const text of chip.querySelectorAll('.lbl__name, .lbl__role, .lbl__read, .lbl__more')) {
      const style = getComputedStyle(text)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      minFont = Math.min(minFont, Number.parseFloat(style.fontSize) * scale)
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i]
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j]
      const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      if (overlapWidth > 0.5 && overlapHeight > 0.5) {
        overlapPairs++
        overlapArea += overlapWidth * overlapHeight
      }
    }
  }
  return {
    theme: ${JSON.stringify(theme)},
    state: ${JSON.stringify(state)},
    viewport: [innerWidth, innerHeight],
    cameraAltitude: Number(window.PGSIMCITY.rig.altitude.toFixed(1)),
    chips: chips.length,
    destinations,
    areaPercent: Number(((area / innerWidth / innerHeight) * 100).toFixed(3)),
    maxWidthPercent: Number(((maxWidth / innerWidth) * 100).toFixed(2)),
    minFont: Number(minFont.toFixed(2)),
    clippedChips,
    overlapPairs,
    overlapAreaPercent: Number(((overlapArea / innerWidth / innerHeight) * 100).toFixed(4)),
  }
})()`

try {
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: APP_URL })
  await waitForHud()
  // Measure the settled first-run surface. The previous tour invitation waited
  // 2.8 seconds, so sampling as soon as the vitals mounted missed real chrome.
  await sleep(3200)

  for (const viewport of LABEL_VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    for (const camera of LABEL_CAMERAS) {
      await evaluate(labelCameraExpression(camera))
      // Software WebGL can run at 1 fps. Two placement passes plus the chip
      // fade must finish before stale pre-resize rectangles stop counting.
      await sleep(LABEL_SETTLE_MS)
      for (const theme of THEMES) {
        const labelArea = await evaluate(labelAreaExpression(theme, camera.name))
        measurements.push({ labelArea })
        const where = `${viewport.width}x${viewport.height} ${theme} ${camera.name}`
        const areaBudget =
          viewport.width <= 480
            ? LABEL_PHONE_AREA_BUDGET_PERCENT
            : LABEL_DESKTOP_AREA_BUDGET_PERCENT
        if (labelArea.areaPercent > areaBudget) {
          failures.push(
            `labels: ${where} area ${labelArea.areaPercent}% exceeds ${areaBudget}%`,
          )
        }
        if (labelArea.chips > 0 && labelArea.minFont < 10.9) {
          failures.push(`labels: ${where} effective type is only ${labelArea.minFont}px`)
        }
        if (labelArea.clippedChips > 0) {
          failures.push(`labels: ${where} clips ${labelArea.clippedChips} chip(s)`)
        }
        if (labelArea.overlapAreaPercent > 0.01) {
          failures.push(`labels: ${where} overlap area reaches ${labelArea.overlapAreaPercent}%`)
        }
        if (viewport.width <= 700 && labelArea.maxWidthPercent > 56) {
          failures.push(`labels: ${where} chip width reaches ${labelArea.maxWidthPercent}%`)
        }
        if (
          viewport.width <= 700 &&
          (camera.name === 'default' || camera.name === 'max') &&
          labelArea.destinations.length < 3
        ) {
          failures.push(
            `labels: ${where} shows only ${labelArea.destinations.length} district name(s)`,
          )
        }
      }
    }
  }

  for (const viewport of VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    for (let attempt = 0; attempt < 20; attempt++) {
      const layoutReady = await evaluate(`(() => {
        const tools = document.querySelector('.hud-tools')
        return innerWidth <= 700
          ? tools?.parentElement?.classList.contains('hud-transport__dock')
          : tools?.parentElement?.classList.contains('hud-right')
      })()`)
      if (layoutReady) break
      await sleep(100)
    }
    for (const theme of THEMES) {
      const measurement = await evaluate(measureExpression(theme))
      measurements.push(measurement)
      if (measurement.vitals.length !== viewport.expectedVitals) {
        failures.push(
          `B1 ${viewport.width}px ${theme}: expected ${viewport.expectedVitals} visible vitals, found ${measurement.vitals.length}`,
        )
      }
      if (measurement.brandCheckpointOverlap) {
        failures.push(
          `B1 ${viewport.width}px ${theme}: checkpoint controls overlap the PGSimCity brand`,
        )
      }
      for (const vital of measurement.vitals) {
        if (!vital.insideViewport) {
          failures.push(`B1 ${viewport.width}px ${theme}: ${vital.name} is clipped by the vital viewport`)
        }
        if (vital.textClipped) {
          failures.push(`B1 ${viewport.width}px ${theme}: ${vital.name} text is clipped`)
        }
        if (vital.overlaps.length > 0) {
          failures.push(
            `B1 ${viewport.width}px ${theme}: ${vital.name} overlaps ${vital.overlaps.join(', ')}`,
          )
        }
      }
      if (viewport.width > 700) {
        for (const control of measurement.controls) {
          if (control.rect.x < -0.5 || control.rect.right > viewport.width + 0.5) {
            failures.push(`B1 ${viewport.width}px ${theme}: ${control.name} is outside the viewport`)
          }
        }
      }
      if (viewport.width === 390) {
        if (measurement.horizontalOverflow !== 0) {
          failures.push(`mobile: ${measurement.horizontalOverflow}px horizontal overflow`)
        }
        if (measurement.badTargets.length > 0) {
          failures.push(`mobile: ${measurement.badTargets.length} visible touch targets are under 44px`)
        }
        if (measurement.chromeCoverage !== null && measurement.chromeCoverage > 48.9) {
          failures.push(`mobile: ${measurement.chromeCoverage}% chrome coverage exceeds 48.9%`)
        }
      }
    }

    const scenario = await evaluate(scenarioExpression)
    measurements.push({ viewport: [viewport.width, viewport.height], scenario })
    if (!scenario.cue) failures.push(`B4 ${viewport.width}px: scenario overflow has no visible cue`)
    if (!scenario.statusBeforeRail) {
      failures.push(`B4 ${viewport.width}px: scenario status is still after the clipping edge`)
    }
    if (!scenario.lastChipReachable) {
      failures.push(`B4 ${viewport.width}px: the final scenario chip is not fully reachable`)
    }

    const help = await evaluate(helpExpression)
    measurements.push({ viewport: [viewport.width, viewport.height], help })
    if (!help.nav) failures.push(`B5 ${viewport.width}px: help has no visible section navigation`)
    for (const [name, target] of Object.entries(help.targets)) {
      if (!target.button || !target.heading || !target.reachable) {
        failures.push(`B5 ${viewport.width}px: help section "${name}" is not directly reachable`)
      }
    }
    await evaluate("window.PGSIMCITY.bus.emit('ui:help', { open: false })")

    if (viewport.width === 390) {
      const panelOverlay = await evaluate(panelOverlayExpression)
      measurements.push({ viewport: [viewport.width, viewport.height], panelOverlay })
      for (const overlay of panelOverlay.overlays) {
        if (overlay.intersectsPanel) {
          failures.push(`mobile: ${overlay.name} intersects the open inspector`)
        }
      }
      if (panelOverlay.overlays.length > 0) {
        failures.push(`mobile: ${panelOverlay.overlays.length} close-zoom affordances remain visible`)
      }
      if (!panelOverlay.overlayVisibleAfterClose) {
        failures.push('mobile: close-zoom affordance does not return after the inspector closes')
      }
    }
  }
} finally {
  await run.cleanup()
  removeProcessCleanup()
}

console.log(JSON.stringify({ measurements, failures }, null, 2))
for (const measurement of measurements) {
  if (measurement.chromeCoverage == null) continue
  console.log(
    `HUD chrome: ${measurement.viewport[0]}x${measurement.viewport[1]} ${measurement.theme} ${measurement.chromeCoverage}%`,
  )
}
if (failures.length > 0) {
  console.error(`HUD layout verification failed with ${failures.length} regression(s).`)
  process.exitCode = 1
}
