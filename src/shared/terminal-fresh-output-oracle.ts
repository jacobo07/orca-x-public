import type { RuntimeTerminalRead } from './runtime-types'

export type FreshTerminalOutputVerdict =
  | 'FRESH'
  | 'CONTAMINATED'
  | 'ABSENT'
  | 'WRONG_TERMINAL'
  | 'UNKNOWN'

export type FreshTerminalOutputJudgement = { verdict: FreshTerminalOutputVerdict; reason?: string }

export type FreshTerminalOutputInput = {
  handle: string
  marker: string
  nonce: string
  /** Exact text written to the PTY; an echo of it is input, never output. */
  sentText: string
  /** Read taken before the send; its latestCursor bounds what counts as fresh. */
  before: RuntimeTerminalRead
  /** Read taken after the send with cursor = before.latestCursor. */
  after: RuntimeTerminalRead
}

export function freshOutputExpectedLine(marker: string, nonce: string): string {
  return `${marker} ${nonce}`
}

/** Proves a send by output it caused: a line `marker nonce` that only the command's execution prints. */
export function judgeFreshTerminalOutput(
  input: FreshTerminalOutputInput
): FreshTerminalOutputJudgement {
  const { handle, marker, nonce, sentText, before, after } = input
  if (!marker || !nonce || marker.includes(nonce) || nonce.includes(marker)) {
    return { verdict: 'UNKNOWN', reason: 'marker and nonce must be distinct non-empty strings' }
  }
  const expected = freshOutputExpectedLine(marker, nonce)
  // Why: if the typed text is the expected line, its echo is indistinguishable from output.
  if (sentText.includes(expected)) {
    return { verdict: 'UNKNOWN', reason: 'sent text contains the expected output line verbatim' }
  }
  if (before.handle !== handle || after.handle !== handle) {
    return { verdict: 'WRONG_TERMINAL', reason: `expected ${handle}, read ${after.handle}` }
  }
  // Why: a nonce the terminal already showed proves nothing about this send.
  if (before.tail.some((line) => line.includes(nonce))) {
    return { verdict: 'CONTAMINATED', reason: 'nonce present before the send' }
  }
  if (before.latestCursor === undefined) {
    return { verdict: 'UNKNOWN', reason: 'pre-send read carries no cursor' }
  }
  if (after.truncated) {
    return { verdict: 'UNKNOWN', reason: 'post-send read is truncated' }
  }
  // Why: Windows ConPTY repaints with cursor moves, so a line-split tail can glue the output onto the
  // full echo; the echo alone cannot contain `expected`, so echo-then-expected still proves execution.
  const glued = `${sentText}${expected}`
  return after.tail.some((line) => line.trim() === expected || line.trimEnd().endsWith(glued))
    ? { verdict: 'FRESH' }
    : { verdict: 'ABSENT', reason: `no output line equals "${expected}"` }
}
