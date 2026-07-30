import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireCdpProfile } from '../tools/cdp-profile.mjs'
import { createCdpRunCleanup, terminateChild } from '../tools/cdp-run.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('CDP run cleanup', () => {
  it('stops Chrome before removing its profile and releasing its slot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pgsimcity-cdp-run-test-'))
    roots.push(root)
    const profile = acquireCdpProfile({ root, port: 9555, reap: false })
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    profile.setOwner(child.pid)
    const events: string[] = []
    child.once('exit', () => events.push('child exited'))
    const run = createCdpRunCleanup({
      profile,
      releaseSlot: () => events.push('slot released'),
    })
    run.trackChild(child)

    await run.cleanup()

    expect(existsSync(profile.path)).toBe(false)
    expect(events).toEqual(['child exited', 'slot released'])
  })

  it('waits for Chrome descendants to release the profile', async () => {
    let attempts = 0
    const warnings: string[] = []
    const run = createCdpRunCleanup({
      profile: {
        path: '/tmp/test-profile',
        owned: true,
        cleanup() {
          attempts++
          return attempts > 1
        },
      },
      profileRetryMs: 1,
      profileWaitMs: 20,
      sleep: async () => {},
      warn: (message: string) => warnings.push(message),
    })

    await run.cleanup()

    expect(attempts).toBe(2)
    expect(warnings).toEqual([])
  })

  it('treats a failed spawn as already stopped', async () => {
    const failedSpawn = {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      kill() {
        throw new Error('process was never started')
      },
      once() {},
      off() {},
    }

    await expect(terminateChild(failedSpawn, 1)).resolves.toBe(true)
  })
})
