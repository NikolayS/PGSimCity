const EXIT_WAIT_MS = 5000
const PROFILE_RETRY_MS = 100

function childExited(child) {
  return child.pid == null || child.exitCode !== null || child.signalCode !== null
}

function waitForChildExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(true)
    }
    child.once('exit', onExit)
    if (childExited(child)) onExit()
  })
}

export async function terminateChild(child, waitMs = EXIT_WAIT_MS) {
  if (!child || childExited(child)) return true
  try {
    child.kill('SIGTERM')
  } catch {}
  if (await waitForChildExit(child, waitMs)) return true

  try {
    child.kill('SIGKILL')
  } catch {}
  return waitForChildExit(child, waitMs)
}

export function createCdpRunCleanup({
  profile,
  releaseSlot = () => {},
  warn = console.error,
  profileRetryMs = PROFILE_RETRY_MS,
  profileWaitMs = EXIT_WAIT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let child = null
  let socket = null
  let cleanupPromise = null

  return {
    trackChild(value) {
      child = value
    },
    trackSocket(value) {
      socket = value
    },
    cleanup() {
      if (cleanupPromise) return cleanupPromise
      cleanupPromise = (async () => {
        try {
          try {
            socket?.close()
          } catch {}
          const stopped = await terminateChild(child)
          if (stopped) {
            let removed = profile?.cleanup()
            const retries = Math.ceil(profileWaitMs / profileRetryMs)
            for (
              let attempt = 0;
              profile?.owned && removed === false && attempt < retries;
              attempt++
            ) {
              await sleep(profileRetryMs)
              removed = profile.cleanup()
            }
            if (profile?.owned && removed === false) {
              warn(`[cdp] profile is still in use; left it for the stale reaper: ${profile.path}`)
            }
          } else {
            warn(`[cdp] Chrome did not exit; left profile for the stale reaper: ${profile?.path}`)
          }
        } finally {
          releaseSlot()
        }
      })()
      return cleanupPromise
    },
  }
}

export function installProcessCleanup(cleanup) {
  let exiting = false
  const listeners = []

  const exitAfterCleanup = (code, error) => {
    if (exiting) return
    exiting = true
    if (error) console.error(error)
    void cleanup()
      .catch((cleanupError) => console.error(cleanupError))
      .finally(() => process.exit(code))
  }

  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const listener = () => exitAfterCleanup(code)
    process.on(signal, listener)
    listeners.push([signal, listener])
  }

  const onUncaughtException = (error) => exitAfterCleanup(1, error)
  const onUnhandledRejection = (error) => exitAfterCleanup(1, error)
  process.on('uncaughtException', onUncaughtException)
  process.on('unhandledRejection', onUnhandledRejection)
  listeners.push(
    ['uncaughtException', onUncaughtException],
    ['unhandledRejection', onUnhandledRejection],
  )

  return () => {
    for (const [event, listener] of listeners) process.off(event, listener)
  }
}
