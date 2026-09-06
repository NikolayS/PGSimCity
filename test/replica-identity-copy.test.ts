import { expect, it } from 'vitest'
import { DOCS_STORAGE } from '../src/ui/docs-storage'

it('links directly to the publication replica-identity section', () => {
  const decoder = DOCS_STORAGE.find((entry) => entry.id === 'logical.decoder')!
  expect(decoder.refs?.docs?.find((ref) => ref.label === '29.1.1 Replica Identity')?.url)
    .toBe('https://www.postgresql.org/docs/18/logical-replication-publication.html#LOGICAL-REPLICATION-PUBLICATION-REPLICA-IDENTITY')
})

const decoderCopy = DOCS_STORAGE.find((entry) => entry.id === 'logical.decoder')!
  .sections.map((section) => section.body).join('\n')

it('scopes the identity requirement to published update/delete operations', () => {
  expect(decoderCopy).not.toMatch(/a table with no primary key will error out unless/)
  expect(decoderCopy).toMatch(/publication[^.]*`UPDATE`[^.]*`DELETE`/)
  expect(decoderCopy).toMatch(/`INSERT`[^.]*does not require/)
})

it('offers an eligible identity index before the full-row fallback', () => {
  expect(decoderCopy).toContain('eligible unique index')
  expect(decoderCopy).toContain('REPLICA IDENTITY USING INDEX')
  expect(decoderCopy).toMatch(/`REPLICA IDENTITY FULL`[^.]*fallback/)
})
