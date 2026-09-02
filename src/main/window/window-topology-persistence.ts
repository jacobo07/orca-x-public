/**
 * Where the window topology is kept, and the rules for touching it.
 *
 * It lives in the profile's UI state rather than in a file of its own, deliberately: that file is
 * already `persistence.profile-data-file`, already crash-durable, and already has a `.bak` ring
 * behind it. A separate file would be a second publisher to classify, a second way to be torn, and
 * a durable pointer with a non-durable referent — the exact shape the durability contracts warn
 * about — for state that is strictly less valuable than the session it would point into.
 *
 * The topology is never sent over the paired-client wire and is not part of `UiUpdateFields`. A
 * remote client has no windows, so a client that could write this key could rewrite the desktop's
 * window set from a machine that cannot see it.
 */
import {
  captureWindowTopology,
  normalizeWindowTopology,
  planWindowTopologyRestore,
  shouldPublishWindowTopology,
  type LiveWindowTopologyEntry,
  type PersistedWindowTopologyEntry
} from './window-topology'

export type WindowTopologyStore = {
  getUI: () => { windowTopology?: unknown }
  updateUI: (patch: { windowTopology: PersistedWindowTopologyEntry[] }) => void
}

/**
 * Record the live window set, or decline to.
 *
 * Returns what was written so a caller can log it; null means the write was deliberately skipped,
 * which is the normal answer during a quit.
 */
export function publishWindowTopology(deps: {
  store: WindowTopologyStore | null
  listLiveWindows: () => LiveWindowTopologyEntry[]
  isQuitting: () => boolean
}): PersistedWindowTopologyEntry[] | null {
  if (!deps.store) {
    return null
  }
  const captured = captureWindowTopology(deps.listLiveWindows())
  if (!shouldPublishWindowTopology(captured, { isQuitting: deps.isQuitting() })) {
    return null
  }
  deps.store.updateUI({ windowTopology: captured })
  return captured
}

/**
 * The windows to reopen, or null when there is nothing trustworthy to reopen from.
 *
 * Null covers three different situations on purpose — never recorded, recorded unreadably, and the
 * read itself failing — because the caller's response to all three is the same and is the safe one:
 * open the single default window and leave what is on disk alone.
 */
export function readWindowTopologyRestorePlan(deps: {
  store: WindowTopologyStore | null
  worktreeExists: (worktreeId: string) => boolean
}): PersistedWindowTopologyEntry[] | null {
  if (!deps.store) {
    return null
  }
  let recorded: unknown
  try {
    recorded = deps.store.getUI().windowTopology
  } catch (err) {
    console.warn('[window] Could not read the saved window topology:', err)
    return null
  }
  const entries = normalizeWindowTopology(recorded)
  if (entries === null || entries.length === 0) {
    return null
  }
  return planWindowTopologyRestore(entries, { worktreeExists: deps.worktreeExists })
}
