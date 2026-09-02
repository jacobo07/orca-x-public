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
 */
export async function applyWindowStartupBinding<T extends { activeWorktreeId?: string | null }>(
  session: T
): Promise<T> {
  let startup: { worktreeId: string | null; restoreSession: boolean }
  try {
    startup = await window.api.ui.getStartupBinding()
  } catch (err) {
    // Why restoring on failure: a window with nothing on screen is a worse answer than a window
    // showing the project it showed last, and an older main process has no such handler at all.
    console.warn('Failed to read this window startup binding; restoring the saved session:', err)
    return session
  }
  if (startup.restoreSession) {
    return startup.worktreeId ? { ...session, activeWorktreeId: startup.worktreeId } : session
  }
  return { ...session, activeWorktreeId: null, activeRepoId: null, activeTabId: null }
}
