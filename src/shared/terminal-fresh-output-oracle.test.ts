import { describe, expect, it } from 'vitest'
import type { RuntimeTerminalRead } from './runtime-types'
import { judgeFreshTerminalOutput } from './terminal-fresh-output-oracle'

const HANDLE = 'term-live-1'
const MARKER = 'ORCA-PHONE-MARKER-7f3a'
const NONCE = 'nonce-9b41c2'
// Quoting splits the expected line in the input, so only execution prints it joined.
const SENT = `echo ${MARKER}' '${NONCE}`

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

function judge(before: RuntimeTerminalRead, after: RuntimeTerminalRead, sentText = SENT) {
  return judgeFreshTerminalOutput({
    handle: HANDLE,
    marker: MARKER,
    nonce: NONCE,
    sentText,
    before,
    after
  })
}

describe('judgeFreshTerminalOutput', () => {
  it('passes when execution prints the marker-nonce line after the pre-send cursor', () => {
    const before = read(['$ ls', 'a.txt'], { latestCursor: '2' })
    const after = read([`$ ${SENT}`, `${MARKER} ${NONCE}`])
    expect(judge(before, after)).toEqual({ verdict: 'FRESH' })
  })

  it('refuses history: a nonce already present before the send never satisfies the oracle', () => {
    const before = read([`${MARKER} ${NONCE}`], { latestCursor: '1' })
    const after = read([`${MARKER} ${NONCE}`])
    expect(judge(before, after).verdict).toBe('CONTAMINATED')
  })

  it('refuses the echoed command line alone (input is not output)', () => {
    const before = read([], { latestCursor: '0' })
    const after = read([`$ ${SENT}`])
    expect(judge(before, after).verdict).toBe('ABSENT')
  })

  it('refuses a nonce that only appears before the marker', () => {
    const before = read([], { latestCursor: '0' })
    const after = read([`${NONCE} typed`, MARKER])
    expect(judge(before, after).verdict).toBe('ABSENT')
  })

  it('answers UNKNOWN when the sent text already contains the expected line verbatim', () => {
    const before = read([], { latestCursor: '0' })
    const after = read([`${MARKER} ${NONCE}`])
    expect(judge(before, after, `echo ${MARKER} ${NONCE}`).verdict).toBe('UNKNOWN')
  })

  it('refuses output read from a different terminal handle', () => {
    const before = read([], { latestCursor: '0' })
    const after = read([`${MARKER} ${NONCE}`], { handle: 'term-other' })
    expect(judge(before, after).verdict).toBe('WRONG_TERMINAL')
  })

  it('answers UNKNOWN, never FRESH, when the post-send read is truncated or has no pre-send cursor', () => {
    const fresh = [`${MARKER} ${NONCE}`]
    expect(judge(read([], { latestCursor: '0' }), read(fresh, { truncated: true })).verdict).toBe(
      'UNKNOWN'
    )
    expect(judge(read([], { latestCursor: undefined }), read(fresh)).verdict).toBe('UNKNOWN')
  })
})
