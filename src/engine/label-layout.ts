/** Hard caps for the sum of placed chip rectangles, as a fraction of the frame. */
export const LABEL_DESKTOP_AREA_BUDGET = 0.04
export const LABEL_PHONE_AREA_BUDGET = 0.02

const PHONE_BUDGET_MAX_WIDTH = 480
const DESKTOP_BUDGET_MIN_WIDTH = 900
const PHONE_LAYOUT_MAX_WIDTH = 700
/** Leaves room for subpixel rounding and a collapse count changing width. */
const AREA_PLACEMENT_RESERVE = 0.95

/**
 * Walking annotates one nearby object in the visitor's line of sight. The
 * orbit hierarchy is a map legend and is deliberately ineligible here.
 */
export const WALK_LABEL_CAP = 1
export const WALK_LABEL_MAX_DISTANCE = 85
/** Object signage stays subordinate at eye level; orbit's near zoom is too loud here. */
export const WALK_LABEL_SCALE = 1

/**
 * Lower wins. `centreDistanceSq` is already available from the placement pass,
 * so this adds no square root or temporary vector to the hot path.
 */
export function walkLabelPriority(
  rank: number,
  districtProxy: boolean,
  distance: number,
  centreDistanceSq: number,
): number | null {
  if (rank < 0 || rank > 2 || districtProxy || distance > WALK_LABEL_MAX_DISTANCE) return null
  return centreDistanceSq + distance * distance * 0.25
}

/**
 * A chip occupies more of the useful scene on a narrow screen, so the budget
 * grows smoothly from 2% on phones to the existing 4% on desktop.
 */
export function labelAreaBudget(viewportWidth: number): number {
  if (viewportWidth <= PHONE_BUDGET_MAX_WIDTH) return LABEL_PHONE_AREA_BUDGET
  if (viewportWidth >= DESKTOP_BUDGET_MIN_WIDTH) return LABEL_DESKTOP_AREA_BUDGET
  const t =
    (viewportWidth - PHONE_BUDGET_MAX_WIDTH) /
    (DESKTOP_BUDGET_MIN_WIDTH - PHONE_BUDGET_MAX_WIDTH)
  return LABEL_PHONE_AREA_BUDGET +
    (LABEL_DESKTOP_AREA_BUDGET - LABEL_PHONE_AREA_BUDGET) * t
}

export function labelAreaPlacementBudget(viewportWidth: number): number {
  return labelAreaBudget(viewportWidth) * AREA_PLACEMENT_RESERVE
}

/** Ordinary label type and its smallest readable rendered size, in CSS pixels. */
const LABEL_TYPE_PX = 11
const LABEL_MIN_LEGIBLE_TYPE_PX = 11
export const LABEL_NEAR_SCALE = 1.5
const LABEL_FAR_NATURAL_SCALE = 0.78

const SCALE_NEAR = 75
const SCALE_FAR = 1050
const SCALE_STEPS = 200

export type LabelScaleBand = 'component' | 'map'
export type MapLabelKind = 'city' | 'district'

/** Lower wins within the two map-hierarchy bands. */
export function mapLabelPriority(kind: MapLabelKind, viewportWidth: number): number {
  const districtsFirst = viewportWidth <= PHONE_LAYOUT_MAX_WIDTH
  if (kind === 'district') return districtsFirst ? 0 : 1
  return districtsFirst ? 1 : 0
}

/**
 * Return the perspective scale for a readable chip, or zero once that response
 * would take its 11 px type below the legibility threshold. Narrow-screen map
 * hierarchy chips hold at that floor; ordinary components retire instead.
 */
export function labelScale(
  distance: number,
  band: LabelScaleBand = 'component',
  viewportWidth = Infinity,
): number {
  const t = (distance - SCALE_NEAR) / (SCALE_FAR - SCALE_NEAR)
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t
  const smooth = clamped * clamped * (3 - 2 * clamped)
  const natural =
    LABEL_NEAR_SCALE + (LABEL_FAR_NATURAL_SCALE - LABEL_NEAR_SCALE) * smooth
  if (LABEL_TYPE_PX * natural < LABEL_MIN_LEGIBLE_TYPE_PX) {
    return band === 'map' && viewportWidth <= PHONE_LAYOUT_MAX_WIDTH
      ? LABEL_MIN_LEGIBLE_TYPE_PX / LABEL_TYPE_PX
      : 0
  }
  return Math.round(natural * SCALE_STEPS) / SCALE_STEPS
}
