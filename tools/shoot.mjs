// CDP driver: boot a page in headless Chrome, collect console + exceptions,
// wait real wall-clock time for software WebGL, screenshot, probe app state.
// Named *-keep so the scratchpad sweep does not delete it.
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, rmdirSync, readdirSync, statSync } from 'node:fs'

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
const MAX_CHROMES = Number(process.env.CDP_MAX || 3)
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

for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
  process.on(sig, () => { releaseSlot(); if (sig !== 'exit') process.exit(1) })
}

await acquireSlot()


const URL_ = process.argv[2] || 'http://localhost:5173/'
const OUT = process.argv[3] || 'shot.png'
const WAIT_MS = Number(process.argv[4] || 45000)
const W = Number(process.argv[5] || 1280)
const H = Number(process.argv[6] || 760)
const PRE = process.argv[7] || ''
const PORT = Number(process.env.CDP_PORT || 9470)
const PROFILE = process.env.CDP_PROFILE || `/tmp/claude-1000/-home-tars/bf57591f-d077-4c2a-80f3-46cf3b053fba/scratchpad/kprof${PORT}`

const chrome = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  // This machine needs all three or DevToolsActivePort never appears.
  '--ozone-platform=headless', '--no-proxy-server', '--password-store=basic',
  `--remote-debugging-port=${PORT}`, `--window-size=${W},${H}`,
  '--no-first-run', '--disable-extensions',
  // Keep one renderer from eating the box while SwiftShader rasterises.
  '--js-flags=--max-old-space-size=512', '--disable-gpu-shader-disk-cache',
  '--renderer-process-limit=1', '--disable-background-networking',
  `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] })

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

let id = 0
const pending = new Map()
const logs = []
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
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id; pending.set(mid, { resolve, reject })
  ws.send(JSON.stringify({ id: mid, method, params }))
})

await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: URL_ })
await sleep(WAIT_MS)
if (PRE) {
  try { await send('Runtime.evaluate', { expression: PRE, awaitPromise: true }) } catch (e) { logs.push('[PRE-FAIL] ' + e.message) }
  await sleep(9000)
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
chrome.kill(); process.exit(0)
