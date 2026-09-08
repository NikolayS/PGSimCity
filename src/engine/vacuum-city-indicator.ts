import * as THREE from 'three'
import type { UiContext, UiModule } from '../ui/uikit'
import { el, setText } from '../ui/uikit'
import { vacuumCityReading, vacuumIndicatorSpace } from '../ui/vacuum-city-state'
import '../styles/vacuum-city-indicator.css'

/* A screen-readable annotation with explicit leaders to real scene objects.
 * Its retained count belongs to the current attempt, never to a saved card. */
export function createVacuumCityIndicator(ctx: UiContext, camera: THREE.PerspectiveCamera,
  isOpen: () => boolean): UiModule {
  const count = el('strong')
  const work = el('span')
  const title = el('span', { class: 'vacuum-city-indicator__title' })
  const badge = el('div', { class: 'vacuum-city-indicator__badge' },
    title, count, work)
  const root = el('div', { class: 'vacuum-city-indicator', hidden: true }, badge)
  const tableDot = el('div', { class: 'vacuum-city-indicator__dot', data: { vacuumCityAnchor: 'table' } })
  const workerDot = el('div', { class: 'vacuum-city-indicator__dot vacuum-city-indicator__dot--worker', data: { vacuumCityAnchor: 'worker' } })
  const tableLine = el('div', { class: 'vacuum-city-indicator__leader' })
  const workerLine = el('div', { class: 'vacuum-city-indicator__leader vacuum-city-indicator__leader--worker' })
  root.append(tableLine, workerLine, tableDot, workerDot)
  document.body.append(root)
  const point = new THREE.Vector3()
  const center = new THREE.Vector3()
  const bounds = new THREE.Box3()
  let cutaway = false
  const offCutaway = ctx.bus.on('storage:cutaway', ({ active }) => { cutaway = active; refreshIn = 0; if (!active) root.hidden = true })
  let measured = false
  let refreshIn = 0

  function anchor(dot: HTMLElement, line: HTMLElement, x: number, y: number, z: number,
    badgeX: number, badgeY: number, left: number, top: number, right: number, bottom: number): void {
    point.set(x, y, z).project(camera)
    const px = (point.x + 1) * innerWidth / 2
    const py = (1 - point.y) * innerHeight / 2
    const visible = point.z > -1 && point.z < 1 && px >= left && px <= right && py >= top && py < bottom
    dot.hidden = line.hidden = !visible
    if (!visible) return
    dot.style.transform = `translate(${px}px, ${py}px)`
    line.style.width = `${Math.hypot(badgeX - px, badgeY - py)}px`
    line.style.transform = `translate(${px}px, ${py}px) rotate(${Math.atan2(badgeY - py, badgeX - px)}rad)`
  }

  return {
    update(dt, elapsed = dt) {
      if (!isOpen()) { root.hidden = true; return }
      refreshIn -= elapsed
      if (refreshIn > 0) return
      refreshIn = 0.2
      const panel = document.querySelector<HTMLElement>('.vacuum-lesson')
      const table = ctx.registry.get('storage.table.sessions')
      if (!panel || !table) { root.hidden = true; return }
      /* Only annotate the revealed relation, not an occluded storage layer. */
      if (!cutaway) { root.hidden = true; return }
      if (!measured) { bounds.setFromObject(table.object).getCenter(center); measured = true }
      const rect = panel.getBoundingClientRect()
      const phone = innerWidth <= 640
      const left = 16
      const right = phone ? innerWidth - 16 : rect.left - 16
      const hudBottom = document.getElementById('hud-top')?.getBoundingClientRect().bottom ?? 70
      const claimsBottom = phone ? document.getElementById('city-version-provenance')?.getBoundingClientRect().bottom ?? 0 : 0
      const top = Math.max(hudBottom, claimsBottom) + 32
      const bottom = phone ? rect.top - 16 : (document.getElementById('hud-bottom')?.getBoundingClientRect().top ?? innerHeight - 100) - 16
      const width = Math.min(380, right - left)
      if (width < 180 || !vacuumIndicatorSpace(top, bottom)) { root.hidden = true; return }
      const live = vacuumCityReading(ctx.sim.state)
      root.hidden = false
      root.dataset.collected = String(live.collected)
      root.dataset.constrained = String(live.constrained)
      setText(title, `LIVE CITY · sessions · snapshot ${live.pinned ? 'retained' : 'released'}`)
      setText(count, live.collection)
      setText(work, live.work)
      badge.style.width = `${width}px`
      badge.style.left = `${left + (right - left - width) / 2}px`
      badge.style.top = `${bottom - badge.offsetHeight}px`
      const badgeX = (left + right) / 2
      const badgeY = bottom - badge.offsetHeight
      anchor(tableDot, tableLine, center.x, center.y, center.z, badgeX, badgeY, left, top, right, badgeY)
      const worker = live.workerId ? ctx.registry.get(live.workerId) : undefined
      if (worker) {
        const p = worker.focus.target
        anchor(workerDot, workerLine, p[0], p[1], p[2], badgeX, badgeY, left, top, right, badgeY)
      } else workerDot.hidden = workerLine.hidden = true
    },
    dispose() { offCutaway(); root.remove() },
  }
}
