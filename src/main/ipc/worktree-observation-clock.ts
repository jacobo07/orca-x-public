/**
 * The one timer behind every local worktree poll (base dirs, git-common metadata, macOS existence).
 *
 * Why: each watch target used to own a 2s timer, so observation cost grew with every repo in the
 * store whether or not anything was happening in it. Targets now register a run here: one timer per
 * interval, targets that were recently active (or pinned) run every cycle, quiet ones every
 * QUIET_EVERY_CYCLES cycles — external changes in a quiet repo still surface, just less often, and
 * any change makes the target active again. See docs/reference/resource-elasticity-fabric.md.
 */

// A target that emitted an event within this window keeps the full cadence.
export const WORKTREE_OBSERVATION_ACTIVE_WINDOW_MS = 2 * 60_000
// Quiet targets run once per this many cycles (10s at the production 2s interval).
export const WORKTREE_OBSERVATION_QUIET_EVERY_CYCLES = 5
// Why: one cycle must not fan every target's stats into the libuv pool at once.
export const WORKTREE_OBSERVATION_MAX_CONCURRENT_RUNS = 4
// A run still pending after this many cycles stops holding a slot, so one hung stat cannot stall all.
const SLOW_RUN_RELEASE_CYCLES = 4

/** 'parked' means the target's window is hidden: skip it until runNow() wakes it. */
export type WorktreeObservationRunResult = 'observed' | 'parked'

export type WorktreeObservationRun = (
  forceFullScan: boolean
) => Promise<WorktreeObservationRunResult>

export type WorktreeObservationRegistration = {
  /** The target saw a change; keep it on the full cadence. */
  noteActivity: () => void
  /** Run as soon as a slot is free (after a hidden window returns, or a watcher gave up). */
  runNow: (forceFullScan: boolean) => void
  unregister: () => void
}

export type WorktreeObservationRegisterOptions = {
  /** Keeps the target on the full cadence while true (e.g. it holds the active git-status ref). */
  isPinnedActive?: () => boolean
}

export type WorktreeObservationClock = {
  register: (
    run: WorktreeObservationRun,
    options?: WorktreeObservationRegisterOptions
  ) => WorktreeObservationRegistration
  /** Test/diagnostic view: registered targets and whether the timer is armed. */
  inspect: () => {
    registrations: number
    parked: number
    running: boolean
    cycles: number
    runs: number
  }
}

type Entry = {
  run: WorktreeObservationRun
  isPinnedActive: () => boolean
  lastActivityAt: number
  lastRunCycle: number
  runStartedCycle: number
  parked: boolean
  queued: boolean
  inFlight: boolean
  holdsSlot: boolean
  forceNext: boolean
  rerunForced: boolean
  removed: boolean
}

export function createWorktreeObservationClock(
  intervalMs: number,
  maxConcurrentRuns = WORKTREE_OBSERVATION_MAX_CONCURRENT_RUNS
): WorktreeObservationClock {
  const entries = new Set<Entry>()
  let queue: Entry[] = []
  let slotsInUse = 0
  let cycle = 0
  let runs = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const hasAwakeEntry = (): boolean => [...entries].some((entry) => !entry.parked)

  const releaseSlot = (entry: Entry): void => {
    if (entry.holdsSlot) {
      entry.holdsSlot = false
      slotsInUse--
    }
  }

  const start = (entry: Entry): void => {
    const force = entry.forceNext
    entry.forceNext = false
    entry.inFlight = true
    entry.holdsSlot = true
    entry.lastRunCycle = cycle
    entry.runStartedCycle = cycle
    slotsInUse++
    runs++
    // Why: start synchronously, so a resume request begins its scan in the caller's turn.
    let running: Promise<WorktreeObservationRunResult>
    try {
      running = entry.run(force)
    } catch (error) {
      running = Promise.reject(error)
    }
    void running
      .then(
        (result) => {
          if (result === 'parked' && !entry.removed) {
            entry.parked = true
          }
        },
        // Why: a target's failure is its own; the others keep observing.
        () => {}
      )
      .finally(() => {
        entry.inFlight = false
        releaseSlot(entry)
        if (entry.rerunForced && !entry.removed) {
          entry.rerunForced = false
          enqueue(entry, true)
        }
        pump()
        syncTimer()
      })
  }

  const pump = (): void => {
    while (slotsInUse < maxConcurrentRuns && queue.length > 0) {
      const entry = queue.shift()!
      entry.queued = false
      if (!entry.removed) {
        start(entry)
      }
    }
  }

  const enqueue = (entry: Entry, force: boolean): void => {
    if (entry.removed) {
      return
    }
    if (entry.inFlight) {
      // Why: never overlap one target with itself; a forced request waits for the run to finish.
      if (force) {
        entry.rerunForced = true
      }
      return
    }
    if (force) {
      entry.forceNext = true
    }
    if (!entry.queued) {
      entry.queued = true
      queue.push(entry)
    }
  }

  const isDue = (entry: Entry, now: number): boolean =>
    now - entry.lastActivityAt < WORKTREE_OBSERVATION_ACTIVE_WINDOW_MS ||
    entry.isPinnedActive() ||
    cycle - entry.lastRunCycle >= WORKTREE_OBSERVATION_QUIET_EVERY_CYCLES

  const runCycle = (): void => {
    timer = null
    cycle++
    const now = Date.now()
    for (const entry of entries) {
      if (
        entry.inFlight &&
        entry.holdsSlot &&
        cycle - entry.runStartedCycle >= SLOW_RUN_RELEASE_CYCLES
      ) {
        releaseSlot(entry)
      }
      if (!entry.parked && isDue(entry, now)) {
        enqueue(entry, false)
      }
    }
    pump()
    if (hasAwakeEntry()) {
      timer = setTimeout(runCycle, intervalMs)
      timer.unref?.()
    }
  }

  // Why: stop at zero awake targets; restart when one registers or wakes.
  const syncTimer = (): void => {
    if (hasAwakeEntry()) {
      if (!timer) {
        timer = setTimeout(runCycle, intervalMs)
        timer.unref?.()
      }
    } else if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    register: (run, options = {}) => {
      const entry: Entry = {
        run,
        isPinnedActive: options.isPinnedActive ?? (() => false),
        lastActivityAt: Date.now(),
        lastRunCycle: cycle,
        runStartedCycle: cycle,
        parked: false,
        queued: false,
        inFlight: false,
        holdsSlot: false,
        forceNext: false,
        rerunForced: false,
        removed: false
      }
      entries.add(entry)
      syncTimer()
      return {
        noteActivity: () => {
          entry.lastActivityAt = Date.now()
        },
        runNow: (forceFullScan) => {
          if (entry.removed) {
            return
          }
          entry.parked = false
          entry.lastActivityAt = Date.now()
          enqueue(entry, forceFullScan)
          pump()
          syncTimer()
        },
        unregister: () => {
          if (entry.removed) {
            return
          }
          entry.removed = true
          entries.delete(entry)
          if (entry.queued) {
            queue = queue.filter((queued) => queued !== entry)
            entry.queued = false
          }
          syncTimer()
        }
      }
    },
    inspect: () => ({
      registrations: entries.size,
      parked: [...entries].filter((entry) => entry.parked).length,
      running: timer !== null,
      cycles: cycle,
      runs
    })
  }
}

const sharedClocks = new Map<number, WorktreeObservationClock>()

if (process.env.ORCA_E2E_USER_DATA_DIR) {
  // Why: lets the e2e suite count the observation work of the running app.
  ;(globalThis as { __orcaWorktreeObservation?: unknown }).__orcaWorktreeObservation = () =>
    [...sharedClocks].map(([intervalMs, clock]) => ({ intervalMs, ...clock.inspect() }))
}

/** One clock per interval; production uses a single 2s interval, so this is one timer. */
export function getWorktreeObservationClock(intervalMs: number): WorktreeObservationClock {
  let clock = sharedClocks.get(intervalMs)
  if (!clock) {
    clock = createWorktreeObservationClock(intervalMs)
    sharedClocks.set(intervalMs, clock)
  }
  return clock
}
