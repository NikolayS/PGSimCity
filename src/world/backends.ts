import * as THREE from 'three'
import { COLOR } from '../core/theme'
import { N_BACKEND_SLOTS } from '../core/types'
import type { BackendState, SimState, WorldFactory, WorldModule } from '../core/types'
import { clamp, clamp01, damp, fmtBytes, fmtDuration, makeRng } from '../core/util'
import { CITY, backendX, rid } from './layout'

/* ============================================================================
 * BACKENDS — sixteen towers, one per connection.
 *
 * A backend is a whole OS process. It parses, plans and executes your query,
 * reads pages through shared buffers, writes WAL, and waits — and *the state
 * machine is the lighting*:
 *
 *   free         dark                     idle          dim blue
 *   starting     a wipe up the shaft      idle_in_xact  amber, slow pulse
 *   parse/plan   crown flickers indigo    exec_cpu      cyan, bands scrolling
 *   exec_io      cyan but frozen + red    sort          violet spill at the base
 *   wal_insert   amber packet leaves      commit_wait   dimmed, slow amber ring
 *   blocked      red + chain to holder    sending       green out of the roof
 *
 * idle_in_xact is deliberately the one that looks faintly wrong: a session
 * holding an open transaction while doing nothing pins the xmin horizon and
 * quietly stops vacuum from cleaning anything newer.
 * ==========================================================================*/

const N = N_BACKEND_SLOTS
const BZ = CITY.backend.z
const BW = CITY.backend.w

const PLINTH_H = 2.2
const COLLAR_H = 0.7
const CROWN_H = 2.2

/* --- module-scope scratch: update() must never allocate ------------------- */
const _p = new THREE.Vector3()
const _sc = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _m = new THREE.Matrix4()
const _c = new THREE.Color()
const _cT = new THREE.Color()

/** Matte base colour of an unlit shaft. State colour is washed into it. */
const SHAFT_BASE = 0x18222f

/** cx, cy, cz, w, h, d */
type BoxSpec = [number, number, number, number, number, number]

function pushBoxEdges(out: number[], s: BoxSpec): void {
  const [cx, cy, cz, w, h, d] = s
  const x0 = cx - w / 2,
    x1 = cx + w / 2
  const y0 = cy - h / 2,
    y1 = cy + h / 2
  const z0 = cz - d / 2,
    z1 = cz + d / 2
  const v: [number, number, number][] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
  ]
  const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7]
  for (let i = 0; i < e.length; i++) {
    const p = v[e[i]]
    out.push(p[0], p[1], p[2])
  }
}

function setBox(mesh: THREE.InstancedMesh, idx: number, s: BoxSpec): void {
  _p.set(s[0], s[1], s[2])
  _sc.set(s[3], s[4], s[5])
  _q.identity()
  _m.compose(_p, _q, _sc)
  mesh.setMatrixAt(idx, _m)
}

/** Damp a packed RGB triple toward `hex * mul`, in linear space. */
function dampRgb(arr: Float32Array, i: number, hex: number, mul: number, rate: number, dt: number): void {
  _c.setHex(hex).multiplyScalar(mul)
  const o = i * 3
  arr[o] = damp(arr[o], _c.r, rate, dt)
  arr[o + 1] = damp(arr[o + 1], _c.g, rate, dt)
  arr[o + 2] = damp(arr[o + 2], _c.b, rate, dt)
}

const BAND_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aBright;
attribute float aScroll;
attribute float aWipe;
attribute float aHeight;
varying vec3 vPos;
varying vec3 vCol;
varying float vBright;
varying float vScroll;
varying float vWipe;
varying float vHeight;
void main() {
  vPos = position;
  vCol = aColor;
  vBright = aBright;
  vScroll = aScroll;
  vWipe = aWipe;
  vHeight = aHeight;
  vec4 mv = vec4( position, 1.0 );
  #ifdef USE_INSTANCING
    mv = instanceMatrix * mv;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * mv;
}`

const BAND_FRAG = /* glsl */ `
varying vec3 vPos;
varying vec3 vCol;
varying float vBright;
varying float vScroll;
varying float vWipe;
varying float vHeight;
void main() {
  // metres up the shaft, so the floor pitch is constant across tower heights
  float y = ( vPos.y + 0.5 ) * vHeight;
  // whichever horizontal axis varies on this face gives us window columns
  float hx = abs( vPos.x ) > abs( vPos.z ) ? vPos.z : vPos.x;
  float col = fract( hx * 5.0 + 0.5 );
  float colMask = smoothstep( 0.16, 0.24, col ) * ( 1.0 - smoothstep( 0.60, 0.68, col ) );
  float row = fract( ( y - vScroll ) / 1.74 );   // 1.74 m floor pitch
  float rowMask = smoothstep( 0.06, 0.14, row ) * ( 1.0 - smoothstep( 0.44, 0.54, row ) );
  float win = colMask * rowMask * vBright;
  // 'starting': a bright wipe running up the shaft as the process comes alive
  float wipe = 0.0;
  if ( vWipe >= 0.0 ) {
    float d = y / max( vHeight, 0.001 ) - vWipe;
    wipe = exp( - d * d * 300.0 );
  }
  float a = win + wipe;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( vCol * win + vec3( 0.70, 0.88, 1.0 ) * wipe * 1.7, 1.0 );
  #include <colorspace_fragment>
}`

const PLATE_VERT = /* glsl */ `
attribute float aRow;
uniform float uRows;
varying vec2 vCell;
void main() {
  vCell = vec2( uv.x, ( uv.y + aRow ) / uRows );
  vec4 mv = vec4( position, 1.0 );
  #ifdef USE_INSTANCING
    mv = instanceMatrix * mv;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * mv;
}`

const PLATE_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vCell;
void main() {
  // the atlas is an sRGB canvas: decode, work linear, encode on the way out
  vec4 tx = sRGBTransferEOTF( texture2D( uMap, vCell ) );
  if ( tx.a < 0.02 ) discard;
  gl_FragColor = vec4( uColor * tx.rgb, tx.a * uOpacity );
  #include <colorspace_fragment>
}`

export const createBackends: WorldFactory = (ctx): WorldModule => {
  const { theme } = ctx
  const group = new THREE.Group()
  group.name = 'district:backends'

  const owned: { dispose(): void }[] = []
  function own<T extends { dispose(): void }>(x: T): T {
    owned.push(x)
    return x
  }

  /* --- materials -------------------------------------------------------- */
  const matStruct = theme.mat('backends.struct', {
    color: 0x2a3852,
    roughness: 0.76,
    metalness: 0.24,
    emissive: 0x0c1524,
  })
  const matTrim = theme.mat('backends.trim', {
    color: 0x18223a,
    roughness: 0.9,
    metalness: 0.1,
    emissive: 0x080e1a,
  })
  // shaft albedo comes entirely from instanceColor, so the base colour is white
  const matShaft = theme.mat('backends.shaft', {
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0.26,
    emissive: 0x0e1728,
  })
  const neonWhite = theme.neon(0xffffff, 1)
  const lineInk = theme.line(COLOR.inkDim, 0.2)

  const unitBox = theme.box(1, 1, 1)
  const unitCyl = theme.cyl(0.5, 0.5, 1, 10)
  const edgeVerts: number[] = []

  /* --- per-slot geometry ------------------------------------------------ */
  const rng = makeRng(0xb17e5)
  const H = new Float32Array(N) // total tower height
  const SH = new Float32Array(N) // shaft height
  const SY = new Float32Array(N) // shaft centre y
  const XS = new Float32Array(N)

  for (let i = 0; i < N; i++) {
    XS[i] = backendX(i)
    // a skyline, not a comb: heights vary but stay inside the contract range
    const h = CITY.backend.minH + rng() * (CITY.backend.maxH - CITY.backend.minH)
    H[i] = h
    SH[i] = Math.max(5, h - PLINTH_H - COLLAR_H - CROWN_H)
    SY[i] = PLINTH_H + SH[i] / 2
  }

  /* --- structure (matte, never glows) ----------------------------------- */
  const structMesh = new THREE.InstancedMesh(unitBox, matStruct, N * 2)
  structMesh.frustumCulled = false
  const trimMesh = new THREE.InstancedMesh(unitBox, matTrim, N * 3)
  trimMesh.frustumCulled = false
  const ventMesh = new THREE.InstancedMesh(unitCyl, matTrim, N * 2)
  ventMesh.frustumCulled = false

  for (let i = 0; i < N; i++) {
    const x = XS[i]
    const top = PLINTH_H + SH[i]
    const plinth: BoxSpec = [x, PLINTH_H / 2, BZ, BW + 3.2, PLINTH_H, BW + 3.2]
    const collar: BoxSpec = [x, top + COLLAR_H / 2, BZ, BW + 1.3, COLLAR_H, BW + 1.3]
    setBox(structMesh, i * 2, plinth)
    setBox(structMesh, i * 2 + 1, collar)
    pushBoxEdges(edgeVerts, plinth)
    pushBoxEdges(edgeVerts, [x, SY[i], BZ, BW, SH[i], BW])
    pushBoxEdges(edgeVerts, collar)

    // service walkway, base skirt, roof rail — the details you see up close
    setBox(trimMesh, i * 3, [x, PLINTH_H + SH[i] * 0.62, BZ, BW + 2.4, 0.32, BW + 2.4])
    setBox(trimMesh, i * 3 + 1, [x, PLINTH_H + 0.9, BZ, BW + 0.7, 1.8, BW + 0.7])
    setBox(trimMesh, i * 3 + 2, [x, top + COLLAR_H + CROWN_H + 0.12, BZ, BW * 0.9, 0.24, BW * 0.9])

    // roof mast (the beacon rides it) + an extract vent
    _p.set(x + 2.7, top + COLLAR_H + CROWN_H + 2.1, BZ - 2.4)
    _sc.set(0.34, 4.2, 0.34)
    _q.identity()
    _m.compose(_p, _q, _sc)
    ventMesh.setMatrixAt(i * 2, _m)
    _p.set(x - 2.9, top + COLLAR_H + CROWN_H + 0.8, BZ + 2.2)
    _sc.set(1.7, 1.6, 1.7)
    _m.compose(_p, _q, _sc)
    ventMesh.setMatrixAt(i * 2 + 1, _m)
  }
  structMesh.instanceMatrix.needsUpdate = true
  trimMesh.instanceMatrix.needsUpdate = true
  ventMesh.instanceMatrix.needsUpdate = true
  group.add(structMesh, trimMesh, ventMesh)

  /* --- shafts (one instanced mesh, per-instance colour) ------------------ */
  const shaftMesh = new THREE.InstancedMesh(unitBox, matShaft, N)
  shaftMesh.frustumCulled = false
  for (let i = 0; i < N; i++) setBox(shaftMesh, i, [XS[i], SY[i], BZ, BW, SH[i], BW])
  shaftMesh.instanceMatrix.needsUpdate = true
  _c.setHex(0x161f2e)
  for (let i = 0; i < N; i++) shaftMesh.setColorAt(i, _c)
  shaftMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  group.add(shaftMesh)

  /* --- window bands (one shader-driven instanced skin) ------------------- */
  const bandGeo = own(new THREE.BoxGeometry(1, 1, 1))
  const aColor = new Float32Array(N * 3)
  const aBright = new Float32Array(N)
  const aScroll = new Float32Array(N)
  const aWipe = new Float32Array(N)
  const aHeight = new Float32Array(N)
  aWipe.fill(-1)
  for (let i = 0; i < N; i++) aHeight[i] = SH[i] - 1.6
  const attrColor = new THREE.InstancedBufferAttribute(aColor, 3)
  const attrBright = new THREE.InstancedBufferAttribute(aBright, 1)
  const attrScroll = new THREE.InstancedBufferAttribute(aScroll, 1)
  const attrWipe = new THREE.InstancedBufferAttribute(aWipe, 1)
  const attrHeight = new THREE.InstancedBufferAttribute(aHeight, 1)
  attrColor.setUsage(THREE.DynamicDrawUsage)
  attrBright.setUsage(THREE.DynamicDrawUsage)
  attrScroll.setUsage(THREE.DynamicDrawUsage)
  attrWipe.setUsage(THREE.DynamicDrawUsage)
  bandGeo.setAttribute('aColor', attrColor)
  bandGeo.setAttribute('aBright', attrBright)
  bandGeo.setAttribute('aScroll', attrScroll)
  bandGeo.setAttribute('aWipe', attrWipe)
  bandGeo.setAttribute('aHeight', attrHeight)

  const bandMat = own(
    new THREE.ShaderMaterial({
      vertexShader: BAND_VERT,
      fragmentShader: BAND_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  const bandMesh = new THREE.InstancedMesh(bandGeo, bandMat, N)
  bandMesh.frustumCulled = false
  bandMesh.raycast = () => {}
  for (let i = 0; i < N; i++) {
    setBox(bandMesh, i, [XS[i], SY[i], BZ, BW * 1.012, SH[i] - 1.6, BW * 1.012])
  }
  bandMesh.instanceMatrix.needsUpdate = true
  group.add(bandMesh)

  /* --- crowns ------------------------------------------------------------ */
  const crownMesh = new THREE.InstancedMesh(unitBox, neonWhite, N)
  crownMesh.frustumCulled = false
  for (let i = 0; i < N; i++) {
    const top = PLINTH_H + SH[i] + COLLAR_H
    setBox(crownMesh, i, [XS[i], top + CROWN_H / 2, BZ, BW * 0.8, CROWN_H, BW * 0.8])
  }
  crownMesh.instanceMatrix.needsUpdate = true
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N; i++) crownMesh.setColorAt(i, _c)
  crownMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  group.add(crownMesh)

  /* --- commit_wait rings ------------------------------------------------- */
  const ringGeo = own(new THREE.TorusGeometry(1, 0.045, 6, 26))
  const ringMesh = new THREE.InstancedMesh(ringGeo, neonWhite, N)
  ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  ringMesh.frustumCulled = false
  ringMesh.raycast = () => {}
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N; i++) ringMesh.setColorAt(i, _c)
  ringMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  group.add(ringMesh)

  /* --- 'waiting on I/O' beacons ------------------------------------------ */
  const beaconGeo = own(new THREE.SphereGeometry(0.62, 8, 6))
  const beaconMesh = new THREE.InstancedMesh(beaconGeo, neonWhite, N)
  beaconMesh.frustumCulled = false
  beaconMesh.raycast = () => {}
  for (let i = 0; i < N; i++) {
    const top = PLINTH_H + SH[i] + COLLAR_H + CROWN_H
    _p.set(XS[i] + 2.7, top + 4.0, BZ - 2.4)
    _sc.set(1, 1, 1)
    _q.identity()
    _m.compose(_p, _q, _sc)
    beaconMesh.setMatrixAt(i, _m)
  }
  beaconMesh.instanceMatrix.needsUpdate = true
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N; i++) beaconMesh.setColorAt(i, _c)
  beaconMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  group.add(beaconMesh)

  /* --- work_mem spill puddles ------------------------------------------- */
  const puddleGeo = own(new THREE.CircleGeometry(1, 24))
  const puddleMat = own(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  )
  const puddleMesh = new THREE.InstancedMesh(puddleGeo, puddleMat, N)
  puddleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  puddleMesh.frustumCulled = false
  puddleMesh.raycast = () => {}
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N; i++) puddleMesh.setColorAt(i, _c)
  puddleMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  group.add(puddleMesh)

  /* --- pid plates (one texture atlas, one draw call) --------------------- */
  const PID = new Int32Array(N)
  for (let i = 0; i < N; i++) PID[i] = 21519 + i * 7
  const plateTex = own(buildPlateAtlas(PID))
  const plateGeo = own(new THREE.PlaneGeometry(6.6, 0.82))
  const aRow = new Float32Array(N)
  for (let i = 0; i < N; i++) aRow[i] = i
  plateGeo.setAttribute('aRow', new THREE.InstancedBufferAttribute(aRow, 1))
  const plateMat = own(
    new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: plateTex },
        uRows: { value: N },
        uColor: { value: new THREE.Color(COLOR.ink) },
        uOpacity: { value: 0.85 },
      },
      vertexShader: PLATE_VERT,
      fragmentShader: PLATE_FRAG,
      transparent: true,
      depthWrite: false,
    }),
  )
  const plateMesh = new THREE.InstancedMesh(plateGeo, plateMat, N)
  plateMesh.frustumCulled = false
  plateMesh.raycast = () => {}
  for (let i = 0; i < N; i++) {
    _p.set(XS[i], PLINTH_H + 2.6, BZ + BW / 2 + 0.09)
    _q.identity()
    _sc.set(1, 1, 1)
    _m.compose(_p, _q, _sc)
    plateMesh.setMatrixAt(i, _m)
  }
  plateMesh.instanceMatrix.needsUpdate = true
  group.add(plateMesh)

  /* --- lock chains ------------------------------------------------------- */
  const chainPos = new Float32Array(N * 6)
  const chainCol = new Float32Array(N * 6)
  const chainGeo = own(new THREE.BufferGeometry())
  chainGeo.setAttribute('position', new THREE.BufferAttribute(chainPos, 3))
  chainGeo.setAttribute('color', new THREE.BufferAttribute(chainCol, 3))
  const chainMat = own(
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  )
  const chains = new THREE.LineSegments(chainGeo, chainMat)
  chains.frustumCulled = false
  chains.raycast = () => {}
  group.add(chains)

  /* --- pick proxies: invisible, but the thing the cursor actually hits ---- */
  const pickMat = own(
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
  )
  const towerObjects: THREE.Mesh[] = []
  for (let i = 0; i < N; i++) {
    const geo = own(new THREE.BoxGeometry(BW + 3.6, H[i] + 1.4, BW + 3.6))
    const mesh = new THREE.Mesh(geo, pickMat)
    mesh.position.set(XS[i], (H[i] + 1.4) / 2, BZ)
    mesh.renderOrder = -1
    towerObjects.push(mesh)
    group.add(mesh)
  }

  /* =======================================================================
   * LOCAL MEMORY — private to one backend, unlike everything on the plaza.
   * =====================================================================*/

  const LM_X = -140
  const LM_Y = 21
  const LM_Z = -132

  const lm = new THREE.Group()
  lm.name = 'backend.localmem'

  const glassMat = theme.mat('backends.localmem', {
    color: 0x3d6bb0,
    roughness: 0.3,
    metalness: 0.05,
    transparent: true,
    opacity: 0.11,
    side: THREE.DoubleSide,
  })
  const shell = new THREE.Mesh(theme.box(30, 15, 22), glassMat)
  shell.position.set(LM_X, LM_Y, LM_Z)
  lm.add(shell)
  pushBoxEdges(edgeVerts, [LM_X, LM_Y, LM_Z, 30, 15, 22])

  // the three local arenas, sized by nothing in particular — the point is that
  // there is one of these per backend, not one for the cluster
  const arenaMat = theme.neon(0xffffff, 1, { transparent: true, opacity: 0.3 })
  const arenas = new THREE.InstancedMesh(unitBox, arenaMat, 3)
  const workBox: BoxSpec = [LM_X - 8.5, LM_Y - 2.6, LM_Z, 11, 5.4, 8]
  setBox(arenas, 0, workBox)
  setBox(arenas, 1, [LM_X + 4.5, LM_Y - 0.6, LM_Z - 0.5, 8, 9, 7])
  setBox(arenas, 2, [LM_X - 8.5, LM_Y + 3.6, LM_Z + 1, 6, 3.4, 6])
  arenas.instanceMatrix.needsUpdate = true
  _c.setHex(COLOR.vacuum).multiplyScalar(0.5)
  arenas.setColorAt(0, _c)
  _c.setHex(COLOR.bgwriter).multiplyScalar(0.32)
  arenas.setColorAt(1, _c)
  _c.setHex(COLOR.bufClean).multiplyScalar(0.32)
  arenas.setColorAt(2, _c)
  arenas.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  lm.add(arenas)

  // work_mem fill level: rises with the number of sorting backends
  const fillMat = theme.neon(COLOR.vacuum, 1.5, { transparent: true, opacity: 0.75 })
  const fill = new THREE.Mesh(theme.box(10.4, 1, 7.4), fillMat)
  const FILL_BASE = workBox[1] - workBox[4] / 2
  fill.position.set(workBox[0], FILL_BASE, workBox[2])
  fill.scale.y = 0.001
  lm.add(fill)

  // overflow: when work_mem is exceeded the sort spills to a temp file on disk
  const spillMat = theme.neon(COLOR.vacuum, 1.2, { transparent: true, opacity: 0.4 })
  const spill = new THREE.Mesh(theme.box(2.6, 1, 2.6), spillMat)
  spill.position.set(workBox[0], FILL_BASE, workBox[2])
  spill.visible = false
  lm.add(spill)

  const tempBlock = new THREE.Mesh(theme.box(17, 2.4, 12), matStruct)
  tempBlock.position.set(LM_X - 8.5, 1.2, LM_Z)
  lm.add(tempBlock)
  pushBoxEdges(edgeVerts, [LM_X - 8.5, 1.2, LM_Z, 17, 2.4, 12])
  const tempGlowMat = theme.neon(COLOR.vacuum, 1.3, { transparent: true, opacity: 0.6 })
  const tempGlow = new THREE.Mesh(theme.box(15, 0.24, 10), tempGlowMat)
  tempGlow.position.set(LM_X - 8.5, 2.5, LM_Z)
  tempGlow.scale.set(0.001, 1, 0.001)
  lm.add(tempGlow)

  const lmPanel = makePanel()
  lmPanel.position.set(LM_X, LM_Y - 1, LM_Z + 11.2)
  lm.add(lmPanel)

  const lmCaption = makeTextPlate('shared memory is one — local memory is per backend', 1.7)
  lmCaption.position.set(LM_X, 6.4, LM_Z + 11.4)
  lm.add(lmCaption)

  group.add(lm)

  /* --- one blueprint line pass for the whole district -------------------- */
  const edgeGeo = own(new THREE.BufferGeometry())
  edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgeVerts, 3))
  const edgeLines = new THREE.LineSegments(edgeGeo, lineInk)
  edgeLines.raycast = () => {}
  edgeLines.renderOrder = 2
  group.add(edgeLines)

  /* --- helpers ----------------------------------------------------------- */
  function makeTextPlate(text: string, height: number): THREE.Mesh {
    const tex = theme.textTexture(text, { size: 48, color: '#a9bedd', letterSpacing: '1px' })
    const img = tex.image as { width: number; height: number }
    const geo = own(new THREE.PlaneGeometry((height * img.width) / Math.max(1, img.height), height))
    const mat = own(
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }),
    )
    const mesh = new THREE.Mesh(geo, mat)
    mesh.raycast = () => {}
    return mesh
  }

  /** Engineering placard for the local-memory volume — one texture, one draw. */
  function makePanel(): THREE.Mesh {
    const cv = document.createElement('canvas')
    cv.width = 512
    cv.height = 256
    const g = cv.getContext('2d')!
    g.clearRect(0, 0, 512, 256)
    g.font = '600 30px ui-monospace, SFMono-Regular, Menlo, monospace'
    g.fillStyle = '#dbe7ff'
    g.fillText('LOCAL MEMORY', 26, 46)
    g.font = '500 26px ui-monospace, SFMono-Regular, Menlo, monospace'
    const rows: [string, string][] = [
      ['work_mem', '#b57bff'],
      ['maintenance_work_mem', '#4fe3c1'],
      ['temp_buffers', '#3fa7ff'],
    ]
    for (let i = 0; i < rows.length; i++) {
      const y = 104 + i * 40
      g.fillStyle = rows[i][1]
      g.fillRect(26, y - 16, 14, 14)
      g.fillStyle = '#c3d3ee'
      g.fillText(rows[i][0], 52, y)
    }
    g.font = '400 22px ui-monospace, SFMono-Regular, Menlo, monospace'
    g.fillStyle = '#8fa5c4'
    g.fillText('one arena per backend', 26, 232)
    const tex = own(new THREE.CanvasTexture(cv))
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    const geo = own(new THREE.PlaneGeometry(15, 7.5))
    const mat = own(
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }),
    )
    const mesh = new THREE.Mesh(geo, mat)
    mesh.raycast = () => {}
    return mesh
  }

  /* =======================================================================
   * Registration.
   * =====================================================================*/

  ctx.register({
    id: 'backend.row',
    name: 'Backends',
    role: 'one process per connection',
    kind: 'process',
    district: 'backends',
    object: group,
    tier: 0,
    focus: { target: [0, 16, BZ], distance: 250, dir: [0.05, 0.5, 1] },
    labelAt: [0, 34, BZ],
    color: COLOR.backend,
    readout: (s) => `${s.stats.activeBackends} of ${N} slots busy · ${Math.round(s.stats.tps)} tps`,
  })

  for (let i = 0; i < N; i++) {
    const slot = i
    ctx.register({
      id: `backend.${slot}`,
      name: `backend ${slot}`,
      role: `pid ${PID[slot]} — a whole OS process, private memory and all`,
      kind: 'process',
      district: 'backends',
      object: towerObjects[slot],
      tier: 2,
      focus: { target: [XS[slot], H[slot] * 0.55, BZ], distance: 44, dir: [0.4, 0.34, 1] },
      labelAt: [XS[slot], H[slot] + 5.5, BZ],
      color: COLOR.backend,
      readout: (s) => {
        const b = s.backends[slot]
        if (!b || !b.active) return `pid ${PID[slot]} · free slot`
        return `pid ${PID[slot]} · ${b.state} · ${fmtDuration(b.stateT)} · ${short(b.sql)}`
      },
    })
  }

  ctx.register({
    id: 'backend.localmem',
    name: 'Local memory',
    role: 'work_mem / maintenance_work_mem / temp_buffers — per backend',
    kind: 'memory',
    district: 'backends',
    object: lm,
    tier: 1,
    focus: { target: [LM_X, 14, LM_Z], distance: 62, dir: [0.2, 0.32, 1] },
    labelAt: [LM_X, LM_Y + 11, LM_Z],
    color: COLOR.vacuum,
    readout: () => `${sorting} sorting · temp files ${fmtBytes(tempBytes)}`,
  })

  /* =======================================================================
   * Runtime state.
   * =====================================================================*/

  const prevState: BackendState[] = new Array(N).fill('free')
  const bufTimer = new Float32Array(N)
  const crownRgb = new Float32Array(N * 3)
  const shaftRgb = new Float32Array(N * 3)
  const puddle = new Float32Array(N)
  const ringPhase = new Float32Array(N)
  const ringLevel = new Float32Array(N)
  const chainLevel = new Float32Array(N)
  let sorting = 0
  let tempBytes = 0
  let prevT = -1
  const bufInterval = ctx.quality.level === 'low' ? 1.1 : 0.55

  function short(sql: string): string {
    return sql.length > 30 ? sql.slice(0, 29) + '…' : sql
  }

  /* =======================================================================
   * Update.
   * =====================================================================*/

  function update(dt: number, sim: SimState, t: number): void {
    if (prevT < 0) prevT = t
    const dts = clamp(t - prevT, 0, 0.25) // simulated seconds: freezes on pause
    prevT = t

    const nb = Math.min(N, sim.backends.length)
    let sortCount = 0

    for (let i = 0; i < N; i++) {
      const b = i < nb ? sim.backends[i] : null
      const st: BackendState = b ? b.state : 'free'

      /* -- state → light ------------------------------------------------- */
      let bandHex = COLOR.bufClean
      let bandBr = 0
      let scroll = 0
      let crownHex = COLOR.bufClean
      let crownBr = 0
      let tintHex = COLOR.backend
      let tintMix = 0
      let tintDim = 1
      let wipe = -1
      let beacon = 0
      let ring = 0
      let pud = 0

      switch (st) {
        case 'free':
          tintDim = 0.8
          break
        case 'starting': {
          // the fork is visible as a wipe running up the shaft
          const k = b ? clamp01(b.stateDur > 0 ? b.stateT / b.stateDur : b.progress) : 0
          wipe = k
          bandHex = COLOR.client
          bandBr = 0.35
          crownHex = COLOR.client
          crownBr = 0.5 + 0.5 * k
          tintHex = COLOR.client
          tintMix = 0.22
          break
        }
        case 'idle':
          bandHex = COLOR.bufClean
          bandBr = 0.16
          crownHex = COLOR.bufClean
          crownBr = 0.12
          tintHex = COLOR.bufClean
          tintMix = 0.1
          break
        case 'idle_in_xact': {
          // an open transaction doing nothing: pins xmin, blocks cleanup
          const pulse = 0.5 + 0.5 * Math.sin(t * 2.2 + i)
          bandHex = COLOR.wal
          bandBr = 0.1 + pulse * 0.22
          crownHex = COLOR.wal
          crownBr = 0.1 + pulse * 0.3
          tintHex = COLOR.wal
          tintMix = 0.13
          break
        }
        case 'parse':
        case 'plan': {
          // crown flickers while the planner argues with itself
          const f = Math.sin(t * 41 + i * 3.7) * Math.sin(t * 27.3 + i)
          bandHex = COLOR.shmem
          bandBr = 0.28
          crownHex = f > 0 ? 0xffffff : COLOR.shmem
          crownBr = 0.55 + Math.abs(f) * 0.9
          tintHex = COLOR.shmem
          tintMix = 0.16
          break
        }
        case 'exec_cpu':
          bandHex = COLOR.backend
          bandBr = 1.0
          scroll = 26
          crownHex = COLOR.backend
          crownBr = 1.1
          tintHex = COLOR.backend
          tintMix = 0.2
          break
        case 'exec_io':
          // same colour, but nothing moves: the process is asleep on a read
          bandHex = COLOR.backend
          bandBr = 0.5
          scroll = 0
          crownHex = COLOR.backend
          crownBr = 0.35
          tintHex = COLOR.backend
          tintMix = 0.14
          beacon = Math.sin(t * 13.5 + i) > 0 ? 1.9 : 0.12
          break
        case 'sort':
          bandHex = COLOR.vacuum
          bandBr = 0.7
          scroll = 9
          crownHex = COLOR.vacuum
          crownBr = 0.7
          tintHex = COLOR.vacuum
          tintMix = 0.2
          pud = b ? 0.35 + clamp01(b.progress) * 0.65 : 0.5
          sortCount++
          break
        case 'wal_insert':
          bandHex = COLOR.wal
          bandBr = 0.95
          scroll = 34
          crownHex = COLOR.wal
          crownBr = 1.2
          tintHex = COLOR.wal
          tintMix = 0.2
          break
        case 'commit_wait':
          // waiting on fsync: the whole tower dims and holds
          bandHex = COLOR.wal
          bandBr = 0.1
          scroll = 0
          crownHex = COLOR.wal
          crownBr = 0.22
          tintHex = COLOR.wal
          tintMix = 0.1
          tintDim = 0.72
          ring = 1
          break
        case 'blocked': {
          const pulse = 0.55 + 0.45 * Math.sin(t * 4.4 + i)
          bandHex = COLOR.lock
          bandBr = 0.35 + pulse * 0.4
          crownHex = COLOR.lock
          crownBr = 0.6 + pulse * 0.8
          tintHex = COLOR.lock
          tintMix = 0.26
          break
        }
        case 'sending':
          bandHex = COLOR.ok
          bandBr = 0.85
          scroll = 42
          crownHex = COLOR.ok
          crownBr = 1.0
          tintHex = COLOR.ok
          tintMix = 0.18
          break
        case 'ending':
          bandHex = COLOR.client
          bandBr = 0.1
          crownHex = COLOR.client
          crownBr = 0.1
          tintHex = COLOR.client
          tintMix = 0.05
          tintDim = 0.85
          break
      }

      /* -- write the visual state ---------------------------------------- */
      // wrap on the floor pitch so the bands never jump when the counter resets
      aScroll[i] = (aScroll[i] + scroll * dts) % 1.74
      aBright[i] = damp(aBright[i], bandBr, 11, dt)
      aWipe[i] = wipe
      dampRgb(aColor, i, bandHex, 1, 9, dt)

      // the parse/plan flicker must survive the smoothing, so it damps faster
      dampRgb(crownRgb, i, crownHex, crownBr, st === 'parse' || st === 'plan' ? 55 : 10, dt)
      _c.setRGB(crownRgb[i * 3], crownRgb[i * 3 + 1], crownRgb[i * 3 + 2])
      crownMesh.setColorAt(i, _c)

      // shaft stays matte: only a faint wash of the state colour, never a glow
      _c.setHex(SHAFT_BASE)
      if (tintMix > 0) {
        _cT.setHex(tintHex)
        _c.lerp(_cT, tintMix)
      }
      if (tintDim !== 1) _c.multiplyScalar(tintDim)
      shaftRgb[i * 3] = damp(shaftRgb[i * 3], _c.r, 7, dt)
      shaftRgb[i * 3 + 1] = damp(shaftRgb[i * 3 + 1], _c.g, 7, dt)
      shaftRgb[i * 3 + 2] = damp(shaftRgb[i * 3 + 2], _c.b, 7, dt)
      _c.setRGB(shaftRgb[i * 3], shaftRgb[i * 3 + 1], shaftRgb[i * 3 + 2])
      shaftMesh.setColorAt(i, _c)

      // I/O beacon
      _c.setHex(COLOR.crit).multiplyScalar(beacon)
      beaconMesh.setColorAt(i, _c)

      // commit_wait ring, climbing slowly while the fsync is outstanding
      ringLevel[i] = damp(ringLevel[i], ring, 6, dt)
      if (ring > 0) ringPhase[i] = (ringPhase[i] + dt * 0.42) % 1
      const rl = ringLevel[i]
      if (rl > 0.01) {
        const y = 2.2 + ringPhase[i] * (H[i] - 3.5)
        const rad = BW / 2 + 1.7
        _p.set(XS[i], y, BZ)
        _e.set(-Math.PI / 2, 0, 0)
        _q.setFromEuler(_e)
        _sc.set(rad, rad, rad)
        _m.compose(_p, _q, _sc)
        ringMesh.setMatrixAt(i, _m)
        _c.setHex(COLOR.wal).multiplyScalar(rl * 1.8 * Math.sin(ringPhase[i] * Math.PI))
      } else {
        _p.set(XS[i], -1000, BZ)
        _q.identity()
        _sc.set(0.001, 0.001, 0.001)
        _m.compose(_p, _q, _sc)
        ringMesh.setMatrixAt(i, _m)
        _c.setRGB(0, 0, 0)
      }
      ringMesh.setColorAt(i, _c)

      // work_mem spill: a puddle of temp file at the tower's feet
      puddle[i] = damp(puddle[i], pud, pud > puddle[i] ? 1.6 : 0.5, dt)
      const pr = puddle[i]
      if (pr > 0.01) {
        const r = 3.4 + pr * 6.2
        _p.set(XS[i], 0.06, BZ + 3)
        _e.set(-Math.PI / 2, 0, 0)
        _q.setFromEuler(_e)
        _sc.set(r, r, r)
        _m.compose(_p, _q, _sc)
        puddleMesh.setMatrixAt(i, _m)
        _c.setHex(COLOR.vacuum).multiplyScalar(0.25 + pr * 0.7)
      } else {
        _p.set(XS[i], -1000, BZ)
        _q.identity()
        _sc.set(0.001, 0.001, 0.001)
        _m.compose(_p, _q, _sc)
        puddleMesh.setMatrixAt(i, _m)
        _c.setRGB(0, 0, 0)
      }
      puddleMesh.setColorAt(i, _c)

      /* -- chains: who is waiting on whom -------------------------------- */
      const o = i * 6
      const blocked = st === 'blocked' && b !== null && b.waitOn >= 0 && b.waitOn < N
      chainLevel[i] = damp(chainLevel[i], blocked ? 1 : 0, 8, dt)
      if (chainLevel[i] > 0.01 && b) {
        const j = blocked ? b.waitOn : i
        const y0 = H[i] * 0.62
        const y1 = H[j] * 0.62
        chainPos[o] = XS[i]
        chainPos[o + 1] = y0
        chainPos[o + 2] = BZ + 1
        chainPos[o + 3] = XS[j]
        chainPos[o + 4] = y1
        chainPos[o + 5] = BZ + 1
        _c.setHex(COLOR.lock).multiplyScalar(chainLevel[i] * (0.7 + 0.5 * Math.sin(t * 6 + i)))
        chainCol[o] = _c.r
        chainCol[o + 1] = _c.g
        chainCol[o + 2] = _c.b
        _c.multiplyScalar(0.3)
        chainCol[o + 3] = _c.r
        chainCol[o + 4] = _c.g
        chainCol[o + 5] = _c.b
      } else {
        chainPos[o] = chainPos[o + 3] = XS[i]
        chainPos[o + 1] = chainPos[o + 4] = -1000
        chainPos[o + 2] = chainPos[o + 5] = BZ
        chainCol[o] = chainCol[o + 1] = chainCol[o + 2] = 0
        chainCol[o + 3] = chainCol[o + 4] = chainCol[o + 5] = 0
      }

      /* -- flows: only on transitions, never every frame ------------------ */
      if (b && st !== prevState[i]) {
        switch (st) {
          case 'parse':
            ctx.flow({ route: rid.query(i), count: 1, kind: 'query', color: COLOR.client })
            break
          case 'sending':
            ctx.flow({
              route: rid.result(i),
              count: clamp(1 + Math.round(b.rowsSent / 60), 1, 4),
              kind: 'result',
              color: COLOR.ok,
              stagger: 0.2,
            })
            break
          case 'wal_insert':
            ctx.flow({
              route: rid.walIns(i),
              count: clamp(1 + Math.round(b.walBytes / 4096), 1, 3),
              kind: 'wal',
              color: COLOR.wal,
              stagger: 0.08,
            })
            break
          case 'blocked':
            ctx.flow({ route: rid.lockWait(i), count: 1, kind: 'stat', color: COLOR.lock })
            break
          case 'exec_io':
            ctx.flow({ route: rid.bufReq(i), count: 1, kind: 'page_read' })
            break
          default:
            break
        }
        // the page the backend was sleeping on has arrived
        if (prevState[i] === 'exec_io') {
          ctx.flow({ route: rid.bufRet(i), count: 1, kind: 'page_read', color: COLOR.bufClean })
        }
      }
      prevState[i] = st

      // steady buffer traffic while the backend is actually doing work
      if (b && (st === 'exec_cpu' || st === 'exec_io' || st === 'sort')) {
        bufTimer[i] -= dts
        if (bufTimer[i] <= 0) {
          bufTimer[i] = bufInterval * (0.75 + ((i * 37) % 11) / 22)
          ctx.flow({ route: rid.bufReq(i), count: 1, kind: 'page_read', size: 0.9 })
          ctx.flow({ route: rid.bufRet(i), count: 1, kind: 'page_read', color: COLOR.bufClean, size: 0.9 })
        }
      } else if (b && st === 'sending') {
        // rows keep streaming back to the client for as long as the state lasts
        bufTimer[i] -= dts
        if (bufTimer[i] <= 0) {
          bufTimer[i] = bufInterval * 0.7
          ctx.flow({ route: rid.result(i), count: 1, kind: 'result', color: COLOR.ok })
        }
      } else {
        bufTimer[i] = 0.12
      }
    }

    attrBright.needsUpdate = true
    attrScroll.needsUpdate = true
    attrWipe.needsUpdate = true
    attrColor.needsUpdate = true
    crownMesh.instanceColor!.needsUpdate = true
    shaftMesh.instanceColor!.needsUpdate = true
    beaconMesh.instanceColor!.needsUpdate = true
    ringMesh.instanceMatrix.needsUpdate = true
    ringMesh.instanceColor!.needsUpdate = true
    puddleMesh.instanceMatrix.needsUpdate = true
    puddleMesh.instanceColor!.needsUpdate = true
    chainGeo.attributes.position.needsUpdate = true
    chainGeo.attributes.color.needsUpdate = true

    /* --- local memory ----------------------------------------------------- */
    sorting = sortCount
    const want = clamp01(sortCount / 3)
    const level = damp(fill.scale.y, Math.max(0.001, want * 5.4), 3, dt)
    fill.scale.y = level
    fill.position.y = FILL_BASE + level / 2

    const overflowing = sortCount > 0
    // temp files accumulate while sorts spill, then age out
    tempBytes = overflowing
      ? tempBytes + dts * sortCount * 5.2e6
      : Math.max(0, tempBytes - dts * 9e6)

    spill.visible = overflowing
    if (overflowing) {
      const len = FILL_BASE - 2.5
      spill.scale.set(1, len, 1)
      spill.position.set(workBox[0], 2.5 + len / 2, workBox[2])
    }
    const ts = clamp01(tempBytes / 4e8)
    const tScale = Math.max(0.001, ts)
    tempGlow.scale.set(tScale, 1, tScale)

    _c.setHex(COLOR.vacuum).multiplyScalar(0.35 + want * 0.9)
    arenas.setColorAt(0, _c)
    arenas.instanceColor!.needsUpdate = true
  }

  function setDetail(level: 0 | 1 | 2): void {
    trimMesh.visible = level >= 1
    ventMesh.visible = level >= 1
    edgeLines.visible = level >= 1
    plateMesh.visible = level >= 2
    lmPanel.visible = level >= 1
    lmCaption.visible = level >= 2
    arenas.visible = level >= 1
  }

  function dispose(): void {
    for (const o of owned) o.dispose()
    owned.length = 0
    structMesh.dispose()
    trimMesh.dispose()
    ventMesh.dispose()
    shaftMesh.dispose()
    bandMesh.dispose()
    crownMesh.dispose()
    ringMesh.dispose()
    beaconMesh.dispose()
    puddleMesh.dispose()
    plateMesh.dispose()
    arenas.dispose()
  }

  return { id: 'backends', group, update, setDetail, dispose }
}

/* --------------------------------------------------------------------------
 * One texture holding all sixteen door plates; the instanced plate shader
 * picks its row with aRow. Row 0 must be at the *bottom* because CanvasTexture
 * flips Y.
 * ------------------------------------------------------------------------*/
function buildPlateAtlas(pids: Int32Array): THREE.CanvasTexture {
  const cellH = 32
  const cv = document.createElement('canvas')
  cv.width = 256
  cv.height = cellH * N
  const g = cv.getContext('2d')!
  g.clearRect(0, 0, cv.width, cv.height)
  g.font = '600 17px ui-monospace, SFMono-Regular, Menlo, monospace'
  g.textBaseline = 'middle'
  for (let i = 0; i < N; i++) {
    const y = (N - 1 - i) * cellH + cellH / 2
    g.fillStyle = '#8fa5c4'
    g.fillText(`b${i.toString().padStart(2, '0')}`, 8, y)
    g.fillStyle = '#dbe7ff'
    g.fillText(`pid ${pids[i]}`, 74, y)
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}
