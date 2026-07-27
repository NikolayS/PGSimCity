import { ATMOSPHERE } from '../core/theme'
import type { Atmosphere } from '../core/theme'

/* ============================================================================
 * PLATE FOG — how short the ground plate reads the scene fog.
 *
 * ONE shared uniform object, deliberately module-scope: there is exactly one
 * ground, and the slab, the kerbs, the floor signage and the pit rim have to
 * agree on this number or a bright rim floats on a hazed plate.
 *
 * It lives in its own file rather than in world/ground.ts so the renderer can
 * drive it from the theme path without importing the plate geometry — and with
 * it the SVG outline loader, which needs a DOM.
 *
 * NIGHT IS 0.32 AND MUST STAY 0.32. The plate is a kilometre across and the
 * overview preset looks at all of it from 1.3 km up; at full strength the scene
 * fog swallows the Slonik silhouette entirely. That silhouette degraded across
 * four commits once with no test able to name the breaking one.
 *
 * Daylight is the opposite problem. The plate is the largest surface in frame
 * and at 0.32 it received no fog at all, so it met the sky at a hard step
 * instead of dissolving into it.
 * ==========================================================================*/

/** The live uniform. Written only by `applyGroundAtmosphere`, never per frame. */
export const plateFogK = { value: ATMOSPHERE.night.plateFogScale }

/** Follow the live theme's plate fog damping. Called from the renderer. */
export function applyGroundAtmosphere(air: Atmosphere): void {
  plateFogK.value = air.plateFogScale
}
