// CDP driver: boot a page in headless Chrome, collect console + exceptions,
// wait real wall-clock time for software WebGL, screenshot, probe app state.
// Named *-keep so the scratchpad sweep does not delete it.
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, rmdirSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquireCdpProfile } from './cdp-profile.mjs'
import { createCdpRunCleanup, installProcessCleanup } from './cdp-run.mjs'

/* ---------------------------------------------------------------------------
 * CONCURRENCY GATE.
 *
 * Each of these Chromes renders WebGL through SwiftShader on the CPU, which
 * spikes to 1-2 GiB while a frame is in flight. Ten agents screenshotting at
 * once is what pushed this box into swap and then into the OOM killer, twice.
 *
 * The gate is a directory-based semaphore: mkdir is atomic on POSIX, so
 * whoever creates slot N owns it. Stale slots (a killed run) are reaped by age.
 * ------------------------------------------------------------------------- */
const GATE = '/tmp/claude-1000/cdp-gate'
const MAX_CHROMES = Number(process.env.CDP_MAX || 2)
const SLOT_STALE_MS = 10 * 60 * 1000

let heldSlot = null

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
  try { mkdirSync(GATE, { recursive: true }) } catch {}
  for (let waited = 0; waited < 15 * 60 * 1000; waited += 3000) {
    reapStaleSlots()
    for (let i = 0; i < MAX_CHROMES; i++) {
      try {
        mkdirSync(`${GATE}/slot${i}`)
        heldSlot = `${GATE}/slot${i}`
        return
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  console.error('[cdp] gate timeout — proceeding anyway')
}

function releaseSlot() {
  if (!heldSlot) return
  try { rmdirSync(heldSlot) } catch {}
  heldSlot = null
}

const URL_ = process.argv[2] || 'http://localhost:5173/'
const OUT = process.argv[3] || 'shot.png'
const WAIT_MS = Number(process.argv[4] || 45000)
const W = Number(process.argv[5] || 1280)
const H = Number(process.argv[6] || 760)
const PRE = process.argv[7] || ''
const PORT = Number(process.env.CDP_PORT || 9470)
const BLOCK_URLS = (process.env.CDP_BLOCK_URLS || '').split(',').filter(Boolean)
const LOG_URLS = (process.env.CDP_LOG_URLS || '').split(',').filter(Boolean)
const ALLOW_ANALYTICS = process.env.CDP_ALLOW_ANALYTICS === '1'
const REDUCED_MOTION = process.env.CDP_REDUCED_MOTION === '1'
const MOBILE = process.env.CDP_MOBILE === '1'
const SEQUENCE = process.env.CDP_SEQUENCE || ''
const profile = acquireCdpProfile({
  explicitProfile: process.env.CDP_PROFILE,
  port: PORT,
})
const run = createCdpRunCleanup({ profile, releaseSlot })
const removeProcessCleanup = installProcessCleanup(() => run.cleanup())

await acquireSlot()

const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  // This machine needs all three or DevToolsActivePort never appears.
  '--ozone-platform=headless', '--no-proxy-server', '--password-store=basic',
  `--remote-debugging-port=${PORT}`, `--window-size=${W},${H}`,
  '--no-first-run', '--disable-extensions',
  // Keep one renderer from eating the box while SwiftShader rasterises.
  '--js-flags=--max-old-space-size=512', '--disable-gpu-shader-disk-cache',
  '--renderer-process-limit=1', '--disable-background-networking',
  `--user-data-dir=${profile.path}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] })
run.trackChild(chrome)
profile.setOwner(chrome.pid)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targetWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const page = (await r.json()).find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error('devtools never came up')
}

const ws = new WebSocket(await targetWs())
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
run.trackSocket(ws)

let id = 0
const pending = new Map()
const logs = []
const loggedRequests = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); return
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(`[${m.params.type}] ${(m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')}`.slice(0, 300))
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    logs.push(`[EXCEPTION] ${d.text} ${d.exception?.description || ''}`.slice(0, 600))
  } else if (m.method === 'Log.entryAdded') {
    logs.push(`[${m.params.entry.level}] ${m.params.entry.text}`.slice(0, 300))
  } else if (
    m.method === 'Network.requestWillBeSent'
    && LOG_URLS.some((part) => m.params.request.url.includes(part))
  ) {
    loggedRequests.set(m.params.requestId, m.params.request.url)
    logs.push(
      `[REQUEST] ${m.params.request.method} ${m.params.request.url} ${m.params.request.postData || ''}`,
    )
  } else if (
    m.method === 'Network.responseReceived'
    && loggedRequests.has(m.params.requestId)
  ) {
    const dropped = m.params.response.headers['x-plausible-dropped']
      ?? m.params.response.headers['X-Plausible-Dropped']
      ?? ''
    logs.push(
      `[RESPONSE] ${m.params.response.status} ${loggedRequests.get(m.params.requestId)}`
      + `${dropped ? ` x-plausible-dropped=${dropped}` : ''}`,
    )
  } else if (
    m.method === 'Network.loadingFailed'
    && BLOCK_URLS.length
  ) {
    logs.push(`[BLOCKED] ${m.params.errorText} ${m.params.blockedReason || ''}`)
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id; pending.set(mid, { resolve, reject })
  ws.send(JSON.stringify({ id: mid, method, params }))
})

await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('Network.enable')
if (BLOCK_URLS.length) await send('Network.setBlockedURLs', { urls: BLOCK_URLS })
if (REDUCED_MOTION) {
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
}
if (ALLOW_ANALYTICS) {
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__plausible = true',
  })
  await send('Network.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  })
}
await send('Emulation.setDeviceMetricsOverride', {
  width: W,
  height: H,
  deviceScaleFactor: 1,
  mobile: MOBILE,
})
if (MOBILE) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await send('Page.navigate', { url: URL_ })
await sleep(WAIT_MS)
if (PRE) {
  try {
    const result = await send('Runtime.evaluate', { expression: PRE, awaitPromise: true, returnByValue: true })
    logs.push(`[PRE] ${result.result.value ?? result.result.description ?? result.result.type}`)
  } catch (e) { logs.push('[PRE-FAIL] ' + e.message) }
  await sleep(9000)
}

if (SEQUENCE) {
  try {
    const moduleUrl = pathToFileURL(resolve(SEQUENCE)).href
    const sequence = await import(moduleUrl)
    if (typeof sequence.runSequence !== 'function') {
      throw new Error(`${SEQUENCE} does not export runSequence()`)
    }
    await sequence.runSequence({
      send,
      logs,
      output: OUT,
      width: W,
      height: H,
      url: URL_,
    })
    console.log('=== CONSOLE (' + logs.length + ') ===\n' + logs.slice(0, 40).join('\n'))
  } finally {
    await run.cleanup()
    removeProcessCleanup()
  }
  process.exit(0)
}

writeFileSync(OUT, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))

const probe = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    bootDone:(document.getElementById('boot')?.className||'').includes('done'),
    status:document.getElementById('boot-status')?.textContent,
    canvas:!!document.querySelector('#canvas-root canvas'),
    labels:document.getElementById('labels-root')?.querySelectorAll('div').length ?? -1,
    components:(window.PGSIMCITY?.registry?.all()||[]).length,
    walkOn: !!window.PGSIMCITY?.walk?.enabled,
    grounded: !!window.PGSIMCITY?.walk?.grounded,
    eyeY: Number((window.PGSIMCITY?.gfx?.camera?.position?.y ?? -1).toFixed(2)),
    boxes: window.PGSIMCITY?.collision?.boxCount,
    fps:Math.round(window.PGSIMCITY?.gfx?.fps ?? -1),
    quality:window.PGSIMCITY?.gfx?.quality?.level,
    simT:Math.round(window.PGSIMCITY?.sim?.state?.t ?? -1),
    hitPct:Number((window.PGSIMCITY?.sim?.state?.stats?.cacheHitPct ?? -1).toFixed(1)),
    ckptCount:window.PGSIMCITY?.sim?.state?.checkpoint?.count,
    vacRuns:window.PGSIMCITY?.sim?.state?.autovac?.totalRuns,
    backends:(window.PGSIMCITY?.sim?.state?.backends||[]).filter(b=>b.active).length,
  })`, returnByValue: true,
})
console.log('=== PROBE ===\n' + probe.result.value)
console.log('=== CONSOLE (' + logs.length + ') ===\n' + logs.slice(0, 25).join('\n'))
await run.cleanup()
removeProcessCleanup()
