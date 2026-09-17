import { beforeEach, describe, expect, it } from 'vitest'
import {
  TERMINAL_OUTPUT_LIVENESS_WINDOW_MS,
  TERMINAL_OUTPUT_RECENCY_WRITE_INTERVAL_MS,
  paneOutputHoldsAgentStateOpen,
  resetTerminalOutputRecencyGateForTests,
  shouldWriteTerminalOutputStamp
} from './terminal-output-recency'

const PANE = 'tab-1:leaf-a'
const OTHER_PANE = 'tab-2:leaf-b'

beforeEach(() => {
  resetTerminalOutputRecencyGateForTests()
})

describe('shouldWriteTerminalOutputStamp', () => {
  it('writes the first chunk a pane ever produces', () => {
    expect(shouldWriteTerminalOutputStamp(PANE, 1_000)).toBe(true)
  })

  it('collapses a burst into one write per interval', () => {
    expect(shouldWriteTerminalOutputStamp(PANE, 1_000)).toBe(true)
    let writes = 0
    // A streaming pane emits far more chunks than this in one interval.
    for (let at = 1_001; at < 1_000 + TERMINAL_OUTPUT_RECENCY_WRITE_INTERVAL_MS; at += 10) {
      if (shouldWriteTerminalOutputStamp(PANE, at)) {
        writes++
      }
    }
    expect(writes).toBe(0)
    expect(shouldWriteTerminalOutputStamp(PANE, 1_000 + TERMINAL_OUTPUT_RECENCY_WRITE_INTERVAL_MS))
      .toBe(true)
  })

  it('gates each pane independently', () => {
    expect(shouldWriteTerminalOutputStamp(PANE, 1_000)).toBe(true)
    expect(shouldWriteTerminalOutputStamp(OTHER_PANE, 1_000)).toBe(true)
  })

  it('refuses an empty key or a non-finite timestamp', () => {
    expect(shouldWriteTerminalOutputStamp('', 1_000)).toBe(false)
    expect(shouldWriteTerminalOutputStamp(PANE, Number.NaN)).toBe(false)
    expect(shouldWriteTerminalOutputStamp(PANE, Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('paneOutputHoldsAgentStateOpen', () => {
  const now = 1_000_000

  // Absent is unknown, never fresh — the property that keeps a pane with no output history
  // on the pre-existing behaviour instead of silently becoming live.
  it('is false when nothing was ever observed', () => {
    expect(paneOutputHoldsAgentStateOpen({ lastOutputAt: undefined, now })).toBe(false)
  })

  it('holds the state open inside the window', () => {
    expect(paneOutputHoldsAgentStateOpen({ lastOutputAt: now - 1_000, now })).toBe(true)
    expect(
      paneOutputHoldsAgentStateOpen({
        lastOutputAt: now - TERMINAL_OUTPUT_LIVENESS_WINDOW_MS,
        now
      })
    ).toBe(true)
  })

  it('releases it one millisecond past the window', () => {
    expect(
      paneOutputHoldsAgentStateOpen({
        lastOutputAt: now - TERMINAL_OUTPUT_LIVENESS_WINDOW_MS - 1,
        now
      })
    ).toBe(false)
  })

  // A clock that moved backwards must not read as fresher than now.
  it('refuses a stamp from the future', () => {
    expect(paneOutputHoldsAgentStateOpen({ lastOutputAt: now + 1, now })).toBe(false)
  })

  it('refuses a non-finite stamp', () => {
    expect(paneOutputHoldsAgentStateOpen({ lastOutputAt: Number.NaN, now })).toBe(false)
  })
})
