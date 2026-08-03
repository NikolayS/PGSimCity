import { spawn } from 'node:child_process'
import {
  mkdirSync,
  readdirSync,
  rmdirSync,
  statSync,
} from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'

import { acquireCdpProfile } from '../tools/cdp-profile.mjs'
import { createCdpRunCleanup } from '../tools/cdp-run.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const GATE = '/tmp/claude-1000/cdp-gate'
const MAX_CHROMES = 2
const SLOT_STALE_MS = 10 * 60 * 1000

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function reapStaleSlots() {
  try {
    for (const name of readdirSync(GATE)) {
      const path = `${GATE}/${name}`
      try {
        if (Date.now() - statSync(path).mtimeMs > SLOT_STALE_MS) rmdirSync(path)
      } catch {}
    }
  } catch {}
}

async function acquireSlot() {
  mkdirSync(GATE, { recursive: true })
  for (let waited = 0; waited < 15 * 60 * 1000; waited += 250) {
    reapStaleSlots()
    for (let index = 0; index < MAX_CHROMES; index += 1) {
      const path = `${GATE}/slot${index}`
      try {
        mkdirSync(path)
        return () => {
          try { rmdirSync(path) } catch {}
        }
      } catch {}
    }
    await sleep(250)
  }
  throw new Error('timed out waiting for a headless browser slot')
}

async function reservePort() {
  const server = createNetServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  if (!port) throw new Error('could not reserve a CDP port')
  return port
}

async function waitForTarget(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const page = (await response.json()).find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(250)
  }
  throw new Error('headless Chrome did not expose a page target')
}

async function waitForPage(send, readySelector) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const result = await send('Runtime.evaluate', {
      expression: `document.readyState === 'complete' && Boolean(document.querySelector(${JSON.stringify(readySelector)}))`,
      returnByValue: true,
    })
    if (result.result.value === true) return
    await sleep(250)
  }
  throw new Error(`page did not render ${readySelector}`)
}

const MEASURE_EXPRESSION = `(() => {
  const describe = (element) => {
    if (element.id) return '#' + element.id
    const classes = Array.from(element.classList || []).slice(0, 2)
    return element.tagName.toLowerCase() + classes.map((name) => '.' + name).join('')
  }
  return Array.from(document.querySelectorAll('*')).filter((element) => (
    Number(getComputedStyle(element).getPropertyValue('--pg-disclosure')) > 0
  )).map((element) => {
    const marker = getComputedStyle(element).getPropertyValue('--pg-disclosure').trim()
    const pseudo = marker === '2' ? '::after' : null
    const style = getComputedStyle(element, pseudo)
    const renderedText = pseudo
      ? style.content.replace(/^['"]|['"]$/g, '')
      : element.textContent
    let hiddenBy = null
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor)
      if (ancestorStyle.display === 'none') {
        hiddenBy = describe(ancestor) + ' has display: none'
        break
      }
      if (ancestorStyle.visibility !== 'visible') {
        hiddenBy = describe(ancestor) + ' has visibility: ' + ancestorStyle.visibility
        break
      }
    }
    return {
      id: element.dataset.disclosure,
      text: renderedText.replace(/\\s+/g, ' ').trim(),
      fontSize: Number.parseFloat(style.fontSize),
      display: style.display,
      visibility: style.visibility,
      hiddenBy,
    }
  })
})()`

async function evaluate(send, expression, options = {}) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    ...options,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result.value
}

/** Inspect pages after a real 390x844 browser layout in one shared browser. */
export async function inspectRenderedPages(pages, inspect) {
  const releaseSlot = await acquireSlot()
  const cdpPort = await reservePort()
  const vitePort = await reservePort()
  const profile = acquireCdpProfile({ port: cdpPort })
  const run = createCdpRunCleanup({ profile, releaseSlot })
  let vite

  try {
    vite = await createViteServer({
      root: ROOT,
      logLevel: 'silent',
      server: {
        host: '127.0.0.1',
        port: vitePort,
        strictPort: true,
      },
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Vite did not expose a local port')

    const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
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
      `--remote-debugging-port=${cdpPort}`,
      '--window-size=390,844',
      '--no-first-run',
      '--disable-extensions',
      '--disable-background-networking',
      '--renderer-process-limit=1',
      `--user-data-dir=${profile.path}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore'] })
    run.trackChild(chrome)
    profile.setOwner(chrome.pid)

    const socket = new WebSocket(await waitForTarget(cdpPort))
    await new Promise((resolve, reject) => {
      socket.onopen = resolve
      socket.onerror = reject
    })
    run.trackSocket(socket)

    let messageId = 0
    const pending = new Map()
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (!message.id || !pending.has(message.id)) return
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++messageId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })

    await send('Runtime.enable')
    await send('Page.enable')
    await send('Network.enable')
    await send('Network.setBlockedURLs', { urls: ['*plausible.io*'] })
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    })
    await send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    })

    const origin = `http://127.0.0.1:${address.port}`
    const reports = []
    for (const page of pages) {
      await send('Page.navigate', { url: `${origin}${page.path}` })
      await waitForPage(send, page.readySelector)
      if (page.prepare) await evaluate(send, page.prepare)
      const viewport = await evaluate(send, '({ width: innerWidth, height: innerHeight })')
      reports.push(await inspect({
        evaluate: (expression, options) => evaluate(send, expression, options),
        page,
        viewport,
      }))
    }
    return reports
  } finally {
    try {
      await vite?.close()
    } finally {
      await run.cleanup()
    }
  }
}

/** Measure marked disclosure nodes on a page already owned by a browser audit. */
export async function measureDisclosurePage(evaluatePage, page, viewport) {
  const authoredDisclosureCount = await evaluatePage(
    `document.querySelectorAll('[data-disclosure]').length`,
  )
  const disclosures = await evaluatePage(MEASURE_EXPRESSION)
  let markerProbe
  if (page.probeMarker) {
    await evaluatePage(`(() => {
      const probe = document.createElement('span')
      probe.id = 'temporary-disclosure-probe'
      probe.textContent = 'TEMPORARY DISCLOSURE PROBE'
      probe.style.cssText = 'display:block;visibility:visible;font-size:1px'
      document.body.append(probe)
    })()`)
    const unmarked = await evaluatePage(MEASURE_EXPRESSION)
    await evaluatePage(`document.querySelector('#temporary-disclosure-probe').dataset.disclosure = 'temporary-probe'`)
    const marked = await evaluatePage(MEASURE_EXPRESSION)
    await evaluatePage(`document.querySelector('#temporary-disclosure-probe').remove()`)
    markerProbe = {
      unmarkedIncluded: unmarked.some((item) => item.text === 'TEMPORARY DISCLOSURE PROBE'),
      marked: marked.find((item) => item.id === 'temporary-probe'),
    }
  }
  return {
    name: page.name,
    viewport,
    authoredDisclosureCount,
    disclosures,
    markerProbe,
  }
}

/** Measure marked disclosure nodes after a real 390x844 browser layout. */
export async function measureDisclosurePages(pages) {
  return inspectRenderedPages(pages, ({ evaluate, page, viewport }) => (
    measureDisclosurePage(evaluate, page, viewport)
  ))
}

export function disclosureFailures(reports, floor = 9) {
  const failures = []
  for (const report of reports) {
    for (const disclosure of report.disclosures) {
      const label = disclosure.text || disclosure.id
      if (disclosure.hiddenBy) failures.push(`${report.name} · ${label}: hidden (${disclosure.hiddenBy})`)
      if (disclosure.fontSize < floor) {
        failures.push(`${report.name} · ${label}: ${disclosure.fontSize}px is below the ${floor}px floor`)
      }
    }
  }
  return failures
}

const TOUCH_TARGET_EXPRESSION = `(async () => {
  const describe = (element) => {
    if (element.id) return '#' + element.id
    const ariaLabel = element.getAttribute('aria-label')
    if (ariaLabel) return ariaLabel
    const text = element.textContent.replace(/\\s+/g, ' ').trim()
    if (text) return text.slice(0, 80)
    const name = element.getAttribute('name')
    return name ? element.tagName.toLowerCase() + '[name="' + name + '"]' : element.tagName.toLowerCase()
  }
  const hasClickHandler = (element) => {
    if (element.tagName !== 'A') return true
    if (typeof element.onclick === 'function') return true
    if (typeof getEventListeners !== 'function') return false
    return (getEventListeners(element).click || []).length > 0
  }
  const isRenderedControl = (element) => {
    if (!hasClickHandler(element)) return false
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const parent = element.parentElement
    const parentStyle = parent && getComputedStyle(parent)
    const parentRect = parent && parent.getBoundingClientRect()
    const hiddenByOwnCss = parentStyle
      && parentStyle.display !== 'none'
      && parentStyle.visibility === 'visible'
      && Number(parentStyle.opacity) > 0
      && parentRect.width > 0
      && parentRect.height > 0
      && (style.display === 'none'
        || style.visibility !== 'visible'
        || Number(style.opacity) === 0
        || style.pointerEvents === 'none')
    return hiddenByOwnCss || (style.display !== 'none'
      && style.visibility === 'visible'
      && Number(style.opacity) > 0
      && style.pointerEvents !== 'none'
      && rect.width > 0
      && rect.height > 0)
  }
  const controls = Array.from(document.querySelectorAll(
    'button, a, [role="button"], input:not([type="hidden"]), select',
  )).filter(isRenderedControl)
  const measured = []
  for (const element of controls) {
    element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' })
    const rect = element.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    const hit = document.elementFromPoint(centerX, centerY)
    measured.push({
      label: describe(element),
      width: rect.width,
      height: rect.height,
      hitTestable: hit === element || element.contains(hit),
      hit: hit ? describe(hit) : null,
    })
  }
  return measured
})()`

/** Measure every rendered semantic touch control on a page already owned by an audit. */
export async function measureTouchTargetPage(evaluatePage, page, viewport) {
  const controls = await evaluatePage(TOUCH_TARGET_EXPRESSION, {
    includeCommandLineAPI: true,
  })
  let probe
  if (page.probeTouchTarget) {
    await evaluatePage(`(() => {
      const button = document.createElement('button')
      button.id = 'temporary-touch-target-probe'
      button.textContent = 'TEMPORARY TOUCH TARGET PROBE'
      button.style.cssText = 'position:fixed;z-index:2147483647;left:100px;top:100px;box-sizing:border-box;width:1px;height:1px;min-width:0;min-height:0;padding:0;border:0'
      document.body.append(button)
    })()`)
    const probed = await evaluatePage(TOUCH_TARGET_EXPRESSION, {
      includeCommandLineAPI: true,
    })
    await evaluatePage(`document.querySelector('#temporary-touch-target-probe').remove()`)
    probe = probed.find((control) => control.label === '#temporary-touch-target-probe')
  }
  return {
    name: page.name,
    viewport,
    controls,
    probe,
  }
}

/** Measure rendered semantic controls after a real 390x844 touch layout. */
export async function measureTouchTargetPages(pages) {
  return inspectRenderedPages(pages, ({ evaluate, page, viewport }) => (
    measureTouchTargetPage(evaluate, page, viewport)
  ))
}

export function touchTargetFailures(reports, floor = 44) {
  const failures = []
  for (const report of reports) {
    for (const control of report.controls) {
      if (control.width < floor || control.height < floor) {
        failures.push(
          `${report.name} · ${control.label}: ${control.width.toFixed(2)} × ${control.height.toFixed(2)}px is below ${floor} × ${floor}px`,
        )
      }
      if (!control.hitTestable) {
        const hit = control.hit ? `hit ${control.hit}` : 'hit nothing'
        failures.push(`${report.name} · ${control.label}: centre ${hit}`)
      }
    }
  }
  return failures
}

/** Measure the live City disclosures after each real renderer-quality transition. */
export async function measureTierDisclosurePage(evaluatePage, page, viewport, levels) {
  const reports = []
  for (const level of levels) {
    if (page.prepareDisclosures) await evaluatePage(page.prepareDisclosures)
    const quality = await evaluatePage(`new Promise((resolve) => {
      window.PGSIMCITY.bus.emit('quality', { level: ${JSON.stringify(level)} })
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve({ ...window.PGSIMCITY.gfx.quality })
      }))
    })`)
    const tierPage = { ...page, name: `${page.name} · ${level}` }
    const disclosure = await measureDisclosurePage(evaluatePage, tierPage, viewport)
    reports.push({ level, quality, disclosure })
  }
  return reports
}

/** Measure touch targets at every tier from a fresh, unmodified page state. */
export async function measureTierTouchTargetPages(pages, levels) {
  return inspectRenderedPages(pages, async ({ evaluate, page, viewport }) => {
    const reports = []
    for (const level of levels) {
      const quality = await evaluate(`new Promise((resolve) => {
        window.PGSIMCITY.bus.emit('quality', { level: ${JSON.stringify(level)} })
        requestAnimationFrame(() => requestAnimationFrame(() => {
          resolve({ ...window.PGSIMCITY.gfx.quality })
        }))
      })`)
      const tierPage = { ...page, name: `${page.name} · ${level}` }
      const touch = await measureTouchTargetPage(evaluate, tierPage, viewport)
      reports.push({ level, quality, touch })
    }
    return reports
  })
}
