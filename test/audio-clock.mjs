/* Test-harness readiness, not an application latency guarantee. */
export async function waitForAudioClock(contexts, {
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 5000,
} = {}) {
  if (!contexts.length) throw new Error('No audio contexts to measure')
  const startedAt = now()
  const initial = contexts.map((context) => context.currentTime)
  while (now() - startedAt < timeoutMs) {
    const advances = contexts.map((context, index) => context.currentTime - initial[index])
    if (contexts.every((context, index) => context.state === 'running' && advances[index] >= 0.05)) {
      return { elapsedMs: now() - startedAt, advances }
    }
    await sleep(16)
  }
  throw new Error(`Audio clock did not advance within ${timeoutMs} ms`)
}
