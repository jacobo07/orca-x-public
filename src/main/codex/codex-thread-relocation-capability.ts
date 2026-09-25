// Whether a Codex peer can move an existing thread to another directory, decided from the peer's
// own `initialize` answer BEFORE anything depends on it.
//
// Measured: `thread/resume {threadId, cwd}` relocates the thread on codex-cli 0.153.4 and 0.155.1.
// Nothing earlier was measured, so an earlier or unreadable version is UNKNOWN — not "unsupported",
// and never allowed: such a peer is not sent the field, and a moved thread starts anew instead.

export type ThreadRelocation = 'supported' | 'unknown'

const MEASURED_FLOOR = [0, 153, 4] as const

/** `initialize` answers `userAgent: "<client>/<codex version> (<platform>) ..."` (0.155.1). */
export function codexVersionOf(initializeResult: unknown): [number, number, number] | null {
  const userAgent = (initializeResult as { userAgent?: unknown } | null)?.userAgent
  const match =
    typeof userAgent === 'string' ? /^[^/\s]+\/(\d+)\.(\d+)\.(\d+)/.exec(userAgent) : null
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function codexThreadRelocation(initializeResult: unknown): ThreadRelocation {
  const version = codexVersionOf(initializeResult)
  if (version === null) {
    return 'unknown'
  }
  for (let index = 0; index < MEASURED_FLOOR.length; index += 1) {
    if (version[index] !== MEASURED_FLOOR[index]) {
      return version[index] > MEASURED_FLOOR[index] ? 'supported' : 'unknown'
    }
  }
  return 'supported'
}
