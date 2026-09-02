/**
 * A window asking to own a workspace, and what it is told.
 *
 * A worktree binds to at most one window: session state is keyed by worktree, so two windows
 * publishing the same keys are two writers the scope-merge cannot separate. Requesting one another
 * window already holds is therefore answered with `owned-by-another-window` and that window is
 * raised, rather than being quietly allowed and losing one of the two sessions later.
 */
export type WorkspaceWindowClaimRequest = {
  repoId: string
  worktreeId: string
}

export type WorkspaceWindowClaimOutcome =
  /** This window now owns the workspace. */
  | 'claimed'
  /** This window already owned it; nothing changed. */
  | 'already-owned'
  /** Another window owns it and has been raised; this window must not open it. */
  | 'owned-by-another-window'
  /** The sender is not a registered application window, so it can own nothing. */
  | 'unknown-window'

export type WorkspaceWindowClaimResult = {
  outcome: WorkspaceWindowClaimOutcome
}

/**
 * What a window should show once its renderer has loaded.
 *
 * The saved session names one active worktree for the whole profile, so a second window that
 * restored it would render a project another window already owns. Main answers from the window's own
 * binding instead of from the shared session.
 */
export type WorkspaceWindowStartup = {
  /** The project this window already owns, or null when it owns none. */
  worktreeId: string | null
  /** False for a window that must start on the launcher instead of the saved session. */
  restoreSession: boolean
}
