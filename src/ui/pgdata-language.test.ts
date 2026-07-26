import { describe, expect, it } from 'vitest'

const sourceFiles = import.meta.glob('../**/*.ts', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>

describe('user-facing data-directory terminology', () => {
  it('uses PGDATA only when explaining the environment variable', () => {
    const allowed = new Set([
      "./anatomy.ts: 'This directory holds the cluster’s durable state. PGDATA is an environment variable used to help locate a cluster; it is not the name of the structure. Configuration files may be elsewhere, and the data_directory setting can select a different storage location.',",
      "./anatomy.ts: el('code', { text: 'PGDATA' }),",
    ])
    const allowedOccurrences: string[] = []
    const violations: string[] = []

    for (const [file, source] of Object.entries(sourceFiles)) {
      if (file.endsWith('.test.ts')) continue

      source.split('\n').forEach((line, index) => {
        if (line.includes('PGDATA')) {
          const occurrence = `${file}: ${line.trim()}`
          if (allowed.has(occurrence)) {
            allowedOccurrences.push(occurrence)
          } else {
            violations.push(`${file}:${index + 1}: ${line.trim()}`)
          }
        }
      })
    }

    expect(violations).toEqual([])
    expect(allowedOccurrences.sort()).toEqual([...allowed].sort())
  })
})
