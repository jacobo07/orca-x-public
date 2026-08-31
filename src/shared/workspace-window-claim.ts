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
