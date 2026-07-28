const canvas = document.querySelector('#machine')
const clock = document.querySelector('#clock')
const runState = document.querySelector('#run-state')
const postgresToggle = document.querySelector('#postgres-toggle')
const postgresPanel = document.querySelector('#postgres-panel')
const postgresClose = document.querySelector('#postgres-close')
const postgresStatus = document.querySelector('#postgres-status')
const postgresSql = document.querySelector('#postgres-sql')
const postgresRun = document.querySelector('#postgres-run')
const postgresMeasurement = document.querySelector('#postgres-measurement')
const postgresOutput = document.querySelector('#postgres-output')
const ctx = canvas?.getContext('2d')

if (
  !canvas ||
  !ctx ||
  !clock ||
  !runState ||
  !postgresToggle ||
  !postgresPanel ||
  !postgresClose ||
  !postgresStatus ||
  !postgresSql ||
  !postgresRun ||
  !postgresMeasurement ||
  !postgresOutput
) {
  throw new Error('The Magnum spike is missing a required browser element')
}

const VIEW_W = 1440
const VIEW_H = 900
const MASTER_PERIOD = 36
const TAU = Math.PI * 2

const periods = Object.freeze({
  walwriter: 3,
  backends: 6,
  walsender: 9,
  bgwriter: 12,
  autovacuum: 18,
  checkpointer: 36,
})

const ink = {
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
}

const postgres = {
  status: 'idle',
  source: null,
  report: null,
  plan: null,
  initError: null,
  loadPromise: null,
}

const QUERY_ARM_INDEX = 1

const backendSpecs = [
  {
    name: 'B1',
    offset: 0,
    pivot: [310, 244],
    fetch: [410, 327],
    work: [454, 383],
    wal: [653, 259],
    commit: [698, 291],
    miss: false,
  },
  {
    name: 'B2 QUERY',
    offset: 2,
    pivot: [520, 188],
    fetch: [524, 548],
    hitFetch: [524, 382],
    work: [545, 350],
    wal: [722, 254],
    commit: [752, 291],
    miss: true,
  },
  {
    name: 'B3',
    offset: 4,
    pivot: [715, 222],
    fetch: [662, 334],
    work: [655, 401],
    wal: [822, 277],
    commit: [842, 321],
    miss: false,
  },
]

const timelineRows = [
  ['WALWRITER', periods.walwriter, ink.copperHi],
  ['BACKENDS', periods.backends, ink.brassHi],
  ['WALSENDER', periods.walsender, ink.blue],
  ['BGWRITER', periods.bgwriter, ink.teal],
  ['AUTOVACUUM ×3', periods.autovacuum, ink.green],
  ['CHECKPOINTER', periods.checkpointer, ink.red],
]

const params = new URLSearchParams(window.location.search)
const suppliedTimeParam = params.get('t')
const suppliedTime = suppliedTimeParam === null ? Number.NaN : Number(suppliedTimeParam)
let manualTime = Number.isFinite(suppliedTime) ? wrap(suppliedTime, MASTER_PERIOD) : 0
let paused =
  Number.isFinite(suppliedTime) ||
  params.get('paused') === '1'
let startAt = performance.now() / 1000 - manualTime
let lastFrame = performance.now()
let cssWidth = 0
let cssHeight = 0
let viewScale = 1
let viewX = 0
let viewY = 0

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

function mixPoint(a, b, amount) {
  return [lerp(a[0], b[0], amount), lerp(a[1], b[1], amount)]
}

function resize() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  cssWidth = window.innerWidth
  cssHeight = window.innerHeight
  canvas.width = Math.max(1, Math.floor(cssWidth * ratio))
  canvas.height = Math.max(1, Math.floor(cssHeight * ratio))
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${cssHeight}px`
  viewScale = Math.min(cssWidth / VIEW_W, cssHeight / VIEW_H)
  viewX = (cssWidth - VIEW_W * viewScale) / 2
  viewY = (cssHeight - VIEW_H * viewScale) / 2
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
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

function text(value, x, y, size, color, align = 'left', weight = 600) {
  ctx.fillStyle = color
  ctx.font = `${weight} ${size}px Georgia, "Times New Roman", serif`
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.fillText(value, x, y)
}

function mono(value, x, y, size, color, align = 'left', weight = 600) {
  ctx.fillStyle = color
  ctx.font = `${weight} ${size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  ctx.fillText(value, x, y)
}

function drawIsoPlate(x, y, width, height, depth, fill, edge = ink.brassDark) {
  ctx.beginPath()
  ctx.moveTo(x, y + height)
  ctx.lineTo(x + width, y + height)
  ctx.lineTo(x + width + depth, y + height - depth)
  ctx.lineTo(x + depth, y + height - depth)
  ctx.closePath()
  fillStroke(ink.brassDark, '#241610', 2)

  ctx.beginPath()
  ctx.moveTo(x + width, y)
  ctx.lineTo(x + width + depth, y - depth)
  ctx.lineTo(x + width + depth, y + height - depth)
  ctx.lineTo(x + width, y + height)
  ctx.closePath()
  fillStroke('#4a2c1b', '#241610', 2)

  pathRoundRect(x, y, width, height, 12)
  fillStroke(fill, edge, 3)
}

function drawScrew(x, y, radius = 5) {
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, TAU)
  fillStroke(ink.ironHi, '#171312', 1.5)
  line(x - radius * 0.55, y, x + radius * 0.55, y, '#171312', 1.5)
}

function drawSourceMedallion(x, y, source, radius = 12) {
  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, TAU)
  ctx.clip()
  ctx.fillStyle = source === 'postgres' ? '#31575a' : '#3d3027'
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2)
  if (source === 'model') {
    for (let d = -radius * 2; d <= radius * 2; d += 5) {
      line(x - radius + d, y + radius, x + radius + d, y - radius, '#7a5d42', 1)
    }
  }
  ctx.restore()
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, TAU)
  ctx.strokeStyle = source === 'postgres' ? '#9fcfd0' : ink.paperDim
  ctx.lineWidth = 1.5
  ctx.stroke()
  mono(source === 'postgres' ? 'P' : 'M', x, y + 0.5, radius, ink.ivory, 'center', 800)
}

function drawModelMedallion(x, y, radius = 12) {
  drawSourceMedallion(x, y, 'model', radius)
}

function drawPlaque(label, period, x, y, width = 154, source = 'model') {
  pathRoundRect(x, y, width, 29, 4)
  fillStroke('#27201c', '#8b6940', 1.5)
  drawSourceMedallion(x + 15, y + 14.5, source, 9)
  mono(label, x + 30, y + 11, 10, ink.ivory, 'left', 750)
  mono(
    source === 'postgres' ? `${period}s M` : `${period}s`,
    x + width - 9,
    y + 20,
    8,
    ink.paperDim,
    'right',
    650,
  )
}

function drawGear(x, y, radius, teeth, angle, fill = ink.brass) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.beginPath()
  for (let i = 0; i < teeth * 2; i += 1) {
    const a = (i / (teeth * 2)) * TAU
    const r = i % 2 === 0 ? radius : radius * 0.84
    const px = Math.cos(a) * r
    const py = Math.sin(a) * r
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  fillStroke(fill, ink.brassDark, 2)
  ctx.beginPath()
  ctx.arc(0, 0, radius * 0.45, 0, TAU)
  fillStroke(ink.iron, ink.brassHi, 2)
  drawScrew(0, 0, Math.max(3, radius * 0.12))
  ctx.restore()
}

function drawTrack(points, color = '#66513c', width = 8) {
  ctx.beginPath()
  ctx.moveTo(points[0][0], points[0][1])
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(points[i][0], points[i][1])
  }
  ctx.strokeStyle = '#211916'
  ctx.lineWidth = width + 5
  ctx.lineJoin = 'round'
  ctx.stroke()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.stroke()
  ctx.strokeStyle = '#b7925a'
  ctx.lineWidth = 1
  ctx.setLineDash([3, 10])
  ctx.stroke()
  ctx.setLineDash([])
}

function pointOnPolyline(points, progress) {
  let total = 0
  const lengths = []
  for (let i = 1; i < points.length; i += 1) {
    const length = Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
    )
    lengths.push(length)
    total += length
  }
  let remaining = clamp(progress) * total
  for (let i = 0; i < lengths.length; i += 1) {
    if (remaining <= lengths[i]) {
      const p = remaining / lengths[i]
      return mixPoint(points[i], points[i + 1], p)
    }
    remaining -= lengths[i]
  }
  return points.at(-1)
}

function drawBackdrop() {
  ctx.fillStyle = ink.void
  ctx.fillRect(0, 0, VIEW_W, VIEW_H)

  const gradient = ctx.createRadialGradient(710, 390, 90, 710, 390, 810)
  gradient.addColorStop(0, '#443226')
  gradient.addColorStop(0.55, '#241b16')
  gradient.addColorStop(1, '#0e0b09')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, VIEW_W, VIEW_H)

  ctx.globalAlpha = 0.12
  for (let x = -VIEW_H; x < VIEW_W; x += 24) {
    line(x, VIEW_H, x + VIEW_H, 0, '#b58c58', 1)
  }
  ctx.globalAlpha = 1

  text('THE UPDATE WORKS', 54, 39, 24, ink.ivory, 'left', 700)
  mono(
    'ONE COMPRESSED 36s SHOP-FLOOR CYCLE · MIXED-SOURCE SEMI-SIMULATOR',
    54,
    67,
    11,
    ink.paperDim,
    'left',
    650,
  )

  drawSourceMedallion(733, 54, 'postgres', 13)
  mono('POSTGRESQL REPORT', 755, 54, 10, ink.paper, 'left', 650)
  drawSourceMedallion(906, 54, 'model', 13)
  mono('MODELLED RHYTHM', 928, 54, 10, ink.paper, 'left', 650)
}

function drawBoard(shake) {
  ctx.save()
  ctx.translate(shake, -Math.abs(shake) * 0.35)
  ctx.shadowColor = '#000'
  ctx.shadowBlur = 28
  ctx.shadowOffsetY = 18
  drawIsoPlate(45, 105, 1040, 540, 15, '#4a382b', '#9e7440')
  ctx.shadowColor = 'transparent'

  ctx.strokeStyle = '#6c543e'
  ctx.lineWidth = 1
  for (let x = 75; x < 1060; x += 40) line(x, 124, x, 625, '#5a4434', 0.7)
  for (let y = 125; y < 625; y += 40) line(65, y, 1065, y, '#5a4434', 0.7)

  drawScrew(68, 128, 7)
  drawScrew(1060, 128, 7)
  drawScrew(68, 621, 7)
  drawScrew(1060, 621, 7)

  drawSignalConduits()
  drawVacuumArea()
  drawStorage()
  drawBufferTray()
  drawBgwriter()
  drawWalStation()
  drawCheckpointer()
  drawBackends()
  ctx.restore()
}

function drawSignalConduits() {
  drawTrack(
    [
      [632, 258],
      [720, 258],
      [790, 277],
      [850, 277],
    ],
    '#6f4b36',
    9,
  )
  for (let x = 655; x <= 835; x += 30) {
    ctx.beginPath()
    ctx.arc(x, 269 - Math.sin((x - 650) / 40) * 7, 3, 0, TAU)
    ctx.fillStyle = ink.copperHi
    ctx.fill()
  }
}

function drawBufferTray() {
  ctx.shadowColor = '#17100d'
  ctx.shadowBlur = 10
  ctx.shadowOffsetY = 5
  drawIsoPlate(370, 298, 355, 205, 10, '#493d34', '#aa7e43')
  ctx.shadowColor = 'transparent'

  const dirtyPattern = [false, true, false, true, true, false, false, true, false, false, true, false]
  let slot = 0
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const x = 390 + col * 80
      const y = 323 + row * 53
      pathRoundRect(x, y, 65, 38, 4)
      fillStroke('#251e1a', '#70583e', 1.5)
      pathRoundRect(x + 5, y + 5, 55, 27, 3)
      fillStroke(dirtyPattern[slot] ? '#8c4e2e' : '#53665a', null)
      line(x + 13, y + 13, x + 50, y + 13, dirtyPattern[slot] ? '#d4804e' : '#81a98d', 2)
      line(x + 13, y + 22, x + 41, y + 22, '#bda277', 1.5)
      if (dirtyPattern[slot]) {
        ctx.beginPath()
        ctx.arc(x + 55, y + 9, 3.5, 0, TAU)
        ctx.fillStyle = ink.orange
        ctx.fill()
      }
      slot += 1
    }
  }

  mono('BUFFER POOL', 386, 487, 10, ink.paper, 'left', 750)
  if (postgres.plan) {
    const buffers = postgres.plan.buffers
    const reach = buffers.sharedReads > 0 ? 'LONG' : 'SHORT'
    mono(
      `P  HIT ${buffers.sharedHits} · READ ${buffers.sharedReads} · ${reach}`,
      710,
      487,
      8,
      buffers.sharedReads > 0 ? ink.copperHi : '#9fcfd0',
      'right',
      700,
    )
  } else {
    mono('M  SHORT / LONG REACH', 710, 487, 8, ink.paperDim, 'right', 600)
  }
}

function backendProfile(spec, index) {
  if (index !== QUERY_ARM_INDEX || postgres.report === null) {
    return {
      active: true,
      miss: spec.miss,
      fetch: spec.fetch,
      source: 'model',
    }
  }

  if (!postgres.plan) {
    return {
      active: false,
      miss: false,
      fetch: spec.hitFetch ?? spec.fetch,
      source: 'postgres',
    }
  }

  const miss = postgres.plan.buffers.sharedReads > 0
  return {
    active: true,
    miss,
    fetch: miss ? spec.fetch : (spec.hitFetch ?? spec.fetch),
    source: 'postgres',
  }
}

function drawStorage() {
  drawTrack(
    [
      [522, 485],
      [522, 540],
      [560, 581],
    ],
    '#3f3832',
    18,
  )

  ctx.save()
  ctx.globalAlpha = 0.9
  drawIsoPlate(460, 523, 208, 88, 8, '#2a2827', '#6f5c46')
  for (let i = 0; i < 4; i += 1) {
    pathRoundRect(478 + i * 44, 544, 34, 38, 3)
    fillStroke('#151515', '#635b50', 1)
    line(485 + i * 44, 553, 503 + i * 44, 553, ink.blue, 2)
  }
  mono('STORAGE · LONG REACH', 476, 598, 9, ink.paperDim, 'left', 650)
  ctx.restore()

  const querySpec = backendSpecs[QUERY_ARM_INDEX]
  const queryProfile = backendProfile(querySpec, QUERY_ARM_INDEX)
  if (queryProfile.active && queryProfile.miss) {
    const missPhase = phase(currentTime(), periods.backends, querySpec.offset)
    const lift = missPhase < 0.25 ? smooth(range(missPhase, 0.02, 0.25)) : 0
    const pageY = lerp(562, 522, lift)
    pathRoundRect(514, pageY, 20, 13, 2)
    fillStroke(ink.blue, ink.ivory, 1)
  }
}

function drawBgwriter() {
  const p = phase(currentTime(), periods.bgwriter)
  const sweep = p < 0.5 ? easeInOut(p * 2) : 1 - easeInOut((p - 0.5) * 2)
  const x = lerp(390, 718, sweep)
  const carryingDirtyPage = p > 0.12 && p < 0.56

  line(386, 514, 727, 514, '#161311', 9)
  line(386, 514, 727, 514, ink.teal, 2)
  for (let tx = 397; tx < 720; tx += 35) line(tx, 508, tx, 520, '#8f7b5f', 2)
  drawTrack(
    [
      [722, 514],
      [746, 532],
      [746, 551],
    ],
    '#486b5c',
    6,
  )

  ctx.save()
  ctx.translate(x, 514)
  pathRoundRect(-24, -17, 48, 29, 5)
  fillStroke('#386554', '#9bb589', 2)
  if (carryingDirtyPage) {
    pathRoundRect(-13, -22, 26, 12, 2)
    fillStroke(ink.orange, ink.ivory, 1)
  }
  for (let i = -14; i <= 14; i += 14) {
    line(i, 12, i - 5, 26, ink.teal, 3)
  }
  drawScrew(0, -3, 5)
  ctx.restore()

  drawPlaque('BGWRITER', periods.bgwriter, 734, 478, 138)
}

function backendTarget(spec, p, profile) {
  const home = [spec.pivot[0], spec.pivot[1] + 24]
  if (!profile.active) return home
  const fetchReached = profile.miss ? 0.12 : 0.055
  const fetchDone = profile.miss ? 0.3 : 0.14
  const workReached = profile.miss ? 0.42 : 0.25
  if (p < fetchReached) {
    return mixPoint(home, profile.fetch, smooth(range(p, 0, fetchReached)))
  }
  if (p < fetchDone) return profile.fetch
  if (p < workReached) {
    return mixPoint(profile.fetch, spec.work, easeInOut(range(p, fetchDone, workReached)))
  }
  if (p < 0.44) return spec.work
  if (p < 0.56) return mixPoint(spec.work, spec.wal, easeInOut(range(p, 0.44, 0.56)))
  if (p < 0.62) return spec.wal
  if (p < 0.65) return mixPoint(spec.wal, spec.commit, easeInOut(range(p, 0.62, 0.65)))
  if (p < 0.9) return spec.commit
  return mixPoint(spec.commit, home, easeInOut(range(p, 0.9, 1)))
}

function drawArm(spec, index) {
  const profile = backendProfile(spec, index)
  const p = profile.active ? phase(currentTime(), periods.backends, spec.offset) : 0
  const target = backendTarget(spec, p, profile)
  const pivot = spec.pivot
  const dx = target[0] - pivot[0]
  const dy = target[1] - pivot[1]
  const distance = Math.hypot(dx, dy)
  const nx = distance > 0 ? -dy / distance : 0
  const ny = distance > 0 ? dx / distance : 0
  const bend = (index % 2 === 0 ? 1 : -1) * Math.min(54, distance * 0.28)
  const elbow = [
    lerp(pivot[0], target[0], 0.48) + nx * bend,
    lerp(pivot[1], target[1], 0.48) + ny * bend,
  ]
  const isCommit = profile.active && p >= 0.62 && p < 0.9
  const isFetching = profile.active && p < (profile.miss ? 0.3 : 0.14)
  const isWorking =
    profile.active && p >= (profile.miss ? 0.3 : 0.14) && p < 0.44
  const extension = clamp((distance - 205) / 175)

  ctx.save()
  ctx.lineCap = 'round'
  line(pivot[0], pivot[1], elbow[0], elbow[1], '#211814', 19)
  line(pivot[0], pivot[1], elbow[0], elbow[1], ink.brass, 13)
  line(elbow[0], elbow[1], target[0], target[1], '#211814', 17)
  line(elbow[0], elbow[1], target[0], target[1], extension > 0 ? ink.copper : ink.brassHi, 10)

  if (extension > 0) {
    const sleeveA = mixPoint(elbow, target, 0.42)
    const sleeveB = mixPoint(elbow, target, 0.66)
    line(sleeveA[0], sleeveA[1], sleeveB[0], sleeveB[1], ink.ironHi, 15)
    line(sleeveA[0], sleeveA[1], sleeveB[0], sleeveB[1], ink.copperHi, 5)
  }

  drawGear(pivot[0], pivot[1], 31, 14, -p * TAU, index === 1 ? ink.copper : ink.brass)
  drawScrew(elbow[0], elbow[1], 9)

  ctx.save()
  ctx.translate(target[0], target[1])
  ctx.rotate(Math.atan2(dy, dx) + Math.PI / 2)
  line(-10, 0, -3, 0, ink.iron, 7)
  line(-4, 0, 8, -10, isCommit ? ink.red : ink.brassHi, 5)
  line(-4, 0, 8, 10, isCommit ? ink.red : ink.brassHi, 5)
  ctx.restore()

  if (isFetching || isWorking) {
    pathRoundRect(target[0] - 12, target[1] - 8, 24, 16, 2)
    fillStroke(profile.miss ? ink.blue : ink.green, ink.ivory, 1.2)
  }

  if (isCommit) {
    const heat = pulse(p, 0.775, 0.14)
    ctx.beginPath()
    ctx.arc(target[0], target[1], 17 + heat * 8, 0, TAU)
    ctx.strokeStyle = `rgba(217, 93, 73, ${0.35 + heat * 0.55})`
    ctx.lineWidth = 2 + heat * 2
    ctx.stroke()
  }
  ctx.restore()

  const plaqueWidth = index === QUERY_ARM_INDEX ? 126 : 96
  drawPlaque(
    spec.name,
    periods.backends,
    pivot[0] - plaqueWidth / 2,
    pivot[1] - 66,
    plaqueWidth,
    profile.source,
  )
}

function drawBackends() {
  backendSpecs.forEach(drawArm)
}

function commitStrength(time) {
  let strength = 0
  for (let index = 0; index < backendSpecs.length; index += 1) {
    const backend = backendSpecs[index]
    if (!backendProfile(backend, index).active) continue
    const p = phase(time, periods.backends, backend.offset)
    strength = Math.max(strength, pulse(p, 0.775, 0.115))
  }
  return smooth(strength)
}

function drawWalStation() {
  const time = currentTime()
  const writerP = phase(time, periods.walwriter)
  const lock = commitStrength(time)
  const spoolX = 913
  const spoolY = 264

  drawIsoPlate(838, 172, 195, 226, 9, '#3a302b', '#a3723a')
  drawGear(spoolX, spoolY, 60, 18, writerP * TAU, ink.copper)
  drawGear(995, 215, 25, 12, -writerP * TAU * 2, ink.brass)

  ctx.save()
  ctx.translate(spoolX, spoolY)
  ctx.rotate(writerP * TAU)
  for (let i = -3; i <= 3; i += 1) {
    line(-39, i * 8, 39, i * 8, i % 2 === 0 ? ink.copperHi : ink.red, 3)
  }
  ctx.restore()

  const pressY = lerp(175, 235, lock)
  pathRoundRect(864, pressY, 98, 22, 5)
  fillStroke(lock > 0.5 ? ink.red : ink.ironHi, ink.brassHi, 2)
  line(875, 168, 875, pressY, ink.iron, 10)
  line(951, 168, 951, pressY, ink.iron, 10)

  if (lock > 0.25) {
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * TAU + time
      const r = 69 + (i % 2) * 8
      line(
        spoolX + Math.cos(a) * 58,
        spoolY + Math.sin(a) * 58,
        spoolX + Math.cos(a) * r,
        spoolY + Math.sin(a) * r,
        i % 2 ? ink.red : ink.brassHi,
        2,
      )
    }
  }

  drawPlaque('COMMIT / FSYNC', periods.backends, 854, 337, 166)
  mono('WAL BUFFERS', 871, 383, 10, ink.paper, 'left', 750)
  drawPlaque('WALWRITER', periods.walwriter, 886, 408, 147)
}

function drawCheckpointer() {
  const p = phase(currentTime(), periods.checkpointer)
  const wind = smooth(range(p, 0.72, 0.84))
  const strike = smooth(range(p, 0.84, 0.89)) * (1 - smooth(range(p, 0.91, 0.97)))
  const angle = p * TAU

  drawIsoPlate(82, 354, 220, 174, 7, '#39312c', '#8a6235')
  drawGear(153, 427, 60, 20, angle, '#a56536')
  drawGear(242, 408, 33, 12, -angle * 1.5, ink.brass)

  const hammerTop = lerp(366, 408, wind)
  const hammerY = lerp(hammerTop, 474, strike)
  line(238, 370, 238, hammerY, ink.iron, 15)
  pathRoundRect(203, hammerY - 10, 70, 29, 5)
  fillStroke(strike > 0.45 ? ink.red : ink.brassDark, ink.brassHi, 2)
  line(196, 493, 283, 493, ink.iron, 14)
  if (strike > 0.25) {
    ctx.globalAlpha = strike * 0.7
    for (let r = 20; r <= 92; r += 18) {
      ctx.beginPath()
      ctx.ellipse(238, 491, r, r * 0.2, 0, 0, TAU)
      ctx.strokeStyle = ink.red
      ctx.lineWidth = 3
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  drawPlaque('CHECKPOINTER', periods.checkpointer, 103, 536, 170)
}

function drawVacuumArea() {
  const starts = [
    [92, 574],
    [92, 607],
    [92, 638],
  ]
  const tables = [
    [298, 562],
    [470, 590],
    [674, 566],
  ]

  for (let i = 0; i < 3; i += 1) {
    const start = starts[i]
    const table = tables[i]
    drawTrack(
      [
        start,
        [start[0] + 72, start[1]],
        [table[0] - 35, table[1]],
      ],
      '#4f6552',
      6,
    )
    ctx.beginPath()
    ctx.ellipse(table[0], table[1], 35, 17, -0.1, 0, TAU)
    fillStroke('#292722', '#8ca370', 2)
    ctx.beginPath()
    ctx.ellipse(table[0], table[1] - 7, 29, 12, -0.1, 0, TAU)
    fillStroke('#60513a', '#b6a47a', 1)
  }

  const offsets = [0, 6, 12]
  for (let i = 0; i < 3; i += 1) {
    const p = phase(currentTime(), periods.autovacuum, offsets[i])
    const travelOut = easeInOut(range(p, 0.02, 0.27))
    const travelBack = easeInOut(range(p, 0.72, 0.98))
    const position = p < 0.72 ? travelOut : 1 - travelBack
    const atTable = p >= 0.27 && p < 0.72
    const start = starts[i]
    const table = tables[i]
    const x = lerp(start[0], table[0] - 35, position)
    const y = lerp(start[1], table[1], position)
    drawVacuumCart(x, y, i, p, atTable)
  }

  drawPlaque('AUTOVACUUM ×3', periods.autovacuum, 817, 573, 190)
}

function drawVacuumCart(x, y, index, p, atTable) {
  ctx.save()
  ctx.translate(x, y)
  if (atTable) ctx.rotate(Math.sin(p * TAU * 18) * 0.025)
  pathRoundRect(-23, -14, 46, 25, 6)
  fillStroke(index === 1 ? '#55724c' : '#6b814f', '#b5c378', 2)
  ctx.beginPath()
  ctx.arc(0, -17, 10, 0, TAU)
  fillStroke(ink.iron, ink.green, 2)
  line(0, -17, Math.cos(p * TAU * 12) * 8, -17 + Math.sin(p * TAU * 12) * 8, ink.ivory, 2)
  for (const wheelX of [-15, 15]) {
    ctx.beginPath()
    ctx.arc(wheelX, 13, 6, 0, TAU)
    fillStroke(ink.iron, ink.paperDim, 1)
  }
  drawModelMedallion(0, 0, 7)
  ctx.restore()
}

function checkpointShake(time) {
  const p = phase(time, periods.checkpointer)
  const strike = smooth(range(p, 0.84, 0.89)) * (1 - smooth(range(p, 0.91, 0.97)))
  return Math.sin(time * 47) * strike * 4
}

function drawSenderAndStandby() {
  const p = phase(currentTime(), periods.walsender)
  const route = [
    [1005, 250],
    [1105, 250],
    [1143, 280],
    [1190, 280],
  ]

  ctx.save()
  ctx.shadowColor = '#000'
  ctx.shadowBlur = 22
  ctx.shadowOffsetY = 14
  drawIsoPlate(1168, 190, 220, 355, 12, '#353638', '#567d82')
  ctx.shadowColor = 'transparent'
  drawTrack(route, '#467c85', 11)

  for (let i = 0; i < 3; i += 1) {
    const packetP = wrap(p + i / 3, 1)
    const packet = pointOnPolyline(route, packetP)
    ctx.save()
    ctx.translate(packet[0], packet[1])
    ctx.rotate(0.18)
    pathRoundRect(-12, -7, 24, 14, 3)
    fillStroke(ink.blue, ink.ivory, 1.5)
    line(-6, -2, 7, -2, '#d3f0ed', 1.5)
    line(-6, 3, 3, 3, '#d3f0ed', 1)
    ctx.restore()
  }

  drawGear(1268, 325, 56, 18, p * TAU, '#4c7e84')
  drawGear(1329, 386, 31, 12, -p * TAU * 1.5, ink.brass)
  line(1268, 325, 1268, 456, '#17191a', 18)
  line(1268, 325, 1268, 456, ink.blue, 7)
  pathRoundRect(1212, 444, 112, 48, 7)
  fillStroke('#273739', '#78aeb1', 2)
  mono('REPLAY', 1268, 468, 10, ink.ivory, 'center', 750)

  drawPlaque('WALSENDER', periods.walsender, 1062, 301, 150)
  drawPlaque('STANDBY', periods.walsender, 1208, 508, 146)
  mono('SMALLER MACHINE', 1279, 219, 10, ink.paperDim, 'center', 650)
  ctx.restore()
}

function drawTimeline(time) {
  const x = 54
  const y = 684
  const width = 1332
  const height = 186
  const labelWidth = 176
  const periodWidth = 70
  const gridX = x + labelWidth
  const gridWidth = width - labelWidth - periodWidth - 18
  const rowHeight = 22

  drawIsoPlate(x, y, width, height, 7, '#28211d', '#8b6439')
  mono('INSTRUCTION RHYTHMS · ONE SHARED 36s CLOCK', x + 20, y + 20, 11, ink.ivory, 'left', 750)
  mono(
    'TOP = FAST / CONTINUOUS · BOTTOM = RARE / HEAVY',
    gridX + gridWidth,
    y + 20,
    8,
    ink.paperDim,
    'right',
    650,
  )

  const top = y + 38
  for (let second = 0; second <= MASTER_PERIOD; second += 3) {
    const gx = gridX + (second / MASTER_PERIOD) * gridWidth
    line(
      gx,
      top,
      gx,
      top + timelineRows.length * rowHeight,
      second % 6 === 0 ? '#6a5743' : '#45382d',
      second % 6 === 0 ? 1.2 : 0.7,
    )
    if (second % 6 === 0) mono(String(second), gx, top - 8, 7, ink.paperDim, 'center', 550)
  }

  timelineRows.forEach(([label, period, color], row) => {
    const rowY = top + row * rowHeight
    mono(label, x + 20, rowY + 10, 9, ink.paper, 'left', 650)
    line(gridX, rowY + rowHeight, gridX + gridWidth, rowY + rowHeight, '#44372d', 1)

    const repeats = MASTER_PERIOD / period
    for (let i = 0; i < repeats; i += 1) {
      const bx = gridX + (i * period * gridWidth) / MASTER_PERIOD + 2
      const bw = (period * gridWidth) / MASTER_PERIOD - 4
      pathRoundRect(bx, rowY + 5, bw, 10, 3)
      ctx.fillStyle = `${color}99`
      ctx.fill()
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.stroke()

      if (label === 'BACKENDS') {
        ctx.fillStyle = `${ink.red}aa`
        ctx.fillRect(bx + bw * 0.65, rowY + 5, bw * 0.25, 10)
        for (let arm = 0; arm < 3; arm += 1) {
          ctx.beginPath()
          ctx.arc(bx + 5 + arm * 7, rowY + 10, 2, 0, TAU)
          ctx.fillStyle = arm === 1 ? ink.copperHi : ink.brassHi
          ctx.fill()
        }
      } else if (label === 'CHECKPOINTER') {
        ctx.fillStyle = ink.red
        ctx.fillRect(bx + bw * 0.84, rowY + 4, bw * 0.1, 12)
      }
    }
    mono(
      `${period}s M  ×${String(repeats).padStart(2, '0')}`,
      x + width - 20,
      rowY + 10,
      9,
      color,
      'right',
      700,
    )
  })

  const playX = gridX + (wrap(time, MASTER_PERIOD) / MASTER_PERIOD) * gridWidth
  line(playX, top - 3, playX, top + timelineRows.length * rowHeight + 1, ink.ivory, 2)
  ctx.beginPath()
  ctx.moveTo(playX - 5, top - 4)
  ctx.lineTo(playX + 5, top - 4)
  ctx.lineTo(playX, top + 4)
  ctx.closePath()
  ctx.fillStyle = ink.ivory
  ctx.fill()
}

function formatMetric(value) {
  if (!Number.isFinite(value)) return '0'
  if (Math.abs(value) >= 100) return String(Math.round(value))
  return Number(value).toFixed(2).replace(/\.?0+$/, '')
}

function appendPlanLines(node, depth, lines) {
  const operation = node.operation ? `${node.operation} ` : ''
  const relation = node.relationName ? ` on ${node.relationName}` : ''
  const index = node.indexName ? ` using ${node.indexName}` : ''
  const indent = '  '.repeat(depth)
  lines.push(
    `${indent}${depth > 0 ? '↳ ' : ''}${operation}${node.nodeType}${relation}${index}`,
  )
  lines.push(
    `${indent}  cost ${formatMetric(node.startupCost)}..${formatMetric(node.totalCost)}`
      + ` · rows est ${formatMetric(node.planRows)} / actual ${formatMetric(node.actualRows)}`
      + ` × ${formatMetric(node.actualLoops)}`
      + ` · ${formatMetric(node.actualTotalTimeMs)} ms`
      + ` · hit ${node.sharedHits} read ${node.sharedReads}`,
  )
  for (const child of node.children) appendPlanLines(child, depth + 1, lines)
}

function jsonLine(value) {
  try {
    return JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item)
  } catch {
    return String(value)
  }
}

function reportText(report) {
  if (report.error) {
    const error = report.error
    const lines = [
      `P ${error.severity} ${error.code}`,
      error.message,
    ]
    if (error.detail) lines.push(`DETAIL: ${error.detail}`)
    if (error.hint) lines.push(`HINT: ${error.hint}`)
    if (error.position) lines.push(`POSITION: ${error.position}`)
    return lines.join('\n')
  }

  const lines = [`P PostgreSQL ${report.serverVersion}`]
  if (report.plan) {
    lines.push(
      `P BUFFERS · shared hit=${report.plan.buffers.sharedHits}`
        + ` read=${report.plan.buffers.sharedReads}`,
    )
    lines.push(
      `P TIME · planning ${formatMetric(report.plan.planningTimeMs)} ms`
        + ` · execution ${formatMetric(report.plan.executionTimeMs)} ms`,
    )
    appendPlanLines(report.plan.root, 0, lines)
  } else {
    lines.push('P PLAN · not applicable to this command')
  }

  report.results.forEach((result, index) => {
    const names = result.fields.map((field) => field.name).join(', ')
    const affected =
      result.affectedRows === null ? '' : ` · ${result.affectedRows} affected`
    lines.push(`P RESULT ${index + 1} · ${result.rows.length} row(s)${affected}`)
    if (names) lines.push(`  fields: ${names}`)
    for (const row of result.rows.slice(0, 8)) lines.push(`  ${jsonLine(row)}`)
    if (result.rows.length > 8) lines.push(`  … ${result.rows.length - 8} more row(s)`)
  })
  return lines.join('\n')
}

function updatePostgresUi() {
  postgresRun.disabled =
    postgres.source === null ||
    postgres.status === 'loading' ||
    postgres.status === 'querying'
  postgresToggle.dataset.state =
    postgres.status === 'failed'
      ? 'error'
      : postgres.source
        ? 'ready'
        : 'idle'

  if (postgres.status === 'loading') {
    postgresToggle.textContent = 'LOADING POSTGRESQL (P)…'
    postgresStatus.textContent = 'FETCHING SAME-ORIGIN PGLITE ASSETS'
    postgresOutput.textContent =
      'Starting a real, single-connection PostgreSQL in this browser…'
  } else if (postgres.status === 'querying') {
    postgresToggle.textContent = 'POSTGRESQL (P) · RUNNING'
    postgresStatus.textContent = 'EXPLAIN ANALYZE + REAL QUERY'
    postgresOutput.textContent = 'PostgreSQL is parsing, planning, and executing…'
  } else if (postgres.status === 'failed') {
    postgresToggle.textContent = 'POSTGRESQL (P) · RETRY'
    postgresStatus.textContent = 'PGLITE UNAVAILABLE · MODEL STILL RUNNING'
    postgresOutput.textContent = postgres.initError ?? 'PostgreSQL could not start.'
  } else if (postgres.source) {
    postgresToggle.textContent = 'POSTGRESQL (P) · READY'
    postgresStatus.textContent = postgres.report?.error
      ? 'GENUINE POSTGRESQL ERROR · SOURCE READY'
      : `SERVER ${postgres.source.serverVersion} · SINGLE CONNECTION`
    postgresOutput.textContent = postgres.report
      ? reportText(postgres.report)
      : 'PostgreSQL is ready.'
  } else {
    postgresToggle.textContent = 'LOAD POSTGRESQL (P)'
    postgresStatus.textContent = 'NOT LOADED · BOARD REMAINS MODELLED'
  }

  delete postgresMeasurement.dataset.reach
  const measurementLabel = postgresMeasurement.querySelector('strong')
  if (!measurementLabel) return

  if (postgres.plan) {
    const buffers = postgres.plan.buffers
    const hasRead = buffers.sharedReads > 0
    postgresMeasurement.dataset.reach = hasRead ? 'read' : 'hit'
    measurementLabel.textContent =
      `P HIT ${buffers.sharedHits} · READ ${buffers.sharedReads}`
      + ` · ${hasRead ? 'LONG REACH' : 'SHORT REACH'}`
  } else if (postgres.report) {
    postgresMeasurement.dataset.reach = 'none'
    measurementLabel.textContent = postgres.report.error
      ? 'P ERROR · QUERY ARM IDLE'
      : 'P RESULT · NO PLAN / NO REACH'
  } else {
    measurementLabel.textContent = 'MODELLED UNTIL POSTGRESQL LOADS'
  }
}

function showPostgresPanel() {
  postgresPanel.hidden = false
  postgresToggle.setAttribute('aria-expanded', 'true')
}

function hidePostgresPanel() {
  postgresPanel.hidden = true
  postgresToggle.setAttribute('aria-expanded', 'false')
}

async function executePostgresQuery(sql = postgresSql.value) {
  if (!postgres.source) throw new Error('PostgreSQL has not loaded')
  const statement = sql.trim()
  if (!statement) {
    postgresOutput.textContent = 'Enter SQL for PostgreSQL to parse and execute.'
    return null
  }

  postgresSql.value = statement
  postgres.status = 'querying'
  postgres.initError = null
  updatePostgresUi()
  try {
    const report = await postgres.source.query(statement)
    postgres.report = report
    postgres.plan = report.plan
    postgres.status = 'ready'
    updatePostgresUi()
    return report
  } catch (error) {
    postgres.report = null
    postgres.plan = null
    postgres.status = 'failed'
    postgres.initError =
      error instanceof Error ? error.message : 'PostgreSQL query execution failed'
    updatePostgresUi()
    return null
  }
}

async function loadPostgres(runInitialQuery = true) {
  showPostgresPanel()
  if (postgres.source) {
    if (runInitialQuery && postgres.report === null) {
      await executePostgresQuery()
    }
    return postgres.source
  }
  if (postgres.loadPromise) return postgres.loadPromise

  postgres.status = 'loading'
  postgres.initError = null
  updatePostgresUi()
  postgres.loadPromise = (async () => {
    try {
      const runtime = await import('../../src/observability/real-postgres.ts')
      postgres.source = await runtime.loadRealPostgres()
      postgres.status = 'ready'
      updatePostgresUi()
      if (runInitialQuery) await executePostgresQuery()
      return postgres.source
    } catch (error) {
      postgres.status = 'failed'
      postgres.initError =
        error instanceof Error ? error.message : 'PGlite could not start'
      updatePostgresUi()
      return null
    } finally {
      postgres.loadPromise = null
    }
  })()
  return postgres.loadPromise
}

async function runPostgresQuery(sql) {
  showPostgresPanel()
  if (typeof sql === 'string') postgresSql.value = sql
  if (!postgres.source) {
    const source = await loadPostgres(false)
    if (!source) return null
  }
  return executePostgresQuery()
}

function currentTime() {
  return manualTime
}

function setTime(seconds) {
  manualTime = wrap(Number(seconds) || 0, MASTER_PERIOD)
  startAt = performance.now() / 1000 - manualTime
  draw()
}

function setPaused(nextPaused) {
  paused = Boolean(nextPaused)
  if (!paused) startAt = performance.now() / 1000 - manualTime
  updateReadout()
}

function togglePaused() {
  setPaused(!paused)
}

function updateReadout() {
  clock.textContent = `${manualTime.toFixed(1).padStart(4, '0')} / 36s`
  runState.textContent = paused ? 'PAUSED · SPACE TO RUN' : 'RUNNING · SPACE TO PAUSE'
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
  drawBackdrop()
  const shake = checkpointShake(manualTime)
  drawBoard(shake)
  drawSenderAndStandby()
  drawTimeline(manualTime)
  ctx.restore()
  updateReadout()
}

function frame(now) {
  const elapsed = Math.min(0.1, (now - lastFrame) / 1000)
  lastFrame = now
  if (!paused) {
    manualTime = wrap(now / 1000 - startAt, MASTER_PERIOD)
  } else {
    void elapsed
  }
  draw()
  requestAnimationFrame(frame)
}

window.addEventListener('resize', resize)
window.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    event.preventDefault()
    togglePaused()
  } else if (event.key.toLowerCase() === 'r') {
    setTime(0)
  } else if (event.key === 'Escape' && !postgresPanel.hidden) {
    hidePostgresPanel()
  }
})
canvas.addEventListener('click', togglePaused)
postgresToggle.addEventListener('click', () => {
  if (!postgresPanel.hidden) {
    hidePostgresPanel()
    return
  }
  showPostgresPanel()
  if (!postgres.source) void loadPostgres(true)
})
postgresClose.addEventListener('click', hidePostgresPanel)
postgresRun.addEventListener('click', () => void runPostgresQuery())
postgresSql.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    void runPostgresQuery()
  }
})
window.addEventListener('beforeunload', () => {
  if (postgres.source) void postgres.source.close()
})

window.MAGNUM = Object.freeze({
  periods,
  pause: () => setPaused(true),
  play: () => setPaused(false),
  setTime,
  loadPostgres,
  runQuery: runPostgresQuery,
  setSql: (sql) => {
    postgresSql.value = String(sql)
  },
  getState: () => ({
    paused,
    time: manualTime,
    periods,
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
      error: postgres.report?.error ?? postgres.initError,
    },
  }),
})

resize()
updatePostgresUi()
requestAnimationFrame(frame)
