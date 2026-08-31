import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '@/store'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'

export type OpenProjectInWorkbenchOutcome =
  /** Activated a workspace that already had a terminal. */
  | 'opened'
  /** Activated a workspace and started a terminal in it. */
  | 'opened-with-terminal'
  /** The project genuinely has no workspace, confirmed by asking its host. */
  | 'no-workspace'
  /** The host could not be asked which workspaces the project has. */
  | 'workspace-lookup-failed'
  /** The store declined to activate the workspace. */
  | 'activation-refused'
  /** Another window already owns this workspace and has been raised instead. */
  | 'opened-in-other-window'

/**
 * Which of a project's workspaces "open the project" means.
 *
 * Most recently visited wins, so reopening a project returns to the branch that was being worked
 * on rather than whichever workspace happens to sort first. A project that has never been opened
 * has no visit history, and then the first workspace is the only sensible answer.
 */
export function pickProjectWorkspaceToOpen(
  worktrees: readonly { id: string }[] | null | undefined,
  lastVisitedAtByWorktreeId: Readonly<Record<string, number>> | null | undefined
): string | null {
  if (!worktrees || worktrees.length === 0) {
    return null
  }
  let best: { id: string; visitedAt: number } | null = null
  for (const worktree of worktrees) {
    const visitedAt = lastVisitedAtByWorktreeId?.[worktree.id]
    if (typeof visitedAt !== 'number' || Number.isNaN(visitedAt)) {
      continue
    }
    if (!best || visitedAt > best.visitedAt) {
      best = { id: worktree.id, visitedAt }
    }
  }
  return best?.id ?? worktrees[0].id
}

/**
 * Ask the project's host which workspaces it has, then pick one.
 *
 * `reachable` is carried separately from the id on purpose: a host that could not be asked — a moved
 * folder, a down SSH target — is not a project without workspaces, and reporting the latter would
 * send the user looking for the wrong problem. It is a field rather than a sentinel id because
 * every sentinel string is also a legal worktree id.
 */
async function loadProjectWorkspaces(
  repoId: string
): Promise<{ workspaceId: string | null; reachable: boolean }> {
  const store = useAppStore.getState()
  const repo = store.repos.find((candidate) => candidate.id === repoId)
  try {
    await store.fetchWorktrees(
      repoId,
      repo ? { executionHostId: getRepoExecutionHostId(repo) } : undefined
    )
  } catch {
    return { workspaceId: null, reachable: false }
  }
  const loaded = useAppStore.getState()
  return {
    workspaceId: pickProjectWorkspaceToOpen(
      loaded.worktreesByRepo[repoId],
      loaded.lastVisitedAtByWorktreeId
    ),
    reachable: true
  }
}

/**
 * Open a project in the main window: activate its workspace and leave a terminal in front of the
 * user, in the workbench itself rather than the floating panel or a second window.
 *
 * A terminal is started only when the workspace has none. Spawning one unconditionally would add a
 * shell every time a project is reopened, and a project left with three terminals should come back
 * with those three, not four.
 */
export async function openProjectInWorkbench(
  repoId: string
): Promise<OpenProjectInWorkbenchOutcome> {
  const store = useAppStore.getState()
  let workspaceId = pickProjectWorkspaceToOpen(
    store.worktreesByRepo[repoId],
    store.lastVisitedAtByWorktreeId
  )
  if (!workspaceId) {
    // Startup loads workspaces only for the projects the saved session names, so a project that has
    // never been opened here has none — not zero, unknown. Reporting "no workspace" from an unasked
    // question makes exactly the projects this list exists to reach the ones that cannot be opened.
    const lookup = await loadProjectWorkspaces(repoId)
    if (!lookup.reachable) {
      return 'workspace-lookup-failed'
    }
    if (!lookup.workspaceId) {
      return 'no-workspace'
    }
    workspaceId = lookup.workspaceId
  }
  // Why claim before activating: a worktree belongs to one window at a time, because the session
  // state both windows would publish is keyed by worktree and the merge cannot separate two writers
  // of the same keys. Main raises the owning window, so the project still ends up in front of the
  // user — in the window that already has it.
  const claim = await window.api.ui.claimWorkspace({ repoId, worktreeId: workspaceId })
  if (claim.outcome === 'owned-by-another-window') {
    return 'opened-in-other-window'
  }
  // Why gated on the result: activation reports whether the workspace could be entered, and
  // navigating past a refusal would show an empty workbench that reads as a broken open.
  if (!store.setActiveWorktree(workspaceId)) {
    return 'activation-refused'
  }
  store.setActiveView('terminal')

  // Re-read: activation is what makes this workspace the active one, and the terminal action below
  // resolves its target from that.
  const activated = useAppStore.getState()
  const existingTerminals = activated.tabsByWorktree[workspaceId] ?? []
  if (existingTerminals.length > 0) {
    // A workspace showing an editor keeps rendering it otherwise, so the terminals it already has
    // would stay invisible behind the file.
    activated.setActiveTabType('terminal')
    const activeTabId = activated.activeTabIdByWorktree[workspaceId]
    if (activeTabId) {
      focusTerminalTabSurface(activeTabId)
    }
    return 'opened'
  }

  // The store's own action rather than a local createTab: it resolves remote and web-runtime
  // workspaces to the right host, which a direct tab creation would silently get wrong over SSH.
  await activated.openNewTerminalTabInActiveWorkspace(
    activated.activeGroupIdByWorktree[workspaceId] ?? undefined
  )
  const opened = useAppStore.getState()
  const createdTabId = opened.activeTabIdByWorktree[workspaceId]
  if (createdTabId) {
    focusTerminalTabSurface(createdTabId)
  }
  return 'opened-with-terminal'
}
