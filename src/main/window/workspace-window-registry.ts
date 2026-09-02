/**
 * Which project Workspace each application window owns.
 *
 * Orca's session state is keyed by worktree, and the scope-merge that lets one writer publish
 * without erasing another (`shared/workspace-session-owner-scope.ts`) arbitrates between writers
 * that own *different* worktrees. Two windows claiming the same worktree are two writers of the
 * same keys, which that merge cannot separate — and the terminal router, which resolves a pane to
 * a worktree, would have no single destination either. So the ownership rule is:
 *
 *   a worktree is bound to at most one window at a time.
 *
 * Requesting a worktree that another window already holds is therefore a focus request, not a
 * second binding. Different worktrees of the same repository stay independent, which is the case
 * this whole feature exists for.
 *
 * Window identity is a minted opaque id, never the array position, the creation order, the title,
 * the project path, the BrowserWindow id or the renderer's webContents id. The last two are real
 * but ephemeral — a renderer is replaced on reload and crash recovery — so they are recorded as
 * *current* attributes of a window rather than as its name.
 */
import type { WorkspaceWindowStartup } from '../../shared/workspace-window-claim'

export type WorkspaceWindowId = string

export type WorkspaceWindowBinding = {
  repoId: string
  worktreeId: string
}

export type WorkspaceWindowRecord = {
  windowId: WorkspaceWindowId
  browserWindowId: number
  rendererWebContentsId: number
  /** Mint order, so "the first window" stays well defined as windows come and go. */
  sequence: number
  /** Null while the window is UNBOUND — showing the launcher, owning no project. */
  binding: WorkspaceWindowBinding | null
}

export type ClaimWorkspaceResult =
  | { outcome: 'claimed' }
  | { outcome: 'already-owned-by-this-window' }
  | { outcome: 'owned-by-another-window'; ownerWindowId: WorkspaceWindowId }
  | { outcome: 'unknown-window' }

const recordsByWindowId = new Map<WorkspaceWindowId, WorkspaceWindowRecord>()
let nextWindowSequence = 1

/**
 * Mint an id that is unique for this process run.
 *
 * Deliberately not derived from anything the window shows: a durable id built from a project path
 * changes meaning when the project moves, and one built from a counter alone collides across runs
 * once these records are persisted. Persistence (W6) will carry the minted id, not re-derive it.
 */
function mintWorkspaceWindow(): { windowId: WorkspaceWindowId; sequence: number } {
  const sequence = nextWindowSequence
  nextWindowSequence += 1
  return { windowId: `window-${sequence}`, sequence }
}

export function registerWorkspaceWindow(attributes: {
  browserWindowId: number
  rendererWebContentsId: number
  windowId?: WorkspaceWindowId
}): WorkspaceWindowRecord {
  const minted = attributes.windowId ? null : mintWorkspaceWindow()
  const windowId = attributes.windowId ?? minted!.windowId
  const existing = recordsByWindowId.get(windowId)
  const record: WorkspaceWindowRecord = {
    windowId,
    browserWindowId: attributes.browserWindowId,
    rendererWebContentsId: attributes.rendererWebContentsId,
    // Why preserved on re-register: a reload replaces the renderer, not the window, and a window
    // that became "first" by being registered again would start restoring another window's project.
    sequence: existing?.sequence ?? minted?.sequence ?? nextWindowSequence++,
    binding: existing?.binding ?? null
  }
  recordsByWindowId.set(windowId, record)
  return record
}

/**
 * Record the renderer a window is currently driven by.
 *
 * A reload or crash recovery replaces the webContents while the window and its project binding
 * survive, so this rebinds the mapping instead of creating a second record.
 */
export function setWorkspaceWindowRenderer(
  windowId: WorkspaceWindowId,
  rendererWebContentsId: number
): void {
  const record = recordsByWindowId.get(windowId)
  if (record) {
    record.rendererWebContentsId = rendererWebContentsId
  }
}

export function unregisterWorkspaceWindow(windowId: WorkspaceWindowId): void {
  recordsByWindowId.delete(windowId)
}

export function getWorkspaceWindow(windowId: WorkspaceWindowId): WorkspaceWindowRecord | null {
  return recordsByWindowId.get(windowId) ?? null
}

export function getWorkspaceWindowForRenderer(
  rendererWebContentsId: number
): WorkspaceWindowRecord | null {
  for (const record of recordsByWindowId.values()) {
    if (record.rendererWebContentsId === rendererWebContentsId) {
      return record
    }
  }
  return null
}

/** The window that owns `worktreeId`, or null when no window holds it. */
export function getWorkspaceWindowForWorktree(worktreeId: string): WorkspaceWindowRecord | null {
  for (const record of recordsByWindowId.values()) {
    if (record.binding?.worktreeId === worktreeId) {
      return record
    }
  }
  return null
}

export function listWorkspaceWindows(): WorkspaceWindowRecord[] {
  return [...recordsByWindowId.values()]
}

/**
 * Bind a workspace to a window, refusing a worktree another window already owns.
 *
 * Refusing rather than transferring is the safe direction: a transfer would leave the previous
 * owner rendering a project it no longer speaks for, still holding its panes and terminals, and
 * still publishing session writes scoped to worktrees that are no longer its own.
 */
export function claimWorkspaceForWindow(
  windowId: WorkspaceWindowId,
  binding: WorkspaceWindowBinding
): ClaimWorkspaceResult {
  const record = recordsByWindowId.get(windowId)
  if (!record) {
    return { outcome: 'unknown-window' }
  }
  const owner = getWorkspaceWindowForWorktree(binding.worktreeId)
  if (owner && owner.windowId !== windowId) {
    return { outcome: 'owned-by-another-window', ownerWindowId: owner.windowId }
  }
  if (record.binding?.worktreeId === binding.worktreeId) {
    return { outcome: 'already-owned-by-this-window' }
  }
  record.binding = binding
  return { outcome: 'claimed' }
}

/** Release a window's workspace, returning it to the UNBOUND state. */
export function releaseWorkspaceForWindow(windowId: WorkspaceWindowId): void {
  const record = recordsByWindowId.get(windowId)
  if (record) {
    record.binding = null
  }
}

/**
 * The worktrees a window speaks for, for a scoped session write.
 *
 * An unbound window owns nothing, and that is not the same as owning everything: publishing an
 * unscoped write from a window with no project is how a launcher-only renderer would erase the
 * projects every other window is holding.
 */
export function getOwnedWorktreeIds(windowId: WorkspaceWindowId): string[] {
  const binding = recordsByWindowId.get(windowId)?.binding
  return binding ? [binding.worktreeId] : []
}

/**
 * What a window should show when its renderer finishes loading.
 *
 * The saved session names one active worktree for the whole profile, so restoring it in every window
 * would put the same project in all of them: two sets of terminals for one worktree, two publishers
 * of one worktree's runtime graph, and a PTY owner that depends on which window asked last. The
 * window's own binding is the source of truth instead.
 *
 * - Bound (it already owns a project, or a reload replaced its renderer) → restore that project.
 * - Unbound and first → restore the saved session, which is the single-window behaviour unchanged.
 * - Unbound and not first → the launcher, which claims properly when the user picks something.
 */
export function resolveWorkspaceWindowStartup(
  rendererWebContentsId: number
): WorkspaceWindowStartup {
  const record = getWorkspaceWindowForRenderer(rendererWebContentsId)
  if (!record) {
    // An unrecognised renderer is not a window we can speak for; leave the saved session alone
    // rather than blanking a window that may be the only one there is.
    return { worktreeId: null, restoreSession: true }
  }
  if (record.binding) {
    return { worktreeId: record.binding.worktreeId, restoreSession: true }
  }
  const isFirst = [...recordsByWindowId.values()].every(
    (candidate) => candidate.sequence >= record.sequence
  )
  return { worktreeId: null, restoreSession: isFirst }
}

export function resetWorkspaceWindowRegistryForTest(): void {
  recordsByWindowId.clear()
  nextWindowSequence = 1
}
