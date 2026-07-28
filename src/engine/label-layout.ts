/** Hard cap for the sum of placed chip rectangles, as a fraction of the frame. */
export const LABEL_AREA_BUDGET = 0.04
/** Leaves room for subpixel rounding and a collapse count changing width. */
export const LABEL_AREA_PLACEMENT_BUDGET = LABEL_AREA_BUDGET * 0.95

/** Ordinary label type is 11 px, so scale 1 is the legibility floor. */
export const LABEL_SCALE_FLOOR = 1
export const LABEL_SCALE_CEILING = 1.12
export const LABEL_PHONE_SCALE_CEILING = 1.06
export const LABEL_PHONE_MAX_WIDTH = 700

const SCALE_NEAR = 90
const SCALE_FAR = 650
const SCALE_STEPS = 200

/**
 * Make nearby chips larger without ever shrinking the 11 px type below its
 * legible floor. Phones use a lower ceiling; their area budget removes detail
 * once scale reaches the floor.
 */
export function labelScale(distance: number, viewportWidth: number): number {
  const ceiling =
    viewportWidth <= LABEL_PHONE_MAX_WIDTH ? LABEL_PHONE_SCALE_CEILING : LABEL_SCALE_CEILING
  const t = (distance - SCALE_NEAR) / (SCALE_FAR - SCALE_NEAR)
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t
  const smooth = clamped * clamped * (3 - 2 * clamped)
  const scale = ceiling + (LABEL_SCALE_FLOOR - ceiling) * smooth
  return Math.round(scale * SCALE_STEPS) / SCALE_STEPS
}
