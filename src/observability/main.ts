import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import './style.css'
import { categories, connections, subsystems } from './data'
import type { CategoryId, Probe, Subsystem } from './data'

interface ProbeRuntime {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>
  line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
  data: Probe
}

interface SubsystemRuntime {
  data: Subsystem
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>
  edges: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>
  halo: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
  label: HTMLDivElement
  probes: ProbeRuntime[]
}

interface HitData {
  kind: 'subsystem' | 'probe'
  subsystem: SubsystemRuntime
  probe?: ProbeRuntime
}

const canvasPlaceholder = document.querySelector<HTMLCanvasElement>('#scene')
const fallback = document.querySelector<HTMLElement>('#fallback')

if (!canvasPlaceholder) throw new Error('Observability canvas is missing')

async function createRenderer(): Promise<THREE.WebGLRenderer> {
  const profiles: THREE.WebGLRendererParameters[] = [
    {
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    },
    { antialias: false },
    { antialias: false, powerPreference: 'low-power', stencil: false },
  ]

  let lastError: unknown
  for (const [index, profile] of profiles.entries()) {
    try {
      return new THREE.WebGLRenderer(profile)
    } catch (error) {
      lastError = error
      console.warn(`WebGL renderer profile ${index + 1} failed.`, error)
      await new Promise<void>((resolve) => window.setTimeout(resolve, 250))
    }
  }

  throw lastError
}

let renderer: THREE.WebGLRenderer | null = null
const forceSoftwareRenderer = new URLSearchParams(window.location.search).get('renderer') === 'software'
if (forceSoftwareRenderer) {
  await import('./software-map')
} else {
  try {
    renderer = await createRenderer()
  } catch (error) {
    console.error('Falling back to the CSS observability map.', error)
    await import('./software-map')
  }
}

if (renderer) {
const activeRenderer = renderer
const canvas = activeRenderer.domElement
canvas.id = 'scene'
canvas.setAttribute('aria-label', canvasPlaceholder.getAttribute('aria-label') ?? 'Interactive 3D map')
canvasPlaceholder.replaceWith(canvas)

canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault()
  if (fallback) {
    fallback.textContent = 'The graphics context was lost. Reload this page to restore the map.'
    fallback.hidden = false
  }
})

activeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
activeRenderer.setSize(window.innerWidth, window.innerHeight, false)
activeRenderer.outputColorSpace = THREE.SRGBColorSpace
activeRenderer.toneMapping = THREE.ACESFilmicToneMapping
activeRenderer.toneMappingExposure = 1.15

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x050812)
scene.fog = new THREE.FogExp2(0x050812, 0.018)

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 180)
camera.position.set(35, 28, 42)

const controls = new OrbitControls(camera, activeRenderer.domElement)
controls.enableDamping = true
controls.dampingFactor = 0.055
controls.minDistance = 14
controls.maxDistance = 80
controls.maxPolarAngle = Math.PI * 0.47
controls.target.set(4, 3, 3)

scene.add(new THREE.HemisphereLight(0xbad9ff, 0x080b16, 1.45))
const key = new THREE.DirectionalLight(0xe9f4ff, 2.4)
key.position.set(-18, 32, 20)
scene.add(key)
const warm = new THREE.PointLight(0xffb94c, 42, 55, 2)
warm.position.set(12, 16, 2)
scene.add(warm)

const world = new THREE.Group()
world.position.set(-3.5, 0, -3)
scene.add(world)

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(54, 42),
  new THREE.MeshStandardMaterial({
    color: 0x080d18,
    roughness: 0.88,
    metalness: 0.18,
    transparent: true,
    opacity: 0.92,
  }),
)
floor.rotation.x = -Math.PI / 2
floor.position.set(3.5, -0.08, 3.5)
world.add(floor)

const grid = new THREE.GridHelper(54, 54, 0x274260, 0x111e30)
grid.position.set(3.5, 0, 3.5)
const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material]
for (const material of gridMaterials) {
  material.transparent = true
  material.opacity = 0.32
}
world.add(grid)

const categoryMap = new Map(categories.map((category) => [category.id, category]))
const runtimeById = new Map<string, SubsystemRuntime>()
const pickables: THREE.Object3D[] = []
const labelsRoot = document.querySelector<HTMLElement>('#labels')

const probeGeometry = new THREE.SphereGeometry(0.16, 12, 8)

function rgb(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

function createLabel(data: Subsystem): HTMLDivElement {
  const category = categoryMap.get(data.category)!
  const label = document.createElement('div')
  label.className = 'node-label'
  label.innerHTML = `<i style="--node:${rgb(category.color)}"></i><strong>${data.short}</strong><span>${data.probes.length}</span>`
  labelsRoot?.append(label)
  return label
}

function makeSubsystem(data: Subsystem): SubsystemRuntime {
  const category = categoryMap.get(data.category)!
  const geometry = new THREE.BoxGeometry(...data.size)
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(category.color).multiplyScalar(0.2),
    emissive: category.color,
    emissiveIntensity: 0.16,
    roughness: 0.38,
    metalness: 0.65,
    transparent: true,
    opacity: 0.93,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(...data.position)
  mesh.userData.pick = 'subsystem'
  mesh.userData.subsystemId = data.id
  world.add(mesh)
  pickables.push(mesh)

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({
      color: category.color,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    }),
  )
  edges.position.copy(mesh.position)
  world.add(edges)

  const halo = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(data.size[0], data.size[2]) * 0.68, Math.max(data.size[0], data.size[2]) * 0.75, 48),
    new THREE.MeshBasicMaterial({
      color: category.color,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  halo.rotation.x = -Math.PI / 2
  halo.position.set(data.position[0], 0.03, data.position[2])
  world.add(halo)

  const runtime: SubsystemRuntime = { data, mesh, edges, halo, label: createLabel(data), probes: [] }

  data.probes.forEach((probe, index) => {
    const angle = (index / data.probes.length) * Math.PI * 2 + data.position[0] * 0.07
    const radius = Math.max(data.size[0], data.size[2]) * 0.73 + 0.9
    const y = Math.max(1.2, data.position[1] + Math.sin(angle * 1.7) * 1.6)
    const position = new THREE.Vector3(
      data.position[0] + Math.cos(angle) * radius,
      y,
      data.position[2] + Math.sin(angle) * radius,
    )
    const probeMaterial = new THREE.MeshStandardMaterial({
      color: category.color,
      emissive: category.color,
      emissiveIntensity: 1.7,
      roughness: 0.25,
      metalness: 0.15,
      transparent: true,
      opacity: 0.95,
    })
    const probeMesh = new THREE.Mesh(probeGeometry, probeMaterial)
    probeMesh.position.copy(position)
    probeMesh.userData.pick = 'probe'
    probeMesh.userData.subsystemId = data.id
    probeMesh.userData.probeIndex = index
    world.add(probeMesh)
    pickables.push(probeMesh)

    const lineGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(data.position[0], data.position[1], data.position[2]),
      position,
    ])
    const line = new THREE.Line(
      lineGeometry,
      new THREE.LineBasicMaterial({
        color: category.color,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
      }),
    )
    world.add(line)

    runtime.probes.push({ mesh: probeMesh, line, data: probe })
  })

  runtimeById.set(data.id, runtime)
  return runtime
}

const runtimes = subsystems.map(makeSubsystem)

const flowCurves: THREE.CatmullRomCurve3[] = []
const flowMaterials: THREE.LineBasicMaterial[] = []

for (const [fromId, toId] of connections) {
  const from = runtimeById.get(fromId)!
  const to = runtimeById.get(toId)!
  const a = from.mesh.position.clone()
  const b = to.mesh.position.clone()
  const lift = Math.max(a.y, b.y) + 2.5 + a.distanceTo(b) * 0.08
  const curve = new THREE.CatmullRomCurve3([
    a,
    new THREE.Vector3(a.x, lift, a.z),
    new THREE.Vector3(b.x, lift, b.z),
    b,
  ])
  const material = new THREE.LineBasicMaterial({
    color: categoryMap.get(to.data.category)!.color,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
  })
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(34)), material)
  world.add(line)
  flowCurves.push(curve)
  flowMaterials.push(material)
}

const packetGeometry = new THREE.SphereGeometry(0.11, 8, 6)
const packets = flowCurves.map((_, index) => {
  const targetId = connections[index]![1]
  const color = categoryMap.get(runtimeById.get(targetId)!.data.category)!.color
  const packet = new THREE.Mesh(
    packetGeometry,
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.88 }),
  )
  world.add(packet)
  return packet
})

const starsGeometry = new THREE.BufferGeometry()
const starPositions = new Float32Array(420 * 3)
for (let i = 0; i < 420; i++) {
  starPositions[i * 3] = (Math.random() - 0.5) * 130
  starPositions[i * 3 + 1] = 8 + Math.random() * 48
  starPositions[i * 3 + 2] = (Math.random() - 0.5) * 130
}
starsGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
scene.add(
  new THREE.Points(
    starsGeometry,
    new THREE.PointsMaterial({ color: 0x8cb9ed, size: 0.09, transparent: true, opacity: 0.5 }),
  ),
)

const inspector = document.querySelector<HTMLElement>('#inspector')
const detailKind = document.querySelector<HTMLElement>('#detail-kind')
const detailTitle = document.querySelector<HTMLElement>('#detail-title')
const detailCopy = document.querySelector<HTMLElement>('#detail-copy')
const detailStats = document.querySelector<HTMLElement>('#detail-stats')
let selected: HitData | null = null
let hovered: HitData | null = null
let activeCategory: CategoryId | null = null
let query = ''

function hitData(object: THREE.Object3D): HitData | null {
  const subsystem = runtimeById.get(String(object.userData.subsystemId))
  if (!subsystem) return null
  if (object.userData.pick === 'probe') {
    const probe = subsystem.probes[Number(object.userData.probeIndex)]
    return probe ? { kind: 'probe', subsystem, probe } : null
  }
  return { kind: 'subsystem', subsystem }
}

function inspect(hit: HitData): void {
  selected = hit
  inspector?.classList.add('open')
  document.querySelector('.intro')?.classList.add('dismissed')
  if (detailKind) detailKind.textContent = hit.kind === 'probe' ? hit.probe!.data.kind.toUpperCase() : 'SUBSYSTEM'
  if (detailTitle) detailTitle.textContent = hit.kind === 'probe' ? hit.probe!.data.name : hit.subsystem.data.label
  if (detailCopy) detailCopy.textContent = hit.kind === 'probe' ? hit.probe!.data.note : hit.subsystem.data.description
  if (detailStats) {
    detailStats.replaceChildren()
    const stats = hit.kind === 'probe' ? [hit.probe!.data] : hit.subsystem.data.probes
    for (const stat of stats) {
      const row = document.createElement('button')
      row.type = 'button'
      row.innerHTML = `<span>${stat.kind}</span><strong>${stat.name}</strong><small>${stat.note}</small>`
      row.addEventListener('click', () => {
        const probe = hit.subsystem.probes.find((candidate) => candidate.data === stat)
        if (probe) inspect({ kind: 'probe', subsystem: hit.subsystem, probe })
      })
      detailStats.append(row)
    }
  }
  const target = hit.kind === 'probe' ? hit.probe!.mesh.position : hit.subsystem.mesh.position
  controls.target.lerp(target, 0.72)
  applyState()
}

function matches(runtime: SubsystemRuntime): boolean {
  const categoryMatch = !activeCategory || runtime.data.category === activeCategory
  if (!categoryMatch) return false
  if (!query) return true
  const haystack = [
    runtime.data.label,
    runtime.data.short,
    runtime.data.description,
    ...runtime.data.probes.flatMap((probe) => [probe.name, probe.kind, probe.note]),
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(query)
}

function applyState(): void {
  for (const runtime of runtimes) {
    const visible = matches(runtime)
    const chosen = selected?.subsystem === runtime
    const hot = hovered?.subsystem === runtime
    runtime.mesh.material.opacity = visible ? (chosen || hot ? 1 : 0.9) : 0.08
    runtime.mesh.material.emissiveIntensity = chosen ? 0.75 : hot ? 0.42 : visible ? 0.16 : 0.02
    runtime.edges.material.opacity = visible ? (chosen || hot ? 1 : 0.62) : 0.05
    runtime.halo.material.opacity = chosen ? 0.55 : hot ? 0.32 : visible ? 0.12 : 0.02
    runtime.label.classList.toggle('muted', !visible)
    runtime.label.classList.toggle('selected', chosen)
    runtime.probes.forEach((probe) => {
      const probeChosen = selected?.probe === probe
      probe.mesh.material.opacity = visible ? 0.95 : 0.06
      probe.mesh.scale.setScalar(probeChosen ? 2.1 : chosen || hot ? 1.35 : 1)
      probe.line.material.opacity = visible ? (chosen ? 0.6 : 0.16) : 0.015
    })
  }
  flowMaterials.forEach((material, index) => {
    const [fromId, toId] = connections[index]!
    const visible = matches(runtimeById.get(fromId)!) && matches(runtimeById.get(toId)!)
    material.opacity = visible ? 0.18 : 0.018
  })
}

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()

function pick(event: PointerEvent): HitData | null {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObjects(pickables, false)[0]
  return hit ? hitData(hit.object) : null
}

canvas.addEventListener('pointermove', (event) => {
  hovered = pick(event)
  canvas.style.cursor = hovered ? 'pointer' : 'grab'
  applyState()
})

canvas.addEventListener('click', (event) => {
  const hit = pick(event)
  if (hit) inspect(hit)
})

document.querySelector('#inspector-close')?.addEventListener('click', () => {
  selected = null
  inspector?.classList.remove('open')
  applyState()
})

document.querySelector('#start')?.addEventListener('click', () => {
  document.querySelector('.intro')?.classList.add('dismissed')
})

const search = document.querySelector<HTMLInputElement>('#search')
search?.addEventListener('input', () => {
  query = search.value.trim().toLowerCase()
  applyState()
})

window.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== search) {
    event.preventDefault()
    search?.focus()
  }
  if (event.key === 'Escape') {
    search?.blur()
    if (search) search.value = ''
    query = ''
    selected = null
    inspector?.classList.remove('open')
    applyState()
  }
})

const categoryRoot = document.querySelector<HTMLElement>('#categories')
for (const category of categories) {
  const button = document.createElement('button')
  button.type = 'button'
  button.style.setProperty('--category', rgb(category.color))
  button.innerHTML = `<i></i>${category.label}`
  button.addEventListener('click', () => {
    activeCategory = activeCategory === category.id ? null : category.id
    categoryRoot?.querySelectorAll('button').forEach((candidate) => candidate.classList.remove('active'))
    if (activeCategory) button.classList.add('active')
    applyState()
  })
  categoryRoot?.append(button)
}

interface CameraGoal {
  position: THREE.Vector3
  target: THREE.Vector3
}

let cameraGoal: CameraGoal | null = null

function setCamera(position: THREE.Vector3, target: THREE.Vector3): void {
  cameraGoal = { position, target }
}

const button3d = document.querySelector<HTMLButtonElement>('#view-3d')
const buttonTop = document.querySelector<HTMLButtonElement>('#view-top')

button3d?.addEventListener('click', () => {
  button3d.classList.add('active')
  buttonTop?.classList.remove('active')
  setCamera(new THREE.Vector3(35, 28, 42), new THREE.Vector3(4, 3, 3))
})

buttonTop?.addEventListener('click', () => {
  buttonTop.classList.add('active')
  button3d?.classList.remove('active')
  setCamera(new THREE.Vector3(4, 58, 3), new THREE.Vector3(4, 0, 3))
})

document.querySelector('#reset')?.addEventListener('click', () => {
  activeCategory = null
  query = ''
  selected = null
  hovered = null
  if (search) search.value = ''
  categoryRoot?.querySelectorAll('button').forEach((button) => button.classList.remove('active'))
  inspector?.classList.remove('open')
  setCamera(new THREE.Vector3(35, 28, 42), new THREE.Vector3(4, 3, 3))
  applyState()
})

const projected = new THREE.Vector3()

function updateLabels(): void {
  for (const runtime of runtimes) {
    projected.copy(runtime.mesh.position)
    projected.y += runtime.data.size[1] * 0.55 + 0.7
    world.localToWorld(projected)
    projected.project(camera)
    const visible = projected.z > -1 && projected.z < 1
    runtime.label.hidden = !visible
    if (!visible) continue
    runtime.label.style.transform = `translate3d(${(projected.x * 0.5 + 0.5) * innerWidth}px, ${(-projected.y * 0.5 + 0.5) * innerHeight}px, 0)`
  }
}

function resize(): void {
  const width = window.innerWidth
  const height = window.innerHeight
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  activeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, width < 700 ? 1.25 : 1.75))
  activeRenderer.setSize(width, height, false)
}
window.addEventListener('resize', resize, { passive: true })

const clock = new THREE.Clock()

function frame(): void {
  const elapsed = clock.getElapsedTime()
  controls.update()

  if (cameraGoal) {
    camera.position.lerp(cameraGoal.position, 0.055)
    controls.target.lerp(cameraGoal.target, 0.055)
    if (camera.position.distanceTo(cameraGoal.position) < 0.08 && controls.target.distanceTo(cameraGoal.target) < 0.08) {
      cameraGoal = null
    }
  }

  runtimes.forEach((runtime, runtimeIndex) => {
    runtime.probes.forEach((probe, probeIndex) => {
      const pulse = 1 + Math.sin(elapsed * 2.2 + runtimeIndex * 0.71 + probeIndex) * 0.14
      if (selected?.probe !== probe) probe.mesh.scale.setScalar(pulse * (selected?.subsystem === runtime ? 1.28 : 1))
    })
  })

  packets.forEach((packet, index) => {
    const speed = 0.035 + (index % 5) * 0.004
    const t = (elapsed * speed + index / packets.length) % 1
    packet.position.copy(flowCurves[index]!.getPointAt(t))
    const [fromId, toId] = connections[index]!
    packet.visible = matches(runtimeById.get(fromId)!) && matches(runtimeById.get(toId)!)
  })

  warm.intensity = 38 + Math.sin(elapsed * 0.8) * 5
  updateLabels()
  activeRenderer.render(scene, camera)
  requestAnimationFrame(frame)
}

applyState()
resize()
requestAnimationFrame(frame)
}
