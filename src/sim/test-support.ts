import { createBus } from '../core/bus'
import type { SimApi } from '../core/types'
import { createSim } from './model'

/** Aggregate properties do not need the city's 30 Hz visual integration cadence. */
export const FRAME_TEST_STEP = 1 / 30
export const AGGREGATE_TEST_STEP = 1 / 15

export function createAggregateSim(maxStep = AGGREGATE_TEST_STEP): SimApi {
  return createSim(createBus(), { maxStep })
}
