import type {
  ProjectHostSetupWithReplicaTopology,
  ReplicaTopologyEntry
} from '../shared/replica-topology'

export const NOT_REPORTED_BY_HOST = "not reported by this host's Orca version"

export const REPLICA_LIST_HEADER = 'SETUP  PROJECT  HOST  STATE  ROLE  MEMBERSHIP  RELATION  PATH'

const DEFAULT_RUNTIME_LABEL = 'the connected Orca runtime'

export function replicaListFooter(runtimeLabel: string = DEFAULT_RUNTIME_LABEL): string {
  return `Replicas known to ${runtimeLabel}; replicas owned by other paired Orca servers are not listed here.`
}

/** The word the pair service published, with its count or closed reason when it carries one. */
function relationText(topology: ReplicaTopologyEntry): string {
  switch (topology.relation) {
    case undefined:
      return '-'
    case 'unverified':
      return topology.relationUnknownReason
        ? `unverified (${topology.relationUnknownReason})`
        : 'unverified'
    case 'ahead':
      return topology.relationAhead === undefined ? 'ahead' : `ahead ${topology.relationAhead}`
    case 'behind':
      return topology.relationBehind === undefined ? 'behind' : `behind ${topology.relationBehind}`
    case 'diverged':
      return topology.relationAhead === undefined || topology.relationBehind === undefined
        ? 'diverged'
        : `diverged +${topology.relationAhead}/-${topology.relationBehind}`
    default:
      return topology.relation
  }
}

/** One text row; a host that does not report topology prints the explicit unknown, never a blank. */
export function formatReplicaListRow(setup: ProjectHostSetupWithReplicaTopology): string {
  const topology = setup.replicaTopology
  const role = topology?.provenance ?? NOT_REPORTED_BY_HOST
  const membership = topology
    ? topology.membershipReason
      ? `${topology.membership} (${topology.membershipReason})`
      : topology.membership
    : NOT_REPORTED_BY_HOST
  const relation = topology ? relationText(topology) : NOT_REPORTED_BY_HOST
  return [
    setup.id,
    `project:${setup.projectId}`,
    `host:${setup.hostId}`,
    setup.setupState,
    role,
    membership,
    relation,
    setup.path
  ].join('  ')
}

export type IdentityBasis = 'github' | 'git' | 'git-root' | 'host-local' | 'unknown'

/** The prefix of a project id says what identified it; `repo:` is a per-host fallback. */
export function identityBasisOfProjectId(projectId: string): IdentityBasis {
  if (projectId.startsWith('github:')) {
    return 'github'
  }
  if (projectId.startsWith('git-root:')) {
    return 'git-root'
  }
  if (projectId.startsWith('git:')) {
    return 'git'
  }
  return projectId.startsWith('repo:') ? 'host-local' : 'unknown'
}
