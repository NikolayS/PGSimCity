import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import {
  handleBoardInstruction,
  handleTerminalInstruction,
} from './instructions.js'

function keyEvent(key, code = key, shiftKey = false) {
  return { key, code, shiftKey, preventDefault: vi.fn() }
}

describe('Machine printed keyboard instructions', () => {
  const footer = readFileSync(new URL('./index.html', import.meta.url), 'utf8')

  it('drives every board key named in the footer through the production router', () => {
    expect(footer).toContain('SPACE ON THE BOARD PAUSES')
    expect(footer).toContain(', / . CHANGES VIEW SPEED')

    const commands = {
      togglePaused: vi.fn(),
      nudgeRate: vi.fn(),
      reset: vi.fn(),
    }
    const space = keyEvent(' ', 'Space')
    const slower = keyEvent(',', 'Comma')
    const faster = keyEvent('.', 'Period')

    expect(handleBoardInstruction(space, commands)).toBe(true)
    expect(commands.togglePaused).toHaveBeenCalledOnce()
    expect(space.preventDefault).toHaveBeenCalledOnce()
    expect(handleBoardInstruction(slower, commands)).toBe(true)
    expect(commands.nudgeRate).toHaveBeenLastCalledWith(-1)
    expect(handleBoardInstruction(faster, commands)).toBe(true)
    expect(commands.nudgeRate).toHaveBeenLastCalledWith(1)
  })

  it('submits Enter and leaves documented Shift+Enter to the textarea', () => {
    expect(footer).toContain('ENTER RUNS')
    expect(footer).toContain('SHIFT+ENTER ADDS A LINE')

    const commands = { submit: vi.fn() }
    const enter = keyEvent('Enter', 'Enter')
    const shifted = keyEvent('Enter', 'Enter', true)

    expect(handleTerminalInstruction(enter, commands)).toBe(true)
    expect(enter.preventDefault).toHaveBeenCalledOnce()
    expect(commands.submit).toHaveBeenCalledOnce()
    expect(handleTerminalInstruction(shifted, commands)).toBe(false)
    expect(shifted.preventDefault).not.toHaveBeenCalled()
    expect(commands.submit).toHaveBeenCalledOnce()
  })
})
