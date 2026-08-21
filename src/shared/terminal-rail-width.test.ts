import { describe, expect, it } from 'vitest'
import {
  TERMINAL_RAIL_DEFAULT_WIDTH,
  TERMINAL_RAIL_MAX_WIDTH,
  TERMINAL_RAIL_MIN_WIDTH,
  clampTerminalRailWidth
} from './terminal-rail-width'

describe('clampTerminalRailWidth', () => {
  it('keeps a width the user could have dragged to', () => {
    expect(clampTerminalRailWidth(210)).toBe(210)
  })

  it('holds the rail inside its range at both ends', () => {
    expect(clampTerminalRailWidth(10)).toBe(TERMINAL_RAIL_MIN_WIDTH)
    expect(clampTerminalRailWidth(4000)).toBe(TERMINAL_RAIL_MAX_WIDTH)
  })

  it('falls back rather than propagating a value that is not a width', () => {
    // Persisted state can be stale, hand-edited, or written by a host on another version. NaN
    // reaching a style attribute collapses the rail to nothing, which reads as the feature
    // vanishing rather than as a bad number.
    expect(clampTerminalRailWidth(Number.NaN)).toBe(TERMINAL_RAIL_DEFAULT_WIDTH)
    expect(clampTerminalRailWidth(undefined)).toBe(TERMINAL_RAIL_DEFAULT_WIDTH)
    expect(clampTerminalRailWidth('220')).toBe(TERMINAL_RAIL_DEFAULT_WIDTH)
    expect(clampTerminalRailWidth(Number.POSITIVE_INFINITY)).toBe(TERMINAL_RAIL_DEFAULT_WIDTH)
  })

  it('honours a caller-supplied fallback so hydration can keep the current width', () => {
    expect(clampTerminalRailWidth(undefined, 240)).toBe(240)
  })

  it('rounds, so a drag cannot persist a subpixel width', () => {
    expect(clampTerminalRailWidth(200.6)).toBe(201)
  })
})
