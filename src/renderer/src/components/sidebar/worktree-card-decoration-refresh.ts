import { e2eConfig } from '@/lib/e2e-config'
import { installWindowVisibilityInterval, isWindowVisible } from '@/lib/window-visibility-interval'
import { HOSTED_REVIEW_CARD_REFRESH_INTERVAL_MS } from './worktree-card-model'

// One clock per window refreshes every mounted card's hosted-review and linked-issue decoration,
// so mounted card count no longer sets timer count and two cards showing one subject ask once.
// The store fetchers keep freshness and in-flight dedup; this only decides who is asked and when.

export type WorktreeCardDecorationFamily = 'hosted-review' | 'linked-issue'

export const WORKTREE_CARD_DECORATION_INTERVALS_MS: Record<WorktreeCardDecorationFamily, number> = {
  'hosted-review': HOSTED_REVIEW_CARD_REFRESH_INTERVAL_MS,
  'linked-issue': 5 * 60_000
}

type Subject = { run: () => unknown; holders: number }

export type WorktreeCardDecorationRefresh = {
  /** `key` must identify every argument `run` sends, so a changed argument is a new subject. */
  register: (family: WorktreeCardDecorationFamily, key: string, run: () => unknown) => () => void
  inspect: () => {
    clockRunning: boolean
    ticks: number
    subjects: Record<WorktreeCardDecorationFamily, number>
    holders: number
  }
}

type InstallInterval = typeof installWindowVisibilityInterval

export function createWorktreeCardDecorationRefresh(
  installInterval: InstallInterval = installWindowVisibilityInterval
): WorktreeCardDecorationRefresh {
  const families = Object.keys(
    WORKTREE_CARD_DECORATION_INTERVALS_MS
  ) as WorktreeCardDecorationFamily[]
  const baseIntervalMs = Math.min(...families.map((f) => WORKTREE_CARD_DECORATION_INTERVALS_MS[f]))
  const subjects = new Map<WorktreeCardDecorationFamily, Map<string, Subject>>(
    families.map((f) => [f, new Map()])
  )
  let holders = 0
  let ticks = 0
  let stopClock: (() => void) | null = null

  const runSubject = (subject: Subject): void => {
    // Why: one subject's failure must not skip the rest of the tick.
    try {
      const result = subject.run()
      if (result instanceof Promise) {
        result.catch((error) => console.error('Worktree card decoration refresh failed:', error))
      }
    } catch (error) {
      console.error('Worktree card decoration refresh failed:', error)
    }
  }
  const runFamily = (family: WorktreeCardDecorationFamily): void => {
    for (const subject of subjects.get(family)!.values()) {
      runSubject(subject)
    }
  }
  const runAll = (): void => {
    ticks = 0
    families.forEach(runFamily)
  }
  const tick = (): void => {
    ticks++
    for (const family of families) {
      // Why: each family keeps its own cadence on the shared clock instead of running at the fastest one.
      const every = Math.round(WORKTREE_CARD_DECORATION_INTERVALS_MS[family] / baseIntervalMs)
      if (ticks % every === 0) {
        runFamily(family)
      }
    }
  }

  return {
    register(family, key, run) {
      const bucket = subjects.get(family)!
      const existing = bucket.get(key)
      let subject: Subject
      if (existing) {
        existing.run = run
        existing.holders++
        subject = existing
      } else {
        subject = { run, holders: 1 }
        bucket.set(key, subject)
      }
      holders++
      if (!stopClock) {
        // Why: starting the clock runs every subject once, which covers this new one.
        stopClock = installInterval({ run: tick, runOnVisible: runAll, intervalMs: baseIntervalMs })
      } else if (!existing && isWindowVisible()) {
        runSubject(subject)
      }
      let released = false
      return () => {
        if (released) {
          return
        }
        released = true
        subject.holders--
        if (subject.holders === 0 && bucket.get(key) === subject) {
          bucket.delete(key)
        }
        holders--
        if (holders === 0 && stopClock) {
          stopClock()
          stopClock = null
          ticks = 0
        }
      }
    },
    inspect() {
      return {
        clockRunning: stopClock !== null,
        ticks,
        subjects: Object.fromEntries(families.map((f) => [f, subjects.get(f)!.size])) as Record<
          WorktreeCardDecorationFamily,
          number
        >,
        holders
      }
    }
  }
}

let windowRefresh: WorktreeCardDecorationRefresh | null = null

/** The renderer is one window, so module scope is window scope. */
export function getWorktreeCardDecorationRefresh(): WorktreeCardDecorationRefresh {
  if (!windowRefresh) {
    windowRefresh = createWorktreeCardDecorationRefresh()
    if (e2eConfig.exposeStore && typeof window !== 'undefined') {
      const refresh = windowRefresh
      ;(
        window as { __orcaWorktreeCardDecorationRefresh?: unknown }
      ).__orcaWorktreeCardDecorationRefresh = () => refresh.inspect()
    }
  }
  return windowRefresh
}
