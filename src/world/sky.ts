import * as THREE from 'three'
import { COLOR, mixHex } from '../core/theme'
import { makeRng } from '../core/util'
import type { ThemeApi } from '../core/types'

/* ============================================================================
 * SKY — the night PGSimCity runs under.
 *
 * Everything is procedural: a gradient dome plus one Points cloud. The dome is
 * pinned to the camera every frame (one vector copy) so the stars behave as if
 * they were at infinity and the sphere can never leave the far plane.
 *
 * Both shaders end with three's own tonemapping + colorspace chunks so they sit
 * in exactly the same colour pipeline as the PBR city; nothing here is allowed
 * to exceed the bloom threshold — the sky is a backdrop, not a light.
 * ==========================================================================*/

const SKY_RADIUS = 1800
const STAR_RADIUS = 1720
const N_STARS = 1400

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
const ASTERISM_EL = 0.50 // ~29°
/** Degrees of sky per unit of the figure below. */
const ASTERISM_SCALE = 1.42

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
varying vec3 vDir;

void main() {
  vec3 d = normalize( vDir );
  float h = d.y;

  // vertical gradient: near-black overhead, deep navy at the horizon
  vec3 col = mix( uHorizon, uZenith, smoothstep( -0.04, 0.62, h ) );

  // the horizon band itself
  float band = exp( - abs( h ) * 8.5 );
  col += uHorizon * band * 0.30;

  // ...biased east, toward the WAL district: the city's one warm light source
  float east = clamp( d.x, 0.0, 1.0 );
  col += uGlow * band * pow( east, 2.4 );

  // below the horizon there is nothing but the ground plane
  col *= mix( 0.18, 1.0, smoothstep( -0.30, -0.01, h ) );

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

/** Cool white, a few amber, a few pale blue — no green, nothing saturated. */
const STAR_TINTS: readonly number[] = [
  0xdfe9ff, 0xdfe9ff, 0xdfe9ff, 0xdfe9ff, 0xc9d8ff, 0xffffff, 0xffd9a8, 0xa9c8ff,
]

/**
 * Build the sky dome + starfield. Add the returned object straight to the scene;
 * it owns its own per-frame work (one uniform write and one vector copy) and
 * never needs to be ticked from outside.
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
    const b = 0.34 + mag * 0.5
    col[i * 3] = c.r * b
    col[i * 3 + 1] = c.g * b
    col[i * 3 + 2] = c.b * b
    siz[i] = 1.5 + mag * 3.6
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
    opacity: 0.085,
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
  group.add(links)

  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  starGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1))
  starGeo.setAttribute('aPhase', new THREE.BufferAttribute(pha, 1))
  starGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), STAR_RADIUS * 1.02)

  const starUniforms = {
    uTime: { value: 0 },
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
  group.add(stars)

  /* ---- self-driving: pin to the camera, advance the twinkle clock ----
   * onBeforeRender runs before three computes modelViewMatrix (WebGLRenderer
   * .renderObject), so updating the transform here is safe for this same frame. */
  dome.onBeforeRender = (_r, _s, camera) => {
    group.position.copy(camera.position)
    group.updateMatrixWorld(true)
    starUniforms.uTime.value = performance.now() * 0.001
  }

  group.userData.dispose = () => {
    domeGeo.dispose()
    domeMat.dispose()
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
