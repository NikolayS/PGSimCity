import { describe, expect, it } from 'vitest'
import {
  ATMOSPHERE,
  CLOCK_SUNRISE_MINUTES,
  CLOCK_SUNSET_MINUTES,
  CLOCK_ENVIRONMENT_REFRESH_MINUTES,
  DAY_PALETTE,
  NIGHT_PALETTE,
  clockAtmosphereAt,
  clockEnvironmentKeyAt,
  clockSunAt,
  dayEmissive,
  dayInkOpacity,
  daySurface,
  exactDay,
  hslOf,
} from './themes'

describe('approximate local-clock sun path', () => {
  it('moves from early light through a high noon sun and back to night', () => {
    const dawn = clockSunAt(6 * 60 + 38)
    const noon = clockSunAt(12 * 60)
    const evening = clockSunAt(17 * 60 + 30)
    const late = clockSunAt(22 * 60)

    expect(dawn.elevationDeg).toBeGreaterThan(8)
    expect(dawn.elevationDeg).toBeLessThan(15)
    expect(noon.elevationDeg).toBeGreaterThan(60)
    expect(evening.elevationDeg).toBeGreaterThan(0)
    expect(evening.elevationDeg).toBeLessThan(dawn.elevationDeg)
    expect(late.elevationDeg).toBeLessThan(0)
    expect(clockAtmosphereAt(22 * 60).daylight).toBe(false)
  })

  it('uses explicit six-to-six boundaries with a smooth civil-twilight handoff', () => {
    expect(CLOCK_SUNRISE_MINUTES).toBe(360)
    expect(CLOCK_SUNSET_MINUTES).toBe(1080)
    expect(clockSunAt(330).daylight).toBe(0)
    expect(clockSunAt(360).daylight).toBeGreaterThan(0)
    expect(clockSunAt(360).daylight).toBeLessThan(1)
    expect(clockSunAt(390).daylight).toBe(1)
    expect(clockSunAt(1050).daylight).toBe(1)
    expect(clockSunAt(1080).daylight).toBeGreaterThan(0)
    expect(clockSunAt(1110).daylight).toBe(0)
  })

  it('keeps the visible solar direction on the clock path while the key light blends through twilight', () => {
    for (const minutes of [6 * 60 + 5, 8 * 60, 12 * 60, 17 * 60 + 55, 18 * 60 + 5]) {
      const sun = clockSunAt(minutes)
      const direction = clockAtmosphereAt(minutes).sunDirection
      const length = Math.hypot(...direction)
      const elevation = Math.asin(direction[1] / length) * (180 / Math.PI)
      expect(elevation).toBeCloseTo(sun.elevationDeg, 10)
    }
  })

  it('limits PMREM recaptures to quarter-hour daylight buckets and one stable night', () => {
    expect(CLOCK_ENVIRONMENT_REFRESH_MINUTES).toBe(15)
    expect(clockEnvironmentKeyAt(12 * 60)).toBe(clockEnvironmentKeyAt(12 * 60 + 14.9))
    expect(clockEnvironmentKeyAt(12 * 60)).not.toBe(clockEnvironmentKeyAt(12 * 60 + 15))
    expect(clockEnvironmentKeyAt(1 * 60)).toBe(clockEnvironmentKeyAt(4 * 60))
    expect(clockEnvironmentKeyAt(20 * 60)).toBe(clockEnvironmentKeyAt(1 * 60))
  })
})

describe('daylight rendering contract', () => {
  it('keeps night untouched and gives daylight the sun-only effects', () => {
    expect(ATMOSPHERE.night.shadows).toBe(false)
    expect(ATMOSPHERE.night.bloomEnabled).toBe(true)
    expect(ATMOSPHERE.night.stars).toBe(true)
    expect(ATMOSPHERE.night.daylight).toBe(false)

    expect(ATMOSPHERE.day.shadows).toBe(true)
    expect(ATMOSPHERE.day.bloomEnabled).toBe(false)
    expect(ATMOSPHERE.day.stars).toBe(false)
    expect(ATMOSPHERE.day.daylight).toBe(true)
    expect(ATMOSPHERE.day.toneMapping).toBe('neutral')
  })

  it('stacks the daylight dome darkest at the zenith and palest below the horizon', () => {
    const air = ATMOSPHERE.day
    const luma = (hex: number): number =>
      0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)
    // Zenith < horizon < below-horizon haze. Any other order is a sky that gets
    // darker as it goes down, which is the night idiom and reads as a grey wall.
    expect(luma(air.skyZenith)).toBeLessThan(luma(air.skyHorizon))
    expect(luma(air.skyHorizon)).toBeLessThan(luma(air.skyHaze))
    const [, zenithSaturation] = hslOf(air.skyZenith)
    const [, horizonSaturation] = hslOf(air.skyHorizon)
    expect(zenithSaturation).toBeGreaterThan(horizonSaturation)
  })

  it('fades distance onto the sky, and lets the plate read the fog in daylight', () => {
    expect(ATMOSPHERE.day.fogColor).toBe(ATMOSPHERE.day.skyHaze)
    expect(ATMOSPHERE.night.fogColor).toBe(ATMOSPHERE.night.skyHaze)
    // The near half of the city used to receive literally no fog: at 2.0/2.0
    // over CITY.fog (220/1150) the curve did not start until 440.
    //
    // Both bounds are load-bearing. Golden hour needs visible aerial
    // perspective across the 830 m city, while the phone view still needs hue.
    const near = 220 * ATMOSPHERE.day.fogNearScale
    const far = 1150 * ATMOSPHERE.day.fogFarScale
    const fogAt = (depth: number): number => (depth - near) / (far - near)
    expect(near).toBeLessThanOrEqual(300)
    expect(fogAt(840)).toBeGreaterThan(0.35) // desktop: the far side visibly recedes
    expect(fogAt(1071)).toBeGreaterThan(0.45) // phone: distance cannot stay equally sharp
    expect(fogAt(1071)).toBeLessThan(0.62) // phone: semantic hue still survives
    // The Slonik plate silhouette depends on this number at night. Do not move it.
    expect(ATMOSPHERE.night.plateFogScale).toBe(0.32)
    expect(ATMOSPHERE.day.plateFogScale).toBeGreaterThan(ATMOSPHERE.night.plateFogScale)
  })

  it('leaves night exactly where it was when day gained its own atmosphere', () => {
    // Night is the older, better-developed theme and the day work must be a
    // pure addition to it. These are the values the renderer resolved before
    // fogColor and plateFogScale existed: fog.color came from COLOR.fog, which
    // in night mode is NIGHT_PALETTE.fog, and ground.ts held FOG_K = 0.32.
    const night = ATMOSPHERE.night
    expect(night.fogColor).toBe(NIGHT_PALETTE.fog)
    expect(night.plateFogScale).toBe(0.32)
    expect(night.fogNearScale).toBe(1)
    expect(night.fogFarScale).toBe(1)
    expect(night.skyZenith).toBe(0x030408)
    expect(night.skyHorizon).toBe(0x19273f)
    expect(night.skyGlow).toBe(0x573c14)
    expect(night.daylight).toBe(false)
    expect(night.clouds).toBe(false)
  })

  it('maps the district meanings to their hand-picked day colors', () => {
    const keys = ['client', 'backend', 'shmem', 'wal', 'storage', 'vacuum', 'replication'] as const
    for (const key of keys) expect(exactDay(NIGHT_PALETTE[key])).toBe(DAY_PALETTE[key])
    expect(new Set(keys.map((key) => DAY_PALETTE[key])).size).toBe(keys.length)
  })

  it('lifts authored navy structure into light stone and removes dark emissive fill', () => {
    const [, saturation, lightness] = hslOf(daySurface(0x101827))
    expect(lightness).toBeGreaterThanOrEqual(0.48)
    expect(saturation).toBeGreaterThan(0.1)
    expect(dayEmissive(0x0a1220)).toBe(0)
  })

  it('turns blueprint hairlines into opaque daylight ink', () => {
    expect(dayInkOpacity(0.2)).toBeGreaterThanOrEqual(0.6)
    expect(dayInkOpacity(0.8)).toBe(1)
  })
})

/*
 * The authored structural colours, by the mat() key that owns them. This is a
 * transcription of src/world, and its job is to hold the day translation to the
 * property the eye actually checks: can you tell one quarter from another?
 */
const STRUCTURE: ReadonlyArray<readonly [string, number]> = [
  ['wal.struct', 0x2a3752],
  ['wal.deep', 0x161f33],
  ['wal.heavy', 0x202b42],
  ['storage.struct', 0x1a2333],
  ['storage.structLo', 0x101827],
  ['storage.structHi', 0x27334c],
  ['maint.struct', 0x2b3550],
  ['maint.deep', 0x18202f],
  ['maint.heavy', 0x232d44],
  ['maint.vehicle', 0x39406b],
  ['shmem.struct', 0x1b2435],
  ['shmem.structLo', 0x121a29],
  ['shmem.structHi', 0x27334a],
  ['shmem.pylon', 0x0f1522],
  ['rep.struct', 0x27334c],
  ['rep.deep', 0x141c2e],
  ['rep.heavy', 0x1f2a41],
  ['rep.cool', 0x1c2740],
  ['backends.struct', 0x2a3852],
  ['backends.trim', 0x18223a],
  ['access.deck', 0x1b2434],
  ['access.struct', 0x121a29],
  ['access.steel', 0x27334a],
  ['access.tread', 0x33415c],
  ['continuity.silo', 0x1d2438],
  ['continuity.jib', 0x223049],
  ['planner.shell', 0x1a2438],
  ['ground.plinth', 0x0c1322],
  ['ground.rim', 0x111b2d],
  ['ground.mast', 0x18233a],
  ['ground.pitWall', 0x0b1220],
]

const district = (key: string): string => key.slice(0, key.indexOf('.'))

/** Shortest distance around the hue wheel, in degrees. */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

describe('daySurface — per-district stone', () => {
  it('gives every district a hue no other district uses', () => {
    const byDistrict = new Map<string, number>()
    for (const [key, night] of STRUCTURE) {
      const d = district(key)
      if (byDistrict.has(d)) continue
      byDistrict.set(d, hslOf(daySurface(night, key))[0])
    }
    // The plate, its kerb and its masts are not a quarter of the city: they are
    // the ground everything stands on, and they share the pavement's hue on
    // purpose. Every actual district has to stand alone.
    byDistrict.delete('ground')

    const entries = [...byDistrict.entries()]
    expect(entries.length).toBeGreaterThanOrEqual(8)
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const gap = hueGap(entries[i][1], entries[j][1])
        expect(
          gap,
          `${entries[i][0]} (${entries[i][1].toFixed(0)}°) vs ${entries[j][0]} (${entries[j][1].toFixed(0)}°)`,
        ).toBeGreaterThan(8)
      }
    }
  })

  it('keeps structure desaturated, well under every semantic colour', () => {
    let loudestStructure = 0
    for (const [key, night] of STRUCTURE) {
      loudestStructure = Math.max(loudestStructure, hslOf(daySurface(night, key))[1])
    }
    expect(loudestStructure).toBeLessThanOrEqual(0.22)

    // Meaning is the only saturated thing on screen, and the gap has to be wide
    // enough that the rule survives a phone screen.
    const semantic = ['wal', 'storage', 'vacuum', 'checkpoint', 'bufDirty', 'lock', 'backend', 'shmem'] as const
    let quietestMeaning = 1
    for (const key of semantic) quietestMeaning = Math.min(quietestMeaning, hslOf(DAY_PALETTE[key])[1])
    expect(quietestMeaning).toBeGreaterThan(loudestStructure * 2)
  })

  it('preserves the lightness ordering the night values encode', () => {
    // Night lightness is what carries the modelling: a pylon is darker than a
    // wall is darker than a rim. Daylight may move the band; it may not
    // reshuffle it, or every building loses its own relief.
    for (const [keyA, nightA] of STRUCTURE) {
      for (const [keyB, nightB] of STRUCTURE) {
        if (district(keyA) !== district(keyB)) continue
        const nA = hslOf(nightA)[2]
        const nB = hslOf(nightB)[2]
        if (Math.abs(nA - nB) < 0.01) continue
        const dA = hslOf(daySurface(nightA, keyA))[2]
        const dB = hslOf(daySurface(nightB, keyB))[2]
        expect(Math.sign(dA - dB), `${keyA} vs ${keyB}`).toBe(Math.sign(nA - nB))
      }
    }
  })

  it('sets pale civic structure against a materially deeper pavement', () => {
    const ground = hslOf(DAY_PALETTE.ground)[2]
    const faces = [
      ['clients.struct', 0x26354c],
      ['backends.struct', 0x2a3852],
      ['shmem.structHi', 0x27334a],
      ['storage.structHi', 0x27334c],
    ] as const
    for (const [key, night] of faces) {
      expect(hslOf(daySurface(night, key))[2], key).toBeGreaterThan(ground + 0.055)
    }
  })

  it('leaves exact palette translations alone whatever key asks', () => {
    // A structural call site that happens to hold a semantic colour still gets
    // that meaning's hand-picked day value.
    expect(daySurface(NIGHT_PALETTE.wal, 'wal.struct')).toBe(DAY_PALETTE.wal)
    expect(daySurface(0xffffff, 'wal.struct')).toBe(0xffffff)
    expect(daySurface(0x000000, 'shmem.struct')).toBe(0x000000)
  })
})

describe('the day sun', () => {
  it('rakes across the city low enough to cast shadows several storeys long', () => {
    const { keyPos, keyTarget } = ATMOSPHERE.day
    const dx = keyPos[0] - keyTarget[0]
    const dy = keyPos[1] - keyTarget[1]
    const dz = keyPos[2] - keyTarget[2]
    const len = Math.hypot(dx, dy, dz)
    const nx = dx / len
    const ny = dy / len
    const nz = dz / len
    const elevation = Math.asin(ny) * (180 / Math.PI)
    const shadowRunPerMetre = Math.hypot(nx, nz) / ny

    expect(elevation).toBeGreaterThanOrEqual(7)
    expect(elevation).toBeLessThanOrEqual(10)
    expect(shadowRunPerMetre).toBeGreaterThan(5.5)
    // The north-west key throws the backend row across the plaza to the south-east.
    expect(nx).toBeLessThan(-0.5)
    expect(nz).toBeLessThan(-0.65)
  })

  it('puts a warm key against genuinely cool shade with a real value split', () => {
    const air = ATMOSPHERE.day
    const channels = (hex: number): [number, number, number] => [
      (hex >> 16) & 255,
      (hex >> 8) & 255,
      hex & 255,
    ]
    const [keyR, , keyB] = channels(air.keyColor)
    const [skyR, , skyB] = channels(air.hemiSky)
    const [groundR, , groundB] = channels(air.hemiGround)
    const [fillR, , fillB] = channels(air.fillColor)

    expect(keyR - keyB).toBeGreaterThan(45)
    expect(skyB - skyR).toBeGreaterThan(18)
    expect(groundB - groundR).toBeGreaterThan(12)
    expect(fillB - fillR).toBeGreaterThan(24)
    expect(air.keyIntensity / air.hemiIntensity).toBeGreaterThan(2.2)
    expect(air.shadowIntensity).toBeGreaterThanOrEqual(0.78)
  })
})
