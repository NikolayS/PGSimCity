import { describe, expect, it } from 'vitest'
import { installTestDom } from '../../test/dom'
import { createBus } from '../core/bus'
import { createSearch } from './search'
import type { UiContext } from './uikit'

function key(target: HTMLElement, value: string, ctrlKey = false): Event {
  const event = new Event('keydown', { cancelable: true })
  Object.defineProperties(event, { key: { value }, target: { value: target }, ctrlKey: { value: ctrlKey } })
  window.dispatchEvent(event)
  return event
}

describe('search keyboard modal ownership', () => {
  it.each(['native', 'aria', 'replay'])('does not open behind an active %s dialog', (kind) => {
    installTestDom()
    const search = createSearch({ bus: createBus(), registry: { get: () => undefined } } as unknown as UiContext)
    const dialog = document.createElement(kind === 'native' ? 'dialog' : 'section')
    if (kind === 'native') dialog.setAttribute('open', '')
    else if (kind === 'aria') dialog.setAttribute('aria-modal', 'true')
    else dialog.setAttribute('role', 'dialog')
    const button = document.createElement('button')
    dialog.append(button)
    document.body.append(dialog)
    try {
      for (const [value, ctrl] of [['/', false], ['k', true]] as const) {
        expect(key(button, value, ctrl).defaultPrevented).toBe(false)
        expect(document.body.classList.contains('pg-palette-open')).toBe(false)
      }
      // Even an already-open palette must not capture another dialog's Enter.
      dialog.remove()
      key(document.body, '/')
      expect(document.body.classList.contains('pg-palette-open')).toBe(true)
      document.body.append(dialog)
      expect(key(button, 'Enter').defaultPrevented).toBe(false)
      expect(document.body.classList.contains('pg-palette-open')).toBe(true)
    } finally { search.dispose() }
  })
})
