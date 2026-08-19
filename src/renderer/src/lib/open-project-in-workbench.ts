import { useAppStore } from '@/store'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'

export type OpenProjectInWorkbenchOutcome =
  /** Activated a workspace that already had a terminal. */
  | 'opened'
  /** Activated a workspace and started a terminal in it. */
  | 'opened-with-terminal'
  /** The project has no workspace to open yet — usually its scan has not finished. */
  | 'no-workspace'
  /** The store declined to activate the workspace. */
  | 'activation-refused'

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
  const workspaceId = pickProjectWorkspaceToOpen(
    store.worktreesByRepo[repoId],
    store.lastVisitedAtByWorktreeId
  )
  if (!workspaceId) {
    return 'no-workspace'
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
