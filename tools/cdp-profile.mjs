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
import { execFileSync } from 'node:child_process'

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

/*
 * Every running process's command line. Linux exposes them under /proc; macOS
 * and the other BSD-family hosts do not, and reading /proc there silently
 * reported that no profile was ever in use. Returns null only when neither
 * source can be read, which callers must treat as "unknown", not "idle".
 */
function readCommandLines() {
  try {
    const lines = []
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue
      try {
        lines.push(readFileSync(`/proc/${pid}/cmdline`).toString().split('\0').join(' '))
      } catch {}
    }
    return lines
  } catch {}

  try {
    // -ww defeats the width truncation that would cut the --user-data-dir flag.
    return execFileSync('ps', ['-A', '-ww', '-o', 'args='], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }).split('\n')
  } catch {
    return null
  }
}

export function profileIsInUse(profilePath) {
  const commandLines = readCommandLines()
  if (!commandLines) return true

  const profileArgument = `--user-data-dir=${profilePath}`
  // Chrome flattens its command line into argv[0] on some hosts.
  return commandLines.some((line) => line.split(/\s+/).includes(profileArgument))
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
