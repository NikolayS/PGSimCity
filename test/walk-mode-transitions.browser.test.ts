import { describe, expect, it } from 'vitest'

import { inspectRenderedPages } from './disclosure-browser.mjs'

describe('rendered walk camera transitions', () => {
  it('honours the fly command when leaving first-person mode', async () => {
    const [result] = await inspectRenderedPages([{
      name: 'Walk to fly transition',
      path: '/',
      readySelector: '#canvas-root canvas',
      prepare: `(async () => {
        for (let attempt = 0; attempt < 240 && !window.PGSIMCITY; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        if (!window.PGSIMCITY) throw new Error('PGSimCity did not expose its browser handle')
        window.PGSIMCITY.sim.setKnob('paused', true)
      })()`,
    }], async ({ evaluate, keyPress }) => {
      const waitFor = (condition: string) => evaluate(`new Promise((resolve, reject) => {
        const startedAt = performance.now()
        const timer = setInterval(() => {
          if (${condition}) {
            clearInterval(timer)
            resolve(true)
          } else if (performance.now() - startedAt > 15000) {
            clearInterval(timer)
            reject(new Error('timed out waiting for ${condition.replaceAll("'", "\\'")}'))
          }
        }, 50)
      })`)

      await keyPress('G', { code: 'KeyG' })
      await waitFor(`window.PGSIMCITY.rig.mode === 'walk' && window.PGSIMCITY.walk.enabled`)
      await evaluate(`window.PGSIMCITY.walk.setPose({ x: 0, y: 3.75, z: 48, yaw: 0, pitch: 0 })`)
      await keyPress('F', { code: 'KeyF' })
      await waitFor(`!window.PGSIMCITY.walk.enabled`)

      return evaluate(`({ mode: window.PGSIMCITY.rig.mode })`)
    })

    expect(result).toEqual({ mode: 'fly' })
  }, 360_000)
})
