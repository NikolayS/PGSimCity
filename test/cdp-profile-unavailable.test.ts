import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireCdpProfile, reapStaleProfiles } from '../tools/cdp-profile.mjs'

const processTable = vi.hoisted(() => ({ unavailable: false }))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
      if (processTable.unavailable && args[0] === '/proc') throw new Error('unavailable')
      return fs.readdirSync(...args)
    },
  }
})

vi.mock('node:child_process', async (importOriginal) => {
  const child = await importOriginal<typeof import('node:child_process')>()
  return {
    ...child,
    execFileSync: (...args: Parameters<typeof child.execFileSync>) => {
      if (processTable.unavailable && args[0] === 'ps') throw new Error('unavailable')
      return child.execFileSync(...args)
    },
  }
})

const roots: string[] = []
afterEach(() => {
  processTable.unavailable = false
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('retains an owned profile when neither process source is readable', () => {
  const root = mkdtempSync(join(tmpdir(), 'pgsimcity-profile-unknown-'))
  roots.push(root)
  const profile = acquireCdpProfile({ root, reap: false })

  processTable.unavailable = true
  expect(profile.cleanup()).toBe(false)
  expect(existsSync(profile.path)).toBe(true)

  processTable.unavailable = false
  expect(profile.cleanup()).toBe(true)
  expect(existsSync(profile.path)).toBe(false)
})

it('does not reap an old profile on unknown usage, even with a dead owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'pgsimcity-profile-unknown-'))
  roots.push(root)
  const profile = acquireCdpProfile({ root, reap: false })
  const now = Date.now()
  const old = new Date(now - 11 * 60 * 1000)
  utimesSync(profile.path, old, old)

  processTable.unavailable = true
  expect(reapStaleProfiles({ root, now, ownerIsAlive: () => false })).toEqual([])
  expect(existsSync(profile.path)).toBe(true)

  processTable.unavailable = false
  expect(reapStaleProfiles({ root, now, ownerIsAlive: () => false })).toEqual([profile.path])
  expect(existsSync(profile.path)).toBe(false)
})
