#!/usr/bin/env node

import { spawn } from 'node:child_process'
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

export const OPERATORS = Object.freeze({
  DELINK: 'Replace a registry read with the literal value or rendered bytes it currently returns.',
  GEOMETRY: 'Perturb a world coordinate, invert a normal, cut a surface hole, or sink a rim below its deck.',
  GATE: 'Flip a comparison boundary or remove a term from a threshold/check expression.',
  GUARD: 'Remove a precondition, risk, disclosure string, or the visibility that keeps it load-bearing.',
})

export const TARGETS = Object.freeze([
  {
    id: 'claims-registry',
    rank: 1,
    critical: true,
    label: 'Claims registry ownership',
    reason: 'A byte-identical literal must not be able to replace the registered owner at a consuming surface.',
  },
  {
    id: 'action-registry',
    rank: 2,
    critical: true,
    label: 'Action registry ownership',
    reason: 'Operator actions must retain their registry wiring, preconditions, risks, and version boundaries.',
  },
  {
    id: 'oracle-checks',
    rank: 3,
    critical: true,
    label: 'PostgreSQL oracle checks',
    reason: 'The external oracle is only a gate if its own comparison boundaries and independent terms are defended.',
  },
  {
    id: 'visual-sweeps',
    rank: 4,
    critical: true,
    label: 'Rendered visual sweeps',
    reason: 'Geometry is factual content; holes, displaced surfaces, inverted facing, and submerged rims must be noticed.',
  },
  {
    id: 'disclosure-invariants',
    rank: 5,
    critical: true,
    label: 'Disclosure invariants',
    reason: 'A qualification that disappears while its claim remains is a correctness failure, not a layout detail.',
  },
])

const TARGET_BY_ID = new Map(TARGETS.map((target) => [target.id, target]))
const PRODUCTION_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.css', '.html'])
const MUTATION_SOURCE_ROOTS = ['src', 'machine', 'tools']
const SOURCE_SCAN_ROOTS = ['src', 'machine']
const activeRestorations = new Map()

const VERIFIERS = Object.freeze({
  claimsWiring: {
    key: 'claims-wiring',
    label: 'claims spine direct-consumer wiring predicate',
    command: [
      'npm', 'test', '--', 'test/claims-spine.test.ts',
      '-t', 'wires every registered direct consumer', '--maxWorkers=1',
    ],
  },
  claimsFull: {
    key: 'claims-full',
    label: 'claims spine semantic invariants',
    command: ['npm', 'test', '--', 'test/claims-spine.test.ts', '--maxWorkers=1'],
  },
  actionsWiring: {
    key: 'actions-wiring',
    label: 'action spine registry-call wiring predicate',
    command: [
      'npm', 'test', '--', 'test/action-spine.test.ts',
      '-t', 'wires every registered surface', '--maxWorkers=1',
    ],
  },
  actionsFull: {
    key: 'actions-full',
    label: 'action spine semantic and rendered-surface invariants',
    command: ['npm', 'test', '--', 'test/action-spine.test.ts', '--maxWorkers=1'],
  },
  oracle: {
    key: 'oracle-unit',
    label: 'oracle characterization tests with adversarial observations',
    command: ['npm', 'test', '--', 'tools/pg-oracle.test.mjs', '--maxWorkers=1'],
  },
  visual: {
    key: 'visual-sweep',
    label: 'live rendered city visual sweep',
    command: ['npm', 'test', '--', 'test/visual-sweep.browser.test.ts', '--maxWorkers=1'],
  },
  disclosureBrowser: {
    key: 'disclosure-browser',
    label: '390 px rendered disclosure audit',
    command: [
      'npm', 'test', '--', 'test/accessibility.browser.test.ts',
      '-t', 'opens the layout-derived city architecture', '--maxWorkers=1',
    ],
  },
})

function markdownCell(value) {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/gu, '<br>')
}

export function markdownMutationTable(rows) {
  const lines = [
    '| Rank | File | Line | Operator | Mutation | What should have caught it |',
    '|---:|---|---:|---|---|---|',
  ]
  for (const row of rows) {
    lines.push([
      `| ${markdownCell(row.rank ?? '—')}`,
      markdownCell(row.file),
      markdownCell(row.line ?? '—'),
      markdownCell(row.operator),
      markdownCell(row.description),
      `${markdownCell(row.shouldCatch)} |`,
    ].join(' | '))
  }
  return lines.join('\n')
}

export function applyTextMutation(source, mutation) {
  const actual = source.slice(mutation.start, mutation.end)
  if (actual !== mutation.expected) {
    throw new Error(
      `source range drifted: expected ${JSON.stringify(mutation.expected)}, found ${JSON.stringify(actual)}`,
    )
  }
  return source.slice(0, mutation.start) + mutation.replacement + source.slice(mutation.end)
}

export function mutationSummary(results) {
  return {
    total: results.length,
    killed: results.filter((result) => result.status === 'KILLED').length,
    survived: results.filter((result) => result.status === 'SURVIVED').length,
    skipped: results.filter((result) => result.status === 'SKIPPED').length,
    criticalSurvivors: results.filter(
      (result) => result.critical && result.status === 'SURVIVED',
    ).length,
    criticalSkips: results.filter(
      (result) => result.critical && result.status === 'SKIPPED',
    ).length,
  }
}

export function coverageSummary(mutations, eligible) {
  const targetFiles = new Set(mutations.map((mutation) => mutation.file))
  const mutatedLines = new Set(
    mutations
      .filter((mutation) => Number.isInteger(mutation.line))
      .map((mutation) => `${mutation.file}:${mutation.line}`),
  )
  return {
    mutationSites: mutations.length,
    mutatedLines: mutatedLines.size,
    totalNonblankLines: eligible.nonblankLines,
    lineFraction: eligible.nonblankLines === 0 ? 0 : mutatedLines.size / eligible.nonblankLines,
    targetFiles: targetFiles.size,
    totalFiles: eligible.files.length,
    fileFraction: eligible.files.length === 0 ? 0 : targetFiles.size / eligible.files.length,
  }
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length
}

function targetFields(targetId) {
  const target = TARGET_BY_ID.get(targetId)
  if (!target) throw new Error(`Unknown mutation target ${targetId}`)
  return {
    target: target.id,
    rank: target.rank,
    critical: target.critical,
  }
}

function mutationRecord({
  id,
  operator,
  target,
  file,
  line,
  description,
  shouldCatch,
  verifier,
  start,
  end,
  expected,
  replacement,
  unavailableReason,
}) {
  return {
    id,
    operator,
    ...targetFields(target),
    file,
    line,
    description,
    shouldCatch,
    verifier,
    start,
    end,
    expected,
    replacement,
    unavailableReason,
  }
}

async function runCommand(command, { allowFailure = true } = {}) {
  const [file, ...args] = command
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      const result = { code, signal, stdout, stderr }
      if (allowFailure || code === 0) resolve(result)
      else reject(new Error(stderr.trim() || stdout.trim() || `${file} exited ${code}`))
    })
  })
}

async function gitOutput(args) {
  const result = await runCommand(['git', ...args], { allowFailure: false })
  return result.stdout.trimEnd()
}

async function filesBelow(relativeRoot, accept) {
  const output = []
  const visit = async (relativeDirectory) => {
    const entries = await readdir(path.join(REPO_ROOT, relativeDirectory), { withFileTypes: true })
    for (const entry of entries) {
      const relative = path.posix.join(relativeDirectory, entry.name)
      if (entry.isDirectory()) await visit(relative)
      else if (entry.isFile() && accept(relative)) output.push(relative)
    }
  }
  await visit(relativeRoot)
  return output
}

function productionFile(relative) {
  const basename = path.basename(relative)
  return PRODUCTION_EXTENSIONS.has(path.extname(relative))
    && !/\.test\.[^.]+$/u.test(basename)
    && !basename.endsWith('.d.ts')
}

async function productionSources() {
  const sources = []
  for (const root of SOURCE_SCAN_ROOTS) {
    sources.push(...await filesBelow(root, (relative) => (
      productionFile(relative) && /\.(?:ts|js)$/u.test(relative)
    )))
  }
  return sources.sort()
}

async function eligibleCodebase() {
  const files = []
  for (const root of MUTATION_SOURCE_ROOTS) {
    files.push(...await filesBelow(root, productionFile))
  }
  let nonblankLines = 0
  for (const file of files) {
    const source = await readFile(path.join(REPO_ROOT, file), 'utf8')
    nonblankLines += source.split(/\r?\n/u).filter((line) => line.trim().length > 0).length
  }
  return { files: files.sort(), nonblankLines }
}

function scriptKind(file) {
  return file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS
}

function unwrapExpression(expression) {
  let current = expression
  while (
    current
    && (
      ts.isAsExpression(current)
      || ts.isParenthesizedExpression(current)
      || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(current))
    )
  ) current = current.expression
  return current
}

function propertyName(property) {
  if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) {
    return property.name.text
  }
  return null
}

function objectProperty(object, name) {
  return object.properties.find((property) => (
    ts.isPropertyAssignment(property) && propertyName(property) === name
  ))
}

function objectVariable(file, name) {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
      const initializer = unwrapExpression(declaration.initializer)
      return initializer && ts.isObjectLiteralExpression(initializer) ? initializer : null
    }
  }
  return null
}

function objectPathExpression(root, parts) {
  let current = root
  for (const part of parts) {
    if (!current || !ts.isObjectLiteralExpression(current)) return null
    const property = objectProperty(current, part)
    if (!property) return null
    current = unwrapExpression(property.initializer)
  }
  return current
}

function serializeLiteral(value) {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('value is not JSON-literal serializable')
  return `(${serialized})`
}

async function loadRegistryValues() {
  const buildDirectory = await mkdtemp(path.join(tmpdir(), 'pgsimcity-mutation-registry-'))
  try {
    const program = ts.createProgram({
      rootNames: [
        path.join(REPO_ROOT, 'src/core/claims.ts'),
        path.join(REPO_ROOT, 'src/core/actions.ts'),
      ],
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        rootDir: REPO_ROOT,
        outDir: buildDirectory,
        esModuleInterop: true,
        skipLibCheck: true,
        strict: true,
      },
    })
    const emitted = program.emit()
    if (emitted.emitSkipped) {
      const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitted.diagnostics)
      const summary = ts.formatDiagnosticsWithColorAndContext(diagnostics.slice(0, 10), {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => REPO_ROOT,
        getNewLine: () => '\n',
      })
      throw new Error(`Could not load mutation registries:\n${summary}`)
    }
    await symlink(path.join(REPO_ROOT, 'node_modules'), path.join(buildDirectory, 'node_modules'), 'dir')
    const require = createRequire(path.join(buildDirectory, 'mutation-loader.cjs'))
    const claims = require(path.join(buildDirectory, 'src/core/claims.js'))
    const actions = require(path.join(buildDirectory, 'src/core/actions.js'))
    return {
      claimValues: claims.CLAIM_VALUES,
      actions: actions.ACTIONS,
      renderAction: actions.renderAction,
    }
  } finally {
    await rm(buildDirectory, { recursive: true, force: true })
  }
}

async function claimDelinkMutations(files, registry) {
  const mutations = []
  for (const file of files) {
    if (file === 'src/core/claims.ts') continue
    const source = await readFile(path.join(REPO_ROOT, file), 'utf8')
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file))
    let ordinal = 0
    const visit = (node) => {
      if (
        ts.isPropertyAccessExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'CLAIM_VALUES'
        && Object.hasOwn(registry.claimValues, node.name.text)
      ) {
        ordinal++
        const start = node.getStart(parsed)
        const end = node.getEnd()
        let replacement
        let unavailableReason
        try {
          replacement = serializeLiteral(registry.claimValues[node.name.text])
        } catch (error) {
          unavailableReason = error.message
        }
        mutations.push(mutationRecord({
          id: `delink-claim-${file}-${lineAt(source, start)}-${ordinal}`,
          operator: 'DELINK',
          target: 'claims-registry',
          file,
          line: lineAt(source, start),
          description: `replace CLAIM_VALUES.${node.name.text} with its current literal value`,
          shouldCatch: 'test/claims-spine.test.ts direct-consumer wiring predicate',
          verifier: VERIFIERS.claimsWiring,
          start,
          end,
          expected: source.slice(start, end),
          replacement,
          unavailableReason,
        }))
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
  }
  return mutations
}

async function actionDelinkMutations(files, registry) {
  const mutations = []
  for (const file of files) {
    if (file === 'src/core/actions.ts') continue
    const source = await readFile(path.join(REPO_ROOT, file), 'utf8')
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file))
    let ordinal = 0
    const visit = (node) => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && (node.expression.text === 'renderAction' || node.expression.text === 'renderActions')
        && node.arguments.length > 0
        && node.arguments.every(ts.isStringLiteralLike)
        && node.arguments.every((argument) => Object.hasOwn(registry.actions, argument.text))
      ) {
        ordinal++
        const actionIds = node.arguments.map((argument) => argument.text)
        const rendered = actionIds.map((actionId) => registry.renderAction(actionId)).join('\n\n')
        const start = node.getStart(parsed)
        const end = node.getEnd()
        mutations.push(mutationRecord({
          id: `delink-action-${file}-${lineAt(source, start)}-${ordinal}`,
          operator: 'DELINK',
          target: 'action-registry',
          file,
          line: lineAt(source, start),
          description: `replace ${node.expression.text}(${actionIds.join(', ')}) with its current rendered prose`,
          shouldCatch: 'test/action-spine.test.ts registry-call wiring predicate',
          verifier: VERIFIERS.actionsWiring,
          start,
          end,
          expected: source.slice(start, end),
          replacement: JSON.stringify(rendered),
        }))
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
  }
  return mutations
}

async function actionGuardMutations() {
  const file = 'src/core/actions.ts'
  const source = await readFile(path.join(REPO_ROOT, file), 'utf8')
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const actions = objectVariable(parsed, 'ACTIONS')
  if (!actions) {
    return [mutationRecord({
      id: 'guard-actions-unavailable',
      operator: 'GUARD',
      target: 'action-registry',
      file,
      line: null,
      description: 'remove registered action preconditions and risks',
      shouldCatch: 'test/action-spine.test.ts semantic action invariants',
      verifier: VERIFIERS.actionsFull,
      unavailableReason: 'ACTIONS object initializer did not resolve safely',
    })]
  }
  const mutations = []
  for (const actionProperty of actions.properties) {
    if (!ts.isPropertyAssignment(actionProperty)) continue
    const actionId = propertyName(actionProperty)
    const action = unwrapExpression(actionProperty.initializer)
    if (!actionId || !action || !ts.isObjectLiteralExpression(action)) continue
    for (const field of ['preconditions', 'risks']) {
      const property = objectProperty(action, field)
      const values = property && unwrapExpression(property.initializer)
      if (!values || !ts.isArrayLiteralExpression(values)) continue
      for (let index = 0; index < values.elements.length; index++) {
        const element = values.elements[index]
        if (!ts.isStringLiteralLike(element)) continue
        const start = element.getStart(parsed)
        const end = element.getEnd()
        mutations.push(mutationRecord({
          id: `guard-${actionId}-${field}-${index + 1}`,
          operator: 'GUARD',
          target: 'action-registry',
          file,
          line: lineAt(source, start),
          description: `remove ${field === 'risks' ? 'risk' : 'precondition'} ${index + 1} from ACTIONS.${actionId}`,
          shouldCatch: 'test/action-spine.test.ts semantic requirements, not registry/surface byte agreement alone',
          verifier: VERIFIERS.actionsFull,
          start,
          end,
          expected: source.slice(start, end),
          replacement: "''",
        }))
      }
    }
  }
  return mutations
}

const DISCLOSURE_PATHS = [
  ['bulkReadRing', 'disclosure'],
  ['modelLatency', 'disclosure'],
  ['modelLatency', 'taxonomyDisclosure'],
  ['connectionPooler', 'coverageDisclosure'],
  ['workMem', 'coverageDisclosure'],
  ['restoreDrill', 'physicalScopeDisclosure'],
  ['restoreDrill', 'checksumDisclosure'],
  ['restoreDrill', 'smokeDisclosure'],
  ['restoreDrill', 'timeDisclosure'],
  ['restoreDrill', 'cadenceDisclosure'],
  ['timelineRecovery', 'coverageDisclosure'],
]

async function disclosureStringMutations() {
  const file = 'src/core/claims.ts'
  const source = await readFile(path.join(REPO_ROOT, file), 'utf8')
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const claims = objectVariable(parsed, 'CLAIM_VALUES')
  const mutations = []
  for (const parts of DISCLOSURE_PATHS) {
    const expression = claims && objectPathExpression(claims, parts)
    const pathLabel = `CLAIM_VALUES.${parts.join('.')}`
    if (!expression || !ts.isStringLiteralLike(expression)) {
      mutations.push(mutationRecord({
        id: `guard-disclosure-${parts.join('-')}`,
        operator: 'GUARD',
        target: 'disclosure-invariants',
        file,
        line: null,
        description: `remove ${pathLabel}`,
        shouldCatch: 'the claim-specific disclosure invariant in test/claims-spine.test.ts',
        verifier: VERIFIERS.claimsFull,
        unavailableReason: `${pathLabel} did not resolve to one literal string`,
      }))
      continue
    }
    const start = expression.getStart(parsed)
    const end = expression.getEnd()
    mutations.push(mutationRecord({
      id: `guard-disclosure-${parts.join('-')}`,
      operator: 'GUARD',
      target: 'disclosure-invariants',
      file,
      line: lineAt(source, start),
      description: `remove disclosure string ${pathLabel}`,
      shouldCatch: 'the claim-specific disclosure invariant in test/claims-spine.test.ts',
      verifier: VERIFIERS.claimsFull,
      start,
      end,
      expected: source.slice(start, end),
      replacement: "''",
    }))
  }
  return mutations
}

async function exactMutation(definition) {
  const source = await readFile(path.join(REPO_ROOT, definition.file), 'utf8')
  const offsets = []
  let offset = source.indexOf(definition.needle)
  while (offset >= 0) {
    offsets.push(offset)
    offset = source.indexOf(definition.needle, offset + Math.max(1, definition.needle.length))
  }
  if (offsets.length !== 1) {
    return mutationRecord({
      ...definition,
      line: offsets.length > 0 ? lineAt(source, offsets[0]) : null,
      unavailableReason: `safe anchor matched ${offsets.length} times; exactly one is required`,
    })
  }
  const start = offsets[0]
  return mutationRecord({
    ...definition,
    line: lineAt(source, start),
    start,
    end: start + definition.needle.length,
    expected: definition.needle,
    replacement: definition.replacement,
  })
}

async function staticMutations() {
  const definitions = [
    {
      id: 'gate-diagnose-client-write-boundary',
      operator: 'GATE',
      target: 'claims-registry',
      file: 'src/observability/paths.ts',
      needle: 'clientBackendWriteShare(c) > DIAGNOSTIC_GATES.clientBackendWriteShare.threshold',
      replacement: 'clientBackendWriteShare(c) >= DIAGNOSTIC_GATES.clientBackendWriteShare.threshold',
      description: 'include the exact client-backend-write warning boundary in the positive branch',
      shouldCatch: 'test/claims-spine.test.ts exact Diagnose branch-boundary characterization',
      verifier: VERIFIERS.claimsFull,
    },
    {
      id: 'gate-diagnose-checkpoint-boundary',
      operator: 'GATE',
      target: 'claims-registry',
      file: 'src/observability/paths.ts',
      needle: 'checkpointRequestedShare(c) > DIAGNOSTIC_GATES.requestedCheckpointShare.threshold',
      replacement: 'checkpointRequestedShare(c) >= DIAGNOSTIC_GATES.requestedCheckpointShare.threshold',
      description: 'include the exact requested-checkpoint share boundary in both opposing branches',
      shouldCatch: 'test/claims-spine.test.ts disjoint threshold-boundary characterization',
      verifier: VERIFIERS.claimsFull,
    },
    {
      id: 'gate-oracle-major-lower-bound',
      operator: 'GATE',
      target: 'oracle-checks',
      file: 'tools/pg-oracle.mjs',
      needle: `export function expectedForMajor(claim, major) {
  const variants = Array.isArray(claim.expected) ? claim.expected : [claim.expected]
  return variants.find((variant) =>
    (variant.from === undefined || major >= variant.from)
    && (variant.to === undefined || major <= variant.to)) ?? null
}`,
      replacement: `export function expectedForMajor(claim, major) {
  const variants = Array.isArray(claim.expected) ? claim.expected : [claim.expected]
  return variants.find((variant) =>
    (variant.from === undefined || major > variant.from)
    && (variant.to === undefined || major <= variant.to)) ?? null
}`,
      description: 'exclude a PostgreSQL major exactly at a registered variant lower bound',
      shouldCatch: 'tools/pg-oracle.test.mjs version-boundary cases',
      verifier: VERIFIERS.oracle,
    },
    {
      id: 'gate-oracle-unexpected-match-term',
      operator: 'GATE',
      target: 'oracle-checks',
      file: 'tools/pg-oracle.mjs',
      needle: "row.verdict === 'DIVERGES' || row.verdict === 'UNEXPECTED MATCH'",
      replacement: "row.verdict === 'DIVERGES'",
      description: 'drop UNEXPECTED MATCH from the oracle failure summary',
      shouldCatch: 'tools/pg-oracle.test.mjs registered-divergence summary case',
      verifier: VERIFIERS.oracle,
    },
    {
      id: 'gate-oracle-reference-upper-bound',
      operator: 'GATE',
      target: 'oracle-checks',
      file: 'tools/pg-oracle.mjs',
      needle: 'serverVersionNum <= referenceVersionNum',
      replacement: 'serverVersionNum < referenceVersionNum',
      description: 'reject the exact reviewed PostgreSQL reference minor',
      shouldCatch: 'tools/pg-oracle.test.mjs exact reference-version case',
      verifier: VERIFIERS.oracle,
    },
    {
      id: 'gate-oracle-wal-independent-name',
      operator: 'GATE',
      target: 'oracle-checks',
      file: 'tools/pg-oracle.mjs',
      needle: "    && observation?.fileName === expected?.fileName\n    && Number(observation?.fileOffset) === expected?.fileOffset",
      replacement: "    && Number(observation?.fileOffset) === expected?.fileOffset",
      description: 'drop the independent WAL filename-to-LSN arithmetic term',
      shouldCatch: 'tools/pg-oracle.test.mjs plausible-but-wrong WAL filename case',
      verifier: VERIFIERS.oracle,
    },
    {
      id: 'geometry-cut-client-ground-hole',
      operator: 'GEOMETRY',
      target: 'visual-sweeps',
      file: 'src/world/ground.ts',
      needle: '  shape.holes.push(hole)',
      replacement: `  shape.holes.push(hole)
  const mutationHole = new THREE.Path()
  mutationHole.moveTo(60, 258)
  mutationHole.lineTo(60, 282)
  mutationHole.lineTo(84, 282)
  mutationHole.lineTo(84, 258)
  mutationHole.closePath()
  shape.holes.push(mutationHole)`,
      description: 'cut an undeclared 24 × 24 world-unit hole in the clients ground',
      shouldCatch: 'test/visual-sweep.browser.test.ts registered-ground boundary and lattice audit',
      verifier: VERIFIERS.visual,
    },
    {
      id: 'geometry-lift-client-forecourt',
      operator: 'GEOMETRY',
      target: 'visual-sweeps',
      file: 'src/world/clients.ts',
      needle: `  apron.position.set(
    (forecourt.x0 + forecourt.x1) / 2,
    0.06,
    (forecourt.z0 + forecourt.z1) / 2,
  )`,
      replacement: `  apron.position.set(
    (forecourt.x0 + forecourt.x1) / 2,
    24.06,
    (forecourt.z0 + forecourt.z1) / 2,
  )`,
      description: 'perturb the clients forecourt world Y coordinate upward by 24 units',
      shouldCatch: 'test/visual-sweep.browser.test.ts rendered surface-support invariant',
      verifier: VERIFIERS.visual,
    },
    {
      id: 'geometry-invert-ground-normal',
      operator: 'GEOMETRY',
      target: 'visual-sweeps',
      file: 'src/world/ground.ts',
      needle: "  plate.name = 'ground.plate'\n  plate.rotation.x = -Math.PI / 2",
      replacement: "  plate.name = 'ground.plate'\n  plate.rotation.x = Math.PI / 2",
      description: 'invert the registered ground plate normal',
      shouldCatch: 'test/visual-sweep.browser.test.ts registered-ground facing/winding invariant',
      verifier: VERIFIERS.visual,
    },
    {
      id: 'geometry-sink-deck-rim',
      operator: 'GEOMETRY',
      target: 'visual-sweeps',
      file: 'src/world/shmem.ts',
      needle: '    const y = DECK_TOP + 0.055',
      replacement: '    const y = DECK_TOP - 0.945',
      description: 'sink the shared-memory rim one unit below its deck',
      shouldCatch: 'test/visual-sweep.browser.test.ts border-to-surface alignment invariant',
      verifier: VERIFIERS.visual,
    },
    {
      id: 'guard-hide-disclosures',
      operator: 'GUARD',
      target: 'disclosure-invariants',
      file: 'src/styles/tokens.css',
      needle: `[data-disclosure] {
  --pg-disclosure: 1;
}`,
      replacement: `[data-disclosure] {
  --pg-disclosure: 1;
  display: none;
}`,
      description: 'hide every marked disclosure with display: none',
      shouldCatch: 'test/accessibility.browser.test.ts 390 px rendered disclosure audit',
      verifier: VERIFIERS.disclosureBrowser,
    },
  ]
  return Promise.all(definitions.map(exactMutation))
}

async function buildMutations() {
  const files = await productionSources()
  const registry = await loadRegistryValues()
  const mutations = [
    ...await claimDelinkMutations(files, registry),
    ...await actionDelinkMutations(files, registry),
    ...await actionGuardMutations(),
    ...await disclosureStringMutations(),
    ...await staticMutations(),
  ]
  return mutations.sort((left, right) => (
    left.rank - right.rank
    || left.file.localeCompare(right.file)
    || (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id)
  ))
}

/** Discovery is cheap enough for the fast suite; executing the mutants is not. */
export async function discoverMutationPlan() {
  return buildMutations()
}

export function isTimeoutFailure(result) {
  return /(?:test timed out(?: in)?\s+\d+\s*ms|timed out waiting|timeouterror|err_[a-z_]*timeout)/iu
    .test(`${result.stdout}\n${result.stderr}`)
}

async function runVerifier(verifier) {
  let result = await runCommand(verifier.command)
  if (result.code !== 0 && isTimeoutFailure(result)) {
    result = await runCommand(verifier.command)
    return { ...result, retriedAfterTimeout: true }
  }
  return { ...result, retriedAfterTimeout: false }
}

function failureExcerpt(result) {
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.find((line) => /(?:FAIL|Error:|AssertionError|timed out)/u.test(line))
    ?? lines.at(-1)
    ?? `exit ${result.code}${result.signal ? ` (${result.signal})` : ''}`
}

async function restoreActiveMutations() {
  for (const [absolute, original] of activeRestorations) {
    await writeFile(absolute, original)
    activeRestorations.delete(absolute)
  }
}

async function executeMutation(mutation, originals, progress) {
  const common = {
    id: mutation.id,
    operator: mutation.operator,
    target: mutation.target,
    rank: mutation.rank,
    critical: mutation.critical,
    file: mutation.file,
    line: mutation.line,
    description: mutation.description,
    shouldCatch: mutation.shouldCatch,
  }
  if (mutation.unavailableReason) {
    return { ...common, status: 'SKIPPED', detail: mutation.unavailableReason }
  }
  const absolute = path.join(REPO_ROOT, mutation.file)
  const original = originals.get(mutation.file)
  if (original === undefined) {
    return { ...common, status: 'SKIPPED', detail: 'original source snapshot is absent' }
  }
  try {
    const current = await readFile(absolute, 'utf8')
    if (current !== original) {
      return { ...common, status: 'SKIPPED', detail: 'target file changed after discovery' }
    }
    const mutated = applyTextMutation(current, mutation)
    activeRestorations.set(absolute, original)
    await writeFile(absolute, mutated)
    progress(`verify ${mutation.id}`)
    const verification = await runVerifier(mutation.verifier)
    if (verification.signal || (verification.code !== 0 && isTimeoutFailure(verification))) {
      return {
        ...common,
        status: 'SKIPPED',
        detail: verification.retriedAfterTimeout
          ? 'serial verifier timed out twice; result is inconclusive'
          : `verifier ended by ${verification.signal ?? 'timeout'}`,
      }
    }
    if (verification.code === 0) {
      return { ...common, status: 'SURVIVED', detail: `${mutation.verifier.label} passed` }
    }
    return {
      ...common,
      status: 'KILLED',
      detail: `${mutation.verifier.label}: ${failureExcerpt(verification)}`,
    }
  } catch (error) {
    return { ...common, status: 'SKIPPED', detail: error.message }
  } finally {
    if (activeRestorations.has(absolute)) {
      await writeFile(absolute, original)
      activeRestorations.delete(absolute)
    }
  }
}

function percentage(fraction) {
  return `${(fraction * 100).toFixed(3).replace(/\.?0+$/u, '')}%`
}

function targetTable(mutations) {
  const lines = [
    '| Rank | Critical target | Mutants | Why it is selected |',
    '|---:|---|---:|---|',
  ]
  for (const target of TARGETS) {
    const count = mutations.filter((mutation) => mutation.target === target.id).length
    lines.push(`| ${target.rank} | ${markdownCell(target.label)} | ${count} | ${markdownCell(target.reason)} |`)
  }
  return lines.join('\n')
}

function report({ mutations, results, coverage, baselineCommit, elapsed, scoped }) {
  const summary = mutationSummary(results)
  const survivors = results.filter((result) => result.status === 'SURVIVED')
  const skips = results.filter((result) => result.status === 'SKIPPED')
  const lines = [
    '# PGSimCity mutation gate',
    '',
    `Baseline commit: \`${baselineCommit}\`.`,
    `Execution: ${scoped ? `scoped selection (${results.length} of ${mutations.length} declared mutants)` : `all ${mutations.length} declared mutants`}; one mutant at a time; every verifier uses \`--maxWorkers=1\`.`,
    '',
    '## Ranked critical targets',
    '',
    targetTable(mutations),
    '',
    'Every listed target is critical. A survivor or an inconclusive skip makes the scheduled gate fail; rank orders investigation and does not dilute that rule.',
    '',
    '## Actual reach and limits',
    '',
    `The harness applied or attempted ${coverage.mutationSites} explicit sites on ${coverage.mutatedLines} distinct source lines out of ${coverage.totalNonblankLines} nonblank production/tool lines under \`src/\`, \`machine/\`, and \`tools/\`: ${percentage(coverage.lineFraction)} of that defined codebase. Those sites occupy ${coverage.targetFiles} of ${coverage.totalFiles} eligible files (${percentage(coverage.fileFraction)}). The exact-line fraction is the honest mutation reach; target-file coverage is not presented as proof that every line in those files was mutated.`,
    '',
    '- The denominator includes production `.ts`, `.js`, `.mjs`, `.css`, and `.html` in those three roots, including generated source data. Tests, workflows, documentation, configuration, assets, and root entry points outside those roots are neither in that denominator nor mutation targets.',
    '- DELINK reaches direct `CLAIM_VALUES.<claim>` property reads and literal-argument `renderAction(...)`/`renderActions(...)` calls discovered in production TypeScript/JavaScript. It does not reach aliases, destructuring, reflective access, computed action IDs, or values assembled outside those registries.',
    '- GEOMETRY is four incident-derived probes: one 24 × 24 ground hole, one displaced world coordinate, one inverted plate normal, and one rim sunk below its deck. It does not generically mutate every mesh, shader, collider, route, animation state, quality tier, browser, or GPU.',
    '- GATE covers selected Diagnose thresholds and oracle boundaries/independent terms. It does not enumerate general arithmetic, boolean, loop, SQL, or timing mutations.',
    '- GUARD covers registered action preconditions/risks, selected load-bearing claim disclosures, and one real 390 px CSS hiding fault. It cannot infer unregistered prose qualifications or facts that ought to have a disclosure but do not.',
    '- Each mutant runs only the named closest plausible verifier. `SURVIVED` means that scoped verifier accepted the mutation; it does not claim that the full suite would accept it. A full-suite-per-mutant loop is deliberately not implied by this report.',
    '- Browser mutations use the live Chrome/SwiftShader sweep at its staged day/medium state. Time-dependent scenes, other quality/theme states, transient host contention, and visual defects below the sweep thresholds remain outside this run.',
    '',
    '## Surviving mutants',
    '',
    survivors.length > 0
      ? markdownMutationTable(survivors)
      : 'No mutant survived its scoped verifier.',
    '',
    '## Skipped or inconclusive mutants',
    '',
    skips.length > 0
      ? markdownMutationTable(skips.map((skip) => ({
        ...skip,
        description: `${skip.description} — SKIPPED: ${skip.detail}`,
      })))
      : 'None. Every declared mutation was applied and restored cleanly.',
    '',
    '## Run summary',
    '',
    `Killed: ${summary.killed}. Survived: ${summary.survived}. Skipped/inconclusive: ${summary.skipped}. No mutation score is calculated.`,
    `Wall time: ${elapsed.toFixed(2)} s.`,
  ]
  return lines.join('\n')
}

function parseArguments(argv) {
  const parsed = { help: false, list: false, only: [] }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--help') parsed.help = true
    else if (argument === '--list') parsed.list = true
    else if (argument === '--maxWorkers=1') continue
    else if (argument === '--only') {
      const value = argv[++index]
      if (!value) throw new Error('--only requires a comma-separated value')
      parsed.only.push(...value.split(',').map((item) => item.trim()).filter(Boolean))
    } else if (argument.startsWith('--only=')) {
      parsed.only.push(...argument.slice('--only='.length).split(',').map((item) => item.trim()).filter(Boolean))
    } else {
      throw new Error(`Unknown argument ${argument}`)
    }
  }
  const fromEnvironment = (process.env.MUTATION_ONLY ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  parsed.only.push(...fromEnvironment)
  return parsed
}

function selectedMutation(mutation, filters) {
  return filters.length === 0 || filters.some((filter) => (
    mutation.id.includes(filter)
    || mutation.target === filter
    || mutation.operator === filter.toUpperCase()
  ))
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (args.help) {
    console.log('Usage: node tools/mutation-gate.mjs [--list] [--only target,operator,id] [--maxWorkers=1]')
    console.log('Runs one incident-derived mutant at a time and fails on every critical survivor or skip.')
    return
  }
  const startedAt = performance.now()
  const statusBefore = await gitOutput(['status', '--porcelain=v1', '--untracked-files=all'])
  const baselineCommit = await gitOutput(['rev-parse', 'HEAD'])
  const mutations = await buildMutations()
  const eligible = await eligibleCodebase()
  const applicable = mutations.filter((mutation) => !mutation.unavailableReason)
  const coverage = coverageSummary(applicable, eligible)

  if (args.list) {
    console.log('# PGSimCity mutation gate target list')
    console.log('')
    console.log(targetTable(mutations))
    console.log('')
    console.log(`Exact mutation reach: ${coverage.mutatedLines}/${coverage.totalNonblankLines} nonblank production/tool lines (${percentage(coverage.lineFraction)}); ${coverage.targetFiles}/${coverage.totalFiles} files contain at least one site.`)
    return
  }

  const selected = mutations.filter((mutation) => selectedMutation(mutation, args.only))
  if (selected.length === 0) throw new Error(`No mutants matched ${args.only.join(', ')}`)
  const originals = new Map()
  for (const mutation of selected) {
    if (originals.has(mutation.file)) continue
    originals.set(mutation.file, await readFile(path.join(REPO_ROOT, mutation.file), 'utf8'))
  }

  const showProgress = process.env.MUTATION_PROGRESS === '1' || process.stderr.isTTY
  const progress = (message) => {
    if (showProgress) console.error(`[mutation] ${message}`)
  }
  const baselineFailures = new Map()
  const verifiers = new Map(selected.map((mutation) => [mutation.verifier.key, mutation.verifier]))
  for (const verifier of verifiers.values()) {
    progress(`baseline ${verifier.label}`)
    const baseline = await runVerifier(verifier)
    if (baseline.code !== 0 || baseline.signal) baselineFailures.set(verifier.key, baseline)
  }

  const results = []
  try {
    for (let index = 0; index < selected.length; index++) {
      const mutation = selected[index]
      progress(`${index + 1}/${selected.length} ${mutation.operator} ${mutation.file}:${mutation.line ?? '—'}`)
      const baselineFailure = baselineFailures.get(mutation.verifier.key)
      if (baselineFailure) {
        results.push({
          ...mutation,
          status: 'SKIPPED',
          detail: `baseline verifier was not green: ${failureExcerpt(baselineFailure)}`,
        })
        continue
      }
      results.push(await executeMutation(mutation, originals, progress))
    }
  } finally {
    await restoreActiveMutations()
  }

  for (const [file, original] of originals) {
    const restored = await readFile(path.join(REPO_ROOT, file), 'utf8')
    if (restored !== original) throw new Error(`Mutation cleanup failed to restore ${file}`)
  }
  const statusAfter = await gitOutput(['status', '--porcelain=v1', '--untracked-files=all'])
  if (statusAfter !== statusBefore) {
    throw new Error(`Mutation run changed repository status after cleanup:\nBefore:\n${statusBefore}\nAfter:\n${statusAfter}`)
  }

  const elapsed = (performance.now() - startedAt) / 1000
  console.log(report({
    mutations,
    results,
    coverage,
    baselineCommit,
    elapsed,
    scoped: selected.length !== mutations.length,
  }))
  const summary = mutationSummary(results)
  if (summary.criticalSurvivors > 0 || summary.criticalSkips > 0) process.exitCode = 1
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await restoreActiveMutations()
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
  main().catch(async (error) => {
    await restoreActiveMutations()
    console.error(`mutation-gate: ${error.message}`)
    process.exitCode = 1
  })
}
