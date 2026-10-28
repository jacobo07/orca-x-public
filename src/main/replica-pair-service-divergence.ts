// Preserve a diverged replica pair as create-only refs (row 66): the service half. A fresh comparison decides whether
// the pair is diverged; the stored relation is never the basis. Nothing but the primitive's refs is written.
import type { ProjectHostSetup } from '../shared/project-types'
import type {
  ReplicaObservedRelation,
  ReplicaPreserveFailureReason,
  ReplicaPreserveDivergenceResult,
  ReplicaSyncUnavailable
} from '../shared/replica-sync-view'
import type { ReplicaUnknownReason } from '../shared/workspace-replica-state'
import { preserveDivergence, type DivergencePreservation } from './replica-divergence'
import { guarded, locateReplicaTarget } from './replica-pair-service-target'
import type { ReplicaPairLedger } from './replica-pair-service-sync'
import { replicaHostKey } from './replica-pair-views'
import type { ReplicaWorktreeMutationGuard } from './replica-worktree-mutation-guard'

// Why: a comparison that threw, or found no live session, has no result to read a failure from; its unknown reason is the only trace.
const UNREACHED: Partial<Record<ReplicaUnknownReason, ReplicaPreserveFailureReason>> = {
  'host-unreachable': 'compare-relay-unsupported',
  'transfer-interrupted': 'compare-transfer-interrupted'
}

type Settled = Exclude<ReplicaPreserveDivergenceResult, ReplicaSyncUnavailable>

export type ReplicaDivergenceOperationDeps = {
  listProjectHostSetups: () => readonly ProjectHostSetup[]
  mutationGuard: ReplicaWorktreeMutationGuard
  ledger: ReplicaPairLedger
}

export type ReplicaDivergenceOperations = {
  preserveDivergence(args: { setupId: string }): Promise<Settled>
}

function viewOf(result: DivergencePreservation): Settled {
  if (result.ok) {
    const { conflict } = result
    return {
      status: 'ok',
      refs: result.refs,
      mergeBase: result.mergeBase,
      // Why: the probe's own reason text is not a product word; the only failed probe is the merge-tree one.
      conflict:
        conflict.kind === 'unknown' ? { kind: 'unknown', reason: 'merge-tree-failed' } : conflict,
      alreadyPreserved: result.alreadyPreserved
    }
  }
  switch (result.reason) {
    case 'ref-occupied':
      return { status: 'refused', reason: 'ref-occupied' }
    case 'tip-missing':
    case 'bad-input':
      return { status: 'failed', reason: result.reason }
    case 'not-diverged':
      // Unreachable: the ancestry handed to the primitive is the diverged one. A bug must not read as a refusal.
      throw new Error('preserveDivergence refused a relation the service had just found diverged')
  }
}

export function createReplicaDivergenceOperations(
  deps: ReplicaDivergenceOperationDeps
): ReplicaDivergenceOperations {
  async function run(setup: ProjectHostSetup, anchor: ProjectHostSetup): Promise<Settled> {
    const { view, result } = await deps.ledger.compareFresh(setup, anchor)
    if (result && !result.ok) {
      return {
        status: 'failed',
        reason: `compare-${result.reason}`,
        ...(result.cause ? { cause: result.cause } : {})
      }
    }
    const { relation } = view
    const unreached = relation.kind === 'unknown' ? UNREACHED[relation.reason] : undefined
    if (unreached) {
      return { status: 'failed', reason: unreached }
    }
    if (relation.kind !== 'diverged') {
      return {
        status: 'refused',
        reason: 'not-diverged',
        relation: relation.kind satisfies ReplicaObservedRelation
      }
    }
    const [localTip, remoteTip] = relation.observedTips
    return viewOf(
      await preserveDivergence({
        repoPath: anchor.path,
        hostKey: replicaHostKey(setup.hostId),
        localTip,
        remoteTip,
        ancestry: {
          kind: 'diverged',
          mergeBase: relation.mergeBase,
          aheadCount: relation.aheadCount,
          behindCount: relation.behindCount
        }
      })
    )
  }

  return {
    async preserveDivergence({ setupId }) {
      const target = locateReplicaTarget(deps.listProjectHostSetups(), setupId)
      if (!('setup' in target)) {
        return target
      }
      const { setup, anchor } = target
      const ran = await guarded(deps.mutationGuard, anchor.path, () => run(setup, anchor))
      return 'done' in ran ? ran.done : ran
    }
  }
}
