export const VIEWING_RATES = Object.freeze([0.1, 0.25, 0.5, 1, 2, 3, 5])

const DEFAULT_VIEWING_RATE = 1
// Match the city's wall-time boundary: slower frames count; longer gaps are stalls.
const MAX_WALL_DELTA_SECONDS = 2

function finitePositive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

export function nearestViewingRate(value) {
  const target = finitePositive(Number(value), DEFAULT_VIEWING_RATE)
  let nearest = VIEWING_RATES[0]
  let distance = Infinity
  for (let index = 0; index < VIEWING_RATES.length; index += 1) {
    const candidate = VIEWING_RATES[index]
    const nextDistance = Math.abs(Math.log(candidate) - Math.log(target))
    if (nextDistance < distance) {
      nearest = candidate
      distance = nextDistance
    }
  }
  return nearest
}

export function nudgeViewingRate(value, direction) {
  const current = nearestViewingRate(value)
  const index = VIEWING_RATES.indexOf(current)
  const next = Math.max(0, Math.min(VIEWING_RATES.length - 1, index + Math.sign(direction)))
  return VIEWING_RATES[next]
}

export function formatViewingRate(value) {
  const rate = nearestViewingRate(value)
  return `${rate < 1 ? String(Number(rate.toFixed(2))) : rate.toFixed(0)}×`
}

/**
 * Playback rate transforms wall time into viewed model time. Model periods and
 * PostgreSQL measurements never pass through this boundary.
 */
export function viewingElapsed(wallSeconds, rate, paused) {
  if (paused) return 0
  const elapsed = Math.min(MAX_WALL_DELTA_SECONDS, finitePositive(wallSeconds, 0))
  return elapsed * nearestViewingRate(rate)
}

export function stageWallDurationMs(stageDuration, rate) {
  return Math.max(0, finitePositive(stageDuration, 0)) / nearestViewingRate(rate)
}
