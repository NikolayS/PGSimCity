import { describe, expect, it } from 'vitest'

import {
  formatDescribeIndex,
  formatError,
  formatResult,
  parseMetaCommand,
} from './psql.js'

describe('Magnum psql output', () => {
  it('renders query rows in psql aligned-column form', () => {
    const output = formatResult(
      [
        { name: 'id', dataTypeId: 23 },
        { name: 'owner', dataTypeId: 25 },
      ],
      [{ id: 42, owner: 'account-42' }],
      { maxWidth: 80 },
    )

    expect(output).toBe([
      ' id |   owner',
      '----+------------',
      ' 42 | account-42',
      '(1 row)',
    ].join('\n'))
  })

  it('switches wide results to psql expanded records', () => {
    const output = formatResult(
      [
        { name: 'id', dataTypeId: 23 },
        { name: 'description', dataTypeId: 25 },
      ],
      [{ id: 7, description: 'a value too wide for this terminal' }],
      { maxWidth: 24 },
    )

    expect(output).toContain('-[ RECORD 1 ]')
    expect(output).toContain('description | a value too wide for this terminal')
  })

  it('places a PostgreSQL syntax-error caret at the reported position', () => {
    const output = formatError(
      {
        severity: 'ERROR',
        message: 'syntax error at or near "SELEC"',
        detail: null,
        hint: null,
        position: '1',
      },
      'SELEC 1',
    )

    expect(output).toBe([
      'ERROR:  syntax error at or near "SELEC"',
      'LINE 1: SELEC 1',
      '        ^',
    ].join('\n'))
  })

  it('marks an invalid index the way psql describe does', () => {
    expect(formatDescribeIndex({
      Name: 'accounts_invalid_owner_idx',
      Primary: false,
      Unique: true,
      Valid: false,
      Definition: 'CREATE UNIQUE INDEX accounts_invalid_owner_idx ON public.accounts USING btree (owner)',
    })).toBe('    "accounts_invalid_owner_idx" UNIQUE, btree (owner) INVALID')
  })

  it('recognizes only the implemented psql meta-commands', () => {
    expect(parseMetaCommand('\\dt')).toEqual({ command: 'dt', argument: '' })
    expect(parseMetaCommand('\\d+ accounts')).toEqual({
      command: 'd+',
      argument: 'accounts',
    })
    expect(parseMetaCommand('\\timing')).toEqual({ command: 'timing', argument: '' })
    expect(parseMetaCommand('\\watch')).toEqual({
      command: 'invalid',
      argument: 'watch',
    })
  })
})
