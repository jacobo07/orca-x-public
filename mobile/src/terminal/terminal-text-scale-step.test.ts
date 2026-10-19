import { describe, expect, it } from 'vitest'
import { TERMINAL_TEXT_SCALES } from '../storage/preferences'
import { nextTerminalTextScale, TERMINAL_TEXT_SCALE_RESET } from './terminal-text-scale-step'

describe('nextTerminalTextScale', () => {
  it('steps to the next preset', () => {
    expect(nextTerminalTextScale(1)).toBe(1.25)
    expect(nextTerminalTextScale(0.5)).toBe(0.75)
  })

  it('wraps from the largest preset to the smallest', () => {
    expect(nextTerminalTextScale(TERMINAL_TEXT_SCALES.at(-1)!)).toBe(TERMINAL_TEXT_SCALES[0])
  })

  it('treats an off-preset value as the reset size, so the next tap is predictable', () => {
    expect(nextTerminalTextScale(1.1)).toBe(1.25)
  })

  it('resets to 1x', () => {
    expect(TERMINAL_TEXT_SCALE_RESET).toBe(1)
  })
})
