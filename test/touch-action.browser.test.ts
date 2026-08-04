import { describe, expect, it } from 'vitest'

import { inspectRenderedPages } from './disclosure-browser.mjs'

interface GestureTarget {
  label: string
  touchAction: string
  visible: boolean
  hasPointerMove: boolean
}

interface GestureCounts {
  downs: number
  moves: number
  cancels: number
  ups: number
}

interface TouchPoint {
  x: number
  y: number
}

interface TouchActionReport {
  targets: GestureTarget[]
  forcedAuto: GestureCounts
  restored: GestureCounts
}

const ENUMERATE_GESTURE_TARGETS = `(() => {
  const describe = (element) => {
    if (element.id) return '#' + element.id
    const ariaLabel = element.getAttribute('aria-label')
    if (ariaLabel) return element.tagName.toLowerCase() + '[aria-label="' + ariaLabel + '"]'
    const classes = Array.from(element.classList).slice(0, 2)
    return element.tagName.toLowerCase() + classes.map((name) => '.' + name).join('')
  }
  const requiredLifecycle = ['pointerdown', 'pointerup', 'pointercancel']
  // Enumerate the receivers installed by production modules. This grows with
  // new gesture surfaces instead of freezing their selectors in the test.
  const targets = Array.from(document.querySelectorAll('*')).filter((element) => {
    const listeners = getEventListeners(element)
    return requiredLifecycle.every((type) => (listeners[type] || []).length > 0)
  })
  window.__pgTouchActionTargets = targets
  return targets.map((element) => {
    const listeners = getEventListeners(element)
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      label: describe(element),
      touchAction: style.touchAction,
      visible: style.display !== 'none' && style.visibility === 'visible'
        && rect.width > 0 && rect.height > 0,
      hasPointerMove: (listeners.pointermove || []).length > 0,
    }
  })
})()`

const INSTALL_NATIVE_GESTURE_PROBE = `(() => {
  const targets = window.__pgTouchActionTargets
  if (!targets) throw new Error('gesture targets were not enumerated')
  const targetIndex = targets.findIndex((element) => {
    const listeners = getEventListeners(element)
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return (listeners.pointermove || []).length > 0
      && style.display !== 'none'
      && style.visibility === 'visible'
      && rect.width > 0
      && rect.height > 0
  })
  if (targetIndex < 0) throw new Error('no visible multi-touch gesture receiver was found')
  const target = targets[targetIndex]
  const rect = target.getBoundingClientRect()
  let start = null
  for (let y = Math.max(rect.top + 120, 180); y <= Math.min(rect.bottom - 180, innerHeight - 180); y += 40) {
    for (let x = Math.max(rect.left + 80, 80); x <= Math.min(rect.right - 180, innerWidth - 180); x += 40) {
      const first = document.elementFromPoint(x, y)
      const second = document.elementFromPoint(x + 100, y)
      if ((first === target || target.contains(first)) && (second === target || target.contains(second))) {
        start = { first: { x, y }, second: { x: x + 100, y } }
        break
      }
    }
    if (start) break
  }
  if (!start) throw new Error('the visible gesture receiver has no clear two-contact test area')

  let counts
  const reset = () => {
    counts = { downs: 0, moves: 0, cancels: 0, ups: 0 }
  }
  const observers = {
    pointerdown: () => { counts.downs += 1 },
    pointermove: () => { counts.moves += 1 },
    pointercancel: () => { counts.cancels += 1 },
    pointerup: () => { counts.ups += 1 },
  }
  for (const [type, observer] of Object.entries(observers)) {
    target.addEventListener(type, observer)
  }
  const original = {
    value: target.style.getPropertyValue('touch-action'),
    priority: target.style.getPropertyPriority('touch-action'),
  }
  reset()
  window.__pgNativeGestureProbe = {
    target,
    start,
    reset,
    counts: () => ({ ...counts }),
    forceAuto: () => target.style.setProperty('touch-action', 'auto', 'important'),
    restore: () => {
      if (original.value) target.style.setProperty('touch-action', original.value, original.priority)
      else target.style.removeProperty('touch-action')
    },
    dispose: () => {
      for (const [type, observer] of Object.entries(observers)) {
        target.removeEventListener(type, observer)
      }
    },
  }
  return start
})()`

async function dispatchTwoFingerSwipe(
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  start: { first: TouchPoint; second: TouchPoint },
  idBase: number,
): Promise<void> {
  const points = (offset: number) => [start.first, start.second].map((point, index) => ({
    x: point.x,
    y: point.y + offset,
    id: idBase + index,
    radiusX: 2,
    radiusY: 2,
    force: 1,
  }))
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(0) })
  for (let step = 1; step <= 6; step += 1) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(step * 20) })
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

describe('native multi-touch gesture ownership', () => {
  it('keeps every production gesture receiver out of browser touch arbitration', async () => {
    const [report] = await inspectRenderedPages([{
      name: 'City',
      path: '/',
      readySelector: '#hud-top',
      beforeLoad: `(() => {
        const context = WebGL2RenderingContext.prototype
        for (const method of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
          context[method] = () => {}
        }
        const schedule = requestAnimationFrame.bind(window)
        window.requestAnimationFrame = (callback) => callback.name === 'frame' ? 0 : schedule(callback)
      })()`,
      prepare: `(async () => {
        for (let attempt = 0; attempt < 120 && !window.PGSIMCITY; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (!window.PGSIMCITY) throw new Error('PGSimCity did not initialise')
      })()`,
    }], async ({ evaluate, send }): Promise<TouchActionReport> => {
      const targets = await evaluate(ENUMERATE_GESTURE_TARGETS, {
        includeCommandLineAPI: true,
      }) as GestureTarget[]
      const start = await evaluate(INSTALL_NATIVE_GESTURE_PROBE, {
        includeCommandLineAPI: true,
      }) as { first: TouchPoint; second: TouchPoint }

      await evaluate(`new Promise((resolve) => {
        window.__pgNativeGestureProbe.forceAuto()
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      })`)
      await dispatchTwoFingerSwipe(send, start, 1)
      await evaluate(`new Promise((resolve) => setTimeout(resolve, 100))`)
      const forcedAuto = await evaluate(`window.__pgNativeGestureProbe.counts()`) as GestureCounts

      await evaluate(`new Promise((resolve) => {
        window.__pgNativeGestureProbe.restore()
        window.__pgNativeGestureProbe.reset()
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      })`)
      await dispatchTwoFingerSwipe(send, start, 3)
      await evaluate(`new Promise((resolve) => setTimeout(resolve, 100))`)
      const restored = await evaluate(`window.__pgNativeGestureProbe.counts()`) as GestureCounts
      await evaluate(`window.__pgNativeGestureProbe.dispose()`)

      return { targets, forcedAuto, restored }
    })

    expect(
      report.targets.length,
      'The source-derived gesture-target enumeration found nothing, so this guard covers nothing.',
    ).toBeGreaterThan(0)

    const unsafe = report.targets.filter((target) => target.touchAction !== 'none')
    expect(
      unsafe,
      'Every production pointer-gesture receiver must compute to touch-action: none. Losing it lets '
        + 'iOS Safari cancel two-finger camera control before pointerup, a failure synthetic '
        + 'PointerEvent tests cannot reveal.',
    ).toEqual([])

    expect(
      report.forcedAuto,
      'The native counterfactual must reproduce the failure mode: touch-action: auto gives the '
        + 'browser the two-finger gesture, producing pointercancel and no application pointerup.',
    ).toMatchObject({ downs: 2, cancels: 2, ups: 0 })
    expect(report.forcedAuto.moves).toBeGreaterThan(0)
    expect(report.forcedAuto.moves).toBeLessThan(report.restored.moves)
    expect(
      report.restored,
      'Restoring touch-action: none must preserve the complete two-finger stream used by iOS '
        + 'Safari camera control; synthetic PointerEvents do not exercise this arbitration.',
    ).toEqual({ downs: 2, moves: 12, cancels: 0, ups: 2 })
  }, 90_000)
})
