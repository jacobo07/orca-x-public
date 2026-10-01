import { getRepoExecutionHostId } from '../shared/execution-host'
import {
  buildRootIdentityEligibility,
  ROOT_PROJECT_ID_PREFIX
} from '../shared/project-root-identity-key'
import type { Repo } from '../shared/repo-types'
import { probeGitRootIdentity } from './repo-git-root-identity'
import type { Store } from './persistence'

export type RootIdentityRefusalCode =
  | 'root_identity_unavailable'
  | 'root_identity_absent'
  | 'root_identity_mismatch'
  | 'root_identity_collision'

export class RootIdentityRefusal extends Error {
  readonly code: RootIdentityRefusalCode

  constructor(code: RootIdentityRefusalCode, sentence: string) {
    super(`${code}: ${sentence}`)
    this.name = 'RootIdentityRefusal'
    this.code = code
  }
}

type RootLinkStore = Pick<Store, 'getRepos' | 'updateRepo'>

/**
 * A `git-root:` id is proven on the target host, never inferred: the folder's own first commit
 * must equal the id. Anything else refuses, and the caller removes the repo it just created.
 */
export async function linkRepoToRootProject(
  store: RootLinkStore,
  repo: Repo,
  projectId: string
): Promise<void> {
  if (!projectId.startsWith(ROOT_PROJECT_ID_PREFIX)) {
    return
  }
  const requestedRoot = projectId.slice(ROOT_PROJECT_ID_PREFIX.length)
  if (repo.kind === 'folder') {
    throw new RootIdentityRefusal(
      'root_identity_absent',
      'A folder workspace has no history, so it cannot be a replica of this project.'
    )
  }
  const probe = await probeGitRootIdentity(repo.path, repo.connectionId)
  if (probe.status === 'unavailable') {
    throw new RootIdentityRefusal(
      'root_identity_unavailable',
      'The history of this folder could not be read on its host. Try again once the host is reachable.'
    )
  }
  if (probe.status === 'settled-none') {
    throw new RootIdentityRefusal(
      'root_identity_absent',
      'This folder has no usable first commit (no commits yet, or a shallow clone).'
    )
  }
  const { identity } = probe
  if (identity.rootCommit !== requestedRoot) {
    throw new RootIdentityRefusal(
      'root_identity_mismatch',
      "This folder's history does not start with the project's first commit."
    )
  }
  const probed: Repo = { ...repo, gitRootIdentity: identity }
  // Why: the new repo's remote probe may be pending; a remote-less project cannot be set up from
  // a folder that already has a remote, and a pending one is judged as the project it asks to join.
  const context = [
    ...store.getRepos().filter((entry) => entry.id !== repo.id),
    { ...probed, gitRemoteIdentity: null }
  ]
  const hostId = getRepoExecutionHostId(repo)
  const duplicate = buildRootIdentityEligibility(context).sameHostDuplicates.some(
    (group) =>
      group.rootCommit === identity.rootCommit &&
      group.hostId === hostId &&
      group.setupIds.includes(repo.id)
  )
  if (duplicate) {
    throw new RootIdentityRefusal(
      'root_identity_collision',
      'This host already holds a different repository with the same first commit.'
    )
  }
  const updated = store.updateRepo(repo.id, {
    gitRootIdentity: identity,
    gitRootIdentityNoneReason: undefined
  })
  if (!updated) {
    throw new Error(`Project setup repo disappeared before it could be linked: ${repo.id}`)
  }
}
