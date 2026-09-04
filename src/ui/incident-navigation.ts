import { cityComponentId } from '../core/city-route'
import { writeIncidentHandoff } from '../core/incident-handoff'
import type { IncidentContext, IncidentDestination } from '../core/incident-handoff'
import type { Bus } from '../core/types'
import type { IncidentReplay } from '../sim/replay'

export function incidentDiagnosticCaption(linked: boolean, stagedName?: string): string {
  if (linked) return 'Inspecting the linked city incident. Choosing a complaint has not changed its workload.'
  return stagedName ? `${stagedName} — the model is running this configuration so you can read it live. Every knob on the page is still yours.` : 'free running'
}

export function showIncidentError(message: string, parent: HTMLElement = document.body): HTMLElement {
  const panel = document.createElement('section')
  panel.setAttribute('role', 'alert')
  panel.className = 'incident-navigation-message'
  panel.style.cssText = 'padding:16px;background:#182330;color:#fff;border:2px solid #e6af57;position:relative;z-index:10000;font:16px/1.5 system-ui;max-width:760px'
  panel.textContent = `Incident not transferred. ${message}. No replacement incident has been started.`
  const restart = document.createElement('a')
  restart.href = /\/observability\/?$/.test(location.pathname) ? '../' : './'
  restart.textContent = 'Open a new city instead (discard this transfer)'
  restart.style.cssText = 'display:block;color:#b9e3ff;margin-top:12px'
  panel.append(restart)
  parent.prepend(panel)
  return panel
}

export function transferIncident(options: {
  replay: IncidentReplay; destination: IncidentDestination; context: IncidentContext; href: string
}): boolean {
  try {
    const target = new URL(options.href, location.href)
    if (target.origin !== location.origin) throw new Error('Incident navigation must stay on this site')
    writeIncidentHandoff(() => sessionStorage, options.replay, options.destination, options.context)
    target.hash = 'incident'
    location.assign(target.href)
    return true
  } catch (error) {
    showIncidentError(error instanceof Error ? error.message : 'Tab storage is unavailable')
    return false
  }
}

/** Same-tab navigation only: browser new-tab commands must not imply continuity. */
export function installCityIncidentNavigation(options: {
  replay: IncidentReplay; bus: Bus; context?: IncidentContext
}): () => void {
  const context: IncidentContext = { ...options.context }
  const off = options.bus.on('select', ({ id }) => { context.selected = id ?? undefined })
  const click = (event: MouseEvent): void => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null
    if (!anchor || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
      || anchor.target === '_blank' || anchor.hasAttribute('download')) return
    const target = new URL(anchor.href, location.href)
    if (target.origin !== location.origin || !/\/observability\/?$/.test(target.pathname)
      || target.searchParams.get('view') === 'flow') return
    event.preventDefault()
    transferIncident({ replay: options.replay, destination: 'diagnose', context, href: target.href })
  }
  document.addEventListener('click', click, true)
  return () => { off(); document.removeEventListener('click', click, true) }
}

export function incidentCitySelection(href: string, fallback: string | undefined): string | undefined {
  return cityComponentId(new URL(href, location.href).hash) ?? fallback
}
