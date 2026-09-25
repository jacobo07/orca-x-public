import { describe, expect, it } from 'vitest'
import { createWebContentsTimedFlags } from './web-contents-timed-flags'

function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return { now: () => current, advance: (ms) => (current += ms) }
}

describe('createWebContentsTimedFlags', () => {
  it('keeps one window mark when another window is marked', () => {
    const flags = createWebContentsTimedFlags(10_000)
    flags.mark(1)
    flags.mark(2)

    expect(flags.matches(1)).toBe(true)
    expect(flags.matches(2)).toBe(true)
  })

  it('clears only the window it is asked to clear', () => {
    const flags = createWebContentsTimedFlags(10_000)
    flags.mark(1)
    flags.mark(2)

    flags.clear(2)

    expect(flags.matches(1)).toBe(true)
    expect(flags.matches(2)).toBe(false)
  })

  it('consumes only the matching window', () => {
    const flags = createWebContentsTimedFlags(10_000)
    flags.mark(1)
    flags.mark(2)

    expect(flags.matches(1, { consume: true })).toBe(true)

    expect(flags.matches(1)).toBe(false)
    expect(flags.matches(2)).toBe(true)
  })

  it('expires each mark on its own deadline', () => {
    const time = clock()
    const flags = createWebContentsTimedFlags(10_000, time.now)
    flags.mark(1, 1_000)
    flags.mark(2, 5_000)

    time.advance(2_000)

    expect(flags.matches(1)).toBe(false)
    expect(flags.matches(2)).toBe(true)
  })

  it('never matches a window that was not marked', () => {
    const flags = createWebContentsTimedFlags(10_000)
    flags.mark(1)

    expect(flags.matches(3)).toBe(false)
  })

  it('drops expired marks instead of keeping one per window forever', () => {
    const time = clock()
    const flags = createWebContentsTimedFlags(10_000, time.now)
    for (let id = 0; id < 50; id++) {
      flags.mark(id, 100)
    }
    time.advance(200)
    flags.mark(99)

    expect(flags.size()).toBe(1)
  })
})
