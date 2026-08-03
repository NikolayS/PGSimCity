import { CITY_ARCHITECTURE_CLAIMS } from '../spine/city-architecture'
import { ANCHOR, DISTRICT_BOUNDS } from '../world/layout'
import type { AnchorId, Bounds } from '../world/layout'

export interface CityFootprint {
  width: number
  depth: number
  center: readonly [number, number]
  bounds: Bounds
}

export interface CityArchitectureDistrict {
  id: string
  name: string
  represents: string
  contains: readonly string[]
  scaleMeaning: string
  placement: string
  footprint: CityFootprint
}

export interface CityArchitectureRelationship {
  id: string
  from: string
  to: string
  placement: string
  why: string
  evidence: {
    routes: readonly string[]
    anchors: readonly AnchorId[]
  }
}

export interface CityArchitecture {
  scope: string
  orientation: string
  overview: string
  limit: string
  districts: readonly CityArchitectureDistrict[]
  relationships: readonly CityArchitectureRelationship[]
}

function cardinalPosition(x: number, z: number): string {
  const eastWest = x < -40 ? 'west' : x > 40 ? 'east' : ''
  const northSouth = z < -40 ? 'north' : z > 40 ? 'south' : ''
  if (!eastWest && !northSouth) return 'at the plan centre'
  if (!eastWest) return `${northSouth} of the plan centre`
  if (!northSouth) return `${eastWest} of the plan centre`
  return `${northSouth}-${eastWest} of the plan centre`
}

function placement(
  id: string,
  bounds: Bounds,
  anchorId: string | undefined,
): string {
  const centerX = (bounds.x[0] + bounds.x[1]) / 2
  const centerZ = (bounds.z[0] + bounds.z[1]) / 2
  const anchor = anchorId ? ANCHOR[anchorId as AnchorId] : undefined
  const y = anchor?.[1] ?? 0
  const level = y <= -10
    ? `${Math.abs(y).toFixed(0)} m below grade`
    : y >= 20
      ? `${y.toFixed(0)} m above grade`
      : y > 0
        ? `raised ${y.toFixed(0)} m above grade`
        : 'at grade'
  const reference = anchor
    ? ` Its ${anchorId} reference is at x ${anchor[0]}, y ${anchor[1]}, z ${anchor[2]}.`
    : ''
  const overall = id === 'world' ? 'centred on the whole plan' : cardinalPosition(centerX, centerZ)
  return `The reserved footprint is ${overall} and its reference level is ${level}.${reference}`
}

export function buildCityArchitecture(): CityArchitecture {
  const districtClaims = CITY_ARCHITECTURE_CLAIMS.districts as Record<
    string,
    (typeof CITY_ARCHITECTURE_CLAIMS.districts)[keyof typeof CITY_ARCHITECTURE_CLAIMS.districts]
  >
  const districts = Object.entries(DISTRICT_BOUNDS).map(([id, bounds]) => {
    const claim = districtClaims[id]
    if (!claim) throw new Error(`City architecture is missing layout district "${id}"`)
    const width = bounds.x[1] - bounds.x[0]
    const depth = bounds.z[1] - bounds.z[0]
    return {
      id,
      name: claim.name,
      represents: claim.represents,
      contains: claim.contains,
      scaleMeaning: claim.scaleMeaning,
      placement: placement(id, bounds, 'anchor' in claim ? claim.anchor : undefined),
      footprint: {
        width,
        depth,
        center: [
          (bounds.x[0] + bounds.x[1]) / 2,
          (bounds.z[0] + bounds.z[1]) / 2,
        ] as const,
        bounds,
      },
    }
  })

  return {
    scope: CITY_ARCHITECTURE_CLAIMS.scope,
    orientation: CITY_ARCHITECTURE_CLAIMS.orientation,
    overview: CITY_ARCHITECTURE_CLAIMS.overview,
    limit: CITY_ARCHITECTURE_CLAIMS.limit,
    districts,
    relationships: CITY_ARCHITECTURE_CLAIMS.relationships as readonly CityArchitectureRelationship[],
  }
}

export function cityArchitectureText(architecture: CityArchitecture): string {
  const names = new Map(architecture.districts.map((district) => [district.id, district.name]))
  const lines = [
    'THE CITY IN WORDS — POSTGRESQL ARCHITECTURE DIAGRAM',
    '',
    architecture.scope,
    architecture.orientation,
    '',
    'READING THE PLAN',
    architecture.overview,
    '',
    'DISTRICTS AND CONTAINMENT',
  ]

  for (const district of architecture.districts) {
    const bounds = district.footprint.bounds
    lines.push(
      '',
      `${district.name} [${district.id}]`,
      `Represents: ${district.represents}`,
      `Position: ${district.placement}`,
      `Footprint: ${district.footprint.width} m east–west by ${district.footprint.depth} m north–south; x ${bounds.x[0]}…${bounds.x[1]}, z ${bounds.z[0]}…${bounds.z[1]}.`,
      `Contains: ${district.contains.join('; ')}.`,
      `Scale meaning: ${district.scaleMeaning}`,
    )
  }

  lines.push('', 'MEANINGFUL ADJACENCIES AND ROUTES')
  for (const relationship of architecture.relationships) {
    lines.push(
      '',
      `${names.get(relationship.from) ?? relationship.from} → ${names.get(relationship.to) ?? relationship.to}`,
      `Placement: ${relationship.placement}`,
      `Why it matters: ${relationship.why}`,
    )
  }

  lines.push('', 'WHAT THIS TEXT CANNOT CARRY', architecture.limit)
  return lines.join('\n')
}
