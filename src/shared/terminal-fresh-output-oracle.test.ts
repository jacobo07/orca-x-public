import { describe, expect, it } from 'vitest'
import type { RuntimeTerminalRead } from './runtime-types'
// RED until Phase 2: no fresh-output oracle exists, so a phone send cannot be proven by output it caused.
import { judgeFreshTerminalOutput } from './terminal-fresh-output-oracle'

const HANDLE = 'term-live-1'
const MARKER = 'ORCA-PHONE-MARKER-7f3a'
const NONCE = 'nonce-9b41c2'

function read(tail: string[], overrides: Partial<RuntimeTerminalRead> = {}): RuntimeTerminalRead {
  return {
    handle: HANDLE,
    status: 'running',
    tail,
    truncated: false,
    nextCursor: null,
    latestCursor: String(tail.length),
    ...overrides
  }
}

describe('judgeFreshTerminalOutput', () => {
  it('passes when the nonce follows the marker in output read after the pre-send cursor', () => {
    const before = read(['$ ls', 'a.txt'], { latestCursor: '2' })
    const after = read([`$ echo ${MARKER} ${NONCE}`, `${MARKER} ${NONCE}`])
    expect(
      judgeFreshTerminalOutput({ handle: HANDLE, marker: MARKER, nonce: NONCE, before, after })
    ).toEqual({ verdict: 'FRESH' })
  })

  it('refuses history: a nonce already present before the send never satisfies the oracle', () => {
    const before = read([`${MARKER} ${NONCE}`], { latestCursor: '1' })
    const after = read([`${MARKER} ${NONCE}`])
    expect(
      judgeFreshTerminalOutput({ handle: HANDLE, marker: MARKER, nonce: NONCE, before, after })
        .verdict
    ).toBe('CONTAMINATED')
  })

  it('refuses a nonce that only appears before the marker (the echoed command line alone)', () => {
    const before = read([], { latestCursor: '0' })
    const after = read([`${NONCE} typed`, MARKER])
    expect(
      judgeFreshTerminalOutput({ handle: HANDLE, marker: MARKER, nonce: NONCE, before, after })
        .verdict
    ).toBe('ABSENT')
  })

  it('refuses output read from a different terminal handle', () => {
    const before = read([], { latestCursor: '0' })
    const after = read([MARKER, NONCE], { handle: 'term-other' })
    expect(
      judgeFreshTerminalOutput({ handle: HANDLE, marker: MARKER, nonce: NONCE, before, after })
        .verdict
    ).toBe('WRONG_TERMINAL')
  })

  it('answers UNKNOWN, never FRESH, when the post-send read is truncated or has no pre-send cursor', () => {
    const after = read([MARKER, NONCE], { truncated: true })
    expect(
      judgeFreshTerminalOutput({
        handle: HANDLE,
        marker: MARKER,
        nonce: NONCE,
        before: read([], { latestCursor: '0' }),
        after
      }).verdict
    ).toBe('UNKNOWN')
    expect(
      judgeFreshTerminalOutput({
        handle: HANDLE,
        marker: MARKER,
        nonce: NONCE,
        before: read([], { latestCursor: undefined }),
        after: read([MARKER, NONCE])
      }).verdict
    ).toBe('UNKNOWN')
  })
})
