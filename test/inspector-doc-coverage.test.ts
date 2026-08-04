import { describe, expect, it } from 'vitest'

import { doc } from '../src/ui/content'
import { createWalkCityHarness } from './walk-harness'

describe('inspector documentation coverage', () => {
  it('documents every component registered by the production city', async () => {
    const city = await createWalkCityHarness({ includeControlCenter: true })
    try {
      const missing = city.registry
        .all()
        .filter((component) => !doc(component.id))
        .map((component) => component.id)
        .sort()

      expect(
        missing,
        `${city.registry.all().length} registered inspector components; missing documentation`,
      ).toEqual([])
    } finally {
      city.dispose()
    }
  })
})
