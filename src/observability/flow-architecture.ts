import type { TraceStop } from '../core/types'

const SVG_NS = 'http://www.w3.org/2000/svg'

type SvgAttrs = Readonly<Record<string, string | number>>
type VisibleTraceStop = Exclude<TraceStop, 'blocked'>

export type ArchitectureStageStatus = 'pending' | 'current' | 'done' | 'skipped'

export interface ArchitectureStageElements {
  root: SVGGElement
  label: SVGTextElement
}

export interface FlowArchitecture {
  root: SVGSVGElement
  components: Map<string, SVGGElement>
  stages: Record<VisibleTraceStop, ArchitectureStageElements>
}

interface ComponentSpec {
  id: string
  label: string
  detail: readonly string[]
  x: number
  y: number
  width: number
  height: number
  tone: string
  compact?: boolean
}

interface TraceStageSpec {
  stop: VisibleTraceStop
  label: string
  path: string
  x: number
  y: number
  anchor?: 'start' | 'end'
}

const TRACE_STAGES: readonly TraceStageSpec[] = [
  { stop: 'connect', label: 'connect', path: 'M 210 62 V 112 M 210 156 V 180', x: 210, y: 84 },
  { stop: 'parse_plan', label: 'parse + plan', path: 'M 153 205 H 267', x: 76, y: 207 },
  { stop: 'fetch', label: 'buffer read', path: 'M 111 450 H 16 V 240 H 142', x: 16, y: 404 },
  { stop: 'work', label: 'execute', path: 'M 169 233 H 267 M 278 218 H 294', x: 306, y: 277 },
  { stop: 'wal', label: 'WAL record', path: 'M 278 240 H 406 V 491 H 396', x: 404, y: 404, anchor: 'end' },
  { stop: 'commit', label: 'fsync', path: 'M 396 491 H 406 V 706 H 331 V 797', x: 331, y: 750 },
  { stop: 'send', label: 'rows', path: 'M 194 180 V 156 H 194 V 62', x: 194, y: 84, anchor: 'end' },
  { stop: 'done', label: 'done', path: 'M 255 40 H 276', x: 289, y: 43 },
]

function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: SvgAttrs = {},
  ...children: (Node | string)[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) {
    node.setAttribute(name, String(value))
    if (name.startsWith('data-')) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
      node.dataset[key] = String(value)
    }
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

function svgText(
  x: number,
  y: number,
  value: string,
  className: string,
  attrs: SvgAttrs = {},
): SVGTextElement {
  return svgElement('text', { x, y, class: className, ...attrs }, value)
}

function component(spec: ComponentSpec): SVGGElement {
  const label = [spec.label, ...spec.detail].join('. ')
  const root = svgElement(
    'g',
    {
      class: `flow-architecture__component tone-${spec.tone}`,
      'data-component': spec.id,
      tabindex: '0',
      role: 'group',
      'aria-label': label,
    },
    svgElement('title', {}, label),
    svgElement('rect', {
      x: spec.x,
      y: spec.y,
      width: spec.width,
      height: spec.height,
      rx: 3,
    }),
    svgText(
      spec.x + 10,
      spec.y + (spec.compact ? 18 : 22),
      spec.label,
      'flow-architecture__component-title',
    ),
  )
  for (let i = 0; i < spec.detail.length; i++) {
    root.append(
      svgText(
        spec.x + 10,
        spec.y + (spec.compact ? 32 : 41) + i * 13,
        spec.detail[i],
        'flow-architecture__component-detail',
      ),
    )
  }
  return root
}

function boundary(
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  className: string,
): [SVGRectElement, SVGTextElement] {
  return [
    svgElement('rect', {
      x,
      y,
      width,
      height,
      rx: 5,
      class: `flow-architecture__boundary ${className}`,
    }),
    svgText(x + 12, y + 20, label, 'flow-architecture__layer-label'),
  ]
}

function marker(
  id: string,
  className: string,
): SVGMarkerElement {
  return svgElement(
    'marker',
    {
      id,
      viewBox: '0 0 8 8',
      refX: 7,
      refY: 4,
      markerWidth: 7,
      markerHeight: 7,
      orient: 'auto',
      markerUnits: 'strokeWidth',
    },
    svgElement('path', {
      d: 'M 0 0 L 8 4 L 0 8 z',
      class: className,
    }),
  )
}

function connection(
  prefix: string,
  relation: 'connection' | 'fork' | 'read' | 'wal-write' | 'flush' | 'background' | 'return',
  path: string,
  markerName: 'control' | 'read' | 'wal' | 'background' | 'return',
): SVGPathElement {
  return svgElement('path', {
    d: path,
    class: `flow-architecture__connection relation-${relation}`,
    'data-relation': relation,
    'marker-end': `url(#${prefix}-arrow-${markerName})`,
  })
}

function register(
  components: Map<string, SVGGElement>,
  parent: SVGElement,
  spec: ComponentSpec,
): SVGGElement {
  const node = component(spec)
  components.set(spec.id, node)
  parent.append(node)
  return node
}

/**
 * Fixed PostgreSQL architecture, deliberately hand-placed. The diagram is a
 * stable map; trace state only changes the overlay and component emphasis.
 */
export function createFlowArchitecture(prefix: string): FlowArchitecture {
  const titleId = `${prefix}-architecture-title`
  const descriptionId = `${prefix}-architecture-description`
  const root = svgElement(
    'svg',
    {
      class: 'flow-architecture',
      viewBox: '0 0 420 912',
      role: 'group',
      'aria-labelledby': `${titleId} ${descriptionId}`,
      preserveAspectRatio: 'xMidYMin meet',
    },
    svgElement('title', { id: titleId }, 'PostgreSQL process, memory, kernel, and disk architecture'),
    svgElement(
      'desc',
      { id: descriptionId },
      'Client and PostgreSQL processes above one shared memory segment, then the operating system page cache and durable stores. Focus each component or numbered trace stage for detail.',
    ),
  )
  const components = new Map<string, SVGGElement>()

  const defs = svgElement(
    'defs',
    {},
    marker(`${prefix}-arrow-control`, 'arrow-control'),
    marker(`${prefix}-arrow-read`, 'arrow-read'),
    marker(`${prefix}-arrow-wal`, 'arrow-wal'),
    marker(`${prefix}-arrow-background`, 'arrow-background'),
    marker(`${prefix}-arrow-return`, 'arrow-return'),
  )
  root.append(defs)

  const connections = svgElement(
    'g',
    { class: 'flow-architecture__connections', 'aria-hidden': 'true' },
    connection(prefix, 'connection', 'M 210 62 V 112', 'control'),
    connection(prefix, 'fork', 'M 210 156 V 180', 'control'),
    connection(prefix, 'return', 'M 194 180 V 156 H 194 V 62', 'return'),
    connection(prefix, 'read', 'M 111 450 H 16 V 240 H 142', 'read'),
    connection(prefix, 'read', 'M 94 797 V 706 H 111 V 532', 'read'),
    connection(prefix, 'wal-write', 'M 278 240 H 406 V 491 H 396', 'wal'),
    connection(prefix, 'flush', 'M 396 491 H 406 V 706 H 331 V 797', 'wal'),
    connection(prefix, 'background', 'M 77 336 V 420 H 83 V 450', 'background'),
    connection(prefix, 'background', 'M 198 336 V 339 H 238 V 428 H 142 V 450', 'background'),
    connection(prefix, 'background', 'M 160 384 V 436 H 164 V 450', 'background'),
    connection(prefix, 'background', 'M 330 336 V 339 H 404 V 428 H 306 V 450', 'background'),
    connection(prefix, 'background', 'M 390 363 H 404 V 746 H 331 V 797', 'background'),
    connection(prefix, 'background', 'M 400 218 H 408 V 746 H 216 V 797', 'background'),
    svgText(219, 173, 'fork backend', 'flow-architecture__relation-label'),
  )
  root.append(connections)

  const clientLayer = svgElement('g', { 'data-layer': 'client' })
  register(components, clientLayer, {
    id: 'client',
    label: 'CLIENT',
    detail: ['query ⇄ rows'],
    x: 165,
    y: 18,
    width: 90,
    height: 44,
    tone: 'client',
    compact: true,
  })
  root.append(clientLayer)

  const processLayer = svgElement(
    'g',
    { 'data-layer': 'processes' },
    ...boundary(8, 88, 404, 310, 'POSTGRESQL PROCESSES · separate address spaces', 'process-boundary'),
  )
  register(components, processLayer, {
    id: 'postmaster',
    label: 'POSTMASTER',
    detail: ['accepts connections'],
    x: 145,
    y: 112,
    width: 130,
    height: 44,
    tone: 'backend',
    compact: true,
  })
  register(components, processLayer, {
    id: 'backend',
    label: 'BACKEND',
    detail: ['parser · planner', 'executor'],
    x: 142,
    y: 180,
    width: 136,
    height: 78,
    tone: 'backend',
  })
  register(components, processLayer, {
    id: 'private-memory',
    label: 'PRIVATE MEMORY',
    detail: ['per backend', 'work_mem'],
    x: 294,
    y: 180,
    width: 106,
    height: 78,
    tone: 'private',
  })
  processLayer.append(
    svgText(20, 282, 'BACKGROUND PROCESSES · placed beside what they act on', 'flow-architecture__process-label'),
  )
  register(components, processLayer, {
    id: 'checkpointer',
    label: 'checkpointer',
    detail: ['checkpoint I/O'],
    x: 18,
    y: 294,
    width: 118,
    height: 42,
    tone: 'checkpoint',
    compact: true,
  })
  register(components, processLayer, {
    id: 'bgwriter',
    label: 'bgwriter',
    detail: ['dirty pages'],
    x: 143,
    y: 294,
    width: 110,
    height: 42,
    tone: 'bgwriter',
    compact: true,
  })
  register(components, processLayer, {
    id: 'autovacuum',
    label: 'autovacuum',
    detail: ['table pages'],
    x: 90,
    y: 342,
    width: 140,
    height: 42,
    tone: 'vacuum',
    compact: true,
  })
  register(components, processLayer, {
    id: 'wal-writer',
    label: 'WAL writer',
    detail: ['WAL flush'],
    x: 260,
    y: 294,
    width: 140,
    height: 42,
    tone: 'wal',
    compact: true,
  })
  register(components, processLayer, {
    id: 'walsender',
    label: 'walsender',
    detail: ['replication'],
    x: 250,
    y: 342,
    width: 140,
    height: 42,
    tone: 'replication',
    compact: true,
  })
  root.append(processLayer)

  const sharedLayer = svgElement(
    'g',
    {
      'data-layer': 'shared-memory',
      'data-component': 'shared-memory',
      class: 'flow-architecture__container tone-shmem',
      tabindex: '0',
      role: 'group',
      'aria-label': 'One shared memory segment containing the buffer pool, WAL buffers, ProcArray, lock table, and pg_xact transaction status cache',
    },
    svgElement('title', {}, 'One shared memory segment, attached to by every PostgreSQL process'),
    ...boundary(8, 414, 404, 238, 'ONE SHARED MEMORY SEGMENT · attached by every process', 'shared-boundary'),
  )
  components.set('shared-memory', sharedLayer)
  register(components, sharedLayer, {
    id: 'buffer-pool',
    label: 'BUFFER POOL',
    detail: ['shared_buffers', 'data pages'],
    x: 24,
    y: 450,
    width: 174,
    height: 82,
    tone: 'buffer',
  })
  register(components, sharedLayer, {
    id: 'wal-buffers',
    label: 'WAL BUFFERS',
    detail: ['shared WAL records', 'before flush'],
    x: 216,
    y: 450,
    width: 180,
    height: 82,
    tone: 'wal',
  })
  register(components, sharedLayer, {
    id: 'proc-array',
    label: 'PROCARRAY',
    detail: ['active xids'],
    x: 24,
    y: 550,
    width: 108,
    height: 72,
    tone: 'shmem',
  })
  register(components, sharedLayer, {
    id: 'lock-table',
    label: 'LOCK TABLE',
    detail: ['shared locks'],
    x: 142,
    y: 550,
    width: 118,
    height: 72,
    tone: 'lock',
  })
  register(components, sharedLayer, {
    id: 'pg-xact-cache',
    label: 'pg_xact CACHE',
    detail: ['SLRU buffers', 'commit status'],
    x: 270,
    y: 550,
    width: 126,
    height: 72,
    tone: 'shmem',
  })
  root.append(sharedLayer)

  const kernelLayer = svgElement('g', { 'data-layer': 'kernel' })
  register(components, kernelLayer, {
    id: 'kernel-page-cache',
    label: 'KERNEL PAGE CACHE',
    detail: ['operating system controlled · PostgreSQL cannot size or evict it'],
    x: 8,
    y: 672,
    width: 404,
    height: 68,
    tone: 'kernel',
  })
  root.append(kernelLayer)

  const diskLayer = svgElement(
    'g',
    {
      'data-layer': 'disk',
      'data-component': 'disk',
      class: 'flow-architecture__container tone-storage',
      tabindex: '0',
      role: 'group',
      'aria-label': 'Durable storage containing separate base and pg_wal stores, plus backend temporary files',
    },
    svgElement('title', {}, 'Durable storage below the operating system page cache'),
    ...boundary(8, 760, 404, 136, 'DISK · data directory and temporary files', 'disk-boundary'),
  )
  components.set('disk', diskLayer)
  register(components, diskLayer, {
    id: 'base-store',
    label: 'base/',
    detail: ['heap + indexes'],
    x: 22,
    y: 797,
    width: 145,
    height: 70,
    tone: 'storage',
  })
  register(components, diskLayer, {
    id: 'temp-files',
    label: 'TEMP FILES',
    detail: ['work_mem spills'],
    x: 177,
    y: 797,
    width: 78,
    height: 70,
    tone: 'private',
  })
  register(components, diskLayer, {
    id: 'pg-wal-store',
    label: 'pg_wal/',
    detail: ['durable WAL'],
    x: 265,
    y: 797,
    width: 133,
    height: 70,
    tone: 'wal',
  })
  root.append(diskLayer)

  const stageRecord = {} as Record<VisibleTraceStop, ArchitectureStageElements>
  const traceLayer = svgElement(
    'g',
    { class: 'flow-architecture__trace', role: 'list', 'aria-label': 'Animated query trace' },
  )
  for (let index = 0; index < TRACE_STAGES.length; index++) {
    const stage = TRACE_STAGES[index]
    const label = svgText(
      stage.x + (stage.anchor === 'end' ? -9 : 9),
      stage.y + 3,
      `${index + 1} ${stage.label}`,
      'flow-trace-stage__label',
      stage.anchor === 'end' ? { 'text-anchor': 'end' } : {},
    )
    const stageRoot = svgElement(
      'g',
      {
        class: 'flow-trace-stage is-pending',
        'data-stop': stage.stop,
        tabindex: '0',
        role: 'listitem',
        'aria-label': `Step ${index + 1}, ${stage.label}, waiting`,
      },
      svgElement('path', { d: stage.path, class: 'flow-trace-stage__path' }),
      svgElement('circle', {
        cx: stage.x,
        cy: stage.y,
        r: 5,
        class: 'flow-trace-stage__dot',
      }),
      label,
    )
    stageRecord[stage.stop] = { root: stageRoot, label }
    traceLayer.append(stageRoot)
  }
  root.append(traceLayer)

  return {
    root,
    components,
    stages: stageRecord,
  }
}
