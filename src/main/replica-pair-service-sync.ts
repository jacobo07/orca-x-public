// One-way sync for one SSH replica (row 65): the service half of the sync verb. Everything that can be refused is
// decided from the stored setups; the rest is syncFromRelayReplica over the app's relay session, under the worktree guard.
import type { ProjectHostSetup } from '../shared/project-types'
import type {
  ReplicaObservedAncestry,
  ReplicaSyncFailureReason,
  ReplicaSyncResult,
  ReplicaSyncUnavailable
} from '../shared/replica-sync-view'
import type { ReplicaPairEvidence } from '../shared/workspace-replica-state'
import type { CapsuleGitRun } from './replica-capsule'
import { openSshRelaySession, type SshRelaySessionDeps } from './replica-comparison-service'
import { guarded, locateReplicaTarget } from './replica-pair-service-target'
import { replicaHostKey } from './replica-pair-views'
import {
  syncFromRelayReplica,
  type GitRun,
  type ReplicaSyncFailure,
  type ReplicaSyncResult as PrimitiveSyncResult
} from './replica-sync'
import type { ReplicaWorktreeMutationGuard } from './replica-worktree-mutation-guard'

/** What the pair service remembers about a pair; sync tells it what it has just done to the local tip. */
export type ReplicaPairLedger = {
  /** Folds already-gathered evidence into the stored answer, with no new transfer. */
  adoptEvidence(
    setup: ProjectHostSetup,
    anchor: ProjectHostSetup,
    evidence: ReplicaPairEvidence
  ): Promise<void>
  /** The local tip moved: the stored answer for this setup can no longer be trusted. */
  markStale(setupId: string): void
}

export type ReplicaSyncOperationDeps = {
  listProjectHostSetups: () => readonly ProjectHostSetup[]
  mutationGuard: ReplicaWorktreeMutationGuard
  /** Production leaves it out and gets the live SSH session. */
  sshSession?: Partial<SshRelaySessionDeps>
  git?: GitRun
  capsuleGit?: CapsuleGitRun
  ledger: ReplicaPairLedger
}

export type ReplicaSyncOperations = {
  sync(args: { setupId: string }): Promise<Exclude<ReplicaSyncResult, ReplicaSyncUnavailable>>
}

// Why: a Record over the primitive's own union, so a new primitive reason is a type error here and not a silent pass-through.
const FAILURE_WORD: Record<ReplicaSyncFailure, ReplicaSyncFailureReason> = {
  'invalid-input': 'invalid-input',
  'stale-generation': 'stale-generation',
  'stale-tip': 'stale-tip',
  'not-descendant': 'not-descendant',
  'capsule-failed': 'capsule-failed',
  'ff-failed': 'ff-failed',
  'verify-failed': 'verify-failed',
  'not-behind': 'not-behind',
  'compare-relay-unsupported': 'compare-relay-unsupported',
  'compare-relay-bad-response': 'compare-relay-bad-response',
  'compare-transfer-interrupted': 'compare-transfer-interrupted',
  'compare-bundle-verify-failed': 'compare-bundle-verify-failed',
  'compare-bundle-heads-mismatch': 'compare-bundle-heads-mismatch',
  'compare-no-comparable-tip': 'compare-no-comparable-tip'
}

function ancestryOf(
  evidence: ReplicaPairEvidence | undefined
): ReplicaObservedAncestry | undefined {
  return evidence?.outcome.ok ? evidence.outcome.ancestry.kind : undefined
}

function viewOf(result: PrimitiveSyncResult): Exclude<ReplicaSyncResult, ReplicaSyncUnavailable> {
  if (result.ok) {
    return {
      status: 'ok',
      from: result.from,
      to: result.to,
      ...(result.capsuleRef ? { capsuleRef: result.capsuleRef } : {})
    }
  }
  const observedAncestry = ancestryOf(result.evidence)
  return {
    status: 'failed',
    reason: FAILURE_WORD[result.reason],
    ...(result.cause ? { cause: result.cause } : {}),
    ...(result.capsuleRef ? { capsuleRef: result.capsuleRef } : {}),
    ...(observedAncestry ? { observedAncestry } : {})
  }
}

export function createReplicaSyncOperations(deps: ReplicaSyncOperationDeps): ReplicaSyncOperations {
  async function runSync(
    setup: ProjectHostSetup,
    anchor: ProjectHostSetup,
    connectionId: string
  ): Promise<Exclude<ReplicaSyncResult, ReplicaSyncUnavailable>> {
    const session = await openSshRelaySession(connectionId, deps.sshSession)
    if (!session) {
      return { status: 'failed', reason: 'compare-relay-unsupported' }
    }
    const result = await syncFromRelayReplica({
      connectionId,
      generation: session.generation,
      currentGeneration: session.currentGeneration,
      request: session.request,
      localRepoPath: anchor.path,
      remoteRepoPath: setup.path,
      hostKey: replicaHostKey(setup.hostId),
      git: deps.git,
      capsuleGit: deps.capsuleGit
    })
    if (result.ok || result.reason === 'verify-failed') {
      // The local tip moved (or may have): whatever was stored about this pair described the old tip.
      deps.ledger.markStale(setup.id)
    } else if (result.reason === 'not-behind' && result.evidence) {
      await deps.ledger.adoptEvidence(setup, anchor, result.evidence)
    }
    return viewOf(result)
  }

  return {
    async sync({ setupId }) {
      const target = locateReplicaTarget(deps.listProjectHostSetups(), setupId)
      if (!('setup' in target)) {
        return target
      }
      const { setup, anchor, connectionId } = target
      const ran = await guarded(deps.mutationGuard, anchor.path, () =>
        runSync(setup, anchor, connectionId)
      )
      return 'done' in ran ? ran.done : ran
    }
  }
}
