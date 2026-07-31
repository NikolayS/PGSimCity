/**
 * Keyboard instructions printed on the Machine. These functions are the
 * production routing boundary as well as the executable documentation seam.
 */
export function handleBoardInstruction(event, commands) {
  if (event.code === 'Space') {
    event.preventDefault()
    commands.togglePaused()
    return true
  }
  if (event.key === ',' || event.key === '<') {
    event.preventDefault()
    commands.nudgeRate(-1)
    return true
  }
  if (event.key === '.' || event.key === '>') {
    event.preventDefault()
    commands.nudgeRate(1)
    return true
  }
  if (event.key.toLowerCase() === 'r') {
    event.preventDefault()
    commands.reset()
    return true
  }
  return false
}

export function handleTerminalInstruction(event, commands) {
  if (event.key !== 'Enter' || event.shiftKey) return false
  event.preventDefault()
  commands.submit()
  return true
}
