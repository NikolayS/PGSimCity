import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('distinguishes manual name review from registered live-server checks', () => {
  const readme = readFileSync(new URL('../observability/README.md', import.meta.url), 'utf8')
  const names = readme.split('1. **Names are real.**')[1].split('2. **')[0]
  expect(names).toContain('A registered subset')
  expect(names).toMatch(/vacuum phase strings[^.]*manual-checked only/)
  expect(names).not.toMatch(/every[\s\S]*and verified\s+against PostgreSQL/)
})
