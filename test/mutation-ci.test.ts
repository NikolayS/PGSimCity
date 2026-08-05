import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/mutation.yml', 'utf8')

describe('mutation gate automation', () => {
  it('runs the deliberately slow gate on a schedule rather than every push', () => {
    expect(workflow).toMatch(/schedule:\s*\n\s*- cron:/)
    expect(workflow).toMatch(/workflow_dispatch:/)
    expect(workflow).not.toMatch(/\npush:/)
    expect(workflow).not.toMatch(/\npull_request:/)
    expect(workflow).toContain('npm run mutation')
    expect(workflow).toContain('--maxWorkers=1')
  })

  it('turns survivors or inconclusive critical skips into a visible failure', () => {
    expect(workflow).toMatch(/permissions:[\s\S]*issues: write/)
    expect(workflow).toContain('continue-on-error: true')
    expect(workflow).toContain("title = 'Mutation gate survivors'")
    expect(workflow).toContain('issue.title === title')
    expect(workflow).toContain('github.rest.issues.create')
    expect(workflow).toContain('github.rest.issues.update')
    expect(workflow).toContain("if: steps.mutation.outcome == 'failure'")
    expect(workflow).toContain('run: exit 1')
  })
})
