import * as THREE from 'three'
import { COLOR } from '../core/theme'
import { clamp01, damp, fmtNum } from '../core/util'
import { ANCHOR } from './layout'
import type { PlanNode, SimState, WorldContext, WorldFactory, WorldModule } from '../core/types'

/* ============================================================================
 * THE QUERY LAB
 *
 * Floats above the backend row and stays dark until you select a backend. Then
 * it unfolds that backend's statement: parse -> rewrite -> plan -> execute,
 * with the winning plan drawn as a real tree.
 *
 * The tree is drawn root-at-top because that is how EXPLAIN prints it, but the
 * *rows* travel upward from the leaves, because that is how the executor
 * actually works: each node pulls tuples from its children.
 * ==========================================================================*/

const LAB = ANCHOR.planner // [0, 66, -130]

const STAGES = [
  { id: 'planner.parser', name: 'Parser', role: 'text → parse tree', color: COLOR.client },
  { id: 'planner.rewriter', name: 'Rewriter', role: 'views and rules expand', color: COLOR.shmem },
  { id: 'planner.planner', name: 'Planner', role: 'cost the candidates, pick one', color: COLOR.index },
  { id: 'planner.executor', name: 'Executor', role: 'pull tuples through the tree', color: COLOR.backend },
] as const

/** Which stage lights for a given backend state. -1 = none. */
function stageForState(state: string): number {
  switch (state) {
    case 'parse':
      return 0
    case 'plan':
      return 2
    case 'exec_cpu':
    case 'exec_io':
    case 'sort':
    case 'sending':
      return 3
    default:
      return -1
  }
}

const STAGE_X = [-36, -12, 12, 36]
const STAGE_Y = 16 // above the lab origin
const ROOT_Y = 6
const LEVEL_DY = 8.5
const NODE_W = 15
const NODE_H = 1.1
const NODE_D = 5
const MAX_NODES = 48

interface Laid {
  node: PlanNode
  x: number
  y: number
  depth: number
  parent: number
}

/* scratch — hoisted, update() allocates nothing */
const _v = new THREE.Vector3()
const _c = new THREE.Color()
const _m = new THREE.Matrix4()

export const createPlanner: WorldFactory = (ctx: WorldContext): WorldModule => {
  const { theme, bus } = ctx
  const group = new THREE.Group()
  group.name = 'planner'
  group.position.set(LAB[0], LAB[1], LAB[2])
  group.visible = false

  const matFrame = theme.mat('lab.frame', { color: 0x1a2740, roughness: 0.5, metalness: 0.35 })
  const matSlab = theme.mat('lab.slab', { color: 0x16203a, roughness: 0.55, metalness: 0.3 })

  /* --- the containing volume ---------------------------------------------- */

  const shellGeo = new THREE.BoxGeometry(104, 46, 26)
  const shell = new THREE.Mesh(
    shellGeo,
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(COLOR.shmem).multiplyScalar(0.12),
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
      side: THREE.BackSide,
      toneMapped: false,
    }),
  )
  shell.position.y = 2
  shell.renderOrder = -1
  group.add(shell, theme.edges(shellGeo, COLOR.shmem, 0.3).translateY(2))

  /* --- text helper --------------------------------------------------------- */

  const textMats = new Map<string, THREE.MeshBasicMaterial>()
  function textPlane(text: string, size: number, color: string, width: number): THREE.Mesh {
    const key = `${text}|${size}|${color}`
    let mat = textMats.get(key)
    if (!mat) {
      const tex = theme.textTexture(text, { size: 56, color })
      mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false })
      textMats.set(key, mat)
    }
    const tex = mat.map!
    const aspect = tex.image ? (tex.image as HTMLCanvasElement).width / (tex.image as HTMLCanvasElement).height : 4
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, width / aspect), mat)
    mesh.raycast = () => {}
    mesh.renderOrder = 3
    return mesh
  }

  /* --- the four stage pods -------------------------------------------------- */

  const podLights: THREE.Mesh[] = []
  const podGeo = theme.box(18, 1.4, 9)
  const beamGeo = theme.box(17, 0.35, 8)

  STAGES.forEach((s, i) => {
    const pod = new THREE.Group()
    pod.position.set(STAGE_X[i], STAGE_Y, 0)

    const base = new THREE.Mesh(podGeo, matFrame)
    const lamp = new THREE.Mesh(beamGeo, theme.neon(s.color, 0.35))
    lamp.position.y = 1.0
    podLights.push(lamp)

    const label = textPlane(s.name.toUpperCase(), 56, '#dbe7ff', 11)
    label.position.set(0, 4.2, 0)

    pod.add(base, lamp, label, theme.edges(podGeo, s.color, 0.35))
    group.add(pod)

    ctx.register({
      id: s.id,
      name: s.name,
      role: s.role,
      kind: 'concept',
      district: 'planner',
      object: pod,
      tier: 2,
      color: s.color,
      focus: { target: [LAB[0] + STAGE_X[i], LAB[1] + STAGE_Y, LAB[2]], distance: 46, dir: [0.2, 0.45, 1] },
    })
  })

  // the connecting rail between stages — a statement moves left to right along it
  const railGeo = theme.box(78, 0.25, 0.25)
  const rail = new THREE.Mesh(railGeo, theme.neon(COLOR.inkDim, 0.5))
  rail.position.set(0, STAGE_Y - 1.4, 0)
  group.add(rail)

  /* --- the plan tree -------------------------------------------------------- */

  const treeGroup = new THREE.Group()
  group.add(treeGroup)

  const nodeGeo = theme.box(NODE_W, NODE_H, NODE_D)
  const nodes = new THREE.InstancedMesh(nodeGeo, matSlab, MAX_NODES)
  nodes.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  nodes.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES * 3).fill(0.2), 3)
  nodes.instanceColor.setUsage(THREE.DynamicDrawUsage)
  nodes.count = 0
  nodes.frustumCulled = false
  treeGroup.add(nodes)

  // struts between a node and its parent
  const strutPos = new Float32Array(MAX_NODES * 2 * 3)
  const strutGeo = new THREE.BufferGeometry()
  strutGeo.setAttribute('position', new THREE.BufferAttribute(strutPos, 3))
  const struts = new THREE.LineSegments(strutGeo, theme.line(COLOR.index, 0.5))
  struts.frustumCulled = false
  struts.raycast = () => {}
  treeGroup.add(struts)

  // one label group per node, rebuilt only when the plan changes
  const labelHolder = new THREE.Group()
  treeGroup.add(labelHolder)

  let laid: Laid[] = []
  let laidKey = ''

  /** Tidy-tree layout: leaves get consecutive slots, parents centre over children. */
  function layout(root: PlanNode): Laid[] {
    const out: Laid[] = []
    let cursor = 0

    function walk(n: PlanNode, depth: number, parent: number): number {
      const self = out.length
      out.push({ node: n, x: 0, y: ROOT_Y - depth * LEVEL_DY, depth, parent })
      if (out.length > MAX_NODES) return 0
      if (!n.children || n.children.length === 0) {
        out[self].x = cursor
        cursor += 1
        return out[self].x
      }
      let sum = 0
      let count = 0
      for (const c of n.children) {
        if (out.length >= MAX_NODES) break
        sum += walk(c, depth + 1, self)
        count++
      }
      out[self].x = count ? sum / count : cursor++
      return out[self].x
    }

    walk(root, 0, -1)

    // centre and spread to fill the lab
    let min = Infinity
    let max = -Infinity
    for (const l of out) {
      if (l.x < min) min = l.x
      if (l.x > max) max = l.x
    }
    const span = Math.max(1, max - min)
    const pitch = Math.min(19, 88 / span)
    for (const l of out) l.x = (l.x - (min + max) / 2) * pitch

    return out
  }

  /** A cheap identity for a plan tree — rebuild only when this changes. */
  function planKey(n: PlanNode | null): string {
    if (!n) return ''
    let s = n.label
    if (n.children) for (const c of n.children) s += '(' + planKey(c) + ')'
    return s
  }

  function rebuild(plan: PlanNode | null): void {
    labelHolder.clear()
    if (!plan) {
      laid = []
      nodes.count = 0
      strutGeo.setDrawRange(0, 0)
      return
    }
    laid = layout(plan)
    nodes.count = laid.length

    let sv = 0
    for (let i = 0; i < laid.length; i++) {
      const l = laid[i]
      _m.makeTranslation(l.x, l.y, 0)
      nodes.setMatrixAt(i, _m)

      if (l.parent >= 0) {
        const p = laid[l.parent]
        strutPos[sv++] = l.x
        strutPos[sv++] = l.y + NODE_H
        strutPos[sv++] = 0
        strutPos[sv++] = p.x
        strutPos[sv++] = p.y - NODE_H
        strutPos[sv++] = 0
      }

      // node label + row estimate, sized to the slab
      const title = textPlane(l.node.label, 56, '#e8f1ff', NODE_W * 0.82)
      title.position.set(l.x, l.y + 1.9, NODE_D * 0.1)
      labelHolder.add(title)

      const sub = textPlane(`${fmtNum(l.node.rows)} rows · cost ${l.node.cost.toFixed(0)}`, 44, '#8fa5c4', NODE_W * 0.62)
      sub.position.set(l.x, l.y - 1.7, NODE_D * 0.1)
      labelHolder.add(sub)
    }

    nodes.instanceMatrix.needsUpdate = true
    strutGeo.setDrawRange(0, sv / 3)
    strutGeo.attributes.position.needsUpdate = true
    strutGeo.computeBoundingSphere()
  }

  /* --- headline: which backend, and what is it running --------------------- */

  let headline: THREE.Mesh | null = null
  let headlineText = ''
  const headHolder = new THREE.Group()
  headHolder.position.set(0, STAGE_Y + 8.5, 0)
  group.add(headHolder)

  function setHeadline(text: string): void {
    if (text === headlineText) return
    headlineText = text
    headHolder.clear()
    if (!text) {
      headline = null
      return
    }
    headline = textPlane(text, 56, '#5ad1ff', Math.min(96, text.length * 1.35))
    headHolder.add(headline)
  }

  /* --- registration --------------------------------------------------------- */

  ctx.register({
    id: 'planner.lab',
    name: 'Query lab',
    role: 'the life of one statement',
    kind: 'concept',
    district: 'planner',
    object: shell,
    tier: 1,
    color: COLOR.shmem,
    focus: { target: [LAB[0], LAB[1] + 4, LAB[2]], distance: 120, dir: [0.1, 0.35, 1] },
    readout: (s) => (selected < 0 ? 'select a backend' : (s.backends[selected]?.sql ?? '').slice(0, 44)),
  })

  ctx.register({
    id: 'planner.plantree',
    name: 'Plan tree',
    role: 'estimated rows vs what actually happens',
    kind: 'concept',
    district: 'planner',
    object: treeGroup,
    tier: 2,
    color: COLOR.index,
    focus: { target: [LAB[0], LAB[1] - 8, LAB[2]], distance: 78, dir: [0.05, 0.3, 1] },
    readout: (s) => (laid.length ? `${laid.length} nodes` : 'idle'),
  })

  /* --- selection ------------------------------------------------------------ */

  let selected = -1
  let opacity = 0

  const offSelect = bus.on('select', ({ id }) => {
    const m = id && /^backend\.(\d+)$/.exec(id)
    selected = m ? Number(m[1]) : id && id.startsWith('planner.') ? selected : -1
  })

  /* --- update ---------------------------------------------------------------- */

  let podPulse = 0

  function update(dt: number, sim: SimState, t: number): void {
    const want = selected >= 0 ? 1 : 0
    opacity = damp(opacity, want, 6, dt)
    const visible = opacity > 0.01
    if (group.visible !== visible) group.visible = visible
    if (!visible) return

    group.scale.setScalar(0.94 + 0.06 * opacity)

    const b = selected >= 0 ? sim.backends[selected] : undefined
    if (!b || !b.active) {
      setHeadline('')
      if (laidKey !== '') {
        laidKey = ''
        rebuild(null)
      }
      return
    }

    setHeadline(b.sql ? b.sql.slice(0, 66) : `backend ${selected}`)

    // stage pods light for the phase this backend is in
    const active = stageForState(b.state)
    podPulse += dt
    for (let i = 0; i < podLights.length; i++) {
      const on = i === active ? 1 : i < active ? 0.35 : 0.08
      const mat = podLights[i].material as THREE.MeshBasicMaterial
      _c.setHex(STAGES[i].color)
      const k = on * (i === active ? 1.4 + Math.sin(podPulse * 6) * 0.25 : 1)
      mat.color.lerp(_c.multiplyScalar(k), clamp01(dt * 8))
      podLights[i].scale.y = 1 + on * 0.6
    }
    rail.scale.x = 0.6 + 0.4 * clamp01(active / 3)

    // rebuild the tree only when the plan's shape actually changed
    const key = planKey(b.plan)
    if (key !== laidKey) {
      laidKey = key
      rebuild(b.plan)
    }

    // node colour tracks activity: children light before their parents, because
    // that is the direction tuples travel
    if (laid.length && nodes.instanceColor) {
      const arr = nodes.instanceColor.array as Float32Array
      for (let i = 0; i < laid.length; i++) {
        const a = clamp01(laid[i].node.activity)
        _c.setHex(a > 0.05 ? COLOR.index : 0x2a3550)
        _c.multiplyScalar(0.22 + a * 1.9)
        arr[i * 3] = _c.r
        arr[i * 3 + 1] = _c.g
        arr[i * 3 + 2] = _c.b
      }
      nodes.instanceColor.needsUpdate = true
    }

    // labels billboard toward the viewer so the tree is readable from anywhere
    const q = ctx.camera.quaternion
    for (let i = 0; i < labelHolder.children.length; i++) labelHolder.children[i].quaternion.copy(q)
    if (headline) headline.quaternion.copy(q)
    void t
    void _v
  }

  function setDetail(level: 0 | 1 | 2): void {
    labelHolder.visible = level >= 1
  }

  function dispose(): void {
    offSelect()
    shellGeo.dispose()
    strutGeo.dispose()
    nodes.dispose()
    for (const m of textMats.values()) m.dispose()
    textMats.clear()
  }

  return { id: 'planner', group, update, setDetail, dispose }
}
