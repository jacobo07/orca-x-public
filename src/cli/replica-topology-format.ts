import type {
  ProjectHostSetupWithReplicaTopology,
  ReplicaTopologyEntry
} from '../shared/replica-topology'
import type { FanOutEntry, FanOutListing } from './handlers/project-setups-all-environments'

export const NOT_REPORTED_BY_HOST = "not reported by this host's Orca version"

export const REPLICA_LIST_HEADER = 'SETUP  PROJECT  HOST  STATE  ROLE  MEMBERSHIP  RELATION  PATH'

const DEFAULT_RUNTIME_LABEL = 'the connected Orca runtime'

export function replicaListFooter(runtimeLabel: string = DEFAULT_RUNTIME_LABEL): string {
  return `Replicas known to ${runtimeLabel}; replicas owned by other paired Orca servers are not listed here.`
}

const FAN_OUT_NO_ENVIRONMENTS =
  'No saved environments, so no other Orca server was asked. Save a paired server with `orca environment add --name <name> --pairing-code <code>`.'

// Why: every unanswered runtime states that its replicas are unknown, so a failure never reads as "none".
const FAN_OUT_UNANSWERED_TEXT = {
  unreachable: 'unreachable (could not reach this Orca server)',
  unauthorized: 'unauthorized (this Orca server rejected the saved pairing)',
  'unsupported-by-host':
    "unsupported by host (this server's Orca version cannot report project host setups)"
} as const

function fanOutSectionHeading(entry: Extract<FanOutEntry, { outcome: 'answered' }>): string {
  const runtime = entry.runtimeId ? `runtime ${entry.runtimeId}` : 'runtime id not reported'
  const aliases = entry.alsoReachedAs?.length
    ? `; also saved as: ${entry.alsoReachedAs.join(', ')}`
    : ''
  return `${entry.environment} (${runtime}${aliases})`
}

function formatFanOutEntry(entry: FanOutEntry): string {
  if (entry.outcome === 'answered') {
    const body =
      entry.setups.length === 0
        ? 'No project host setups found.'
        : [REPLICA_LIST_HEADER, ...entry.setups.map(formatReplicaListRow)].join('\n')
    return `${fanOutSectionHeading(entry)}\n${body}`
  }
  const reason =
    entry.outcome === 'failed'
      ? `failed (error code ${entry.code ?? 'unknown_error'})`
      : FAN_OUT_UNANSWERED_TEXT[entry.outcome]
  return `${entry.environment}: ${reason}; replicas unknown, not none.`
}

/** `project setups --all-environments`: one section per runtime, then which environments were asked. */
export function formatFanOutListing(listing: FanOutListing): string {
  if (listing.status === 'no-saved-environments') {
    return FAN_OUT_NO_ENVIRONMENTS
  }
  const count = listing.queried.length
  const footer = `Queried ${count} saved environment${count === 1 ? '' : 's'}: ${listing.queried.join(', ')}. Replicas owned by Orca servers that are not saved as environments are not listed here.`
  return [...listing.entries.map(formatFanOutEntry), footer].join('\n')
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
