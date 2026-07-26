import { categories, connections, subsystems } from './data'
import type { CategoryId, Probe, Subsystem } from './data'

const fallback = document.querySelector<HTMLElement>('#fallback')
const canvas = document.querySelector<HTMLCanvasElement>('#scene')
const inspector = document.querySelector<HTMLElement>('#inspector')
const detailKind = document.querySelector<HTMLElement>('#detail-kind')
const detailTitle = document.querySelector<HTMLElement>('#detail-title')
const detailCopy = document.querySelector<HTMLElement>('#detail-copy')
const detailStats = document.querySelector<HTMLElement>('#detail-stats')
const search = document.querySelector<HTMLInputElement>('#search')
const categoryRoot = document.querySelector<HTMLElement>('#categories')

fallback?.setAttribute('hidden', '')
canvas?.setAttribute('hidden', '')
document.body.classList.add('software-renderer')

const map = document.createElement('section')
map.className = 'software-map'
map.setAttribute('aria-label', 'Interactive PostgreSQL observability map')
map.innerHTML = `
  <div class="software-map__sky" aria-hidden="true"></div>
  <svg class="software-map__flows software-map__flows--3d" aria-hidden="true"></svg>
  <svg class="software-map__flows software-map__flows--top" aria-hidden="true"></svg>
  <div class="software-map__buildings"></div>
  <p class="software-map__mode">COMPATIBILITY RENDERER · INTERACTIVE MAP</p>
`
document.querySelector('#app')?.prepend(map)

const buildingsRoot = map.querySelector<HTMLElement>('.software-map__buildings')!
const categoryById = new Map(categories.map((category) => [category.id, category]))
const subsystemById = new Map(subsystems.map((subsystem) => [subsystem.id, subsystem]))
const buttons = new Map<string, HTMLButtonElement>()
let activeCategory: CategoryId | null = null
let selected: Subsystem | null = null
let query = ''

function color(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`
}

function coordinates(subsystem: Subsystem, top = false): [number, number] {
  const [x, , z] = subsystem.position
  if (top) return [50 + x * 1.65, 48 + z * 1.65]
  return [50 + (x - z) * 1.25, 46 + (x + z) * 0.6 - subsystem.size[1] * 0.42]
}

function inspect(subsystem: Subsystem, probe?: Probe): void {
  selected = subsystem
  document.querySelector('.intro')?.classList.add('dismissed')
  inspector?.classList.add('open')
  if (detailKind) detailKind.textContent = probe ? probe.kind.toUpperCase() : 'SUBSYSTEM'
  if (detailTitle) detailTitle.textContent = probe?.name ?? subsystem.label
  if (detailCopy) detailCopy.textContent = probe?.note ?? subsystem.description
  if (detailStats) {
    detailStats.replaceChildren()
    for (const stat of probe ? [probe] : subsystem.probes) {
      const row = document.createElement('button')
      row.type = 'button'
      row.innerHTML = `<span>${stat.kind}</span><strong>${stat.name}</strong><small>${stat.note}</small>`
      row.addEventListener('click', () => inspect(subsystem, stat))
      detailStats.append(row)
    }
  }
  applyState()
}

function matches(subsystem: Subsystem): boolean {
  if (activeCategory && subsystem.category !== activeCategory) return false
  if (!query) return true
  return [
    subsystem.label,
    subsystem.short,
    subsystem.description,
    ...subsystem.probes.flatMap((probe) => [probe.name, probe.kind, probe.note]),
  ]
    .join(' ')
    .toLowerCase()
    .includes(query)
}

function applyState(): void {
  for (const subsystem of subsystems) {
    const button = buttons.get(subsystem.id)!
    button.classList.toggle('muted', !matches(subsystem))
    button.classList.toggle('selected', selected === subsystem)
  }
}

for (const subsystem of subsystems) {
  const category = categoryById.get(subsystem.category)!
  const [x3d, y3d] = coordinates(subsystem)
  const [xtop, ytop] = coordinates(subsystem, true)
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'software-building'
  button.style.cssText = [
    `--node:${color(category.color)}`,
    `--x3d:${x3d}%`,
    `--y3d:${y3d}%`,
    `--xtop:${xtop}%`,
    `--ytop:${ytop}%`,
    `--w:${Math.max(38, subsystem.size[0] * 9)}px`,
    `--h:${Math.max(32, subsystem.size[1] * 3.7)}px`,
  ].join(';')
  button.innerHTML = `
    <i aria-hidden="true"></i>
    <strong>${subsystem.short}</strong>
    <span>${subsystem.probes.length} probes</span>
  `
  button.setAttribute('aria-label', `${subsystem.label}, ${subsystem.probes.length} probes`)
  button.addEventListener('click', () => inspect(subsystem))
  buildingsRoot.append(button)
  buttons.set(subsystem.id, button)
}

function drawFlows(selector: string, top: boolean): void {
  const svg = map.querySelector<SVGSVGElement>(selector)!
  svg.setAttribute('viewBox', '0 0 100 100')
  for (const [fromId, toId] of connections) {
    const from = subsystemById.get(fromId)!
    const to = subsystemById.get(toId)!
    const [x1, y1] = coordinates(from, top)
    const [x2, y2] = coordinates(to, top)
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line.setAttribute('x1', String(x1))
    line.setAttribute('y1', String(y1))
    line.setAttribute('x2', String(x2))
    line.setAttribute('y2', String(y2))
    line.style.setProperty('--flow', color(categoryById.get(to.category)!.color))
    svg.append(line)
  }
}

drawFlows('.software-map__flows--3d', false)
drawFlows('.software-map__flows--top', true)

for (const category of categories) {
  const button = document.createElement('button')
  button.type = 'button'
  button.style.setProperty('--category', color(category.color))
  button.innerHTML = `<i></i>${category.label}`
  button.addEventListener('click', () => {
    activeCategory = activeCategory === category.id ? null : category.id
    categoryRoot?.querySelectorAll('button').forEach((candidate) => candidate.classList.remove('active'))
    button.classList.toggle('active', activeCategory === category.id)
    applyState()
  })
  categoryRoot?.append(button)
}

search?.addEventListener('input', () => {
  query = search.value.trim().toLowerCase()
  applyState()
})

document.querySelector('#start')?.addEventListener('click', () => {
  document.querySelector('.intro')?.classList.add('dismissed')
})

document.querySelector('#inspector-close')?.addEventListener('click', () => {
  selected = null
  inspector?.classList.remove('open')
  applyState()
})

const button3d = document.querySelector<HTMLButtonElement>('#view-3d')
const buttonTop = document.querySelector<HTMLButtonElement>('#view-top')
button3d?.addEventListener('click', () => {
  map.classList.remove('top-view')
  button3d.classList.add('active')
  buttonTop?.classList.remove('active')
})
buttonTop?.addEventListener('click', () => {
  map.classList.add('top-view')
  buttonTop.classList.add('active')
  button3d?.classList.remove('active')
})

document.querySelector('#reset')?.addEventListener('click', () => {
  activeCategory = null
  selected = null
  query = ''
  if (search) search.value = ''
  categoryRoot?.querySelectorAll('button').forEach((button) => button.classList.remove('active'))
  inspector?.classList.remove('open')
  map.classList.remove('top-view')
  button3d?.classList.add('active')
  buttonTop?.classList.remove('active')
  applyState()
})

window.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== search) {
    event.preventDefault()
    search?.focus()
  }
  if (event.key === 'Escape') {
    selected = null
    query = ''
    if (search) search.value = ''
    inspector?.classList.remove('open')
    applyState()
  }
})

applyState()
