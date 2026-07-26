/** The renderer and animated world never consume more than this per frame. */
export const MAX_VISUAL_DELTA_SECONDS = 0.1
/**
 * A two-second frame is possible on the software renderer. Larger gaps are
 * treated as stalls; THREE.Timer separately drops hidden-tab time through the
 * Page Visibility API.
 */
export const MAX_WALL_DELTA_SECONDS = 2
export const MODEL_STEP_SECONDS = 1 / 30

type ModelUpdate = (dt: number) => void

export function wallDelta(rawDt: number): number {
  if (!Number.isFinite(rawDt) || rawDt <= 0) return 0
  return Math.min(rawDt, MAX_WALL_DELTA_SECONDS)
}

export function simulationAnimationDelta(
  animationDt: number,
  paused: boolean,
  timeScale: number,
): number {
  return paused ? 0 : animationDt * timeScale
}

/**
 * Keep model time synchronized to accepted wall time without giving one slow
 * update to the model. Pausing drops the fractional backlog immediately.
 */
export function createFrameTimebase(updateModel: ModelUpdate): {
  advance(elapsed: number, paused: boolean, timeScale: number): number
} {
  let remainder = 0

  return {
    advance(elapsed: number, paused: boolean, timeScale: number): number {
      if (paused) {
        remainder = 0
        return 0
      }

      remainder += elapsed
      const steps = Math.floor((remainder + MODEL_STEP_SECONDS * 1e-9) / MODEL_STEP_SECONDS)
      for (let index = 0; index < steps; index++) {
        updateModel(MODEL_STEP_SECONDS * timeScale)
      }
      remainder -= steps * MODEL_STEP_SECONDS
      if (Math.abs(remainder) < MODEL_STEP_SECONDS * 1e-9) remainder = 0
      return steps * MODEL_STEP_SECONDS
    },
  }
}
