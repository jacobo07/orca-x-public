// Closed results of replica sync, divergence preservation and dirty-both reconcile as the pair service, the RPC
// and the CLI see them. Mirrors the main-process primitives and imports nothing from src/main.

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
