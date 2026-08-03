import { describe, expect, it } from 'vitest'

import { inspectRenderedPages } from './disclosure-browser.mjs'

interface AxNode {
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  description?: { value?: string }
}

const names = (tree: { nodes: AxNode[] }) => tree.nodes
  .filter((node) => !node.ignored)
  .map((node) => String(node.name?.value ?? ''))

describe('keyboard and screen-reader lesson routes', () => {
  it('contains both Machine dialogs, restores their openers, and exposes source meaning', async () => {
    const [report] = await inspectRenderedPages([{
      name: 'Machine',
      path: '/machine/',
      readySelector: '#comparison-open',
    }], async ({ accessibilityTree, evaluate, keyPress }) => {
      await evaluate(`document.querySelector('#comparison-open').focus(); document.querySelector('#comparison-open').click()`)
      const comparisonIsolation = await evaluate(`({
        active: document.activeElement.id,
        inertSiblings: Array.from(document.querySelector('.workbench').children)
          .filter((child) => child.id !== 'comparison')
          .every((child) => child.inert),
      })`)

      await evaluate(`document.querySelector('#comparison-close').focus()`)
      await keyPress('Tab', { code: 'Tab', shift: true })
      const wrappedBackward = await evaluate(`({
        inside: Boolean(document.activeElement.closest('#comparison')),
        label: document.activeElement.id || document.activeElement.getAttribute('aria-label') || document.activeElement.textContent.trim(),
      })`)
      await keyPress('Tab', { code: 'Tab' })
      const wrappedForward = await evaluate(`document.activeElement.id`)
      const comparisonAxNames = names(await accessibilityTree())
      await keyPress('Escape', { code: 'Escape' })
      const comparisonRestored = await evaluate(`document.activeElement.id`)

      await evaluate(`document.querySelector('#index-walk-open').focus(); document.querySelector('#index-walk-open').click()`)
      await evaluate(`document.querySelector('#index-walk-close').focus()`)
      await keyPress('Tab', { code: 'Tab', shift: true })
      const indexWrapped = await evaluate(`({
        inside: Boolean(document.activeElement.closest('#index-walk')),
        label: document.activeElement.id || document.activeElement.getAttribute('aria-label') || document.activeElement.textContent.trim(),
      })`)
      await keyPress('Tab', { code: 'Tab' })
      const indexWrappedForward = await evaluate(`document.activeElement.id`)
      const axNames = [...comparisonAxNames, ...names(await accessibilityTree())]
      await keyPress('Escape', { code: 'Escape' })
      const indexRestored = await evaluate(`document.activeElement.id`)

      return {
        comparisonIsolation,
        wrappedBackward,
        wrappedForward,
        comparisonRestored,
        indexWrapped,
        indexWrappedForward,
        indexRestored,
        axNames,
      }
    })

    expect(report.comparisonIsolation).toEqual({
      active: 'comparison-run',
      inertSiblings: true,
    })
    expect(report.wrappedBackward.inside).toBe(true)
    expect(report.wrappedForward).toBe('comparison-close')
    expect(report.comparisonRestored).toBe('comparison-open')
    expect(report.indexWrapped.inside).toBe(true)
    expect(report.indexWrappedForward).toBe('index-walk-close')
    expect(report.indexRestored).toBe('index-walk-open')
    expect(report.axNames).toContain('PostgreSQL source')
    expect(report.axNames).toContain('Modelled source')
  }, 90_000)

  it('reaches a Diagnose verdict by keyboard and exposes its claim in the accessibility tree', async () => {
    const [report] = await inspectRenderedPages([{
      name: 'Diagnose',
      path: '/observability/',
      readySelector: '.homecard',
    }], async ({ accessibilityTree, evaluate, keyPress }) => {
      const keys: string[] = []
      const press = async (key: string, code = key) => {
        keys.push(key === ' ' ? 'Space' : key)
        await keyPress(key, { code })
      }
      await press('Tab', 'Tab')
      const firstFocus = await evaluate(`document.activeElement.className`)
      await press('Enter', 'Enter')
      await press('Tab', 'Tab')
      const lessonFocus = await evaluate(`document.activeElement.className`)
      await press('Enter', 'Enter')
      let steps = 0
      const trail: unknown[] = []
      while (steps < 12 && !await evaluate(`Boolean(document.querySelector('.verdict'))`)) {
        let tabs = 0
        let branch = false
        while (tabs < 120 && !branch) {
          await press('Tab', 'Tab')
          tabs += 1
          branch = await evaluate(`document.activeElement.matches('.branch.true, .branch')`)
        }
        const state = await evaluate(`(() => {
          return {
            branch: document.activeElement.matches('.branch.true, .branch'),
            heading: document.querySelector('.pane h1')?.textContent,
            active: document.activeElement?.className,
          }
        })()`)
        trail.push(state)
        if (!state.branch) break
        await press('Enter', 'Enter')
        steps += 1
      }
      const semantics = await evaluate(`(() => {
        const verdict = document.querySelector('.verdict')
        return {
          reached: Boolean(verdict),
          labelledBy: verdict?.getAttribute('aria-labelledby'),
          describedBy: verdict?.getAttribute('aria-describedby'),
          title: verdict?.querySelector('h1')?.textContent,
          summary: verdict?.querySelector('.lede')?.textContent,
          active: document.activeElement?.textContent,
        }
      })()`)
      return {
        semantics,
        trail,
        firstFocus,
        lessonFocus,
        keys,
        axNames: names(await accessibilityTree()),
      }
    })

    expect(report.firstFocus).toContain('skip-link')
    expect(report.lessonFocus).toContain('homecard')
    expect(report.keys).toEqual([
      'Tab', 'Enter',
      'Tab', 'Enter',
      'Tab', 'Tab', 'Tab', 'Tab', 'Enter',
    ])
    expect(report.semantics.reached, JSON.stringify(report.trail)).toBe(true)
    expect(report.semantics.labelledBy).toBe('diagnose-card-title')
    expect(report.semantics.describedBy).toBe('diagnose-card-summary diagnose-card-mechanism')
    expect(report.semantics.active).toBe(report.semantics.title)
    expect(report.axNames).toContain(report.semantics.title)
    expect(report.axNames).toContain(report.semantics.summary)
  }, 90_000)

  it('defaults all animated lessons to paused under reduced motion and exposes a Machine receipt', async () => {
    const reports = await inspectRenderedPages([{
      name: 'City',
      path: '/',
      readySelector: '#hud-top',
      reducedMotion: true,
      prepare: `(async () => {
        for (let attempt = 0; attempt < 120 && !window.PGSIMCITY; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      })()`,
    }, {
      name: 'Diagnose',
      path: '/observability/',
      readySelector: '.clock',
      reducedMotion: true,
    }, {
      name: 'Machine',
      path: '/machine/',
      readySelector: '#terminal-input',
      reducedMotion: true,
    }], async ({ accessibilityTree, evaluate, page }) => {
      if (page.name === 'City') {
        return { name: page.name, paused: await evaluate(`window.PGSIMCITY.sim.state.knobs.paused`) }
      }
      if (page.name === 'Diagnose') {
        return {
          name: page.name,
          paused: await evaluate(`document.querySelector('.clock > button').getAttribute('aria-pressed') === 'true'`),
        }
      }
      await evaluate(`window.MAGNUM.runQuery('SELECT 1;')`)
      return {
        name: page.name,
        paused: await evaluate(`window.MAGNUM.getState().paused`),
        state: await evaluate(`window.MAGNUM.getState().statement.status`),
        axNames: names(await accessibilityTree()),
      }
    })

    expect(reports[0]).toMatchObject({ name: 'City', paused: true })
    expect(reports[1]).toMatchObject({ name: 'Diagnose', paused: true })
    expect(reports[2]).toMatchObject({ name: 'Machine', paused: true, state: 'complete' })
    const receiptNames = reports[2].axNames.filter((name: string) => (
      name.startsWith('PostgreSQL measured receipt:')
    ))
    expect(receiptNames.length).toBeGreaterThan(0)
    expect(receiptNames.every((name: string) => /, 1 row\. Modelled/.test(name))).toBe(true)
  }, 120_000)
})
