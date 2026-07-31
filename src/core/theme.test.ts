import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'

import {
  COLOR,
  atmosphere,
  createTheme,
  setBloomAvailable,
  setThemeClockMinutes,
  setThemeMode,
  themeEnvironmentKey,
  themeMode,
} from './theme'
import { BAKED_SKY_COLOR, NIGHT_PALETTE } from './themes'
import type { CuratedThemeMode, ThemeMode } from './themes'

const READABLE_LUMINANCE = 0.24

describe('prefiltered environment identity', () => {
  it('changes on a theme switch and only at the clock refresh cadence', () => {
    setThemeMode('day', { persist: false })
    expect(themeEnvironmentKey()).toBe('day')

    setThemeMode('clock', { persist: false })
    setThemeClockMinutes(12 * 60)
    const noon = themeEnvironmentKey()
    setThemeClockMinutes(12 * 60 + 14)
    expect(themeEnvironmentKey()).toBe(noon)
    setThemeClockMinutes(12 * 60 + 15)
    expect(themeEnvironmentKey()).not.toBe(noon)

    setThemeMode('night', { persist: false })
    expect(themeEnvironmentKey()).toBe('night')
  })
})

function luminance({ r, g, b }: { r: number; g: number; b: number }): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

describe('bloom-off neon fallback', () => {
  /* This suite is about NIGHT behaviour -- the neon repaint that carries meaning
   * when the bloom pass is unavailable. It used to rely on night being the
   * default mode, which quietly coupled it to an unrelated product decision.
   * Say which mode it means. */
  beforeEach(() => {
    setThemeMode('night', { persist: false })
  })

  afterEach(() => {
    setBloomAvailable(true)
  })

  it('keeps representative semantic colours readable without bloom', () => {
    const theme = createTheme()
    const materials = [
      ['dirty page', theme.neon(NIGHT_PALETTE.bufDirty, 0.55)],
      ['clean page', theme.neon(NIGHT_PALETTE.bufClean, 0.55)],
      ['WAL', theme.neon(NIGHT_PALETTE.wal, 0.55)],
      ['storage', theme.neon(NIGHT_PALETTE.storage, 0.55)],
    ] as const
    setBloomAvailable(false)

    for (const [meaning, material] of materials) {
      expect(luminance(material.color), meaning).toBeGreaterThanOrEqual(READABLE_LUMINANCE)
    }

    theme.dispose()
  })

  it('restores the authored night neon exactly when bloom returns', () => {
    const theme = createTheme()
    const material = theme.neon(NIGHT_PALETTE.bufDirty, 0.55)
    const authored = material.color.clone()

    setBloomAvailable(false)
    setBloomAvailable(true)

    expect(material.color.equals(authored)).toBe(true)

    theme.dispose()
  })
})

/*
 * A stand-in for what three hands onBeforeCompile. Only the anchors matter: the
 * theme finds its injection points by chunk name, and the standard/physical
 * chunks are what tell it a material is structure rather than meaning.
 */
const STANDARD_FRAG = [
  '#include <lights_physical_pars_fragment>',
  'void main() {',
  '  vec4 diffuseColor = vec4( diffuse, opacity );',
  '  #include <color_fragment>',
  '  #include <roughnessmap_fragment>',
  '  #include <normal_fragment_maps>',
  '  #include <lights_fragment_end>',
  '}',
].join('\n')

const STANDARD_VERT = ['void main() {', '  #include <worldpos_vertex>', '}'].join('\n')

const BASIC_FRAG = [
  'void main() {',
  '  vec4 diffuseColor = vec4( diffuse, opacity );',
  '  #include <color_fragment>',
  '}',
].join('\n')

const BASIC_VERT = ['void main() {', '  #include <project_vertex>', '}'].join('\n')

interface Compiled {
  vertexShader: string
  fragmentShader: string
}

function compile(material: THREE.Material, structural: boolean): Compiled {
  const shader: Compiled = {
    vertexShader: structural ? STANDARD_VERT : BASIC_VERT,
    fragmentShader: structural ? STANDARD_FRAG : BASIC_FRAG,
  }
  const hook = material.onBeforeCompile as unknown as ((s: Compiled) => void) | undefined
  expect(typeof hook).toBe('function')
  hook!(shader)
  return shader
}

function inMode<T>(mode: ThemeMode, fn: () => T): T {
  const before = themeMode()
  setThemeMode(mode, { persist: false })
  try {
    return fn()
  } finally {
    setThemeMode(before, { persist: false })
  }
}

const MIN_MATTE_BACKGROUND_SEPARATION = 0.006
const WALL_SKY_ACCESS = 0.58

function currentMatteBackgroundSeparation(theme: ReturnType<typeof createTheme>): number {
  const material = theme.mat('wal.struct.contrast', {
    color: 0x2a3752,
    roughness: 0.72,
    metalness: 0.3,
    emissive: 0x070c16,
  })
  const shader = compile(material, true)
  const match = /const vec3 pgBakeSkyColor = vec3\( ([^)]+) \);/.exec(shader.vertexShader)
  expect(match).not.toBeNull()
  const channels = match![1].split(',').map(Number)
  expect(channels).toHaveLength(3)

  const air = atmosphere()
  const irradiance = new THREE.Color(air.hemiSky)
    .add(new THREE.Color(air.hemiGround))
    .multiplyScalar(air.hemiIntensity * 0.5)
    .add(new THREE.Color(channels[0], channels[1], channels[2]).multiplyScalar(WALL_SKY_ACCESS))
  const surface = material.color.clone().multiply(irradiance)
    .add(material.emissive.clone().multiplyScalar(material.emissiveIntensity))
  const background = new THREE.Color(COLOR.bg)
  return Math.abs(luminance(surface) - luminance(background))
}

function matteBackgroundSeparation(
  theme: ReturnType<typeof createTheme>,
  target: CuratedThemeMode,
): number {
  return inMode(target, () => currentMatteBackgroundSeparation(theme))
}

describe('matte structure against its background', () => {
  it.each(['night', 'day'] as const)('keeps %s structure visibly separate', (target) => {
    const theme = createTheme()
    const separation = matteBackgroundSeparation(theme, target)

    expect(
      separation,
      `${target} matte/background luminance separation ${separation.toFixed(6)}`,
    ).toBeGreaterThanOrEqual(MIN_MATTE_BACKGROUND_SEPARATION)

    theme.dispose()
  })

  it('keeps structure separate at every dark sample on the local-clock path', () => {
    const before = themeMode()
    const theme = createTheme()
    setThemeMode('clock', { persist: false })
    try {
      for (let minutes = 0; minutes < 1440; minutes += 10) {
        setThemeClockMinutes(minutes)
        const separation = currentMatteBackgroundSeparation(theme)
        expect(
          separation,
          `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} matte/background separation ${separation.toFixed(6)}`,
        ).toBeGreaterThanOrEqual(MIN_MATTE_BACKGROUND_SEPARATION)
      }
    } finally {
      theme.dispose()
      setThemeMode(before, { persist: false })
    }
  })
})

describe('the masonry surface term', () => {
  let theme: ReturnType<typeof createTheme>

  beforeEach(() => {
    setThemeMode('night', { persist: false })
    theme = createTheme()
  })

  afterEach(() => {
    theme.dispose()
    setThemeMode('night', { persist: false })
  })

  it('reaches structure in both modes', () => {
    for (const mode of ['day', 'night'] as const) {
      const out = inMode(mode, () => compile(theme.mat(`wal.struct.${mode}`, { color: 0x2a3752 }), true))
      expect(out.fragmentShader, mode).toContain('varying vec3 pgWorld;')
      expect(out.vertexShader, mode).toContain('varying vec3 pgWorld;')
      // The world position has to survive instancing, or every instanced tower
      // in the city would course from the same origin and read as one object.
      expect(out.vertexShader, mode).toContain('instanceMatrix')
    }
  })

  it('adds baked transport to indirect diffuse without touching emissive', () => {
    for (const mode of ['day', 'night'] as const) {
      const out = inMode(mode, () =>
        compile(theme.mat(`wal.baked.${mode}`, { color: 0x2a3752 }), true),
      )
      expect(out.vertexShader, mode).toContain('attribute vec3 pgBakeSkyA;')
      expect(out.vertexShader, mode).toContain('varying vec3 pgBakedIndirect;')
      expect(out.fragmentShader, mode).toContain('irradiance += pgBakedIndirect;')
      const baked = out.vertexShader.slice(out.vertexShader.indexOf('vec3 pgBakedTransport'))
      expect(baked).not.toContain('totalEmissiveRadiance')
      expect(baked).not.toContain('emissive')
    }
  })

  it('recombines one transport bake with separate day and night light', () => {
    const day = inMode('day', () =>
      compile(theme.mat('storage.baked.day', { color: 0x1a2333 }), true),
    )
    const night = inMode('night', () =>
      compile(theme.mat('storage.baked.night', { color: 0x1a2333 }), true),
    )
    expect(day.vertexShader).toContain(`const vec3 pgBakeSkyColor = vec3( ${BAKED_SKY_COLOR.day[0].toFixed(6)}`)
    expect(night.vertexShader).toContain(`const vec3 pgBakeSkyColor = vec3( ${BAKED_SKY_COLOR.night[0].toFixed(6)}`)
    expect(day.vertexShader).not.toBe(night.vertexShader)
  })

  it('cannot reach meaning: neon and line materials get nothing', () => {
    for (const mode of ['day', 'night'] as const) {
      const neon = inMode(mode, () => compile(theme.neon(0xff4d6d, 2.4), false))
      const line = inMode(mode, () => compile(theme.line(0x8fa5c4, 0.4), false))
      for (const out of [neon, line]) {
        expect(out.fragmentShader, mode).not.toContain('pgWorld')
        expect(out.vertexShader, mode).not.toContain('pgWorld')
      }
    }
  })

  it('is refused to a structural material that asks to opt out', () => {
    const out = inMode('day', () =>
      compile(theme.mat('wal.glass', { color: 0x9fd8ff, surface: false }), true),
    )
    expect(out.fragmentShader).not.toContain('pgWorld')
    // ...but that material still gets the day toon ramp, which is not optional.
    expect(out.fragmentShader).toContain('RE_Direct_Toon')
  })

  it('derives roughness and a restrained normal from the same surface height', () => {
    const out = inMode('day', () => compile(theme.mat('storage.struct', { color: 0x1a2333 }), true))
    const surface = out.fragmentShader.slice(out.fragmentShader.indexOf('vec3 pgDX'))
    expect(surface.length).toBeGreaterThan(0)
    expect(surface).toContain('pgSurfaceHeight')
    expect(surface).toContain('roughnessFactor = clamp')
    expect(surface).toContain('normal = normalize')
    expect(surface).toContain('dFdx( pgSurfaceHeight )')
    expect(surface).toContain('dFdy( pgSurfaceHeight ) ) * 0.65')
    expect(surface).toMatch(/pgNormalFade = 1\.0 - smoothstep\( 0\.[0-9]+, 0\.[0-9]+, pgPx \)/)
    for (const forbidden of ['emissive', 'gl_FragColor', 'reflectedLight', 'totalEmissiveRadiance']) {
      expect(surface, forbidden).not.toContain(forbidden)
    }
    const writes = surface.match(/\n\tdiffuseColor[^;]*;/g) ?? []
    expect(writes.length).toBeGreaterThan(0)
    for (const write of writes) expect(write).toContain('*=')
  })

  it('stays inside the eight percent contrast ceiling', () => {
    /* Amplitude discipline is the whole difference between a wall and a sci-fi
     * panel, and the joint darkening is the loudest term in the set. */
    const out = inMode('day', () => compile(theme.mat('access.struct', { color: 0x121a29 }), true))
    const joint = /pgBed \* ([0-9.]+) \+ pgPerp \* ([0-9.]+)/.exec(out.fragmentShader)
    expect(joint).not.toBeNull()
    expect(Number(joint![1]) + Number(joint![2])).toBeLessThanOrEqual(0.08)
  })

  it('gives the surfaced and plain variants different program cache keys', () => {
    const surfaced = theme.mat('backends.struct', { color: 0x2a3852 })
    const plain = theme.mat('backends.rubber', { color: 0x2a3852, surface: false })
    const a = surfaced.customProgramCacheKey?.()
    expect(a).toBeTruthy()
    expect(a).not.toBe(plain.customProgramCacheKey?.())
  })

  it('recompiles a material once per mode change and not again', () => {
    /* Material.version is what three actually watches; `needsUpdate` is a
     * write-only setter that bumps it. A mode change touches every material in
     * the city at once, so paying for two recompiles instead of one doubles
     * the stall the viewer sees on the theme toggle. */
    const material = theme.mat('clients.struct', { color: 0x23304a })
    const built = material.version
    setThemeMode('day', { persist: false })
    expect(material.version).toBe(built + 1)
    setThemeMode('day', { persist: false })
    expect(material.version).toBe(built + 1)
    setThemeMode('night', { persist: false })
    expect(material.version).toBe(built + 2)
  })
})

describe('the day toon ramp', () => {
  let theme: ReturnType<typeof createTheme>

  beforeEach(() => {
    setThemeMode('night', { persist: false })
    theme = createTheme()
  })

  afterEach(() => {
    theme.dispose()
    setThemeMode('night', { persist: false })
  })

  it('is compiled in for daylight and left out at night', () => {
    const day = inMode('day', () => compile(theme.mat('maint.struct', { color: 0x2b3550 }), true))
    expect(day.fragmentShader).toContain('#define RE_Direct RE_Direct_Toon')

    const night = inMode('night', () => compile(theme.mat('maint.heavy', { color: 0x232d44 }), true))
    expect(night.fragmentShader).not.toContain('RE_Direct_Toon')
  })

  it('separates a roof from a sunlit wall', () => {
    const out = inMode('day', () => compile(theme.mat('rep.struct', { color: 0x27334c }), true))
    /* Three ingredients, all required: two N·L thresholds for the wall tones,
     * and a world-space up term for the roof, which no dot product against the
     * sun can find on its own — a roof and a wall can share a dot product. */
    expect(out.fragmentShader).toContain('0.14 - w')
    expect(out.fragmentShader).toContain('0.68 - w')
    expect(out.fragmentShader).toContain('worldN.y')
  })

  it('gates the cartoon highlight on roughness so matte stone stays matte', () => {
    const out = inMode('day', () => compile(theme.mat('shmem.struct', { color: 0x1b2435 }), true))
    expect(out.fragmentShader).toContain('smoothstep( 0.35, 0.75, material.roughness )')
  })

  it('leaves the night vertex-colour buffers alone', () => {
    // The day remap inverts brightness into ink. Applied at night it would
    // erase the plaza's page grid, so it must be a daylight-only injection.
    const night = inMode('night', () => compile(theme.mat('shmem.struct', { color: 0x1b2435 }), true))
    expect(night.fragmentShader).toContain('#include <color_fragment>')
    const day = inMode('day', () => compile(theme.mat('shmem.pylon', { color: 0x0f1522 }), true))
    expect(day.fragmentShader).not.toContain('#include <color_fragment>')
  })
})

describe('the daylight per-instance remap', () => {
  let theme: ReturnType<typeof createTheme>

  beforeEach(() => {
    setThemeMode('night', { persist: false })
    theme = createTheme()
  })

  afterEach(() => {
    theme.dispose()
    setThemeMode('night', { persist: false })
  })

  it('lets an instance switched fully off reach inert grey', () => {
    /* A district says "this lamp is off" by writing black into its instance
     * colour buffer. The remap blends between a flat printable value and the
     * instance's own normalised hue; with a floor under that blend, black kept
     * a quarter of a colour it did not have and came out a dark slab on a
     * sunlit roof. The blend must be able to reach zero. */
    const out = inMode('day', () => compile(theme.mat('backends.trim', { color: 0x18223a }), true))
    const blend = /clamp\( \( pgM - ([0-9.]+) \) \* ([0-9.]+), ([0-9.]+), 1\.0 \)/.exec(out.fragmentShader)
    expect(blend).not.toBeNull()
    expect(Number(blend![3])).toBe(0)
    // ...and it must still reach one for anything with real colour in it: a
    // dirty page has to keep being red.
    const knee = Number(blend![1]) + 1 / Number(blend![2])
    expect(knee).toBeLessThan(0.2)
  })
})

describe('what counts as masonry', () => {
  let theme: ReturnType<typeof createTheme>

  beforeEach(() => {
    setThemeMode('day', { persist: false })
    theme = createTheme()
  })

  afterEach(() => {
    theme.dispose()
    setThemeMode('night', { persist: false })
  })

  it('courses stone and leaves machinery alone', () => {
    // A flywheel, a vault door and a pressure vessel are steel. This city
    // already says so with metalness, so nothing had to be re-declared.
    const wall = compile(theme.mat('wal.struct', { color: 0x2a3752, metalness: 0.3 }), true)
    const steel = compile(theme.mat('wal.heavy', { color: 0x202b42, metalness: 0.48 }), true)
    expect(wall.fragmentShader).toContain('pgWorld')
    expect(steel.fragmentShader).not.toContain('pgWorld')
  })
})
