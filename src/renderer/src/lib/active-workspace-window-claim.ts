/**
 * Keep the window's authoritative workspace binding on the project the window is showing.
 *
 * A worktree binds to at most one window (`src/main/window/workspace-window-registry.ts`). Entering a
 * project claims it — the launcher claims before it navigates, and a window restoring a saved session
 * claims what it restores — but switching project *inside* a window used to claim nothing. The
 * binding stayed on whatever was claimed last, so the worktree now on screen read as unowned: a
 * second window could take it, and session writes scoped by the binding went to the project the user
 * had left.
 *
 * Called from the store writer rather than from each navigation surface. `setActiveWorktree` is the
 * single writer to the active workspace, so every path reaches this one — sidebar, Explorer, deep
 * links, the palette, automations, mobile-initiated opens, and any surface added later. Gating the
 * ~30 synchronous callers instead would leave the next one to remember.
 *
 * The claim is asynchronous and the writer is not, so the switch commits first and is undone if the
 * destination turns out to belong to another window. That ordering is a deliberate trade: a refused
 * claim mutates nothing, so the window still owns what it came from and the revert target is always
 * valid. Making the check synchronous instead would need the renderer to hold a live copy of every
 * window's binding, which nothing publishes today.
 *
 * State arrives through the caller instead of being imported: this runs inside a store slice, and
 * reaching back into the store root from one would close an import cycle.
 */

export type ActiveWorkspaceClaim = {
  /** The project now on screen, and the repository it belongs to. */
  repoId: string | null
  worktreeId: string | null
  /** Where to put the window back if the project belongs to another window. */
  previousWorktreeId: string | null
  /** Read at the end, to tell a settled switch from one that has already been replaced. */
  currentWorktreeId: () => string | null
  revertTo: (worktreeId: string | null) => void
}

/**
 * Which switch is current. A claim answers after its switch may already have been replaced, and
 * applying a stale refusal would drag the window back off a project it legitimately holds.
 */
let currentSwitchGeneration = 0

export function resetActiveWorkspaceClaimForTest(): void {
  currentSwitchGeneration = 0
}

export function claimActiveWorkspaceForWindow(claim: ActiveWorkspaceClaim): void {
  const { repoId, worktreeId, previousWorktreeId, currentWorktreeId, revertTo } = claim
  // No repo means this is not a project the registry can bind: a cleared workspace, or a standalone
  // surface such as the floating terminal, which has a tab bucket but no worktree to own. Claiming
  // one of those would *release* the real project, turning a stale binding into a lost one.
  if (!worktreeId || !repoId) {
    return
  }
  const generation = ++currentSwitchGeneration
  void (async () => {
    let outcome: string
    try {
      outcome = (await window.api.ui.claimWorkspace({ repoId, worktreeId })).outcome
    } catch (err) {
      // The binding stays where it was, which is the same state as before this claim existed. Taking
      // the project off screen because an IPC failed would be a worse answer than a stale record.
      console.warn('Failed to claim the active workspace for this window:', err)
      return
    }
    if (generation !== currentSwitchGeneration || outcome !== 'owned-by-another-window') {
      return
    }
    // Main has already revealed the owning window — the claim handler does that itself, so the user
    // is looking at the project they asked for, in the window that holds it. All that is left is to
    // put this window back where it was.
    if (currentWorktreeId() !== worktreeId) {
      return
    }
    revertTo(previousWorktreeId)
  })()
}
