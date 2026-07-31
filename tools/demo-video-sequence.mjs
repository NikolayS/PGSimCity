import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  closeSync,
  existsSync,
  openSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

const FPS = 30
const DEFAULT_SECONDS = 158
const FRAME_MS = 1000 / FPS
const SWIM_START_SECONDS = 124
const SWIM_DURATION_SECONDS = 15

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
  if (
    report.operatorDecision?.phaseSeen !== 'ready'
    || report.operatorDecision.choiceCount !== 2
    || !report.operatorDecision.choicesVisible
    || report.operatorDecision.choiceMade !== null
  ) {
    problems.push('operator decision did not show both unchosen branch costs')
  }
  if (
    !report.failover?.forkSeen
    || report.failover.lossTransactions < 1
    || report.failover.lossBytes < 1
  ) {
    problems.push('failover did not show a non-zero timeline fork loss')
  }
  if (
    !report.failover?.formerPrimaryDiverged
    || !report.failover.rewindStarted
    || !report.failover.rewindComplete
  ) {
    problems.push('former primary divergence/pg_rewind proof was incomplete')
  }
  if (
    !report.swim?.gaitSeen
    || !report.swim.submergedSeen
    || !report.swim.dragSeen
    || !report.swim.buoyancySeen
  ) {
    problems.push('swim drag/buoyancy/submersion proof was incomplete')
  }
  if (!report.swim?.audioCaptured) {
    problems.push('swim audio was not captured from the app')
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
    body.pg-demo-capture .tour-narrate,
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
      background: var(--bg-panel);
      color: var(--ink);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      pointer-events: none;
    }
    #pg-demo-caption[data-side="right"] {
      left: auto;
      right: 28px;
    }
    #pg-demo-caption[data-place="top"] {
      top: 146px;
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
      padding: 4px 0;
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
    operatorDecision: {
      phaseSeen: 'staging',
      choiceCount: 0,
      choicesVisible: false,
      choiceMade: null,
      choices: [],
    },
    failover: {
      forkSeen: false,
      lossTransactions: 0,
      lossBytes: 0,
      formerPrimaryDiverged: false,
      rewindStarted: false,
      rewindComplete: false,
      forkLsn: 0,
      oldHistoryEndLsn: 0,
      newHistoryEndLsn: 0,
      roles: [],
    },
    swim: {
      gaitSeen: false,
      submergedSeen: false,
      dragSeen: false,
      buoyancySeen: false,
      audioCaptured: false,
      maxSpeed: 0,
      speedAtRelease: 0,
      minFeetY: Number.POSITIVE_INFINITY,
      feetYAtRise: 0,
      maxRiseMetres: 0,
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
    if (!visible(captionRoot)) return

    const demoRect = captionRoot.getBoundingClientRect()
    const blockers = [
      ...document.querySelectorAll(
        '.walk-up-prompt:not([hidden]), .hud-decision:not([hidden]), '
        + '.pgc-rail:not([hidden]), #canvas-root aside:not([hidden]), '
        + '#hud-top > .pg-panel, #hud-bottom > .pg-panel, '
        + '#hud-left .pgc-panel, #hud-right .pgc-panel, #compass .pg-panel',
      ),
    ].filter((node) => node !== captionRoot && visible(node))
    if (blockers.length > 0) report.captions.multipleCardFrames++
    for (const blocker of blockers) {
      const blockerRect = blocker.getBoundingClientRect()
      const overlaps = (
        demoRect.left < blockerRect.right
        && demoRect.right > blockerRect.left
        && demoRect.top < blockerRect.bottom
        && demoRect.bottom > blockerRect.top
      )
      if (!overlaps) continue

      report.captions.overlapFrames++
      report.captions.firstOverlap ??= {
        frame: currentFrame,
        blocker: blocker.className || blocker.id || blocker.tagName,
        demo: {
          left: demoRect.left,
          top: demoRect.top,
          right: demoRect.right,
          bottom: demoRect.bottom,
        },
        other: {
          left: blockerRect.left,
          top: blockerRect.top,
          right: blockerRect.right,
          bottom: blockerRect.bottom,
        },
      }
      throw new Error(
        `caption cards overlap at frame ${currentFrame}: `
        + `${blocker.className || blocker.id || blocker.tagName}`,
      )
    }
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
    if (currentFrame < F(77) || currentFrame >= F(78.2)) return
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

  function compactBytes(value) {
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`
    return `${Math.round(value)} bytes`
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
    'PGSIMCITY · v0.27.0',
    'GOLDEN HOUR · RELEASE WALKTHROUGH',
    'Textured ground · scattering sky · fixed 1/30 s simulation steps',
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
  document.body.classList.add('pg-demo-cinematic')

  function beforeFrame(frame) {
    currentFrame = frame

    if (frame === F(7)) {
      scene(7, 5)
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
    } else if (frame === F(12)) {
      scene(12, 5)
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
    } else if (frame === F(17)) {
      scene(17, 5)
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
    } else if (frame === F(22)) {
      scene(22, 5)
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
    } else if (frame === F(27)) {
      scene(27, 5)
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
    } else if (frame === F(32)) {
      scene(32, 5)
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
    } else if (frame === F(37)) {
      finishCollision()
      scene(37, 7)
      pg.gfx.setQuality('reduced')
      ensureWalk({ x: 0, y: 0.02, z: -174, yaw: Math.PI, pitch: -0.03 })
      setCaption(
        '02 / WALK-MODE SIGNAGE',
        'THE STREET, NOT A MAP LEGEND',
        'Walk mode keeps context local; turn toward the postmaster for its in-world entrance sign.',
        'ON FOOT',
      )
    } else if (frame === F(44)) {
      scene(44, 28)
      pg.gfx.setQuality('reduced')
      pg.sim.reset()
      pg.sim.setKnob('tps', 900)
      pg.sim.setKnob('writeRatio', 0.8)
      pg.sim.setKnob('updateRatio', 0.9)
      pg.sim.setKnob('autovacuumScaleFactor', 0.02)
      pg.sim.setKnob('autovacuum', true)
      pg.sim.setKnob('paused', false)
      ensureWalk({
        x: -126,
        y: 0.62,
        z: -11.175,
        yaw: 1.777,
        pitch: -0.055,
      })
      pg.walk.setTouchMove(0, 0.8)
      report.lever.before = pg.sim.state.knobs.autovacuum
      setCaption(
        '03 / IN-WORLD CONTROL',
        'AUTOVACUUM CONTROL / LEVER',
        'High-write model workload • walking from the plaza causeway toward the yard',
        'APPROACH',
        'left',
        'top',
      )
    } else if (frame === F(55)) {
      pg.walk.setTouchMove(0, 0)
      report.lever.activeBeforePull = activeWorkers()
      report.lever.promptAtPull = promptText()
      if (pg.sim.state.knobs.autovacuum) pressE()
      leverPulled = pg.sim.state.knobs.autovacuum === false
      report.lever.after = pg.sim.state.knobs.autovacuum
      pg.sim.setKnob('timeScale', 12)
      setCaption(
        '03 / IN-WORLD CONTROL',
        'LEVER OFF • ROUTINE LAUNCHES STOP',
        `12× MODEL TIME • ${activeWorkers()} in-flight worker(s) finish; no new workers launch`,
        '12× MODEL TIME',
        'left',
        'top',
      )
    } else if (frame === F(56)) {
      scene(56, 8)
      ensureWalk({
        x: -176,
        y: 0.02,
        z: -42,
        yaw: 2.39,
        pitch: -0.12,
      })
    } else if (frame === F(64)) {
      pg.sim.setKnob('timeScale', 1)
      report.lever.activeAfterWait = activeWorkers()
      pg.walk.setTouchMove(0, 0)
      showConsoleGroup('Workload')
      scene(64, 4)
      setCaption(
        'CONSEQUENCE PATH',
        'WRITE SHARE CREATES DEAD TUPLES',
        'The workload control states the causal path; the city is staged at 80% writes.',
        'CONSOLE',
        'left',
      )
    } else if (frame === F(68)) {
      scene(68, 4)
      showConsoleGroup('Autovacuum')
      setCaption(
        'CONSEQUENCE PATH',
        'AUTOVACUUM OFF • THRESHOLD CONTROL VISIBLE',
        'The same console exposes the lever state and autovacuum_vacuum_scale_factor.',
        'CONSOLE',
        'left',
      )
    } else if (frame === F(72)) {
      closeConsole()
      scene(72, 12)
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
    } else if (frame === F(77)) {
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
    } else if (frame === F(78.2)) {
      pressE()
      report.door.inside = pg.controlCenter.inside
      captionRoot.style.display = 'none'
    } else if (frame === F(80.5) && pg.controlCenter.inside && !traceStarted) {
      document.querySelector('.control-center__run')?.click()
      traceStarted = true
    } else if (frame === F(84)) {
      scene(84, 12)
      if (pg.controlCenter.inside) pg.controlCenter.leave()
      pg.sim.reset()
      pg.sim.runScenario('vacuum-blockade')
      pg.sim.setKnob('timeScale', 8)
      pg.gfx.setQuality('reduced')
      document.body.classList.remove('pg-demo-cinematic')
      captionRoot.style.display = ''
      setCaption(
        '05 / OPERATOR DECISION',
        'VACUUM BLOCKADE · BOTH COSTS STAY ON SCREEN',
        '8× MODEL TIME TO DECISION · No branch is selected: abort one session, or preserve it while dead rows and pages grow.',
        '8× MODEL TIME',
        'left',
        'top',
      )
    } else if (frame === F(91.2)) {
      pg.sim.setKnob('paused', true)
      pg.sim.setKnob('timeScale', 1)
      captionBadge.textContent = 'DECISION PAUSED'
      setCaptionDetail(
        'BOTH BRANCH COSTS REMAIN VISIBLE · No branch is selected for the recording.',
      )
    } else if (frame === F(96)) {
      scene(96, 12)
      pg.sim.reset()
      pg.sim.setKnob('tps', 2200)
      pg.sim.setKnob('writeRatio', 1)
      pg.sim.setKnob('updateRatio', 0.7)
      pg.sim.setKnob('synchronousCommit', 'local')
      pg.sim.setKnob('replicaEnabled', true)
      pg.sim.setKnob('replicaNetworkLag', 400)
      pg.sim.setKnob('standbyBEnabled', true)
      pg.sim.setKnob('standbyBNetworkLag', 1250)
      pg.sim.setKnob('standbyBSlowApply', true)
      pg.sim.setKnob('walLogHints', true)
      pg.sim.setKnob('timeScale', 6)
      pg.sim.setKnob('paused', false)
      pg.gfx.setQuality('reduced')
      setCaption(
        '06 / FAILOVER',
        'THREE NODES · THREE DURABLE POSITIONS',
        '6× MODEL TIME · The DCS lease posts stay distinct while standby_a and standby_b fall behind independently.',
        '6× MODEL TIME',
      )
      startOrbitFocus([0, 8, 250], 180, [0.95, 0.36, 1])
    } else if (frame === F(102)) {
      pg.sim.setKnob('timeScale', 2)
      pg.sim.startFailover('standbyA')
      pg.bus.emit('select', { id: null })
      setCaption(
        '06 / FAILOVER',
        'PRIMARY GONE · OLD LEADER LEASE DRAINS',
        '2× MODEL TIME · Write admission is closed until standby_a can acquire the DCS leader lock.',
        '2× MODEL TIME',
        'left',
        'top',
      )
      startOrbitFocus([0, 7, 250], 92, [0.8, 0.32, 1])
    } else if (frame === F(108)) {
      scene(108, 8)
      pg.sim.setKnob('timeScale', 1)
      setCaption(
        '06 / FAILOVER · MEASURED LOSS',
        'TIMELINE 2 FORKS FROM TIMELINE 1',
        'Waiting for promotion result from the live simulation…',
        'FORK',
        'left',
        'top',
      )
      startOrbitFocus([346, 8, -35], 92, [0.55, 0.38, 1])
      pg.bus.emit('select', { id: null })
    } else if (frame === F(116)) {
      scene(116, 8)
      pg.sim.startPgRewind()
      pg.bus.emit('select', { id: null })
      pg.sim.setKnob('timeScale', 3)
      setCaption(
        '06 / REJOIN',
        'pg_rewind DISCARDS THE DIVERGENT TAIL',
        '3× MODEL TIME · The former primary cannot merge histories; the rejoin bay tracks the measured copy.',
        '3× MODEL TIME',
        'left',
        'top',
      )
      startOrbitFocus([-56, 5, 232], 68, [0.72, 0.34, 1])
    } else if (frame === F(124)) {
      scene(124, 15)
      pg.sim.reset()
      pg.setThemeMode('day', { persist: false })
      pg.gfx.setQuality('medium')
      ensureWalk({ x: 0, y: 7.05, z: 34, yaw: Math.PI, pitch: -0.06 })
      pg.walk.setTouchMove(0, 0.75)
      report.swim.minFeetY = pg.walk.position.y
      setCaption(
        '07 / BUFFER-POOL SWIM',
        'FORWARD THRUST MEETS WATER DRAG',
        'Listen: surface strokes are open; the same strokes are low-passed after the dive.',
        'APP AUDIO',
        'left',
        'top',
      )
    } else if (frame === F(128)) {
      pg.walk.setTouchCrouch(true)
      setCaption(
        '07 / BUFFER-POOL SWIM',
        'DIVE HELD · UNDERWATER WORLD CLOSES IN',
        'The water column adds drag, depth motes, a surface boundary, and audible muffling.',
        'DIVE',
        'left',
        'top',
      )
    } else if (frame === F(132)) {
      pg.walk.setTouchMove(0, 0)
      pg.walk.setTouchCrouch(false)
      report.swim.speedAtRelease = pg.walk.speed
      report.swim.feetYAtRise = pg.walk.position.y
      setCaption(
        '07 / BUFFER-POOL SWIM',
        'INPUT RELEASED · DRAG SLOWS, BUOYANCY RISES',
        'Live speed and vertical motion below come from the walk controller.',
        'FLOAT',
        'left',
        'top',
      )
    } else if (frame === F(139)) {
      scene(139, 7)
      pg.walk.setTouchMove(0, 0)
      pg.walk.setTouchCrouch(false)
      pg.setThemeMode('day', { persist: false })
      report.environment.themes.push({ frame, mode: 'day' })
      setCaption(
        '08 / ENVIRONMENT · WATER + SKY',
        'THE SKYLINE MOVES IN THE BUFFER POOL',
        'Daylight separates textured ground, the warm horizon, clouds, and the cool scattering sky.',
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
        7,
      )
    } else if (frame === F(146)) {
      scene(146, 12)
      pg.gfx.setQuality('reduced')
      pg.setThemeMode('night', { persist: false })
      report.environment.themes.push({ frame, mode: 'night' })
      setCaption(
        '08 / ENVIRONMENT · NIGHT',
        'MATTE STRUCTURE • NEON MEANING',
        'The same city after dark: semantic light remains the strongest signal.',
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

    if (frame >= F(37) && frame < F(44)) {
      const turnT = Math.max(0, Math.min(1, (frame / FPS_ - 39.5) / 3.8))
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

    if (frame >= F(37) && frame < F(44)) {
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

    if (frame >= F(44) && frame < F(55)) {
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
    } else if (leverPulled && frame >= F(55) && frame < F(64)) {
      setCaptionDetail(
        `12× MODEL TIME • ACTIVE WORKERS ${activeWorkers()} • autovacuum = `
        + `${pg.sim.state.knobs.autovacuum ? 'on' : 'off'}`,
      )
    }

    if (frame >= F(72) && frame < F(84)) {
      const state = pg.controlCenter.doorState
      if (report.door.states.at(-1)?.state !== state) {
        report.door.states.push({ frame, state })
      }
      report.door.maxOpenness = Math.max(report.door.maxOpenness, pg.controlCenter.doorOpenness)
      const map = document.querySelector('.control-center__map-svg')
      report.door.mapVisible ||= pg.controlCenter.inside && visible(map)
      report.door.inside ||= pg.controlCenter.inside
    }

    if (frame >= F(84) && frame < F(96)) {
      const decision = pg.sim.state.scenarioDecision
      if (decision) {
        report.operatorDecision.phaseSeen = decision.phase
        report.operatorDecision.choiceMade = decision.choice
      }
      const choices = [...document.querySelectorAll('[data-scenario-choice]')]
        .filter(visible)
      report.operatorDecision.choiceCount = Math.max(
        report.operatorDecision.choiceCount,
        choices.length,
      )
      report.operatorDecision.choicesVisible ||= choices.length === 2
      if (choices.length === 2) {
        report.operatorDecision.choices = choices.map((node) =>
          node.textContent.replace(/\s+/g, ' ').trim())
      }
    }

    if (frame >= F(96) && frame < F(124)) {
      const ha = pg.sim.state.highAvailability
      const transition = ha.transition
      const timeline = ha.timeline
      if (timeline.forkLsn > 0) {
        report.failover.forkSeen = true
        report.failover.lossTransactions = transition.lossTransactions
        report.failover.lossBytes = transition.lossBytes
        report.failover.forkLsn = timeline.forkLsn
        report.failover.oldHistoryEndLsn = timeline.oldHistoryEndLsn
        report.failover.newHistoryEndLsn = timeline.newHistoryEndLsn
        report.failover.roles = pg.sim.state.cluster.nodes.map((node) => ({
          id: node.id,
          role: node.role,
          opinion: node.leaderOpinion,
        }))
        report.failover.formerPrimaryDiverged ||=
          pg.sim.state.cluster.nodes[0].role === 'diverged'
      }
      report.failover.rewindStarted ||=
        ha.rejoin.status === 'checking'
        || ha.rejoin.status === 'rewinding'
        || ha.rejoin.status === 'complete'
      report.failover.rewindComplete ||= ha.rejoin.status === 'complete'

      if (frame >= F(108) && frame < F(116) && transition.status === 'complete') {
        captionBadge.textContent = `${transition.lossTransactions} TX LOST`
        setCaptionDetail(
          `ACKNOWLEDGED ON OLD PRIMARY, ABSENT AFTER PROMOTION · `
          + `${transition.lossTransactions.toLocaleString()} tx · `
          + `${compactBytes(transition.lossBytes)} · fork LSN ${timeline.forkLsn.toLocaleString()}`,
        )
      } else if (frame >= F(116)) {
        captionBadge.textContent = `${ha.rejoin.status.toUpperCase()} · 3×`
        setCaptionDetail(
          `3× MODEL TIME · STATUS ${ha.rejoin.status.toUpperCase()} · `
          + `${(ha.rejoin.progress * 100).toFixed(0)}% · `
          + `${compactBytes(ha.rejoin.bytesCopied)} / ${compactBytes(ha.rejoin.bytesRewound)}`,
        )
      }
    }

    if (frame >= F(124) && frame < F(139)) {
      const feetY = pg.walk.position.y
      report.swim.gaitSeen ||= pg.walk.gait === 'swim'
      report.swim.submergedSeen ||= pg.walk.submerged
      report.swim.maxSpeed = Math.max(report.swim.maxSpeed, pg.walk.speed)
      report.swim.minFeetY = Math.min(report.swim.minFeetY, feetY)
      if (frame >= F(132)) {
        const rise = Math.max(0, feetY - report.swim.feetYAtRise)
        report.swim.maxRiseMetres = Math.max(report.swim.maxRiseMetres, rise)
        report.swim.dragSeen ||=
          report.swim.speedAtRelease > 0.25
          && pg.walk.speed < report.swim.speedAtRelease * 0.35
        report.swim.buoyancySeen ||= rise > 0.25 && pg.walk.verticalSpeed > 0.08
      }
      const audioState = pg.walk.submerged ? 'UNDERWATER LOW-PASS' : 'OPEN-AIR STROKES'
      setCaptionDetail(
        `GAIT ${pg.walk.gait.toUpperCase()} · SPEED ${pg.walk.speed.toFixed(2)} m/s · `
        + `VERTICAL ${pg.walk.verticalSpeed >= 0 ? '+' : ''}${pg.walk.verticalSpeed.toFixed(2)} m/s · `
        + `FEET Y ${feetY.toFixed(2)} m · AUDIO ${audioState}`,
      )
    }

    if (frame === F(157.9)) {
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
    markAudioCaptured(captured) {
      report.swim.audioCaptured = captured === true
      return report.swim.audioCaptured
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

async function runProcess(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] })
  const [code] = await once(child, 'close')
  if (code !== 0) throw new Error(`${command} exited with status ${code}`)
}

async function captureSwimAudio(send, source, rawPath, wavPath) {
  const enabled = await send('Runtime.evaluate', {
    expression: `(async () => {
      window.PGSIMCITY.audio.volume = 0.72
      await window.PGSIMCITY.audio.enable()
      return window.PGSIMCITY.audio.enabled
    })()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (enabled.exceptionDetails || enabled.result.value !== true) {
    throw new Error('the app audio graph did not start from the CDP user gesture')
  }

  const rawFd = openSync(rawPath, 'w')
  const recorder = spawn('parec', [
    `--device=${source}`,
    '--format=s16le',
    '--rate=48000',
    '--channels=2',
    '--raw',
  ], {
    stdio: ['ignore', rawFd, 'inherit'],
  })
  const recorderClosed = once(recorder, 'close')
  closeSync(rawFd)
  await once(recorder, 'spawn')
  await sleep(250)

  const synthesis = await send('Runtime.evaluate', {
    expression: `new Promise((resolve) => {
      const audio = window.PGSIMCITY.audio
      const fps = ${FPS}
      const frames = ${SWIM_DURATION_SECONDS * FPS}
      let frame = 0
      let distance = 0
      audio.splash(0.48)
      const timer = setInterval(() => {
        const seconds = frame / fps
        const moving = seconds < 9
        const submerged = seconds >= 5
        if (moving) distance += 1.55 / fps
        audio.step(1 / fps, {
          distance,
          speed: moving ? 1.55 : 0,
          gait: 'swim',
          grounded: false,
          surface: 'water',
          submerged,
        })
        frame++
        if (frame >= frames) {
          clearInterval(timer)
          resolve({ enabled: audio.enabled, frames, distance })
        }
      }, 1000 / fps)
    })`,
    awaitPromise: true,
    returnByValue: true,
  })
  await sleep(400)
  recorder.kill('SIGTERM')
  const [recordCode] = await recorderClosed
  if (recordCode !== 0 && recordCode !== null) {
    throw new Error(`parec exited with status ${recordCode}`)
  }
  if (synthesis.exceptionDetails || synthesis.result.value?.enabled !== true) {
    throw new Error('the app audio graph stopped during swim synthesis')
  }
  if (statSync(rawPath).size < 192000) {
    throw new Error('PulseAudio returned less than one second of stereo audio')
  }

  await runProcess('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'warning',
    '-y',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    '-i', rawPath,
    '-af', `atrim=start=0.25,apad=whole_dur=${SWIM_DURATION_SECONDS},atrim=duration=${SWIM_DURATION_SECONDS}`,
    '-c:a', 'pcm_s16le',
    wavPath,
  ])
}

async function muxDemoAudio(videoPath, audioPath, output, seconds, delaySeconds) {
  const delayMs = Math.max(0, Math.round(delaySeconds * 1000))
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'warning',
    '-y',
    '-i', videoPath,
    '-i', audioPath,
    '-filter_complex',
    `[1:a]adelay=${delayMs}:all=1,apad=whole_dur=${seconds}[demo_audio]`,
    '-map', '0:v:0',
    '-map', '[demo_audio]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-pix_fmt', 'yuv420p',
    '-t', String(seconds),
    '-movflags', '+faststart',
    '-metadata:s:a:0', 'title=PGSimCity procedural swim audio',
    output,
  ])
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
  const fullFilm = startFrame === 0 && frames >= DEFAULT_SECONDS * FPS
  const pulseSource = process.env.DEMO_PULSE_SOURCE || ''
  const includesSwim =
    startSeconds <= SWIM_START_SECONDS
    && startSeconds + seconds >= SWIM_START_SECONDS + SWIM_DURATION_SECONDS
  const captureAudio = pulseSource !== '' && includesSwim
  if (fullFilm && !captureAudio) {
    throw new Error('DEMO_PULSE_SOURCE is required for the full film swim-audio proof')
  }
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

  const videoPath = captureAudio
    ? `${output}.video-only-${process.pid}.mp4`
    : output
  const rawAudioPath = `${output}.swim-${process.pid}.raw`
  const wavAudioPath = `${output}.swim-${process.pid}.wav`
  const ffmpeg = ffmpegProcess(videoPath, width, height)
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
        const detail = advanced.exceptionDetails?.exception?.description
          || advanced.exceptionDetails?.text
          || `returned ${JSON.stringify(advanced.result.value)}`
        throw new Error(`deterministic frame ${frame} did not advance: ${detail}`)
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

  if (captureAudio) {
    try {
      console.log('[demo] capturing the app procedural swim audio')
      await captureSwimAudio(send, pulseSource, rawAudioPath, wavAudioPath)
      await muxDemoAudio(
        videoPath,
        wavAudioPath,
        output,
        seconds,
        SWIM_START_SECONDS - startSeconds,
      )
      const marked = await send('Runtime.evaluate', {
        expression: 'window.__PG_DEMO.markAudioCaptured(true)',
        returnByValue: true,
      })
      if (marked.exceptionDetails || marked.result.value !== true) {
        throw new Error('audio capture was not recorded in the verification report')
      }
    } finally {
      for (const path of [videoPath, rawAudioPath, wavAudioPath]) {
        if (existsSync(path)) unlinkSync(path)
      }
    }
  }

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
  if (fullFilm) {
    const problems = fullReportProblems(result.result.value)
    if (problems.length > 0) {
      throw new Error(`full demo verification failed:\n- ${problems.join('\n- ')}`)
    }
  }
}
