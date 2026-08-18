import { useEffect } from 'react'
import { useAppStore } from '../store'

/**
 * Records which project the user actually opened, feeding the launcher's Recent projects list.
 *
 * Why a gate rather than a hook in App: activation is high-churn, and this subscription has no
 * business re-rendering the App shell. Why not the activation path itself: that path is hot and
 * already carries remount warnings, so observing it is cheaper than extending it.
 */
export function RecentProjectTrackingGate(): null {
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const activeRepoId = useAppStore((s) => {
    const worktreeId = s.activeWorktreeId
    return worktreeId ? (s.getKnownWorktreeById(worktreeId)?.repoId ?? null) : null
  })
  const noteProjectOpened = useAppStore((s) => s.noteProjectOpened)

  useEffect(() => {
    // Why the readiness gate: before hydration the in-memory list is empty, so stamping here would
    // publish a one-entry MRU over the stored one — a transient state turned into permanent loss.
    if (!persistedUIReady || !activeRepoId) {
      return
    }
    noteProjectOpened(activeRepoId)
  }, [activeRepoId, noteProjectOpened, persistedUIReady])

  return null
}
