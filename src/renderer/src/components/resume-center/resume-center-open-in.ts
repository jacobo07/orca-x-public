import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { DeskWorkspaceIdentity } from '../../../../shared/desk-continuity-projection'

export type ResumeCenterOpenInTarget = { worktreePath: string; connectionId: string | null }

/** What the sidebar's "Open in" receives for this row, or null when no app can open it from here. */
export function resumeCenterOpenInTarget(row: {
  hostId: string
  identity: DeskWorkspaceIdentity
}): ResumeCenterOpenInTarget | null {
  if (row.identity.kind !== 'known' || !row.identity.path) {
    return null
  }
  const host = parseExecutionHostId(row.hostId)
  if (host?.kind === 'local') {
    return { worktreePath: row.identity.path, connectionId: null }
  }
  if (host?.kind === 'ssh') {
    return { worktreePath: row.identity.path, connectionId: host.targetId }
  }
  // Why: a runtime path names a remote environment; with no connection it would open locally.
  return null
}
