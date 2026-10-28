// Re-fencing a stored pair answer on read: against the current anchor tip and, for an equal-tips answer,
// against the SSH session it was observed under (the remote half is never re-read, so its age is the only fence).
import type { ProjectHostSetup } from '../shared/project-types'
import type { ReplicaPairView } from '../shared/replica-pair-view'
import type { ReplicaFacts, ReplicaRelation } from '../shared/workspace-replica-state'
import type { ReplicaComparisonResult, SshRelaySessionDeps } from './replica-comparison-service'
import type { LocalReplicaRead } from './replica-local-facts'
import { anchorFactsOf, foldPair, localTipOf, viewOf } from './replica-pair-views'

export type StoredPair = {
  /** Set when the local tip moved under the answer (a sync): the answer is kept only as the fact that it is stale. */
  stale?: true
  anchorId: string
  local: ReplicaFacts
  remote: ReplicaFacts
  result: ReplicaComparisonResult
  /** The SSH connection the remote half was observed over, its generation then, and when (the service's clock). */
  connectionId: string
  generation: number
  observedAt: number
}

export type RemoteSessionProbe = {
  getGeneration: (connectionId: string) => number
  getMultiplexer: SshRelaySessionDeps['getMultiplexer']
}

/** False when the session the remote half was observed under has been replaced or is gone; a probe that throws is false. */
export async function remoteObservationCurrent(
  entry: StoredPair,
  probe: RemoteSessionProbe
): Promise<boolean> {
  try {
    if (probe.getGeneration(entry.connectionId) !== entry.generation) {
      return false
    }
    const mux = await probe.getMultiplexer(entry.connectionId)
    return Boolean(mux) && !mux!.isDisposed()
  } catch {
    return false
  }
}

// Why: re-derived against the current anchor so a moved local tip reads evidence-stale, never the old relation.
export async function refenceStoredPair(
  entry: StoredPair,
  setup: ProjectHostSetup,
  anchor: ProjectHostSetup,
  read: LocalReplicaRead,
  probe: RemoteSessionProbe
): Promise<ReplicaPairView> {
  const local = anchorFactsOf(read)
  const moved = localTipOf(local) !== localTipOf(entry.local)
  // A failure that carried no evidence has no tips for the model to fence, so the fence is checked here.
  let relation: ReplicaRelation =
    entry.stale || (moved && !entry.result.evidence)
      ? { kind: 'unknown', reason: 'evidence-stale' }
      : foldPair(local, read.shallow, entry.remote, entry.result)
  // Why: `same` rests on a remote rev-parse and a remote worktree fact that nothing re-reads; older than its session, it is unverified.
  let observed = !entry.stale && entry.result.evidence !== null
  if (relation.kind === 'same' && !(await remoteObservationCurrent(entry, probe))) {
    relation = { kind: 'unknown', reason: 'evidence-stale' }
    observed = false // the remote tip is part of the stale observation
  }
  return viewOf(setup, anchor, local, entry.remote, relation, observed)
}
