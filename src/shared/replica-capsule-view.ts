// Closed results of capsule create, list and restore as the pair service, the RPC and the CLI see them.
// Mirrors the main-process primitives field for field and imports nothing from src/main, so clients can use it.
import type { CapsuleOmission } from './replica-capsule-plan'

/** Refusals the service and the RPC decide before or around the primitives. */
export type ReplicaCapsuleRefusal =
  | 'remote-caller'
  | 'remote-capsule-unsupported'
  | 'not-a-git-repo'
  | 'worktree-missing'
  | 'worktree-busy'

/** Refusal words of the restore primitive; the detail text travels beside them. */
export type ReplicaCapsuleRestoreRefusal =
  | 'invalid-capsule-argument'
  | 'invalid-mode'
  | 'capsule-unknown'
  | 'capsule-damaged'
  | 'base-mismatch'
  | 'operation-in-progress'
  | 'worktree-not-clean'
  | 'untracked-collision'

export type ReplicaCapsuleUnavailable = { status: 'unavailable'; reason: 'no-replica-service' }
export type ReplicaCapsuleNotFound = { status: 'not-found'; reason: 'unknown-setup' }

export type ReplicaCapsuleCreateOutcome =
  | { kind: 'clean' }
  | {
      kind: 'created'
      ref: string
      sha: string
      base: string
      alreadyExisted: boolean
      omissions: CapsuleOmission[]
      partial: boolean
    }

export type ReplicaCapsuleCreateResult =
  | { status: 'ok'; outcome: ReplicaCapsuleCreateOutcome }
  | { status: 'refused'; reason: ReplicaCapsuleRefusal | 'capsule-unmerged' | 'capsule-unstable' }
  | ReplicaCapsuleUnavailable
  | ReplicaCapsuleNotFound

export type ReplicaCapsuleListEntry =
  | { ref: string; sha: string; baseTip: string; partial: boolean }
  | { ref: string; damaged: true; reason: string }

export type ReplicaCapsuleListResult =
  | { status: 'ok'; capsules: ReplicaCapsuleListEntry[] }
  | { status: 'refused'; reason: ReplicaCapsuleRefusal }
  | ReplicaCapsuleUnavailable
  | ReplicaCapsuleNotFound

/** tracked = edits on top of the index, staged = index versus base, untracked = files in the untracked tree. */
export type ReplicaCapsuleChanges = { tracked: number; staged: number; untracked: number }

export type ReplicaCapsuleDescription = {
  ref: string
  sha: string
  base: string
  partial: boolean
  changes: ReplicaCapsuleChanges
}

export type ReplicaCapsuleTrees = { worktree: string; index: string; untracked: string | null }

export type ReplicaCapsuleRestoreOutcome =
  | ({ kind: 'plan' } & ReplicaCapsuleDescription)
  | ({
      kind: 'applied'
      verified: ReplicaCapsuleTrees
      recaptureRef?: string
      warnings: string[]
    } & ReplicaCapsuleDescription)

export type ReplicaCapsuleRestoreResult =
  | { status: 'ok'; outcome: ReplicaCapsuleRestoreOutcome }
  | {
      status: 'refused'
      reason: ReplicaCapsuleRefusal | ReplicaCapsuleRestoreRefusal
      /** Present when the restore primitive explains its refusal. */
      detail?: string
    }
  | {
      status: 'failed'
      reason: 'apply-failed' | 'verify-failed'
      ref: string
      detail: string
      /** Verbatim from the primitive: what is intact and where to look. */
      recovery: string
    }
  | ReplicaCapsuleUnavailable
  | ReplicaCapsuleNotFound
