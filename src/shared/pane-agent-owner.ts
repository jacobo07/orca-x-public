import type { ProviderType } from './agent-status-types'

/**
 * The owner-evidence signals a terminal pane can carry, strongest launch intent
 * first, ending in the durable host-stamped identity. Every field is optional so
 * each call site passes only what it holds; absent signals are skipped.
 */
export type PaneAgentOwnerSignals = {
  /** Tab-scoped launch intent — what Orca launched into this tab. */
  launchAgent?: ProviderType | null
  /** Never-cleared per-connection launch seed (pane connection only). */
  startupLaunchAgent?: ProviderType | null
  /** Startup-provided initial agent status (pane connection only). */
  initialStatusAgent?: ProviderType | null
  /** Agent inferred from a manually typed shell command (pane connection only). */
  commandInferredAgent?: ProviderType | null
  /** Live focused-pane hook identity — host-stamped, published, mirror-safe. */
  hookAgent?: ProviderType | null
  /** Live sibling-pane hook identity. */
  siblingHookAgent?: ProviderType | null
  /** Last completed focused-pane hook — survives the live hook row clearing. */
  completedHookAgent?: ProviderType | null
  /** Last completed sibling-pane hook. */
  siblingCompletedHookAgent?: ProviderType | null
  /** Hibernated session record — the final durable identity while a pane sleeps. */
  sleepingSessionAgent?: ProviderType | null
}

/**
 * The single authoritative resolver for "which agent owns this pane", shared by
 * the tab-icon resolver, the terminal-pane display/renderer owner, and the
 * mirrored-tab title owner so they cannot drift apart.
 *
 * Why this precedence: launch intent is the authoritative bootstrap before any
 * process signal exists, so it leads. Once launch metadata is gone — a mirrored
 * or restored pane drops the host-owned launchAgent — the owner must fall
 * through to a durable pane identity rather than to the raw title, because a
 * wrapper agent's title (OMP emits Pi-compatible frames) cannot be told apart
 * from the agent it wraps. The host-stamped hook identity is that durable,
 * published, mirror-safe anchor; the last completed hook and the hibernated
 * session record carry it across the windows where no live hook exists. Ranking
 * launch/live-hook above the completed/sleeping records keeps a genuine pane on
 * its real agent and stops a stale record from hijacking it.
 */
export function resolvePaneAgentOwner(signals: PaneAgentOwnerSignals): ProviderType | null {
  return (
    signals.launchAgent ??
    signals.startupLaunchAgent ??
    signals.initialStatusAgent ??
    signals.commandInferredAgent ??
    signals.hookAgent ??
    signals.siblingHookAgent ??
    signals.completedHookAgent ??
    signals.siblingCompletedHookAgent ??
    signals.sleepingSessionAgent ??
    null
  )
}
