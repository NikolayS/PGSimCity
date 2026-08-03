import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/oracle.yml', 'utf8')

describe('PostgreSQL oracle automation', () => {
  it('runs the unchanged lifecycle harness nightly inside PostgreSQL 18', () => {
    expect(workflow).toMatch(/schedule:\s*\n\s+- cron:/)
    expect(workflow).toMatch(/workflow_dispatch:/)
    expect(workflow).toContain('image: postgres:18')
    expect(workflow).toContain("PG_VERSION: '18'")
    expect(workflow).toContain('gosu postgres npm run oracle')
  })

  it('turns an unexpected result into a visible, deduplicated failure', () => {
    expect(workflow).toMatch(/permissions:[\s\S]*issues: write/)
    expect(workflow).toContain('continue-on-error: true')
    expect(workflow).toContain("title = 'PostgreSQL oracle divergence'")
    expect(workflow).toContain('issue.title === title')
    expect(workflow).toContain('github.rest.issues.create')
    expect(workflow).toContain('github.rest.issues.update')
    expect(workflow).toContain("if: steps.oracle.outcome == 'failure'")
    expect(workflow).toContain('run: exit 1')
  })
})
