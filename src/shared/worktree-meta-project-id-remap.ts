import type { WorktreeMeta } from './worktree/meta-types'

/**
 * Moves each worktree's `projectId` with its project when a project id was replaced. Returns the
 * same record when nothing moved. Without this a worktree keeps naming a project id that no
 * longer exists until a discovery pass happens to repair it, and a repo that is never
 * rediscovered stays stranded.
 */
export function remapWorktreeMetaProjectIds(
  worktreeMeta: Record<string, WorktreeMeta>,
  remappedProjectIds: ReadonlyMap<string, string>
): Record<string, WorktreeMeta> {
  if (remappedProjectIds.size === 0) {
    return worktreeMeta
  }
  let remapped: Record<string, WorktreeMeta> | null = null
  for (const [worktreeId, meta] of Object.entries(worktreeMeta)) {
    const projectId = meta.projectId ? remappedProjectIds.get(meta.projectId) : undefined
    if (projectId) {
      remapped ??= { ...worktreeMeta }
      remapped[worktreeId] = { ...meta, projectId }
    }
  }
  return remapped ?? worktreeMeta
}
