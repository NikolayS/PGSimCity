import '../styles/city-words.css'

import { cityComponentHref } from '../core/city-route'
import { createCorrectionPath, displayedClaim } from '../core/corrections'
import { destinationForDistrict } from '../core/destinations'
import type { DistrictId } from '../core/types'
import { buildCityArchitecture } from './city-words-model'
import { MODE_IDS } from './mode-exits'
import { el, icon } from './uikit'
import type { UiContext, UiModule } from './uikit'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function createCityWords(ctx: UiContext): UiModule {
  const architecture = buildCityArchitecture()
  const cleanup: (() => void)[] = []
  const districtSections = new Map<string, HTMLElement>()
  const backgroundState = new Map<HTMLElement, boolean>()
  let open = false
  let lastFocus: HTMLElement | null = null

  const closeBtn = el(
    'button',
    {
      class: 'pg-btn city-words__close',
      type: 'button',
      data: { modeExit: MODE_IDS.cityWords },
      title: 'Close City in words  (Esc)',
      'aria-label': 'Close City in words',
      on: { click: () => setOpen(false) },
    },
    icon('close', 14),
    el('span', { text: 'Close' }),
  )

  function districtLink(id: string): HTMLAnchorElement {
    const destination = destinationForDistrict(id as DistrictId)
    const componentId = destination?.id ?? 'world.ground'
    return el(
      'a',
      {
        class: 'pg-btn city-words__visit',
        href: cityComponentHref(componentId),
        on: {
          click: () => {
            setOpen(false)
            ctx.bus.emit('select', { id: componentId })
            ctx.bus.emit('focus', { id: componentId })
          },
        },
      },
      'Open this district in the city',
    )
  }

  const districts = architecture.districts.map((district) => {
    const bounds = district.footprint.bounds
    const section = el(
      'section',
      {
        class: 'city-words__district',
        id: `city-words-${district.id}`,
        data: { cityDistrict: district.id },
        'aria-labelledby': `city-words-${district.id}-title`,
      },
      el(
        'header',
        { class: 'city-words__district-head' },
        el('h3', {
          class: 'city-words__district-title',
          id: `city-words-${district.id}-title`,
          text: district.name,
        }),
        el('code', { class: 'city-words__id', text: district.id }),
      ),
      el('p', { class: 'city-words__represents', text: district.represents }),
      el('p', { class: 'city-words__placement', text: district.placement }),
      el(
        'p',
        { class: 'city-words__footprint pg-mono' },
        `${district.footprint.width} m east–west × ${district.footprint.depth} m north–south`,
        el('span', {
          text: `x ${bounds.x[0]}…${bounds.x[1]} · z ${bounds.z[0]}…${bounds.z[1]}`,
        }),
      ),
      el('h4', { class: 'city-words__minor', text: 'Contains' }),
      el(
        'ul',
        { class: 'city-words__contains' },
        ...district.contains.map((item) => el('li', { text: item })),
      ),
      el(
        'p',
        { class: 'city-words__scale' },
        el('strong', { text: 'What the scale says: ' }),
        district.scaleMeaning,
      ),
      districtLink(district.id),
    )
    districtSections.set(district.id, section)
    return section
  })

  const districtNames = new Map(architecture.districts.map((district) => [district.id, district.name]))
  const relationships = architecture.relationships.map((relationship) =>
    el(
      'article',
      {
        class: 'city-words__relationship',
        data: { cityRelationship: relationship.id },
      },
      el('h3', {
        class: 'city-words__relationship-title',
        text: `${districtNames.get(relationship.from) ?? relationship.from} → ${districtNames.get(relationship.to) ?? relationship.to}`,
      }),
      el('p', {}, el('strong', { text: 'Placement: ' }), relationship.placement),
      el('p', {}, el('strong', { text: 'Why it matters: ' }), relationship.why),
    ),
  )

  const limit = el(
    'section',
    {
      class: 'city-words__limit',
      'aria-labelledby': 'city-words-limit-title',
    },
    el('h2', { class: 'city-words__section-title', id: 'city-words-limit-title', text: 'What this text cannot carry' }),
    el('p', { text: architecture.limit }),
  )

  const body = el(
    'div',
    { class: 'pg-panel__body city-words__body pg-scroll' },
    el(
      'section',
      { class: 'city-words__intro', 'aria-labelledby': 'city-words-reading-title' },
      el('h2', { class: 'city-words__section-title', id: 'city-words-reading-title', text: 'Reading the plan' }),
      el('p', { text: architecture.scope }),
      el('p', { class: 'city-words__orientation pg-mono', text: architecture.orientation }),
      el('p', { text: architecture.overview }),
    ),
    el('h2', { class: 'city-words__section-title', text: 'Districts and containment' }),
    el('div', { class: 'city-words__districts' }, ...districts),
    el('h2', { class: 'city-words__section-title', text: 'Meaningful adjacencies and routes' }),
    el('div', { class: 'city-words__relationships' }, ...relationships),
    limit,
  )

  const dialog = el(
    'div',
    {
      class: 'city-words__dialog pg-panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'city-words-title',
      tabindex: '-1',
      data: {
        analyticsPanel: 'city-words',
        correctionSubject: 'city-architecture',
      },
    },
    el(
      'header',
      { class: 'pg-panel__head city-words__head' },
      el(
        'div',
        { class: 'city-words__heading' },
        el('span', { class: 'pg-eyebrow', text: 'PostgreSQL architecture diagram' }),
        el('h1', { class: 'pg-title', id: 'city-words-title', text: 'The city in words' }),
        el('p', { class: 'pg-sub', text: 'The geography from layout.ts, with the reason each adjacency matters' }),
      ),
      closeBtn,
    ),
    body,
  )
  createCorrectionPath(dialog, {
    surface: 'City / City in words',
    panel: 'PostgreSQL architecture diagram',
    source: 'src/world/layout.ts; src/spine/city-architecture.ts; src/ui/city-words-model.ts',
    claim: () => displayedClaim(body),
    claimCaptureNote: 'The district footprints and coordinate text are generated from src/world/layout.ts.',
  })

  const overlay = el('div', { class: 'city-words', hidden: true }, dialog)
  document.body.append(overlay)

  function focusables(): HTMLElement[] {
    return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (node) => !node.closest('[inert]') && (node.offsetParent !== null || node === dialog),
    )
  }

  function isolateBackground(next: boolean): void {
    for (const selector of ['#stage', '#hud']) {
      const node = document.querySelector<HTMLElement>(selector)
      if (!node) continue
      if (next) {
        backgroundState.set(node, node.inert)
        node.inert = true
      } else {
        node.inert = backgroundState.get(node) ?? false
      }
    }
    if (!next) backgroundState.clear()
  }

  function setOpen(next: boolean, district?: DistrictId): void {
    if (next === open) {
      if (next && district) {
        requestAnimationFrame(() => districtSections.get(district)?.scrollIntoView({ block: 'start' }))
      }
      return
    }
    if (next) {
      lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
    open = next
    overlay.hidden = !next
    if (next) limit.dataset.disclosure = 'city-words-limit'
    else delete limit.dataset.disclosure
    document.body.classList.toggle('pg-city-words-open', next)
    isolateBackground(next)
    if (next) {
      ctx.bus.emit('panel:open', { panel: 'city-words' })
      ctx.bus.emit('ui:help', { open: false })
      ctx.bus.emit('ui:palette', { open: false })
      requestAnimationFrame(() => {
        if (!open) return
        const section = district ? districtSections.get(district) : undefined
        section?.scrollIntoView({ block: 'start' })
        closeBtn.focus()
      })
    } else {
      const back = lastFocus
      lastFocus = null
      if (back && document.contains(back) && back !== document.body) back.focus()
    }
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) setOpen(false)
  })

  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      return
    }
    if (event.key !== 'Tab') return
    const list = focusables()
    if (list.length === 0) return
    const first = list[0]
    const last = list[list.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  })

  cleanup.push(
    ctx.bus.on('ui:city-words', (request) => {
      setOpen(request.open ?? (request.district ? true : !open), request.district)
    }),
    ctx.bus.on('ui:escape', (payload) => {
      if (!open) return
      setOpen(false)
      payload.handled = true
    }),
    ctx.bus.on('tour:start', () => setOpen(false)),
  )

  function update(_dt: number): void {
    void _dt
  }

  function dispose(): void {
    for (const off of cleanup) off()
    cleanup.length = 0
    setOpen(false)
    overlay.remove()
  }

  return { update, dispose }
}
