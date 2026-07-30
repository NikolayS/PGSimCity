import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const PROFILE_STALE_MS = 10 * 60 * 1000
export const DEFAULT_PROFILE_ROOT = join(tmpdir(), 'pgsimcity-cdp-profiles')

const OWNER_FILE = '.pgsimcity-cdp-owner.json'
const MANAGED_PROFILE = /^profile-\d+-\d+-[A-Za-z0-9]+$/

function readProcessStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fieldsAfterName = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    return fieldsAfterName[19]
  } catch {
    return null
  }
}

export function profileOwnerIsAlive({ pid, processStartTime }) {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return error?.code === 'EPERM'
  }

  const currentStartTime = readProcessStartTime(pid)
  return !processStartTime || !currentStartTime || currentStartTime === processStartTime
}

export function profileIsInUse(profilePath) {
  let processes
  try {
    processes = readdirSync('/proc')
  } catch {
    return false
  }

  const profileArgument = `--user-data-dir=${profilePath}`
  for (const pid of processes) {
    if (!/^\d+$/.test(pid)) continue
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`).toString().split('\0')
      // Chrome flattens its command line into argv[0] on this host.
      if (args.some((arg) => arg.split(/\s+/).includes(profileArgument))) return true
    } catch {}
  }
  return false
}

function readOwner(profilePath) {
  try {
    const owner = JSON.parse(readFileSync(join(profilePath, OWNER_FILE), 'utf8'))
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return null
    return owner
  } catch {
    return null
  }
}

export function reapStaleProfiles({
  root = DEFAULT_PROFILE_ROOT,
  staleMs = PROFILE_STALE_MS,
  now = Date.now(),
  ownerIsAlive = profileOwnerIsAlive,
  profileIsActive = profileIsInUse,
} = {}) {
  const removed = []
  try {
    for (const name of readdirSync(root)) {
      if (!MANAGED_PROFILE.test(name)) continue
      const profilePath = join(root, name)
      try {
        if (now - statSync(profilePath).mtimeMs <= staleMs) continue
        if (profileIsActive(profilePath)) continue
        const owner = readOwner(profilePath)
        if (owner && ownerIsAlive(owner)) continue
        rmSync(profilePath, { force: true, recursive: true })
        removed.push(profilePath)
      } catch {}
    }
  } catch {}
  return removed
}

export function acquireCdpProfile({
  explicitProfile,
  root = DEFAULT_PROFILE_ROOT,
  port = 0,
  pid = process.pid,
  processStartTime = readProcessStartTime(pid),
  reap = true,
} = {}) {
  mkdirSync(root, { recursive: true })
  if (reap) reapStaleProfiles({ root })

  if (explicitProfile) {
    return {
      path: explicitProfile,
      owned: false,
      cleanup() {
        return false
      },
      setOwner() {},
    }
  }

  const profilePath = mkdtempSync(join(root, `profile-${port}-${pid}-`))
  const writeOwner = (ownerPid, ownerStartTime = readProcessStartTime(ownerPid)) => {
    writeFileSync(
      join(profilePath, OWNER_FILE),
      JSON.stringify({ pid: ownerPid, processStartTime: ownerStartTime }),
      { mode: 0o600 },
    )
  }
  writeOwner(pid, processStartTime)
  let cleaned = false

  return {
    path: profilePath,
    owned: true,
    setOwner: writeOwner,
    cleanup() {
      if (cleaned) return true
      if (profileIsInUse(profilePath)) return false
      rmSync(profilePath, { force: true, recursive: true })
      cleaned = true
      return true
    },
  }
}
