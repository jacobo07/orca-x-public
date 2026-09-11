/**
 * Which terminal one window's taskbar thumbnail is about.
 *
 * The shell asks a *window* for a picture, so the subject has to be resolved from the window
 * outward: window -> the worktree it owns -> that worktree's active tab -> that tab's active pane ->
 * the PTY behind it. Every hop is a different fact, and the reasons they can fail are not the same
 * reason, so they are never collapsed into one empty answer.
 *
 * The profile-global `activeTabId` is deliberately not read. It is a single scalar shared by every
 * window (workspace-window-registry.ts:5-10 explains why session state is keyed by worktree), so
 * with two windows open it holds the last writer's answer — which is the other window's tab about
 * half the time. `activeTabIdByWorktree` is the per-worktree refinement, and because a worktree is
 * bound to at most one window, reading it through this window's binding is window-local by
 * construction. Falling back to the global when the per-worktree entry is missing would reintroduce
 * exactly the cross-window contamination the binding exists to prevent.
 *
 * Never falls back to a sibling pane, a sibling tab, or the most recently active terminal. A
 * thumbnail showing the wrong terminal is worse than a thumbnail showing that there is nothing to
 * show, because the user cannot tell it is wrong.
 */
import type { WorkspaceWindowBinding } from './workspace-window-registry'

export type TaskbarPreviewSubject =
  | {
      status: 'available'
      ptyId: string
      worktreeId: string
      tabId: string
      leafId: string
    }
  | { status: 'unavailable'; reason: TaskbarPreviewUnavailableReason }

/**
 * Why five reasons rather than one: they need different representations. A window on the launcher
 * has no project yet, a tab whose pane never spawned is still starting, and a PTY that has exited
 * is finished — and a single blank frame would tell the user the same nothing about all three.
 */
export type TaskbarPreviewUnavailableReason =
  /** The window is UNBOUND — showing the launcher, owning no project. */
  | 'no-workspace'
  /** The workspace has no active terminal tab recorded for this window's worktree. */
  | 'no-tab'
  /** The tab has no active pane (no layout recorded, or an empty layout). */
  | 'no-pane'
  /** The pane exists but has not spawned a PTY. */
  | 'no-pty'
  /** The pane names a PTY the runtime no longer has. */
  | 'not-live'

export type TaskbarPreviewSessionView = {
  /** Per-worktree active terminal tab. The only tab authority a single window may read. */
  activeTabIdByWorktree?: Readonly<Record<string, string | null>>
  terminalLayoutsByTabId?: Readonly<
    Record<
      string,
      {
        activeLeafId?: string | null
        ptyIdsByLeafId?: Readonly<Record<string, string>>
      }
    >
  >
}

export function resolveTaskbarPreviewSubject(args: {
  /** Null while the window owns no project. */
  binding: WorkspaceWindowBinding | null
  session: TaskbarPreviewSessionView
  /** The runtime's live PTY index. A PTY absent from it has exited, not merely gone quiet. */
  livePtyIds: ReadonlySet<string>
}): TaskbarPreviewSubject {
  const worktreeId = args.binding?.worktreeId
  if (!worktreeId) {
    return { status: 'unavailable', reason: 'no-workspace' }
  }

  const tabId = args.session.activeTabIdByWorktree?.[worktreeId]
  if (!tabId) {
    return { status: 'unavailable', reason: 'no-tab' }
  }

  const layout = args.session.terminalLayoutsByTabId?.[tabId]
  const leafId = layout?.activeLeafId
  if (!leafId) {
    return { status: 'unavailable', reason: 'no-pane' }
  }

  const ptyId = layout?.ptyIdsByLeafId?.[leafId]
  if (!ptyId) {
    return { status: 'unavailable', reason: 'no-pty' }
  }
  if (!args.livePtyIds.has(ptyId)) {
    return { status: 'unavailable', reason: 'not-live' }
  }

  return { status: 'available', ptyId, worktreeId, tabId, leafId }
}
