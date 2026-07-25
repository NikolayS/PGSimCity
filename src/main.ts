import * as THREE from 'three'

import './styles/tokens.css'
import './styles/ui.css'

import { createBus } from './core/bus'
import { Registry } from './core/registry'
import { createTheme } from './core/theme'
import { clamp } from './core/util'
import type { ComponentDef, FlowRequest, QualitySettings, WorldContext, WorldModule } from './core/types'

import { createRenderer } from './engine/renderer'
import { createCameraRig } from './engine/camera'
import { createFlows } from './engine/flows'
import { createRoads } from './engine/roads'
import { createLabels } from './engine/labels'
import { createPicker } from './engine/picker'

import { createSim } from './sim/model'

import { createGround } from './world/ground'
import { createSky } from './world/sky'
import { createShmem } from './world/shmem'
import { createClients } from './world/clients'
import { createBackends } from './world/backends'
import { createWal } from './world/wal'
import { createStorage } from './world/storage'
import { createMaintenance } from './world/maintenance'
import { createReplication } from './world/replication'
import { createPlanner } from './world/planner'

import { createHud, setCompassCamera } from './ui/hud'
import { createHelp } from './ui/help'
import { createControls } from './ui/controls'
import { createInspector } from './ui/panel'
import { createTour } from './ui/tour'
import { createSearch } from './ui/search'
import type { UiContext, UiModule } from './ui/uikit'

/* ============================================================================
 * PGCITY — boot.
 *
 * Order matters: renderer -> camera -> simulation -> world -> overlays -> UI.
 * The world modules only ever read simulation state; the UI only ever talks to
 * the world through the bus. Nothing reaches across those lines.
 * ==========================================================================*/

const bootEl = document.getElementById('boot')
const bootFill = document.getElementById('boot-fill')
const bootStatus = document.getElementById('boot-status')

function progress(pct: number, label: string): Promise<void> {
  if (bootFill) bootFill.style.width = `${pct}%`
  if (bootStatus) bootStatus.textContent = label
  // yield a frame so the boot bar actually paints between construction steps
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function fatal(message: string, detail?: unknown): void {
  console.error('[pgcity]', message, detail)
  if (bootStatus) {
    bootStatus.textContent = message
    bootStatus.style.color = 'var(--c-crit)'
  }
  if (bootFill) bootFill.style.background = 'var(--c-crit)'
}

async function boot(): Promise<void> {
  const canvasRoot = document.getElementById('canvas-root')
  const labelsRoot = document.getElementById('labels-root')
  if (!canvasRoot || !labelsRoot) throw new Error('DOM shell is missing')

  // --- WebGL2 gate -----------------------------------------------------------
  const probe = document.createElement('canvas')
  if (!probe.getContext('webgl2')) {
    fatal('This browser has no WebGL2. Try a recent Chrome, Edge, Firefox or Safari.')
    return
  }

  const bus = createBus()
  const registry = new Registry()
  const theme = createTheme()

  await progress(8, 'starting the renderer…')
  const gfx = createRenderer(canvasRoot, bus)
  const { scene, camera, renderer } = gfx

  await progress(16, 'placing the camera…')
  const rig = createCameraRig(camera, renderer.domElement, bus)

  await progress(24, 'warming up the cluster…')
  const sim = createSim(bus)

  // --- the context every district is built against ---------------------------
  const flowQueue: FlowRequest[] = []
  const ctx: WorldContext = {
    scene,
    camera,
    bus,
    sim: sim.state,
    quality: gfx.quality,
    theme,
    register: (def: ComponentDef) => registry.register(def),
    flow: (req: FlowRequest) => bus.emit('flow', req),
  }

  await progress(32, 'grading the ground…')
  scene.add(createSky(theme))
  const modules: WorldModule[] = []
  const add = (m: WorldModule) => {
    modules.push(m)
    scene.add(m.group)
    return m
  }
  add(createGround(ctx))

  await progress(42, 'pouring the shared memory plaza…')
  add(createShmem(ctx))

  await progress(52, 'forking backends…')
  add(createClients(ctx))
  add(createBackends(ctx))

  await progress(62, 'laying the write-ahead log…')
  add(createWal(ctx))

  await progress(70, 'excavating $PGDATA…')
  add(createStorage(ctx))

  await progress(78, 'opening the maintenance yard…')
  add(createMaintenance(ctx))

  await progress(85, 'connecting the standby…')
  add(createReplication(ctx))
  add(createPlanner(ctx))

  await progress(90, 'painting the roads…')
  scene.add(createRoads(theme))
  const flows = createFlows(scene, bus, gfx.quality, theme)
  const labels = createLabels(labelsRoot, registry, bus)
  scene.add(labels.group)
  const picker = createPicker({ dom: renderer.domElement, camera, registry, bus, theme })
  scene.add(picker.group)

  await progress(96, 'wiring the console…')
  const uiCtx: UiContext = {
    bus,
    sim,
    registry,
    getFps: () => gfx.fps,
    getQuality: () => gfx.quality,
    getFlowStats: () => ({ active: flows.active, dropped: flows.dropped }),
  }
  const ui: UiModule[] = [
    createHud(uiCtx),
    createHelp(uiCtx),
    createControls(uiCtx),
    createInspector(uiCtx),
    createTour(uiCtx),
    createSearch(uiCtx),
  ]

  /* --- bus wiring ---------------------------------------------------------- */

  bus.on('focus', ({ id, instant }) => {
    if (!id) {
      rig.release()
      return
    }
    const def = registry.get(id)
    if (!def) {
      console.warn(`[pgcity] focus on unknown component "${id}"`)
      return
    }
    rig.focusOn(def.focus, { instant })
  })

  // The HUD's F key asks for a mode change; the rig announces the mode it ended
  // up in. Guard so the two can't ping-pong.
  let applyingMode = false
  bus.on('camera:mode', ({ mode }) => {
    if (applyingMode || rig.mode === mode) return
    applyingMode = true
    try {
      rig.setMode(mode)
    } finally {
      applyingMode = false
    }
  })

  bus.on('quality', ({ level }) => {
    flows.setQuality(gfx.quality)
    labels.setQuality(gfx.quality)
    void level
  })

  bus.on('sim:reset', () => sim.reset())

  /* --- resize -------------------------------------------------------------- */

  const onResize = () => {
    gfx.resize()
    rig.resize(canvasRoot.clientWidth, canvasRoot.clientHeight)
    labels.resize(canvasRoot.clientWidth, canvasRoot.clientHeight)
  }
  window.addEventListener('resize', onResize)
  onResize()

  /* --- LOD ----------------------------------------------------------------- */

  let detail: 0 | 1 | 2 = 0
  const detailFor = (alt: number): 0 | 1 | 2 => (alt > 420 ? 0 : alt > 150 ? 1 : 2)

  /* --- the loop ------------------------------------------------------------ */

  const clock = new THREE.Clock()
  let running = true

  function frame(): void {
    if (!running) return
    requestAnimationFrame(frame)

    const dt = clamp(clock.getDelta(), 0, 0.1)
    const s = sim.state

    // 1. advance the model
    if (!s.knobs.paused) sim.update(dt * s.knobs.timeScale)

    // 2. camera, then everything that depends on where the camera is
    rig.update(dt)
    const nextDetail = detailFor(rig.altitude)
    if (nextDetail !== detail) {
      detail = nextDetail
      for (const m of modules) m.setDetail?.(detail)
    }

    // 3. the city
    for (let i = 0; i < modules.length; i++) modules[i].update(dt, s, s.t)
    flows.update(dt)
    picker.update(dt)

    // 4. draw
    gfx.render(dt)
    labels.update(dt, camera, s)
    labels.render(scene, camera)

    // 5. chrome
    setCompassCamera(camera.position.x, camera.position.z, Math.atan2(-camera.matrix.elements[8], -camera.matrix.elements[10]))
    for (let i = 0; i < ui.length; i++) ui[i].update(dt)
  }

  await progress(100, 'ready')
  rig.home(true)
  frame()

  window.setTimeout(() => bootEl?.classList.add('done'), 260)

  /* --- teardown (hot reload / navigation) ---------------------------------- */

  const dispose = () => {
    running = false
    window.removeEventListener('resize', onResize)
    for (const m of modules) m.dispose?.()
    for (const u of ui) u.dispose()
    flows.dispose()
    labels.dispose()
    picker.dispose()
    rig.dispose()
    gfx.dispose()
    theme.dispose()
  }
  window.addEventListener('pagehide', dispose, { once: true })
  if (import.meta.hot) import.meta.hot.dispose(dispose)

  // handy in the console
  Object.assign(window as unknown as Record<string, unknown>, { PGCITY: { sim, registry, bus, rig, gfx, flows } })
  void flowQueue
}

boot().catch((err) => fatal('PGSimCity failed to start — see the console.', err))
