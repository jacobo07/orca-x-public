import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { ProjectIdentityCollision } from '../../../shared/project-identity-collisions'
import type { ProjectHostSetupProjection } from '../../../shared/project-host-setup-projection'
import type { ProjectHostSetup } from '../../../shared/project-types'
import { deriveReplicaTopology, type ReplicaTopologyEntry } from '../../../shared/replica-topology'
import type { ReplicaRelation } from '../../../shared/workspace-replica-state'
import { getProjectHostSetupProjectionFromState } from './project-host-setup-selector'
import type { AppState } from './types'

type ReplicaTopologyState = Pick<AppState, 'repos'> &
  Partial<
    Pick<
      AppState,
      'projects' | 'projectHostSetups' | 'runtimeStatusByEnvironmentId' | 'replicaPair'
    >
  >

export type ReplicaTopologyBySetupId = ReadonlyMap<string, ReplicaTopologyEntry>

const EMPTY_RUNTIME_STATUS: NonNullable<AppState['runtimeStatusByEnvironmentId']> = new Map()
// Why: every non-ready pair state shares this one map, so it stays reference-stable and feeds nothing.
const NO_RELATIONS: ReadonlyMap<string, ReplicaRelation> = new Map()
const topologyCache = new WeakMap<
  AppState['repos'],
  WeakMap<object, WeakMap<object, WeakMap<object, ReplicaTopologyBySetupId>>>
>()

function runtimeReportsRootIdentity(
  hostId: ExecutionHostId,
  runtimeStatusByEnvironmentId: NonNullable<AppState['runtimeStatusByEnvironmentId']>
): boolean {
  const host = parseExecutionHostId(hostId)
  if (host?.kind !== 'runtime') {
    // Why: this machine and SSH hosts run this build's own git probe.
    return true
  }
  const capabilities = runtimeStatusByEnvironmentId.get(host.environmentId)?.status?.capabilities
  return capabilities?.includes(PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY) ?? false
}

/**
 * Provenance and membership of every setup, from the one pure producer, over the same projection
 * the Settings section reads. Reference-stable per (repos, projection, runtime status, relations).
 */
export function getReplicaTopologyFromState(state: ReplicaTopologyState): ReplicaTopologyBySetupId {
  const projection = getProjectHostSetupProjectionFromState(state)
  const runtimeStatus = state.runtimeStatusByEnvironmentId ?? EMPTY_RUNTIME_STATUS
  // Why: only a ready answer carries relations; idle, loading, unavailable and failed never read as healthy.
  const relations =
    state.replicaPair?.status === 'ready' ? state.replicaPair.relations : NO_RELATIONS
  const byProjection = topologyCache.get(state.repos)
  const byRuntimeStatus = byProjection?.get(projection)
  const byRelations = byRuntimeStatus?.get(runtimeStatus)
  const cached = byRelations?.get(relations)
  if (cached) {
    return cached
  }
  const entries = deriveReplicaTopology({
    projects: projection.projects,
    setups: projection.setups,
    repos: state.repos,
    identityCollisions: projection.identityCollisions,
    relations,
    hostReportsRootIdentity: (hostId) => runtimeReportsRootIdentity(hostId, runtimeStatus)
  })
  const result: ReplicaTopologyBySetupId = new Map(entries.map((entry) => [entry.setupId, entry]))
  const nextByRelations = byRelations ?? new WeakMap<object, ReplicaTopologyBySetupId>()
  nextByRelations.set(relations, result)
  const nextByRuntimeStatus =
    byRuntimeStatus ?? new WeakMap<object, WeakMap<object, ReplicaTopologyBySetupId>>()
  nextByRuntimeStatus.set(runtimeStatus, nextByRelations)
  if (!byProjection) {
    topologyCache.set(state.repos, new WeakMap([[projection, nextByRuntimeStatus]]))
  } else if (!byRuntimeStatus) {
    byProjection.set(projection, nextByRuntimeStatus)
  }
  return result
}

export type ProjectReplicaNotice = {
  /** Set only for a project whose id is its first commit; other grouping evidence is not shown. */
  groupingRootCommit: string | null
  collisions: ProjectCollidingReplica[]
}

export type ProjectCollidingReplica = {
  setupId: string
  hostId: ExecutionHostId
  path: string
  kind: ProjectIdentityCollision['kind']
}

const ROOT_PROJECT_ID_PREFIX = 'git-root:'

/**
 * The first commits a project is known by: its own id when it is one, else its repos' proven root.
 */
function rootCommitsOfProject(
  projectId: string,
  setups: readonly ProjectHostSetup[],
  repos: AppState['repos']
): Set<string> {
  const roots = new Set<string>()
  if (projectId.startsWith(ROOT_PROJECT_ID_PREFIX)) {
    roots.add(projectId.slice(ROOT_PROJECT_ID_PREFIX.length))
  }
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  for (const setup of setups) {
    const root = repoById.get(setup.repoId)?.gitRootIdentity
    if (root) {
      roots.add(root.rootCommit)
    }
  }
  return roots
}

/** Collisions that concern this project, matched by first commit, with each copy's host and path. */
export function getProjectReplicaNotice(
  projection: ProjectHostSetupProjection,
  repos: AppState['repos'],
  projectId: string
): ProjectReplicaNotice {
  const own = projection.setups.filter((setup) => setup.projectId === projectId)
  const roots = rootCommitsOfProject(projectId, own, repos)
  const setupById = new Map(projection.setups.map((setup) => [setup.id, setup]))
  const collisions: ProjectCollidingReplica[] = []
  for (const record of projection.identityCollisions ?? []) {
    if (!roots.has(record.rootCommit)) {
      continue
    }
    for (const setupId of record.setupIds) {
      const setup = setupById.get(setupId)
      if (setup) {
        collisions.push({ setupId, hostId: setup.hostId, path: setup.path, kind: record.kind })
      }
    }
  }
  const groupingRootCommit = projectId.startsWith(ROOT_PROJECT_ID_PREFIX)
    ? projectId.slice(ROOT_PROJECT_ID_PREFIX.length)
    : null
  return { groupingRootCommit: own.length > 1 ? groupingRootCommit : null, collisions }
}
