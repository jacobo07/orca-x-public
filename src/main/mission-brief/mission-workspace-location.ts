import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import type { DeskReadStore } from '../continuity/desk-read'

export type MissionWorkspaceLocation =
  | { kind: 'local'; path: string }
  | { kind: 'remote' }
  | { kind: 'unknown' }

/**
 * Where a desk workspace's mission records live. Only a workspace whose owner says it is local is
 * read: a remote repo's path names a directory on another machine, and reading the same path here
 * would describe a different (or no) project.
 */
export function locateMissionWorkspace(
  store: DeskReadStore,
  key: string
): MissionWorkspaceLocation {
  if (key.startsWith('folder:')) {
    const folder = store.getFolderWorkspace(key.slice('folder:'.length))
    if (!folder) {
      return { kind: 'unknown' }
    }
    return getRepoExecutionHostId(folder) === LOCAL_EXECUTION_HOST_ID
      ? { kind: 'local', path: folder.folderPath }
      : { kind: 'remote' }
  }
  const worktreeId = key.startsWith('worktree:') ? key.slice('worktree:'.length) : key
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  const repo = parsed ? store.getRepo(parsed.repoId) : undefined
  if (!parsed || !repo) {
    return { kind: 'unknown' }
  }
  return getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
    ? { kind: 'local', path: parsed.worktreePath }
    : { kind: 'remote' }
}
