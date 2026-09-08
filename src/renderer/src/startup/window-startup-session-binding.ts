/**
 * Blank the saved session's active project for a window that must not restore it.
 *
 * The session names one active worktree for the whole profile. A second project window that restored
 * it would render a project another window already owns — two sets of terminals for one worktree,
 * two publishers of its runtime graph, and a PTY owner decided by whichever window asked last. Main
 * answers from the window's own binding; this applies that answer.
 *
 * Only the active pointers are cleared. The per-worktree tabs and layouts stay, so when the user
 * picks a project here through the launcher — which claims it properly — its terminals are already
 * loaded rather than rebuilt from nothing.
 *
 * The window that *does* restore the saved session claims it here. Nothing else does: main answers
 * the first window with "restore what you had" and never learns which worktree that was, so the
 * registry held no binding for it and reported the project as free. A second window could then claim
 * it legitimately and land on the same worktree — one terminal tab, one PTY, two windows — which is
 * the topology the one-window-per-worktree rule exists to prevent. Refused means another window got
 * there first, and then this one starts on the launcher like any other unbound window.
 */
export async function applyWindowStartupBinding<
  T extends { activeWorktreeId?: string | null; activeRepoId?: string | null }
>(session: T): Promise<T> {
  let startup: { worktreeId: string | null; restoreSession: boolean }
  try {
    startup = await window.api.ui.getStartupBinding()
  } catch (err) {
    // Why restoring on failure: a window with nothing on screen is a worse answer than a window
    // showing the project it showed last, and an older main process has no such handler at all.
    console.warn('Failed to read this window startup binding; restoring the saved session:', err)
    return session
  }
  if (!startup.restoreSession) {
    return { ...session, activeWorktreeId: null, activeRepoId: null, activeTabId: null }
  }
  if (startup.worktreeId) {
    // Already bound, which is how main answers a window that owns a project — including one whose
    // renderer was just replaced by a reload. The claim is the binding that produced this answer.
    return { ...session, activeWorktreeId: startup.worktreeId }
  }
  const worktreeId = session.activeWorktreeId
  const repoId = session.activeRepoId
  if (!worktreeId || !repoId) {
    return session
  }
  try {
    const claim = await window.api.ui.claimWorkspace({ repoId, worktreeId })
    if (claim.outcome === 'owned-by-another-window') {
      return { ...session, activeWorktreeId: null, activeRepoId: null, activeTabId: null }
    }
  } catch (err) {
    // Same reasoning as above: an unreachable claim should not cost the user the project they had.
    // The window is no worse off than before this claim existed.
    console.warn('Failed to claim the restored workspace for this window:', err)
  }
  return session
}
