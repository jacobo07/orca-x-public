import type { ExecutionHostId } from './execution-host'
import type { GitRootIdentityNoneReason } from './git-root-identity'
import type { ProjectIdentityCollision } from './project-identity-collisions'
import { isHostLocalProjectId } from './project-host-setup-projection'
import type { Project, ProjectHostSetup, ProjectHostSetupMethod } from './project-types'
import type { Repo } from './repo-types'
import type { ReplicaRelation } from './workspace-replica-state'

export type ReplicaProvenance = 'imported' | 'cloned' | 'provisioned' | 'legacy' | 'unknown'

export type ReplicaMembership = 'sole' | 'grouped' | 'colliding' | 'identity-pending' | 'host-local'

export type ReplicaMembershipReason =
  | 'folder'
  | GitRootIdentityNoneReason
  | 'no-usable-root'
  | 'host-not-reporting'
  | ProjectIdentityCollision['kind']

export type ReplicaTopologyEntry = {
  setupId: string
  projectId: string
  hostId: ExecutionHostId
  path: string
  provenance: ReplicaProvenance
  membership: ReplicaMembership
  membershipReason?: ReplicaMembershipReason
  /** Only grouped members carry it: 'unverified' until ancestry evidence on transferred objects says otherwise. */
  relation?: 'unverified' | Exclude<ReplicaRelation['kind'], 'unknown'>
}

/** A setup as published to a client that supports `projects.root-identity.v1`. */
export type ProjectHostSetupWithReplicaTopology = ProjectHostSetup & {
  replicaTopology?: ReplicaTopologyEntry
}

export type ReplicaTopologyInput = {
  projects?: readonly Project[]
  setups: readonly ProjectHostSetup[]
  repos: readonly Pick<Repo, 'id' | 'kind' | 'gitRootIdentity' | 'gitRootIdentityNoneReason'>[]
  identityCollisions?: readonly ProjectIdentityCollision[]
  /** False for a host whose Orca version predates root identity: its absence is not "no root". */
  /** setupId -> relation derived from SHA-fenced ancestry evidence (row 63); absent or unknown stays 'unverified'. */
  relations?: ReadonlyMap<string, ReplicaRelation>
  hostReportsRootIdentity?: (hostId: ExecutionHostId) => boolean
}

function provenanceOf(method: ProjectHostSetupMethod | undefined): ReplicaProvenance {
  switch (method) {
    case 'imported-existing-folder':
      return 'imported'
    case 'cloned':
      return 'cloned'
    case 'provisioned':
      return 'provisioned'
    case 'legacy-repo':
      return 'legacy'
    default:
      return 'unknown'
  }
}

function hostLocalReason(
  setup: ProjectHostSetup,
  repo: ReplicaTopologyInput['repos'][number] | undefined
): ReplicaMembershipReason | undefined {
  if (setup.kind === 'folder' || repo?.kind === 'folder') {
    return 'folder'
  }
  if (repo?.gitRootIdentity === null) {
    return repo.gitRootIdentityNoneReason ?? 'no-usable-root'
  }
  return undefined
}

/**
 * Pure and recomputed on every read: provenance and membership are facts about the setup set,
 * never stored. Precedence: colliding > grouped > host-local > identity-pending > sole.
 */
export function deriveReplicaTopology(input: ReplicaTopologyInput): ReplicaTopologyEntry[] {
  const hostReports = input.hostReportsRootIdentity ?? (() => true)
  const repoById = new Map(input.repos.map((repo) => [repo.id, repo]))
  const countByProject = new Map<string, number>()
  for (const setup of input.setups) {
    countByProject.set(setup.projectId, (countByProject.get(setup.projectId) ?? 0) + 1)
  }
  const collisionBySetup = new Map<string, ProjectIdentityCollision['kind']>()
  for (const collision of input.identityCollisions ?? []) {
    for (const setupId of collision.setupIds) {
      collisionBySetup.set(setupId, collision.kind)
    }
  }

  return input.setups.map((setup): ReplicaTopologyEntry => {
    const base = {
      setupId: setup.id,
      projectId: setup.projectId,
      hostId: setup.hostId,
      path: setup.path,
      provenance: provenanceOf(setup.setupMethod)
    }
    const collision = collisionBySetup.get(setup.id)
    if (collision) {
      return { ...base, membership: 'colliding', membershipReason: collision }
    }
    if ((countByProject.get(setup.projectId) ?? 0) > 1) {
      // A diverged or unrelated pair stays grouped and visible; it is never merged or hidden.
      const known = input.relations?.get(setup.id)
      return {
        ...base,
        membership: 'grouped',
        relation: known && known.kind !== 'unknown' ? known.kind : 'unverified'
      }
    }
    if (!isHostLocalProjectId(setup.projectId)) {
      return { ...base, membership: 'sole' }
    }
    const reason = hostLocalReason(setup, repoById.get(setup.repoId))
    if (reason) {
      return { ...base, membership: 'host-local', membershipReason: reason }
    }
    return hostReports(setup.hostId)
      ? { ...base, membership: 'identity-pending' }
      : { ...base, membership: 'identity-pending', membershipReason: 'host-not-reporting' }
  })
}
