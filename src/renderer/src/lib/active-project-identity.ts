import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'

export type ActiveProjectIdentity = {
  repoId: string
  displayName: string
}

type RepoIdentity = {
  id: string
  displayName: string
}

/**
 * Which project the workbench is currently showing.
 *
 * `activeRepoId` is the answer whenever it is set. The worktree fallback exists because activation
 * order is not guaranteed: a workspace can be active for a frame before the repo pointer catches up,
 * and a title that blanks on every project switch reads as a bug.
 *
 * Returns null rather than inventing a name when the project cannot be identified — an honest
 * absence, since the wrong project name in the chrome is worse than none.
 */
export function resolveActiveProjectIdentity(args: {
  activeRepoId: string | null | undefined
  activeWorktreeId: string | null | undefined
  repos: readonly RepoIdentity[]
}): ActiveProjectIdentity | null {
  const repoId = args.activeRepoId ?? repoIdFromWorkspaceKey(args.activeWorktreeId)
  if (!repoId) {
    return null
  }
  const repo = args.repos.find((candidate) => candidate.id === repoId)
  if (!repo?.displayName) {
    return null
  }
  return { repoId, displayName: repo.displayName }
}

function repoIdFromWorkspaceKey(activeWorktreeId: string | null | undefined): string | null {
  if (!activeWorktreeId) {
    return null
  }
  // Why parse first: a folder workspace key carries no repo id, and reading one out of it by
  // string shape would attribute the workspace to whatever the prefix happened to look like.
  const scope = parseWorkspaceKey(activeWorktreeId)
  if (scope && scope.type !== 'worktree') {
    return null
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : activeWorktreeId
  return getRepoIdFromWorktreeId(worktreeId) || null
}
