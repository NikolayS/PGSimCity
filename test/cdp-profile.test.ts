import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireCdpProfile,
  reapStaleProfiles,
} from '../tools/cdp-profile.mjs'

const roots: string[] = []

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'pgsimcity-cdp-profile-test-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('CDP profile lifecycle', () => {
  it('gives concurrent runs on the same port separate owned profiles', () => {
    const root = temporaryRoot()
    const first = acquireCdpProfile({ root, port: 9555, reap: false })
    const second = acquireCdpProfile({ root, port: 9555, reap: false })

    expect(first.path).not.toBe(second.path)
    expect(first.owned).toBe(true)
    expect(second.owned).toBe(true)

    first.cleanup()
    expect(existsSync(first.path)).toBe(false)
    expect(existsSync(second.path)).toBe(true)

    second.cleanup()
    expect(existsSync(second.path)).toBe(false)
  })

  it('does not remove an explicitly supplied profile', () => {
    const root = temporaryRoot()
    const explicitProfile = join(root, 'caller-owned')
    mkdirSync(explicitProfile)
    writeFileSync(join(explicitProfile, 'keep'), 'caller data')

    const profile = acquireCdpProfile({
      explicitProfile,
      root: join(root, 'managed'),
    })
    profile.cleanup()

    expect(profile.owned).toBe(false)
    expect(existsSync(join(explicitProfile, 'keep'))).toBe(true)
  })

  it('does not remove a profile still named by a live process', async () => {
    const root = temporaryRoot()
    const profile = acquireCdpProfile({ root, port: 9555, reap: false })
    const child = spawn(
      'bash',
      [
        '-c',
        'exec -a "$1" sleep 60',
        'bash',
        `chrome --user-data-dir=${profile.path} about:blank`,
      ],
    )
    await once(child, 'spawn')

    expect(profile.cleanup()).toBe(false)
    expect(existsSync(profile.path)).toBe(true)

    child.kill('SIGTERM')
    await once(child, 'exit')
    expect(profile.cleanup()).toBe(true)
    expect(existsSync(profile.path)).toBe(false)
  })

  it('reaps only old profiles whose owning process is gone', () => {
    const root = temporaryRoot()
    const live = acquireCdpProfile({
      root,
      port: 9550,
      pid: 100,
      processStartTime: 'driver-start',
      reap: false,
    })
    live.setOwner(101, 'chrome-start')
    const dead = acquireCdpProfile({
      root,
      port: 9551,
      pid: 102,
      processStartTime: 'dead-start',
      reap: false,
    })
    const freshDead = acquireCdpProfile({
      root,
      port: 9552,
      pid: 103,
      processStartTime: 'fresh-dead-start',
      reap: false,
    })
    const activeChrome = acquireCdpProfile({
      root,
      port: 9553,
      pid: 104,
      processStartTime: 'dead-driver-start',
      reap: false,
    })
    const now = Date.now()
    const old = new Date(now - 11 * 60 * 1000)
    utimesSync(live.path, old, old)
    utimesSync(dead.path, old, old)
    utimesSync(activeChrome.path, old, old)

    const removed = reapStaleProfiles({
      root,
      now,
      ownerIsAlive: ({ pid, processStartTime }) =>
        pid === 101 && processStartTime === 'chrome-start',
      profileIsActive: (path) => path === activeChrome.path,
    })

    expect(removed).toEqual([dead.path])
    expect(existsSync(live.path)).toBe(true)
    expect(existsSync(dead.path)).toBe(false)
    expect(existsSync(freshDead.path)).toBe(true)
    expect(existsSync(activeChrome.path)).toBe(true)
  })
})
