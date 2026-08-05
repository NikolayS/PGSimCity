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
