import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  PLAUSIBLE_DOMAIN,
  PLAUSIBLE_SCRIPT_URL,
} from '../src/core/analytics'

const entrypoint = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('analytics entry points', () => {
  it.each([
    ['city', 'index.html'],
    ['observability', 'observability/index.html'],
  ])('loads the privacy-preserving tracker early on %s', (name, path) => {
    const html = entrypoint(path)

    expect(html).toContain(`src="${PLAUSIBLE_SCRIPT_URL}"`)
    expect(html).toContain(`data-domain="${PLAUSIBLE_DOMAIN}"`)
    expect(html).toContain(`event-entrypoint="${name}"`)
  })
})
