import * as THREE from 'three'
import { COLOR, mixHex } from '../core/theme'
import type { Atmosphere } from '../core/theme'
import { makeRng } from '../core/util'
import type { QualityLevel, ThemeApi } from '../core/types'

/* ============================================================================
 * SKY — one procedural atmosphere, with deliberately different day and night.
 *
 * Everything is procedural: a gradient dome, a sun drawn into that dome, one
 * instanced cloud draw, and one Points starfield. The dome is pinned to the
 * camera every frame so the atmosphere stays at infinity.
 *
 * Both shaders end with three's own tonemapping + colorspace chunks so they sit
 * in exactly the same colour pipeline as the city. The sun's soft rim is drawn
 * into the sky rather than sent through the bloom pass; daylight therefore
 * keeps bloom free for semantic night lighting.
 * ==========================================================================*/

const SKY_RADIUS = 1800
const STAR_RADIUS = 1720
const N_STARS = 1400
const CLOUD_RADIUS = 1500

/* ---------------------------------------------------------------------------
 * SLONIK, the asterism.
 *
 * Fourteen stars in the eastern sky, above the WAL district — which is where a
 * visitor at the establishing shot is already looking. It is deliberately a
 * *sparse* reading of the outline, not a tracing of it: the points sit on the
 * strong corners (brow, crown, ear, notch, jaw, trunk, curl) with the spacing
 * left irregular, the magnitudes uneven, and only some of the links drawn. An
 * asterism you have to finish yourself is the only kind that reads as one.
 *
 * Coordinates are in the constellation's own plane, x right, y up, degrees.
 * -------------------------------------------------------------------------*/

/** Where the figure sits: azimuth in the XZ plane, then elevation. */
const ASTERISM_AZ = Math.atan2(0.851, 0.522)
const ASTERISM_EL = 0.42 // ~24°, high enough to clear the skyline
/** Degrees of sky per unit of the figure below. */
const ASTERISM_SCALE = 1.42
/** Faint but deliberately visible against the night dome. */
export const SLONIK_LINK_OPACITY = 0.22

/** x, y, magnitude 0..1. */
const ASTERISM: readonly (readonly [number, number, number])[] = [
  [-11.4, 1.0, 0.55], // the face, low
  [-12.2, 9.6, 0.85], // the brow
  [-7.6, 15.2, 0.5], // the forehead
  [-1.4, 17.0, 0.95], // the crown — the bright one
  [3.2, 14.6, 0.45], // the temple dip
  [8.6, 16.4, 0.7], // the top of the ear
  [15.4, 8.0, 0.9], // the ear, outer
  [13.6, -1.4, 0.5],
  [10.2, -8.4, 0.65], // the bottom of the ear
  [6.4, -5.6, 0.4], // the notch
  [1.0, -10.2, 0.6], // the jaw
  [-4.4, -13.4, 0.5], // the trunk leaves the jaw
  [-10.6, -16.8, 0.75], // the trunk
  [-15.8, -14.2, 0.85], // the curl
]

/** Which stars are joined. Gaps are on purpose. */
const ASTERISM_LINKS: readonly (readonly [number, number])[] = [
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 6],
  [6, 7],
  [8, 9],
  [10, 11],
  [11, 12],
  [12, 13],
  [0, 1],
]

const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  // Pin to the far plane. The dome can then never be clipped by whatever the
  // camera's far distance happens to be, and it never occludes anything.
  gl_Position = vec4( p.xy, p.w, p.w );
}
`

const skyFrag = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uSunDirection;
uniform float uDaylight;
varying vec3 vDir;

void main() {
  vec3 d = normalize( vDir );
  float h = d.y;

  vec3 col;
  if ( uDaylight > 0.5 ) {
    // The plate is finite and the establishing camera looks down, so its
    // visible skyline lies below the mathematical horizon. Grade from that
    // distant plate edge or the entire first-load band stays one flat color.
    float skyHeight = pow( smoothstep( -0.30, 0.62, h ), 0.72 );
    col = mix( uHorizon, uZenith, skyHeight );

    // A trace of warm suspended haze stops the horizon reading as white fog.
    float haze = exp( - abs( h + 0.28 ) * 12.0 );
    col = mix( col, uGlow, haze * 0.055 );

    // The directional light and this disc share one direction. A compact halo
    // softens the edge without turning the sky into a lens flare.
    float sunDot = dot( d, uSunDirection );
    float halo = smoothstep( 0.99756, 0.99970, sunDot );
    float disc = smoothstep( 0.99951, 0.99978, sunDot );
    col += vec3( 1.0, 0.72, 0.34 ) * halo * 0.11;
    col = mix( col, vec3( 1.0, 0.82, 0.48 ), disc * 0.94 );

    // Deep below the visual skyline only the ground plate should be visible.
    col *= mix( 0.58, 1.0, smoothstep( -0.48, -0.28, h ) );
  } else {
    // The established night gradient and restrained eastern warmth.
    col = mix( uHorizon, uZenith, smoothstep( -0.04, 0.62, h ) );
    float band = exp( - abs( h ) * 8.5 );
    col += uHorizon * band * 0.30;
    float east = clamp( d.x, 0.0, 1.0 );
    col += uGlow * band * pow( east, 2.4 );
    col *= mix( 0.18, 1.0, smoothstep( -0.30, -0.01, h ) );
  }

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const starVert = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aPhase;
uniform float uTime;
uniform float uScale;
varying vec3 vColor;
varying float vTw;

void main() {
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  // twinkle: a slow per-star sine, evaluated on the GPU — the CPU never touches a star
  float rate = 0.55 + fract( aPhase * 7.31 ) * 1.15;
  vTw = 0.62 + 0.38 * sin( uTime * rate + aPhase * 6.2831853 );
  vColor = aColor;
  gl_PointSize = aSize * ( uScale / max( 1.0, - mv.z ) ) * ( 0.86 + 0.14 * vTw );
  vec4 p = projectionMatrix * mv;
  gl_Position = vec4( p.xy, p.w, p.w );
}
`

const starFrag = /* glsl */ `
varying vec3 vColor;
varying float vTw;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot( d, d );
  float a = exp( - r2 * 17.0 ) * ( 1.0 - smoothstep( 0.15, 0.25, r2 ) );
  gl_FragColor = vec4( vColor * vTw, a * 0.92 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const cloudVert = /* glsl */ `
attribute vec3 aCenter;
attribute vec2 aSize;
attribute float aShape;
attribute float aSpeed;
uniform float uTime;
varying vec2 vUv;
varying float vShape;

void main() {
  float angle = uTime * aSpeed;
  float ca = cos( angle );
  float sa = sin( angle );
  vec3 center = aCenter;
  center.xz = mat2( ca, -sa, sa, ca ) * center.xz;

  // Offset in view space: every instance is a camera-facing patch of sky.
  vec4 mv = modelViewMatrix * vec4( center, 1.0 );
  mv.xy += position.xy * aSize;
  gl_Position = projectionMatrix * mv;
  vUv = uv * 2.0 - 1.0;
  vShape = aShape;
}
`

const cloudFrag = /* glsl */ `
uniform vec3 uCloudTop;
uniform vec3 uCloudBottom;
varying vec2 vUv;
varying float vShape;

float circle( vec2 p, vec2 center, float radius ) {
  return length( p - center ) - radius;
}

void main() {
  vec2 p = vUv;
  float spread = ( vShape - 0.5 ) * 0.16;
  float d = circle( p, vec2( -0.62 - spread, -0.06 ), 0.31 );
  d = min( d, circle( p, vec2( -0.34, 0.10 + spread ), 0.38 ) );
  d = min( d, circle( p, vec2( -0.03, 0.31 ), 0.44 ) );
  d = min( d, circle( p, vec2( 0.34, 0.14 - spread ), 0.37 ) );
  d = min( d, circle( p, vec2( 0.63 + spread, -0.07 ), 0.29 ) );

  // The horizontal cut is what makes these read as cumulus, not smoke puffs.
  float base = -0.31 + spread * 0.25;
  d = max( d, base - p.y );
  float alpha = ( 1.0 - smoothstep( -0.015, 0.105, d ) ) * 0.72;
  if ( alpha < 0.006 ) discard;

  float light = smoothstep( base, 0.62, p.y );
  vec3 col = mix( uCloudBottom, uCloudTop, 0.32 + light * 0.68 );
  gl_FragColor = vec4( col, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/** Cool white, a few amber, a few pale blue — no green, nothing saturated. */
const STAR_TINTS: readonly number[] = [
  0xdfe9ff, 0xdfe9ff, 0xdfe9ff, 0xdfe9ff, 0xc9d8ff, 0xffffff, 0xffd9a8, 0xa9c8ff,
]

/** Azimuth°, elevation°, width, height, silhouette variant, radians/second. */
const CLOUDS: readonly (readonly [number, number, number, number, number, number])[] = [
  [-68, 17, 190, 76, 0.15, 0.00016],
  [-39, 25, 235, 88, 0.72, 0.00012],
  [-10, 14, 170, 66, 0.38, 0.00019],
  [24, 29, 215, 82, 0.9, 0.00014],
  [58, 19, 178, 68, 0.52, 0.00021],
  // Home looks down toward azimuth 149°. This high, distant bank sits behind
  // the finite plate even though that makes its sky-dome elevation negative.
  [145, -12, 205, 88, 0.27, 0.00015],
  [118, 24, 225, 84, 0.64, 0.00013],
]

/** Clouds cost one transparent draw, so the emergency tier leaves it out. */
export function skyCloudsVisible(air: Atmosphere, quality: QualityLevel): boolean {
  return air.clouds && quality !== 'low'
}

/**
 * Repaint the procedural atmosphere through the renderer's live theme path.
 * The light-to-target vector is the apparent direction toward the sun.
 */
export function applySkyAtmosphere(sky: THREE.Object3D, air: Atmosphere, quality: QualityLevel): void {
  const dome = sky.getObjectByName('sky.dome') as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | undefined
  const uniforms = dome?.material.uniforms
  if (uniforms) {
    const zenith = uniforms.uZenith?.value as THREE.Color | undefined
    const horizon = uniforms.uHorizon?.value as THREE.Color | undefined
    const glow = uniforms.uGlow?.value as THREE.Color | undefined
    zenith?.setHex(air.skyZenith)
    horizon?.setHex(air.skyHorizon)
    glow?.setHex(air.skyGlow)
    const sun = uniforms.uSunDirection?.value as THREE.Vector3 | undefined
    if (sun) {
      const x = air.keyPos[0] - air.keyTarget[0]
      const y = air.keyPos[1] - air.keyTarget[1]
      const z = air.keyPos[2] - air.keyTarget[2]
      const invLength = 1 / Math.hypot(x, y, z)
      sun.set(x * invLength, y * invLength, z * invLength)
    }
    if (uniforms.uDaylight) uniforms.uDaylight.value = air.daylight ? 1 : 0
  }

  const stars = sky.getObjectByName('sky.stars')
  if (stars) stars.visible = air.stars
  const clouds = sky.getObjectByName('sky.clouds')
  if (clouds) clouds.visible = skyCloudsVisible(air, quality)
}

/**
 * Build the sky. Add the returned object straight to the scene; it owns its
 * per-frame clock and camera pinning and never needs an external tick.
 */
export function createSky(theme: ThemeApi): THREE.Object3D {
  const group = new THREE.Group()
  group.name = 'sky'
  group.matrixAutoUpdate = true

  /* ---- dome ---- */

  // Palette-derived so the dome, the fog and the ground clear colour agree.
  const zenith = mixHex(COLOR.bg, 0x000000, 0.35)
  const horizon = mixHex(COLOR.fog, COLOR.gridBright, 0.5)
  const glow = mixHex(0x000000, COLOR.wal, 0.34)

  const domeGeo = new THREE.SphereGeometry(SKY_RADIUS, 32, 20)
  const domeMat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color(zenith) },
      uHorizon: { value: new THREE.Color(horizon) },
      uGlow: { value: new THREE.Color(glow) },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uDaylight: { value: 0 },
    },
    vertexShader: skyVert,
    fragmentShader: skyFrag,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })
  const dome = new THREE.Mesh(domeGeo, domeMat)
  dome.name = 'sky.dome'
  dome.frustumCulled = false
  dome.renderOrder = -1000
  dome.raycast = () => {}
  group.add(dome)

  /* ---- clouds: seven instances, one draw, no texture ------------------- */

  const cloudGeo = new THREE.InstancedBufferGeometry()
  cloudGeo.setIndex([0, 1, 2, 0, 2, 3])
  cloudGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
  )
  cloudGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))

  const cloudCenters = new Float32Array(CLOUDS.length * 3)
  const cloudSizes = new Float32Array(CLOUDS.length * 2)
  const cloudShapes = new Float32Array(CLOUDS.length)
  const cloudSpeeds = new Float32Array(CLOUDS.length)
  for (let i = 0; i < CLOUDS.length; i++) {
    const [azimuth, elevation, width, height, shape, speed] = CLOUDS[i]
    const az = THREE.MathUtils.degToRad(azimuth)
    const el = THREE.MathUtils.degToRad(elevation)
    const horizontal = Math.cos(el) * CLOUD_RADIUS
    cloudCenters[i * 3] = Math.sin(az) * horizontal
    cloudCenters[i * 3 + 1] = Math.sin(el) * CLOUD_RADIUS
    cloudCenters[i * 3 + 2] = -Math.cos(az) * horizontal
    cloudSizes[i * 2] = width
    cloudSizes[i * 2 + 1] = height
    cloudShapes[i] = shape
    cloudSpeeds[i] = speed
  }
  cloudGeo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(cloudCenters, 3))
  cloudGeo.setAttribute('aSize', new THREE.InstancedBufferAttribute(cloudSizes, 2))
  cloudGeo.setAttribute('aShape', new THREE.InstancedBufferAttribute(cloudShapes, 1))
  cloudGeo.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(cloudSpeeds, 1))
  cloudGeo.instanceCount = CLOUDS.length
  cloudGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), CLOUD_RADIUS * 1.2)

  const skyTime = { value: 0 }
  const cloudMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: skyTime,
      uCloudTop: { value: new THREE.Color(0xfffdf6) },
      uCloudBottom: { value: new THREE.Color(0xc5d3dd) },
    },
    vertexShader: cloudVert,
    fragmentShader: cloudFrag,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: false,
  })
  const clouds = new THREE.Mesh(cloudGeo, cloudMat)
  clouds.name = 'sky.clouds'
  clouds.visible = false
  clouds.frustumCulled = false
  clouds.renderOrder = -997
  clouds.raycast = () => {}
  group.add(clouds)

  /* ---- stars ---- */

  const nTotal = N_STARS + ASTERISM.length
  const pos = new Float32Array(nTotal * 3)
  const col = new Float32Array(nTotal * 3)
  const siz = new Float32Array(nTotal)
  const pha = new Float32Array(nTotal)
  const rng = makeRng(0x51a2b7)
  const c = new THREE.Color()

  for (let i = 0; i < N_STARS; i++) {
    // uniform on the sphere, then pushed above the horizon: the ground eats the rest
    const u = rng() * 2 - 1
    const y = Math.abs(u) * 0.94 + 0.02
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const a = rng() * Math.PI * 2
    pos[i * 3] = Math.cos(a) * r * STAR_RADIUS
    pos[i * 3 + 1] = y * STAR_RADIUS
    pos[i * 3 + 2] = Math.sin(a) * r * STAR_RADIUS

    c.setHex(STAR_TINTS[Math.floor(rng() * STAR_TINTS.length)] ?? 0xdfe9ff)
    // dim most of them so a handful of bright ones can carry the composition
    const mag = 0.30 + Math.pow(rng(), 3.2) * 0.62
    col[i * 3] = c.r * mag
    col[i * 3 + 1] = c.g * mag
    col[i * 3 + 2] = c.b * mag

    siz[i] = 1.0 + Math.pow(rng(), 3.5) * 3.4
    pha[i] = rng()
  }

  /* ---- the asterism ----
   * Laid out in its own tangent plane and pushed onto the star sphere. The
   * stars ride in the same buffer as every other star, so the figure costs one
   * extra draw call for its links and nothing at all for its points. */
  const aF = new THREE.Vector3(
    Math.cos(ASTERISM_AZ) * Math.cos(ASTERISM_EL),
    Math.sin(ASTERISM_EL),
    Math.sin(ASTERISM_AZ) * Math.cos(ASTERISM_EL),
  ).normalize()
  const aRight = new THREE.Vector3().crossVectors(aF, new THREE.Vector3(0, 1, 0)).normalize()
  const aUp = new THREE.Vector3().crossVectors(aRight, aF).normalize()
  const aDir = new THREE.Vector3()
  const DEG = (Math.PI / 180) * ASTERISM_SCALE

  const linkPos = new Float32Array(ASTERISM_LINKS.length * 6)
  const starAt = (k: number, out: THREE.Vector3): THREE.Vector3 => {
    const s = ASTERISM[k]
    return out
      .copy(aF)
      .addScaledVector(aRight, s[0] * DEG)
      .addScaledVector(aUp, s[1] * DEG)
      .normalize()
      .multiplyScalar(STAR_RADIUS)
  }

  for (let k = 0; k < ASTERISM.length; k++) {
    const i = N_STARS + k
    const mag = ASTERISM[k][2]
    starAt(k, aDir)
    pos[i * 3] = aDir.x
    pos[i * 3 + 1] = aDir.y
    pos[i * 3 + 2] = aDir.z
    // Cool white, a shade brighter than the field they sit in — but still under
    // the bloom threshold, because the sky is a backdrop and never a light.
    c.setHex(0xdce9ff)
    // Brighter than the field so the figure carries, still under the bloom
    // threshold so it stays a backdrop.
    const b = 0.45 + mag * 0.5
    col[i * 3] = c.r * b
    col[i * 3 + 1] = c.g * b
    col[i * 3 + 2] = c.b * b
    siz[i] = 2.0 + mag * 4.4
    pha[i] = (k * 0.37) % 1
  }
  for (let l = 0; l < ASTERISM_LINKS.length; l++) {
    starAt(ASTERISM_LINKS[l][0], aDir).toArray(linkPos, l * 6)
    starAt(ASTERISM_LINKS[l][1], aDir).toArray(linkPos, l * 6 + 3)
  }

  const linkGeo = new THREE.BufferGeometry()
  linkGeo.setAttribute('position', new THREE.BufferAttribute(linkPos, 3))
  linkGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), STAR_RADIUS * 1.02)
  const linkMat = new THREE.LineBasicMaterial({
    color: 0x9fb8e6,
    // Same queue trick as the stars: opaque queue, additive blend, no depth.
    transparent: false,
    blending: THREE.AdditiveBlending,
    opacity: SLONIK_LINK_OPACITY,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    fog: false,
  })
  const links = new THREE.LineSegments(linkGeo, linkMat)
  links.name = 'sky.slonik'
  links.frustumCulled = false
  links.renderOrder = -998
  links.raycast = () => {}

  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  starGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1))
  starGeo.setAttribute('aPhase', new THREE.BufferAttribute(pha, 1))
  starGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), STAR_RADIUS * 1.02)

  const starUniforms = {
    uTime: skyTime,
    uScale: { value: STAR_RADIUS },
  }
  const starMat = new THREE.ShaderMaterial({
    uniforms: starUniforms,
    vertexShader: starVert,
    fragmentShader: starFrag,
    // transparent:false keeps the stars in the *opaque* queue so they are drawn
    // before the city; three still honours a non-Normal blending mode there
    // (WebGLState.setMaterial), which is what makes additive stars possible
    // without them floating in front of the buildings.
    transparent: false,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })
  const stars = new THREE.Points(starGeo, starMat)
  stars.name = 'sky.stars'
  stars.frustumCulled = false
  stars.renderOrder = -999
  stars.raycast = () => {}
  // The renderer hides the starfield in daylight. Parenting the asterism here
  // gives its links the same night-only lifecycle without a second theme hook.
  stars.add(links)
  group.add(stars)

  /* ---- self-driving: pin to the camera, advance the twinkle clock ----
   * onBeforeRender runs before three computes modelViewMatrix (WebGLRenderer
   * .renderObject), so updating the transform here is safe for this same frame. */
  dome.onBeforeRender = (_r, _s, camera) => {
    group.position.copy(camera.position)
    group.updateMatrixWorld(true)
    skyTime.value = performance.now() * 0.001
  }

  group.userData.dispose = () => {
    domeGeo.dispose()
    domeMat.dispose()
    cloudGeo.dispose()
    cloudMat.dispose()
    starGeo.dispose()
    starMat.dispose()
    linkGeo.dispose()
    linkMat.dispose()
  }

  // The sky reads the palette but deliberately holds no *cached* theme material:
  // it must never be recoloured by a district that grabs the same key.
  void theme

  return group
}
