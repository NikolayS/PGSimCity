import '../styles/control-center.css'

import type { TraceStop } from '../core/types'
import { createCorrectionPath, displayedClaim } from '../core/corrections'
import { fmtBytes } from '../core/util'
import type { FlowsApi } from '../engine/flows'
import type { WalkController, WalkPose } from '../engine/walk'
import { traceStopBit } from '../core/model-helpers'
import {
  formatModelMilliseconds,
  PRESENTED_TRACE_STAGES,
  traceStageState,
} from '../core/trace-presentation'
import {
  ANCHOR,
  TABLES,
} from '../world/layout'
import {
  CONTROL_PLAN_LANDMARKS,
  CONTROL_PLAN_REGIONS,
  CONTROL_TRACE_ROUTES,
} from '../world/control-center-plan'
import { TRACE_COPY } from './trace-copy'
import { classifyModelStatement } from './control-center-model'
import { el, setText } from './uikit'
import type { UiContext, UiModule } from './uikit'

export interface ControlCenterOptions {
  ctx: UiContext
  walk: WalkController
  flows: FlowsApi
  canvas: HTMLElement
  door: {
    setOpenness(value: number): void
  }
  /** Test override; production reads prefers-reduced-motion once at creation. */
  reducedMotion?: boolean
}

export interface ControlCenterApi extends UiModule {
  readonly inside: boolean
  readonly doorState: DoorState
  readonly doorOpenness: number
  enter(): boolean
  leave(): void
}

interface SvgRoute {
  stop: Exclude<TraceStop, 'done'>
  requiresRead: boolean
  path: SVGPolylineElement
  markerX: number
  markerY: number
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const DOOR_RADIUS_SQ = 22 * 22
const DOOR_TRAVEL_SECONDS = 0.8
const INTERIOR_POSE: Readonly<WalkPose> = {
  x: ANCHOR.controlCenter[0],
  y: ANCHOR.controlCenter[1],
  z: ANCHOR.controlCenter[2],
  yaw: Math.PI,
  pitch: -0.25,
}

type DoorState = 'closed' | 'opening' | 'open' | 'closing'

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, string | number>> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value))
  return node
}

function typingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  return (
    element.tagName === 'INPUT'
    || element.tagName === 'TEXTAREA'
    || element.tagName === 'SELECT'
    || element.isContentEditable
  )
}

function isDone(stop: TraceStop, visited: number): boolean {
  return stop === 'done' && (visited & traceStopBit('done')) !== 0
}

function createCityPlan(): {
  root: SVGSVGElement
  routes: SvgRoute[]
  marker: SVGCircleElement
} {
  const root = svg('svg', {
    class: 'control-center__map-svg',
    viewBox: '-430 -375 860 750',
    role: 'img',
    'aria-label': 'Plan view of PGSimCity with the foreground statement route',
    preserveAspectRatio: 'xMidYMid meet',
  })

  const ambient = svg('g', { class: 'control-center__map-ambient' })
  ambient.append(
    svg('path', {
      class: 'control-center__map-spine',
      d: 'M 0 -340 L 0 -112 L 0 68 L 0 330 M -256 16 L 268 16',
    }),
  )
  for (let i = 0; i < CONTROL_PLAN_REGIONS.length; i++) {
    const region = CONTROL_PLAN_REGIONS[i]
    const group = svg('g', {
      class: `control-center__map-region${region.below ? ' is-below' : ''}`,
      'data-region': region.id,
    })
    group.append(
      svg('rect', {
        x: region.x[0],
        y: region.z[0],
        width: region.x[1] - region.x[0],
        height: region.z[1] - region.z[0],
        rx: 5,
      }),
    )
    const label = svg('text', {
      x: (region.x[0] + region.x[1]) / 2,
      y: region.z[0] + 17,
      'text-anchor': 'middle',
    })
    label.textContent = region.label
    group.append(label)
    ambient.append(group)
  }
  for (let i = 0; i < CONTROL_PLAN_LANDMARKS.length; i++) {
    const landmark = CONTROL_PLAN_LANDMARKS[i]
    const group = svg('g', {
      class: 'control-center__map-landmark',
      'data-landmark': landmark.id,
    })
    group.append(svg('circle', { cx: landmark.x, cy: landmark.z, r: landmark.id === 'postmaster' ? 8 : 5 }))
    const label = svg('text', { x: landmark.x + 10, y: landmark.z + 4 })
    label.textContent = landmark.label
    group.append(label)
    ambient.append(group)
  }
  root.append(ambient)

  const traceLayer = svg('g', { class: 'control-center__map-trace' })
  const routes: SvgRoute[] = []
  for (let i = 0; i < CONTROL_TRACE_ROUTES.length; i++) {
    const route = CONTROL_TRACE_ROUTES[i]
    let points = ''
    for (let p = 0; p < route.points.length; p++) {
      const point = route.points[p]
      points += `${p === 0 ? '' : ' '}${point[0]},${point[2]}`
    }
    const path = svg('polyline', {
      class: 'control-center__map-route',
      points,
      'data-stop': route.stop,
      'data-route': route.id,
    })
    const last = route.points[route.points.length - 1]
    routes.push({
      stop: route.stop,
      requiresRead: route.requiresRead === true,
      path,
      markerX: last[0],
      markerY: last[2],
    })
    traceLayer.append(path)
  }
  const marker = svg('circle', {
    class: 'control-center__map-marker',
    cx: 0,
    cy: ANCHOR.clientTerminal[2],
    r: 8,
  })
  traceLayer.append(marker)
  root.append(traceLayer)
  return { root, routes, marker }
}

export function createControlCenter(options: ControlCenterOptions): ControlCenterApi {
  const { ctx, walk, flows, canvas, door } = options
  const { sim, bus } = ctx
  const reducedMotion = options.reducedMotion ?? prefersReducedMotion()

  /* Same walk-up grammar as the in-world handles: owner, object, E action.
   * The button itself is the touch route. */
  const actionText = el('span', { class: 'world-handle-prompt__action-text', text: 'OPEN' })
  const enterButton = el(
    'button',
    {
      class: 'world-handle-prompt__action',
      type: 'button',
      'aria-label': 'Open the postmaster control center door',
    },
    el('kbd', { class: 'world-handle-prompt__key', text: 'E' }),
    actionText,
  )
  const doorPrompt = el(
    'section',
    {
      class: 'world-handle-prompt control-center-door-prompt',
      'aria-live': 'polite',
      'aria-label': 'Nearby in-world entrance',
    },
    el('span', { class: 'world-handle-prompt__owner', text: 'POSTMASTER' }),
    el('code', { class: 'world-handle-prompt__guc', text: 'CONTROL CENTER' }),
    enterButton,
  )
  doorPrompt.hidden = true
  document.body.append(doorPrompt)

  const map = createCityPlan()
  const stageStatusNodes: HTMLElement[] = []
  const stageNodes = PRESENTED_TRACE_STAGES.map((stage) => {
    const status = el('small', { text: 'WAIT' })
    stageStatusNodes.push(status)
    return el(
      'li',
      {
        class: 'control-center__stage',
        data: { stop: stage.stop, state: 'wait' },
      },
      el('span', { text: stage.label }),
      status,
    )
  })
  const stageRail = el(
    'ol',
    {
      class: 'control-center__stages',
      'aria-label': 'Statement stage rail',
    },
    ...stageNodes,
  )

  const sourceM = el('span', { class: 'control-center__source is-model', text: 'M' })
  const sourceP = el('span', { class: 'control-center__source is-postgres', text: 'P' })
  const title = el('strong', { class: 'control-center__statement-title', text: 'NO STATEMENT' })
  const statementSql = el('code', { class: 'control-center__statement-sql', text: '—' })
  const narrative = el('p', {
    class: 'control-center__narrative',
    text: 'Type a statement below. The city will map it onto one of its six model paths.',
  })
  const metricHits = el('strong', { text: '—' })
  const metricReads = el('strong', { text: '—' })
  const metricWal = el('strong', { text: '—' })
  const metricRows = el('strong', { text: '—' })
  const metricTime = el('strong', { text: '—' })
  const receipt = el(
    'section',
    { class: 'control-center__receipt', 'aria-live': 'polite' },
    el(
      'header',
      {},
      sourceM,
      el(
        'div',
        {},
        title,
        el('span', { text: 'PERSISTS UNTIL THE NEXT STATEMENT' }),
      ),
    ),
    statementSql,
    narrative,
    el(
      'dl',
      { class: 'control-center__metrics' },
      el('div', {}, el('dt', { text: 'HITS' }), el('dd', {}, metricHits)),
      el('div', {}, el('dt', { text: 'READS' }), el('dd', {}, metricReads)),
      el('div', {}, el('dt', { text: 'WAL' }), el('dd', {}, metricWal)),
      el('div', {}, el('dt', { text: 'ROWS' }), el('dd', {}, metricRows)),
      el('div', {}, el('dt', { text: 'MODEL TIME' }), el('dd', {}, metricTime)),
    ),
    el(
      'p',
      { class: 'control-center__sources' },
      sourceP,
      ' PostgreSQL measured · ',
      el('b', { text: 'not loaded here' }),
      '  ',
      el('span', { class: 'control-center__source is-model', text: 'M' }),
      ' modelled route and values',
    ),
  )

  const sqlInput = el('textarea', {
    class: 'control-center__sql-input',
    rows: 2,
    maxLength: 360,
    spellcheck: false,
    autocomplete: 'off',
    autocapitalize: 'off',
    value: 'SELECT * FROM accounts WHERE id = 42',
    'aria-label': 'SQL-shaped model route selector',
  })
  const promptError = el('p', {
    class: 'control-center__prompt-error',
    role: 'alert',
  })
  promptError.hidden = true
  const runButton = el('button', {
    class: 'control-center__run',
    type: 'submit',
    text: 'RUN MODEL TRACE',
  })
  const form = el(
    'form',
    { class: 'control-center__prompt' },
    el('label', {}, el('span', { text: 'model-route=> ' }), sqlInput),
    el('p', {
      class: 'control-center__prompt-note',
      text: 'SQL-SHAPED ROUTE SELECTOR · MATCHES OPERATION + CITY TABLE ONLY · NOT PARSED OR NAME-RESOLVED',
    }),
    el('div', { class: 'control-center__prompt-actions' }, runButton),
    promptError,
  )

  const autoButton = el('button', {
    class: 'control-center__mode',
    type: 'button',
    text: 'TRACE: AUTO',
    'aria-pressed': 'false',
  })
  const nextButton = el('button', {
    class: 'control-center__next',
    type: 'button',
    text: 'NEXT STAGE',
    disabled: true,
  })
  const leaveButton = el('button', {
    class: 'control-center__leave',
    type: 'button',
    text: 'LEAVE · E / ESC',
  })
  const root = el(
    'section',
    {
      class: 'control-center',
      'data-correction-subject': 'city-control-center',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Postmaster control center',
    },
    el(
      'header',
      { class: 'control-center__head' },
      el(
        'div',
        {},
        el('span', { text: 'POSTMASTER TOWER · CONTROL CENTER' }),
        el('small', { text: 'THE CITY OUTSIDE AND THE PLAN BELOW ARE ONE SYSTEM' }),
      ),
      leaveButton,
    ),
    el('div', { class: 'control-center__window-label', text: 'LIVE CITY · FOREGROUND ROUTE OUTSIDE' }),
    el(
      'div',
      { class: 'control-center__console' },
      el(
        'section',
        { class: 'control-center__map' },
        el(
          'header',
          {},
          el('strong', { text: 'CITY PLAN' }),
          el('span', { text: 'AMBIENT WORK DIMMED · CYAN = YOUR STATEMENT' }),
        ),
        map.root,
      ),
      el(
        'section',
        { class: 'control-center__side' },
        receipt,
        form,
      ),
      el(
        'footer',
        { class: 'control-center__transport' },
        stageRail,
        el('div', { class: 'control-center__playback' }, autoButton, nextButton),
      ),
    ),
  )
  root.hidden = true
  document.body.append(root)

  let inside = false
  let nearDoor = false
  let doorState: DoorState = 'closed'
  let doorOpenness = 0
  let stepMode = false
  let pendingStep = false
  let playbackSaved = false
  let savedTimeScale = 1
  let savedPaused = false
  const outsidePose: WalkPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }
  let lastSql = ''
  let lastStop: TraceStop | null = null
  let lastVisited = -1
  let lastHits = -1
  let lastReads = -1
  let lastWal = -1
  let lastRows = -1
  let lastTime = -1
  createCorrectionPath(root, {
    surface: 'City / Control center',
    panel: () => `Postmaster control center / ${title.textContent || 'no statement'}`,
    source: 'src/ui/control-center.ts#createControlCenter; src/ui/trace-copy.ts#TRACE_COPY',
    claim: () => displayedClaim(
      title,
      narrative,
      receipt.querySelector<HTMLElement>('.control-center__metrics'),
      receipt.querySelector<HTMLElement>('.control-center__sources'),
    ),
    context: () => {
      if (!sim.state.trace.sql) return []
      const table = TABLES[sim.state.trace.table]?.id ?? 'none'
      return [
        ['Model statement', `${sim.state.trace.query} on ${table}`],
        ['Trace stop', sim.state.trace.stop],
      ]
    },
    disclosure: true,
  })
  door.setOpenness(0)

  function syncDoorPrompt(): void {
    let label = 'OPEN'
    let aria = 'Open the postmaster control center door'
    let disabled = false
    if (doorState === 'opening') {
      label = 'OPENING'
      aria = 'Postmaster control center door opening'
      disabled = true
    } else if (doorState === 'open') {
      label = 'ENTER'
      aria = 'Enter the postmaster control center'
    } else if (doorState === 'closing') {
      label = 'CLOSING'
      aria = 'Postmaster control center door closing'
      disabled = true
    }
    setText(actionText, label)
    enterButton.setAttribute('aria-label', aria)
    enterButton.disabled = disabled
  }

  function openDoor(): void {
    if (doorState === 'open' || doorState === 'opening') return
    if (reducedMotion) {
      doorState = 'open'
      doorOpenness = 1
      door.setOpenness(doorOpenness)
    } else {
      doorState = 'opening'
    }
    syncDoorPrompt()
  }

  function closeDoor(): void {
    if (doorState === 'closed' || doorState === 'closing') return
    if (reducedMotion) {
      doorState = 'closed'
      doorOpenness = 0
      door.setOpenness(doorOpenness)
    } else {
      doorState = 'closing'
    }
    syncDoorPrompt()
  }

  function updateDoor(dt: number): void {
    if (doorState !== 'opening' && doorState !== 'closing') return
    const direction = doorState === 'opening' ? 1 : -1
    doorOpenness += (dt / DOOR_TRAVEL_SECONDS) * direction
    if (doorOpenness >= 1) {
      doorOpenness = 1
      doorState = 'open'
      syncDoorPrompt()
    } else if (doorOpenness <= 0) {
      doorOpenness = 0
      doorState = 'closed'
      syncDoorPrompt()
    }
    door.setOpenness(doorOpenness)
  }

  function savePlayback(): void {
    if (playbackSaved) return
    playbackSaved = true
    savedTimeScale = sim.state.knobs.timeScale
    savedPaused = sim.state.knobs.paused
  }

  function restorePlayback(finishLive: boolean): void {
    if (!playbackSaved) return
    if (finishLive && !isDone(sim.state.trace.stop, sim.state.trace.visited)) {
      sim.setTraceMode('live')
    }
    sim.setKnob('timeScale', savedTimeScale)
    sim.setKnob('paused', savedPaused)
    playbackSaved = false
    pendingStep = false
  }

  function setStepMode(next: boolean): void {
    stepMode = next
    setText(autoButton, stepMode ? 'TRACE: STEP' : 'TRACE: AUTO')
    autoButton.setAttribute('aria-pressed', String(stepMode))
    if (sim.state.trace.sql.length === 0 || isDone(sim.state.trace.stop, sim.state.trace.visited)) return
    if (stepMode) {
      sim.setTraceMode('step')
    } else {
      sim.setKnob('timeScale', 0.05)
      sim.setKnob('paused', false)
      sim.setTraceMode('slow')
    }
  }

  function runStatement(): void {
    const result = classifyModelStatement(sqlInput.value)
    if ('error' in result) {
      setText(promptError, result.error)
      promptError.hidden = false
      return
    }
    promptError.hidden = true

    restorePlayback(true)
    savePlayback()
    if (sim.state.trace.sql.length > 0) sim.endTrace()
    sim.setKnob('timeScale', 0.05)
    sim.setKnob('paused', false)
    sim.setTraceMode('slow')
    sim.request(result.kind, result.tableIndex, { sql: result.sql })
    pendingStep = stepMode
    bus.emit('trace:run', {
      statement: result.kind,
      table: TABLES[result.tableIndex].id,
      playback: stepMode ? 'step' : 'slow',
    })
  }

  function paintTrace(): void {
    const trace = sim.state.trace
    const live = trace.sql.length > 0
    const done = live && isDone(trace.stop, trace.visited)
    setText(
      title,
      !live
        ? 'NO STATEMENT'
        : done
          ? 'STATEMENT RECEIPT · M MODELLED'
          : 'YOUR STATEMENT · M MODELLED ROUTE',
    )
    setText(statementSql, live ? trace.sql : '—')
    setText(
      narrative,
      live
        ? TRACE_COPY[trace.stop].line(trace)
        : 'Type a statement below. The city will map it onto one of its six model paths.',
    )
    setText(metricHits, live ? String(trace.buffersHit) : '—')
    setText(metricReads, live ? String(trace.buffersRead) : '—')
    setText(metricWal, live ? fmtBytes(trace.walBytes) : '—')
    setText(metricRows, live ? String(trace.rowsSent) : '—')
    setText(metricTime, live ? formatModelMilliseconds(trace.lastTripSec * 1000) : '—')

    let markerRoute: SvgRoute | null = null
    for (let i = 0; i < map.routes.length; i++) {
      const route = map.routes[i]
      const state = live && !done ? traceStageState(trace, route.stop) : 'wait'
      const visible = !route.requiresRead || trace.buffersRead > 0
      route.path.dataset.state = visible ? state : 'wait'
      if (visible && state === 'now') markerRoute = route
    }
    map.marker.style.display = markerRoute === null ? 'none' : ''
    if (markerRoute) {
      map.marker.setAttribute('cx', String(markerRoute.markerX))
      map.marker.setAttribute('cy', String(markerRoute.markerY))
    }

    for (let i = 0; i < PRESENTED_TRACE_STAGES.length; i++) {
      const stage = PRESENTED_TRACE_STAGES[i]
      const state = live ? traceStageState(trace, stage.stop) : 'wait'
      const node = stageNodes[i]
      node.dataset.state = state
      setText(stageStatusNodes[i], state.toUpperCase())
    }
    nextButton.disabled = !stepMode || !live || done
  }

  function enter(): boolean {
    if (inside || !walk.enabled) return false
    if (doorState !== 'open') {
      openDoor()
      return false
    }
    walk.capturePose(outsidePose)
    walk.setPose(INTERIOR_POSE)
    if (typeof document.exitPointerLock === 'function' && document.pointerLockElement) {
      document.exitPointerLock()
    }
    inside = true
    nearDoor = false
    doorPrompt.hidden = true
    root.hidden = false
    document.body.classList.add('pg-control-center')
    flows.setAmbientDimmed(true)
    paintTrace()
    sqlInput.focus()
    // The exterior leaves close while the reader is at the console, so leaving
    // restores a threshold rather than an entrance permanently stuck open.
    closeDoor()
    return true
  }

  function leave(): void {
    if (!inside) return
    restorePlayback(true)
    inside = false
    root.hidden = true
    document.body.classList.remove('pg-control-center')
    flows.setAmbientDimmed(false)
    walk.setPose(outsidePose)
    canvas.focus()
    const lockable = canvas as HTMLElement & { requestPointerLock?: () => unknown }
    try {
      const result = lockable.requestPointerLock?.()
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch(() => {})
      }
    } catch {
      /* Drag-look remains available when a browser refuses pointer lock. */
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (inside && event.code === 'KeyG' && !typingTarget(event.target)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    if (
      event.code !== 'KeyE'
      && event.code !== 'Escape'
    ) {
      return
    }
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
    if (inside) {
      if (typingTarget(event.target) && event.code !== 'Escape') return
      event.preventDefault()
      leave()
      return
    }
    if (event.code !== 'KeyE' || typingTarget(event.target) || !nearDoor) return
    event.preventDefault()
    enter()
  }

  function update(dt: number): void {
    updateDoor(dt)
    const dx = walk.position.x - ANCHOR.postmasterDoor[0]
    const dz = walk.position.z - ANCHOR.postmasterDoor[2]
    const nextNear = !inside && walk.enabled && dx * dx + dz * dz < DOOR_RADIUS_SQ
    if (nextNear !== nearDoor) {
      nearDoor = nextNear
      doorPrompt.hidden = !nearDoor
    }

    const trace = sim.state.trace
    if (pendingStep && trace.visited !== 0) {
      pendingStep = false
      sim.setTraceMode('step')
    }
    if (playbackSaved && isDone(trace.stop, trace.visited)) restorePlayback(false)

    const changed =
      trace.sql !== lastSql
      || trace.stop !== lastStop
      || trace.visited !== lastVisited
      || trace.buffersHit !== lastHits
      || trace.buffersRead !== lastReads
      || trace.walBytes !== lastWal
      || trace.rowsSent !== lastRows
      || trace.lastTripSec !== lastTime
    if (!changed) return
    lastSql = trace.sql
    lastStop = trace.stop
    lastVisited = trace.visited
    lastHits = trace.buffersHit
    lastReads = trace.buffersRead
    lastWal = trace.walBytes
    lastRows = trace.rowsSent
    lastTime = trace.lastTripSec
    paintTrace()
  }

  function onSubmit(event: Event): void {
    event.preventDefault()
    runStatement()
  }

  function onMode(): void {
    setStepMode(!stepMode)
  }

  function onNext(): void {
    if (!stepMode || nextButton.disabled) return
    sim.setTraceMode('step')
  }

  form.addEventListener('submit', onSubmit)
  autoButton.addEventListener('click', onMode)
  nextButton.addEventListener('click', onNext)
  leaveButton.addEventListener('click', leave)
  enterButton.addEventListener('click', enter)
  window.addEventListener('keydown', onKeyDown)
  paintTrace()

  function dispose(): void {
    restorePlayback(true)
    if (inside) {
      inside = false
      flows.setAmbientDimmed(false)
      document.body.classList.remove('pg-control-center')
    }
    window.removeEventListener('keydown', onKeyDown)
    form.removeEventListener('submit', onSubmit)
    autoButton.removeEventListener('click', onMode)
    nextButton.removeEventListener('click', onNext)
    leaveButton.removeEventListener('click', leave)
    enterButton.removeEventListener('click', enter)
    doorPrompt.remove()
    root.remove()
  }

  return {
    get inside(): boolean {
      return inside
    },
    get doorState(): DoorState {
      return doorState
    },
    get doorOpenness(): number {
      return doorOpenness
    },
    enter,
    leave,
    update,
    dispose,
  }
}
