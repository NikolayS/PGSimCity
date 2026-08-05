import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const CONDITIONS = ['before', 'after']
const THEMES = ['day', 'night']
const LEVELS = ['low', 'reduced', 'medium', 'high', 'ultra']
const FRAME_BUDGET_MS = 1000 / 45
const MODE = process.env.PG_LIT_EVIDENCE_MODE || 'desktop'

const DESKTOP_STATIONS = [
  { id: 'home', label: '400 m establishing view', kind: 'home' },
  { id: 'clients', label: 'Clients at the south perimeter', kind: 'focus', target: 'client.pool' },
  { id: 'wal', label: 'WAL at the east perimeter', kind: 'focus', target: 'wal.vault' },
  { id: 'standby', label: 'Standby at the south-west perimeter', kind: 'focus', target: 'replica.standby' },
  {
    id: 'eye',
    label: 'First-person east-perimeter kerb',
    kind: 'walk-edge',
    themes: ['day'],
  },
]

const MOBILE_STATIONS = [
  { id: 'home', label: '400 m establishing view', kind: 'home' },
  { id: 'clients', label: 'Clients at the south perimeter', kind: 'focus', target: 'client.pool' },
  { id: 'wal', label: 'WAL at the east perimeter', kind: 'focus', target: 'wal.vault' },
]

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result.value
}

const BOOT = `(async () => {
  if (window.__PG_LIT_STRUCTURE) return window.__PG_LIT_STRUCTURE.describe()
  const themeModule = await import('/src/core/theme.ts')
  const pg = window.PGSIMCITY
  const renderFixed = pg.gfx.render.bind(pg.gfx)
  let automaticRendering = true
  pg.gfx.render = (dt, rawDt) => {
    if (automaticRendering) renderFixed(dt, Math.min(rawDt ?? dt, 1 / 60))
  }

  let cap = null
  let BasicMaterial = null
  let StandardMaterial = null
  pg.gfx.scene.traverse((object) => {
    const source = object.material
    const materials = Array.isArray(source) ? source : source ? [source] : []
    if (!BasicMaterial) {
      const basic = materials.find((material) => material.isMeshBasicMaterial === true)
      if (basic) BasicMaterial = basic.constructor
    }
    if (!StandardMaterial) {
      const standard = materials.find((material) => material.isMeshStandardMaterial === true)
      if (standard) StandardMaterial = standard.constructor
    }
    if (materials.some((material) => material.name === 'ground.kerbTop')) cap = object
  })
  if (!cap || Array.isArray(cap.material)) throw new Error('Expected one ground.kerbTop mesh')
  if (!BasicMaterial) throw new Error('No MeshBasicMaterial constructor found')
  if (!StandardMaterial) throw new Error('No MeshStandardMaterial constructor found')
  const source = cap.material
  const authored = source.userData.pgNight?.color ?? source.color.getHex()
  const before = source.isMeshBasicMaterial === true ? source : new BasicMaterial({
    color: authored,
    side: source.side,
    transparent: false,
    opacity: 1,
    depthTest: source.depthTest,
    depthWrite: source.depthWrite,
    colorWrite: source.colorWrite,
    fog: source.fog,
    toneMapped: false,
  })
  const after = source.isMeshStandardMaterial === true ? source : new StandardMaterial({
    color: authored,
    side: source.side,
    transparent: false,
    opacity: 1,
    depthTest: source.depthTest,
    depthWrite: source.depthWrite,
    colorWrite: source.colorWrite,
    fog: source.fog,
    roughness: 0.86,
    metalness: 0.08,
  })
  before.name = 'ground.kerbTop'
  after.name = 'ground.kerbTop'
  before.userData.pgLitEvidence = true
  after.userData.pgLitEvidence = true

  const apply = (condition) => {
    cap.material = condition === 'after' ? after : before
    themeModule.paintSceneMaterial(cap.material, pg.themeMode())
    cap.material.needsUpdate = true
    document.body.dataset.litStructure = condition
  }

  const forceQuality = (level) => {
    const alternate = level === 'low' ? 'reduced' : 'low'
    pg.gfx.setQuality(alternate)
    pg.gfx.setQuality(level)
  }

  const stage = (station) => {
    pg.bus.emit('hover', { id: null })
    pg.bus.emit('select', { id: null })
    if (station.kind !== 'walk' && station.kind !== 'walk-edge' && pg.walk.enabled) {
      pg.bus.emit('camera:mode', { mode: 'orbit' })
    }
    if (station.kind === 'home') pg.rig.home(true)
    else if (station.kind === 'focus') {
      const component = pg.registry.get(station.target)
      if (!component) throw new Error('Missing evidence target ' + station.target)
      pg.rig.focusOn(component.focus, { instant: true })
    } else {
      if (!pg.walk.enabled) pg.bus.emit('camera:mode', { mode: 'walk' })
      let pose = station.pose
      if (station.kind === 'walk-edge') {
        const ring = pg.registry.get('world.ground')?.object.userData.slonik?.ring
        if (!ring) throw new Error('Ground perimeter ring is unavailable')
        let bx = -Infinity
        let bz = 0
        for (let i = 0; i < ring.length; i += 2) {
          if (ring[i] > bx && ring[i + 1] > -100 && ring[i + 1] < 120) {
            bx = ring[i]
            bz = ring[i + 1]
          }
        }
        const length = Math.hypot(bx, bz)
        const inwardX = -bx / length
        const inwardZ = -bz / length
        const x = bx + inwardX * 10
        const z = bz + inwardZ * 10
        pose = {
          x,
          y: 0.05,
          z,
          yaw: Math.atan2(-(bx - x), -(bz - z)),
          pitch: -0.04,
        }
      }
      pg.walk.setPose(pose)
      // Evidence needs one eye transform, not a 5 cm gravity-settle race
      // between conditions. The pose is already a valid first-person camera.
      pg.walk.update = () => {}
    }
    document.querySelectorAll('.hud-toast').forEach((toast) => toast.remove())
  }

  const renderSettled = () => {
    const gl = pg.gfx.renderer.getContext()
    automaticRendering = false
    renderFixed(1 / 60, 1 / 60)
    gl.finish()
    renderFixed(1 / 60, 1 / 60)
    gl.finish()
    automaticRendering = true
  }

  const measureFrames = (count) => new Promise((resolve) => {
    const samples = []
    const gl = pg.gfx.renderer.getContext()
    automaticRendering = false
    let warmed = false
    const frame = () => {
      const started = performance.now()
      renderFixed(1 / 60, 1 / 60)
      gl.finish()
      const elapsed = performance.now() - started
      if (!warmed) warmed = true
      else samples.push(elapsed)
      if (samples.length < count) requestAnimationFrame(frame)
      else {
        automaticRendering = true
        resolve(samples)
      }
    }
    requestAnimationFrame(frame)
  })

  const visibleLabels = () => document.getElementById('labels-root')?.style.visibility === 'hidden'
    ? []
    : [...document.querySelectorAll('#labels-root .lbl.is-on')]
    .map((element) => element.querySelector('.lbl__name')?.textContent?.trim() || '')
    .filter(Boolean)

  window.__PG_LIT_STRUCTURE = {
    apply,
    forceQuality,
    stage,
    renderSettled,
    measureFrames,
    describe() {
      return {
        condition: document.body.dataset.litStructure || null,
        quality: pg.gfx.quality.level,
        theme: pg.themeMode(),
        material: {
          name: cap.material.name,
          type: cap.material.type,
          lit: cap.material.isMeshStandardMaterial === true,
          color: '#' + cap.material.color.getHex().toString(16).padStart(6, '0'),
          roughness: cap.material.roughness ?? null,
          metalness: cap.material.metalness ?? null,
        },
        camera: {
          mode: pg.rig.mode,
          position: pg.gfx.camera.position.toArray().map((value) => Number(value.toFixed(3))),
          quaternion: pg.gfx.camera.quaternion.toArray().map((value) => Number(value.toFixed(6))),
        },
        visibleLabels: visibleLabels(),
        rendererInfo: {
          calls: pg.gfx.renderer.info.render.calls,
          triangles: pg.gfx.renderer.info.render.triangles,
          points: pg.gfx.renderer.info.render.points,
          lines: pg.gfx.renderer.info.render.lines,
        },
      }
    },
  }
  apply('after')
  return window.__PG_LIT_STRUCTURE.describe()
})()`

async function prepare(send) {
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    ready = await evaluate(send, 'Boolean(window.PGSIMCITY?.gfx?.scene)')
    if (ready) break
    await sleep(500)
  }
  if (!ready) throw new Error('PGSimCity did not finish booting within 60 seconds')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  await evaluate(send, `(() => {
    document.querySelector('.tour-first__no')?.click()
    window.PGSIMCITY.bus.emit('select', { id: null })
    window.PGSIMCITY.bus.emit('hover', { id: null })
    window.PGSIMCITY.bus.emit('ui:help', { open: false })
    window.PGSIMCITY.sim.reset()
    window.PGSIMCITY.sim.setKnob('paused', true)
    window.PGSIMCITY.rig.home(true)
    const labels = document.getElementById('labels-root')
    if (labels) labels.style.visibility = 'hidden'
    document.querySelectorAll('.hud-toast').forEach((toast) => toast.remove())
  })()`)
  await sleep(1_000)
  return evaluate(send, BOOT)
}

async function screenshots({ send, logs, output, width, height }) {
  const directory = dirname(output)
  mkdirSync(directory, { recursive: true })
  const boot = await prepare(send)
  const stations = MODE === 'mobile'
    ? MOBILE_STATIONS
    : MODE === 'eye'
      ? DESKTOP_STATIONS.filter((station) => station.id === 'eye')
      : DESKTOP_STATIONS
  const records = []
  await evaluate(send, `window.__PG_LIT_STRUCTURE.forceQuality('high')`)

  for (const theme of THEMES) {
    await evaluate(send, `window.PGSIMCITY.setThemeMode(${JSON.stringify(theme)}, { persist: false })`)
    for (const station of stations) {
      if (station.themes && !station.themes.includes(theme)) continue
      for (const condition of CONDITIONS) {
        await evaluate(send, `(() => {
          window.__PG_LIT_STRUCTURE.apply(${JSON.stringify(condition)})
          window.__PG_LIT_STRUCTURE.stage(${JSON.stringify(station)})
        })()`)
        await sleep(250)
        await evaluate(send, 'window.__PG_LIT_STRUCTURE.renderSettled()')
        const state = await evaluate(send, 'window.__PG_LIT_STRUCTURE.describe()')
        const filename = `${condition}-${theme}-${station.id}-${width}x${height}.png`
        const path = join(directory, filename)
        const shot = await send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(path, Buffer.from(shot.data, 'base64'))
        records.push({ condition, theme, station: station.id, label: station.label, screenshot: filename, ...state })
      }
    }
  }

  const reportPath = join(directory, `screenshots-${MODE}.json`)
  writeFileSync(reportPath, `${JSON.stringify({
    complete: true,
    protocol: {
      viewport: [width, height],
      mode: MODE,
      quality: 'high',
      simulation: 'deterministic reset, then paused',
      labels: 'Floating map labels are hidden in both conditions so district identity is judged from semantic colour and form without a text crutch.',
      comparison: 'The before condition replaces only ground.kerbTop with an unlit material in browser memory. Geometry, draw count, camera, simulation, renderer thresholds, GTAO, PMREM and every semantic material remain unchanged.',
    },
    boot,
    records,
  }, null, 2)}\n`)
  logs.push(`[LIT-STRUCTURE] ${records.length} screenshots -> ${reportPath}`)
}

async function timings({ send, logs, output, width, height }) {
  mkdirSync(dirname(output), { recursive: true })
  const boot = await prepare(send)
  await evaluate(send, `(() => {
    window.PGSIMCITY.setThemeMode('day', { persist: false })
    window.__PG_LIT_STRUCTURE.stage({ id: 'home', kind: 'home' })
  })()`)
  const measurements = []
  const passes = [
    { id: 'forward', conditions: CONDITIONS },
    { id: 'reverse', conditions: [...CONDITIONS].reverse() },
  ]

  for (const pass of passes) {
    for (const level of LEVELS) {
      for (const condition of pass.conditions) {
        await evaluate(send, `(() => {
          window.__PG_LIT_STRUCTURE.apply(${JSON.stringify(condition)})
          window.__PG_LIT_STRUCTURE.forceQuality(${JSON.stringify(level)})
        })()`)
        await sleep(250)
        const samples = await evaluate(send, 'window.__PG_LIT_STRUCTURE.measureFrames(12)')
        const sorted = [...samples].sort((a, b) => a - b)
        const state = await evaluate(send, 'window.__PG_LIT_STRUCTURE.describe()')
        measurements.push({
          pass: pass.id,
          condition,
          level,
          samples: samples.map((value) => Number(value.toFixed(2))),
          medianMs: Number(median(sorted).toFixed(2)),
          p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
          state,
        })
      }
    }
  }

  const summary = LEVELS.flatMap((level) => CONDITIONS.map((condition) => {
    const pair = measurements.filter((row) => row.level === level && row.condition === condition)
    return {
      level,
      condition,
      pairedMedianMs: Number((pair.reduce((sum, row) => sum + row.medianMs, 0) / pair.length).toFixed(2)),
      pairedP95Ms: Number((pair.reduce((sum, row) => sum + row.p95Ms, 0) / pair.length).toFixed(2)),
    }
  }))
  writeFileSync(output, `${JSON.stringify({
    complete: true,
    protocol: {
      viewport: [width, height],
      theme: 'day',
      station: '400 m establishing view',
      samplesPerRun: 12,
      passes: ['forward', 'reverse'],
      frameBudgetMs: FRAME_BUDGET_MS,
      note: 'One synchronized warm/drain frame precedes each run. Each sample is one explicit full-pipeline render followed by WebGL finish. The adaptive governor receives a fixed 60 fps clock. No fidelity threshold is changed.',
    },
    boot,
    measurements,
    summary,
  }, null, 2)}\n`)
  logs.push(`[LIT-STRUCTURE] ${measurements.length} timing runs -> ${output}`)
}

export async function runSequence(context) {
  if (MODE === 'timing') await timings(context)
  else await screenshots(context)
}
