import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { createBus } from '../src/core/bus'
import { createRealPostgresConsole } from '../src/observability/real-postgres-ui'
import { createSim } from '../src/sim/model'
import { installTestDom } from './dom'

const PGLITE_HOME = 'https://pglite.dev'
const PGLITE_SOURCE = 'https://github.com/electric-sql/pglite'

function normalize(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function expectExternalLink(
  root: ParentNode,
  selector: string,
  href: string,
): HTMLAnchorElement {
  const link = root.querySelector<HTMLAnchorElement>(selector)
  expect(link).not.toBeNull()
  expect(link!.getAttribute('href')).toBe(href)
  expect(link!.getAttribute('target')).toBe('_blank')
  expect(link!.getAttribute('rel')?.split(/\s+/)).toContain('noopener')
  return link!
}

describe('PGlite credit', () => {
  const machine = readFileSync(
    fileURLToPath(new URL('../machine/index.html', import.meta.url)),
    'utf8',
  )

  it('sources the Machine real-PostgreSQL claim and keeps the credit visible on phones', () => {
    const claim = machine.match(/<p class="deck">([\s\S]*?)<\/p>/)?.[1] ?? ''
    expect(normalize(claim)).toContain(
      'REAL POSTGRESQL LEFT VIA PGLITE BY ELECTRICSQL — POSTGRESQL COMPILED TO WEBASSEMBLY.',
    )
    expect(claim).toMatch(
      /<a[^>]+href="https:\/\/pglite\.dev"[^>]+target="_blank"[^>]+rel="noopener"[^>]*>PGLITE BY ELECTRICSQL<\/a>/,
    )
    expect(claim).toMatch(
      /<a[^>]+href="https:\/\/github\.com\/electric-sql\/pglite"[^>]+target="_blank"[^>]+rel="noopener"[^>]*>SOURCE<\/a>/,
    )

    const terminalHeader =
      machine.match(/<header class="terminal-header">([\s\S]*?)<\/header>/)?.[1] ?? ''
    expect(normalize(terminalHeader)).toContain('PGLITE BY ELECTRICSQL')
    expect(terminalHeader).toMatch(
      /<a[^>]+href="https:\/\/pglite\.dev"[^>]+target="_blank"[^>]+rel="noopener"[^>]*>PGLITE BY ELECTRICSQL<\/a>/,
    )
  })

  it('keeps PGlite attribution and licensing reachable from Machine Legal', () => {
    const legal = machine.match(/<details class="machine-legal">([\s\S]*?)<\/details>/)?.[1] ?? ''
    expect(normalize(legal)).toContain(
      'PGlite is by ElectricSQL (Electric DB Limited), copyright Electric DB Limited and licensed under Apache-2.0.',
    )
    expect(legal).toContain(PGLITE_HOME)
    expect(legal).toContain(PGLITE_SOURCE)
  })

  it('credits the PGlite host beside Query flow’s opt-in PostgreSQL claim', () => {
    installTestDom()
    const console = createRealPostgresConsole(createSim(createBus()))

    const home = expectExternalLink(
      console.root,
      '[data-pglite-credit="home"]',
      PGLITE_HOME,
    )
    const source = expectExternalLink(
      console.root,
      '[data-pglite-credit="source"]',
      PGLITE_SOURCE,
    )
    expect(home.textContent).toBe('PGlite by ElectricSQL')
    expect(source.textContent).toBe('Read the source')
    expect(console.root.textContent).toContain(
      'a real PostgreSQL compiled to WebAssembly',
    )

    console.dispose()
  })
})
