export const DETAIL_WIDTH = 720
export const DETAIL_HEIGHT = 900
export const MIN_DETAIL_LABEL_PX = 9.25
export const BOARD_MAX_SCALE = MIN_DETAIL_LABEL_PX / 4
export const RECEIPT_FOCUS = Object.freeze({ x: 114, y: 823 })

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value))
}

export function fitBoardScale(viewportWidth, viewportHeight) {
  return clamp(
    Math.min(viewportWidth / DETAIL_WIDTH, viewportHeight / DETAIL_HEIGHT),
    0.001,
    1,
  )
}

function overviewSourceFloor(scale, fitScale) {
  if (scale >= 1) return 4
  const progress = clamp((scale - fitScale) / Math.max(0.001, 1 - fitScale), 0, 1)
  return 9 - progress * 5
}

export function detailFontSize(sourceSize, scale, fitScale) {
  if (sourceSize < overviewSourceFloor(scale, fitScale)) return 0
  return Math.max(sourceSize, MIN_DETAIL_LABEL_PX / Math.max(scale, 0.001))
}

export function effectiveLabelPixels(sourceSize, scale, fitScale) {
  return detailFontSize(sourceSize, scale, fitScale) * scale
}

export function needsCompletionFollow(status) {
  return status === 'complete' || status === 'error'
}

/**
 * Clamp a proposed board origin without exposing space beyond a zoomed axis.
 * The board stays centred on any axis that is smaller than the viewport.
 */
export function clampBoardView(viewport, proposedX, proposedY, output) {
  const boardWidth = DETAIL_WIDTH * viewport.scale
  const boardHeight = DETAIL_HEIGHT * viewport.scale
  output.scale = viewport.scale
  output.viewX = boardWidth <= viewport.clientWidth
    ? (viewport.clientWidth - boardWidth) / 2
    : clamp(proposedX, viewport.clientWidth - boardWidth, 0)
  output.viewY = boardHeight <= viewport.clientHeight
    ? (viewport.clientHeight - boardHeight) / 2
    : clamp(proposedY, viewport.clientHeight - boardHeight, 0)
  return output
}

/**
 * Scale around a board point while allowing a moving pinch midpoint.
 * Both input and output objects are caller-owned and reused.
 */
export function zoomBoardView(
  viewport,
  requestedScale,
  fromX,
  fromY,
  toX,
  toY,
  fitScale,
  output,
) {
  const nextScale = clamp(requestedScale, fitScale, BOARD_MAX_SCALE)
  const boardX = (fromX - viewport.viewX) / viewport.scale
  const boardY = (fromY - viewport.viewY) / viewport.scale
  const boardWidth = DETAIL_WIDTH * nextScale
  const boardHeight = DETAIL_HEIGHT * nextScale
  const proposedX = toX - boardX * nextScale
  const proposedY = toY - boardY * nextScale

  output.scale = nextScale
  output.viewX = boardWidth <= viewport.clientWidth
    ? (viewport.clientWidth - boardWidth) / 2
    : clamp(proposedX, viewport.clientWidth - boardWidth, 0)
  output.viewY = boardHeight <= viewport.clientHeight
    ? (viewport.clientHeight - boardHeight) / 2
    : clamp(proposedY, viewport.clientHeight - boardHeight, 0)
  return output
}

/**
 * Keep the moving statement marker inside a stable reading frame.
 * The caller owns and reuses `output`, so following the route allocates nothing.
 */
export function containBoardPoint(viewport, boardX, boardY, output) {
  const x = viewport.viewX + boardX * viewport.scale
  const y = viewport.viewY + boardY * viewport.scale
  const horizontalInset = Math.min(96, viewport.clientWidth * 0.24)
  const topInset = Math.min(72, viewport.clientHeight * 0.18)
  const bottomInset = Math.min(88, viewport.clientHeight * 0.22)
  let nextX = viewport.viewX
  let nextY = viewport.viewY

  if (x < horizontalInset) nextX += horizontalInset - x
  if (x > viewport.clientWidth - horizontalInset) {
    nextX -= x - viewport.clientWidth + horizontalInset
  }
  if (y < topInset) nextY += topInset - y
  if (y > viewport.clientHeight - bottomInset) {
    nextY -= y - viewport.clientHeight + bottomInset
  }

  return clampBoardView(viewport, nextX, nextY, output)
}
