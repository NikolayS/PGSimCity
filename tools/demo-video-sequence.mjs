import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, writeFileSync } from 'node:fs'

const FPS = 30
const DEFAULT_SECONDS = 147
const FRAME_MS = 1000 / FPS

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function reservedCaptionPlace(requestedPlace, walkUpVisible) {
  return walkUpVisible ? 'top' : requestedPlace
}

export function measureWallProof(past, current, approach, wallPlane) {
  const dx = current.x - past.x
  const dz = current.z - past.z
  const tangentX = -approach.z
  const tangentZ = approach.x
  return {
    towardWallMetres: Math.max(0, dx * approach.x + dz * approach.z),
    lateralMetres: Math.abs(dx * tangentX + dz * tangentZ),
    wallGapMetres: Math.abs(
      wallPlane - (current.x * approach.x + current.z * approach.z),
    ),
  }
}

export function fullReportProblems(report) {
  const problems = []
  const collisionIds = [
    'backends',
    'checkpointer',
    'maintenance',
    'standby',
    'wal',
    'query-lab',
  ]
  for (const id of collisionIds) {
    const proof = report.collision[id]
    if (!proof) {
      problems.push(`${id}: no collision proof`)
      continue
    }
    if (proof.totalMetres < 2) problems.push(`${id}: approach was not visible`)
    if (proof.lastSecondTowardWallMetres > 0.03) {
      problems.push(`${id}: still advanced into the wall`)
    }
    if (proof.lastSecondLateralMetres > 0.03) {
      problems.push(`${id}: slid during the final hold`)
    }
    if (proof.finalWallGapMetres < 0.3 || proof.finalWallGapMetres > 0.4) {
      problems.push(`${id}: final wall gap was ${proof.finalWallGapMetres}`)
    }
  }
  if (report.labels.maxDistrictLabels > 1) {
    problems.push(`walk mode showed ${report.labels.maxDistrictLabels} district chips`)
  }
  if (!report.body.visible) problems.push('first-person body was not visible')
  if (!report.lever.approachSeen || !report.lever.operateSeen) {
    problems.push('autovacuum approach/operate prompt was not demonstrated')
  }
  if (report.lever.before !== true || report.lever.after !== false) {
    problems.push('autovacuum lever did not change on to off')
  }
  if (report.lever.activeAfterWait !== 0) {
    problems.push(`autovacuum still had ${report.lever.activeAfterWait} active workers`)
  }
  if (!report.door.inside || !report.door.mapVisible || report.door.maxOpenness < 0.95) {
    problems.push('postmaster door/control-center proof was incomplete')
  }
  const themes = new Set(report.environment.themes.map(({ mode }) => mode))
  if (!themes.has('day') || !themes.has('night')) {
    problems.push('day/night environment pass was incomplete')
  }
  if (!report.captions || report.captions.checkedFrames < 1) {
    problems.push('caption layout proof missing')
  } else if (report.captions.overlapFrames > 0) {
    problems.push(`caption cards overlapped in ${report.captions.overlapFrames} frame(s)`)
  }
  return problems
}

/*
 * Runs inside the page after normal boot. The app already owns one scheduled
 * animation frame; replacing requestAnimationFrame here lets that frame enter
 * a caller-driven queue without inventing a second renderer or simulation.
 */
function installDemo(measureWallProof_, reservedCaptionPlace_) {
  const pg = window.PGSIMCITY
  if (!pg?.walk || !pg?.rig || !pg?.controlCenter) {
    throw new Error('PGSimCity debugging surface is incomplete')
  }

  const FPS_ = 30
  const F = (seconds) => Math.round(seconds * FPS_)
  let now = performance.now()
  let nextRaf = 1
  let rafQueue = []
  const cancelled = new Set()

  Object.defineProperty(performance, 'now', {
    configurable: true,
    value: () => now,
  })
  window.requestAnimationFrame = (callback) => {
    const id = nextRaf++
    rafQueue.push([id, callback])
    return id
  }
  window.cancelAnimationFrame = (id) => {
    cancelled.add(id)
  }

  const style = document.createElement('style')
  style.textContent = `
    body.pg-demo-capture *,
    body.pg-demo-capture *::before,
    body.pg-demo-capture *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      caret-color: transparent !important;
    }
    body.pg-demo-capture .tour-first,
    body.pg-demo-capture #toast-stack,
    body.pg-demo-capture .hud-toast {
      display: none !important;
    }
    body.pg-demo-cinematic #hud-top,
    body.pg-demo-cinematic #hud-left,
    body.pg-demo-cinematic #hud-right,
    body.pg-demo-cinematic #hud-bottom,
    body.pg-demo-cinematic #compass,
    body.pg-demo-cinematic #labels-root {
      display: none !important;
    }
    #pg-demo-caption {
      position: fixed;
      left: 28px;
      bottom: 80px;
      z-index: 9998;
      width: min(570px, calc(100vw - 56px));
      padding: 13px 16px 14px;
      border: 1px solid color-mix(in srgb, var(--ink) 34%, transparent);
      background: var(--bg-panel);
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.28);
      color: var(--ink);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      pointer-events: none;
    }
    #pg-demo-caption[data-side="right"] {
      left: auto;
      right: 28px;
    }
    #pg-demo-caption[data-place="top"] {
      top: 78px;
      bottom: auto;
    }
    #pg-demo-caption .pg-demo-caption__eyebrow {
      color: var(--ink-dim);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }
    #pg-demo-caption .pg-demo-caption__title {
      margin-top: 5px;
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, sans-serif;
      font-size: 22px;
      font-weight: 760;
      letter-spacing: 0.025em;
      line-height: 1.12;
    }
    #pg-demo-caption .pg-demo-caption__detail {
      margin-top: 7px;
      color: var(--ink-dim);
      font-size: 12px;
      font-weight: 650;
      letter-spacing: 0.045em;
      line-height: 1.4;
    }
    #pg-demo-caption .pg-demo-caption__badge {
      position: absolute;
      right: 14px;
      top: 13px;
      padding: 4px 7px;
      border: 1px solid color-mix(in srgb, var(--ink) 26%, transparent);
      color: var(--c-shmem);
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.12em;
    }
    #pg-demo-fade {
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: #03060c;
      opacity: 0;
      pointer-events: none;
    }
    #pg-demo-walker {
      position: fixed;
      z-index: 9997;
      width: 11px;
      height: 11px;
      border: 2px solid var(--ink);
      border-radius: 50%;
      background: var(--bg-panel);
      box-shadow: 0 1px 6px rgba(0, 0, 0, 0.4);
      transform: translate(-50%, -50%);
      pointer-events: none;
    }
    #pg-demo-walker::after {
      content: 'WALKER';
      position: absolute;
      left: 15px;
      top: -4px;
      padding: 3px 5px;
      border: 1px solid color-mix(in srgb, var(--ink) 30%, transparent);
      background: var(--bg-panel);
      color: var(--ink);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.12em;
    }
  `
  document.head.append(style)
  document.body.classList.add('pg-demo-capture')

  const captionRoot = document.createElement('section')
  captionRoot.id = 'pg-demo-caption'
  captionRoot.innerHTML = `
    <div class="pg-demo-caption__eyebrow"></div>
    <div class="pg-demo-caption__title"></div>
    <div class="pg-demo-caption__detail"></div>
    <div class="pg-demo-caption__badge"></div>
  `
  const captionEyebrow = captionRoot.querySelector('.pg-demo-caption__eyebrow')
  const captionTitle = captionRoot.querySelector('.pg-demo-caption__title')
  const captionDetail = captionRoot.querySelector('.pg-demo-caption__detail')
  const captionBadge = captionRoot.querySelector('.pg-demo-caption__badge')
  document.body.append(captionRoot)

  const fade = document.createElement('div')
  fade.id = 'pg-demo-fade'
  document.body.append(fade)

  const walkerMarker = document.createElement('div')
  walkerMarker.id = 'pg-demo-walker'
  walkerMarker.hidden = true
  document.body.append(walkerMarker)
  const witnessPoint = pg.walk.position.clone()

  const report = {
    fps: FPS_,
    fixedDeltaMs: 1000 / FPS_,
    collision: {},
    labels: {
      maxDistrictLabels: 0,
      maxAllLabels: 0,
      samples: [],
    },
    body: {
      visible: false,
    },
    lever: {
      approachSeen: false,
      operateSeen: false,
      before: null,
      after: null,
      activeBeforePull: null,
      activeAfterWait: null,
      promptAtPull: '',
    },
    door: {
      states: [],
      maxOpenness: 0,
      inside: false,
      mapVisible: false,
    },
    environment: {
      themes: [],
      finalQuality: '',
    },
    captions: {
      policy: 'reserved-regions',
      checkedFrames: 0,
      multipleCardFrames: 0,
      overlapFrames: 0,
      firstOverlap: null,
    },
  }

  let activeCollision = null
  let collisionHistory = []
  let currentSceneStart = 0
  let currentSceneDuration = 1
  let currentFrame = 0
  let leverPulled = false
  let traceStarted = false
  let requestedCaptionPlace = 'bottom'
  const pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }

  function setCaption(
    eyebrow,
    title,
    detail,
    badge = '',
    side = 'left',
    place = 'bottom',
  ) {
    requestedCaptionPlace = place
    captionRoot.style.display = ''
    captionRoot.dataset.side = side
    captionRoot.dataset.place = place
    captionEyebrow.textContent = eyebrow
    captionTitle.textContent = title
    captionDetail.textContent = detail
    captionBadge.textContent = badge
    captionBadge.style.display = badge ? '' : 'none'
  }

  function setCaptionDetail(detail) {
    captionDetail.textContent = detail
  }

  function visible(node) {
    if (!node || node.hidden) return false
    const css = getComputedStyle(node)
    return css.display !== 'none' && css.visibility !== 'hidden' && Number(css.opacity) > 0.05
  }

  function verifyCaptionRegions() {
    report.captions.checkedFrames++
    const walkUp = document.querySelector('.walk-up-prompt:not([hidden])')
    const walkUpVisible = visible(walkUp)
    captionRoot.dataset.place = reservedCaptionPlace_(
      requestedCaptionPlace,
      walkUpVisible,
    )
    if (!visible(captionRoot) || !walkUpVisible) return

    report.captions.multipleCardFrames++
    const demoRect = captionRoot.getBoundingClientRect()
    const walkUpRect = walkUp.getBoundingClientRect()
    const overlaps = (
      demoRect.left < walkUpRect.right
      && demoRect.right > walkUpRect.left
      && demoRect.top < walkUpRect.bottom
      && demoRect.bottom > walkUpRect.top
    )
    if (!overlaps) return

    report.captions.overlapFrames++
    report.captions.firstOverlap ??= {
      frame: currentFrame,
      demo: {
        left: demoRect.left,
        top: demoRect.top,
        right: demoRect.right,
        bottom: demoRect.bottom,
      },
      walkUp: {
        left: walkUpRect.left,
        top: walkUpRect.top,
        right: walkUpRect.right,
        bottom: walkUpRect.bottom,
      },
    }
    throw new Error(`caption cards overlap at frame ${currentFrame}`)
  }

  function setFadeForScene() {
    const local = (currentFrame - currentSceneStart) / FPS_
    const tail = currentSceneDuration - local
    let opacity = 0
    if (local < 0.18) opacity = 1 - local / 0.18
    else if (tail < 0.18) opacity = 1 - tail / 0.18
    fade.style.opacity = String(Math.max(0, Math.min(1, opacity)))
  }

  function scene(start, duration) {
    currentSceneStart = F(start)
    currentSceneDuration = duration
  }

  function ensureWalk(nextPose) {
    if (!pg.walk.enabled) pg.bus.emit('camera:mode', { mode: 'walk' })
    pg.walk.setTouchMove(0, 0)
    pg.walk.setPose(nextPose)
    document.body.classList.remove('pg-demo-cinematic')
  }

  function capturePose() {
    pg.walk.capturePose(pose)
    return {
      x: pose.x,
      y: pose.y,
      z: pose.z,
      yaw: pose.yaw,
      pitch: pose.pitch,
    }
  }

  function finishCollision() {
    if (!activeCollision) return
    const final = capturePose()
    const first = collisionHistory[0] ?? final
    const lastSecond = collisionHistory[Math.max(0, collisionHistory.length - FPS_)] ?? final
    const proof = measureWallProof_(
      lastSecond,
      final,
      activeCollision.approach,
      activeCollision.wallPlane,
    )
    report.collision[activeCollision.id] = {
      start: first,
      final,
      totalMetres: Math.hypot(final.x - first.x, final.z - first.z),
      lastSecondMetres: Math.hypot(final.x - lastSecond.x, final.z - lastSecond.z),
      lastSecondTowardWallMetres: proof.towardWallMetres,
      lastSecondLateralMetres: proof.lateralMetres,
      finalWallGapMetres: proof.wallGapMetres,
      grounded: pg.walk.grounded,
      surface: pg.walk.surface,
    }
    activeCollision = null
    collisionHistory = []
  }

  function startCollision(id, nextPose, title, approach, wallPlane, witness) {
    finishCollision()
    ensureWalk(nextPose)
    activeCollision = { id, approach, wallPlane, witness }
    collisionHistory = [capturePose()]
    setCaption(
      '01 / RUNTIME COLLISION',
      title,
      'FORWARD HELD · witness camera tracks the real walk controller',
      'APPROACH',
    )
  }

  function frameCollisionWitness() {
    walkerMarker.hidden = !activeCollision
    if (!activeCollision) return
    const camera = pg.gfx.camera
    const { position, target } = activeCollision.witness
    camera.position.set(position[0], position[1], position[2])
    camera.lookAt(target[0], target[1], target[2])
    camera.updateMatrixWorld(true)
    witnessPoint.copy(pg.walk.position)
    witnessPoint.y += 0.08
    witnessPoint.project(camera)
    walkerMarker.style.left = `${(witnessPoint.x * 0.5 + 0.5) * innerWidth}px`
    walkerMarker.style.top = `${(-witnessPoint.y * 0.5 + 0.5) * innerHeight}px`
  }

  function frameDoorWitness() {
    if (currentFrame < F(107) || currentFrame >= F(108.2)) return
    const camera = pg.gfx.camera
    camera.position.set(15, 7, -190)
    camera.lookAt(0, 4.5, -206)
    camera.updateMatrixWorld(true)
  }

  function startOrbitPath(points, lookAt, duration) {
    if (pg.controlCenter.inside) pg.controlCenter.leave()
    if (pg.walk.enabled) pg.bus.emit('camera:mode', { mode: 'orbit' })
    pg.rig.flyPath(points, lookAt, duration)
    document.body.classList.add('pg-demo-cinematic')
  }

  function startOrbitFocus(target, distance, dir) {
    if (pg.controlCenter.inside) pg.controlCenter.leave()
    if (pg.walk.enabled) pg.bus.emit('camera:mode', { mode: 'orbit' })
    pg.rig.focusOn({ target, distance, dir }, { instant: true })
    document.body.classList.add('pg-demo-cinematic')
  }

  function visibleLabels() {
    return [...document.querySelectorAll('#labels-root .lbl')].filter(visible)
  }

  function activeWorkers() {
    return pg.sim.state.autovac.workers.filter((worker) => worker.active).length
  }

  function promptText() {
    const prompt = document.querySelector('.walk-up-prompt:not([hidden])')
    return visible(prompt) ? prompt.textContent.replace(/\s+/g, ' ').trim() : ''
  }

  function pressE() {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'KeyE',
      key: 'e',
      bubbles: true,
      cancelable: true,
    }))
  }

  function groupNamed(name) {
    return [...document.querySelectorAll('.pgc-group')].find((root) => {
      const label = root.querySelector('.pgc-collapse__t')
      return label?.textContent?.trim() === name
    })
  }

  function showConsoleGroup(name) {
    pg.bus.emit('ui:console', {})
    for (const root of document.querySelectorAll('.pgc-group')) {
      const button = root.querySelector('.pg-collapse__head')
      const shouldOpen = root === groupNamed(name)
      if (button && (button.getAttribute('aria-expanded') === 'true') !== shouldOpen) {
        button.click()
      }
    }
    const target = groupNamed(name)
    const body = document.querySelector('.pgc-rail__body')
    if (target && body) body.scrollTop = Math.max(0, target.offsetTop - body.offsetTop - 8)
  }

  function closeConsole() {
    document.querySelector('.pgc-rail__collapse')?.click()
  }

  pg.sim.reset()
  pg.sim.setKnob('tps', 900)
  pg.sim.setKnob('writeRatio', 0.8)
  pg.sim.setKnob('updateRatio', 0.9)
  pg.sim.setKnob('autovacuumScaleFactor', 0.02)
  pg.sim.setKnob('autovacuum', true)
  pg.sim.setKnob('timeScale', 1)
  pg.sim.setKnob('paused', false)
  pg.setThemeMode('day', { persist: false })
  /*
   * Capture throughput is not viewer frame rate. Keep the adaptive monitor on
   * its deterministic 60 fps signal while the city itself advances by 1/30 s.
   */
  const render = pg.gfx.render.bind(pg.gfx)
  pg.gfx.render = (dt) => {
    frameCollisionWitness()
    frameDoorWitness()
    render(dt, 1 / 60)
  }
  pg.gfx.setQuality('high')
  pg.rig.home(true)
  report.environment.themes.push({ frame: 0, mode: 'day' })
  scene(0, 7)
  setCaption(
    'PGSIMCITY · v0.23.0',
    'GOLDEN HOUR · RELEASE WALKTHROUGH',
    'Scattering sky · raking sun · fixed 1/30 s simulation steps',
    'DETERMINISTIC',
  )
  pg.rig.flyPath(
    [
      [-330, 185, -390],
      [-245, 118, -245],
      [-165, 72, -80],
    ],
    [
      [-24, 4, -42],
      [-10, 6, -72],
      [-18, 8, -20],
    ],
    7,
  )

  function beforeFrame(frame) {
    currentFrame = frame

    if (frame === F(7)) {
      scene(7, 6)
      pg.gfx.setQuality('reduced')
      startCollision(
        'backends',
        { x: 37.3, y: 0.02, z: -115, yaw: 0, pitch: -0.06 },
        'BACKENDS ROW · SOUTH WALL',
        { x: 0, z: -1 },
        123.4,
        {
          position: [53, 8, -105],
          target: [37.2, 2.5, -124],
        },
      )
    } else if (frame === F(13)) {
      scene(13, 6)
      startCollision(
        'checkpointer',
        { x: -170, y: 0.02, z: -40, yaw: -Math.PI / 2, pitch: -0.04 },
        'CHECKPOINTER · WEST WALL',
        { x: 1, z: 0 },
        -161.5,
        {
          position: [-179, 9, -56],
          target: [-160.5, 3.5, -39.5],
        },
      )
    } else if (frame === F(19)) {
      scene(19, 6)
      startCollision(
        'maintenance',
        { x: -196, y: 0.62, z: -18, yaw: Math.PI, pitch: -0.05 },
        'MAINTENANCE YARD · LAUNCHER WALL',
        { x: 0, z: 1 },
        -9,
        {
          position: [-215, 10, -21],
          target: [-196, 4, -8.8],
        },
      )
    } else if (frame === F(25)) {
      scene(25, 6)
      startCollision(
        'standby',
        { x: 120, y: 0.02, z: 267, yaw: Math.PI, pitch: -0.08 },
        'STANDBY · NORTH FACE',
        { x: 0, z: 1 },
        275.5,
        {
          position: [99, 10, 263],
          target: [120, 3.5, 277],
        },
      )
    } else if (frame === F(31)) {
      scene(31, 6)
      startCollision(
        'wal',
        { x: 168, y: 0.02, z: -76.5, yaw: Math.PI, pitch: -0.05 },
        'WAL DISTRICT · pg_wal DOOR',
        { x: 0, z: 1 },
        -67,
        {
          position: [188, 10, -80],
          target: [168, 4, -67],
        },
      )
    } else if (frame === F(37)) {
      scene(37, 6)
      startCollision(
        'query-lab',
        { x: 0, y: 45, z: -135.5, yaw: 0, pitch: -0.04 },
        'QUERY LAB · SUSPENDED SHELL',
        { x: 0, z: -1 },
        143.9,
        {
          position: [20, 57, -132],
          target: [0, 47, -144],
        },
      )
    } else if (frame === F(43)) {
      finishCollision()
      scene(43, 8)
      pg.gfx.setQuality('reduced')
      ensureWalk({ x: 0, y: 0.02, z: -174, yaw: Math.PI, pitch: -0.03 })
      setCaption(
        '02 / WALK-MODE SIGNAGE',
        'THE STREET, NOT A MAP LEGEND',
        'Walk mode keeps context local; turn toward the postmaster for its in-world entrance sign.',
        'ON FOOT',
      )
    } else if (frame === F(51)) {
      scene(51, 4)
      ensureWalk({ x: 30, y: 0.02, z: -180, yaw: Math.PI, pitch: -1.05 })
      pg.walk.setTouchMove(0, 0.25)
      setCaption(
        'FIRST-PERSON BODY',
        'A GROUNDED SILHOUETTE',
        'The body projection follows position and gait; this release does not add hands.',
        'WALKING',
      )
    } else if (frame === F(55)) {
      scene(55, 37)
      pg.gfx.setQuality('reduced')
      ensureWalk({
        x: -126,
        y: 0.62,
        z: -11.175,
        yaw: 1.777,
        pitch: -0.055,
      })
      pg.walk.setTouchMove(0, 0.65)
      report.lever.before = pg.sim.state.knobs.autovacuum
      setCaption(
        '03 / IN-WORLD CONTROL',
        'AUTOVACUUM CONTROL / LEVER',
        'High-write model workload • walking from the plaza causeway toward the yard',
        'APPROACH',
        'left',
        'top',
      )
    } else if (frame === F(69)) {
      pg.walk.setTouchMove(0, 0)
      report.lever.activeBeforePull = activeWorkers()
      report.lever.promptAtPull = promptText()
      if (pg.sim.state.knobs.autovacuum) pressE()
      leverPulled = pg.sim.state.knobs.autovacuum === false
      report.lever.after = pg.sim.state.knobs.autovacuum
      pg.sim.setKnob('timeScale', 5)
      setCaption(
        '03 / IN-WORLD CONTROL',
        'LEVER OFF • ROUTINE LAUNCHES STOP',
        `5× MODEL TIME • ${activeWorkers()} in-flight worker(s) finish; no new workers launch`,
        '5× MODEL TIME',
        'left',
        'top',
      )
    } else if (frame === F(70)) {
      scene(70, 22)
      ensureWalk({
        x: -176,
        y: 0.02,
        z: -42,
        yaw: 2.39,
        pitch: -0.12,
      })
    } else if (frame === F(91)) {
      pg.sim.setKnob('timeScale', 1)
      report.lever.activeAfterWait = activeWorkers()
    } else if (frame === F(92)) {
      scene(92, 5)
      pg.walk.setTouchMove(0, 0)
      showConsoleGroup('Workload')
      setCaption(
        'CONSEQUENCE PATH',
        'WRITE SHARE CREATES DEAD TUPLES',
        'The product’s workload control states the causal path; the city is staged at 80% writes.',
        'CONSOLE',
        'right',
      )
    } else if (frame === F(97)) {
      scene(97, 5)
      showConsoleGroup('Autovacuum')
      setCaption(
        'CONSEQUENCE PATH',
        'AUTOVACUUM OFF • THRESHOLD CONTROL VISIBLE',
        'The same console exposes the lever state and autovacuum_vacuum_scale_factor.',
        'CONSOLE',
        'right',
      )
    } else if (frame === F(102)) {
      closeConsole()
      scene(102, 15)
      pg.gfx.setQuality('reduced')
      ensureWalk({ x: 0, y: 0.02, z: -188, yaw: 0, pitch: -0.035 })
      pg.walk.setTouchMove(0, 0.55)
      setCaption(
        '04 / POSTMASTER',
        'APPROACH THE CONTROL CENTER',
        'The entrance prompt appears in reach; E opens the paired door leaves.',
        'ON FOOT',
        'left',
        'top',
      )
    } else if (frame === F(107)) {
      pg.walk.setTouchMove(0, 0)
      pressE()
      setCaption(
        '04 / POSTMASTER',
        'DOOR OPENING',
        'The leaves animate through the world before entry becomes available.',
        'E PRESSED',
        'left',
        'top',
      )
    } else if (frame === F(108.2)) {
      pressE()
      report.door.inside = pg.controlCenter.inside
      captionRoot.style.display = 'none'
    } else if (frame === F(110.5) && pg.controlCenter.inside && !traceStarted) {
      document.querySelector('.control-center__run')?.click()
      traceStarted = true
    } else if (frame === F(117)) {
      scene(117, 6)
      pg.controlCenter.leave()
      pg.setThemeMode('day', { persist: false })
      pg.gfx.setQuality('reduced')
      report.environment.themes.push({ frame, mode: 'day' })
      captionRoot.style.display = ''
      setCaption(
        '05 / ENVIRONMENT · INDIRECT LIGHT',
        'UNDER THE BUFFER-POOL OVERHANG',
        'Direct sun cannot reach here; green and cyan surfaces colour the filled shadow.',
        'BOUNCE',
        'left',
        'top',
      )
      startOrbitFocus([0, -42, 0], 92, [0.8, 0.16, 1])
    } else if (frame === F(123)) {
      scene(123, 6)
      pg.gfx.setQuality('medium')
      setCaption(
        '05 / ENVIRONMENT · LIGHT SHAFTS',
        'MOVE PAST A PARTIAL OCCLUDER',
        'Air contrast appears along the building edge as the low sun clears it.',
        'REAL DEPTH',
        'left',
        'top',
      )
      startOrbitPath(
        [
          [115, 3, 100],
          [102, 5, 105],
          [90, 7, 110],
        ],
        [
          [-515, 148, -662],
          [-518, 134, -656],
          [-520, 120, -650],
        ],
        6,
      )
    } else if (frame === F(129)) {
      scene(129, 6)
      setCaption(
        '05 / ENVIRONMENT · WATER + SKY',
        'THE SKYLINE MOVES IN THE BUFFER POOL',
        'A blurred reflection carries the city; the warm horizon deepens toward a cool scattering sky.',
        'DAY',
        'left',
        'top',
      )
      startOrbitPath(
        [
          [-9, 18, 74],
          [0, 17.8, 74.5],
          [9, 18, 74],
        ],
        [
          [0, 8.8, 0],
          [0, 8.8, 0],
          [0, 8.8, 0],
        ],
        6,
      )
    } else if (frame === F(135)) {
      scene(135, 12)
      pg.gfx.setQuality('reduced')
      pg.setThemeMode('night', { persist: false })
      report.environment.themes.push({ frame, mode: 'night' })
      setCaption(
        '05 / ENVIRONMENT · NIGHT',
        'MATTE STRUCTURE • NEON MEANING',
        'The same responsive surfaces after dark: semantic light remains the strongest signal.',
        'NIGHT',
      )
      startOrbitPath(
        [
          [320, 112, -285],
          [245, 82, -25],
          [105, 90, 255],
          [-110, 105, 280],
        ],
        [
          [38, 8, -105],
          [12, 6, -10],
          [30, 7, 115],
          [-5, 8, 80],
        ],
        12,
      )
    }

    if (activeCollision) pg.walk.setTouchMove(0, 0.55)

    if (frame >= F(43) && frame < F(51)) {
      const turnT = Math.max(0, Math.min(1, (frame / FPS_ - 46) / 4.5))
      const next = capturePose()
      next.yaw = Math.PI + Math.PI * turnT
      pg.walk.setPose(next)
    }

    setFadeForScene()
  }

  function afterFrame(frame) {
    if (activeCollision) {
      const current = capturePose()
      collisionHistory.push(current)
      const past = collisionHistory[Math.max(0, collisionHistory.length - FPS_)]
      const proof = measureWallProof_(
        past,
        current,
        activeCollision.approach,
        activeCollision.wallPlane,
      )
      const contact = proof.wallGapMetres <= 0.37
      captionBadge.textContent = contact ? 'CONTACT · HELD' : 'APPROACH'
      setCaptionDetail(
        `W HELD · INTO-WALL ${proof.towardWallMetres.toFixed(2)} m / last 1.0 s · `
        + `GAP ${proof.wallGapMetres.toFixed(2)} m · SLIDE ${proof.lateralMetres.toFixed(2)} m`,
      )
    }

    if (frame >= F(43) && frame < F(51)) {
      const labels = visibleLabels()
      const districts = labels.filter((node) => node.classList.contains('lbl--district'))
      report.labels.maxDistrictLabels = Math.max(report.labels.maxDistrictLabels, districts.length)
      report.labels.maxAllLabels = Math.max(report.labels.maxAllLabels, labels.length)
      if (frame % FPS_ === 0) {
        report.labels.samples.push({
          frame,
          districts: districts.map((node) => node.textContent.replace(/\s+/g, ' ').trim()),
          all: labels.map((node) => node.textContent.replace(/\s+/g, ' ').trim()),
        })
      }
      setCaptionDetail(
        `VISIBLE LABELS ${labels.length} • DISTRICT CHIPS ${districts.length} • `
        + 'nearby objects are identified in place',
      )
    }

    if (frame >= F(51) && frame < F(55)) {
      report.body.visible ||= pg.gfx.scene.getObjectByName('walk:body-shadow')?.visible === true
    }

    if (frame >= F(55) && frame < F(69)) {
      const root = document.querySelector('.walk-up-prompt:not([hidden])')
      const range = visible(root) ? root.dataset.range : ''
      report.lever.approachSeen ||= range === 'approach'
      report.lever.operateSeen ||= range === 'operate'
      const distance = Math.hypot(
        pg.walk.position.x - -179.5,
        pg.walk.position.z,
      )
      setCaptionDetail(
        `DISTANCE ${distance.toFixed(1)} m • ${promptText() || 'AUTOVACUUM beacon ahead'}`,
      )
    } else if (leverPulled && frame >= F(69) && frame < F(92)) {
      setCaptionDetail(
        `5× MODEL TIME • ACTIVE WORKERS ${activeWorkers()} • autovacuum = `
        + `${pg.sim.state.knobs.autovacuum ? 'on' : 'off'}`,
      )
    }

    if (frame >= F(102) && frame < F(117)) {
      const state = pg.controlCenter.doorState
      if (report.door.states.at(-1)?.state !== state) {
        report.door.states.push({ frame, state })
      }
      report.door.maxOpenness = Math.max(report.door.maxOpenness, pg.controlCenter.doorOpenness)
      const map = document.querySelector('.control-center__map-svg')
      report.door.mapVisible ||= pg.controlCenter.inside && visible(map)
      report.door.inside ||= pg.controlCenter.inside
    }

    if (frame === F(146.9)) {
      report.environment.finalQuality = pg.gfx.quality.level
    }

    verifyCaptionRegions()
  }

  window.__PG_DEMO = {
    advance(frame, deltaMs) {
      beforeFrame(frame)
      now += deltaMs
      const queued = rafQueue
      rafQueue = []
      for (const [id, callback] of queued) {
        if (cancelled.has(id)) {
          cancelled.delete(id)
          continue
        }
        callback(now)
      }
      afterFrame(frame)
      return true
    },
    finish() {
      finishCollision()
      pg.walk.setTouchMove(0, 0)
      report.environment.finalQuality = pg.gfx.quality.level
      return report
    },
  }

  return {
    bootDone: document.getElementById('boot')?.classList.contains('done') === true,
    quality: pg.gfx.quality.level,
    theme: pg.themeMode(),
  }
}

async function writeFrame(ffmpeg, buffer) {
  if (ffmpeg.stdin.write(buffer)) return
  await once(ffmpeg.stdin, 'drain')
}

function ffmpegProcess(output, width, height) {
  return spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'warning',
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(FPS),
    '-vcodec', 'png',
    '-video_size', `${width}x${height}`,
    '-i', 'pipe:0',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    output,
  ], {
    stdio: ['pipe', 'inherit', 'inherit'],
  })
}

export async function runSequence({ send, logs, output, width, height }) {
  if (existsSync(output) && process.env.DEMO_OVERWRITE !== '1') {
    throw new Error(`Refusing to overwrite ${output}; set DEMO_OVERWRITE=1`)
  }

  const seconds = Number(process.env.DEMO_SECONDS || DEFAULT_SECONDS)
  const startSeconds = Number(process.env.DEMO_START_SECONDS || 0)
  const frames = Math.round(seconds * FPS)
  const startFrame = Math.round(startSeconds * FPS)
  const minimumSeconds = process.env.DEMO_ALLOW_SHORT === '1' ? 1 : 90
  if (
    !Number.isFinite(frames)
    || !Number.isFinite(startFrame)
    || startFrame < 0
    || frames < FPS * minimumSeconds
    || frames > FPS * 180
  ) {
    throw new Error(`DEMO_SECONDS must be between ${minimumSeconds} and 180`)
  }

  const installed = await send('Runtime.evaluate', {
    expression:
      `(${installDemo.toString()})`
      + `(${measureWallProof.toString()},${reservedCaptionPlace.toString()})`,
    awaitPromise: true,
    returnByValue: true,
  })
  logs.push(`[SEQUENCE] ${JSON.stringify(installed.result.value)}`)

  /*
   * One native frame was already pending when requestAnimationFrame was
   * replaced. Let it run and enqueue the app's next frame in our fixed clock.
   */
  await sleep(1000)

  const ffmpeg = ffmpegProcess(output, width, height)
  let ffmpegError = null
  ffmpeg.on('error', (error) => {
    ffmpegError = error
  })

  const started = Date.now()
  try {
    for (let frame = 0; frame < frames; frame++) {
      const timelineFrame = startFrame + frame
      if (ffmpegError) throw ffmpegError
      const advanced = await send('Runtime.evaluate', {
        expression: `window.__PG_DEMO.advance(${timelineFrame},${FRAME_MS})`,
        awaitPromise: true,
        returnByValue: true,
      })
      if (advanced.exceptionDetails || advanced.result.value !== true) {
        throw new Error(`deterministic frame ${frame} did not advance`)
      }
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
        optimizeForSpeed: true,
      })
      await writeFrame(ffmpeg, Buffer.from(shot.data, 'base64'))

      if (frame === 0 || (frame + 1) % (FPS * 5) === 0) {
        const wallSeconds = ((Date.now() - started) / 1000).toFixed(1)
        console.log(
          `[demo] frame ${frame + 1}/${frames} `
          + `(${((frame + 1) / FPS).toFixed(1)} s film, `
          + `${timelineFrame / FPS}s timeline, ${wallSeconds} s wall)`,
        )
      }
    }
  } finally {
    ffmpeg.stdin.end()
  }

  const [code] = await once(ffmpeg, 'close')
  if (code !== 0) throw new Error(`ffmpeg exited with status ${code}`)

  const result = await send('Runtime.evaluate', {
    expression: 'window.__PG_DEMO.finish()',
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails || !result.result.value) {
    throw new Error('demo verification report was not returned')
  }
  if (
    result.result.value.captions?.checkedFrames < 1
    || result.result.value.captions?.overlapFrames > 0
  ) {
    throw new Error('demo caption layout verification failed')
  }
  const reportPath = output.replace(/\.mp4$/i, '') + '.json'
  writeFileSync(reportPath, JSON.stringify(result.result.value, null, 2) + '\n')
  console.log(`[demo] wrote ${output}`)
  console.log(`[demo] wrote ${reportPath}`)
  console.log(`[demo] report ${JSON.stringify(result.result.value)}`)
  if (startFrame === 0 && frames >= DEFAULT_SECONDS * FPS) {
    const problems = fullReportProblems(result.result.value)
    if (problems.length > 0) {
      throw new Error(`full demo verification failed:\n- ${problems.join('\n- ')}`)
    }
  }
}
