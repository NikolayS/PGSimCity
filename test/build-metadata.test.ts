import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { BUILD_LABEL, BUILD_SHA, BUILD_VERSION } from '../src/core/build'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string, engines: { node: string } }
const lock = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package-lock.json', import.meta.url)), 'utf8'),
) as { packages: Record<string, { engines?: { node?: string } }> }
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

describe('build marker', () => {
  it('contains the package version and build-time short git SHA', () => {
    expect(BUILD_VERSION).toBe(pkg.version)
    expect(BUILD_SHA).toMatch(/^[0-9a-f]{7}$/)
    expect(BUILD_LABEL).toBe(`v${pkg.version} · ${BUILD_SHA}`)

    const viteNodeRange = lock.packages['node_modules/vite'].engines?.node
    expect(pkg.engines.node).toBe(viteNodeRange)
    for (const path of ['README.md', 'CONTRIBUTING.md', 'CLAUDE.md']) {
      expect(read(path), `${path} does not state the toolchain's Node constraint`)
        .toContain(`Node.js \`${pkg.engines.node}\``)
    }

    const contributing = read('CONTRIBUTING.md')
    expect(contributing).toContain('google-chrome')
    expect(contributing).toContain('CHROME_BIN')
    expect(contributing).toContain("npm test -- --exclude '**/*.browser.test.*'")

    const roadmap = read('ROADMAP.md')
    expect(roadmap).toMatch(/starts at the `high` quality tier[^.]+`medium`[^.]+`reduced`[^.]+`low`/i)
    expect(roadmap).not.toContain('Modest hardware falls to the `reduced` quality tier')
  })
})
