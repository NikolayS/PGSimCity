import { describe, expect, it } from 'vitest'
import {
  labelAreaBudget,
  labelAreaPlacementBudget,
  mapLabelPriority,
  labelScale,
  WALK_LABEL_CAP,
  WALK_LABEL_MAX_DISTANCE,
  WALK_LABEL_SCALE,
  walkLabelPriority,
} from './label-layout'

describe('floating label screen budget', () => {
  it('gives a phone substantially less of its frame to chips', () => {
    const phone = labelAreaBudget(390)
    const desktop = labelAreaBudget(1280)

    expect(phone).toBeLessThan(desktop * 0.6)
    expect(labelAreaPlacementBudget(390)).toBeLessThan(phone)
    expect(labelAreaPlacementBudget(1280)).toBeLessThan(desktop)
  })

  it('makes a nearby chip visibly larger than a distant readable chip', () => {
    const near = labelScale(60)
    const far = labelScale(600)

    expect(far).toBeGreaterThan(0)
    expect(near).toBeGreaterThan(far * 1.2)
  })

  it('retires chips instead of returning an unreadably small scale', () => {
    let retired = false

    for (let distance = 0; distance <= 2000; distance += 25) {
      const scale = labelScale(distance)
      if (scale === 0) {
        retired = true
      } else {
        expect(retired).toBe(false)
        expect(scale).toBeGreaterThanOrEqual(1)
      }
    }

    expect(retired).toBe(true)
  })

  it('keeps the map hierarchy readable after component chips retire', () => {
    expect(labelScale(1_650)).toBe(0)
    expect(labelScale(1_650, 'map', 390)).toBe(1)
    expect(labelScale(1_650, 'map', 1280)).toBe(0)
  })

  it('spends a phone map budget on districts before the redundant city chip', () => {
    expect(mapLabelPriority('district', 390)).toBeLessThan(mapLabelPriority('city', 390))
    expect(mapLabelPriority('city', 1280)).toBeLessThan(mapLabelPriority('district', 1280))
  })

  it('gives walking its own local object policy instead of the map hierarchy', () => {
    expect(WALK_LABEL_CAP).toBe(1)
    expect(WALK_LABEL_SCALE).toBe(1)
    expect(walkLabelPriority(-1, false, 20, 0)).toBeNull()
    expect(walkLabelPriority(3, false, 20, 0)).toBeNull()
    expect(walkLabelPriority(0, true, 20, 0)).toBeNull()
    expect(walkLabelPriority(0, false, WALK_LABEL_MAX_DISTANCE + 1, 0)).toBeNull()
    expect(walkLabelPriority(0, false, 30, 20)).not.toBeNull()
  })

  it('identifies the object in front before a peripheral neighbour', () => {
    const ahead = walkLabelPriority(1, false, 38, 8)
    const peripheral = walkLabelPriority(0, false, 24, 240)

    expect(ahead).not.toBeNull()
    expect(peripheral).not.toBeNull()
    expect(ahead!).toBeLessThan(peripheral!)
  })
})
