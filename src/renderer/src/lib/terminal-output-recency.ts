/**
 * Per-pane PTY output recency — the input that separates a long turn from an abandoned pane.
 *
 * Agent hooks report at turn boundaries, so a turn longer than the staleness window emits no status
 * update while it runs. Without this, a streaming pane and a pane abandoned an hour ago reach the
 * activity resolver as identical arguments (see terminal-tab-activity-long-turn-staleness.test.ts).
 *
 * Output is evidence that the state still holds; it is never evidence of what the state IS. A pane
 * with no agent row does not become `working` because bytes arrived — only an existing explicit
 * state is held open.
 */

/**
 * Why 30s: the consumer is a 30-minute window, so losing the trailing edge costs nothing and the
 * leading edge does not have to be exact. A continuously streaming pane writes twice a minute
 * instead of once per chunk, and no timer is needed — which is why this adds no recurring work.
 */
export const TERMINAL_OUTPUT_RECENCY_WRITE_INTERVAL_MS = 30_000

/**
 * Why a window rather than "any output since the report": a `done` hook that never arrived would
 * otherwise let later shell output hold a finished turn open forever. Bounded, the worst case is a
 * dot that stays live for this long after the bytes stop.
 */
export const TERMINAL_OUTPUT_LIVENESS_WINDOW_MS = 2 * 60 * 1000

const GATE_PRUNE_SIZE = 256
const lastWrittenByPaneKey = new Map<string, number>()

function pruneGate(now: number): void {
  if (lastWrittenByPaneKey.size <= GATE_PRUNE_SIZE) {
    return
  }
  for (const [paneKey, writtenAt] of lastWrittenByPaneKey) {
    // Entries past the interval already pass the gate, so dropping them changes nothing.
    if (now - writtenAt >= TERMINAL_OUTPUT_RECENCY_WRITE_INTERVAL_MS) {
      lastWrittenByPaneKey.delete(paneKey)
    }
  }
}

/** True when this pane's output stamp is due a store write. Call once per observed chunk. */
export function shouldWriteTerminalOutputStamp(paneKey: string, at: number): boolean {
  if (!paneKey || !Number.isFinite(at)) {
    return false
  }
  const lastWrittenAt = lastWrittenByPaneKey.get(paneKey)
  if (lastWrittenAt !== undefined && at - lastWrittenAt < TERMINAL_OUTPUT_RECENCY_WRITE_INTERVAL_MS) {
    return false
  }
  lastWrittenByPaneKey.set(paneKey, at)
  pruneGate(at)
  return true
}

/**
 * Whether observed output should hold an otherwise-stale agent state open.
 *
 * Deliberately not a general freshness helper: it answers only "is the belief still supported",
 * and an absent stamp is unknown, never fresh.
 */
export function paneOutputHoldsAgentStateOpen({
  lastOutputAt,
  now,
  windowMs = TERMINAL_OUTPUT_LIVENESS_WINDOW_MS
}: {
  lastOutputAt: number | undefined
  now: number
  windowMs?: number
}): boolean {
  if (lastOutputAt === undefined || !Number.isFinite(lastOutputAt)) {
    return false
  }
  // Why clamp below: a clock that moved backwards must not read as "fresher than now".
  const age = now - lastOutputAt
  return age >= 0 && age <= windowMs
}

export function resetTerminalOutputRecencyGateForTests(): void {
  lastWrittenByPaneKey.clear()
}
