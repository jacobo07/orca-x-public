/**
 * The set of workspace windows that were open, so a relaunch reopens the same ones.
 *
 * This module is only the model: capture the live set, decide whether a capture is safe to publish,
 * read a recorded one back, and turn it into a restore plan. Nothing here touches Electron or the
 * store, because the interesting failures are all in the degenerate cases and those are easier to
 * hold still in a pure function than behind a window lifecycle.
 *
 * Three rules earn their place:
 *
 * - **An empty capture is never published.** Every window closing is what a quit looks like, so the
 *   one moment a clean shutdown would write is the moment it would erase the set it exists to save.
 * - **Unreadable is not empty.** A read that fails returns "absent", never `[]`. Collapsing the two
 *   is what turns a transient failure into permanent loss on the next write.
 * - **A worktree still binds to at most one window.** `claimWorkspaceForWindow` refuses a second
 *   binding at runtime; a restore that honoured a duplicate would reintroduce exactly the state that
 *   refusal prevents, so the later window opens on the launcher instead.
 */
import type { WorkspaceWindowBinding } from './workspace-window-registry'
import type {
  PersistedWindowTopologyBounds as WindowTopologyBounds,
  PersistedWindowTopologyEntry
} from '../../shared/window-topology-types'

export type { PersistedWindowTopologyEntry, WindowTopologyBounds }

export type LiveWindowTopologyEntry = PersistedWindowTopologyEntry

function isBounds(value: unknown): value is WindowTopologyBounds {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (['x', 'y', 'width', 'height'] as const).every(
    (key) => typeof candidate[key] === 'number' && Number.isFinite(candidate[key])
  )
}

function normalizeBinding(value: unknown): WorkspaceWindowBinding | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.repoId === 'string' && typeof candidate.worktreeId === 'string'
    ? { repoId: candidate.repoId, worktreeId: candidate.worktreeId }
    : null
}

function normalizeEntry(value: unknown): PersistedWindowTopologyEntry | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.windowId !== 'string' || candidate.windowId.length === 0) {
    return null
  }
  const sequence = candidate.sequence
  return {
    windowId: candidate.windowId,
    sequence: typeof sequence === 'number' && Number.isFinite(sequence) ? sequence : 0,
    binding: normalizeBinding(candidate.binding),
    bounds: isBounds(candidate.bounds) ? candidate.bounds : null,
    maximized: candidate.maximized === true
  }
}

/** Snapshot the live window set, in mint order. */
export function captureWindowTopology(
  windows: readonly LiveWindowTopologyEntry[]
): PersistedWindowTopologyEntry[] {
  return [...windows]
    .sort((a, b) => a.sequence - b.sequence)
    .map((window) => ({
      windowId: window.windowId,
      sequence: window.sequence,
      binding: window.binding ? { ...window.binding } : null,
      bounds: window.bounds ? { ...window.bounds } : null,
      maximized: window.maximized
    }))
}

/**
 * Whether a capture is safe to write.
 *
 * A quit closes every window one by one, so without this the last close before exit publishes the
 * empty set — and the next launch restores nothing. Freezing during the quit means the topology on
 * disk is the one from just before it, which is also exactly what a crash leaves behind. The two
 * paths converge on the same answer for the same reason.
 */
export function shouldPublishWindowTopology(
  captured: readonly PersistedWindowTopologyEntry[],
  context: { isQuitting: boolean }
): boolean {
  return !context.isQuitting && captured.length > 0
}

/**
 * Read a recorded topology, distinguishing absent from empty.
 *
 * `null` means "nothing usable was recorded" — no topology, or one this build cannot read. `[]`
 * means a genuinely empty topology was recorded. Callers must not publish over the first.
 */
export function normalizeWindowTopology(value: unknown): PersistedWindowTopologyEntry[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const entries = value.map(normalizeEntry).filter((entry): entry is PersistedWindowTopologyEntry => entry !== null)
  // Why not []: an array that yielded nothing usable is a failed read wearing the shape of a result.
  if (entries.length === 0 && value.length > 0) {
    return null
  }
  return entries
}

/**
 * Turn a recorded topology into the windows to open.
 *
 * Windows are never dropped — a window whose project has since been deleted, or whose project a
 * lower-sequence window already claims, opens on the launcher with its geometry intact. Dropping it
 * would silently reduce the user's window count on a restart, which reads as the app losing a window
 * rather than as a project having gone away.
 */
export function planWindowTopologyRestore(
  entries: readonly PersistedWindowTopologyEntry[],
  options: { worktreeExists: (worktreeId: string) => boolean }
): PersistedWindowTopologyEntry[] {
  const claimed = new Set<string>()
  return [...entries]
    .sort((a, b) => a.sequence - b.sequence)
    .map((entry) => {
      const worktreeId = entry.binding?.worktreeId
      const bindable =
        worktreeId !== undefined && !claimed.has(worktreeId) && options.worktreeExists(worktreeId)
      if (bindable) {
        claimed.add(worktreeId)
      }
      return { ...entry, binding: bindable ? entry.binding : null }
    })
}
