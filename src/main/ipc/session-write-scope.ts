import type { WorkspaceSessionWriteScope } from '../../shared/workspace-session-owner-scope'
import {
  getOwnedWorktreeIds,
  getWorkspaceWindowForRenderer,
  listWorkspaceWindows
} from '../window/workspace-window-registry'

/**
 * The worktrees a session write is allowed to speak for.
 *
 * The renderer publishes its whole store as one snapshot, so with two windows the last writer wins
 * and the second window erases the first window's tabs — silently, and durably. The scope-merge in
 * `shared/workspace-session-owner-scope.ts` exists to bound that blast radius; this is what finally
 * reaches it.
 *
 * The scope is derived in main from the sending window's claim, never taken from the wire. A
 * renderer that named its own scope could name someone else's worktrees, which is the erasure this
 * prevents, and deriving it needs no new wire field, so a mixed-version client cannot be left
 * writing unscoped.
 *
 * With a single window the scope is deliberately absent, which the merge reads as whole-workspace
 * authority. That is the shipped behaviour: one window legitimately holds the state of every
 * project it has visited, and scoping it to the one project it currently shows would stop the rest
 * from ever being written again.
 */
export function resolveSessionWriteScope(senderWebContentsId: number): WorkspaceSessionWriteScope {
  if (listWorkspaceWindows().length <= 1) {
    return {}
  }
  const window = getWorkspaceWindowForRenderer(senderWebContentsId)
  if (!window) {
    // An unrecognised sender speaks for nothing. Owning an empty set is safe: the merge retains
    // every entry the writer does not own, so the write becomes a no-op rather than an erasure.
    return { ownedWorktreeIds: [] }
  }
  return { ownedWorktreeIds: getOwnedWorktreeIds(window.windowId) }
}
