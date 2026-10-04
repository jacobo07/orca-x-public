import { join } from 'node:path'
import {
  createListingFailureReporter,
  toListingError,
  unlistableBaseSnapshot,
  type WorktreeListingError
} from './worktree-base-directory-listing-errors'
import {
  diffBase,
  dirSignature,
  hasGitMarker,
  snapshotBase,
  type WorktreeBasePollEvent
} from './worktree-base-directory-snapshot'
import { isMainWindowVisible, onMainWindowBecameVisible } from '../window/main-window-visibility'
import type {
  WorktreeBaseRepoWatchConfig,
  WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'
import { startGitCommonWatch } from './worktree-git-common-watch'
import {
  getWorktreeObservationClock,
  type WorktreeObservationClock
} from './worktree-observation-clock'

export type { WorktreeBasePollEvent }

export type WorktreeBaseSubscription = { unsubscribe: () => Promise<void> }

export type WorktreePollerWindowVisibility = {
  isWindowVisible: () => boolean
  onWindowBecameVisible: (listener: () => void) => () => void
}

type WorktreePollerWindow = {
  isDestroyed: () => boolean
  isVisible?: () => boolean
  isMinimized?: () => boolean
}

const alwaysVisible: WorktreePollerWindowVisibility = {
  isWindowVisible: () => true,
  onWindowBecameVisible: () => () => {}
}

export function createWorktreePollerWindowVisibility(
  getWindow: () => WorktreePollerWindow | null
): WorktreePollerWindowVisibility {
  // Why: only park a window that has actually been shown and is now hidden. A window
  // that has NEVER been shown is either headless (ORCA_E2E_HEADLESS keeps a live but
  // never-shown BrowserWindow) or still starting up — no show/restore signal is coming
  // to resume it, so parking it would starve worktree freshness forever. Treat
  // never-shown as visible and keep polling; only start parking once we've observed the
  // window visible at least once. null/destroyed (serve/headless, macOS window-recreation
  // gap) stay always-visible so a torn-down window never permanently parks the poller.
  let hasBeenVisible = false
  return {
    isWindowVisible: () => {
      const window = getWindow()
      if (window === null || window.isDestroyed()) {
        return true
      }
      if (isMainWindowVisible(window)) {
        hasBeenVisible = true
        return true
      }
      return !hasBeenVisible
    },
    onWindowBecameVisible: onMainWindowBecameVisible
  }
}

export type WorktreeBasePollerOptions = {
  pollIntervalMs?: number
  platform?: NodeJS.Platform
  visibility?: WorktreePollerWindowVisibility
  getGitStatusRefPaths?: () => readonly string[]
  /** Returns false when the error was not delivered, so the poller offers it again next tick. */
  onWatchError?: (error: Error) => boolean | void
  /** Test hook: called whenever a full snapshot scan runs (vs. a gated skip). */
  onFullScan?: () => void
  /** Test hook: called before a pending `.git` marker stat. */
  onPendingMarkerProbe?: (path: string) => void
  /** Test hook: awaited with the tick after a full scan's listings, to land a racing write. */
  onSnapshotTaken?: (tick: number) => void | Promise<void>
  /** Test hook: overrides the fast-probe window. */
  pendingMarkerMaxTicks?: number
}

// Why: these targets used to be recursive FSEvents subscriptions spanning the
// entire workspace root (every worktree's full tree) and the repo's whole
// common .git (objects included), forcing fseventsd to deliver all of that
// churn to Orca just to observe a handful of shallow paths. The replacements
// register at most one tiny-scope native stream (macOS git-common) and
// otherwise poll with a dir-mtime gate, so idle cost is a couple of stat
// calls per tick. 2s is fast enough for external `git worktree add/remove`;
// Orca's own worktree operations notify the renderer directly.
export const WORKTREE_BASE_POLL_INTERVAL_MS = 2_000

// Why: the mtime gate is an optimization, not a correctness boundary — some
// filesystems have coarse dir timestamps, and pending `.git` markers expire.
// A periodic ungated scan guarantees eventual convergence.
export const WORKTREE_BASE_BACKSTOP_TICKS = 15

// Why: a `.git` completion marker lands within moments of its worktree dir
// (git writes it before populating the checkout). Dirs that never get one are
// not worktrees; stop re-statting them after this many ticks and let the
// backstop scan cover the pathological case.
const PENDING_MARKER_MAX_TICKS = 300

async function startBasePoller(
  target: WorktreeBaseWatchTarget,
  getRepos: () => ReadonlyMap<string, WorktreeBaseRepoWatchConfig>,
  onTargetEvents: (events: WorktreeBasePollEvent[]) => void,
  clock: WorktreeObservationClock,
  visibility: WorktreePollerWindowVisibility,
  options: WorktreeBasePollerOptions
): Promise<WorktreeBaseSubscription> {
  let disposed = false
  let ticking = false
  let tickCount = 0
  const noteListingOutcome = createListingFailureReporter((error) => {
    if (!options.onWatchError) {
      console.warn('[worktree-base-poller]', error)
      return true
    }
    return options.onWatchError(error) !== false
  })
  const startupErrors: WorktreeListingError[] = []
  let snapshot = await snapshotBase(target.path, getRepos()).catch((error: unknown) => {
    startupErrors.push(toListingError(target.path, error))
    return unlistableBaseSnapshot(target.path)
  })
  noteListingOutcome([...startupErrors, ...snapshot.listingErrors], startupErrors.length === 0)
  let parkedWhileHidden = false
  const onEvents = (events: WorktreeBasePollEvent[]): void => {
    registration.noteActivity()
    onTargetEvents(events)
  }
  const pendingMarkerMaxTicks = options.pendingMarkerMaxTicks ?? PENDING_MARKER_MAX_TICKS
  // dir → first probe tick; null means backstop scans only
  const markerProbeStartedAt = new Map<string, number | null>()
  for (const [dir, marker] of snapshot.markers) {
    if (!marker) {
      markerProbeStartedAt.set(dir, 0)
    }
  }

  const fullScan = async (): Promise<void> => {
    options.onFullScan?.()
    const next = await snapshotBase(target.path, getRepos(), snapshot)
    await options.onSnapshotTaken?.(tickCount)
    if (disposed) {
      return
    }
    noteListingOutcome(next.listingErrors, true)
    const events = diffBase(snapshot, next)
    for (const [dir, marker] of next.markers) {
      if (marker) {
        markerProbeStartedAt.delete(dir)
      } else if (!markerProbeStartedAt.has(dir)) {
        markerProbeStartedAt.set(dir, tickCount)
      }
    }
    for (const dir of markerProbeStartedAt.keys()) {
      if (!next.markers.has(dir)) {
        markerProbeStartedAt.delete(dir)
      }
    }
    snapshot = next
    if (events.length > 0) {
      onEvents(events)
    }
  }

  const checkPendingMarkers = async (): Promise<void> => {
    const events: WorktreeBasePollEvent[] = []
    for (const [dir, firstSeenTick] of markerProbeStartedAt) {
      if (firstSeenTick === null) {
        continue
      }
      if (tickCount - firstSeenTick > pendingMarkerMaxTicks) {
        markerProbeStartedAt.set(dir, null)
        continue
      }
      options.onPendingMarkerProbe?.(join(dir, '.git'))
      if (await hasGitMarker(dir)) {
        markerProbeStartedAt.delete(dir)
        snapshot.markers.set(dir, true)
        events.push({ type: 'create', path: join(dir, '.git') })
      }
    }
    if (!disposed && events.length > 0) {
      onEvents(events)
    }
  }

  const poll = async (forceFullScan = false): Promise<void> => {
    tickCount++
    if (forceFullScan || tickCount % WORKTREE_BASE_BACKSTOP_TICKS === 0) {
      await fullScan()
      return
    }
    // Idle fast path: when the dirs whose listings define the candidate set
    // are untouched, skip the readdir + per-candidate stat fan-out entirely.
    const signatures = await Promise.all(snapshot.gateDirs.map(dirSignature))
    const gateChanged =
      signatures.length !== snapshot.gateSignatures.length ||
      signatures.some((sig, index) => sig !== snapshot.gateSignatures[index])
    if (gateChanged) {
      await fullScan()
      return
    }
    if (markerProbeStartedAt.size > 0) {
      await checkPendingMarkers()
    }
  }

  const registration = clock.register(async (forceFullScan) => {
    if (disposed) {
      return 'observed'
    }
    if (!visibility.isWindowVisible()) {
      parkedWhileHidden = true
      return 'parked'
    }
    if (ticking) {
      return 'observed'
    }
    ticking = true
    try {
      await poll(forceFullScan)
    } catch (error) {
      // Transient fs error: keep the previous snapshot and retry next tick.
      noteListingOutcome([toListingError(target.path, error)], false)
    } finally {
      ticking = false
    }
    return 'observed'
  })

  const unsubscribeVisibility = visibility.onWindowBecameVisible(() => {
    if (disposed || !parkedWhileHidden) {
      return
    }
    parkedWhileHidden = false
    // Why: the ordinary dir-signature gate can miss same-granule changes made
    // while hidden; resume must diff a fresh full snapshot against the baseline.
    registration.runNow(true)
  })

  return {
    unsubscribe: async () => {
      disposed = true
      registration.unregister()
      unsubscribeVisibility()
    }
  }
}

/** Watches the shallow paths a worktree base target cares about and emits
 *  watcher-shaped events. Resolves once the baseline (snapshot or narrow
 *  native subscription) is established. */
export async function startWorktreeBaseDirectoryPoller(
  target: WorktreeBaseWatchTarget,
  getRepos: () => ReadonlyMap<string, WorktreeBaseRepoWatchConfig>,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  options: WorktreeBasePollerOptions = {}
): Promise<WorktreeBaseSubscription> {
  const pollIntervalMs = options.pollIntervalMs ?? WORKTREE_BASE_POLL_INTERVAL_MS
  const platform = options.platform ?? process.platform
  const visibility = options.visibility ?? alwaysVisible
  if (target.kind === 'git-common') {
    return startGitCommonWatch(
      target,
      onEvents,
      pollIntervalMs,
      platform,
      visibility,
      options.onFullScan,
      options.getGitStatusRefPaths,
      options.onWatchError
    )
  }
  const clock = getWorktreeObservationClock(pollIntervalMs)
  return startBasePoller(target, getRepos, onEvents, clock, visibility, options)
}
