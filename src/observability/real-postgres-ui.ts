import type {
  QueryKind,
  SimApi,
  TraceRecord,
  TraceStop,
} from '../core/types'
import { traceStopBit } from '../core/model-helpers'
import { el, setText } from '../ui/uikit'
import {
  cityRelationForPlan,
  loadRealPostgres,
} from './real-postgres'
import type {
  CityModelTarget,
  DataSource,
  RealPlanNode,
  RealPostgresSource,
  RealQueryReport,
  RealResultSet,
} from './real-postgres'

const MODEL_PATH: readonly {
  stop: Exclude<TraceStop, 'blocked'>
  short: string
  writeOnly?: boolean
}[] = [
  { stop: 'connect', short: 'connect' },
  { stop: 'parse_plan', short: 'parse / plan' },
  { stop: 'fetch', short: 'buffers / storage' },
  { stop: 'work', short: 'execute' },
  { stop: 'wal', short: 'WAL insert', writeOnly: true },
  { stop: 'commit', short: 'fsync / commit', writeOnly: true },
  { stop: 'send', short: 'rows out' },
  { stop: 'done', short: 'complete' },
]

const DOWNLOAD_LABEL = 'about 5.3 MiB compressed / 16.5 MiB uncompressed'
const LOAD_TIMEOUT_MS = 30_000
const DEFAULT_SQL = 'SELECT id, balance FROM accounts WHERE id = 42;'

export interface RealPostgresConsole {
  root: HTMLElement
  update(): void
  dispose(): void
}

export interface RealPostgresConsoleOptions {
  beforeModelTrace?(): void
  load?: () => Promise<RealPostgresSource>
}

const isWrite = (kind: QueryKind): boolean =>
  kind === 'insert' || kind === 'update' || kind === 'delete'

function sourceBadge(source: DataSource, text: string): HTMLElement {
  return el('span', {
    class: `pg-source source-${source}`,
    text,
  })
}

function formatValue(value: unknown): string {
  if (value === null) return 'null'
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function resultSetView(result: RealResultSet, index: number): HTMLElement {
  if (result.fields.length === 0) {
    const affected = result.affectedRows ?? 0
    return el(
      'section',
      { class: 'pg-result source-postgres' },
      sourceBadge('postgres', 'POSTGRES · REAL RESULT'),
      el('p', {
        class: 'pg-command-tag',
        text: `${affected} row${affected === 1 ? '' : 's'} affected`,
      }),
    )
  }

  const visible = result.rows.slice(0, 100)
  const table = el(
    'table',
    { class: 'pg-result-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        ...result.fields.map((field) => el('th', { text: field.name })),
      ),
    ),
    el(
      'tbody',
      {},
      ...visible.map((row) =>
        el(
          'tr',
          {},
          ...result.fields.map((field) =>
            el('td', {
              class: row[field.name] === null ? 'is-null' : '',
              text: formatValue(row[field.name]),
            }),
          ),
        ),
      ),
    ),
  )
  return el(
    'section',
    { class: 'pg-result source-postgres' },
    sourceBadge('postgres', `POSTGRES · REAL RESULT ${index + 1}`),
    el('div', { class: 'pg-result-scroll' }, table),
    el('p', {
      class: 'pg-result-count',
      text:
        result.rows.length > visible.length
          ? `${visible.length} of ${result.rows.length} PostgreSQL rows shown`
          : `${result.rows.length} PostgreSQL row${result.rows.length === 1 ? '' : 's'}`,
    }),
  )
}

function realPlanTree(node: RealPlanNode): HTMLElement {
  const relation = [node.relationName, node.indexName].filter(Boolean).join(' · ')
  const item = el(
    'li',
    { class: 'pg-plan-node' },
    el(
      'div',
      { class: 'pg-plan-node__head' },
      el('strong', { text: node.nodeType }),
      relation ? el('code', { text: relation }) : null,
    ),
    el(
      'div',
      { class: 'pg-plan-node__numbers' },
      el('span', { text: `est ${node.planRows}` }),
      el('span', { text: `actual ${node.actualRows} × ${node.actualLoops}` }),
      el('span', { text: `cost ${node.startupCost.toFixed(2)}..${node.totalCost.toFixed(2)}` }),
      el('span', { text: `${node.actualTotalTimeMs.toFixed(3)} ms` }),
      el('span', { text: `hit ${node.sharedHits} · read ${node.sharedReads}` }),
    ),
  )
  if (node.children.length > 0) {
    item.append(
      el(
        'ul',
        {},
        ...node.children.map((child) => realPlanTree(child).firstElementChild as HTMLElement),
      ),
    )
  }
  return el('ul', { class: 'pg-plan-tree' }, item)
}

function modelRouteLabel(target: CityModelTarget): string {
  const kind: Record<QueryKind, string> = {
    select_idx: 'point/index read',
    select_seq: 'sequential read',
    aggregate: 'aggregate',
    insert: 'insert',
    update: 'update',
    delete: 'delete',
  }
  return `${kind[target.kind]} on ${target.relation}`
}

function reportView(report: RealQueryReport): HTMLElement {
  if (report.error) {
    const error = report.error
    return el(
      'section',
      { class: 'pg-error source-postgres' },
      sourceBadge('postgres', 'POSTGRES · REAL ERROR'),
      el('strong', { text: `${error.severity} [${error.code}]` }),
      el('pre', { text: error.message }),
      error.detail ? el('p', { text: `DETAIL: ${error.detail}` }) : null,
      error.hint ? el('p', { text: `HINT: ${error.hint}` }) : null,
      error.position ? el('p', { text: `POSITION: ${error.position}` }) : null,
    )
  }

  return el(
    'div',
    { class: 'pg-results' },
    ...report.results.map(resultSetView),
  )
}

/**
 * The terminal owns presentation only. Plans, counters, results and errors
 * enter as plain data from real-postgres.ts.
 */
export function createRealPostgresConsole(
  sim: SimApi,
  options: RealPostgresConsoleOptions = {},
): RealPostgresConsole {
  const load = options.load ?? loadRealPostgres
  let source: RealPostgresSource | null = null
  let disposed = false
  let loading = false
  let running = false
  let historyIndex = 0
  const history: string[] = []
  let modelTarget: CityModelTarget | null = null
  let modelTable = -1

  const modeBadge = sourceBadge('model', 'MODEL MODE · ACTIVE')
  const modeText = el('p', {
    class: 'pg-mode__text',
    text: 'The six-statement model is active. Real PostgreSQL is not downloaded.',
  })
  const loadButton = el('button', {
    class: 'pg-load',
    type: 'button',
    text: `Load real PostgreSQL · ${DOWNLOAD_LABEL}`,
  })
  const loadProgress = el('div', {
    class: 'pg-load-progress',
    role: 'status',
    'aria-live': 'polite',
  })

  const transcript = el('div', {
    class: 'pg-transcript',
    'aria-live': 'polite',
    'aria-label': 'PostgreSQL query history',
  })
  const prompt = el('label', { class: 'pg-prompt' })
  const promptText = el('span', { class: 'pg-prompt__mark', text: 'pgsimcity=>' })
  const input = el('textarea', {
    class: 'pg-input',
    rows: 2,
    spellcheck: false,
    value: DEFAULT_SQL,
    'aria-label': 'SQL statement',
  })
  const runButton = el('button', {
    class: 'pg-run',
    type: 'button',
    text: 'Run',
  })
  prompt.append(promptText, input, runButton)

  const terminal = el(
    'section',
    { class: 'pg-terminal', hidden: true, 'aria-label': 'Real PostgreSQL prompt' },
    el(
      'header',
      { class: 'pg-terminal__head' },
      el('strong', { text: 'PGlite / PostgreSQL' }),
      el('span', { class: 'pg-server-version' }),
    ),
    transcript,
    prompt,
    el('p', {
      class: 'pg-terminal__hint',
      text: 'Ctrl/⌘ + Enter runs · ↑/↓ recalls prompt history · query pg_catalog directly',
    }),
  )
  const version = terminal.querySelector<HTMLElement>('.pg-server-version')!

  const realHits = el('strong', { text: '—' })
  const realReads = el('strong', { text: '—' })
  const realRows = el('strong', { text: '—' })
  const realTime = el('strong', { text: '—' })
  const realPlan = el('div', {
    class: 'pg-plan-empty',
    text: 'Run a plannable statement to see PostgreSQL’s plan.',
  })
  const modelHits = el('strong', { text: '—' })
  const modelReads = el('strong', { text: '—' })
  const modelRows = el('strong', { text: '—' })
  const modelTime = el('strong', { text: '—' })
  const modelState = el('p', {
    class: 'pg-model-state',
    text: 'The model route starts after PostgreSQL returns a plan.',
  })
  const modelStops = MODEL_PATH.map((segment) =>
    el('li', {
      class: 'pg-model-stop is-pending',
      text: segment.short,
      data: { stop: segment.stop },
    }),
  )

  const metric = (label: string, value: HTMLElement) =>
    el('div', { class: 'pg-fact' }, el('span', { text: label }), value)

  const comparison = el(
    'section',
    { class: 'pg-comparison', hidden: true, 'aria-label': 'Real versus modelled query data' },
    el(
      'article',
      { class: 'pg-source-panel source-postgres' },
      el(
        'header',
        {},
        sourceBadge('postgres', 'POSTGRES · MEASURED'),
        el('span', { text: 'plan · buffers · result' }),
      ),
      el(
        'div',
        { class: 'pg-facts' },
        metric('shared hit', realHits),
        metric('shared read', realReads),
        metric('actual rows', realRows),
        metric('execution', realTime),
      ),
      realPlan,
    ),
    el(
      'article',
      { class: 'pg-source-panel source-model' },
      el(
        'header',
        {},
        sourceBadge('model', 'MODEL · SCALED'),
        el('span', { text: 'interior mechanism · deliberately visible timing' }),
      ),
      el(
        'div',
        { class: 'pg-facts' },
        metric('buffer hits', modelHits),
        metric('storage reads', modelReads),
        metric('rows sent', modelRows),
        metric('model time', modelTime),
      ),
      modelState,
      el('ol', { class: 'pg-model-path' }, ...modelStops),
    ),
    el('p', {
      class: 'pg-plan-disclosure',
      text: 'PostgreSQL executes each submitted statement once. For statements that can be captured, EXPLAIN ANALYZE drives that execution and a temporary table supplies its displayed rows; Execution Time includes that capture overhead. EXPLAIN Planning Time excludes parsing and rewriting. The model uses the resulting plan to choose the closest interior route; its buffer, WAL, fsync, eviction and timing values remain simulated.',
    }),
  )

  function setLoadingState(): void {
    modeBadge.className = 'pg-source source-postgres is-loading'
    setText(modeBadge, 'POSTGRES · LOADING')
    setText(modeText, `Downloading and starting ${DOWNLOAD_LABEL}; the model remains available below.`)
    loadButton.disabled = true
    loadButton.hidden = true
    loadProgress.classList.add('is-active')
    setText(loadProgress, 'Fetching PostgreSQL WebAssembly and seeding five city tables…')
  }

  function setFailureState(error: unknown): void {
    modeBadge.className = 'pg-source source-model'
    setText(modeBadge, 'MODEL MODE · FALLBACK')
    setText(
      modeText,
      `Real PostgreSQL could not load (${error instanceof Error ? error.message : String(error)}). The six-statement model is active; none of its output is presented as PostgreSQL.`,
    )
    loadProgress.classList.remove('is-active')
    setText(loadProgress, 'WASM unavailable or blocked. No real parse, plan, catalog, or result is being shown.')
    loadButton.disabled = false
    loadButton.hidden = false
    setText(loadButton, `Retry real PostgreSQL · ${DOWNLOAD_LABEL}`)
  }

  async function activate(): Promise<void> {
    if (loading || source || disposed) return
    loading = true
    setLoadingState()
    let pendingLoad: Promise<RealPostgresSource> | null = null
    let timeoutId = 0
    try {
      if (typeof WebAssembly === 'undefined') {
        throw new Error('this browser has no WebAssembly support')
      }
      pendingLoad = load()
      source = await Promise.race([
        pendingLoad,
        new Promise<never>((_resolve, reject) => {
          timeoutId = window.setTimeout(() => {
            reject(new Error('startup exceeded 30 seconds; a database asset may be blocked'))
          }, LOAD_TIMEOUT_MS)
        }),
      ])
      window.clearTimeout(timeoutId)
      if (disposed) {
        await source.close()
        source = null
        return
      }
      modeBadge.className = 'pg-source source-postgres'
      setText(modeBadge, 'POSTGRES MODE · ACTIVE')
      setText(
        modeText,
        'Real PostgreSQL now executes the SQL and supplies catalogs and results. EXPLAIN ANALYZE measures planning, execution and buffer counters; parsing and rewriting are not timed. The animated interior remains the model.',
      )
      loadProgress.classList.remove('is-active')
      setText(
        loadProgress,
        'Single connection: this PostgreSQL cannot demonstrate concurrency, lock contention, replication, or a standby. Those remain modelled in the city.',
      )
      setText(version, `PostgreSQL ${source.serverVersion} · in memory`)
      terminal.hidden = false
      loadButton.hidden = true
      input.focus()
    } catch (error) {
      source = null
      if (pendingLoad) {
        void pendingLoad.then(
          (lateSource) => lateSource.close(),
          () => {},
        )
      }
      if (!disposed) setFailureState(error)
    } finally {
      window.clearTimeout(timeoutId)
      loading = false
    }
  }

  function transcriptCommand(sql: string): HTMLElement {
    return el(
      'div',
      { class: 'pg-history-entry' },
      el(
        'div',
        { class: 'pg-history-sql' },
        el('span', { text: 'pgsimcity=>' }),
        el('pre', { text: sql }),
      ),
      el('p', { class: 'pg-running', text: 'PostgreSQL is running this statement…' }),
    )
  }

  function stageModel(report: RealQueryReport): void {
    const target = report.plan ? cityRelationForPlan(report.plan, report.sql) : null
    modelTarget = target
    comparison.hidden = report.plan === null
    if (!report.plan) return

    const plan = report.plan
    setText(realHits, String(plan.buffers.sharedHits))
    setText(realReads, String(plan.buffers.sharedReads))
    setText(realRows, String(plan.root.actualRows))
    setText(realTime, `${plan.executionTimeMs.toFixed(3)} ms`)
    realPlan.className = 'pg-plan-wrap'
    realPlan.replaceChildren(realPlanTree(plan.root))

    setText(modelHits, '—')
    setText(modelReads, '—')
    setText(modelRows, '—')
    setText(modelTime, '—')
    modelStops.forEach((stop) => {
      stop.className = 'pg-model-stop is-pending'
    })

    if (!target) {
      modelTable = -1
      setText(
        modelState,
        'PostgreSQL produced a real plan, but it does not touch one of the five city relations, so no interior path is invented.',
      )
      return
    }

    modelTable = sim.state.tables.findIndex((table) => table.def.id === target.relation)
    if (modelTable < 0) {
      setText(modelState, `The city has no model relation for ${target.relation}.`)
      return
    }
    options.beforeModelTrace?.()
    sim.endTrace()
    sim.setTraceMode('slow')
    sim.request(target.kind, modelTable)
    setText(
      modelState,
      `PostgreSQL chose the evidence for ${modelRouteLabel(target)}. Waiting for the modelled interior route…`,
    )
  }

  async function run(): Promise<void> {
    if (!source || running) return
    const sql = input.value.trim()
    if (!sql) return
    running = true
    runButton.disabled = true
    input.disabled = true
    history.push(sql)
    historyIndex = history.length
    const entry = transcriptCommand(sql)
    transcript.append(entry)
    transcript.scrollTop = transcript.scrollHeight
    try {
      const report = await source.query(sql)
      entry.querySelector('.pg-running')?.remove()
      entry.append(reportView(report))
      stageModel(report)
      if (!report.error) input.value = ''
    } catch (error) {
      entry.querySelector('.pg-running')?.remove()
      entry.append(
        el(
          'section',
          { class: 'pg-error source-model' },
          sourceBadge('model', 'UI ERROR · NOT POSTGRES'),
          el('pre', { text: error instanceof Error ? error.message : String(error) }),
        ),
      )
    } finally {
      running = false
      runButton.disabled = false
      input.disabled = false
      input.focus()
      transcript.scrollTop = transcript.scrollHeight
    }
  }

  loadButton.addEventListener('click', () => {
    void activate()
  })
  runButton.addEventListener('click', () => {
    void run()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void run()
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey || history.length === 0) return
    if (event.key === 'ArrowUp' && input.selectionStart === 0) {
      event.preventDefault()
      historyIndex = Math.max(0, historyIndex - 1)
      input.value = history[historyIndex]
      input.setSelectionRange(0, 0)
    } else if (event.key === 'ArrowDown' && input.selectionStart === input.value.length) {
      event.preventDefault()
      historyIndex = Math.min(history.length, historyIndex + 1)
      input.value = historyIndex === history.length ? '' : history[historyIndex]
      input.setSelectionRange(input.value.length, input.value.length)
    }
  })

  const root = el(
    'section',
    { class: 'pg-real', 'aria-labelledby': 'pg-real-title' },
    el(
      'div',
      { class: 'pg-real__intro' },
      el(
        'div',
        {},
        el('h2', { id: 'pg-real-title', text: 'Ask a real PostgreSQL' }),
        el(
          'p',
          {},
          'Opt in to arbitrary SQL through ',
          el('a', {
            href: 'https://pglite.dev',
            target: '_blank',
            rel: 'noopener',
            data: { pgliteCredit: 'home' },
            text: 'PGlite by ElectricSQL',
          }),
          ' — a real PostgreSQL compiled to WebAssembly. ',
          el('a', {
            href: 'https://github.com/electric-sql/pglite',
            target: '_blank',
            rel: 'noopener',
            data: { pgliteCredit: 'source' },
            text: 'Read the source',
          }),
          '. PostgreSQL supplies the authority it exposes; PGSimCity supplies the interior it does not expose.',
        ),
      ),
      el('div', { class: 'pg-mode' }, modeBadge, modeText),
      loadButton,
    ),
    loadProgress,
    terminal,
    comparison,
  )

  return {
    root,
    update() {
      if (!modelTarget || modelTable < 0 || comparison.hidden) return
      const trace: TraceRecord = sim.state.trace
      const matches =
        trace.query === modelTarget.kind
        && trace.table === modelTable
        && trace.sql.length > 0
        && (trace.visited & traceStopBit('connect')) !== 0
      if (!matches) return

      setText(modelHits, String(trace.buffersHit))
      setText(modelReads, String(trace.buffersRead))
      setText(modelRows, String(trace.rowsSent))
      setText(modelTime, `${(trace.lastTripSec * 1000).toFixed(0)} ms`)
      setText(
        modelState,
        trace.stop === 'done'
          ? `Modelled ${modelRouteLabel(modelTarget)} complete. Its numbers may disagree with PostgreSQL’s measured plan above.`
          : `Modelled ${modelRouteLabel(modelTarget)}: ${trace.stop.replace('_', ' ')} now.`,
      )
      for (let i = 0; i < MODEL_PATH.length; i++) {
        const segment = MODEL_PATH[i]
        const stop = modelStops[i]
        const skipped = segment.writeOnly && !isWrite(modelTarget.kind)
        const current = trace.stop === segment.stop
        const done = (trace.visited & traceStopBit(segment.stop)) !== 0 && !current
        stop.className = `pg-model-stop is-${
          skipped ? 'skipped' : current ? 'current' : done ? 'done' : 'pending'
        }`
      }
    },
    dispose() {
      disposed = true
      const active = source
      source = null
      if (active) void active.close()
    },
  }
}
