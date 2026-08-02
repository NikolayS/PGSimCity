import { describe, expect, it } from 'vitest'

import { createBus } from './bus'
import { installCityComponentRoutes } from './city-route'

describe('city component deep links', () => {
  it('selects and frames the registered component on load and hash changes', () => {
    const bus = createBus()
    const selected: (string | null)[] = []
    const focused: (string | null)[] = []
    bus.on('select', ({ id }) => selected.push(id))
    bus.on('focus', ({ id }) => focused.push(id))

    const location = { hash: '#/c/checkpointer' }
    const target = new EventTarget()
    const registry = {
      get: (id: string) => ['checkpointer', 'wal.vault'].includes(id) ? { id } : undefined,
    }
    const dispose = installCityComponentRoutes({ bus, registry, location, target })

    expect(selected).toEqual(['checkpointer'])
    expect(focused).toEqual(['checkpointer'])

    location.hash = '#/c/wal.vault'
    target.dispatchEvent(new Event('hashchange'))
    expect(selected).toEqual(['checkpointer', 'wal.vault'])
    expect(focused).toEqual(['checkpointer', 'wal.vault'])

    location.hash = '#/c/not-registered'
    target.dispatchEvent(new Event('hashchange'))
    expect(selected).toEqual(['checkpointer', 'wal.vault'])
    expect(focused).toEqual(['checkpointer', 'wal.vault'])

    dispose()
  })
})
