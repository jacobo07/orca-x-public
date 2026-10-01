import { getRepoExecutionHostId, type ExecutionHostId } from './execution-host'
// Why type-only: git-root-identity imports node:path, which the renderer bundle must not pull in.
import type { GitRootIdentity } from './git-root-identity'
import type {
  SameHostDuplicateGroup,
  SharesRootWithRemoteGroup
} from './project-identity-collisions'
import {
  getProjectGitRemoteIdentity,
  getProjectIdForProviderIdentity,
  getProjectProviderIdentity
} from './project-provider-identity'
import type { Repo } from './repo-types'

export type RootIdentityEligibility = {
  eligibleRepoIds: ReadonlySet<string>
  sameHostDuplicates: SameHostDuplicateGroup[]
  sharesRootWithRemote: SharesRootWithRemoteGroup[]
}

type RootRepo = Pick<
  Repo,
  | 'id'
  | 'kind'
  | 'connectionId'
  | 'executionHostId'
  | 'upstream'
  | 'repoIcon'
  | 'gitRemoteIdentity'
  | 'gitRootIdentity'
>

export const ROOT_PROJECT_ID_PREFIX = 'git-root:'

export function rootIdentityProjectId(rootCommit: string): string {
  return `${ROOT_PROJECT_ID_PREFIX}${rootCommit}`
}

function resolvedRoot(repo: RootRepo): GitRootIdentity | null {
  if (repo.kind === 'folder') {
    return null
  }
  const root = repo.gitRootIdentity
  // Why: null (settled none) and undefined (pending) both mean "no proven root"; neither may group.
  return root && typeof root.rootCommit === 'string' && typeof root.commonDir === 'string'
    ? root
    : null
}

function remoteProjectKey(repo: RootRepo): string | null {
  const provider = getProjectProviderIdentity(repo)
  if (provider) {
    return getProjectIdForProviderIdentity(provider)
  }
  const remote = getProjectGitRemoteIdentity(repo)
  return remote ? `git:${remote.canonicalKey}` : null
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) {
    list.push(value)
  } else {
    map.set(key, [value])
  }
}

/**
 * Which repos of `context` may derive a `git-root:` id. Identity depends on the whole repo
 * set, so a caller that holds only a subset must pass the full list, never the subset.
 */
export function buildRootIdentityEligibility(
  context: readonly RootRepo[]
): RootIdentityEligibility {
  const remoteProjectsByRoot = new Map<string, Set<string>>()
  const candidatesByRoot = new Map<string, RootRepo[]>()
  for (const repo of context) {
    const root = resolvedRoot(repo)
    if (!root) {
      continue
    }
    const remoteKey = remoteProjectKey(repo)
    if (remoteKey) {
      const keys = remoteProjectsByRoot.get(root.rootCommit) ?? new Set<string>()
      keys.add(remoteKey)
      remoteProjectsByRoot.set(root.rootCommit, keys)
      continue
    }
    // Why: a pending remote probe is missing evidence; deriving a root key now would be
    // promoted to a provider key later and could join a fork in the meantime.
    if (repo.gitRemoteIdentity === null) {
      pushTo(candidatesByRoot, root.rootCommit, repo)
    }
  }

  const eligibleRepoIds = new Set<string>()
  const sameHostDuplicates: SameHostDuplicateGroup[] = []
  const sharesRootWithRemote: SharesRootWithRemoteGroup[] = []
  for (const [rootCommit, candidates] of candidatesByRoot) {
    const byHost = new Map<ExecutionHostId, RootRepo[]>()
    for (const repo of candidates) {
      pushTo(byHost, getRepoExecutionHostId(repo), repo)
    }
    const remoteProjects = remoteProjectsByRoot.get(rootCommit)
    for (const [hostId, repos] of byHost) {
      const setupIds = repos.map((repo) => repo.id)
      // Why: a linked worktree added as a repo shares its main repo's commonDir, so one
      // distinct commonDir is one repository; two are unknowably which is the replica.
      const distinctCommonDirs = new Set(repos.map((repo) => resolvedRoot(repo)?.commonDir))
      if (distinctCommonDirs.size > 1) {
        sameHostDuplicates.push({ rootCommit, hostId, setupIds })
      }
      if (remoteProjects) {
        // Why: forks all share the upstream's first commit, so this match is ambiguous by construction.
        sharesRootWithRemote.push({ rootCommit, hostId, setupIds, projectIds: [...remoteProjects] })
      }
      if (distinctCommonDirs.size <= 1 && !remoteProjects) {
        setupIds.forEach((id) => eligibleRepoIds.add(id))
      }
    }
  }
  return { eligibleRepoIds, sameHostDuplicates, sharesRootWithRemote }
}
