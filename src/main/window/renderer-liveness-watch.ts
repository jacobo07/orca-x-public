/**
 * Whether an application window's renderer is still answering, as a recorded fact.
 *
 * `src/main/hang-watchdog/` watches the MAIN thread via a worker heartbeat. Nothing watched the
 * renderer, so the freeze users describe — window alive, title correct, pixels dead, only a
 * restart clears it — left no trace at all.
 *
 * Observation only, and deliberately: a false positive must never reload or kill a live window.
 * The recovery that already exists hangs off `render-process-gone`, which a hung-but-alive
 * renderer never emits.
 */

/** A stall that ended, and one that never did, are different evidence — only the first was survivable. */
export type RendererLivenessObservation =
  | { kind: 'unresponsive'; at: number }
  | { kind: 'responsive'; at: number; unresponsiveMs: number }
  | { kind: 'abandoned'; at: number; unresponsiveMs: number; reason: RendererGoneReason }

export type RendererGoneReason = 'closed' | 'process-gone'

export type RendererLivenessWatch = {
  markUnresponsive: () => void
  markResponsive: () => void
  /** The window or its renderer went away; reports an outstanding stall that therefore never cleared. */
  markGone: (reason: RendererGoneReason) => void
  readonly unresponsiveSince: number | null
}

export function createRendererLivenessWatch(deps: {
  now: () => number
  onObservation: (observation: RendererLivenessObservation) => void
}): RendererLivenessWatch {
  let unresponsiveSince: number | null = null

  return {
    markUnresponsive(): void {
      // Why: Electron re-emits while a stall continues; re-anchoring would report the last
      // notification instead of the length of the stall, which is the only number worth having.
      if (unresponsiveSince !== null) {
        return
      }
      const at = deps.now()
      unresponsiveSince = at
      deps.onObservation({ kind: 'unresponsive', at })
    },
    markResponsive(): void {
      // Why: 'responsive' can arrive without a stall of ours to close; reporting one would
      // invent a recovery from a freeze that was never observed.
      if (unresponsiveSince === null) {
        return
      }
      const at = deps.now()
      const unresponsiveMs = Math.max(0, at - unresponsiveSince)
      unresponsiveSince = null
      deps.onObservation({ kind: 'responsive', at, unresponsiveMs })
    },
    markGone(reason: RendererGoneReason): void {
      if (unresponsiveSince === null) {
        return
      }
      const at = deps.now()
      const unresponsiveMs = Math.max(0, at - unresponsiveSince)
      unresponsiveSince = null
      // Why this exists at all: the reported freeze is cleared by restarting Orca, so the only
      // moment a never-recovered stall can be written down is the one where the window goes away.
      deps.onObservation({ kind: 'abandoned', at, unresponsiveMs, reason })
    },
    get unresponsiveSince(): number | null {
      return unresponsiveSince
    }
  }
}
