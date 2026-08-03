import {
  ARCHITECTURE_LAYOUT as layout,
  activeStatementStageIndex,
  createStatementReplay,
  nextStatementStageIndex,
} from './architecture.js'
import {
  formatDescribeIndex,
  formatError,
  formatReport,
  formatResult,
  parseMetaCommand,
} from './psql.js'
import {
  BOARD_MAX_SCALE,
  DETAIL_HEIGHT,
  DETAIL_WIDTH,
  MIN_DETAIL_LABEL_PX,
  RECEIPT_FOCUS,
  clampBoardView,
  containBoardPoint,
  detailFontSize,
  effectiveLabelPixels,
  fitBoardScale,
  needsCompletionFollow,
  shouldFocusBoardAfterSubmit,
  zoomBoardView,
} from './mobile-board.js'
import {
  formatViewingRate,
  nearestViewingRate,
  nudgeViewingRate,
  viewingElapsed,
} from './playback.js'
import {
  handleBoardInstruction,
  handleTerminalInstruction,
} from './instructions.js'
import {
  COMPARISON_SQL,
  SYNCHRONOUS_COMMIT_COMPARISON_CLAIM,
  createSynchronousCommitComparison,
} from './comparison.js'
import {
  INDEX_WALK_CLAIM,
  INDEX_WALK_STEPS,
  createIndexWalkEvidence,
  indexWalkFinding,
  matchingIndexWalkStep,
} from './index-walk.js'
import {
  createCorrectionPath,
  displayedClaim,
} from '../src/core/corrections.ts'
import { CLAIM_VALUES } from '../src/core/claims.ts'

const canvas = document.querySelector('#machine')
const architecturePane = document.querySelector('.architecture-pane')
const architectureScroll = document.querySelector('.architecture-scroll')
const architectureStage = document.querySelector('.architecture-stage')
const boardView = document.querySelector('#board-view')
const boardFollow = document.querySelector('#board-follow')
const clock = document.querySelector('#clock')
const runState = document.querySelector('#run-state')
const machineToggle = document.querySelector('#machine-toggle')
const machineReset = document.querySelector('#machine-reset')
const machineSlower = document.querySelector('#machine-slower')
const machineRate = document.querySelector('#machine-rate')
const machineFaster = document.querySelector('#machine-faster')
const statementMode = document.querySelector('#statement-mode')
const statementNext = document.querySelector('#statement-next')
const statementState = document.querySelector('#statement-state')
const postgresToggle = document.querySelector('#postgres-toggle')
const postgresStatus = document.querySelector('#postgres-status')
const postgresMeasurement = document.querySelector('#postgres-measurement')
const measurementRack = document.querySelector('.measurement-rack')
const terminalBanner = document.querySelector('.terminal-banner')
const machineDeck = document.querySelector('.deck')
const machineVersionProvenance = document.querySelector('#machine-version-provenance')
const terminalState = document.querySelector('#terminal-state')
const terminalTranscript = document.querySelector('#terminal-transcript')
const terminalForm = document.querySelector('#terminal-form')
const terminalInput = document.querySelector('#terminal-input')
const comparisonRoot = document.querySelector('#comparison')
const comparisonProof = document.querySelector('#comparison-proof')
const comparisonActions = document.querySelector('.comparison-actions')
const comparisonOpen = document.querySelector('#comparison-open')
const comparisonClose = document.querySelector('#comparison-close')
const comparisonRun = document.querySelector('#comparison-run')
const comparisonContinue = document.querySelector('#comparison-continue')
const comparisonStatus = document.querySelector('#comparison-status')
const comparisonFinding = document.querySelector('#comparison-finding')
const comparisonPgliteDisclosure = document.querySelector('#comparison-pglite-disclosure')
const comparisonReplayDisclosure = document.querySelector('#comparison-replay-disclosure')
const comparisonSql = document.querySelector('#comparison-sql')
const comparisonLanes = document.querySelector('.comparison-lanes')
const comparisonBoardA = document.querySelector('#comparison-board-a')
const comparisonBoardB = document.querySelector('#comparison-board-b')
const comparisonPhaseA = document.querySelector('[data-comparison-phase="a"]')
const comparisonPhaseB = document.querySelector('[data-comparison-phase="b"]')
const comparisonNoteB = document.querySelector('[data-comparison-note="b"]')
const comparisonTabA = document.querySelector('[data-comparison-lane="a"]')
const comparisonTabB = document.querySelector('[data-comparison-lane="b"]')
const indexWalkRoot = document.querySelector('#index-walk')
const indexWalkIntro = document.querySelector('#index-walk-intro')
const indexWalkOpen = document.querySelector('#index-walk-open')
const indexWalkClose = document.querySelector('#index-walk-close')
const indexWalkStatus = document.querySelector('#index-walk-status')
const indexWalkStepsRoot = document.querySelector('#index-walk-steps')
const indexWalkStepButtons = [...document.querySelectorAll('[data-index-walk-step]')]
const indexWalkFindingRoot = document.querySelector('#index-walk-finding')
const indexWalkFindingText = document.querySelector('#index-walk-finding-text')
const indexWalkDisclosures = document.querySelector('#index-walk-disclosures')
const indexWalkSequence = document.querySelector('#index-walk-sequence')
const indexWalkModel = document.querySelector('#index-walk-model')
const indexWalkComparison = document.querySelector('#index-walk-comparison')
const indexWalkReset = document.querySelector('#index-walk-reset')
const indexWalkFooter = document.querySelector('#index-walk-footer')
let ctx = canvas?.getContext('2d')
const comparisonCtxA = comparisonBoardA?.getContext('2d')
const comparisonCtxB = comparisonBoardB?.getContext('2d')

if (
  !canvas
  || !architecturePane
  || !architectureScroll
  || !architectureStage
  || !boardView
  || !boardFollow
  || !ctx
  || !clock
  || !runState
  || !machineToggle
  || !machineReset
  || !machineSlower
  || !machineRate
  || !machineFaster
  || !statementMode
  || !statementNext
  || !statementState
  || !postgresToggle
  || !postgresStatus
  || !postgresMeasurement
  || !measurementRack
  || !terminalBanner
  || !machineDeck
  || !machineVersionProvenance
  || !terminalState
  || !terminalTranscript
  || !terminalForm
  || !terminalInput
  || !comparisonRoot
  || !comparisonProof
  || !comparisonActions
  || !comparisonOpen
  || !comparisonClose
  || !comparisonRun
  || !comparisonContinue
  || !comparisonStatus
  || !comparisonFinding
  || !comparisonPgliteDisclosure
  || !comparisonReplayDisclosure
  || !comparisonSql
  || !comparisonLanes
  || !comparisonBoardA
  || !comparisonBoardB
  || !comparisonPhaseA
  || !comparisonPhaseB
  || !comparisonNoteB
  || !comparisonTabA
  || !comparisonTabB
  || !indexWalkRoot
  || !indexWalkIntro
  || !indexWalkOpen
  || !indexWalkClose
  || !indexWalkStatus
  || !indexWalkStepsRoot
  || indexWalkStepButtons.length !== INDEX_WALK_STEPS.length
  || !indexWalkFindingRoot
  || !indexWalkFindingText
  || !indexWalkDisclosures
  || !indexWalkSequence
  || !indexWalkModel
  || !indexWalkComparison
  || !indexWalkReset
  || !indexWalkFooter
  || !comparisonCtxA
  || !comparisonCtxB
) {
  throw new Error('The Magnum workbench is missing a required browser element')
}

createCorrectionPath(architecturePane, {
  surface: 'Machine / Architecture board',
  panel: 'Layered PostgreSQL architecture',
  source: 'machine/architecture.js#ARCHITECTURE_LAYOUT; machine/magnum.js#drawMachine',
  claim: () => [
    canvas.getAttribute('aria-label'),
    displayedClaim(statementState, runState),
  ].filter(Boolean).join('\n'),
})

createCorrectionPath(comparisonActions, {
  surface: 'Machine / Comparison',
  panel: 'synchronous_commit on versus off',
  source: 'src/spine/machine-comparison.ts#MACHINE_SYNCHRONOUS_COMMIT_COMPARISON',
  claim: () => displayedClaim(comparisonProof),
  context: () => [
    ['Modelled setting', 'synchronous_commit: on vs off'],
    ['Comparison status', comparisonStatus.textContent || 'unknown'],
  ],
  disclosure: true,
})

const VIEW_W = DETAIL_WIDTH
const VIEW_H = DETAIL_HEIGHT
const MASTER_PERIOD = 36
const TAU = Math.PI * 2
const PROMPT = 'pgsimcity=#'
const SMALLEST_SOURCE_LABEL_PX = 4
const MOBILE_BOARD_QUERY =
  '(max-width: 760px), '
  + '(max-width: 900px) and (max-height: 500px) and (hover: none) and (pointer: coarse)'
const mobileBoardMedia = window.matchMedia(MOBILE_BOARD_QUERY)

function syncMobileResetVisibility() {
  machineReset.hidden = mobileBoardMedia.matches
}

mobileBoardMedia.addEventListener('change', syncMobileResetVisibility)
syncMobileResetVisibility()

const periods = Object.freeze({
  walwriter: 3,
  backends: 6,
  walsender: 9,
  bgwriter: 12,
  autovacuum: 18,
  checkpointer: 36,
})

const ink = Object.freeze({
  void: '#15100d',
  paper: '#d8c29a',
  paperDim: '#9b845f',
  brass: '#c8923e',
  brassHi: '#f1ca74',
  brassDark: '#70451f',
  copper: '#b85f35',
  copperHi: '#ed9760',
  iron: '#353231',
  ironHi: '#5d5852',
  groove: '#211916',
  blue: '#62a9b2',
  teal: '#5c9e87',
  green: '#7ea65f',
  red: '#d95d49',
  orange: '#de8d3e',
  ivory: '#f1dfba',
})

const timelineRows = Object.freeze([
  Object.freeze(['WALWRITER', periods.walwriter, ink.copperHi]),
  Object.freeze(['BACKENDS', periods.backends, ink.brassHi]),
  Object.freeze(['WALSENDER', periods.walsender, ink.blue]),
  Object.freeze(['BGWRITER', periods.bgwriter, ink.teal]),
  Object.freeze(['AUTOVAC ×3', periods.autovacuum, ink.green]),
  Object.freeze(['CHECKPOINT', periods.checkpointer, ink.red]),
])

const backendSpecs = Object.freeze([
  Object.freeze({
    name: 'B1',
    offset: 0,
    pivotX: 132,
    pivotY: 235,
    fetchX: 144,
    fetchY: 390,
    hitFetchX: 144,
    hitFetchY: 390,
    workX: 164,
    workY: 263,
    walX: 472,
    walY: 373,
    commitX: 588,
    commitY: 443,
    miss: false,
  }),
  Object.freeze({
    name: 'B2',
    offset: 2,
    pivotX: 277,
    pivotY: 225,
    fetchX: 280,
    fetchY: 704,
    hitFetchX: 280,
    hitFetchY: 420,
    workX: 466,
    workY: 222,
    walX: 526,
    walY: 373,
    commitX: 588,
    commitY: 443,
    miss: true,
  }),
  Object.freeze({
    name: 'B3',
    offset: 4,
    pivotX: 382,
    pivotY: 235,
    fetchX: 370,
    fetchY: 405,
    hitFetchX: 370,
    hitFetchY: 405,
    workX: 382,
    workY: 263,
    walX: 580,
    walY: 373,
    commitX: 602,
    commitY: 443,
    miss: false,
  }),
])

const statementRoutes = Object.freeze({
  backend: Object.freeze([
    Object.freeze([124, 128]),
    Object.freeze([215, 128]),
    Object.freeze([306, 128]),
    Object.freeze([306, 188]),
    Object.freeze([277, 211]),
  ]),
  parse: Object.freeze([
    Object.freeze([277, 225]),
    Object.freeze([360, 225]),
    Object.freeze([407, 211]),
    Object.freeze([428, 211]),
  ]),
  rewrite: Object.freeze([
    Object.freeze([428, 211]),
    Object.freeze([484, 211]),
  ]),
  plan: Object.freeze([
    Object.freeze([484, 211]),
    Object.freeze([540, 211]),
  ]),
  execute: Object.freeze([
    Object.freeze([540, 211]),
    Object.freeze([600, 211]),
  ]),
  buffer: Object.freeze([
    Object.freeze([600, 211]),
    Object.freeze([600, 284]),
    Object.freeze([386, 318]),
    Object.freeze([252, 402]),
  ]),
  kernel: Object.freeze([
    Object.freeze([252, 402]),
    Object.freeze([245, 536]),
    Object.freeze([245, 625]),
  ]),
  disk: Object.freeze([
    Object.freeze([245, 625]),
    Object.freeze([245, 704]),
  ]),
  returnFromBuffer: Object.freeze([
    Object.freeze([252, 402]),
    Object.freeze([36, 402]),
    Object.freeze([36, 128]),
    Object.freeze([124, 128]),
  ]),
  returnFromDisk: Object.freeze([
    Object.freeze([245, 704]),
    Object.freeze([36, 704]),
    Object.freeze([36, 128]),
    Object.freeze([124, 128]),
  ]),
  wal: Object.freeze([
    Object.freeze([252, 402]),
    Object.freeze([396, 402]),
    Object.freeze([458, 373]),
    Object.freeze([526, 373]),
  ]),
  commit: Object.freeze([
    Object.freeze([526, 373]),
    Object.freeze([661, 373]),
    Object.freeze([661, 625]),
    Object.freeze([590, 625]),
    Object.freeze([590, 704]),
  ]),
  returnFromCommit: Object.freeze([
    Object.freeze([590, 704]),
    Object.freeze([36, 704]),
    Object.freeze([36, 128]),
    Object.freeze([124, 128]),
  ]),
  earlyAck: Object.freeze([
    Object.freeze([526, 373]),
    Object.freeze([500, 373]),
  ]),
  returnFromWal: Object.freeze([
    Object.freeze([500, 373]),
    Object.freeze([36, 373]),
    Object.freeze([36, 128]),
    Object.freeze([124, 128]),
  ]),
})

const statementPipeline = Object.freeze([
  Object.freeze({ id: 'parse', label: 'PARSE', x: 416 }),
  Object.freeze({ id: 'rewrite', label: 'REWRITE', x: 474 }),
  Object.freeze({ id: 'plan', label: 'PLAN', x: 532 }),
  Object.freeze({ id: 'execute', label: 'EXECUTE', x: 590 }),
])

const statementStagePoint = { x: 124, y: 128 }
const asyncWalStagePoint = { x: 526, y: 373 }
const pendingStatementStage = Object.freeze({
  source: 'model',
  label: 'Client',
  detail: 'waiting for PostgreSQL measurements',
  measurement: null,
})

const postgres = {
  status: 'idle',
  source: null,
  report: null,
  plan: null,
  initError: null,
  loadPromise: null,
  timing: false,
}

const primaryStatement = {
  status: 'idle',
  mode: 'auto',
  sql: '',
  shortSql: '',
  replay: null,
  elapsedMs: 0,
  stageElapsedMs: 0,
  stageIndex: 0,
  error: null,
}
let statement = primaryStatement

const MACHINE_BOARD_LABELS = Object.freeze([
  'CLIENT',
  'POSTMASTER',
  'BACKENDS',
  'PRIVATE MEMORY',
  'SHARED MEMORY SEGMENT',
  'BUFFER POOL (shared_buffers)',
  'WAL BUFFERS',
  'PROCARRAY',
  'LOCK TABLE',
  'pg_xact / SLRU BUFFERS',
  'KERNEL PAGE CACHE',
  'DATA FILES',
  'WAL',
  'pg_xact FILES',
  'WALSENDER',
  'STANDBY',
])

function safeWorkbenchClaim() {
  const replay = statement.replay
  const stage = replay?.stages[statement.stageIndex]
  const receipt = replay?.receipt
  const stageNarration = stage
    ? `M modelled stage narration: ${stage.label} · source marker ${stage.source === 'postgres' ? 'P' : 'M'} · ${stage.measurement ?? stage.detail}`
    : statement.status === 'measuring'
      ? 'M modelled stage narration: client is waiting for PostgreSQL measurements.'
      : statement.status === 'error'
        ? 'M modelled stage narration: the statement stopped; error details remain in the omitted transcript.'
        : 'M modelled stage narration: no foreground statement replay is active.'
  const measured = receipt
    ? `P measured receipt: ${receipt.sharedHits} shared buffer hits · ${receipt.sharedReads} shared reads · ${receipt.planningTimeMs.toFixed(3)} ms planning · ${receipt.executionTimeMs.toFixed(3)} ms execution · ${receipt.rowLabel} ${receipt.rows} · plan node ${receipt.planNode}`
    : 'P measured receipt: not available.'

  return [
    displayedClaim(machineDeck, machineVersionProvenance, terminalBanner, postgresMeasurement),
    `Board labels: ${MACHINE_BOARD_LABELS.join(' · ')}`,
    stageNarration,
    measured,
  ].filter(Boolean).join('\n')
}

createCorrectionPath(measurementRack, {
  surface: 'Machine / Workbench',
  panel: 'psql terminal and modelled machine',
  source: 'machine/index.html#console-pane; machine/magnum.js; machine/postgres.js',
  claim: safeWorkbenchClaim,
  claimCaptureNote:
    'The psql transcript is intentionally not included because it can contain user-typed SQL and result values. If the disputed sentence appears only there, quote it manually after opening the issue.',
  context: () => {
    const stage = statement.replay?.stages[statement.stageIndex]
    return [
      ['Foreground replay', stage ? `${statement.status}: ${stage.id}` : statement.status],
      ['PostgreSQL receipt', statement.replay?.receipt ? 'numeric measurements included' : 'not available'],
    ]
  },
})

const comparisonState = {
  visible: false,
  status: 'idle',
  model: null,
  elapsedMs: 0,
  holdReleased: false,
  flushComplete: false,
  error: null,
  statements: [null, null],
  stagePoints: [
    { x: 124, y: 128 },
    { x: 124, y: 128 },
  ],
  lastMobileStage: new Int16Array([-1, -1]),
}

const indexWalkEvidence = new Array(INDEX_WALK_STEPS.length).fill(null)
const indexWalkState = {
  visible: false,
  status: 'idle',
  invited: false,
  error: null,
}

createCorrectionPath(indexWalkFooter, {
  surface: 'Machine / First index walk',
  panel: 'SELECT 1 to indexed and unindexed access paths',
  source: 'src/spine/machine-index-walk.ts#MACHINE_INDEX_WALK; machine/index-walk.js',
  claim: () => displayedClaim(
    indexWalkIntro,
    indexWalkStepsRoot,
    indexWalkFindingRoot,
    indexWalkDisclosures,
  ),
  context: () => [
    ['Walk status', indexWalkStatus.textContent || 'unknown'],
    ['Completed PostgreSQL receipts', String(indexWalkEvidence.filter(Boolean).length)],
  ],
  disclosure: true,
})

const params = new URLSearchParams(window.location.search)
const suppliedTimeParam = params.get('t')
const suppliedTime = suppliedTimeParam === null ? Number.NaN : Number(suppliedTimeParam)
let manualTime = Number.isFinite(suppliedTime) ? wrap(suppliedTime, MASTER_PERIOD) : 0
let paused = Number.isFinite(suppliedTime) || params.get('paused') === '1'
let viewingRate = nearestViewingRate(params.get('rate'))
let labelsVisible = params.get('labels') !== '0'
let lastFrame = performance.now()
let cssWidth = 0
let cssHeight = 0
let viewScale = 1
let viewX = 0
let viewY = 0
let boardFitScale = 1
let boardCameraReady = false
let boardViewportLeft = 0
let boardViewportTop = 0
let mobileBoard = false
let boardFollowing = true
let detailViewX = -12
let detailViewY = 0
let completionFollowPending = false
let queryBusy = false
let historyIndex = 0
let historyDraft = ''
const history = []
const followViewport = {
  clientWidth: 0,
  clientHeight: 0,
  scale: 1,
  viewX: 0,
  viewY: 0,
}
const boardCameraOutput = { scale: 1, viewX: 0, viewY: 0 }
const pointerIds = new Int32Array(2)
const pointerActive = new Uint8Array(2)
const pointerX = new Float64Array(2)
const pointerY = new Float64Array(2)
let activePointerCount = 0
let pointerStartX = 0
let pointerStartY = 0
let gestureMoved = false
let gestureHadMultiplePointers = false
let suppressCanvasClickUntil = -1000
let lastTapTime = -1000
let lastTapX = 0
let lastTapY = 0

function clamp(value, low = 0, high = 1) {
  return Math.max(low, Math.min(high, value))
}

function wrap(value, period) {
  return ((value % period) + period) % period
}

function phase(time, period, offset = 0) {
  return wrap(time + offset, period) / period
}

function smooth(value) {
  const x = clamp(value)
  return x * x * (3 - 2 * x)
}

function easeInOut(value) {
  return 0.5 - Math.cos(clamp(value) * Math.PI) / 2
}

function range(value, start, end) {
  return clamp((value - start) / (end - start))
}

function pulse(value, center, radius) {
  return clamp(1 - Math.abs(value - center) / radius)
}

function lerp(a, b, amount) {
  return a + (b - a) * amount
}

function shortenSql(sql) {
  const oneLine = String(sql).replaceAll(/\s+/g, ' ').trim()
  return oneLine.length > 82 ? `${oneLine.slice(0, 79)}…` : oneLine
}

function startStatementMeasurement(sql) {
  statement.status = 'measuring'
  statement.sql = String(sql)
  statement.shortSql = shortenSql(sql)
  statement.replay = null
  statement.elapsedMs = 0
  statement.stageElapsedMs = 0
  statement.stageIndex = 0
  statement.error = null
  completionFollowPending = false
  postgres.report = null
  postgres.plan = null
  updatePostgresUi()
  updateStatementControls()
}

function startStatementReplay(report) {
  statement.replay = createStatementReplay(report)
  statement.sql = statement.replay.sql
  statement.shortSql = shortenSql(statement.sql)
  statement.elapsedMs = 0
  statement.stageElapsedMs = 0
  statement.stageIndex = activeStatementStageIndex(statement.replay, 0)
  statement.error = report.error?.message ?? null
  statement.status = report.error ? 'error' : 'replaying'
  if (statement.status === 'error') statement.stageIndex = 2
  completionFollowPending = statement.status === 'error'
  updatePostgresUi()
  updateStatementControls()
}

function failStatementMeasurement(error) {
  statement.status = 'error'
  statement.error = error instanceof Error ? error.message : String(error)
  statement.replay = null
  statement.stageIndex = 2
  completionFollowPending = true
  updatePostgresUi()
  updateStatementControls()
}

function elapsedAtStatementStage(replay, targetIndex) {
  let elapsed = 0
  for (let index = 0; index < targetIndex; index += 1) {
    const stage = replay.stages[index]
    if (!stage.skipped) elapsed += stage.durationMs
  }
  return elapsed
}

function setStatementMode(mode) {
  statement.mode = mode === 'step' ? 'step' : 'auto'
  if (statement.status === 'replaying' && statement.replay) {
    if (statement.mode === 'step') {
      statement.stageElapsedMs = statement.replay.stages[statement.stageIndex].durationMs
    } else {
      statement.elapsedMs =
        elapsedAtStatementStage(statement.replay, statement.stageIndex)
        + statement.stageElapsedMs
    }
  }
  updateStatementControls()
}

function toggleStatementMode() {
  setStatementMode(statement.mode === 'auto' ? 'step' : 'auto')
}

function stepStatementReplay() {
  if (statement.status !== 'replaying' || !statement.replay || statement.mode !== 'step') return
  const next = nextStatementStageIndex(statement.replay, statement.stageIndex)
  if (next === statement.stageIndex) {
    statement.status = 'complete'
    completionFollowPending = true
  } else {
    statement.stageIndex = next
    statement.stageElapsedMs = statement.replay.stages[next].durationMs
    statement.elapsedMs = elapsedAtStatementStage(statement.replay, next)
  }
  updateStatementControls()
  completeIndexWalkReplayIfReady()
}

function updateStatementReplay(elapsedSeconds) {
  if (
    statement.status !== 'replaying'
    || statement.mode !== 'auto'
    || !statement.replay
  ) return
  statement.elapsedMs = Math.min(
    statement.replay.durationMs,
    statement.elapsedMs + elapsedSeconds * 1000,
  )
  const nextIndex = activeStatementStageIndex(statement.replay, statement.elapsedMs)
  statement.stageIndex = nextIndex
  statement.stageElapsedMs =
    statement.elapsedMs - elapsedAtStatementStage(statement.replay, nextIndex)
  if (statement.elapsedMs >= statement.replay.durationMs) {
    statement.status = 'complete'
    completionFollowPending = true
    completeIndexWalkReplayIfReady()
  }
}

function makeComparisonStatement(replay) {
  return {
    status: 'replaying',
    mode: 'auto',
    sql: replay.sql,
    shortSql: shortenSql(replay.sql),
    replay,
    elapsedMs: 0,
    stageElapsedMs: 0,
    stageIndex: activeStatementStageIndex(replay, 0),
    error: null,
  }
}

function syncComparisonStatement(laneIndex) {
  const lane = comparisonState.model?.lanes[laneIndex]
  const laneStatement = comparisonState.statements[laneIndex]
  if (!lane || !laneStatement) return
  const elapsedMs = Math.min(comparisonState.elapsedMs, lane.replay.durationMs)
  laneStatement.elapsedMs = elapsedMs
  laneStatement.stageIndex = activeStatementStageIndex(lane.replay, elapsedMs)
  laneStatement.stageElapsedMs =
    elapsedMs - elapsedAtStatementStage(lane.replay, laneStatement.stageIndex)
  laneStatement.status = comparisonState.elapsedMs >= lane.replay.durationMs
    ? 'complete'
    : 'replaying'
}

function comparisonFlushProgress() {
  const laneStatement = comparisonState.statements[1]
  const durationMs = laneStatement?.replay?.backgroundFlushDurationMs
  if (
    !durationMs
    || laneStatement.replay.stages[laneStatement.stageIndex]?.id !== 'return'
  ) return 0
  return clamp(laneStatement.stageElapsedMs / durationMs)
}

function comparisonPhaseText(laneIndex) {
  const laneStatement = comparisonState.statements[laneIndex]
  if (comparisonState.status === 'loading') return 'P MEASURING'
  if (comparisonState.status === 'error') return 'P UNAVAILABLE'
  if (!laneStatement?.replay) return 'READY'
  if (comparisonState.status === 'finding' && laneIndex === 0) {
    return 'M · WAITING FOR LOCAL FLUSH'
  }
  if (
    laneIndex === 1
    && laneStatement.replay.stages[laneStatement.stageIndex].id === 'return'
  ) {
    return comparisonState.flushComplete
      ? 'M · FLUSHED; LOSS WINDOW CLOSED'
      : 'M · ACK SENT; ACKS AT RISK'
  }
  if (laneStatement.status === 'complete') return 'COMPLETE'
  return `${laneStatement.stageIndex + 1}/${laneStatement.replay.stages.length} · ${laneStatement.replay.stages[laneStatement.stageIndex].label.toUpperCase()}`
}

function updateComparisonUi() {
  comparisonRoot.hidden = !comparisonState.visible
  comparisonStatus.textContent =
    comparisonState.status === 'loading'
      ? 'P RECORDING ONE EXECUTION'
      : comparisonState.status === 'running'
        ? 'M REPLAYS IN LOCKSTEP'
        : comparisonState.status === 'finding'
          ? 'HELD AT THE DIFFERENCE'
          : comparisonState.status === 'complete'
            ? 'REPLAY COMPLETE'
            : comparisonState.status === 'error'
              ? 'P REPORT UNAVAILABLE'
              : 'READY'
  comparisonPhaseA.textContent = comparisonPhaseText(0)
  comparisonPhaseB.textContent = comparisonPhaseText(1)
  comparisonContinue.hidden = comparisonState.status !== 'finding'
  comparisonRun.disabled = comparisonState.status === 'loading'
  comparisonRun.textContent = comparisonState.model
    ? 'RUN AGAIN'
    : 'RUN MODELLED REPLAY'
  comparisonFinding.textContent = SYNCHRONOUS_COMMIT_COMPARISON_CLAIM.finding
  comparisonPgliteDisclosure.textContent =
    SYNCHRONOUS_COMMIT_COMPARISON_CLAIM.pgliteDisclosure
  comparisonReplayDisclosure.textContent =
    SYNCHRONOUS_COMMIT_COMPARISON_CLAIM.replayDisclosure
  comparisonNoteB.textContent = comparisonState.flushComplete
    ? 'WAL FLUSH COMPLETE; LOSS WINDOW CLOSED'
    : 'EARLY ACK; CRASH CAN LOSE RECENT ACKS UNTIL WAL FLUSH'
  comparisonSql.textContent = COMPARISON_SQL
  if (comparisonState.error) {
    comparisonFinding.textContent =
      `P report unavailable: ${comparisonState.error} The modelled comparison did not run.`
  }
}

function openComparison() {
  if (indexWalkState.visible) {
    indexWalkState.visible = false
    updateIndexWalkUi()
  }
  comparisonState.visible = true
  updateComparisonUi()
  comparisonRun.focus()
}

function closeComparison() {
  comparisonState.visible = false
  updateComparisonUi()
  comparisonOpen.focus()
}

function nextIndexWalkStep() {
  const index = indexWalkEvidence.findIndex((entry) => entry === null)
  return index < 0 ? INDEX_WALK_STEPS.length : index
}

function indexWalkStatusText(completed) {
  if (indexWalkState.status === 'running') return `P EXECUTING · ${completed}/4`
  if (indexWalkState.status === 'watching') return `M REPLAY · ${completed}/4`
  if (indexWalkState.status === 'error') return `RETRY · ${completed}/4`
  if (completed === INDEX_WALK_STEPS.length) return 'P SEQUENCE COMPLETE · 4/4'
  return `READY · ${completed}/4`
}

function updateIndexWalkUi() {
  const completed = indexWalkEvidence.filter(Boolean).length
  const next = nextIndexWalkStep()
  const blocked = indexWalkState.status === 'running' || indexWalkState.status === 'watching'
  indexWalkRoot.hidden = !indexWalkState.visible
  indexWalkStatus.textContent = indexWalkStatusText(completed)
  indexWalkOpen.textContent = completed === INDEX_WALK_STEPS.length
    ? 'WALK DONE'
    : indexWalkState.invited
      ? 'WHAT NEXT?'
      : completed > 0
        ? 'CONTINUE WALK'
        : 'START HERE'
  indexWalkOpen.dataset.invited = String(indexWalkState.invited && completed < 4)

  for (let index = 0; index < INDEX_WALK_STEPS.length; index += 1) {
    const step = INDEX_WALK_STEPS[index]
    const button = indexWalkStepButtons[index]
    const output = button.querySelector(`[data-index-walk-result="${step.id}"]`)
    const evidence = indexWalkEvidence[index]
    const active = index === next
    button.dataset.state = evidence ? 'complete' : active ? 'active' : 'locked'
    button.disabled = Boolean(evidence) || blocked || !active
    if (active) button.setAttribute('aria-current', 'step')
    else button.removeAttribute('aria-current')
    if (!output) continue
    output.textContent = evidence
      ? `P · ${evidence.summary}`
      : active && indexWalkState.error
        ? `RETRY · ${indexWalkState.error}`
        : active
          ? blocked ? 'WAIT FOR THIS REPLAY' : 'RUN THIS STATEMENT'
          : 'LOCKED'
  }

  const finished = completed === INDEX_WALK_STEPS.length
  indexWalkFindingRoot.hidden = !finished
  if (finished) {
    const finding = indexWalkFinding(indexWalkEvidence)
    indexWalkFindingRoot.dataset.supported = String(finding.supported)
    indexWalkFindingText.textContent = finding.text
  }
  indexWalkSequence.textContent = INDEX_WALK_CLAIM.sequenceDisclosure
  indexWalkModel.textContent = INDEX_WALK_CLAIM.modelDisclosure
  indexWalkComparison.textContent = INDEX_WALK_CLAIM.comparisonDisclosure
  indexWalkReset.disabled = indexWalkState.status === 'running'
  if (indexWalkState.visible) {
    const visibleStep = indexWalkStepButtons[Math.min(next, INDEX_WALK_STEPS.length - 1)]
    requestAnimationFrame(() => {
      const firstTop = indexWalkStepButtons[0].offsetTop
      const stepBottom = visibleStep.offsetTop - firstTop + visibleStep.offsetHeight
      indexWalkStepsRoot.scrollTo({
        top: Math.max(0, stepBottom - indexWalkStepsRoot.clientHeight),
        behavior: 'smooth',
      })
    })
  }
}

function openIndexWalk() {
  if (comparisonState.visible) {
    comparisonState.visible = false
    updateComparisonUi()
  }
  indexWalkState.visible = true
  updateIndexWalkUi()
  const next = nextIndexWalkStep()
  ;(indexWalkStepButtons[next] ?? indexWalkClose).focus()
}

function closeIndexWalk() {
  indexWalkState.visible = false
  updateIndexWalkUi()
  indexWalkOpen.focus()
}

function resetIndexWalk() {
  indexWalkEvidence.fill(null)
  indexWalkState.status = 'idle'
  indexWalkState.invited = false
  indexWalkState.error = null
  updateIndexWalkUi()
}

function offerIndexWalk(report) {
  if (indexWalkEvidence.some(Boolean) || indexWalkState.status !== 'idle') return
  if (matchingIndexWalkStep(report) !== 'constant') return
  const evidence = createIndexWalkEvidence('constant', report)
  if (!evidence) return
  indexWalkEvidence[0] = evidence
  indexWalkState.invited = true
  indexWalkState.status = statement.status === 'replaying' ? 'watching' : 'ready'
  updateIndexWalkUi()
}

function completeIndexWalkReplayIfReady() {
  if (indexWalkState.status !== 'watching') return
  if (statement.status !== 'complete' && statement.status !== 'error') return
  indexWalkState.status = nextIndexWalkStep() === INDEX_WALK_STEPS.length
    ? 'complete'
    : 'ready'
  updateIndexWalkUi()
}

async function runIndexWalkStep(stepId) {
  const index = INDEX_WALK_STEPS.findIndex((step) => step.id === stepId)
  if (
    index < 0
    || index !== nextIndexWalkStep()
    || indexWalkState.status === 'running'
    || indexWalkState.status === 'watching'
  ) return false
  const step = INDEX_WALK_STEPS[index]
  indexWalkState.status = 'running'
  indexWalkState.error = null
  updateIndexWalkUi()
  const report = await submitCommand(step.sql)
  if (!report || report.error || matchingIndexWalkStep(report) !== step.id) {
    indexWalkState.status = 'error'
    indexWalkState.error = report?.error?.message ?? 'PostgreSQL report unavailable'
    updateIndexWalkUi()
    return false
  }
  const evidence = createIndexWalkEvidence(step.id, report)
  if (!evidence) {
    indexWalkState.status = 'error'
    indexWalkState.error = 'PostgreSQL returned no measured plan'
    updateIndexWalkUi()
    return false
  }
  indexWalkEvidence[index] = evidence
  indexWalkState.status = statement.status === 'replaying'
    ? 'watching'
    : nextIndexWalkStep() === INDEX_WALK_STEPS.length
      ? 'complete'
      : 'ready'
  updateIndexWalkUi()
  return true
}

async function runSynchronousCommitComparison() {
  if (queryBusy || comparisonState.status === 'loading') return false
  openComparison()
  comparisonState.status = 'loading'
  comparisonState.model = null
  comparisonState.statements[0] = null
  comparisonState.statements[1] = null
  comparisonState.error = null
  comparisonState.elapsedMs = 0
  comparisonState.holdReleased = false
  comparisonState.flushComplete = false
  comparisonState.lastMobileStage.fill(-1)
  updateComparisonUi()
  queryBusy = true
  try {
    const source = await loadPostgres(false)
    if (!source) throw new Error(postgres.initError ?? 'PostgreSQL could not start')
    const report = await source.query(COMPARISON_SQL)
    if (report.error) throw new Error(report.error.message)
    const model = createSynchronousCommitComparison(report)
    comparisonState.model = model
    comparisonState.statements[0] = makeComparisonStatement(model.lanes[0].replay)
    comparisonState.statements[1] = makeComparisonStatement(model.lanes[1].replay)
    comparisonState.elapsedMs = 0
    comparisonState.status = 'running'
    setCurrentReport(report)
    updateComparisonUi()
    return true
  } catch (error) {
    comparisonState.status = 'error'
    comparisonState.error = error instanceof Error ? error.message : String(error)
    updateComparisonUi()
    return false
  } finally {
    queryBusy = false
  }
}

function continueComparison() {
  if (comparisonState.status !== 'finding') return
  comparisonState.holdReleased = true
  comparisonState.status = 'running'
  updateComparisonUi()
}

function selectComparisonLane(laneIndex) {
  const board = comparisonLanes.children[laneIndex]
  if (!(board instanceof HTMLElement)) return
  comparisonLanes.scrollTo({
    left: board.offsetLeft - comparisonLanes.offsetLeft,
    behavior: 'smooth',
  })
  comparisonTabA.setAttribute('aria-pressed', String(laneIndex === 0))
  comparisonTabB.setAttribute('aria-pressed', String(laneIndex === 1))
}

function updateComparisonTabsFromScroll() {
  const laneIndex = comparisonLanes.scrollLeft > comparisonLanes.clientWidth / 2 ? 1 : 0
  comparisonTabA.setAttribute('aria-pressed', String(laneIndex === 0))
  comparisonTabB.setAttribute('aria-pressed', String(laneIndex === 1))
}

function updateComparison(elapsedSeconds) {
  const model = comparisonState.model
  if (!model || comparisonState.status !== 'running') return
  const previousStatus = comparisonState.status
  const previousStageA = comparisonState.statements[0]?.stageIndex
  const previousStageB = comparisonState.statements[1]?.stageIndex
  const nextElapsedMs = comparisonState.elapsedMs + elapsedSeconds * 1000
  if (
    !comparisonState.holdReleased
    && comparisonState.elapsedMs < model.observationAtMs
    && nextElapsedMs >= model.observationAtMs
  ) {
    comparisonState.elapsedMs = model.observationAtMs
    comparisonState.status = 'finding'
    comparisonState.lastMobileStage.fill(-1)
  } else {
    comparisonState.elapsedMs = nextElapsedMs
  }
  syncComparisonStatement(0)
  syncComparisonStatement(1)
  const flushComplete = comparisonFlushProgress() >= 1
  const flushStateChanged = flushComplete !== comparisonState.flushComplete
  if (flushStateChanged) {
    comparisonState.flushComplete = flushComplete
    comparisonState.lastMobileStage[1] = -1
  }
  if (
    comparisonState.status === 'running'
    && comparisonState.statements[0]?.status === 'complete'
    && comparisonState.statements[1]?.status === 'complete'
  ) {
    comparisonState.status = 'complete'
  }
  if (
    previousStatus !== comparisonState.status
    || previousStageA !== comparisonState.statements[0]?.stageIndex
    || previousStageB !== comparisonState.statements[1]?.stageIndex
    || flushStateChanged
  ) updateComparisonUi()
}

function updateStatementControls() {
  statementMode.textContent = statement.mode === 'auto' ? 'TRACE: AUTO' : 'TRACE: STEP'
  statementMode.setAttribute('aria-pressed', String(statement.mode === 'step'))
  statementNext.disabled = statement.status !== 'replaying' || statement.mode !== 'step'
  if (statement.status === 'measuring') {
    statementState.textContent = 'MEASURING'
  } else if (statement.status === 'replaying' && statement.replay) {
    statementState.textContent =
      `STATEMENT ${statement.stageIndex + 1}/${statement.replay.stages.length}`
  } else if (statement.status === 'complete') {
    statementState.textContent = 'RECEIPT'
  } else if (statement.status === 'error') {
    statementState.textContent = 'STATEMENT ERROR'
  } else {
    statementState.textContent = 'NO STATEMENT'
  }
  const receipt = statement.replay?.receipt
  canvas.setAttribute(
    'aria-label',
    receipt
      ? `PostgreSQL statement replay and architecture. Measured: ${receipt.sharedHits} shared buffer hits, ${receipt.sharedReads} shared reads, ${receipt.planningTimeMs} milliseconds planning, ${receipt.executionTimeMs} milliseconds execution, ${receipt.rows} rows.`
      : 'A layered PostgreSQL architecture with modelled ambient processes and a foreground trace for the submitted statement.',
  )
}

function resize() {
  const wasMobileBoard = mobileBoard
  const wasFit = boardCameraReady && isBoardFit()
  mobileBoard = mobileBoardMedia.matches
  if (mobileBoard !== wasMobileBoard) comparisonState.lastMobileStage.fill(-1)
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  const bounds = architectureStage.getBoundingClientRect()
  const viewportBounds = architectureScroll.getBoundingClientRect()
  cssWidth = Math.max(1, bounds.width)
  cssHeight = Math.max(1, bounds.height)
  boardViewportLeft = viewportBounds.left
  boardViewportTop = viewportBounds.top
  boardFitScale = fitBoardScale(cssWidth, cssHeight)

  if (!boardCameraReady || mobileBoard !== wasMobileBoard) {
    viewScale = mobileBoard ? Math.max(boardFitScale, 1) : boardFitScale
    viewX = mobileBoard && viewScale > boardFitScale
      ? detailViewX
      : (cssWidth - VIEW_W * viewScale) / 2
    viewY = mobileBoard && viewScale > boardFitScale
      ? detailViewY
      : (cssHeight - VIEW_H * viewScale) / 2
    boardCameraReady = true
  } else {
    viewScale = wasFit
      ? boardFitScale
      : clamp(viewScale, boardFitScale, BOARD_MAX_SCALE)
  }

  followViewport.clientWidth = cssWidth
  followViewport.clientHeight = cssHeight
  followViewport.scale = viewScale
  followViewport.viewX = viewX
  followViewport.viewY = viewY
  clampBoardView(followViewport, viewX, viewY, boardCameraOutput)
  viewScale = boardCameraOutput.scale
  viewX = boardCameraOutput.viewX
  viewY = boardCameraOutput.viewY

  canvas.width = Math.max(1, Math.floor(cssWidth * ratio))
  canvas.height = Math.max(1, Math.floor(cssHeight * ratio))
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${cssHeight}px`
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  if (mobileBoard && !isBoardFit() && needsCompletionFollow(statement.status)) {
    completionFollowPending = true
  }
  updateBoardView()
}

function isBoardFit() {
  return Math.abs(viewScale - boardFitScale) < 0.0001
}

function populateBoardViewport() {
  followViewport.clientWidth = cssWidth
  followViewport.clientHeight = cssHeight
  followViewport.scale = viewScale
  followViewport.viewX = viewX
  followViewport.viewY = viewY
}

function applyBoardCameraOutput() {
  viewScale = boardCameraOutput.scale
  viewX = boardCameraOutput.viewX
  viewY = boardCameraOutput.viewY
  if (!isBoardFit()) {
    detailViewX = viewX
    detailViewY = viewY
  }
}

function updateBoardView() {
  const fit = isBoardFit()
  boardView.textContent = fit ? '1:1 DETAIL' : 'FIT BOARD'
  boardView.setAttribute('aria-pressed', String(fit))
  boardView.title = fit
    ? 'Return to the legible one-to-one board'
    : 'Fit the whole board on screen'
  boardFollow.textContent = boardFollowing ? 'FOLLOW: ON' : 'FOLLOW STAGE'
  boardFollow.setAttribute('aria-pressed', String(boardFollowing))
  boardFollow.title = boardFollowing
    ? 'The active statement stage stays in view'
    : 'Resume following the active statement stage'
}

function takeManualBoardControl() {
  if (!mobileBoard || !boardFollowing) return
  boardFollowing = false
  updateBoardView()
}

function setBoardScaleAt(
  requestedScale,
  fromX,
  fromY,
  toX,
  toY,
  manualControl = true,
) {
  if (manualControl) takeManualBoardControl()
  populateBoardViewport()
  zoomBoardView(
    followViewport,
    requestedScale,
    fromX,
    fromY,
    toX,
    toY,
    boardFitScale,
    boardCameraOutput,
  )
  applyBoardCameraOutput()
  updateBoardView()
}

function setBoardFit(nextFit, manualControl = true) {
  if (!mobileBoard) return
  const next = Boolean(nextFit)
  if (next === isBoardFit()) return
  if (manualControl) takeManualBoardControl()
  if (next) {
    detailViewX = viewX
    detailViewY = viewY
    populateBoardViewport()
    zoomBoardView(
      followViewport,
      boardFitScale,
      cssWidth / 2,
      cssHeight / 2,
      cssWidth / 2,
      cssHeight / 2,
      boardFitScale,
      boardCameraOutput,
    )
  } else {
    followViewport.clientWidth = cssWidth
    followViewport.clientHeight = cssHeight
    followViewport.scale = Math.max(boardFitScale, 1)
    followViewport.viewX = detailViewX
    followViewport.viewY = detailViewY
    clampBoardView(
      followViewport,
      detailViewX,
      detailViewY,
      boardCameraOutput,
    )
  }
  applyBoardCameraOutput()
  if (!next && needsCompletionFollow(statement.status)) {
    completionFollowPending = true
  }
  updateBoardView()
}

function toggleBoardFit() {
  setBoardFit(!isBoardFit())
}

function enableBoardFollow() {
  if (!mobileBoard) return
  boardFollowing = true
  if (isBoardFit() && boardFitScale < 1) {
    setBoardScaleAt(
      1,
      cssWidth / 2,
      cssHeight / 2,
      cssWidth / 2,
      cssHeight / 2,
      false,
    )
  }
  completionFollowPending = true
  updateBoardView()
  followMobileStatement()
}

function followMobileStatement() {
  if (!mobileBoard || !boardFollowing || statement.status === 'idle') return
  const finished = needsCompletionFollow(statement.status)
  if (finished && !completionFollowPending) return
  let targetX = statementStagePoint.x
  let targetY = statementStagePoint.y
  if (finished) {
    targetX = RECEIPT_FOCUS.x
    targetY = RECEIPT_FOCUS.y
  }

  populateBoardViewport()
  containBoardPoint(
    followViewport,
    targetX,
    targetY,
    boardCameraOutput,
  )
  applyBoardCameraOutput()
  if (finished) completionFollowPending = false
}

function pointerSlot(pointerId) {
  for (let index = 0; index < pointerActive.length; index += 1) {
    if (pointerActive[index] && pointerIds[index] === pointerId) return index
  }
  return -1
}

function openPointerSlot() {
  for (let index = 0; index < pointerActive.length; index += 1) {
    if (!pointerActive[index]) return index
  }
  return -1
}

function otherPointerSlot(slot) {
  const other = slot === 0 ? 1 : 0
  return pointerActive[other] ? other : -1
}

function boardPointerX(event) {
  return event.clientX - boardViewportLeft
}

function boardPointerY(event) {
  return event.clientY - boardViewportTop
}

function onBoardPointerDown(event) {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  if (pointerSlot(event.pointerId) >= 0) return
  const slot = openPointerSlot()
  if (slot < 0) return

  const x = boardPointerX(event)
  const y = boardPointerY(event)
  pointerActive[slot] = 1
  pointerIds[slot] = event.pointerId
  pointerX[slot] = x
  pointerY[slot] = y
  activePointerCount += 1
  architectureScroll.setPointerCapture(event.pointerId)

  if (activePointerCount === 1) {
    pointerStartX = x
    pointerStartY = y
    gestureMoved = false
    gestureHadMultiplePointers = false
  } else {
    gestureHadMultiplePointers = true
    gestureMoved = true
    takeManualBoardControl()
  }
  event.preventDefault()
}

function onBoardPointerMove(event) {
  const slot = pointerSlot(event.pointerId)
  if (slot < 0) return
  const previousX = pointerX[slot]
  const previousY = pointerY[slot]
  const nextX = boardPointerX(event)
  const nextY = boardPointerY(event)
  const other = otherPointerSlot(slot)

  if (other >= 0) {
    const oldMidpointX = (previousX + pointerX[other]) / 2
    const oldMidpointY = (previousY + pointerY[other]) / 2
    const oldDistance = Math.hypot(
      previousX - pointerX[other],
      previousY - pointerY[other],
    )
    pointerX[slot] = nextX
    pointerY[slot] = nextY
    const newMidpointX = (nextX + pointerX[other]) / 2
    const newMidpointY = (nextY + pointerY[other]) / 2
    const newDistance = Math.hypot(
      nextX - pointerX[other],
      nextY - pointerY[other],
    )
    if (oldDistance > 0.001 && newDistance > 0.001) {
      setBoardScaleAt(
        viewScale * newDistance / oldDistance,
        oldMidpointX,
        oldMidpointY,
        newMidpointX,
        newMidpointY,
      )
    }
  } else {
    pointerX[slot] = nextX
    pointerY[slot] = nextY
    const fromStartX = nextX - pointerStartX
    const fromStartY = nextY - pointerStartY
    if (
      !gestureMoved
      && fromStartX * fromStartX + fromStartY * fromStartY >= 16
    ) {
      gestureMoved = true
      takeManualBoardControl()
    }
    if (gestureMoved) {
      populateBoardViewport()
      clampBoardView(
        followViewport,
        viewX + nextX - previousX,
        viewY + nextY - previousY,
        boardCameraOutput,
      )
      applyBoardCameraOutput()
    }
  }
  event.preventDefault()
}

function toggleBoardDetailAt(x, y) {
  if (isBoardFit()) {
    setBoardScaleAt(Math.max(boardFitScale, 1), x, y, x, y)
  } else {
    setBoardFit(true)
  }
}

function releaseBoardPointer(event, cancelled) {
  const slot = pointerSlot(event.pointerId)
  if (slot < 0) return
  const wasTouch = event.pointerType === 'touch'
  const tap =
    !cancelled
    && wasTouch
    && activePointerCount === 1
    && !gestureMoved
    && !gestureHadMultiplePointers
  const tapX = pointerX[slot]
  const tapY = pointerY[slot]

  pointerActive[slot] = 0
  activePointerCount -= 1
  if (architectureScroll.hasPointerCapture(event.pointerId)) {
    architectureScroll.releasePointerCapture(event.pointerId)
  }

  if (tap) {
    const elapsed = event.timeStamp - lastTapTime
    const deltaX = tapX - lastTapX
    const deltaY = tapY - lastTapY
    if (elapsed > 0 && elapsed <= 320 && deltaX * deltaX + deltaY * deltaY <= 576) {
      toggleBoardDetailAt(tapX, tapY)
      lastTapTime = -1000
    } else {
      lastTapTime = event.timeStamp
      lastTapX = tapX
      lastTapY = tapY
    }
  }

  if (wasTouch || gestureMoved) {
    suppressCanvasClickUntil = event.timeStamp + 500
  }
  const remaining = pointerActive[0] ? 0 : pointerActive[1] ? 1 : -1
  if (remaining >= 0) {
    pointerStartX = pointerX[remaining]
    pointerStartY = pointerY[remaining]
  }
  event.preventDefault()
}

function onBoardPointerUp(event) {
  releaseBoardPointer(event, false)
}

function onBoardPointerCancel(event) {
  releaseBoardPointer(event, true)
}

function onBoardWheel(event) {
  event.preventDefault()
  let delta = event.deltaY
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= cssHeight
  delta = clamp(delta, -120, 120)
  const x = boardPointerX(event)
  const y = boardPointerY(event)
  setBoardScaleAt(viewScale * Math.exp(-delta * 0.002), x, y, x, y)
}

function onCanvasClick(event) {
  if (event.timeStamp <= suppressCanvasClickUntil) return
  togglePaused()
}

function pathRoundRect(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

function fillStroke(fill, stroke, width = 1) {
  if (fill) {
    ctx.fillStyle = fill
    ctx.fill()
  }
  if (stroke) {
    ctx.strokeStyle = stroke
    ctx.lineWidth = width
    ctx.stroke()
  }
}

function line(x1, y1, x2, y2, color, width = 1, dash = []) {
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.setLineDash(dash)
  ctx.stroke()
  ctx.setLineDash([])
}

function arrow(x1, y1, x2, y2, color, width = 2) {
  line(x1, y1, x2, y2, color, width)
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const size = 7
  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(
    x2 - Math.cos(angle - 0.55) * size,
    y2 - Math.sin(angle - 0.55) * size,
  )
  ctx.lineTo(
    x2 - Math.cos(angle + 0.55) * size,
    y2 - Math.sin(angle + 0.55) * size,
  )
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
}

function text(value, x, y, size, color, align = 'left', weight = 600) {
  if (!labelsVisible) return
  const renderedSize = mobileBoard
    ? detailFontSize(size, viewScale, boardFitScale)
    : size
  if (renderedSize === 0) return
  ctx.fillStyle = color
  ctx.font = `${weight} ${renderedSize}px Georgia, "Times New Roman", serif`
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.fillText(value, x, y)
}

function mono(value, x, y, size, color, align = 'left', weight = 600) {
  if (!labelsVisible) return
  const renderedSize = mobileBoard
    ? detailFontSize(size, viewScale, boardFitScale)
    : size
  if (renderedSize === 0) return
  ctx.fillStyle = color
  ctx.font = `${weight} ${renderedSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.fillText(value, x, y)
}

function drawIsoPlate(x, y, width, height, depth, fill, edge = ink.brassDark, radius = 8) {
  ctx.beginPath()
  ctx.moveTo(x, y + height)
  ctx.lineTo(x + width, y + height)
  ctx.lineTo(x + width + depth, y + height - depth)
  ctx.lineTo(x + depth, y + height - depth)
  ctx.closePath()
  fillStroke(ink.brassDark, '#241610', 1.5)

  ctx.beginPath()
  ctx.moveTo(x + width, y)
  ctx.lineTo(x + width + depth, y - depth)
  ctx.lineTo(x + width + depth, y + height - depth)
  ctx.lineTo(x + width, y + height)
  ctx.closePath()
  fillStroke('#4a2c1b', '#241610', 1.5)

  pathRoundRect(x, y, width, height, radius)
  fillStroke(fill, edge, 2)
}

function drawScrew(x, y, radius = 4) {
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, TAU)
  fillStroke(ink.ironHi, '#171312', 1)
  line(x - radius * 0.55, y, x + radius * 0.55, y, '#171312', 1)
}

function drawSourceMedallion(x, y, source, radius = 8) {
  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, TAU)
  ctx.clip()
  ctx.fillStyle = source === 'postgres' ? '#31575a' : '#3d3027'
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2)
  if (source === 'model') {
    for (let d = -radius * 2; d <= radius * 2; d += 4) {
      line(x - radius + d, y + radius, x + radius + d, y - radius, '#7a5d42', 0.8)
    }
  }
  ctx.restore()
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, TAU)
  ctx.strokeStyle = source === 'postgres' ? '#9fcfd0' : ink.paperDim
  ctx.lineWidth = 1
  ctx.stroke()
  mono(source === 'postgres' ? 'P' : 'M', x, y + 0.5, radius, ink.ivory, 'center', 800)
}

function drawPlaque(label, period, x, y, width, source = 'model') {
  pathRoundRect(x, y, width, 24, 4)
  fillStroke('#27201c', '#8b6940', 1)
  drawSourceMedallion(x + 12, y + 12, source, 7)
  mono(label, x + 23, y + 9, 7.5, ink.ivory, 'left', 750)
  mono(`${period}s`, x + width - 7, y + 17, 6.5, ink.paperDim, 'right', 650)
}

function drawGear(x, y, radius, teeth, angle, fill = ink.brass) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.beginPath()
  for (let index = 0; index < teeth * 2; index += 1) {
    const a = (index / (teeth * 2)) * TAU
    const r = index % 2 === 0 ? radius : radius * 0.83
    const px = Math.cos(a) * r
    const py = Math.sin(a) * r
    if (index === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  fillStroke(fill, ink.brassDark, 1.5)
  ctx.beginPath()
  ctx.arc(0, 0, radius * 0.43, 0, TAU)
  fillStroke(ink.iron, ink.brassHi, 1.5)
  drawScrew(0, 0, Math.max(2.5, radius * 0.12))
  ctx.restore()
}

function drawTrack(points, color = '#66513c', width = 6) {
  ctx.beginPath()
  ctx.moveTo(points[0][0], points[0][1])
  for (let index = 1; index < points.length; index += 1) {
    ctx.lineTo(points[index][0], points[index][1])
  }
  ctx.lineJoin = 'round'
  ctx.strokeStyle = ink.groove
  ctx.lineWidth = width + 4
  ctx.stroke()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.stroke()
  ctx.strokeStyle = '#b7925a'
  ctx.lineWidth = 0.8
  ctx.setLineDash([3, 8])
  ctx.stroke()
  ctx.setLineDash([])
}

function pointOnRoute(points, progress, target = null) {
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(
      points[index][0] - points[index - 1][0],
      points[index][1] - points[index - 1][1],
    )
  }
  let remaining = clamp(progress) * total
  for (let index = 1; index < points.length; index += 1) {
    const x1 = points[index - 1][0]
    const y1 = points[index - 1][1]
    const x2 = points[index][0]
    const y2 = points[index][1]
    const length = Math.hypot(x2 - x1, y2 - y1)
    if (remaining <= length) {
      const amount = remaining / length
      const point = target ?? {}
      point.x = lerp(x1, x2, amount)
      point.y = lerp(y1, y2, amount)
      return point
    }
    remaining -= length
  }
  const last = points.at(-1)
  const point = target ?? {}
  point.x = last[0]
  point.y = last[1]
  return point
}

function drawBackdrop() {
  ctx.fillStyle = ink.void
  ctx.fillRect(0, 0, VIEW_W, VIEW_H)
  const gradient = ctx.createRadialGradient(350, 370, 70, 350, 370, 640)
  gradient.addColorStop(0, '#443226')
  gradient.addColorStop(0.55, '#241b16')
  gradient.addColorStop(1, '#0e0b09')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, VIEW_W, VIEW_H)

  ctx.globalAlpha = 0.1
  for (let x = -VIEW_H; x < VIEW_W; x += 22) {
    line(x, VIEW_H, x + VIEW_H, 0, '#b58c58', 0.8)
  }
  ctx.globalAlpha = 1

  text('POSTGRESQL ARCHITECTURE', 24, 28, 20, ink.ivory, 'left', 700)
  mono(
    'CLIENT → PROCESSES → SHARED MEMORY → KERNEL → DISK',
    24,
    51,
    8,
    ink.paperDim,
    'left',
    650,
  )
  drawSourceMedallion(493, 49, 'postgres', 9)
  mono('REPORT', 507, 49, 7, ink.paper, 'left', 700)
  drawSourceMedallion(574, 49, 'model', 9)
  mono('RHYTHM', 588, 49, 7, ink.paper, 'left', 700)
}

function drawLayerConnections() {
  arrow(200, 128, 230, 128, ink.blue, 3)
  mono('CONNECTION', 215, 115, 6.5, ink.blue, 'center', 700)

  line(306, 164, 306, 188, '#967247', 3)
  line(132, 188, 382, 188, '#967247', 2)
  arrow(132, 188, 132, 210, ink.brassHi, 2)
  arrow(277, 188, 277, 202, ink.brassHi, 2)
  arrow(382, 188, 382, 210, ink.brassHi, 2)
  mono('FORK', 321, 180, 6.5, ink.brassHi, 'left', 700)

  line(245, 536, 245, 596, '#516c60', 8)
  line(245, 654, 245, 674, '#516c60', 8)
  line(506, 542, 506, 596, '#7e5139', 7)
  line(506, 654, 506, 674, '#7e5139', 7)
  line(586, 542, 586, 596, '#705c46', 5)
  line(586, 654, 586, 674, '#705c46', 5)
}

function drawClientAndPostmaster() {
  const client = layout.client
  const postmaster = layout.postmaster

  drawIsoPlate(client.x, client.y, client.width, client.height, 5, '#2b3433', '#5a8d8e')
  pathRoundRect(client.x + 14, client.y + 14, 80, 40, 3)
  fillStroke('#0d1413', '#79aeb0', 1.2)
  mono('pgsimcity=#', client.x + 22, client.y + 28, 7, '#a5d2cf', 'left', 700)
  line(client.x + 22, client.y + 40, client.x + 73, client.y + 40, '#547b78', 1)
  drawGear(client.x + 121, client.y + 36, 20, 10, manualTime * 0.3, '#4c7e84')
  mono('CLIENT / PSQL', client.x + 12, client.y + 62, 7, ink.paper, 'left', 750)

  drawIsoPlate(
    postmaster.x,
    postmaster.y,
    postmaster.width,
    postmaster.height,
    5,
    '#3a3028',
    '#a3723a',
  )
  drawGear(postmaster.x + 43, postmaster.y + 35, 23, 12, -manualTime * 0.22, ink.brass)
  for (let port = 0; port < 3; port += 1) {
    ctx.beginPath()
    ctx.arc(postmaster.x + 92 + port * 18, postmaster.y + 33, 6, 0, TAU)
    fillStroke('#25201d', port === 1 ? ink.copperHi : ink.brassHi, 1.5)
  }
  mono('POSTMASTER', postmaster.x + 83, postmaster.y + 58, 8, ink.ivory, 'center', 750)
}

function drawPrivateMemory() {
  const box = layout.privateMemory
  ctx.save()
  ctx.shadowColor = '#000'
  ctx.shadowBlur = 12
  ctx.shadowOffsetY = 7
  drawIsoPlate(box.x, box.y, box.width, box.height, 6, '#312a26', '#8b6940')
  ctx.restore()
  pathRoundRect(box.x + 12, box.y + 31, 108, 46, 4)
  fillStroke('#41362f', '#a77c46', 1.2)
  pathRoundRect(box.x + 133, box.y + 31, 102, 46, 4)
  fillStroke('#282a2a', '#68746f', 1.2)
  for (let slot = 0; slot < 4; slot += 1) {
    line(
      box.x + 23,
      box.y + 44 + slot * 7,
      box.x + 99 - slot * 5,
      box.y + 44 + slot * 7,
      slot === 2 ? ink.copperHi : ink.paperDim,
      2,
    )
  }
  for (let file = 0; file < 3; file += 1) {
    pathRoundRect(box.x + 146 + file * 26, box.y + 43, 18, 25, 2)
    fillStroke('#1a1d1d', '#6c817c', 1)
  }
  mono('BACKEND PRIVATE MEMORY · OUTSIDE SHARED SEGMENT', box.x + 12, box.y + 16, 7, ink.ivory, 'left', 750)
  mono('work_mem', box.x + 65, box.y + 84, 7, ink.brassHi, 'center', 700)
  mono('TEMP FILES', box.x + 184, box.y + 84, 7, ink.paperDim, 'center', 700)
  line(392, 236, box.x, 236, '#8b6940', 2, [4, 4])
}

function drawSharedMemoryContainer(shake) {
  const box = layout.sharedMemory
  ctx.save()
  ctx.translate(shake, -Math.abs(shake) * 0.2)
  ctx.shadowColor = '#000'
  ctx.shadowBlur = 20
  ctx.shadowOffsetY = 11
  drawIsoPlate(box.x, box.y, box.width, box.height, 8, '#332a24', '#c8923e', 10)
  ctx.shadowColor = 'transparent'

  pathRoundRect(box.x + 10, box.y + 10, box.width - 20, box.height - 20, 7)
  fillStroke('rgb(26 23 21 / 45%)', '#8a6438', 1.2)
  line(box.x + 18, box.y + 31, box.x + box.width - 18, box.y + 31, '#805e38', 1)
  drawScrew(box.x + 13, box.y + 13, 4)
  drawScrew(box.x + box.width - 13, box.y + 13, 4)
  drawScrew(box.x + 13, box.y + box.height - 13, 4)
  drawScrew(box.x + box.width - 13, box.y + box.height - 13, 4)
  mono('ONE SHARED MEMORY SEGMENT', box.x + 26, box.y + 17, 9, ink.brassHi, 'left', 800)
  mono('VISIBLE CONTAINMENT · ALL BACKENDS ATTACH', box.x + box.width - 26, box.y + 17, 6.5, ink.paperDim, 'right', 650)
  ctx.restore()
}

function drawBufferPool(shake) {
  const box = layout.bufferPool
  ctx.save()
  ctx.translate(shake, -Math.abs(shake) * 0.2)
  pathRoundRect(box.x, box.y, box.width, box.height, 6)
  fillStroke('#42372f', '#aa7e43', 2)
  mono('BUFFER POOL (shared_buffers)', box.x + 12, box.y + 16, 8, ink.paper, 'left', 750)
  if (postgres.plan) {
    const buffers = postgres.plan.buffers
    mono(
      `P HIT ${buffers.sharedHits} / READ ${buffers.sharedReads}`,
      box.x + box.width - 12,
      box.y + 16,
      6.5,
      buffers.sharedReads > 0 ? ink.copperHi : '#9fcfd0',
      'right',
      750,
    )
  } else {
    mono('M VISIBLE PAGES', box.x + box.width - 12, box.y + 16, 6.5, ink.paperDim, 'right', 650)
  }

  let slot = 0
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const x = box.x + 14 + col * 78
      const y = box.y + 31 + row * 44
      const dirty = [false, true, false, true, true, false, false, true, false, false, true, false][slot]
      pathRoundRect(x, y, 65, 34, 3)
      fillStroke('#251e1a', '#70583e', 1)
      pathRoundRect(x + 4, y + 4, 57, 25, 2)
      fillStroke(dirty ? '#8c4e2e' : '#53665a', null)
      line(x + 11, y + 12, x + 51, y + 12, dirty ? '#d4804e' : '#81a98d', 1.5)
      line(x + 11, y + 21, x + 40, y + 21, '#bda277', 1)
      if (dirty) {
        ctx.beginPath()
        ctx.arc(x + 56, y + 8, 2.5, 0, TAU)
        ctx.fillStyle = ink.orange
        ctx.fill()
      }
      slot += 1
    }
  }

  const p = phase(manualTime, periods.bgwriter)
  const sweep = p < 0.5 ? easeInOut(p * 2) : 1 - easeInOut((p - 0.5) * 2)
  const cartX = lerp(box.x + 34, box.x + box.width - 38, sweep)
  line(box.x + 18, box.y + 174, box.x + box.width - 18, box.y + 174, ink.groove, 7)
  line(box.x + 18, box.y + 174, box.x + box.width - 18, box.y + 174, ink.teal, 1.5)
  pathRoundRect(cartX - 18, box.y + 161, 36, 23, 4)
  fillStroke('#386554', '#9bb589', 1.5)
  if (p > 0.1 && p < 0.58) {
    pathRoundRect(cartX - 10, box.y + 155, 20, 9, 2)
    fillStroke(ink.orange, ink.ivory, 0.8)
  }
  drawSourceMedallion(cartX, box.y + 173, 'model', 6)
  ctx.restore()
}

function commitStrength(time) {
  let strength = 0
  for (let index = 0; index < backendSpecs.length; index += 1) {
    const spec = backendSpecs[index]
    const profile = backendProfile(spec, index)
    if (!profile.active) continue
    strength = Math.max(
      strength,
      pulse(phase(time, periods.backends, spec.offset), 0.775, 0.115),
    )
  }
  return smooth(strength)
}

function drawWalAndSharedTables(shake) {
  const wal = layout.walBuffers
  const proc = layout.procArray
  const locks = layout.lockTable
  const xact = layout.pgXact
  const writerP = phase(manualTime, periods.walwriter)
  const lock = commitStrength(manualTime)

  ctx.save()
  ctx.translate(shake, -Math.abs(shake) * 0.2)

  pathRoundRect(wal.x, wal.y, wal.width, wal.height, 5)
  fillStroke('#3c2d28', '#ad6942', 2)
  mono('WAL BUFFERS', wal.x + 10, wal.y + 13, 8, ink.copperHi, 'left', 800)
  drawGear(wal.x + 73, wal.y + 42, 24, 12, writerP * TAU, ink.copper)
  drawGear(wal.x + 118, wal.y + 43, 14, 9, -writerP * TAU * 1.6, ink.brass)
  for (let index = 0; index < 4; index += 1) {
    line(
      wal.x + 144,
      wal.y + 29 + index * 8,
      wal.x + 209,
      wal.y + 29 + index * 8,
      index % 2 ? ink.red : ink.copperHi,
      3,
    )
  }

  pathRoundRect(proc.x, proc.y, proc.width, proc.height, 4)
  fillStroke('#2d3432', '#6f9b8d', 1.5)
  mono('PROCARRAY', proc.x + 8, proc.y + 11, 7, '#9cc4b4', 'left', 750)
  for (let index = 0; index < 5; index += 1) {
    pathRoundRect(proc.x + 8 + index * 18, proc.y + 24, 13, 16, 2)
    fillStroke(index < 3 ? '#597761' : '#272c29', '#86a08d', 0.8)
  }

  pathRoundRect(locks.x, locks.y, locks.width, locks.height, 4)
  fillStroke('#382b28', '#a2614b', 1.5)
  mono('LOCK TABLE', locks.x + 8, locks.y + 11, 7, '#e39a84', 'left', 750)
  const pressY = lerp(locks.y + 22, locks.y + 36, lock)
  line(locks.x + 18, locks.y + 20, locks.x + 18, pressY, ink.iron, 5)
  line(locks.x + 87, locks.y + 20, locks.x + 87, pressY, ink.iron, 5)
  pathRoundRect(locks.x + 13, pressY, 79, 9, 2)
  fillStroke(lock > 0.5 ? ink.red : ink.ironHi, ink.brassHi, 1)

  pathRoundRect(xact.x, xact.y, xact.width, xact.height, 4)
  fillStroke('#33302b', '#83724e', 1.5)
  mono('pg_xact · SLRU BUFFERS', xact.x + 9, xact.y + 12, 7, ink.paper, 'left', 750)
  for (let index = 0; index < 8; index += 1) {
    const x = xact.x + 11 + index * 25
    ctx.beginPath()
    ctx.ellipse(x + 8, xact.y + 36, 8, 12, 0, 0, TAU)
    fillStroke(index < 5 ? '#66583d' : '#292825', '#a68d5d', 0.8)
    line(x + 3, xact.y + 36, x + 13, xact.y + 36, index % 2 ? ink.green : ink.paperDim, 1)
  }
  ctx.restore()
}

function drawBackgroundProcesses() {
  drawPlaque('CHECKPOINTER', periods.checkpointer, 52, 268, 110)
  drawPlaque('BGWRITER', periods.bgwriter, 168, 268, 96)
  drawPlaque('AUTOVAC ×3', periods.autovacuum, 270, 268, 107)
}

function backendProfile(spec, index) {
  return {
    active: true,
    miss: spec.miss,
    fetchX: spec.fetchX,
    fetchY: spec.fetchY,
    source: 'model',
  }
}

function backendTarget(spec, p, profile) {
  const homeX = spec.pivotX
  const homeY = spec.pivotY + 18
  if (!profile.active) return { x: homeX, y: homeY }
  const fetchReached = profile.miss ? 0.14 : 0.07
  const fetchDone = profile.miss ? 0.3 : 0.15
  const workReached = profile.miss ? 0.42 : 0.27
  if (p < fetchReached) {
    const amount = smooth(range(p, 0, fetchReached))
    return {
      x: lerp(homeX, profile.fetchX, amount),
      y: lerp(homeY, profile.fetchY, amount),
    }
  }
  if (p < fetchDone) return { x: profile.fetchX, y: profile.fetchY }
  if (p < workReached) {
    const amount = easeInOut(range(p, fetchDone, workReached))
    return {
      x: lerp(profile.fetchX, spec.workX, amount),
      y: lerp(profile.fetchY, spec.workY, amount),
    }
  }
  if (p < 0.44) return { x: spec.workX, y: spec.workY }
  if (p < 0.56) {
    const amount = easeInOut(range(p, 0.44, 0.56))
    return {
      x: lerp(spec.workX, spec.walX, amount),
      y: lerp(spec.workY, spec.walY, amount),
    }
  }
  if (p < 0.62) return { x: spec.walX, y: spec.walY }
  if (p < 0.67) {
    const amount = easeInOut(range(p, 0.62, 0.67))
    return {
      x: lerp(spec.walX, spec.commitX, amount),
      y: lerp(spec.walY, spec.commitY, amount),
    }
  }
  if (p < 0.9) return { x: spec.commitX, y: spec.commitY }
  const amount = easeInOut(range(p, 0.9, 1))
  return {
    x: lerp(spec.commitX, homeX, amount),
    y: lerp(spec.commitY, homeY, amount),
  }
}

function drawArm(spec, index) {
  const profile = backendProfile(spec, index)
  const p = profile.active ? phase(manualTime, periods.backends, spec.offset) : 0
  const target = backendTarget(spec, p, profile)
  const dx = target.x - spec.pivotX
  const dy = target.y - spec.pivotY
  const distance = Math.hypot(dx, dy)
  const nx = distance > 0 ? -dy / distance : 0
  const ny = distance > 0 ? dx / distance : 0
  const bend = (index % 2 === 0 ? 1 : -1) * Math.min(38, distance * 0.2)
  const elbowX = lerp(spec.pivotX, target.x, 0.48) + nx * bend
  const elbowY = lerp(spec.pivotY, target.y, 0.48) + ny * bend
  const isCommit = profile.active && p >= 0.67 && p < 0.9
  const isFetching = profile.active && p < (profile.miss ? 0.3 : 0.15)
  const isWorking =
    profile.active && p >= (profile.miss ? 0.3 : 0.15) && p < 0.44
  const extension = clamp((distance - 190) / 260)

  ctx.save()
  ctx.lineCap = 'round'
  line(spec.pivotX, spec.pivotY, elbowX, elbowY, '#211814', 15)
  line(spec.pivotX, spec.pivotY, elbowX, elbowY, ink.brass, 10)
  line(elbowX, elbowY, target.x, target.y, '#211814', 13)
  line(elbowX, elbowY, target.x, target.y, extension > 0 ? ink.copper : ink.brassHi, 7)

  if (extension > 0) {
    const sleeveAX = lerp(elbowX, target.x, 0.38)
    const sleeveAY = lerp(elbowY, target.y, 0.38)
    const sleeveBX = lerp(elbowX, target.x, 0.65)
    const sleeveBY = lerp(elbowY, target.y, 0.65)
    line(sleeveAX, sleeveAY, sleeveBX, sleeveBY, ink.ironHi, 11)
    line(sleeveAX, sleeveAY, sleeveBX, sleeveBY, ink.copperHi, 3.5)
  }

  drawGear(
    spec.pivotX,
    spec.pivotY,
    24,
    12,
    -p * TAU,
    index === 1 ? ink.copper : ink.brass,
  )
  drawScrew(elbowX, elbowY, 7)

  ctx.save()
  ctx.translate(target.x, target.y)
  ctx.rotate(Math.atan2(dy, dx) + Math.PI / 2)
  line(-8, 0, -2, 0, ink.iron, 5)
  line(-3, 0, 7, -8, isCommit ? ink.red : ink.brassHi, 4)
  line(-3, 0, 7, 8, isCommit ? ink.red : ink.brassHi, 4)
  ctx.restore()

  if (isFetching || isWorking) {
    pathRoundRect(target.x - 9, target.y - 6, 18, 12, 2)
    fillStroke(profile.miss ? ink.blue : ink.green, ink.ivory, 1)
  }
  if (isCommit) {
    const heat = pulse(p, 0.78, 0.13)
    ctx.beginPath()
    ctx.arc(target.x, target.y, 13 + heat * 6, 0, TAU)
    ctx.strokeStyle = `rgba(217, 93, 73, ${0.35 + heat * 0.55})`
    ctx.lineWidth = 1.5 + heat * 1.5
    ctx.stroke()
  }
  ctx.restore()

  drawPlaque(
    spec.name,
    periods.backends,
    spec.pivotX - (index === 1 ? 46 : 34),
    spec.pivotY - 45,
    index === 1 ? 92 : 68,
    profile.source,
  )
}

function drawBackends() {
  backendSpecs.forEach(drawArm)
}

function drawKernelAndDisk(shake) {
  const kernel = layout.kernelCache
  const disk = layout.disk
  ctx.save()
  ctx.translate(shake * 0.4, 0)
  drawIsoPlate(kernel.x, kernel.y, kernel.width, kernel.height, 6, '#2c302f', '#637b73')
  mono('KERNEL PAGE CACHE · OPERATING SYSTEM CONTROL', kernel.x + 14, kernel.y + 13, 8, '#9bb8ae', 'left', 750)
  for (let index = 0; index < 10; index += 1) {
    const x = kernel.x + 16 + index * 59
    pathRoundRect(x, kernel.y + 25, 47, 21, 2)
    fillStroke(index % 3 === 1 ? '#66442e' : '#3b4a45', '#6e827b', 0.8)
    line(x + 7, kernel.y + 32, x + 38, kernel.y + 32, index % 3 === 1 ? ink.orange : ink.teal, 1.3)
    line(x + 7, kernel.y + 39, x + 29, kernel.y + 39, '#9d8b6c', 1)
  }

  drawIsoPlate(disk.x, disk.y, disk.width, disk.height, 7, '#252627', '#6f604c')
  const dataEnd = disk.x + 314
  const walEnd = disk.x + 480
  line(dataEnd, disk.y + 7, dataEnd, disk.y + disk.height - 7, '#705b43', 1.5)
  line(walEnd, disk.y + 7, walEnd, disk.y + disk.height - 7, '#705b43', 1.5)
  mono('DATA FILES', disk.x + 18, disk.y + 14, 8, ink.paper, 'left', 750)
  mono('WAL', dataEnd + 18, disk.y + 14, 8, ink.copperHi, 'left', 750)
  mono('pg_xact FILES', walEnd + 15, disk.y + 14, 7, ink.paperDim, 'left', 750)
  for (let index = 0; index < 6; index += 1) {
    pathRoundRect(disk.x + 18 + index * 43, disk.y + 27, 33, 22, 2)
    fillStroke('#151515', '#635b50', 0.8)
    line(disk.x + 24 + index * 43, disk.y + 34, disk.x + 43 + index * 43, disk.y + 34, ink.blue, 1.4)
  }
  for (let index = 0; index < 3; index += 1) {
    pathRoundRect(dataEnd + 19 + index * 43, disk.y + 27, 33, 22, 2)
    fillStroke('#341c18', '#8c4d38', 0.8)
    line(dataEnd + 25 + index * 43, disk.y + 34, dataEnd + 48 + index * 43, disk.y + 34, ink.red, 1.5)
  }
  for (let index = 0; index < 3; index += 1) {
    ctx.beginPath()
    ctx.ellipse(walEnd + 20 + index * 36, disk.y + 37, 10, 15, 0, 0, TAU)
    fillStroke('#403b30', '#8d7b59', 0.8)
  }
  ctx.restore()
}

function drawCheckpointHammer() {
  const p = phase(manualTime, periods.checkpointer)
  const wind = smooth(range(p, 0.72, 0.84))
  const strike = smooth(range(p, 0.84, 0.89)) * (1 - smooth(range(p, 0.91, 0.97)))
  const hammerTop = lerp(566, 612, wind)
  const hammerY = lerp(hammerTop, 673, strike)
  line(184, 558, 184, hammerY, ink.iron, 10)
  pathRoundRect(157, hammerY - 7, 54, 20, 4)
  fillStroke(strike > 0.45 ? ink.red : ink.brassDark, ink.brassHi, 1.5)
  if (strike > 0.25) {
    ctx.globalAlpha = strike * 0.65
    for (let radius = 18; radius <= 65; radius += 16) {
      ctx.beginPath()
      ctx.ellipse(184, 675, radius, radius * 0.16, 0, 0, TAU)
      ctx.strokeStyle = ink.red
      ctx.lineWidth = 2
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }
}

function drawVacuumCarts() {
  const starts = [82, 162, 242]
  const finishes = [142, 242, 330]
  for (let index = 0; index < 3; index += 1) {
    const p = phase(manualTime, periods.autovacuum, index * 6)
    const travelOut = easeInOut(range(p, 0.05, 0.32))
    const travelBack = easeInOut(range(p, 0.72, 0.97))
    const position = p < 0.72 ? travelOut : 1 - travelBack
    const x = lerp(starts[index], finishes[index], position)
    const y = 664 + index * 3
    line(starts[index], y, finishes[index], y, '#4f6552', 3)
    pathRoundRect(x - 12, y - 8, 24, 15, 3)
    fillStroke(index === 1 ? '#55724c' : '#6b814f', '#b5c378', 1)
    ctx.beginPath()
    ctx.arc(x, y - 9, 5, 0, TAU)
    fillStroke(ink.iron, ink.green, 1)
    drawSourceMedallion(x, y, 'model', 4)
  }
}

const standbyRoute = Object.freeze([
  Object.freeze([574, 372]),
  Object.freeze([685, 372]),
  Object.freeze([685, 127]),
  Object.freeze([662, 127]),
])

function drawWalSenderAndStandby() {
  const p = phase(manualTime, periods.walsender)
  drawTrack(standbyRoute, '#467c85', 5)
  for (let index = 0; index < 3; index += 1) {
    const packet = pointOnRoute(standbyRoute, wrap(p + index / 3, 1))
    pathRoundRect(packet.x - 7, packet.y - 4, 14, 8, 2)
    fillStroke(ink.blue, ink.ivory, 0.8)
  }

  drawIsoPlate(570, 88, 100, 76, 5, '#303638', '#567d82')
  drawGear(603, 123, 23, 12, p * TAU, '#4c7e84')
  pathRoundRect(630, 105, 27, 37, 3)
  fillStroke('#273739', '#78aeb1', 1)
  line(635, 115, 652, 115, ink.blue, 1.5)
  line(635, 124, 648, 124, ink.blue, 1.2)
  mono('STANDBY', 620, 153, 7, ink.ivory, 'center', 750)
  drawPlaque('WALSENDER', periods.walsender, 574, 168, 94)
}

function checkpointShake(time) {
  const p = phase(time, periods.checkpointer)
  const strike = smooth(range(p, 0.84, 0.89)) * (1 - smooth(range(p, 0.91, 0.97)))
  return Math.sin(time * 47) * strike * 3
}

function drawRhythmStrip(time) {
  const box = layout.rhythm
  const labelWidth = 93
  const periodWidth = 55
  const gridX = box.x + labelWidth
  const gridWidth = box.width - labelWidth - periodWidth - 13
  const top = box.y + 35
  const rowHeight = 13

  drawIsoPlate(box.x, box.y, box.width, box.height, 5, '#28211d', '#8b6439', 6)
  mono('RHYTHM STRIP · ONE SHARED 36s MODEL CLOCK', box.x + 12, box.y + 13, 8.5, ink.ivory, 'left', 750)
  mono('TOP FAST / BOTTOM RARE', box.x + box.width - 12, box.y + 13, 6.5, ink.paperDim, 'right', 650)

  for (let second = 0; second <= MASTER_PERIOD; second += 6) {
    const x = gridX + (second / MASTER_PERIOD) * gridWidth
    line(x, top - 5, x, top + timelineRows.length * rowHeight, '#584837', second % 12 === 0 ? 1 : 0.6)
    mono(String(second), x, top - 11, 5.5, ink.paperDim, 'center', 550)
  }

  timelineRows.forEach(([label, period, color], row) => {
    const y = top + row * rowHeight
    mono(label, box.x + 10, y + 5, 6.5, ink.paper, 'left', 650)
    line(gridX, y + rowHeight, gridX + gridWidth, y + rowHeight, '#44372d', 0.7)
    const repeats = MASTER_PERIOD / period
    for (let index = 0; index < repeats; index += 1) {
      const x = gridX + (index * period * gridWidth) / MASTER_PERIOD + 1.5
      const width = (period * gridWidth) / MASTER_PERIOD - 3
      pathRoundRect(x, y + 2, width, 7, 2)
      ctx.fillStyle = `${color}99`
      ctx.fill()
      ctx.strokeStyle = color
      ctx.lineWidth = 0.7
      ctx.stroke()
      if (label === 'BACKENDS') {
        ctx.fillStyle = `${ink.red}bb`
        ctx.fillRect(x + width * 0.66, y + 2, width * 0.22, 7)
      } else if (label === 'CHECKPOINT') {
        ctx.fillStyle = ink.red
        ctx.fillRect(x + width * 0.84, y + 1, width * 0.1, 9)
      }
    }
    mono(
      `${period}s ×${String(repeats).padStart(2, '0')} M`,
      box.x + box.width - 9,
      y + 5,
      6,
      color,
      'right',
      750,
    )
  })

  const playX = gridX + (wrap(time, MASTER_PERIOD) / MASTER_PERIOD) * gridWidth
  line(playX, top - 6, playX, top + timelineRows.length * rowHeight, ink.ivory, 1.3)
  ctx.beginPath()
  ctx.moveTo(playX - 4, top - 7)
  ctx.lineTo(playX + 4, top - 7)
  ctx.lineTo(playX, top - 1)
  ctx.closePath()
  ctx.fillStyle = ink.ivory
  ctx.fill()
}

function statementRouteForStage(stageId) {
  if (stageId === 'commit' && statement.replay?.synchronousCommit === 'off') {
    return statementRoutes.earlyAck
  }
  if (stageId === 'return') {
    if (statement.replay?.writes) {
      return statement.replay.synchronousCommit === 'off'
        ? statementRoutes.returnFromWal
        : statementRoutes.returnFromCommit
    }
    return statement.replay?.receipt?.sharedReads > 0
      ? statementRoutes.returnFromDisk
      : statementRoutes.returnFromBuffer
  }
  return statementRoutes[stageId] ?? null
}

function drawStatementRoute(points, color, width, alpha = 1) {
  if (!points) return
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.beginPath()
  ctx.moveTo(points[0][0], points[0][1])
  for (let index = 1; index < points.length; index += 1) {
    ctx.lineTo(points[index][0], points[index][1])
  }
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.strokeStyle = '#101617'
  ctx.lineWidth = width + 5
  ctx.stroke()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.stroke()
  ctx.restore()
}

function drawAsyncWalFlush() {
  const durationMs = statement.replay?.backgroundFlushDurationMs
  if (!durationMs) return
  const progress = clamp(statement.stageElapsedMs / durationMs)
  const complete = progress >= 1
  drawStatementRoute(statementRoutes.commit, ink.copperHi, 3, 0.72)
  pointOnRoute(statementRoutes.commit, smooth(progress), asyncWalStagePoint)
  ctx.save()
  ctx.shadowColor = ink.copperHi
  ctx.shadowBlur = 14
  ctx.beginPath()
  ctx.arc(asyncWalStagePoint.x, asyncWalStagePoint.y, 7, 0, TAU)
  fillStroke(ink.copperHi, '#3d2419', 2)
  ctx.restore()
  mono(
    complete ? 'DONE' : 'WAL',
    asyncWalStagePoint.x,
    asyncWalStagePoint.y + 0.5,
    4.8,
    '#3d2419',
    'center',
    900,
  )
  pathRoundRect(428, 642, 232, 30, 4)
  fillStroke(complete ? '#263a2a' : '#38281f', complete ? '#91b978' : ink.copperHi, 2)
  drawSourceMedallion(443, 657, 'model', 7)
  mono(
    complete
      ? 'WAL FLUSH COMPLETE · LOSS WINDOW CLOSED'
      : 'DEFERRED WAL FLUSH · ACKS AT RISK',
    456,
    657,
    6.4,
    complete ? '#d8edcb' : '#ffd0b3',
    'left',
    800,
  )
}

function drawStatementPipeline(activeId) {
  pathRoundRect(402, 174, 258, 88, 5)
  fillStroke('#172526', '#79bdc1', 2)
  drawSourceMedallion(416, 187, 'model', 7)
  mono('B2 STATEMENT PIPELINE · MODELLED ROUTE', 428, 187, 6.5, '#b8dddd', 'left', 750)
  for (let index = 0; index < statementPipeline.length; index += 1) {
    const spec = statementPipeline[index]
    const current = spec.id === activeId
    pathRoundRect(spec.x, 199, 51, 47, 3)
    fillStroke(
      current ? '#306467' : '#1d3030',
      current ? '#d2ffff' : '#52787a',
      current ? 2 : 1,
    )
    drawSourceMedallion(
      spec.x + 25.5,
      211,
      spec.id === 'plan' || spec.id === 'execute' ? 'postgres' : 'model',
      6,
    )
    mono(spec.label, spec.x + 25.5, 232, 6.5, current ? '#e8ffff' : '#9fc8c6', 'center', 800)
  }
}

function drawStatementStageOutline(stageId, progress) {
  const alpha = 0.7 + smooth(progress) * 0.3
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.shadowColor = '#b9ffff'
  ctx.shadowBlur = 16
  ctx.strokeStyle = '#c9ffff'
  ctx.lineWidth = 3
  if (stageId === 'client' || stageId === 'return') {
    pathRoundRect(layout.client.x - 5, layout.client.y - 5, layout.client.width + 10, layout.client.height + 10, 10)
    ctx.stroke()
  } else if (stageId === 'backend') {
    ctx.beginPath()
    ctx.arc(277, 225, 34, 0, TAU)
    ctx.stroke()
  } else if (stageId === 'buffer') {
    pathRoundRect(
      layout.bufferPool.x - 5,
      layout.bufferPool.y - 5,
      layout.bufferPool.width + 10,
      layout.bufferPool.height + 10,
      9,
    )
    ctx.stroke()
  } else if (stageId === 'kernel') {
    pathRoundRect(
      layout.kernelCache.x - 5,
      layout.kernelCache.y - 5,
      layout.kernelCache.width + 10,
      layout.kernelCache.height + 10,
      9,
    )
    ctx.stroke()
  } else if (stageId === 'disk') {
    pathRoundRect(
      layout.disk.x - 5,
      layout.disk.y - 5,
      layout.disk.width + 10,
      layout.disk.height + 10,
      9,
    )
    ctx.stroke()
  } else if (stageId === 'wal') {
    pathRoundRect(
      layout.walBuffers.x - 5,
      layout.walBuffers.y - 5,
      layout.walBuffers.width + 10,
      layout.walBuffers.height + 10,
      9,
    )
    ctx.stroke()
  } else if (stageId === 'commit') {
    pathRoundRect(
      layout.disk.x - 5,
      layout.disk.y - 5,
      layout.disk.width + 10,
      layout.disk.height + 10,
      9,
    )
    ctx.stroke()
  }
  ctx.restore()
}

function drawMeasuredBufferAction(progress) {
  const receipt = statement.replay?.receipt
  if (!receipt) return
  const hitNow = Math.round(receipt.sharedHits * progress)
  const readNow = Math.round(receipt.sharedReads * progress)
  pathRoundRect(89, 478, 296, 45, 4)
  fillStroke('#142b2b', '#b9ffff', 2)
  drawSourceMedallion(103, 491, 'postgres', 7)
  mono('MEASURED BUFFER REQUESTS', 116, 491, 7, '#d9ffff', 'left', 800)
  mono(
    `HITS ${hitNow}/${receipt.sharedHits} · READS ${readNow}/${receipt.sharedReads}`,
    237,
    510,
    8,
    receipt.sharedReads > 0 ? '#ffb19e' : '#b9e9d1',
    'center',
    800,
  )
}

function drawStatementStageRail(activeIndex) {
  const replay = statement.replay
  if (!replay) return
  const startX = 36
  const width = Math.min(64, 648 / replay.stages.length)
  for (let index = 0; index < replay.stages.length; index += 1) {
    const stage = replay.stages[index]
    const x = startX + index * width
    const current = index === activeIndex
    const done = !stage.skipped && index < activeIndex
    pathRoundRect(x, 824, width - 7, 36, 3)
    fillStroke(
      current ? '#315f62' : done ? '#263e3e' : '#211c19',
      current ? '#d2ffff' : done ? '#6aa5a7' : '#5c4937',
      current ? 2 : 1,
    )
    mono(
      stage.label.toUpperCase(),
      x + (width - 7) / 2,
      839,
      stage.label.length > 9 || width < 60 ? 5.2 : 5.8,
      stage.skipped ? '#715f4d' : current ? '#efffff' : done ? '#abd1d0' : ink.paperDim,
      'center',
      800,
    )
    mono(
      stage.skipped ? 'SKIP' : current ? 'NOW' : done ? 'DONE' : 'WAIT',
      x + (width - 7) / 2,
      851,
      5.2,
      stage.skipped ? ink.red : current ? '#b9ffff' : ink.paperDim,
      'center',
      750,
    )
    if (stage.skipped) line(x + 5, 855, x + width - 12, 829, ink.red, 1.2)
  }
}

function drawStatementPanel(activeStage, progress) {
  const box = layout.rhythm
  drawIsoPlate(box.x, box.y, box.width, box.height, 5, '#172120', '#79aeb0', 6)
  drawSourceMedallion(box.x + 15, box.y + 14, 'model', 7)
  mono(
    'YOUR STATEMENT · HUMAN-PACED REPLAY',
    box.x + 28,
    box.y + 14,
    8.5,
    '#d9ffff',
    'left',
    800,
  )
  mono(statement.shortSql, box.x + box.width - 12, box.y + 14, 6.5, '#a8cfcd', 'right', 650)

  if (statement.status === 'measuring') {
    mono('P  EXPLAIN (ANALYZE, BUFFERS) IS MEASURING THE FACTS…', box.x + 15, box.y + 54, 8, '#b9ffff', 'left', 800)
    mono('M  AMBIENT RHYTHMS CONTINUE BEHIND THIS FOREGROUND PATH', box.x + 15, box.y + 78, 7, ink.paperDim, 'left', 700)
    return
  }

  if (!statement.replay || statement.status === 'error') {
    drawSourceMedallion(box.x + 15, box.y + 49, 'postgres', 7)
    mono('STATEMENT STOPPED', box.x + 28, box.y + 49, 8, '#ffb19e', 'left', 800)
    mono(statement.error ?? 'PostgreSQL did not return a plan.', box.x + 15, box.y + 78, 7, ink.paper, 'left', 650)
    return
  }

  drawSourceMedallion(box.x + 15, box.y + 45, activeStage.source, 7)
  mono(
    `${activeStage.label.toUpperCase()} · ${activeStage.measurement ?? activeStage.detail}`,
    box.x + 28,
    box.y + 45,
    8,
    activeStage.source === 'postgres' ? '#d9ffff' : ink.paper,
    'left',
    800,
  )
  mono(
    activeStage.source === 'postgres'
      ? 'P = MEASURED BY POSTGRESQL'
      : 'M = MODELLED ROUTE / REPLAY PACE',
    box.x + box.width - 12,
    box.y + 45,
    6.3,
    activeStage.source === 'postgres' ? '#9fcfd0' : ink.paperDim,
    'right',
    700,
  )
  drawStatementStageRail(statement.stageIndex)
  if (activeStage.id === 'buffer') drawMeasuredBufferAction(progress)
}

function drawStatementReceipt() {
  const box = layout.rhythm
  const receipt = statement.replay?.receipt
  drawIsoPlate(box.x, box.y, box.width, box.height, 5, '#182523', '#79aeb0', 6)
  drawSourceMedallion(
    box.x + 15,
    box.y + 14,
    receipt || statement.status === 'error' ? 'postgres' : 'model',
    7,
  )
  mono(
    receipt
      ? 'STATEMENT RECEIPT · P MEASURED'
      : statement.status === 'error'
        ? 'STATEMENT RECEIPT · P ERROR'
        : 'STATEMENT RECEIPT · NO BUFFER PLAN',
    box.x + 28,
    box.y + 14,
    8.5,
    receipt ? '#d9ffff' : ink.paper,
    'left',
    800,
  )
  mono('PERSISTS UNTIL THE NEXT STATEMENT', box.x + box.width - 12, box.y + 14, 6.5, ink.paperDim, 'right', 700)
  mono(statement.shortSql, box.x + 14, box.y + 35, 7, '#b8d8d5', 'left', 650)
  if (!receipt) {
    mono(statement.error ?? 'PostgreSQL returned no EXPLAIN buffer report.', box.x + 14, box.y + 65, 8, ink.paper, 'left', 700)
    mono('M  BACKGROUND PROCESS RHYTHMS CONTINUE', box.x + 14, box.y + 97, 6.5, ink.paperDim, 'left', 700)
    return
  }
  mono(
    `HIT ${receipt.sharedHits}  ·  READ ${receipt.sharedReads}  ·  PLAN ${receipt.planningTimeMs.toFixed(3)} ms  ·  EXEC ${receipt.executionTimeMs.toFixed(3)} ms  ·  ${receipt.rowLabel} ${receipt.rows}`,
    box.x + 14,
    box.y + 61,
    8,
    receipt.sharedReads > 0 ? '#ffb19e' : '#c7e8d3',
    'left',
    800,
  )
  mono(`PLAN NODE  ${receipt.planNode}`, box.x + 14, box.y + 84, 7, '#b9ffff', 'left', 750)
  mono(
    'M  REPLAY PACE + KERNEL / PHYSICAL STORAGE ROUTE · AMBIENT RHYTHMS',
    box.x + 14,
    box.y + 105,
    6.3,
    ink.paperDim,
    'left',
    700,
  )
}

function drawStatementTrace() {
  if (statement.status === 'idle') return
  if (statement.status === 'complete' || statement.status === 'error') {
    drawStatementReceipt()
    return
  }

  let activeStage = null
  let progress = 1
  if (statement.replay && statement.status === 'replaying') {
    activeStage = statement.replay.stages[statement.stageIndex]
    const foregroundDurationMs =
      activeStage.clientReturnDurationMs ?? activeStage.durationMs
    progress = statement.mode === 'step'
      ? 1
      : clamp(statement.stageElapsedMs / Math.max(1, foregroundDurationMs))
  }

  const activeId = activeStage?.id ?? 'client'
  drawStatementPipeline(activeId)

  if (statement.replay && statement.status === 'replaying') {
    for (let index = 1; index <= statement.stageIndex; index += 1) {
      const stage = statement.replay.stages[index]
      if (stage.skipped) continue
      const route = statementRouteForStage(stage.id)
      drawStatementRoute(route, '#8fe5e7', index === statement.stageIndex ? 4 : 3, index === statement.stageIndex ? 0.58 : 0.38)
    }
    if (
      statement.replay.synchronousCommit === 'off'
      && activeStage.id === 'return'
    ) drawAsyncWalFlush()
    const route = statementRouteForStage(activeStage.id)
    if (route) {
      pointOnRoute(route, smooth(progress), statementStagePoint)
    } else {
      statementStagePoint.x = 124
      statementStagePoint.y = 128
    }
  } else {
    statementStagePoint.x = activeId === 'parse' ? 428 : 124
    statementStagePoint.y = activeId === 'parse' ? 211 : 128
  }

  drawStatementStageOutline(activeId, progress)
  ctx.save()
  ctx.shadowColor = '#d9ffff'
  ctx.shadowBlur = 18
  ctx.beginPath()
  ctx.arc(statementStagePoint.x, statementStagePoint.y, 8, 0, TAU)
  fillStroke('#d9ffff', '#173b3d', 2)
  ctx.restore()
  mono(
    activeId === 'return' && statement.replay?.writes ? 'ACK' : 'SQL',
    statementStagePoint.x,
    statementStagePoint.y + 0.5,
    5.2,
    '#173b3d',
    'center',
    900,
  )
  drawStatementPanel(activeStage ?? pendingStatementStage, progress)
}

function drawArchitecture() {
  drawBackdrop()
  const shake = checkpointShake(manualTime)
  const foregroundStatement =
    statement.status === 'measuring' || statement.status === 'replaying'
  ctx.save()
  if (foregroundStatement) ctx.globalAlpha = 0.28
  drawLayerConnections()
  drawClientAndPostmaster()
  drawWalSenderAndStandby()
  drawPrivateMemory()
  drawBackgroundProcesses()
  drawSharedMemoryContainer(shake)
  drawBufferPool(shake)
  drawWalAndSharedTables(shake)
  drawKernelAndDisk(shake)
  drawCheckpointHammer()
  drawVacuumCarts()
  drawBackends()
  drawRhythmStrip(manualTime)
  ctx.restore()
  drawStatementTrace()
}

function drawComparisonCaption(laneIndex) {
  const laneStatement = comparisonState.statements[laneIndex]
  if (!laneStatement?.replay) return
  const activeStage = laneStatement.replay.stages[laneStatement.stageIndex]
  pathRoundRect(12, 696, 696, 34, 4)
  fillStroke('#162423', '#79aeb0', 2)
  drawSourceMedallion(28, 713, 'model', 7)
  let label
  if (laneIndex === 1 && activeStage.id === 'return') {
    label = comparisonState.flushComplete
      ? 'B · OFF · WAL FLUSH COMPLETE; LOSS WINDOW CLOSED'
      : 'B · OFF · ACK SENT EARLY; RECENT ACKS AT RISK UNTIL WAL FLUSH'
  } else if (comparisonState.status === 'finding') {
    label = 'A · ON · WAITING FOR LOCAL WAL FLUSH'
  } else {
    label = `${laneIndex === 0 ? 'A · ON' : 'B · OFF'} · ${activeStage.label.toUpperCase()} · ${activeStage.measurement ?? activeStage.detail}`
  }
  mono(`M  ${label}`, 43, 713, 8, '#d9ffff', 'left', 800)
}

function positionComparisonBoard(laneIndex, board) {
  if (!mobileBoard) {
    if (board.style.transform) board.style.transform = ''
    return
  }
  const laneStatement = comparisonState.statements[laneIndex]
  if (!laneStatement) return
  if (comparisonState.lastMobileStage[laneIndex] === laneStatement.stageIndex) return
  comparisonState.lastMobileStage[laneIndex] = laneStatement.stageIndex
  const viewport = board.parentElement
  if (!viewport) return
  const point = comparisonState.stagePoints[laneIndex]
  const forkedFinding = comparisonState.status === 'finding' && laneIndex === 1
  const landedFlush = comparisonState.flushComplete && laneIndex === 1
  const focusX = landedFlush
    ? asyncWalStagePoint.x
    : forkedFinding ? (point.x + asyncWalStagePoint.x) / 2 : point.x
  const focusY = landedFlush
    ? asyncWalStagePoint.y
    : forkedFinding ? (point.y + asyncWalStagePoint.y) / 2 : point.y
  const width = viewport.clientWidth
  const height = viewport.clientHeight
  const x = clamp(width * 0.46 - focusX, width - 720, 0)
  const y = clamp(height * 0.42 - focusY, height - 740, 0)
  board.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
}

function drawComparisonBoards() {
  if (!comparisonState.visible || !comparisonState.model) return
  const primaryContext = ctx
  const activeStatement = statement
  try {
    for (let laneIndex = 0; laneIndex < 2; laneIndex += 1) {
      const laneContext = laneIndex === 0 ? comparisonCtxA : comparisonCtxB
      const board = laneIndex === 0 ? comparisonBoardA : comparisonBoardB
      const laneStatement = comparisonState.statements[laneIndex]
      if (!laneStatement) continue
      ctx = laneContext
      statement = laneStatement
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, board.width, board.height)
      drawArchitecture()
      comparisonState.stagePoints[laneIndex].x = statementStagePoint.x
      comparisonState.stagePoints[laneIndex].y = statementStagePoint.y
      drawComparisonCaption(laneIndex)
      positionComparisonBoard(laneIndex, board)
    }
  } finally {
    ctx = primaryContext
    statement = activeStatement
  }
}

function updateReadout() {
  clock.textContent = `${manualTime.toFixed(1).padStart(4, '0')} / 36s MODEL`
  runState.textContent = paused ? 'VIEW PAUSED' : 'VIEW RUNNING'
  machineToggle.textContent = paused ? 'RUN' : 'PAUSE'
  updateStatementControls()
}

function draw() {
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  ctx.setTransform(
    ratio * viewScale,
    0,
    0,
    ratio * viewScale,
    ratio * viewX,
    ratio * viewY,
  )
  drawArchitecture()
  ctx.restore()
  drawComparisonBoards()
  followMobileStatement()
  updateReadout()
}

function frame(now) {
  const elapsed = (now - lastFrame) / 1000
  lastFrame = now
  const viewedElapsed = viewingElapsed(elapsed, viewingRate, paused)
  const comparisonElapsed = viewingElapsed(elapsed, viewingRate, false)
  manualTime = wrap(manualTime + viewedElapsed, MASTER_PERIOD)
  updateStatementReplay(viewedElapsed)
  updateComparison(comparisonElapsed)
  draw()
  requestAnimationFrame(frame)
}

function setTime(seconds) {
  manualTime = wrap(Number(seconds) || 0, MASTER_PERIOD)
  draw()
}

function setPaused(nextPaused) {
  paused = Boolean(nextPaused)
  updateReadout()
}

function togglePaused() {
  setPaused(!paused)
}

function setViewingRate(nextRate) {
  viewingRate = nearestViewingRate(nextRate)
  const label = formatViewingRate(viewingRate)
  machineRate.textContent = `VIEW ${label}`
  machineRate.setAttribute(
    'aria-label',
    `Viewing speed ${label}. Model periods and PostgreSQL measurements are unchanged.`,
  )
  updateReadout()
}

function nudgeMachineRate(direction) {
  setViewingRate(nudgeViewingRate(viewingRate, direction))
}

function terminalWidth() {
  return clamp(Math.floor((terminalTranscript.clientWidth - 30) / 7.05), 28, 94)
}

function scrollTranscript() {
  requestAnimationFrame(() => {
    terminalTranscript.scrollTop = terminalTranscript.scrollHeight
  })
}

function appendSystemOutput(output, type = 'system') {
  const pre = document.createElement('pre')
  pre.className = `terminal-output ${type}`
  pre.textContent = output
  terminalTranscript.append(pre)
  scrollTranscript()
  return pre
}

function appendCommand(command) {
  const block = document.createElement('div')
  block.className = 'terminal-command'
  const commandLine = document.createElement('div')
  commandLine.className = 'terminal-command-line'
  const prompt = document.createElement('b')
  prompt.textContent = PROMPT
  const input = document.createElement('pre')
  input.textContent = command
  commandLine.append(prompt, input)
  const output = document.createElement('pre')
  output.className = 'terminal-output system'
  output.textContent = '…'
  block.append(commandLine, output)
  terminalTranscript.append(block)
  scrollTranscript()
  return output
}

function resizeTerminalInput() {
  terminalInput.style.height = 'auto'
  terminalInput.style.height = `${Math.min(112, terminalInput.scrollHeight)}px`
}

function updatePostgresUi() {
  const actualVersion = postgres.source?.versionText.match(
    /^PostgreSQL\s+\S+(?:\s+\(PGlite\s+[^)]+\))?/u,
  )?.[0]
  machineVersionProvenance.textContent =
    `Model and explanations: ${CLAIM_VALUES.postgresqlVersion.referenceLabel}`
    + ` · PGlite engine: ${actualVersion ?? CLAIM_VALUES.pgliteVersion.reportedPrefix},`
    + ' checked separately with SELECT version().'

  postgresToggle.dataset.state =
    postgres.status === 'failed'
      ? 'error'
      : postgres.source
        ? 'ready'
        : 'idle'

  if (postgres.status === 'loading') {
    postgresToggle.textContent = 'LOADING POSTGRESQL (P)…'
    postgresStatus.textContent = 'FETCHING SAME-ORIGIN PGLITE ASSETS'
    terminalState.textContent = 'BOOTING'
  } else if (postgres.status === 'querying') {
    postgresToggle.textContent = 'POSTGRESQL (P) · BUSY'
    postgresStatus.textContent = 'ONE ANALYZED EXECUTION · DISPLAY CAPTURED FROM IT'
    terminalState.textContent = 'BUSY'
  } else if (postgres.status === 'failed') {
    postgresToggle.textContent = 'POSTGRESQL (P) · RETRY'
    postgresStatus.textContent = 'PGLITE UNAVAILABLE · MACHINE RHYTHM CONTINUES'
    terminalState.textContent = 'ERROR'
  } else if (postgres.source) {
    postgresToggle.textContent = 'POSTGRESQL (P) · READY'
    postgresStatus.textContent = `SERVER ${postgres.source.serverVersion} · SINGLE CONNECTION`
    terminalState.textContent = postgres.timing ? 'READY · TIMING' : 'READY'
  } else {
    postgresToggle.textContent = 'START POSTGRESQL (P)'
    postgresStatus.textContent = 'NOT LOADED · FIRST QUERY MAY START IT'
    terminalState.textContent = 'OFFLINE'
  }

  delete postgresMeasurement.dataset.reach
  const measurementLabel = postgresMeasurement.querySelector('strong')
  if (!measurementLabel) return
  if (statement.status === 'measuring') {
    measurementLabel.textContent = 'P MEASURING EXPLAIN (ANALYZE, BUFFERS)…'
  } else if (postgres.plan) {
    const buffers = postgres.plan.buffers
    const hasRead = buffers.sharedReads > 0
    postgresMeasurement.dataset.reach = hasRead ? 'read' : 'hit'
    measurementLabel.textContent =
      `P MEASURED · HIT ${buffers.sharedHits} · READ ${buffers.sharedReads}`
      + ` · ${hasRead ? 'READ BELOW SHARED_BUFFERS' : 'ALL HIT IN SHARED_BUFFERS'}`
  } else if (postgres.report) {
    measurementLabel.textContent = postgres.report.error
      ? 'P ERROR · QUERY ARM IDLE'
      : 'P COMMAND · NO BUFFER PLAN'
  } else {
    measurementLabel.textContent = 'MODELLED UNTIL POSTGRESQL REPORTS BUFFERS'
  }
}

async function loadPostgres(announce = true) {
  if (postgres.source) return postgres.source
  if (postgres.loadPromise) return postgres.loadPromise
  postgres.status = 'loading'
  postgres.initError = null
  updatePostgresUi()
  if (announce) {
    appendSystemOutput('Starting a real, single-connection PostgreSQL in this browser…')
  }
  postgres.loadPromise = (async () => {
    try {
      const runtime = await import('./postgres.js')
      postgres.source = await runtime.loadRealPostgres()
      postgres.status = 'ready'
      updatePostgresUi()
      if (announce) {
        appendSystemOutput(
          `psql (PostgreSQL ${postgres.source.serverVersion}, PGlite)\nType "\\d" for relations.`,
        )
      }
      return postgres.source
    } catch (error) {
      postgres.status = 'failed'
      postgres.initError = error instanceof Error ? error.message : 'PGlite could not start'
      updatePostgresUi()
      if (announce) appendSystemOutput(postgres.initError, 'error')
      return null
    } finally {
      postgres.loadPromise = null
    }
  })()
  return postgres.loadPromise
}

function setCurrentReport(report) {
  postgres.report = report
  postgres.plan = report.plan
  postgres.status = 'ready'
  updatePostgresUi()
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function patternToLike(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_')
    .replaceAll('*', '%')
    .replaceAll('?', '_')
}

function relationListSql(pattern = '', tablesOnly = false) {
  let condition = ''
  if (pattern) {
    const [schemaPattern, relationPattern] = pattern.includes('.')
      ? pattern.split('.', 2)
      : ['', pattern]
    const relationLike = quoteLiteral(patternToLike(relationPattern))
    condition += ` AND c.relname LIKE ${relationLike} ESCAPE '\\'`
    if (schemaPattern) {
      condition += ` AND n.nspname LIKE ${quoteLiteral(patternToLike(schemaPattern))} ESCAPE '\\'`
    }
  }
  const kinds = tablesOnly ? "'r', 'p'" : "'r', 'p', 'v', 'm', 'S', 'f'"
  return `
    SELECT
      n.nspname AS "Schema",
      c.relname AS "Name",
      CASE c.relkind
        WHEN 'r' THEN 'table'
        WHEN 'p' THEN 'partitioned table'
        WHEN 'v' THEN 'view'
        WHEN 'm' THEN 'materialized view'
        WHEN 'S' THEN 'sequence'
        WHEN 'f' THEN 'foreign table'
      END AS "Type",
      pg_catalog.pg_get_userbyid(c.relowner) AS "Owner"
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE c.relkind IN (${kinds})
      AND n.nspname !~ '^pg_'
      AND n.nspname <> 'information_schema'
      ${condition}
    ORDER BY 1, 2`
}

async function queryCatalog(sql) {
  const report = await postgres.source.query(sql)
  setCurrentReport(report)
  return report
}

async function listRelations(command, argument) {
  const report = await queryCatalog(relationListSql(argument, command === 'dt'))
  if (report.error) return formatError(report.error, report.sql)
  const result = report.results.at(-1)
  const title = command === 'dt' ? 'List of relations' : 'List of relations'
  return `${title}\n${formatResult(result.fields, result.rows, { maxWidth: terminalWidth() })}`
}

function describeColumnsSql(regclass, extended) {
  const extra = extended
    ? `,
      CASE a.attstorage
        WHEN 'p' THEN 'plain'
        WHEN 'e' THEN 'external'
        WHEN 'm' THEN 'main'
        WHEN 'x' THEN 'extended'
      END AS "Storage",
      CASE WHEN a.attstattarget = -1 THEN NULL ELSE a.attstattarget::text END AS "Stats target",
      pg_catalog.col_description(a.attrelid, a.attnum) AS "Description"`
    : ''
  return `
    SELECT
      a.attname AS "Column",
      pg_catalog.format_type(a.atttypid, a.atttypmod) AS "Type",
      CASE
        WHEN a.attcollation <> t.typcollation THEN coll.collname
        ELSE NULL
      END AS "Collation",
      CASE WHEN a.attnotnull THEN 'not null' ELSE '' END AS "Nullable",
      pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS "Default"
      ${extra}
    FROM pg_catalog.pg_attribute AS a
    JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_collation AS coll ON coll.oid = a.attcollation
    LEFT JOIN pg_catalog.pg_attrdef AS ad
      ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE a.attrelid = ${regclass}
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY a.attnum`
}

async function describeRelation(argument, extended) {
  if (!argument) return listRelations('d', '')
  const literal = quoteLiteral(argument)
  const regclass = `pg_catalog.to_regclass(${literal})`
  const metadata = await queryCatalog(`
    SELECT
      n.nspname AS "Schema",
      c.relname AS "Name",
      CASE c.relkind
        WHEN 'r' THEN 'Table'
        WHEN 'p' THEN 'Partitioned table'
        WHEN 'v' THEN 'View'
        WHEN 'm' THEN 'Materialized view'
        WHEN 'S' THEN 'Sequence'
        WHEN 'f' THEN 'Foreign table'
      END AS "Type",
      am.amname AS "Access method",
      pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(c.oid)) AS "Size"
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_am AS am ON am.oid = c.relam
    WHERE c.oid = ${regclass}`)
  if (metadata.error) return formatError(metadata.error, metadata.sql)
  const relation = metadata.results.at(-1)?.rows[0]
  if (!relation) return `Did not find any relation named "${argument}".`

  const columns = await queryCatalog(describeColumnsSql(regclass, extended))
  if (columns.error) return formatError(columns.error, columns.sql)
  const indexes = await queryCatalog(`
    SELECT
      ic.relname AS "Name",
      i.indisprimary AS "Primary",
      i.indisunique AS "Unique",
      i.indisvalid AS "Valid",
      pg_catalog.pg_get_indexdef(i.indexrelid) AS "Definition"
    FROM pg_catalog.pg_index AS i
    JOIN pg_catalog.pg_class AS ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = ${regclass}
    ORDER BY ic.relname`)
  if (indexes.error) return formatError(indexes.error, indexes.sql)
  const constraints = await queryCatalog(`
    SELECT
      conname AS "Name",
      CASE contype
        WHEN 'f' THEN 'Foreign-key'
        WHEN 'c' THEN 'Check'
        WHEN 'u' THEN 'Unique'
        WHEN 'x' THEN 'Exclusion'
      END AS "Type",
      pg_catalog.pg_get_constraintdef(oid, true) AS "Definition"
    FROM pg_catalog.pg_constraint
    WHERE conrelid = ${regclass}
      AND contype IN ('f', 'c', 'u', 'x')
    ORDER BY conname`)
  if (constraints.error) return formatError(constraints.error, constraints.sql)

  const columnResult = columns.results.at(-1)
  const lines = [
    `${relation.Type} "${relation.Schema}.${relation.Name}"`,
    formatResult(columnResult.fields, columnResult.rows, {
      maxWidth: terminalWidth(),
      footer: false,
    }),
  ]
  const indexRows = indexes.results.at(-1)?.rows ?? []
  if (indexRows.length > 0) {
    lines.push('Indexes:')
    for (const row of indexRows) {
      lines.push(formatDescribeIndex(row))
    }
  }
  const constraintRows = constraints.results.at(-1)?.rows ?? []
  if (constraintRows.length > 0) {
    lines.push('Constraints:')
    for (const row of constraintRows) {
      lines.push(`    "${row.Name}" ${row.Type}: ${row.Definition}`)
    }
  }
  if (extended) {
    lines.push(`Access method: ${relation['Access method'] ?? 'unknown'}`)
    lines.push(`Size: ${relation.Size}`)
  }
  return lines.join('\n')
}

async function executeMetaCommand(meta) {
  if (meta.command === 'invalid') return `invalid command \\${meta.argument}`
  if (meta.command === 'timing') {
    const value = meta.argument.toLowerCase()
    if (value && !['on', 'off'].includes(value)) {
      return `unrecognized value "${meta.argument}" for "\\timing": Boolean expected`
    }
    postgres.timing = value ? value === 'on' : !postgres.timing
    updatePostgresUi()
    return `Timing is ${postgres.timing ? 'on' : 'off'}.`
  }
  if (meta.command === 'dt') return listRelations('dt', meta.argument)
  if (meta.command === 'd') return describeRelation(meta.argument, false)
  if (meta.command === 'd+') return describeRelation(meta.argument, true)
  return `invalid command \\${meta.command}`
}

async function executeCommand(command, output) {
  const source = await loadPostgres(false)
  if (!source) {
    if (statement.status === 'measuring') {
      failStatementMeasurement(postgres.initError ?? 'PostgreSQL could not start.')
    }
    output.className = 'terminal-output error'
    output.textContent = postgres.initError ?? 'PostgreSQL could not start.'
    return null
  }

  const started = performance.now()
  postgres.status = 'querying'
  updatePostgresUi()
  const meta = parseMetaCommand(command)
  let result
  let report = null
  try {
    if (meta) {
      result = await executeMetaCommand(meta)
    } else {
      report = await source.query(command)
      setCurrentReport(report)
      startStatementReplay(report)
      offerIndexWalk(report)
      result = formatReport(report, { maxWidth: terminalWidth() })
    }
  } catch (error) {
    if (!meta) failStatementMeasurement(error)
    postgres.status = 'ready'
    updatePostgresUi()
    result = error instanceof Error ? error.message : 'Command failed'
    output.className = 'terminal-output error'
  }

  if (postgres.status === 'querying') {
    postgres.status = 'ready'
    updatePostgresUi()
  }
  const elapsed = performance.now() - started
  if (postgres.timing && meta?.command !== 'timing') {
    result += `\nTime: ${elapsed.toFixed(3)} ms`
  }
  if (report?.error) output.className = 'terminal-output error'
  else if (!output.classList.contains('error')) output.className = 'terminal-output'
  output.textContent = result
  scrollTranscript()
  return report
}

async function submitCommand(value) {
  const command = String(value).trim()
  if (!command || queryBusy) return null
  const isStatement = !parseMetaCommand(command)
  if (isStatement) startStatementMeasurement(command)
  history.push(command)
  historyIndex = history.length
  historyDraft = ''
  const output = appendCommand(command)
  terminalInput.value = ''
  terminalInput.placeholder = ''
  resizeTerminalInput()
  queryBusy = true
  if (shouldFocusBoardAfterSubmit(mobileBoard, isStatement, false)) {
    terminalInput.blur()
    canvas.focus({ preventScroll: true })
  }
  terminalInput.disabled = true
  try {
    return await executeCommand(command, output)
  } finally {
    queryBusy = false
    terminalInput.disabled = false
    if (
      shouldFocusBoardAfterSubmit(
        mobileBoard,
        isStatement,
        output.classList.contains('error'),
      )
    ) {
      canvas.focus({ preventScroll: true })
    } else {
      terminalInput.focus()
    }
  }
}

function recallHistory(direction) {
  if (history.length === 0) return
  if (historyIndex === history.length && direction < 0) historyDraft = terminalInput.value
  historyIndex = clamp(historyIndex + direction, 0, history.length)
  terminalInput.value =
    historyIndex === history.length ? historyDraft : history[historyIndex]
  terminalInput.setSelectionRange(terminalInput.value.length, terminalInput.value.length)
  resizeTerminalInput()
}

window.addEventListener('resize', resize)
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(resize).observe(architectureScroll)
}
architectureScroll.addEventListener('pointerdown', onBoardPointerDown)
architectureScroll.addEventListener('pointermove', onBoardPointerMove)
architectureScroll.addEventListener('pointerup', onBoardPointerUp)
architectureScroll.addEventListener('pointercancel', onBoardPointerCancel)
architectureScroll.addEventListener('wheel', onBoardWheel, { passive: false })
canvas.addEventListener('click', onCanvasClick)
canvas.addEventListener('keydown', (event) => {
  handleBoardInstruction(event, {
    togglePaused,
    nudgeRate: nudgeMachineRate,
    reset: () => setTime(0),
  })
})
machineToggle.addEventListener('click', togglePaused)
machineReset.addEventListener('click', () => setTime(0))
machineSlower.addEventListener('click', () => nudgeMachineRate(-1))
machineFaster.addEventListener('click', () => nudgeMachineRate(1))
boardView.addEventListener('click', toggleBoardFit)
boardFollow.addEventListener('click', enableBoardFollow)
statementMode.addEventListener('click', toggleStatementMode)
statementNext.addEventListener('click', stepStatementReplay)
comparisonOpen.addEventListener('click', openComparison)
comparisonClose.addEventListener('click', closeComparison)
comparisonRun.addEventListener('click', () => { void runSynchronousCommitComparison() })
comparisonContinue.addEventListener('click', continueComparison)
comparisonTabA.addEventListener('click', () => selectComparisonLane(0))
comparisonTabB.addEventListener('click', () => selectComparisonLane(1))
comparisonLanes.addEventListener('scroll', updateComparisonTabsFromScroll, { passive: true })
indexWalkOpen.addEventListener('click', openIndexWalk)
indexWalkClose.addEventListener('click', closeIndexWalk)
indexWalkReset.addEventListener('click', resetIndexWalk)
for (const button of indexWalkStepButtons) {
  button.addEventListener('click', () => {
    void runIndexWalkStep(button.dataset.indexWalkStep)
  })
}
postgresToggle.addEventListener('click', () => {
  if (postgres.source) {
    terminalInput.focus()
    return
  }
  void loadPostgres(true).then(() => terminalInput.focus())
})
terminalForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void submitCommand(terminalInput.value)
})
terminalInput.addEventListener('input', resizeTerminalInput)
terminalInput.addEventListener('keydown', (event) => {
  if (handleTerminalInstruction(event, { submit: () => { void submitCommand(terminalInput.value) } })) {
    return
  }
  if (event.key === 'ArrowUp' && !event.shiftKey) {
    event.preventDefault()
    recallHistory(-1)
  } else if (event.key === 'ArrowDown' && !event.shiftKey) {
    event.preventDefault()
    recallHistory(1)
  }
})
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && comparisonState.visible) closeComparison()
  else if (event.key === 'Escape' && indexWalkState.visible) closeIndexWalk()
})
window.addEventListener('beforeunload', () => {
  if (postgres.source) void postgres.source.close()
})

window.MAGNUM = Object.freeze({
  periods,
  pause: () => setPaused(true),
  play: () => setPaused(false),
  setRate: setViewingRate,
  setTime,
  setLabels: (visible) => {
    labelsVisible = Boolean(visible)
    draw()
  },
  loadPostgres,
  openComparison,
  runComparison: runSynchronousCommitComparison,
  continueComparison,
  closeComparison,
  openIndexWalk,
  closeIndexWalk,
  resetIndexWalk,
  runIndexWalkStep,
  runQuery: (sql) => submitCommand(sql),
  replayLast: () => {
    if (!postgres.report) return false
    startStatementReplay(postgres.report)
    return statement.status === 'replaying'
  },
  setTraceMode: setStatementMode,
  stepTrace: stepStatementReplay,
  setBoardFit,
  setSql: (sql) => {
    terminalInput.value = String(sql)
    resizeTerminalInput()
  },
  getState: () => ({
    paused,
    rate: viewingRate,
    time: manualTime,
    labelsVisible,
    periods,
    board: {
      mobile: mobileBoard,
      fit: isBoardFit(),
      following: boardFollowing,
      fitScale: boardFitScale,
      maxScale: BOARD_MAX_SCALE,
      scale: viewScale,
      smallestLabelPixels: mobileBoard
        ? (
            effectiveLabelPixels(
              SMALLEST_SOURCE_LABEL_PX,
              viewScale,
              boardFitScale,
            ) || MIN_DETAIL_LABEL_PX
          )
        : SMALLEST_SOURCE_LABEL_PX * viewScale,
      viewX,
      viewY,
      scrollLeft: Math.max(0, -viewX),
      scrollTop: Math.max(0, -viewY),
      viewportWidth: cssWidth,
      viewportHeight: cssHeight,
    },
    statement: {
      status: statement.status,
      mode: statement.mode,
      sql: statement.sql,
      stageIndex: statement.stageIndex,
      stage: statement.replay?.stages[statement.stageIndex]?.id ?? null,
      receipt: statement.replay?.receipt ?? null,
      error: statement.error,
    },
    postgres: {
      status: postgres.status,
      serverVersion: postgres.source?.serverVersion ?? null,
      buffers: postgres.plan?.buffers ?? null,
      queryReach:
        postgres.report === null
          ? 'model'
          : postgres.plan === null
            ? 'idle'
            : postgres.plan.buffers.sharedReads > 0
              ? 'read'
              : 'hit',
      timing: postgres.timing,
      error: postgres.report?.error ?? postgres.initError,
    },
    comparison: {
      visible: comparisonState.visible,
      status: comparisonState.status,
      elapsedMs: comparisonState.elapsedMs,
      deferredFlushProgress: comparisonFlushProgress(),
      flushComplete: comparisonState.flushComplete,
      modelledSetting:
        comparisonState.model?.modelledSetting ?? 'synchronous_commit',
      held: comparisonState.model?.held ?? SYNCHRONOUS_COMMIT_COMPARISON_CLAIM.held,
      evidenceSource: comparisonState.model?.evidenceSource ?? 'model',
      stages: comparisonState.statements.map((lane) =>
        lane?.replay?.stages[lane.stageIndex]?.id ?? null),
      samePostgresReceipt:
        comparisonState.model
          ? comparisonState.model.lanes[0].replay.receipt
            === comparisonState.model.lanes[1].replay.receipt
          : null,
      error: comparisonState.error,
    },
    indexWalk: {
      visible: indexWalkState.visible,
      status: indexWalkState.status,
      invited: indexWalkState.invited,
      completed: indexWalkEvidence.filter(Boolean).length,
      evidence: indexWalkEvidence.map((entry) => entry ? { ...entry } : null),
      finding: nextIndexWalkStep() === INDEX_WALK_STEPS.length
        ? indexWalkFinding(indexWalkEvidence)
        : null,
      error: indexWalkState.error,
    },
  }),
})

resize()
resizeTerminalInput()
updatePostgresUi()
updateStatementControls()
updateComparisonUi()
updateIndexWalkUi()
setViewingRate(viewingRate)
requestAnimationFrame(frame)
