import { isRuntimeOwnedSshTargetId, type ExecutionHostScope } from '../../../shared/execution-host'
import {
  getNewWorkspaceDialogEligibleRepos,
  resolveNewWorkspaceDialogGitRepoId,
  resolveNewWorkspaceDialogRepoId
} from '../../../shared/new-workspace-dialog-repo'
import { getProjectIdentityKey } from '../../../shared/project-host-setup-projection'
import { buildRootIdentityEligibility } from '../../../shared/project-root-identity-key'
import type { Repo } from '../../../shared/repo-types'

export function getComposerEligibleRepos(repos: readonly Repo[]): Repo[] {
  return getNewWorkspaceDialogEligibleRepos(repos)
}

/**
 * After creating a per-workspace-env, its runtime-owned SSH repo becomes the active repo — but it's
 * excluded from the composer's eligible repos (hidden plumbing). Without this, the composer can't
 * match `activeRepoId`, so it falls back to the first eligible repo (a different project). Map the
 * active runtime repo to its local sibling in the same project so the composer stays on that project.
 */
export function resolveComposerActiveRepoId(
  repos: readonly Repo[],
  eligibleRepos: readonly Repo[],
  activeRepoId: string | null | undefined
): string | null {
  if (!activeRepoId) {
    return activeRepoId ?? null
  }
  const activeRepo = repos.find((repo) => repo.id === activeRepoId)
  if (!activeRepo || !isRuntimeOwnedSshTargetId(activeRepo.connectionId)) {
    return activeRepoId
  }
  // Why: eligibleRepos is a filtered subset; root identity is judged over the full repo list.
  const { eligibleRepoIds } = buildRootIdentityEligibility(repos)
  const projectKey = getProjectIdentityKey(activeRepo, eligibleRepoIds)
  const sibling = eligibleRepos.find(
    (repo) => getProjectIdentityKey(repo, eligibleRepoIds) === projectKey
  )
  return sibling?.id ?? activeRepoId
}

export function resolveComposerRepoId({
  eligibleRepos,
  draftRepoId,
  initialRepoId,
  activeRepoId,
  focusedHostScope
}: {
  eligibleRepos: readonly Repo[]
  draftRepoId?: string | null
  initialRepoId?: string | null
  activeRepoId?: string | null
  focusedHostScope?: ExecutionHostScope | null
}): string {
  return resolveNewWorkspaceDialogRepoId({
    eligibleRepos,
    draftRepoId,
    initialRepoId,
    activeRepoId,
    focusedHostScope
  })
}

export function resolveComposerGitRepoId(args: {
  eligibleRepos: readonly Repo[]
  draftRepoId?: string | null
  initialRepoId?: string | null
  activeRepoId?: string | null
  focusedHostScope?: ExecutionHostScope | null
}): string | null {
  return resolveNewWorkspaceDialogGitRepoId(args)
}
