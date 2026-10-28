import {
  MAX_CONNECTED_APPLICATIONS_PER_PROJECT,
  sanitizePersistedConnectedApplications,
  type ProjectConnectedApplication
} from './connected-application'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from './execution-host'
import { ROOT_PROJECT_ID_PREFIX } from './project-root-identity-key'
import type { Project } from './project-types'
import type { Repo } from './repo-types'

export type ProjectIdentitySuccession = {
  /** Projected projects with user-set state carried forward from their predecessor row. */
  projects: readonly Project[]
  /** Predecessor project id -> surviving project id, for rows whose identity key changed. */
  remappedProjectIds: ReadonlyMap<string, string>
}

/** Ids of the repos that live on this host: the only replica a local runtime preference acts on. */
export function localRepoIdSet(
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
) {
  return new Set(
    repos
      .filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID)
      .map((r) => r.id)
  )
}

function unionConnectedApplications(claimed: readonly Project[]): ProjectConnectedApplication[] {
  const byId = new Map<string, ProjectConnectedApplication>()
  // Why: connected applications are user state too; a Studio bound to `repo:x` must survive `git:x`.
  for (const previous of claimed) {
    for (const application of sanitizePersistedConnectedApplications(
      previous.connectedApplications
    )) {
      // Why: the primary is first, so it wins an id clash.
      if (!byId.has(application.id)) {
        byId.set(application.id, application)
      }
    }
  }
  return [...byId.values()].slice(0, MAX_CONNECTED_APPLICATIONS_PER_PROJECT)
}

function pickRuntimePreference(
  claimed: readonly Project[],
  localRepoIds: ReadonlySet<string> | undefined
): Project['localWindowsRuntimePreference'] {
  // Why: the preference acts only on the local replica, so the local holder's value is the one
  // that had an effect. Two local holders keep the primary's (first) value.
  const holders = localRepoIds
    ? claimed.filter((previous) => previous.sourceRepoIds.some((id) => localRepoIds.has(id)))
    : []
  return [...holders, ...claimed].find((previous) => previous.localWindowsRuntimePreference)
    ?.localWindowsRuntimePreference
}

function carryUserState(
  projected: Project,
  claimed: readonly Project[],
  localRepoIds: ReadonlySet<string> | undefined
): Project {
  const connectedApplications = unionConnectedApplications(claimed)
  const preference = pickRuntimePreference(claimed, localRepoIds)
  if (!preference && connectedApplications.length === 0) {
    return projected
  }
  return {
    ...projected,
    ...(preference ? { localWindowsRuntimePreference: preference } : {}),
    ...(connectedApplications.length > 0 ? { connectedApplications } : {}),
    updatedAt: Math.max(projected.updatedAt, ...claimed.map((previous) => previous.updatedAt))
  }
}

function countSharedRepoIds(sourceRepoIds: readonly string[], other: ReadonlySet<string>): number {
  return sourceRepoIds.reduce((count, repoId) => (other.has(repoId) ? count + 1 : count), 0)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isRootProject(project: Project): boolean {
  return project.id.startsWith(ROOT_PROJECT_ID_PREFIX)
}

/**
 * Carries persisted per-project user state (and the rows that point at it) across a
 * project id change. Project ids are derived from repo identity, so `repo:` -> `git:` ->
 * `github:` promotion and remote re-probes rewrite them mid-session; matching only on id
 * would drop the user's runtime preference and leave a ghost row behind.
 *
 * Predecessor rule when several prior rows overlap a surviving project: most shared
 * `sourceRepoIds` wins, then newest `updatedAt`, then lowest prior id (then lowest new id).
 * Each prior row is claimed by at most one surviving project, so two distinct user
 * preferences are never merged into one - the unclaimed row keeps its own identity.
 *
 * One exception, for `git-root:` successors only: a root project groups the replicas of one
 * repository, so it also claims every other orphaned prior row whose repos it fully contains
 * (`repo:a` + `repo:b` -> `git-root:R`). Their applications are unioned (primary wins an id
 * clash) and the runtime preference comes from the claimed row holding a repo in `localRepoIds`.
 */
export function carryProjectStateThroughIdentityChange(
  projectedProjects: readonly Project[],
  previousProjects: readonly Project[],
  localRepoIds?: ReadonlySet<string>
): ProjectIdentitySuccession {
  const previousById = new Map(previousProjects.map((project) => [project.id, project]))
  const projectedIds = new Set(projectedProjects.map((project) => project.id))
  // Why: a prior row that still exists under its own id is live, not a predecessor.
  const orphanedPrevious = previousProjects.filter((project) => !projectedIds.has(project.id))
  const unmatched = projectedProjects.filter((project) => !previousById.has(project.id))
  const candidates = unmatched.flatMap((project) => {
    const repoIds = new Set(project.sourceRepoIds)
    return orphanedPrevious
      .map((previous) => ({
        project,
        previous,
        shared: countSharedRepoIds(previous.sourceRepoIds, repoIds)
      }))
      .filter((candidate) => candidate.shared > 0)
  })
  candidates.sort(
    (left, right) =>
      right.shared - left.shared ||
      right.previous.updatedAt - left.previous.updatedAt ||
      compareStrings(left.previous.id, right.previous.id) ||
      compareStrings(left.project.id, right.project.id)
  )
  const claimedPreviousIds = new Set<string>()
  const predecessorByProjectId = new Map<string, Project>()
  for (const candidate of candidates) {
    if (
      claimedPreviousIds.has(candidate.previous.id) ||
      predecessorByProjectId.has(candidate.project.id)
    ) {
      continue
    }
    claimedPreviousIds.add(candidate.previous.id)
    predecessorByProjectId.set(candidate.project.id, candidate.previous)
  }
  // Why: a root project also takes the remaining orphaned rows it fully contains, whether or
  // not it already existed under its own id (the second repo of a group joins a live row).
  const containedByProjectId = new Map<string, Project[]>()
  const rootProjects = projectedProjects.filter(isRootProject)
  const leftovers = orphanedPrevious
    .filter((previous) => !claimedPreviousIds.has(previous.id) && previous.sourceRepoIds.length > 0)
    .sort((left, right) => right.updatedAt - left.updatedAt || compareStrings(left.id, right.id))
  for (const previous of leftovers) {
    const owner = rootProjects.find((project) => {
      const repoIds = new Set(project.sourceRepoIds)
      return previous.sourceRepoIds.every((repoId) => repoIds.has(repoId))
    })
    if (!owner) {
      continue
    }
    claimedPreviousIds.add(previous.id)
    containedByProjectId.set(owner.id, [...(containedByProjectId.get(owner.id) ?? []), previous])
  }
  const remappedProjectIds = new Map<string, string>()
  const projects = projectedProjects.map((project) => {
    const exact = previousById.get(project.id)
    const primary = exact ?? predecessorByProjectId.get(project.id)
    const contained = containedByProjectId.get(project.id) ?? []
    const claimed = primary ? [primary, ...contained] : contained
    if (!exact && primary) {
      remappedProjectIds.set(primary.id, project.id)
    }
    for (const previous of contained) {
      remappedProjectIds.set(previous.id, project.id)
    }
    return claimed.length > 0 ? carryUserState(project, claimed, localRepoIds) : project
  })
  return { projects, remappedProjectIds }
}
