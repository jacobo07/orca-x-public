// Row 74: the remote worktree fact crosses the relay only through the sync.v1 capability gate.
// Every failure is a free-string unknown on the model's WorktreeFact; none of them can read as clean.
import { parseReplicaFactsWire, REPLICA_FACTS_METHOD } from '../shared/replica-facts-wire'
import type { WorktreeFact } from '../shared/workspace-replica-state'
import type { ReplicaComparisonResult } from './replica-comparison-service'
import {
  requestGatedRelayMethod,
  RelayCapabilityUnsupportedError,
  type RelayCapabilityRequest
} from './ssh/ssh-relay-capabilities'

const FACTS_TIMEOUT_MS = 45_000

const unknown = (reason: string): WorktreeFact => ({ kind: 'unknown', reason })

/** The remote worktree when nothing read it (no comparison, or tips differ): unknown, never clean. */
export const UNREAD_REMOTE_WORKTREE: WorktreeFact = unknown('remote-worktree-not-read')

/** Only equal tips can be healthy, so only they spend a relay request on the remote worktree. */
export function comparisonFoundEqualTips(result: ReplicaComparisonResult): boolean {
  return result.ok && result.evidence.outcome.ok && result.evidence.outcome.ancestry.kind === 'same'
}

export async function readRemoteWorktreeFact(args: {
  connectionId: string
  generation: number
  request: RelayCapabilityRequest
  /** Absolute repository path on the relay host. */
  repoPath: string
}): Promise<WorktreeFact> {
  let answer: unknown
  try {
    answer = await requestGatedRelayMethod(
      args.connectionId,
      args.generation,
      args.request,
      REPLICA_FACTS_METHOD,
      { repoPath: args.repoPath },
      { timeoutMs: FACTS_TIMEOUT_MS }
    )
  } catch (error) {
    return error instanceof RelayCapabilityUnsupportedError
      ? unknown('remote-facts-relay-too-old')
      : unknown('remote-facts-read-failed')
  }
  const parsed = parseReplicaFactsWire(answer)
  return parsed.ok ? parsed.worktree : unknown('remote-facts-invalid')
}
