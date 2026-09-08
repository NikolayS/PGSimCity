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
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireCdpProfile,
  profileIsInUse,
  reapStaleProfiles,
} from '../tools/cdp-profile.mjs'

const roots: string[] = []
const children: ChildProcess[] = []

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'pgsimcity-cdp-profile-test-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

/*
 * Process-table visibility can lag child startup or exit. Poll for the
 * observed transition and assert it before testing profile cleanup.
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

/* Wait for the final executable, not a shell whose argv matches before exec. */
async function spawnHoldingProfile(profilePath: string) {
  const child = spawn(process.execPath, [
    '-e',
    'setInterval(() => {}, 1000); process.stdout.write("ready")',
    '--',
    `--user-data-dir=${profilePath}`,
  ])
  children.push(child)
  const [ready] = await once(child.stdout, 'data')
  expect(ready.toString()).toBe('ready')
  return child
}

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
    const child = await spawnHoldingProfile(profile.path)
    expect(await waitUntil(() => profileIsInUse(profile.path))).toBe(true)

    expect(profile.cleanup()).toBe(false)
    expect(existsSync(profile.path)).toBe(true)

    child.kill('SIGTERM')
    await once(child, 'exit')
    expect(await waitUntil(() => !profileIsInUse(profile.path))).toBe(true)

    expect(profile.cleanup()).toBe(true)
    expect(existsSync(profile.path)).toBe(false)
  })

  /*
   * The in-use check is the only thing standing between two concurrent shoots
   * and a deleted live profile, and it must not depend on /proc, which this
   * project's primary development platform does not have.
   */
  it('sees a live process on every platform, not only where /proc exists', async () => {
    const root = temporaryRoot()
    const profile = acquireCdpProfile({ root, port: 9556, reap: false })

    expect(profileIsInUse(profile.path)).toBe(false)

    const child = await spawnHoldingProfile(profile.path)

    expect(await waitUntil(() => profileIsInUse(profile.path))).toBe(true)
    expect(profileIsInUse(`${profile.path}-other`)).toBe(false)

    child.kill('SIGTERM')
    await once(child, 'exit')
    expect(await waitUntil(() => !profileIsInUse(profile.path))).toBe(true)
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
