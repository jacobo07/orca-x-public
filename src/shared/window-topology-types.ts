/**
 * The persisted shape of the workspace-window set.
 *
 * Shared only because it is written into the profile's UI state, which is a shared type. The rules
 * that govern it — what may be published, what an unreadable value means, how a restore resolves a
 * worktree two windows both claim — live with the model in `main/window/window-topology.ts`.
 */
export type PersistedWindowTopologyBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type PersistedWindowTopologyEntry = {
  /** The minted window id, carried rather than re-derived: a path-derived id changes meaning when the project moves. */
  windowId: string
  /** Mint order, so "the first window" survives the restart with the meaning it had. */
  sequence: number
  /** Null for a window that was showing the launcher — a real window owning no project. */
  binding: { repoId: string; worktreeId: string } | null
  bounds: PersistedWindowTopologyBounds | null
  maximized: boolean
}
