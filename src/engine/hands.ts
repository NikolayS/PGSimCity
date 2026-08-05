import * as THREE from 'three'

import type { QualityLevel, ThemeApi } from '../core/types'
import { clamp, clamp01, damp, easeInOutCubic, reduceMotion } from '../core/util'
import type { WalkController } from './walk'

/* ============================================================================
 * FIRST-PERSON HANDS
 *
 * Hands are an interaction cue, not permanent first-person furniture. One hand
 * rises near an operable control, both answer a door or swimming stroke, and all
 * of them recede below the viewport when they have nothing to do. World targets
 * stay inside a deliberately narrow lower-corner lane.
 *
 * The frame path allocates nothing. Geometry, matrices, projections, motion
 * state, and every spring accumulator are built once and mutated in place.
 * ==========================================================================*/

export type HandAction = 'lever' | 'door'

export interface ReachProjection {
  x: number
  y: number
  visible: boolean
}

export interface HandScreenRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface HandScreenBounds {
  left: HandScreenRect
  right: HandScreenRect
}

export interface ViewmodelHandsOptions {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  theme: ThemeApi
  walk: WalkController
  quality: QualityLevel
  /** Test override; production reads prefers-reduced-motion once at creation. */
  reducedMotion?: boolean
}

export interface ViewmodelHandsApi {
  readonly group: THREE.Group
  readonly action: HandAction | null
  update(dt: number): void
  setQuality(level: QualityLevel): void
  setNearby(action: HandAction, x: number, y: number, z: number): void
  clearNearby(): void
  perform(action: HandAction, x: number, y: number, z: number): void
  dispose(): void
}

interface HandRig {
  root: THREE.Group
  detail: THREE.Group
  side: -1 | 1
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  rx: number
  ry: number
  rz: number
}

const FOV_HALF_TAN = Math.tan((52 * Math.PI) / 360)
/** Keep the viewmodel inside the walker's 0.35 m collision capsule. */
const VIEWMODEL_DEPTH_SCALE = 0.3
const IDLE_DEPTH = 0.92 * VIEWMODEL_DEPTH_SCALE
const REACH_DEPTH = 1.06 * VIEWMODEL_DEPTH_SCALE
const IDLE_X = 0.84
const IDLE_Y = -0.79
const REACH_X_MIN = 0.80
const REACH_X_MAX = 0.84
const REACH_Y_MIN = -0.52
const REACH_Y_MAX = -0.38
/** A nearby control raises the hand enough to clear the phone interaction prompt. */
const NEARBY_POISE = 0.68
/** Distance below the authored idle pose at which the silhouette is fully gone. */
const HIDDEN_DROP = 0.34
/** Model-space silhouette plus the largest inertial displacement. */
const OCCLUSION_HALF_X = 0.145
const OCCLUSION_HALF_Y = 0.165
const PORTRAIT_SCALE_ASPECT = 1.35

const POSITION_STIFFNESS = 82
const POSITION_DAMPING = 15
const ROTATION_RATE = 12
const LAG_STIFFNESS = 74
const LAG_DAMPING = 14
const TAU = Math.PI * 2

const _projectWorld = new THREE.Vector3()
const _projectView = new THREE.Vector3()
const _fingerMatrix = new THREE.Matrix4()
const _fingerPosition = new THREE.Vector3()
const _fingerRotation = new THREE.Quaternion()
const _fingerScale = new THREE.Vector3(1, 1, 1)
const _fingerAxis = new THREE.Vector3(0, 0, 1)

function viewportScale(aspect: number): number {
  return Math.min(0.82, Math.max(0.25, (aspect / PORTRAIT_SCALE_ASPECT) * 0.82))
    * VIEWMODEL_DEPTH_SCALE
}

function ndcRect(
  width: number,
  height: number,
  cx: number,
  cy: number,
  halfX: number,
  halfY: number,
): HandScreenRect {
  const left = clamp(((cx - halfX + 1) * width) / 2, 0, width)
  const right = clamp(((cx + halfX + 1) * width) / 2, 0, width)
  const top = clamp(((1 - (cy + halfY)) * height) / 2, 0, height)
  const bottom = clamp(((1 - (cy - halfY)) * height) / 2, 0, height)
  return { left, top, right, bottom }
}

/**
 * Conservative screen envelope for the palm, fingers, camera lag, and gait
 * weight. This is also the authored constraint used by the actual layout.
 */
export function handOcclusionBounds(
  width: number,
  height: number,
  reaching: boolean,
): HandScreenBounds {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  const aspect = w / h
  const scale = viewportScale(aspect)
  const depth = reaching ? REACH_DEPTH : IDLE_DEPTH
  const halfH = FOV_HALF_TAN * depth
  const halfW = halfH * aspect
  const hx = (OCCLUSION_HALF_X * scale) / halfW
  const hy = (OCCLUSION_HALF_Y * scale) / halfH
  const x = reaching ? REACH_X_MIN : IDLE_X
  const y = reaching ? REACH_Y_MAX : IDLE_Y
  return {
    left: ndcRect(w, h, -x, y, hx, hy),
    right: ndcRect(w, h, x, y, hx, hy),
  }
}

/** Mutates caller-owned output so the same helper is safe in interaction loops. */
export function projectReachTarget(
  camera: THREE.PerspectiveCamera,
  x: number,
  y: number,
  z: number,
  out: ReachProjection,
): ReachProjection {
  _projectWorld.set(x, y, z)
  _projectView.copy(_projectWorld).applyMatrix4(camera.matrixWorldInverse)
  out.visible = _projectView.z < -camera.near
  const side = _projectView.x < 0 ? -1 : 1
  if (out.visible) {
    _projectWorld.project(camera)
    const magnitude = clamp(Math.abs(_projectWorld.x), REACH_X_MIN, REACH_X_MAX)
    out.x = (_projectWorld.x < 0 ? -1 : 1) * magnitude
    out.y = clamp(_projectWorld.y, REACH_Y_MIN, REACH_Y_MAX)
  } else {
    out.x = side * REACH_X_MIN
    out.y = REACH_Y_MIN
  }
  return out
}

function setMeshRules(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.frustumCulled = false
    mesh.renderOrder = 900
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.raycast = () => {}
  })
}

function createHand(
  side: -1 | 1,
  theme: ThemeApi,
  glove: THREE.Material,
  sleeve: THREE.Material,
  cuff: THREE.Material,
): HandRig {
  const root = new THREE.Group()
  root.name = side < 0 ? 'viewmodel-hand:left' : 'viewmodel-hand:right'

  const forearm = new THREE.Mesh(theme.cyl(0.044, 0.066, 0.34, 7), sleeve)
  forearm.name = `${root.name}:forearm`
  forearm.position.set(side * 0.016, -0.19, 0.026)
  forearm.rotation.z = side * -0.11
  root.add(forearm)

  const cuffMesh = new THREE.Mesh(theme.cyl(0.062, 0.06, 0.048, 7), cuff)
  cuffMesh.name = `${root.name}:cuff`
  cuffMesh.position.set(0, -0.02, 0.006)
  root.add(cuffMesh)

  const palm = new THREE.Mesh(theme.cyl(0.063, 0.048, 0.112, 6), glove)
  palm.name = `${root.name}:palm`
  palm.position.set(0, 0.048, -0.004)
  palm.scale.z = 0.5
  root.add(palm)

  const thumb = new THREE.Mesh(theme.cyl(0.011, 0.017, 0.068, 5), glove)
  thumb.name = `${root.name}:thumb`
  thumb.position.set(-side * 0.061, 0.045, -0.002)
  thumb.rotation.z = side * 0.56
  thumb.scale.z = 0.72
  root.add(thumb)

  const detail = new THREE.Group()
  detail.name = side < 0 ? 'viewmodel-hands:detail' : 'viewmodel-hands:detail:right'
  const fingers = new THREE.InstancedMesh(theme.cyl(0.0075, 0.0105, 0.068, 5), glove, 4)
  fingers.name = `${root.name}:fingers`
  for (let i = 0; i < 4; i++) {
    const offset = i - 1.5
    const across = offset * 0.027
    const length = 1 - Math.abs(offset) * 0.065
    _fingerPosition.set(across, 0.108 - Math.abs(offset) * 0.003, -0.004)
    _fingerRotation.setFromAxisAngle(_fingerAxis, offset * -0.035)
    _fingerScale.set(1, length, 0.86)
    _fingerMatrix.compose(_fingerPosition, _fingerRotation, _fingerScale)
    fingers.setMatrixAt(i, _fingerMatrix)
  }
  fingers.instanceMatrix.needsUpdate = true
  detail.add(fingers)
  root.add(detail)
  setMeshRules(root)

  return {
    root,
    detail,
    side,
    x: 0,
    y: 0,
    z: -IDLE_DEPTH,
    vx: 0,
    vy: 0,
    vz: 0,
    rx: -0.08,
    ry: side * -0.08,
    rz: side * 0.08,
  }
}

function wrapAngle(angle: number): number {
  if (angle > Math.PI) return angle - TAU
  if (angle < -Math.PI) return angle + TAU
  return angle
}

function actionAmount(t: number, duration: number): number {
  const u = clamp01(t / duration)
  if (u < 0.34) return easeInOutCubic(u / 0.34)
  if (u < 0.58) return 1
  return easeInOutCubic(1 - (u - 0.58) / 0.42)
}

export function createViewmodelHands(opts: ViewmodelHandsOptions): ViewmodelHandsApi {
  const { scene, camera, theme, walk } = opts
  const noMotion = opts.reducedMotion ?? reduceMotion()
  const group = new THREE.Group()
  group.name = 'viewmodel-hands'
  group.visible = false

  const glove = theme.mat('viewmodel-hands.glove', {
    color: 0x354a5c,
    roughness: 0.9,
    metalness: 0.08,
    flatShading: true,
    surface: false,
  })
  const sleeve = theme.mat('viewmodel-hands.sleeve', {
    color: 0x111923,
    roughness: 0.86,
    metalness: 0.16,
    flatShading: true,
    surface: false,
  })
  const cuff = theme.mat('viewmodel-hands.cuff', {
    color: 0x4f7892,
    roughness: 0.62,
    metalness: 0.38,
    flatShading: true,
    surface: false,
  })

  const left = createHand(-1, theme, glove, sleeve, cuff)
  const right = createHand(1, theme, glove, sleeve, cuff)
  group.add(left.root, right.root)
  scene.add(group)

  let aspect = -1
  let scale = 1
  let idleHalfW = 1
  let idleHalfH = 1
  let reachHalfW = 1
  let reachHalfH = 1
  let action: HandAction | null = null
  let actionT = 0
  let actionDuration = 1
  let actionSide: -1 | 1 = 1
  let nearby: HandAction | null = null
  let nearbyX = 0
  let nearbyY = 0
  let nearbyZ = 0
  let nearbySide: -1 | 1 = 1
  let displayedSide: -1 | 0 | 1 = 1
  let presence = 0
  let qualityEnabled = true
  const reach: ReachProjection = { x: REACH_X_MIN, y: REACH_Y_MIN, visible: true }

  let breathT = 0
  let strokeT = 0
  let moveBlend = 0
  let runBlend = 0
  let swimBlend = 0
  let lastYaw = camera.rotation.y
  let lastPitch = camera.rotation.x
  let lagX = 0
  let lagY = 0
  let lagVX = 0
  let lagVY = 0
  let disposed = false

  function applyLayout(): void {
    aspect = Math.max(0.1, camera.aspect)
    scale = viewportScale(aspect)
    idleHalfH = FOV_HALF_TAN * IDLE_DEPTH
    idleHalfW = idleHalfH * aspect
    reachHalfH = FOV_HALF_TAN * REACH_DEPTH
    reachHalfW = reachHalfH * aspect
    left.root.scale.setScalar(scale)
    right.root.scale.setScalar(scale)
    if (left.x === 0 && right.x === 0) {
      left.x = -IDLE_X * idleHalfW
      right.x = IDLE_X * idleHalfW
      left.y = IDLE_Y * idleHalfH - HIDDEN_DROP * scale
      right.y = IDLE_Y * idleHalfH - HIDDEN_DROP * scale
      left.z = -IDLE_DEPTH
      right.z = -IDLE_DEPTH
      left.root.position.set(left.x, left.y, left.z)
      right.root.position.set(right.x, right.y, right.z)
    }
  }

  function setQuality(level: QualityLevel): void {
    qualityEnabled = level !== 'low' && level !== 'reduced'
    left.detail.visible = qualityEnabled
    right.detail.visible = qualityEnabled
    if (!qualityEnabled) {
      action = null
      presence = 0
      group.visible = false
    }
  }

  function setNearby(next: HandAction, x: number, y: number, z: number): void {
    if (disposed) return
    nearby = next
    nearbyX = x
    nearbyY = y
    nearbyZ = z
  }

  function clearNearby(): void {
    nearby = null
  }

  function perform(next: HandAction, x: number, y: number, z: number): void {
    if (!walk.enabled || disposed) return
    projectReachTarget(camera, x, y, z, reach)
    action = next
    actionT = 0
    actionDuration = next === 'door' ? 1.15 : 0.92
    actionSide = reach.x < 0 ? -1 : 1
  }

  function spring(hand: HandRig, tx: number, ty: number, tz: number, dt: number): void {
    hand.vx += (tx - hand.x) * POSITION_STIFFNESS * dt
    hand.vy += (ty - hand.y) * POSITION_STIFFNESS * dt
    hand.vz += (tz - hand.z) * POSITION_STIFFNESS * dt
    const drag = Math.exp(-POSITION_DAMPING * dt)
    hand.vx *= drag
    hand.vy *= drag
    hand.vz *= drag
    hand.x += hand.vx * dt
    hand.y += hand.vy * dt
    hand.z += hand.vz * dt
  }

  function updateHand(
    hand: HandRig,
    amount: number,
    stride: number,
    stroke: number,
    breath: number,
    dt: number,
  ): void {
    const side = hand.side
    let tx = side * IDLE_X * idleHalfW
    let ty = IDLE_Y * idleHalfH + breath * 0.006 * scale
    ty -= (1 - presence) * HIDDEN_DROP * scale
    let tz = -IDLE_DEPTH
    let trx = -0.08
    let try_ = side * -0.08
    let trz = side * 0.08

    const ground = moveBlend * (1 - swimBlend)
    if (ground > 0.001) {
      const weight = 0.55 + runBlend * 0.75
      const swing = stride * ground
      tx += side * Math.abs(swing) * 0.008 * scale
      ty -= Math.abs(Math.sin(stride * Math.PI)) * 0.012 * weight * scale
      tz += side * swing * 0.028 * weight * scale
      trx += side * swing * 0.18 * weight
      trz += side * swing * 0.08
    }

    if (swimBlend > 0.001) {
      const extension = (stroke + 1) * 0.5
      tx += side * (0.018 + (1 - extension) * 0.022) * swimBlend * scale
      ty += extension * 0.046 * swimBlend * scale
      tz -= extension * 0.095 * swimBlend * scale
      trx -= (0.18 + extension * 0.46) * swimBlend
      try_ += side * stroke * 0.2 * swimBlend
      trz += side * (0.1 - extension * 0.24) * swimBlend
    }

    let handAction = nearby !== null && action === null && side === nearbySide
      ? presence * NEARBY_POISE
      : 0
    if (action === 'door' || (action !== null && side === actionSide)) handAction = amount
    if (handAction > 0) {
      const targetX = action === 'door' ? side * REACH_X_MIN : reach.x
      tx += (targetX * reachHalfW - tx) * handAction
      ty += (reach.y * reachHalfH - ty) * handAction
      tz += (-REACH_DEPTH - tz) * handAction
      trx += (-0.62 - trx) * handAction
      try_ += ((action === 'door' ? side * -0.12 : side * 0.24) - try_) * handAction
      trz += ((action === 'lever' ? side * -0.38 : side * -0.08) - trz) * handAction
    }

    tx += lagX * scale
    ty += lagY * scale
    spring(hand, tx, ty, tz, dt)
    hand.rx = damp(hand.rx, trx, ROTATION_RATE, dt)
    hand.ry = damp(hand.ry, try_, ROTATION_RATE, dt)
    hand.rz = damp(hand.rz, trz, ROTATION_RATE, dt)
    hand.root.position.set(hand.x, hand.y, hand.z)
    hand.root.rotation.set(hand.rx, hand.ry, hand.rz, 'XYZ')
  }

  function update(dt: number): void {
    if (disposed) return
    if (camera.aspect !== aspect) applyLayout()
    group.position.copy(camera.position)
    group.quaternion.copy(camera.quaternion)
    if (!walk.enabled || !qualityEnabled) {
      group.visible = false
      if (!walk.enabled) {
        action = null
        nearby = null
        presence = 0
      }
      lastYaw = camera.rotation.y
      lastPitch = camera.rotation.x
      return
    }

    const d = clamp(dt, 0, 0.1)
    if (d === 0) return
    breathT += d * 0.92

    const swimming = walk.gait === 'swim' || walk.submerged
    if (nearby !== null) {
      projectReachTarget(camera, nearbyX, nearbyY, nearbyZ, reach)
      nearbySide = reach.x < 0 ? -1 : 1
    }
    moveBlend = damp(moveBlend, clamp01(walk.speed / 2.4), swimming ? 3.5 : 8, d)
    runBlend = damp(runBlend, walk.gait === 'run' ? 1 : 0, 6, d)
    swimBlend = damp(swimBlend, swimming ? 1 : 0, 4.2, d)
    strokeT += d * (swimming ? 1.7 + walk.speed * 0.9 : 0.35)
    if (strokeT > TAU) strokeT -= TAU

    const yawDelta = wrapAngle(camera.rotation.y - lastYaw)
    const pitchDelta = wrapAngle(camera.rotation.x - lastPitch)
    lastYaw = camera.rotation.y
    lastPitch = camera.rotation.x
    if (!noMotion) {
      lagX = clamp(lagX - yawDelta * 0.32, -0.045, 0.045)
      lagY = clamp(lagY + pitchDelta * 0.24, -0.035, 0.035)
    }
    lagVX += (-lagX * LAG_STIFFNESS - lagVX * LAG_DAMPING) * d
    lagVY += (-lagY * LAG_STIFFNESS - lagVY * LAG_DAMPING) * d
    lagX += lagVX * d
    lagY += lagVY * d

    let amount = 0
    if (action !== null) {
      actionT += d
      amount = actionAmount(actionT, actionDuration)
      if (actionT >= actionDuration) {
        action = null
        amount = 0
      }
    }

    const hasIntent = swimming || action !== null || nearby !== null
    if (swimming || action === 'door') displayedSide = 0
    else if (action !== null) displayedSide = actionSide
    else if (nearby !== null) displayedSide = nearbySide
    presence = damp(presence, hasIntent ? 1 : 0, hasIntent ? 8 : 6, d)
    group.visible = hasIntent || presence > 0.008
    left.root.visible = displayedSide <= 0
    right.root.visible = displayedSide >= 0

    const phase = walk.distance * (TAU / 1.55)
    const stride = noMotion ? 0 : Math.sin(phase)
    const breath = noMotion ? 0 : Math.sin(breathT)
    const leftStroke = noMotion ? 0 : Math.sin(strokeT)
    const rightStroke = noMotion ? 0 : -leftStroke
    updateHand(left, amount, stride, leftStroke, breath, d)
    updateHand(right, amount, -stride, rightStroke, breath, d)
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    group.removeFromParent()
    group.clear()
  }

  applyLayout()
  setQuality(opts.quality)

  return {
    group,
    get action(): HandAction | null {
      return action
    },
    update,
    setQuality,
    setNearby,
    clearNearby,
    perform,
    dispose,
  }
}
