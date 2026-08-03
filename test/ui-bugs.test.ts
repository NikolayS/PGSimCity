import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BUILD_LABEL } from '../src/core/build'
import { createBus } from '../src/core/bus'
import { DESTINATIONS } from '../src/core/destinations'
import { setThemeMode, storedThemeMode, themeMode } from '../src/core/theme'
import { DEFAULT_MODE, THEME_STORAGE_KEY } from '../src/core/themes'
import {
  DEFAULT_KNOBS,
  SHARED_BUFFERS_MAX_MIB,
  SHARED_BUFFERS_MIN_MIB,
} from '../src/core/types'
import { traceStopBit } from '../src/core/model-helpers'
import { createSim } from '../src/sim/model'
import { recordRepresentativeUpdate } from '../src/sim/mvcc'
import { createAnatomy } from '../src/ui/anatomy'
import { knobMeta } from '../src/ui/content'
import {
  createControls,
  createKnobControl,
  KNOB_PREFERENCES_STORAGE_KEY,
} from '../src/ui/controls'
import { createHud } from '../src/ui/hud'
import { createHelp } from '../src/ui/help'
import { createInspector } from '../src/ui/panel'
import { createTour } from '../src/ui/tour'
import type { UiContext } from '../src/ui/uikit'
import { installTestDom } from './dom'

function context(): UiContext {
  const bus = createBus()
  return {
    bus,
    sim: createSim(bus),
    registry: { get: () => undefined } as UiContext['registry'],
    getFps: () => 60,
    getQuality: () => ({
      level: 'high',
      pixelRatio: 1,
      bloom: true,
      shadows: true,
      maxParticles: 1,
      maxLabels: 1,
      antialias: true,
    }),
    getFlowStats: () => ({ active: 0, dropped: 0 }),
  }
}

describe('shared_buffers control', () => {
  beforeEach(() => {
    installTestDom()
  })

  it('uses the declared MiB range in the native slider', () => {
    const ctx = context()
    const control = createKnobControl(ctx, knobMeta('sharedBuffers')!)
    const input = control.root.querySelector('input[type="range"]') as unknown as HTMLInputElement

    expect(input.min).toBe(String(SHARED_BUFFERS_MIN_MIB))
    expect(input.max).toBe(String(SHARED_BUFFERS_MAX_MIB))
    expect(input.value).toBe(String(DEFAULT_KNOBS.sharedBuffers))
  })

  it('round-trips values across the entire declared range without model clamping', () => {
    const ctx = context()
    const control = createKnobControl(ctx, knobMeta('sharedBuffers')!)
    const input = control.root.querySelector('input[type="range"]') as unknown as HTMLInputElement

    for (const value of [128, 512, 1024, 2048, 8192, 32768, 65536]) {
      ctx.sim.setKnob('sharedBuffers', value)
      control.sync(true)
      expect(ctx.sim.state.knobs.sharedBuffers).toBe(value)
      expect(Number(input.value)).toBe(value)
      input.dispatchEvent(new Event('input'))
      expect(ctx.sim.state.knobs.sharedBuffers).toBe(value)
    }
  })

  it('does not change a 2 GiB setting when the untouched control is first activated', () => {
    const ctx = context()
    const setKnob = vi.spyOn(ctx.sim, 'setKnob')
    const control = createKnobControl(ctx, knobMeta('sharedBuffers')!)
    const input = control.root.querySelector('input[type="range"]') as unknown as HTMLInputElement

    expect(ctx.sim.state.knobs.sharedBuffers).toBe(2048)
    expect(setKnob).not.toHaveBeenCalled()

    input.dispatchEvent(new Event('pointerdown'))
    window.dispatchEvent(new Event('pointerup'))
    expect(ctx.sim.state.knobs.sharedBuffers).toBe(2048)
    expect(setKnob).not.toHaveBeenCalled()

    input.dispatchEvent(new Event('input'))
    expect(ctx.sim.state.knobs.sharedBuffers).toBe(2048)
  })
})

describe('standby knob preference migration', () => {
  it('loads old replica-prefixed values as standby A preferences', () => {
    const dom = installTestDom()
    dom.mount('hud-left')
    window.localStorage.setItem(KNOB_PREFERENCES_STORAGE_KEY, JSON.stringify({
      replicaEnabled: false,
      replicaNetworkLag: 175,
      replicaSlowApply: true,
      standbyLongQuery: true,
      synchronousStandbyNames: false,
    }))
    const ctx = context()

    const controls = createControls(ctx)

    expect(ctx.sim.state.knobs.standbyAEnabled).toBe(false)
    expect(ctx.sim.state.knobs.standbyANetworkLag).toBe(175)
    expect(ctx.sim.state.knobs.standbyASlowApply).toBe(true)
    expect(ctx.sim.state.knobs.standbyALongQuery).toBe(true)
    expect(ctx.sim.state.knobs.synchronousStandbyNames).toBe('none')
    expect(JSON.parse(window.localStorage.getItem(KNOB_PREFERENCES_STORAGE_KEY)!)).toEqual({
      standbyAEnabled: false,
      standbyANetworkLag: 175,
      standbyASlowApply: true,
      standbyALongQuery: true,
      synchronousStandbyNames: 'none',
    })
    controls.dispose()
  })
})

describe('storage anatomy entry points', () => {
  beforeEach(() => {
    const dom = installTestDom()
    dom.mount('hud-right')
  })

  it('renders reachable page and directory actions in the data-directory inspector', () => {
    const ctx = context()
    const opened: { view: 'page' | 'directory'; id?: string }[] = []
    ctx.bus.on('anatomy:open', (event) => opened.push(event))
    createInspector(ctx)

    ctx.bus.emit('select', { id: 'storage.datadir' })
    const directory = document.querySelector('[data-anatomy-entry="directory"] button') as HTMLButtonElement | null
    const page = document.querySelector('[data-anatomy-entry="page"] button') as HTMLButtonElement | null
    expect(directory).not.toBeNull()
    expect(page).not.toBeNull()

    directory!.click()
    page!.click()
    expect(opened).toEqual([
      { view: 'directory', id: 'storage.datadir' },
      { view: 'page', id: 'storage.datadir' },
    ])
  })

  it.each([
    ['heap files', 'storage.table.accounts'],
    ['indexes', 'storage.index.accounts_pkey'],
    ['TOAST', 'storage.toast'],
  ])('offers and activates page anatomy from %s', (_label, id) => {
    const ctx = context()
    const opened = vi.fn()
    ctx.bus.on('anatomy:open', opened)
    createInspector(ctx)

    ctx.bus.emit('select', { id })
    const button = document.querySelector('[data-anatomy-entry="page"] button') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    button!.click()
    expect(opened).toHaveBeenCalledWith({ view: 'page', id })
  })
})

describe('restore drill evidence', () => {
  beforeEach(() => {
    const dom = installTestDom()
    dom.mount('hud-right')
  })

  it('states the supported claim, its limit, cadence, restore time, and modeled cost', () => {
    const ctx = context()
    const start = vi.spyOn(ctx.sim, 'startRestoreDrill')
    const inspector = createInspector(ctx)

    ctx.bus.emit('select', { id: 'recovery.ground' })

    const control = document.querySelector<HTMLElement>('[data-restore-drill="control"]')
    const level = control?.querySelector<HTMLSelectElement>('select')
    const button = control?.querySelector<HTMLButtonElement>('button')
    expect(control).not.toBeNull()
    expect(level?.querySelectorAll('option')).toHaveLength(3)
    expect(control?.textContent).toContain('Proved')
    expect(control?.textContent).toContain('Did not prove')
    expect(control?.textContent).toContain('Cadence')
    expect(control?.textContent).toContain('Restore-to-target')
    expect(control?.querySelector('.pgc-drill__result')?.textContent).not.toContain('RTO')
    expect(control?.textContent).toContain('Object-store reads')
    expect(control?.querySelectorAll('[data-disclosure]')).not.toHaveLength(0)

    level!.value = 'table'
    level!.dispatchEvent(new Event('change'))
    button!.click()
    expect(start).toHaveBeenCalledWith('table')
    expect(control?.textContent).toMatch(/FAIL.*no retained full backup/i)

    level!.value = 'cluster'
    level!.dispatchEvent(new Event('change'))
    expect(control?.textContent).toMatch(/One-table smoke.*FAIL.*no retained full backup/i)
    expect(control?.textContent).not.toMatch(/not measured/i)

    inspector.dispose()
  })
})

describe('page anatomy MVCC story', () => {
  beforeEach(() => {
    installTestDom()
  })

  it('shows two snapshots selecting different physical versions after UPDATE', () => {
    const ctx = context()
    const sessions = ctx.sim.state.tables.findIndex(
      (table) => table.def.id === 'sessions',
    )
    ctx.sim.setKnob('longRunningXact', true)
    ctx.sim.request('update', sessions, { hot: false })
    for (let tick = 0; tick < 900; tick++) {
      ctx.sim.update(1 / 30)
      if (
        ctx.sim.state.trace.stop === 'done'
        && (ctx.sim.state.trace.visited & traceStopBit('done')) !== 0
      ) {
        break
      }
    }

    const anatomy = createAnatomy(ctx)
    ctx.bus.emit('anatomy:open', {
      view: 'page',
      id: 'storage.table.sessions',
    })

    const versions = document.querySelectorAll('.an-mvcc-version')
    const older = document.querySelector('.an-mvcc-snapshot--older')
    const later = document.querySelector('.an-mvcc-snapshot--later')
    const cutoff = document.querySelector('.an-mvcc-cutoff')
    expect(versions.length).toBeGreaterThanOrEqual(2)
    expect(older?.textContent).toContain(
      `v${ctx.sim.state.tables[sessions].mvcc.earlierSnapshot.visibleRevision}`,
    )
    expect(later?.textContent).toContain(
      `v${ctx.sim.state.tables[sessions].mvcc.laterSnapshot.visibleRevision}`,
    )
    expect(older?.textContent).not.toBe(later?.textContent)
    expect(cutoff?.textContent).toContain(
      ctx.sim.state.xminHorizon.toLocaleString(),
    )
    anatomy.dispose()
  })

  it('keeps a HOT successor under the root index TID and shows both tuple flags', () => {
    const ctx = context()
    const sessions = ctx.sim.state.tables.findIndex(
      (table) => table.def.id === 'sessions',
    )
    const row = ctx.sim.state.tables[sessions].mvcc
    const initialXid = row.versions[row.versions.length - 1].xmin
    recordRepresentativeUpdate(row, initialXid + 1, 1, true)
    recordRepresentativeUpdate(row, initialXid + 2, 2, true)

    const anatomy = createAnatomy(ctx)
    ctx.bus.emit('anatomy:open', { view: 'page', id: 'storage.table.sessions' })
    const intermediate = row.versions.find((version) => version.hot && version.nextHot)!
    const button = document.querySelector<HTMLButtonElement>(
      `[data-mvcc-revision="${intermediate.revision}"]`,
    )!
    button.click()

    expect(document.querySelector('.an-hot-chain__index')?.textContent).toContain(
      `(${intermediate.indexBlock},${intermediate.indexOffset})`,
    )
    const flags = document.querySelector('.an-tuple-field--t_infomask2')?.textContent ?? ''
    expect(flags).toContain('HOT_UPDATED')
    expect(flags).toContain('HEAP_ONLY_TUPLE')
    anatomy.dispose()
  })

  it('draws tuple bodies only for body-bearing line pointers', () => {
    const ctx = context()
    const table = ctx.sim.state.tables.find((candidate) => candidate.def.id === 'sessions')!
    table.updates = 100
    table.hotUpdates = 100
    table.liveTuples = Math.floor(table.pages * table.def.tuplesPerPage * 0.7)
    table.deadTuples = Math.floor(table.liveTuples * 0.2)
    table.bloat = table.deadTuples / (table.liveTuples + table.deadTuples)

    const anatomy = createAnatomy(ctx)
    ctx.bus.emit('anatomy:open', { view: 'page', id: 'storage.table.sessions' })
    const pointers = document.querySelectorAll('.an-pointer').length
    const bodyless = document.querySelectorAll('.an-pointer--redirect').length
      + document.querySelectorAll('.an-pointer--unused').length
    const bodies = document.querySelectorAll('.an-tuple-block').length

    expect(bodyless).toBeGreaterThan(0)
    expect(bodies).toBe(pointers - bodyless)
    anatomy.dispose()
  })
})

describe('theme toggle entry point', () => {
  beforeEach(() => {
    const dom = installTestDom()
    for (const id of ['hud-top', 'hud-bottom', 'toast-stack', 'compass']) dom.mount(id)
    setThemeMode('night', { persist: false })
  })

  it('changes and persists the visible HUD theme control', () => {
    const hud = createHud(context())
    const button = document.querySelector('#hud-top .hud-theme') as HTMLButtonElement | null

    expect(button).not.toBeNull()
    expect(button!.textContent).toContain('Night')
    expect(button!.title).toContain('(N)')
    expect(themeMode()).toBe('night')

    button!.dispatchEvent(new Event('click'))

    expect(themeMode()).toBe('day')
    expect(document.documentElement.dataset.theme).toBe('day')
    expect(storedThemeMode()).toBe('day')
    expect(button!.textContent).toContain('Day')

    button!.dispatchEvent(new Event('click'))

    expect(themeMode()).toBe('clock')
    expect(storedThemeMode()).toBe('clock')
    expect(button!.textContent).toContain('Local time')
    expect(button!.title).toContain('no location used')
    hud.dispose()
  })

  it('falls back safely when the stored theme is unknown', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'future-theme')
    expect(storedThemeMode()).toBe(DEFAULT_MODE)
  })

  it('exposes working touch routes for labels and camera presets', () => {
    const ctx = context()
    const presets = vi.fn()
    const focuses = vi.fn()
    ctx.bus.on('ui:camera-preset', presets)
    ctx.bus.on('focus', focuses)

    const hud = createHud(ctx)
    const view = document.querySelector('.hud-view-toggle') as HTMLButtonElement | null
    expect(view).not.toBeNull()
    view!.dispatchEvent(new Event('click'))

    const panel = document.querySelector('.hud-view-panel') as HTMLElement | null
    expect(panel).not.toBeNull()
    expect(panel!.hidden).toBe(false)

    const labelToggle = document.querySelector('[data-view-action="labels"]') as HTMLButtonElement | null
    const home = document.querySelector('[data-view-action="home"]') as HTMLButtonElement | null
    const overview = document.querySelector('[data-view-action="overview"]') as HTMLButtonElement | null
    expect(labelToggle).not.toBeNull()
    expect(home).not.toBeNull()
    expect(overview).not.toBeNull()

    labelToggle!.dispatchEvent(new Event('click'))
    expect(document.body.classList.contains('pg-labels-off')).toBe(true)

    home!.dispatchEvent(new Event('click'))
    expect(focuses).toHaveBeenCalledWith({ id: 'world.ground' })

    overview!.dispatchEvent(new Event('click'))
    expect(presets).toHaveBeenCalledWith({ preset: 'plan' })
    hud.dispose()
  })

  it('exposes every hidden-phone district destination as a button', () => {
    const ctx = context()
    const focuses: string[] = []
    ctx.bus.on('focus', ({ id }) => {
      if (id) focuses.push(id)
    })
    const hud = createHud(ctx)
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-view-district]'),
    )

    expect(buttons).toHaveLength(8)
    for (const button of buttons) button.dispatchEvent(new Event('click'))
    expect(focuses).toEqual([
      'client.pool',
      'backend.row',
      'shared.buffers',
      'wal.vault',
      'storage.datadir',
      'planner.lab',
      'checkpointer',
      'replica.standby',
    ])
    expect(buttons.map((button) => button.textContent.replace(/^\d+/, ''))).toEqual([
      'Clients',
      'Backends',
      'Buffer pool (shared_buffers)',
      'WAL',
      'Storage',
      'Query lab',
      'Maintenance',
      'Standby',
    ])
    hud.dispose()
  })

  it('uses semantic glyphs and accessible names for icon-only top-bar actions', () => {
    const hud = createHud(context())
    const iconOnly = Array.from(
      document.querySelectorAll<HTMLElement>('#hud-top .hud-tools .pg-btn--icon'),
    )

    expect(iconOnly.length).toBeGreaterThan(0)
    for (const control of iconOnly) {
      expect(control.title).not.toBe('')
      expect(control.getAttribute('aria-label')).not.toBeNull()
    }

    const controls = [
      ...Array.from(document.querySelectorAll<HTMLElement>('#hud-top .hud-tools button')),
      ...Array.from(document.querySelectorAll<HTMLElement>('#hud-top .hud-tools a')),
    ]
    const glyph = (label: string) =>
      controls.find((control) => control.getAttribute('aria-label') === label)?.querySelector('svg')?.dataset.icon
    expect(glyph('Guided tour')).toBe('tour')
    expect(glyph('Walk the city')).toBe('walk')
    expect(glyph('Diagnose')).toBe('diagnose')
    hud.dispose()
  })

  it('reports one canonical name across navigation, help, and destination inspectors', () => {
    const helpRoot = document.createElement('div')
    helpRoot.id = 'help-overlay'
    document.body.append(helpRoot)
    const inspectorRoot = document.createElement('div')
    inspectorRoot.id = 'hud-right'
    document.body.append(inspectorRoot)

    const ctx = context()
    const hud = createHud(ctx)
    const help = createHelp(ctx)
    const inspector = createInspector(ctx)
    const names = DESTINATIONS.map((destination) => destination.name)

    expect(
      Array.from(document.querySelectorAll<HTMLElement>('[data-view-district]')).map((button) =>
        button.textContent.replace(/^\d+/, ''),
      ),
    ).toEqual(names)
    expect(document.querySelector('.help-districts')?.textContent).toContain(names.join(' · '))
    expect(document.querySelector('.help-build')?.textContent).toBe(`PGSimCity ${BUILD_LABEL}`)

    for (const destination of DESTINATIONS) {
      ctx.bus.emit('select', { id: destination.id })
      expect(document.querySelector('.pgc-insp__title')?.textContent).toBe(destination.name)
    }

    inspector.dispose()
    help.dispose()
    hud.dispose()
  })
})

describe('camera rotate discovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    const dom = installTestDom()
    for (const id of ['hud-top', 'hud-bottom', 'toast-stack', 'compass']) dom.mount(id)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows a first-pan rotate hint and does not show it after dismissal', () => {
    const ctx = context()
    const hud = createHud(ctx)

    ctx.bus.emit('camera:gesture', { kind: 'pan', pointer: 'mouse' })
    const hint = document.querySelector<HTMLButtonElement>('.hud-rotate-hint')
    expect(hint?.textContent).toContain('Shift')

    hint!.click()
    vi.advanceTimersByTime(241)
    ctx.bus.emit('camera:gesture', { kind: 'pan', pointer: 'mouse' })
    expect(document.querySelector('.hud-rotate-hint')).toBeNull()
    hud.dispose()
  })

  it('explains the two-finger rotate gesture after a first touch pan', () => {
    const ctx = context()
    const hud = createHud(ctx)

    ctx.bus.emit('camera:gesture', { kind: 'pan', pointer: 'touch' })
    expect(document.querySelector('.hud-rotate-hint')?.textContent).toContain('two fingers')
    expect(document.querySelector('.hud-rotate-hint')?.textContent).toContain('twist')
    hud.dispose()
  })
})

describe('city-first panel state', () => {
  beforeEach(() => {
    const dom = installTestDom()
    dom.mount('hud-left')
    dom.mount('hud-right')
  })

  it('collapses both side panels on a first visit and restores explicit choices', () => {
    const ctx = context()
    let controls = createControls(ctx)
    let inspector = createInspector(ctx)

    const left = () => document.querySelector('.pgc-host--left') as HTMLElement
    const right = () => document.querySelector('.pgc-host--right') as HTMLElement
    expect(left().classList.contains('is-open')).toBe(false)
    expect(right().classList.contains('is-open')).toBe(false)
    expect(document.querySelector('.pgc-tab--left')?.textContent).toContain('Console')
    expect(document.querySelector('.pgc-tab--right')?.textContent).toContain('Inspector')

    ;(document.querySelector('.pgc-tab--left') as HTMLButtonElement).click()
    ;(document.querySelector('.pgc-tab--right') as HTMLButtonElement).click()
    expect(window.localStorage.getItem('pgsimcity.console.open')).toBe('1')
    expect(window.localStorage.getItem('pgsimcity.inspector.open')).toBe('1')

    controls.dispose()
    inspector.dispose()
    controls = createControls(ctx)
    inspector = createInspector(ctx)
    expect(left().classList.contains('is-open')).toBe(true)
    expect(right().classList.contains('is-open')).toBe(true)

    ;(document.querySelector('.pgc-rail__collapse') as HTMLButtonElement).click()
    ;(document.querySelector('.pgc-insp__close') as HTMLButtonElement).click()
    expect(window.localStorage.getItem('pgsimcity.console.open')).toBe('0')
    expect(window.localStorage.getItem('pgsimcity.inspector.open')).toBe('0')

    controls.dispose()
    inspector.dispose()
  })

  it('opens the inspector for a selection and dismisses it with one empty instruction', () => {
    const ctx = context()
    const inspector = createInspector(ctx)
    const host = document.querySelector('.pgc-host--right') as HTMLElement

    expect(host.classList.contains('is-open')).toBe(false)
    expect(document.querySelector('.pgc-empty__lead')).toBeNull()

    ctx.bus.emit('select', { id: 'shared.buffers' })
    expect(host.classList.contains('is-open')).toBe(true)

    ctx.bus.emit('select', { id: null })
    expect(host.classList.contains('is-open')).toBe(false)

    ctx.bus.emit('select', { id: 'shared.buffers' })
    ;(document.querySelector('.pgc-insp__close') as HTMLButtonElement).click()
    expect(host.classList.contains('is-open')).toBe(false)
    expect(document.querySelector('.pgc-insp__title')?.textContent).toBe('Nothing selected')
    expect(document.querySelector('.pgc-insp__sub')?.textContent).toBe('Click a building to open it up')

    inspector.dispose()
  })

  it('connects the panel tabs to named panels and returns focus when a panel closes', () => {
    const ctx = context()
    const controls = createControls(ctx)
    const inspector = createInspector(ctx)
    const consoleTab = document.querySelector('.pgc-tab--left') as HTMLButtonElement
    const consolePanel = document.querySelector('.pgc-rail') as HTMLElement
    const inspectorTab = document.querySelector('.pgc-tab--right') as HTMLButtonElement
    const inspectorPanel = document.querySelector('.pgc-insp') as HTMLElement

    expect(consoleTab.getAttribute('aria-controls')).toBe(consolePanel.id)
    expect(consolePanel.getAttribute('aria-labelledby')).toBe(consoleTab.id)
    expect(inspectorTab.getAttribute('aria-controls')).toBe(inspectorPanel.id)
    expect(inspectorPanel.getAttribute('aria-labelledby')).toContain(inspectorTab.id)

    consoleTab.click()
    ;(document.querySelector('.pgc-rail__collapse') as HTMLButtonElement).click()
    expect(document.activeElement).toBe(consoleTab)

    ctx.bus.emit('select', { id: 'shared.buffers' })
    ;(document.querySelector('.pgc-insp__close') as HTMLButtonElement).click()
    expect(document.activeElement).toBe(inspectorTab)

    inspector.dispose()
    controls.dispose()
  })
})

describe('HUD teaching routes', () => {
  beforeEach(() => {
    const dom = installTestDom()
    for (const id of ['hud-top', 'hud-bottom', 'toast-stack', 'compass', 'hud-right']) dom.mount(id)
  })

  it('opens the matching text inspector when a keyboard-operable vital is activated', () => {
    const ctx = context()
    const focuses = vi.fn()
    const selections = vi.fn()
    ctx.bus.on('focus', focuses)
    ctx.bus.on('select', selections)
    const inspector = createInspector(ctx)
    const hud = createHud(ctx)

    const tps = document.querySelector('.hud-vital') as HTMLButtonElement
    expect(tps.getAttribute('aria-label')).toContain('inspector')
    expect(tps.getAttribute('aria-label')).toContain(
      tps.querySelector('.hud-vital__v')?.textContent,
    )
    const checkpoint = document.querySelector('.hud-ckpt') as HTMLButtonElement
    expect(checkpoint.getAttribute('aria-label')).toContain(
      checkpoint.querySelector('.hud-ckpt__state')?.textContent,
    )
    tps.click()

    expect(focuses).toHaveBeenCalledWith({ id: 'backend.row' })
    expect(selections).toHaveBeenCalledWith({ id: 'backend.row' })
    expect(document.querySelector('.pgc-host--right')?.classList.contains('is-open')).toBe(true)

    hud.dispose()
    inspector.dispose()
  })
})

describe('first-visit tour entry point', () => {
  beforeEach(() => {
    const dom = installTestDom()
    dom.mount('tour-layer')
  })

  it('shows one immediate, text-labelled invitation and does not repeat it', () => {
    const ctx = context()
    let tour = createTour(ctx)
    const invitation = document.querySelector('.tour-first') as HTMLElement
    const start = document.querySelector('.tour-first__go') as HTMLButtonElement

    expect(invitation.classList.contains('is-live')).toBe(true)
    expect(start.textContent).toContain('Start the tour')
    expect(window.localStorage.getItem('pgsimcity.seen')).toBe('1')

    tour.dispose()
    tour = createTour(ctx)
    expect((document.querySelector('.tour-first') as HTMLElement).classList.contains('is-live')).toBe(false)
    tour.dispose()
  })

  it('moves focus into the lesson controls and restores the tour opener', () => {
    const ctx = context()
    const opener = document.createElement('button')
    opener.className = 'hud-tour'
    document.body.append(opener)
    const tour = createTour(ctx)

    opener.focus()
    ctx.bus.emit('tour:start', { source: 'button' })
    expect(document.activeElement).toBe(document.querySelector('.tour-next'))

    ctx.bus.emit('tour:stop', {})
    expect(document.activeElement).toBe(opener)
    tour.dispose()
  })
})
