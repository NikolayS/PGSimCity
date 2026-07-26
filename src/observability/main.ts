import './style.css'

import { flows, groups, nodes, probeAvailable, probes, versions } from './data'
import type { PgVersion, Probe, SystemNode } from './data'

const stage = document.querySelector<HTMLElement>('#architecture')
const nodeLayer = document.querySelector<HTMLElement>('#nodes')
const flowLayer = document.querySelector<SVGSVGElement>('#flows')
const probeLayers = {
  left: document.querySelector<HTMLElement>('#probes-left'),
  right: document.querySelector<HTMLElement>('#probes-right'),
  bottom: document.querySelector<HTMLElement>('#probes-bottom'),
}
const versionRail = document.querySelector<HTMLElement>('#versions')
const search = document.querySelector<HTMLInputElement>('#search')
const inspector = document.querySelector<HTMLElement>('#inspector')
const detailType = document.querySelector<HTMLElement>('#detail-type')
const detailTitle = document.querySelector<HTMLElement>('#detail-title')
const detailCopy = document.querySelector<HTMLElement>('#detail-copy')
const detailMeta = document.querySelector<HTMLElement>('#detail-meta')
const detailTargets = document.querySelector<HTMLElement>('#detail-targets')
const detailColumns = document.querySelector<HTMLElement>('#detail-columns')
const detailTip = document.querySelector<HTMLElement>('#detail-tip')
const detailTipWrap = document.querySelector<HTMLElement>('#detail-tip-wrap')

if (!stage || !nodeLayer || !flowLayer || !versionRail) throw new Error('Observability map shell is incomplete')

const groupById = new Map(groups.map((group) => [group.id, group]))
const nodeById = new Map(nodes.map((node) => [node.id, node]))
const nodeElements = new Map<string, HTMLButtonElement>()
const probeElements = new Map<string, HTMLButtonElement>()
let selectedVersion: PgVersion = '18'
let selectedProbe: Probe | null = null
let selectedNode: SystemNode | null = null
let query = ''

function createNode(node: SystemNode): HTMLButtonElement {
  const group = groupById.get(node.group)!
  const element = document.createElement('button')
  element.type = 'button'
  element.className = 'system-node'
  element.dataset.node = node.id
  element.style.cssText = [
    `--x:${node.x}%`,
    `--y:${node.y}%`,
    `--w:${node.width}%`,
    `--h:${node.height}%`,
    `--depth:${node.depth}px`,
    `--node:${group.color}`,
  ].join(';')
  element.innerHTML = `<span>${node.label}</span><small>${group.label}</small>`
  element.addEventListener('click', () => inspectNode(node))
  nodeLayer!.append(element)
  nodeElements.set(node.id, element)
  return element
}

function createProbe(probe: Probe): HTMLButtonElement {
  const target = nodeById.get(probe.targets[0]!)!
  const color = groupById.get(target.group)!.color
  const element = document.createElement('button')
  element.type = 'button'
  element.className = 'probe'
  element.dataset.probe = probe.id
  element.style.setProperty('--probe', color)
  element.innerHTML = `<i></i><span>${probe.name}</span><small>${probe.kind}</small>`
  element.addEventListener('click', () => inspectProbe(probe))
  probeLayers[probe.side]?.append(element)
  probeElements.set(probe.id, element)
  return element
}

nodes.forEach(createNode)
probes.slice().sort((a, b) => a.order - b.order).forEach(createProbe)

function center(node: SystemNode): [number, number] {
  return [node.x + node.width / 2, node.y + node.height / 2]
}

function drawFlows(): void {
  flowLayer!.replaceChildren()
  flowLayer!.setAttribute('viewBox', '0 0 100 117')
  for (const [fromId, toId, label] of flows) {
    const from = nodeById.get(fromId)!
    const to = nodeById.get(toId)!
    const [x1, y1] = center(from)
    const [x2, y2] = center(to)
    const group = groupById.get(to.group)!
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    const vertical = Math.abs(y2 - y1) > Math.abs(x2 - x1)
    const bend = vertical
      ? `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`
      : `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`
    path.setAttribute('d', bend)
    path.style.setProperty('--flow', group.color)
    path.dataset.from = fromId
    path.dataset.to = toId
    path.dataset.label = label
    flowLayer!.append(path)
  }
}

drawFlows()

function inspectProbe(probe: Probe): void {
  selectedProbe = probe
  selectedNode = null
  inspector?.classList.add('open')
  if (detailType) detailType.textContent = probe.kind.toUpperCase()
  if (detailTitle) detailTitle.textContent = probe.name
  if (detailCopy) detailCopy.textContent = probe.summary
  if (detailMeta) {
    detailMeta.innerHTML = `<span>PG ${probe.since}+</span><span>${probe.kind}</span><span>${probe.targets.length} subsystem${probe.targets.length === 1 ? '' : 's'}</span>`
  }
  if (detailTargets) {
    detailTargets.replaceChildren()
    for (const targetId of probe.targets) {
      const node = nodeById.get(targetId)!
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = node.label
      button.addEventListener('click', () => inspectNode(node))
      detailTargets.append(button)
    }
  }
  if (detailColumns) {
    detailColumns.replaceChildren()
    for (const column of probe.columns ?? []) {
      const code = document.createElement('code')
      code.textContent = column
      detailColumns.append(code)
    }
  }
  if (detailTipWrap) detailTipWrap.hidden = !probe.tip
  if (detailTip) detailTip.textContent = probe.tip ?? ''
  applyState()
}

function inspectNode(node: SystemNode): void {
  selectedNode = node
  selectedProbe = null
  inspector?.classList.add('open')
  const related = probes.filter((probe) => probe.targets.includes(node.id) && probeAvailable(probe, selectedVersion))
  if (detailType) detailType.textContent = 'POSTGRES SUBSYSTEM'
  if (detailTitle) detailTitle.textContent = node.label
  if (detailCopy) detailCopy.textContent = node.description
  if (detailMeta) detailMeta.innerHTML = `<span>${groupById.get(node.group)!.label}</span><span>${related.length} observability items</span>`
  if (detailTargets) {
    detailTargets.replaceChildren()
    for (const probe of related) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = probe.name
      button.addEventListener('click', () => inspectProbe(probe))
      detailTargets.append(button)
    }
  }
  detailColumns?.replaceChildren()
  if (detailTipWrap) detailTipWrap.hidden = true
  applyState()
}

function probeMatches(probe: Probe): boolean {
  if (!probeAvailable(probe, selectedVersion)) return false
  if (!query) return true
  return [probe.name, probe.kind, probe.summary, ...(probe.columns ?? []), ...probe.targets]
    .join(' ')
    .toLowerCase()
    .includes(query)
}

function applyState(): void {
  const matchedTargets = new Set<string>()
  for (const probe of probes) {
    const element = probeElements.get(probe.id)!
    const available = probeAvailable(probe, selectedVersion)
    const matches = probeMatches(probe)
    element.classList.toggle('unavailable', !available)
    element.classList.toggle('muted', available && !matches)
    element.classList.toggle('selected', selectedProbe === probe)
    element.title = available ? `${probe.name} — available in PG ${probe.since}+` : `${probe.name} — added in PG ${probe.since}`
    if (matches) probe.targets.forEach((target) => matchedTargets.add(target))
  }

  for (const node of nodes) {
    const selected = selectedNode === node || selectedProbe?.targets.includes(node.id)
    const searchable = !query || matchedTargets.has(node.id) || node.label.toLowerCase().includes(query)
    const element = nodeElements.get(node.id)!
    element.classList.toggle('selected', Boolean(selected))
    element.classList.toggle('muted', !searchable)
  }

  flowLayer!.querySelectorAll<SVGPathElement>('path').forEach((path) => {
    const active = selectedProbe
      ? selectedProbe.targets.includes(path.dataset.from ?? '') || selectedProbe.targets.includes(path.dataset.to ?? '')
      : selectedNode
        ? path.dataset.from === selectedNode.id || path.dataset.to === selectedNode.id
        : false
    path.classList.toggle('active', active)
    path.classList.toggle('muted', Boolean(query) && !matchedTargets.has(path.dataset.from ?? '') && !matchedTargets.has(path.dataset.to ?? ''))
  })

  document.querySelector('#version-caption')!.textContent = `POSTGRES ${selectedVersion}`
  document.querySelector('#visible-count')!.textContent = String(probes.filter((probe) => probeAvailable(probe, selectedVersion)).length)
}

for (const version of versions) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = version
  button.classList.toggle('active', version === selectedVersion)
  button.addEventListener('click', () => {
    selectedVersion = version
    versionRail.querySelectorAll('button').forEach((candidate) => candidate.classList.remove('active'))
    button.classList.add('active')
    if (selectedProbe && !probeAvailable(selectedProbe, selectedVersion)) {
      selectedProbe = null
      inspector?.classList.remove('open')
    }
    applyState()
  })
  versionRail.append(button)
}

for (const group of groups) {
  const item = document.createElement('span')
  item.style.setProperty('--legend', group.color)
  item.innerHTML = `<i></i>${group.label}`
  document.querySelector('#legend-groups')?.append(item)
}

search?.addEventListener('input', () => {
  query = search.value.trim().toLowerCase()
  applyState()
})

document.querySelector('#inspector-close')?.addEventListener('click', () => {
  selectedProbe = null
  selectedNode = null
  inspector?.classList.remove('open')
  applyState()
})

document.querySelector('#view-depth')?.addEventListener('click', (event) => {
  stage.classList.remove('flat')
  document.querySelectorAll('.view-switch button').forEach((button) => button.classList.remove('active'))
  ;(event.currentTarget as HTMLButtonElement).classList.add('active')
})

document.querySelector('#view-flat')?.addEventListener('click', (event) => {
  stage.classList.add('flat')
  document.querySelectorAll('.view-switch button').forEach((button) => button.classList.remove('active'))
  ;(event.currentTarget as HTMLButtonElement).classList.add('active')
})

window.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== search) {
    event.preventDefault()
    search?.focus()
  }
  if (event.key === 'Escape') {
    selectedProbe = null
    selectedNode = null
    query = ''
    if (search) search.value = ''
    inspector?.classList.remove('open')
    applyState()
  }
})

applyState()
