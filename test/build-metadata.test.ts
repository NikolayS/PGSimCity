import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { BUILD_LABEL, BUILD_SHA, BUILD_VERSION } from '../src/core/build'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string }

describe('build marker', () => {
  it('contains the package version and build-time short git SHA', () => {
    expect(BUILD_VERSION).toBe(pkg.version)
    expect(BUILD_SHA).toMatch(/^[0-9a-f]{7}$/)
    expect(BUILD_LABEL).toBe(`v${pkg.version} · ${BUILD_SHA}`)
  })
})
