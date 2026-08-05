import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import {
  ACTIONS,
  actionSurfaceLabel,
  renderAction,
} from '../src/core/actions'
import type { ActionId, ActionSurface } from '../src/core/actions'
import {
  CLAIM_VALUES,
  ordinaryConnectionCapacity,
} from '../src/core/claims'
import { createBus } from '../src/core/bus'
import { createCollector } from '../src/observability/collector'
import { ALL_STEPS, ALL_VERDICTS } from '../src/observability/paths'
import { PROJECTIONS } from '../src/observability/views'
import { createSim } from '../src/sim/model'
import { SCENARIOS } from '../src/sim/scenarios'
import { DOCS_MEMORY } from '../src/ui/docs-memory'
import { DOCS_STORAGE } from '../src/ui/docs-storage'

const ROOT = resolve(import.meta.dirname, '..')

interface SourceActionSurface {
  file: string
  line: number
  surface: ActionSurface
  expression: ts.Expression
}

interface OperationalCopyOccurrence {
  actionId: ActionId
  file: string
  line: number
  surface?: SourceActionSurface
  target: string
}

interface RegistryBindings {
  checker: ts.TypeChecker
  renderers: ReadonlySet<ts.Symbol>
  references: ReadonlySet<ts.Symbol>
}

interface ActionAnalysis extends RegistryBindings {
  program: ts.Program
}

let cachedActionSurfaces: SourceActionSurface[] | undefined
let cachedActionAnalysis: ActionAnalysis | undefined

function sourceFiles(directory = 'src'): string[] {
  return readdirSync(resolve(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })
}

function property(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return object.properties.find((candidate): candidate is ts.PropertyAssignment => (
    ts.isPropertyAssignment(candidate)
    && (
      (ts.isIdentifier(candidate.name) && candidate.name.text === name)
      || (ts.isStringLiteralLike(candidate.name) && candidate.name.text === name)
    )
  ))
}

function stringValue(expression: ts.Expression | undefined): string | undefined {
  return expression && ts.isStringLiteralLike(expression) ? expression.text : undefined
}

function numberValue(expression: ts.Expression | undefined): number | undefined {
  if (!expression || !ts.isNumericLiteral(expression)) return undefined
  return Number(expression.text)
}

function resolveSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node)
  const seen = new Set<ts.Symbol>()
  while (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(symbol)) {
    seen.add(symbol)
    symbol = checker.getAliasedSymbol(symbol)
  }
  return symbol
}

function canonicalFunctionSymbols(
  program: ts.Program,
  checker: ts.TypeChecker,
  fileName: string,
  names: ReadonlySet<string>,
): Set<ts.Symbol> {
  const file = program.getSourceFile(fileName)
  if (!file) throw new Error(`binding proof cannot load ${fileName}`)
  const symbols = new Set<ts.Symbol>()
  for (const statement of file.statements) {
    if (
      ts.isFunctionDeclaration(statement)
      && statement.name
      && names.has(statement.name.text)
    ) {
      const symbol = resolveSymbol(checker, statement.name)
      if (symbol) symbols.add(symbol)
    }
  }
  return symbols
}

function bindingsFor(program: ts.Program, actionsFile: string): RegistryBindings {
  const checker = program.getTypeChecker()
  return {
    checker,
    renderers: canonicalFunctionSymbols(
      program,
      checker,
      actionsFile,
      new Set(['renderAction', 'renderActions']),
    ),
    references: canonicalFunctionSymbols(
      program,
      checker,
      actionsFile,
      new Set(['operationalReference']),
    ),
  }
}

function productionActionAnalysis(): ActionAnalysis {
  if (cachedActionAnalysis) return cachedActionAnalysis
  const configPath = resolve(ROOT, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT)
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
  cachedActionAnalysis = {
    program,
    ...bindingsFor(program, resolve(ROOT, 'src/core/actions.ts')),
  }
  return cachedActionAnalysis
}

function productionActionSurfaces(): SourceActionSurface[] {
  if (cachedActionSurfaces) return cachedActionSurfaces
  const analysis = productionActionAnalysis()
  const surfaces: SourceActionSurface[] = []
  for (const path of sourceFiles()) {
    const file = analysis.program.getSourceFile(resolve(ROOT, path))
    if (!file) throw new Error(`binding proof cannot load ${path}`)
    const add = (surface: ActionSurface, expression: ts.Expression): void => {
      surfaces.push({
        file: path,
        line: file.getLineAndCharacterOfPosition(expression.getStart()).line + 1,
        surface,
        expression,
      })
    }
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const id = stringValue(property(node, 'id')?.initializer)
        const kind = stringValue(property(node, 'kind')?.initializer)
        const fix = property(node, 'fix')?.initializer
        if (id && kind === 'verdict' && fix) {
          add({ kind: 'diagnose-verdict', id }, fix)
        }

        const beats = property(node, 'beats')?.initializer
        if (id && beats && ts.isArrayLiteralExpression(beats)) {
          for (const beat of beats.elements) {
            if (!ts.isArrayLiteralExpression(beat)) continue
            const at = numberValue(beat.elements[0] as ts.Expression | undefined)
            const body = beat.elements[2]
            if (at !== undefined && body && ts.isExpression(body)) {
              add({ kind: 'scenario-beat', scenario: id, at }, body)
            }
          }
        }

        const sections = property(node, 'sections')?.initializer
        if (id && sections && ts.isArrayLiteralExpression(sections)) {
          for (const section of sections.elements) {
            if (!ts.isObjectLiteralExpression(section)) continue
            const heading = stringValue(property(section, 'heading')?.initializer)
            const body = property(section, 'body')?.initializer
            if (heading && body) {
              add({ kind: 'inspector-section', doc: id, section: heading }, body)
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  cachedActionSurfaces = surfaces
  return cachedActionSurfaces
}

function registryCalls(expression: ts.Expression): Set<ActionId> {
  return registryCallsWithBindings(expression, productionActionAnalysis())
}

function registryCallsWithBindings(
  expression: ts.Expression,
  bindings: RegistryBindings,
): Set<ActionId> {
  const actionIds = new Set<ActionId>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && bindings.renderers.has(resolveSymbol(bindings.checker, node.expression) as ts.Symbol)
    ) {
      for (const argument of node.arguments) {
        if (ts.isStringLiteralLike(argument) && argument.text in ACTIONS) {
          actionIds.add(argument.text as ActionId)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(expression)
  return actionIds
}

function bindingFixture(files: Readonly<Record<string, string>>): {
  expression: ts.Expression
  bindings: RegistryBindings
} {
  const root = '/action-binding-fixture'
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
  }
  const virtual = new Map(Object.entries(files).map(([name, text]) => [
    `${root}/${name}`,
    text,
  ]))
  const base = ts.createCompilerHost(options)
  const host: ts.CompilerHost = {
    ...base,
    directoryExists: (directory) => (
      [...virtual.keys()].some((fileName) => fileName.startsWith(`${directory}/`))
      || base.directoryExists?.(directory)
      || false
    ),
    fileExists: (fileName) => virtual.has(fileName) || base.fileExists(fileName),
    readFile: (fileName) => virtual.get(fileName) ?? base.readFile(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const text = virtual.get(fileName)
      return text === undefined
        ? base.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(fileName, text, languageVersion, true)
    },
  }
  const program = ts.createProgram({
    rootNames: [...virtual.keys()],
    options,
    host,
  })
  const file = program.getSourceFile(`${root}/surface.ts`)
  if (!file) throw new Error('binding fixture has no surface.ts')
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name)
        && declaration.name.text === 'surface'
        && declaration.initializer
      ) {
        return {
          expression: declaration.initializer,
          bindings: bindingsFor(program, `${root}/actions.ts`),
        }
      }
    }
  }
  throw new Error('binding fixture has no surface expression')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mentionsTarget(
  copy: string,
  target: { name: string },
): boolean {
  const name = escapeRegExp(target.name)
  return new RegExp(`(?:^|[^A-Za-z0-9_])${name}(?=$|[^A-Za-z0-9_])`).test(copy)
}

function productionOperationalCopy(): OperationalCopyOccurrence[] {
  const surfaces = productionActionSurfaces()
  const bindings = productionActionAnalysis()
  const occurrences: OperationalCopyOccurrence[] = []
  for (const surface of surfaces) {
    const file = surface.expression.getSourceFile()
    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteralLike(node)
        || ts.isTemplateHead(node)
        || ts.isTemplateMiddle(node)
        || ts.isTemplateTail(node)
      ) {
        const start = node.getStart()
        let explicitlyReferenceOnly = false
        for (let parent = node.parent; parent && parent !== surface.expression.parent; parent = parent.parent) {
          if (
            ts.isCallExpression(parent)
            && bindings.references.has(resolveSymbol(bindings.checker, parent.expression) as ts.Symbol)
          ) {
            explicitlyReferenceOnly = true
            break
          }
        }
        if (!explicitlyReferenceOnly) {
          for (const [actionId, action] of Object.entries(ACTIONS) as [ActionId, (typeof ACTIONS)[ActionId]][]) {
            for (const target of action.operationalTargets) {
              if (!mentionsTarget(node.text, target)) continue
              occurrences.push({
                actionId,
                file: surface.file,
                line: file.getLineAndCharacterOfPosition(start).line + 1,
                surface,
                target: target.name,
              })
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(surface.expression)
  }
  return occurrences
}

function surfaceCopy(surface: ActionSurface): string {
  if (surface.kind === 'diagnose-verdict') {
    const verdict = ALL_VERDICTS.find((candidate) => candidate.id === surface.id)
    expect(verdict, `missing ${actionSurfaceLabel(surface)}`).toBeDefined()
    return verdict!.fix
  }
  if (surface.kind === 'scenario-beat') {
    const scenario = SCENARIOS.find((candidate) => candidate.id === surface.scenario)
    const beat = scenario?.beats?.find((candidate) => candidate[0] === surface.at)
    expect(beat, `missing ${actionSurfaceLabel(surface)}`).toBeDefined()
    return beat![2]
  }
  const docs = [...DOCS_MEMORY, ...DOCS_STORAGE]
  const entry = docs.find((candidate) => candidate.id === surface.doc)
  const section = entry?.sections.find((candidate) => candidate.heading === surface.section)
  expect(section, `missing ${actionSurfaceLabel(surface)}`).toBeDefined()
  return section!.body
}

function actionDisagreements(
  actionId: ActionId,
  rendered: ReadonlyMap<string, string>,
): string[] {
  const contract = ACTIONS[actionId]
  const expected = renderAction(actionId)
  return contract.surfaces.flatMap((surface) => {
    const label = actionSurfaceLabel(surface)
    const actual = rendered.get(label)
    if (actual?.includes(expected)) return []
    const agreeing = contract.surfaces
      .map(actionSurfaceLabel)
      .find((candidate) => rendered.get(candidate)?.includes(expected))
    return [`${actionId}: ${label} disagrees with ${agreeing ?? contract.owner}`]
  })
}

describe('operator action spine', () => {
  it('finds an exact operational target without classifying English verbs', () => {
    expect(mentionsTarget(
      'Constrain max_slot_wal_keep_size only after measuring retention and recovery cost.',
      { name: 'max_slot_wal_keep_size' },
    )).toBe(true)
  })

  it.each([
    {
      attack: 'shadows an aliased canonical import with the trusted spelling',
      files: {
        'actions.ts': "export function renderAction(id: string): string { return id }",
        'surface.ts': `
          import { renderAction as canonicalAction } from './actions'
          const renderAction = (id: string): string => id
          const surface = \`${'${'}renderAction('tuneAutovacuum')}\`
          void canonicalAction
        `,
      },
    },
    {
      attack: 'reassigns a local renderer before the call',
      files: {
        'actions.ts': "export function renderAction(id: string): string { return id }",
        'surface.ts': `
          import { renderAction as canonicalAction } from './actions'
          let renderAction = canonicalAction
          renderAction = (id: string): string => id
          const surface = \`${'${'}renderAction('tuneAutovacuum')}\`
        `,
      },
    },
    {
      attack: 'imports the trusted spelling through a fake re-export',
      files: {
        'actions.ts': "export function renderAction(id: string): string { return id }",
        'fake.ts': "export function renderAction(id: string): string { return id }",
        'bridge.ts': "export { renderAction } from './fake'",
        'surface.ts': `
          import { renderAction } from './bridge'
          const surface = \`${'${'}renderAction('tuneAutovacuum')}\`
        `,
      },
    },
    {
      attack: 'calls the canonical renderer through an indirect local',
      files: {
        'actions.ts': "export function renderAction(id: string): string { return id }",
        'surface.ts': `
          import * as actions from './actions'
          const renderAction = actions.renderAction
          const surface = \`${'${'}renderAction('tuneAutovacuum')}\`
        `,
      },
    },
  ])('rejects a delinked registry call that $attack', ({ files }) => {
    const fixture = bindingFixture(files)
    expect(registryCallsWithBindings(fixture.expression, fixture.bindings))
      .not.toContain('tuneAutovacuum')
  })

  it.each([
    {
      route: 'a direct import alias',
      files: {
        'actions.ts': "export function renderAction(id: string): string { return id }",
        'surface.ts': `
          import { renderAction as canonicalAction } from './actions'
          const surface = \`${'${'}canonicalAction('tuneAutovacuum')}\`
        `,
      },
    },
    {
      route: 'a genuine re-export',
      files: {
        'actions.ts': "export function renderAction(id: string): string { return id }",
        'bridge.ts': "export { renderAction } from './actions'",
        'surface.ts': `
          import { renderAction } from './bridge'
          const surface = \`${'${'}renderAction('tuneAutovacuum')}\`
        `,
      },
    },
  ])('accepts the canonical registry binding through $route', ({ files }) => {
    const fixture = bindingFixture(files)
    expect(registryCallsWithBindings(fixture.expression, fixture.bindings))
      .toContain('tuneAutovacuum')
  })

  it('wires every registered surface to its registry call', () => {
    const sources = new Map(productionActionSurfaces().map((surface) => [
      actionSurfaceLabel(surface.surface),
      surface,
    ]))

    for (const [actionId, action] of Object.entries(ACTIONS) as [ActionId, (typeof ACTIONS)[ActionId]][]) {
      for (const surface of action.surfaces) {
        const label = actionSurfaceLabel(surface)
        const production = sources.get(label)
        expect(production, `${actionId}: ${label} has no production copy expression`).toBeDefined()
        expect(
          production && registryCalls(production.expression),
          `${actionId}: ${label} contains rendered bytes but is not wired to ${action.owner}`,
        ).toContain(actionId)
      }
    }
  })

  it('classifies every exact target mention in a static action-capable surface', () => {
    /* This mechanical pass covers static verdict fixes, scenario beats and
     * inspector bodies. Dynamic copy, identifier-free paraphrases and exact
     * mentions explicitly marked by operationalReference are outside it. */
    const violations: string[] = []
    for (const occurrence of productionOperationalCopy()) {
      const action = ACTIONS[occurrence.actionId]
      const label = occurrence.surface
        ? actionSurfaceLabel(occurrence.surface.surface)
        : `source:${occurrence.file}:${occurrence.line}`
      const calls = occurrence.surface
        ? registryCalls(occurrence.surface.expression)
        : new Set<ActionId>()
      const registered = action.surfaces.some(
        (surface) => actionSurfaceLabel(surface) === label,
      )
      if (!registered || !calls.has(occurrence.actionId)) {
        violations.push(
          `${occurrence.file}:${occurrence.line} ${label} mentions ${occurrence.target} but bypasses ${action.owner}`,
        )
      }
    }
    expect([...new Set(violations)]).toEqual([])
  })

  it('renders every registered surface with its owned preconditions and risks', () => {
    for (const [actionId, action] of Object.entries(ACTIONS) as [ActionId, (typeof ACTIONS)[ActionId]][]) {
      expect(action.owner).toBe(`src/core/actions.ts#ACTIONS.${actionId}`)
      expect(action.preconditions.length, `${actionId} has no preconditions`).toBeGreaterThan(0)
      expect(action.risks.length, `${actionId} has no risks`).toBeGreaterThan(0)
      expect(action.surfaces.length, `${actionId} has no operator-facing surfaces`).toBeGreaterThan(1)

      const expected = renderAction(actionId)
      for (const surface of action.surfaces) {
        const label = actionSurfaceLabel(surface)
        const actual = surfaceCopy(surface)
        expect(
          actual,
          `${actionId}: ${label} disagrees with ${action.owner}`,
        ).toContain(expected)
        for (const precondition of action.preconditions) {
          expect(actual, `${actionId}: ${label} omits precondition ${precondition}`)
            .toContain(precondition)
        }
        for (const risk of action.risks) {
          expect(actual, `${actionId}: ${label} omits risk ${risk}`).toContain(risk)
        }
      }
    }
  })

  it('names both surfaces when a deliberate disagreement is introduced', () => {
    const actionId: ActionId = 'limitSlotWalRetention'
    const surfaces = ACTIONS[actionId].surfaces
    const rendered = new Map(surfaces.map((surface) => [
      actionSurfaceLabel(surface),
      renderAction(actionId),
    ]))
    const disagreeing = actionSurfaceLabel(surfaces[1])
    rendered.set(disagreeing, 'Set a cap and move on.')

    const [message] = actionDisagreements(actionId, rendered)
    expect(message).toContain(disagreeing)
    expect(message).toContain(actionSurfaceLabel(surfaces[0]))
  })

  it('finding 1: excludes paused recovery before prescribing replay capacity', () => {
    const sim = createSim(createBus())
    const collector = createCollector(sim)
    const [standby] = sim.state.replication.standbys
    standby.enabled = true
    standby.connected = true
    standby.flushedLsn = 10 * 1024 * 1024
    standby.appliedLsn = 1 * 1024 * 1024
    standby.replayPaused = true

    const step = ALL_STEPS.find((candidate) => candidate.id === 'replica.replay-state')
    expect(step?.sql).toContain('pg_is_wal_replay_paused()')
    expect(step?.sql).toContain("backend_type = 'startup'")
    expect(step?.sql).toContain('pg_stat_wal_receiver')
    expect(step?.look).toMatch(/standby log/i)
    expect(step?.branches.find((branch) => branch.next === 'v.replay_paused')
      ?.test(sim.state, collector)).toBe(true)
    expect(step?.branches.find((branch) => branch.next === 'v.replay')
      ?.test(sim.state, collector)).toBe(false)
    expect(PROJECTIONS.replay_state(sim.state, collector, 'total').rows)
      .toContainEqual(expect.objectContaining({
        key: standby.nodeId,
        cells: expect.objectContaining({
          replay_paused: expect.objectContaining({ v: 'true' }),
        }),
      }))
    expect(ACTIONS.restoreReplayCapacity.preconditions.join(' '))
      .toContain('pg_is_wal_replay_paused() is false')
  })

  it('finding 2: subtracts reserved connections from ordinary admission capacity', () => {
    const reservations = CLAIM_VALUES.connectionPooler.modelConnectionReservations
    expect(ordinaryConnectionCapacity(8, 3, 0)).toBe(5)
    expect(reservations).toEqual({ superuser: 3, reserved: 0 })

    const sim = createSim(createBus())
    const collector = createCollector(sim)
    sim.state.maxConnections = 8
    sim.state.superuserReservedConnections = 3
    sim.state.reservedConnections = 0
    for (let i = 0; i < sim.state.backends.length; i++) {
      sim.state.backends[i].state = i < 5 ? 'idle' : 'free'
    }
    const saturation = ALL_STEPS.find((candidate) => candidate.id === 'slow.1')
      ?.branches.find((branch) => branch.next === 'v.saturation')
    expect(saturation?.test(sim.state, collector)).toBe(true)
  })

  it('finding 3: carries the slot-cap destructive boundary on every surface', () => {
    const action = ACTIONS.limitSlotWalRetention
    expect(action.preconditions.join(' ')).toMatch(/ownership.*recovery intent.*archive/is)
    expect(action.risks.join(' ')).toMatch(/required WAL.*removed.*invalidat.*rebuild/is)
    for (const surface of action.surfaces) {
      expect(surfaceCopy(surface)).toContain(renderAction('limitSlotWalRetention'))
    }
  })

  it('finding 4: inspects and branches on per-table autovacuum disablement', () => {
    const sim = createSim(createBus())
    const collector = createCollector(sim)
    const table = sim.state.tables[0]
    table.autovacuumEnabled = false
    table.deadTuples = table.liveTuples
    table.lastVacuum = 0

    const step = ALL_STEPS.find((candidate) => candidate.id === 'bloat.autovacuum')
    expect(step?.sql).toContain('c.reloptions')
    expect(step?.sql).toContain('pg_options_to_table')
    expect(step?.sql).toMatch(/relkind.*partition/is)
    expect(step?.branches.find((branch) => branch.next === 'v.av_relation_off')
      ?.test(sim.state, collector)).toBe(true)
    expect(PROJECTIONS.autovacuum_settings(sim.state, collector, 'total').rows)
      .toContainEqual(expect.objectContaining({
        key: table.def.id,
        cells: expect.objectContaining({
          reloptions: '{autovacuum_enabled=false}',
        }),
      }))
  })

  it('finding 5: makes the worker change restart-only through 17 and reloadable on 18', () => {
    const specificity = ACTIONS.tuneAutovacuum.versionSpecificity
    expect(specificity).not.toBeNull()
    expect(specificity?.variants).toEqual([
      { from: 13, to: 17, context: 'postmaster', activation: 'server restart' },
      { from: 18, context: 'sighup', activation: 'configuration reload' },
    ])
    for (const surface of ACTIONS.tuneAutovacuum.surfaces) {
      const copy = surfaceCopy(surface)
      expect(copy).toMatch(/PostgreSQL 13.*17.*server restart/is)
      expect(copy).toMatch(/PostgreSQL 18.*configuration reload/is)
    }
  })
})
