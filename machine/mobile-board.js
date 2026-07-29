export const DETAIL_WIDTH = 720
export const DETAIL_HEIGHT = 900
export const MIN_DETAIL_LABEL_PX = 9.25
export const RECEIPT_FOCUS = Object.freeze({ x: 114, y: 823 })

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value))
}

export function detailFontSize(sourceSize, scale, fit) {
  if (fit) return sourceSize
  return Math.max(sourceSize, MIN_DETAIL_LABEL_PX / Math.max(scale, 0.001))
}

export function effectiveLabelPixels(sourceSize, scale, fit) {
  return detailFontSize(sourceSize, scale, fit) * scale
}

export function needsCompletionFollow(status) {
  return status === 'complete' || status === 'error'
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
  let left = viewport.scrollLeft
  let top = viewport.scrollTop

  if (x < left + horizontalInset) left = x - horizontalInset
  if (x > left + viewport.clientWidth - horizontalInset) {
    left = x - viewport.clientWidth + horizontalInset
  }
  if (y < top + topInset) top = y - topInset
  if (y > top + viewport.clientHeight - bottomInset) {
    top = y - viewport.clientHeight + bottomInset
  }

  output.left = clamp(
    left,
    0,
    Math.max(0, viewport.scrollWidth - viewport.clientWidth),
  )
  output.top = clamp(
    top,
    0,
    Math.max(0, viewport.scrollHeight - viewport.clientHeight),
  )
  return output
}
