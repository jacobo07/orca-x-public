import { getRepoExecutionHostId } from './execution-host'
import {
  projectIdentityCollisionsFromEligibility,
  type ProjectIdentityCollision
} from './project-identity-collisions'
import {
  getProjectGitRemoteIdentity,
  getProjectIdForProviderIdentity,
  getProjectProviderIdentity
} from './project-provider-identity'
import { buildRootIdentityEligibility, rootIdentityProjectId } from './project-root-identity-key'
import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'
import type { WorktreeMeta } from './worktree/meta-types'

type ProjectAccumulator = {
  project: Project
}

export { getProjectIdForProviderIdentity, getProjectProviderIdentity }

export type ProjectHostSetupProjection = {
  projects: readonly Project[]
  setups: readonly ProjectHostSetup[]
  /** Derived on every projection and never persisted; absent from hosts that predate it. */
  identityCollisions?: readonly ProjectIdentityCollision[]
}

/** True when the repo resolves to a GitHub provider identity (via explicit
 *  upstream or a GitHub-sourced avatar icon). Used to scope GitHub-CLI setup
 *  prompts to users who actually have GitHub-backed projects. */
export function isGitHubBackedRepo(
  repo: Pick<Repo, 'upstream' | 'repoIcon' | 'gitRemoteIdentity'>
): boolean {
  return getProjectProviderIdentity(repo) !== null
}

export function hasProjectRemoteIdentity(
  repo: Pick<Repo, 'upstream' | 'repoIcon' | 'gitRemoteIdentity'>
): boolean {
  return getProjectProviderIdentity(repo) !== null || getProjectGitRemoteIdentity(repo) !== null
}

/** True while nothing has settled the repo's remote identity yet: the background
 *  probe has not answered (or could not reach the host), as distinct from the
 *  resolved `null` marker meaning "checked, no usable remote". Provider-neutral —
 *  GitHub repos usually settle through persisted `upstream` instead. */
export function isProjectRemoteIdentityPending(
  repo: Pick<Repo, 'upstream' | 'repoIcon' | 'gitRemoteIdentity'>
): boolean {
  return repo.gitRemoteIdentity === undefined && !hasProjectRemoteIdentity(repo)
}

const HOST_LOCAL_PROJECT_ID_PREFIX = 'repo:'

/**
 * Precedence: github: > git: > git-root:<first commit> > repo:<id>. A git-root: id is only
 * derived for a repo in `eligibleRepoIds`, which is computed over a whole repo set (see
 * buildRootIdentityEligibility), so no argument means the conservative repo: fallback.
 */
export function getProjectIdentityKey(
  repo: Pick<Repo, 'id' | 'upstream' | 'repoIcon' | 'gitRemoteIdentity' | 'gitRootIdentity'>,
  eligibleRepoIds?: ReadonlySet<string>
): string {
  const identity = getProjectProviderIdentity(repo)
  if (identity) {
    return getProjectIdForProviderIdentity(identity)
  }
  const gitRemoteIdentity = getProjectGitRemoteIdentity(repo)
  if (gitRemoteIdentity) {
    return `git:${gitRemoteIdentity.canonicalKey}`
  }
  if (eligibleRepoIds?.has(repo.id) && repo.gitRootIdentity) {
    return rootIdentityProjectId(repo.gitRootIdentity.rootCommit)
  }
  return `${HOST_LOCAL_PROJECT_ID_PREFIX}${repo.id}`
}

/**
 * True for the `repo:<id>` fallback above — a folder project, or a git repo with no
 * remote and no proven first commit. The id is a per-host repo id, so the same project on
 * another host derives a different one and can never be matched there; a git-root: id
 * is matchable across hosts and is deliberately not host-local.
 */
export function isHostLocalProjectId(projectId: string): boolean {
  return projectId.startsWith(HOST_LOCAL_PROJECT_ID_PREFIX)
}

function getProjectId(repo: Repo, eligibleRepoIds: ReadonlySet<string>): string {
  return getProjectIdentityKey(repo, eligibleRepoIds)
}

// Why: `addedAt || now` restamps Date.now() when addedAt is 0 / absent / NaN, so every
// projection looks dirty and reconcileCatalogRows never reuses the project or setup.
function catalogTimestampFromAddedAt(addedAt: number): number {
  return Number.isFinite(addedAt) ? addedAt : 0
}

// Why: 0 / absent / NaN means "the repo predates timestamped catalog rows", not epoch. Keeping
// it out of min()/max() stops one unknown sibling from wiping a real timestamp — and unlike the
// old `|| now` fallback it stays order-independent, so both merge orders agree.
function knownCatalogTimestamp(value: number): number | undefined {
  return Number.isFinite(value) && value !== 0 ? value : undefined
}

/** Oldest of two catalog `createdAt` values, treating 0/NaN on either side as unknown. */
export function mergeCatalogCreatedAt(left: number, right: number): number {
  const known = knownCatalogTimestamp(left)
  const other = knownCatalogTimestamp(right)
  if (known === undefined || other === undefined) {
    return known ?? other ?? 0
  }
  return Math.min(known, other)
}

/** Newest of two catalog `updatedAt` values, treating 0/NaN on either side as unknown. */
export function mergeCatalogUpdatedAt(left: number, right: number): number {
  const known = knownCatalogTimestamp(left)
  const other = knownCatalogTimestamp(right)
  if (known === undefined || other === undefined) {
    return known ?? other ?? 0
  }
  return Math.max(known, other)
}

function createProjectFromRepo(repo: Repo, projectId: string): Project {
  const identity = getProjectProviderIdentity(repo)
  const gitRemoteIdentity = getProjectGitRemoteIdentity(repo)
  const addedAt = catalogTimestampFromAddedAt(repo.addedAt)
  return {
    id: projectId,
    displayName: repo.displayName,
    badgeColor: repo.badgeColor,
    ...(repo.repoIcon !== undefined ? { repoIcon: repo.repoIcon } : {}),
    ...(repo.kind ? { kind: repo.kind } : {}),
    ...(identity ? { providerIdentity: identity } : {}),
    ...(gitRemoteIdentity ? { gitRemoteIdentity } : {}),
    sourceRepoIds: [repo.id],
    createdAt: addedAt,
    updatedAt: addedAt
  }
}

function mergeProjectRepo(project: Project, repo: Repo): Project {
  const sourceRepoIds = project.sourceRepoIds.includes(repo.id)
    ? project.sourceRepoIds
    : [...project.sourceRepoIds, repo.id]
  // Why unknown-aware on both sides: the accumulator itself carries 0 when the first repo of the
  // project had no addedAt, so a plain min() would let repo order decide the project's createdAt.
  const addedAt = catalogTimestampFromAddedAt(repo.addedAt)
  return {
    ...project,
    sourceRepoIds,
    createdAt: mergeCatalogCreatedAt(project.createdAt, addedAt),
    updatedAt: mergeCatalogUpdatedAt(project.updatedAt, addedAt)
  }
}

function createSetupFromRepo(repo: Repo, projectId: string): ProjectHostSetup {
  const hostId = getRepoExecutionHostId(repo)
  const createdAt = catalogTimestampFromAddedAt(repo.addedAt)
  const setupMethod = repo.projectHostSetupMethod ?? 'legacy-repo'
  return {
    id: repo.id,
    projectId,
    hostId,
    repoId: repo.id,
    path: repo.path,
    displayName: repo.displayName,
    ...(repo.kind ? { kind: repo.kind } : {}),
    ...(repo.connectionId !== undefined ? { connectionId: repo.connectionId } : {}),
    ...(repo.executionHostId !== undefined ? { executionHostId: repo.executionHostId } : {}),
    ...(repo.worktreeBasePath ? { worktreeBasePath: repo.worktreeBasePath } : {}),
    ...(repo.hookSettings ? { hookSettings: repo.hookSettings } : {}),
    ...(repo.gitUsername ? { gitUsername: repo.gitUsername } : {}),
    ...(repo.sourceControlAi ? { sourceControlAi: repo.sourceControlAi } : {}),
    setupState: 'ready',
    setupMethod,
    createdAt,
    updatedAt: createdAt
  }
}

/**
 * `identityContext` is the whole repo set identity is judged against: a caller projecting a
 * filtered subset must pass the full list (a git-root: id depends on the repos NOT shown), and
 * `[]` means "no context", i.e. the conservative repo: derivation.
 */
export function projectHostSetupProjectionFromRepos(
  repos: readonly Repo[],
  _now?: number,
  options?: { identityContext?: readonly Repo[] }
): ProjectHostSetupProjection {
  const projectById = new Map<string, ProjectAccumulator>()
  const setups: ProjectHostSetup[] = []
  const eligibility = buildRootIdentityEligibility(options?.identityContext ?? repos)

  for (const repo of repos) {
    const projectId = getProjectId(repo, eligibility.eligibleRepoIds)
    const existing = projectById.get(projectId)
    const project = existing
      ? mergeProjectRepo(existing.project, repo)
      : createProjectFromRepo(repo, projectId)
    const setup = createSetupFromRepo(repo, projectId)
    projectById.set(projectId, {
      project
    })
    setups.push(setup)
  }

  return {
    projects: [...projectById.values()].map((entry) => entry.project),
    setups,
    identityCollisions: projectIdentityCollisionsFromEligibility(eligibility)
  }
}

export function getProjectHostSetupsForProject(
  setups: readonly ProjectHostSetup[],
  projectId: string
): readonly ProjectHostSetup[] {
  return setups.filter((setup) => setup.projectId === projectId)
}

export function getProjectHostSetupForRepo(
  setups: readonly ProjectHostSetup[],
  repo: Repo
): ProjectHostSetup {
  return (
    setups.find((setup) => setup.repoId === repo.id) ??
    projectHostSetupProjectionFromRepos([repo], undefined, { identityContext: [] }).setups[0]
  )
}

export function getProjectHostSetupWorktreeMeta(
  setups: readonly ProjectHostSetup[],
  repo: Repo
): Pick<WorktreeMeta, 'projectId' | 'hostId' | 'projectHostSetupId'> {
  const setup = getProjectHostSetupForRepo(setups, repo)
  return {
    projectId: setup.projectId,
    hostId: setup.hostId,
    projectHostSetupId: setup.id
  }
}
