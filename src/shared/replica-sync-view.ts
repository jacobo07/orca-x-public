// Closed results of replica sync, divergence preservation and dirty-both reconcile as the pair service, the RPC
// and the CLI see them. Mirrors the main-process primitives and imports nothing from src/main.
import type { CapsuleOmission } from './replica-capsule-plan'

/** Refusals decided from the stored setup alone, before any git or relay call. */
export type ReplicaSyncRefusal =
  | 'remote-caller'
  | 'no-local-anchor'
  | 'anchor-setup'
  | 'remote-runtime-unsupported'
  | 'not-a-git-repo'
  | 'worktree-missing'
  | 'worktree-busy'

/** The only cause words a failure may carry; absence means the failure had no recognised cause (a disconnect has none). */
export type ReplicaFailureCauseWord = 'disk-full'

export type ReplicaSyncComparisonFailure =
  | 'relay-unsupported'
  | 'relay-bad-response'
  | 'transfer-interrupted'
  | 'bundle-verify-failed'
  | 'bundle-heads-mismatch'
  | 'no-comparable-tip'

export type ReplicaSyncFailureReason =
  | 'invalid-input'
  | 'stale-generation'
  | 'stale-tip'
  | 'not-descendant'
  | 'capsule-failed'
  | 'ff-failed'
  | 'verify-failed'
  | 'not-behind'
  | `compare-${ReplicaSyncComparisonFailure}`

export type ReplicaObservedAncestry = 'same' | 'ahead' | 'behind' | 'diverged' | 'unrelated'

export type ReplicaSyncUnavailable = { status: 'unavailable'; reason: 'no-replica-service' }
export type ReplicaSyncNotFound = { status: 'not-found'; reason: 'unknown-setup' }

export type ReplicaSyncResult =
  | { status: 'ok'; from: string; to: string; capsuleRef?: string }
  | { status: 'refused'; reason: ReplicaSyncRefusal }
  | {
      status: 'failed'
      reason: ReplicaSyncFailureReason
      cause?: ReplicaFailureCauseWord
      capsuleRef?: string
      /** What the comparison found when the reason is `not-behind`. */
      observedAncestry?: ReplicaObservedAncestry
    }
  | ReplicaSyncUnavailable
  | ReplicaSyncNotFound

/** What a pair looked like when an operation that needs a particular relation found a different one. */
export type ReplicaObservedRelation = Exclude<ReplicaObservedAncestry, 'diverged'> | 'unknown'

/** What merging the two tips would do. `unknown` is a failed probe and is never shown or mapped as clean. */
export type ReplicaDivergenceConflict =
  | { kind: 'clean' }
  | { kind: 'conflicted'; paths: string[] }
  | { kind: 'unknown'; reason: 'merge-tree-failed' }

export type ReplicaPreserveFailureReason =
  | 'tip-missing'
  | 'bad-input'
  | `compare-${ReplicaSyncComparisonFailure}`

export type ReplicaPreserveDivergenceResult =
  | {
      status: 'ok'
      refs: { local: string; remote: string }
      mergeBase: string
      conflict: ReplicaDivergenceConflict
      /** True when both refs already existed at these tips (a repeated call); nothing was written. */
      alreadyPreserved: boolean
    }
  | { status: 'refused'; reason: ReplicaSyncRefusal | 'ref-occupied' }
  | { status: 'refused'; reason: 'not-diverged'; relation: ReplicaObservedRelation }
  | { status: 'failed'; reason: ReplicaPreserveFailureReason; cause?: ReplicaFailureCauseWord }
  | ReplicaSyncUnavailable
  | ReplicaSyncNotFound

export type ReplicaReconcileRefusal =
  | ReplicaSyncRefusal
  | 'invalid-input'
  | 'local-clean'
  | 'unknown-commit'
  | 'not-same-base'
  | 'merge-tree-unsupported'
  | 'capsule-unmerged'
  | 'capsule-unstable'

export type ReplicaReconcileResult =
  | {
      status: 'ok'
      base: string
      tree: string
      /** The merge commit, kept under `ref`; nothing was checked out and HEAD did not move. */
      commit: string
      ref: string
      localCapsuleRef: string
      /** Paths the local capsule left out; the reconciled commit does not contain them either. */
      localOmissions: CapsuleOmission[]
      /** A capsule carried untracked files that the reconciled tree does not include. */
      untrackedNotReconciled: boolean
    }
  | { status: 'refused'; reason: ReplicaReconcileRefusal }
  | { status: 'failed'; reason: 'conflict'; base: string; conflictedPaths: string[] }
  | { status: 'failed'; reason: 'commit-failed' }
  | ReplicaSyncUnavailable
  | ReplicaSyncNotFound
