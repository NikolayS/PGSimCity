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
import { createCollisionWorld, DEFAULT_EXCLUDE_IDS } from './engine/collision'
import { createWalkController } from './engine/walk'

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
import { createContinuity } from './world/continuity'
import { createAccess } from './world/access'
import type { AccessModule } from './world/access'

import { createHud, setCompassCamera } from './ui/hud'
import { createHelp } from './ui/help'
import { createControls } from './ui/controls'
import { createInspector } from './ui/panel'
import { createTour } from './ui/tour'
import { createSearch } from './ui/search'
import type { UiContext, UiModule } from './ui/uikit'

/* ============================================================================
 * PGSimCity — boot.
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
  console.error('[PGSimCity]', message, detail)
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
  const probeCtx = probe.getContext('webgl2')
  if (!probeCtx) {
    fatal('This browser has no WebGL2. Try a recent Chrome, Edge, Firefox or Safari.')
    return
  }
  // Hand the probe context straight back — browsers cap how many WebGL contexts
  // can be live at once, and the real one has not been created yet.
  probeCtx.getExtension('WEBGL_lose_context')?.loseContext()

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
  const groundMod = add(createGround(ctx))

  await progress(42, 'pouring the shared memory plaza…')
  const shmemMod = add(createShmem(ctx))
  // Pedestrian infrastructure: causeways across the excavation and the stair
  // down to $PGDATA. After shmem, because it lands on the deck shmem builds.
  const access: AccessModule = createAccess(ctx)
  add(access)

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
  // After replication: the continuity quarter reads the standby's anchors and
  // hangs its own second standby, archive estate and recovery ground off them.
  add(createContinuity(ctx))

  // --- collision + the pedestrian -------------------------------------------
  // Every district is in the scene, so the registry's bounding boxes are final.
  scene.updateMatrixWorld(true)
  const collision = createCollisionWorld()
  // The deck is excluded because its registry box is a solid 156 x 124 slab —
  // it would seal the causeway landings. Its surface is a walkable mesh instead.
  collision.build(registry, { excludeIds: [...DEFAULT_EXCLUDE_IDS, 'shmem.deck'] })
  // Two walkables, and only two: the ground plate — which has the excavation cut
  // out of it, so a downward ray correctly finds nothing over the pit — and the
  // plaza deck. Every other surface is already the top of a collider box.
  collision.addWalkable(groundMod.group)
  // The DECK, not the whole shared-memory group. The 1024 buffer tiles standing
  // on it change height every frame with usage_count, and a walkable surface
  // that moves is not a floor: it rises into your feet and drops away from
  // under them while you stand still. You walk *through* the buffer tiles —
  // being inside a lit buffer is the point — so only the slab underneath them
  // is ground. (Falls back to the whole group if shmem ever renames the deck.)
  collision.addWalkable(shmemMod.group.getObjectByName('shmem.deck') ?? shmemMod.group)
  // MUST follow build(): build() resets the box array and would discard these.
  access.installCollision(collision)
  for (const b of (groundMod.group.userData.rimColliders as THREE.Box3[] | undefined) ?? []) collision.addBox(b)
  const walk = createWalkController({
    camera,
    dom: renderer.domElement,
    collision,
    bus,
    overlayRoot: canvasRoot,
  })

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
      console.warn(`[PGSimCity] focus on unknown component "${id}"`)
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
      if (mode === 'walk') {
        rig.setMode('walk') // the rig stops driving the camera…
        void walk.enter() // …and the walker drops in from wherever it was
      } else if (walk.enabled) {
        // Stand up. The walker hands back a vantage point up and behind the way
        // it was looking, and the rig flies to it, so leaving reads as stepping
        // back out of the model rather than as a cut.
        const view = walk.exit()
        const dx = view.position[0] - view.target[0]
        const dy = view.position[1] - view.target[1]
        const dz = view.position[2] - view.target[2]
        rig.setMode('orbit')
        rig.focusOn(
          { target: view.target, distance: Math.hypot(dx, dy, dz), dir: [dx, dy, dz] },
          { duration: 1.1 },
        )
      } else {
        rig.setMode(mode)
      }
    } finally {
      applyingMode = false
    }
  })

  // The HUD's quality select asks for a level; the renderer echoes the level it
  // ended up at. Same ping-pong guard as camera:mode.
  let applyingQuality = false
  bus.on('quality', ({ level }) => {
    if (!applyingQuality && level !== gfx.quality.level) {
      applyingQuality = true
      try {
        gfx.setQuality(level)
      } finally {
        applyingQuality = false
      }
    }
    flows.setQuality(gfx.quality)
    labels.setQuality(gfx.quality)
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

  const timer = new THREE.Timer()
  timer.connect(document)
  let running = true

  function frame(): void {
    if (!running) return
    requestAnimationFrame(frame)

    timer.update()
    // rawDt is real wall-clock time — the only honest input to the fps readout
    // and the adaptive-quality timers. dt is clamped so that one slow frame
    // cannot teleport the simulation or the camera.
    const rawDt = timer.getDelta()
    const dt = clamp(rawDt, 0, 0.1)
    const s = sim.state

    // 1. advance the model
    if (!s.knobs.paused) sim.update(dt * s.knobs.timeScale)

    // 2. camera, then everything that depends on where the camera is
    rig.update(dt)
    walk.update(dt)
    // On foot you are always up against the detail, wherever you stand.
    const nextDetail: 0 | 1 | 2 = walk.enabled ? 2 : detailFor(rig.altitude)
    if (nextDetail !== detail) {
      detail = nextDetail
      for (const m of modules) m.setDetail?.(detail)
    }

    // 3. the city
    for (let i = 0; i < modules.length; i++) modules[i].update(dt, s, s.t)
    flows.update(dt)
    picker.update(dt)

    // 4. draw
    gfx.render(dt, rawDt)
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

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    running = false
    window.removeEventListener('resize', onResize)
    timer.disconnect()
    for (const m of modules) m.dispose?.()
    for (const u of ui) u.dispose()
    flows.dispose()
    labels.dispose()
    picker.dispose()
    walk.dispose()
    collision.dispose()
    rig.dispose()
    gfx.dispose()
    theme.dispose()
  }
  // pagehide also fires when the page goes into the back/forward cache, where it
  // is expected to come back alive. Only tear down when it is a real unload.
  window.addEventListener('pagehide', (e: PageTransitionEvent) => {
    if (e.persisted) {
      running = false // pause; pageshow restarts the loop
      return
    }
    dispose()
  })
  window.addEventListener('pageshow', () => {
    if (running || disposed) return
    running = true
    timer.update() // swallow the delta accumulated while frozen
    frame()
  })
  if (import.meta.hot) import.meta.hot.dispose(dispose)

  // Handy in the console. PGCITY is the pre-rename alias, kept because existing
  // notes and tooling still reach for it; both names are the same object.
  const handle = { sim, registry, bus, rig, gfx, flows, walk, collision }
  Object.assign(window as unknown as Record<string, unknown>, { PGSIMCITY: handle, PGCITY: handle })
}

boot().catch((err) => fatal('PGSimCity failed to start — see the console.', err))
