import { describe, expect, it } from 'vitest'

import { CITY_ARCHITECTURE_CLAIMS } from '../spine/city-architecture'
import { ANCHOR, DISTRICT_BOUNDS, ROUTES } from '../world/layout'
import { buildCityArchitecture, cityArchitectureText } from './city-words-model'

describe('city architecture in words', () => {
  it('describes exactly the districts owned by the layout', () => {
    expect(Object.keys(CITY_ARCHITECTURE_CLAIMS.districts).sort()).toEqual(
      Object.keys(DISTRICT_BOUNDS).sort(),
    )

    const architecture = buildCityArchitecture()
    expect(architecture.districts.map((district) => district.id).sort()).toEqual(
      Object.keys(DISTRICT_BOUNDS).sort(),
    )
  })

  it('derives every footprint and verifies every relationship against layout evidence', () => {
    const architecture = buildCityArchitecture()

    for (const district of architecture.districts) {
      const bounds = DISTRICT_BOUNDS[district.id]
      expect(district.footprint.width).toBe(bounds.x[1] - bounds.x[0])
      expect(district.footprint.depth).toBe(bounds.z[1] - bounds.z[0])
      expect(district.footprint.center).toEqual([
        (bounds.x[0] + bounds.x[1]) / 2,
        (bounds.z[0] + bounds.z[1]) / 2,
      ])
    }

    for (const relationship of architecture.relationships) {
      expect(relationship.why.length).toBeGreaterThan(40)
      for (const route of relationship.evidence.routes) expect(ROUTES[route]).toBeDefined()
      for (const anchor of relationship.evidence.anchors) expect(ANCHOR[anchor]).toBeDefined()
    }
  })

  it('teaches the write-ahead rule and keeps the embodied limit explicit', () => {
    const text = cityArchitectureText(buildCityArchitecture())

    expect(text).toMatch(/WAL is written before the data pages it protects/i)
    expect(text).toMatch(/buffer pool[\s\S]+WAL[\s\S]+storage/i)
    expect(text).toMatch(/does not replace[\s\S]+first-person/i)
  })
})
