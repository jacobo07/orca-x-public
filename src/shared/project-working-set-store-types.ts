import type { WorkingSetCorruptReason } from './project-working-set-schema'
import type { ProjectWorkingSetManifest, ProjectWorkingSetScope } from './project-working-set-types'

/** What the desktop's sealed working-set store answers. Every non-success names its own stage. */

export type WorkingSetScopeKey = Pick<ProjectWorkingSetScope, 'executionHostId' | 'ownerKey'>

export type WorkingSetStoreCorruptReason =
  | WorkingSetCorruptReason
  | 'unparseable'
  | 'oversize'
  /** Valid content whose id or scope does not belong at this path. */
  | 'misplaced'

export type WorkingSetArtifactOutcome =
  | { status: 'valid'; manifest: ProjectWorkingSetManifest }
  | { status: 'unsupported-version'; manifestVersion: number }
  | { status: 'corrupt'; reason: WorkingSetStoreCorruptReason; detail: string }
  | { status: 'unreadable'; code: string }
  | { status: 'missing' }

/** Per-pane scrollback copies taken at save; a failed copy never fails the save. */
export type WorkingSetScrollbackSealReport = {
  sealed: number
  /** No persisted scrollback existed for the pane. */
  absent: number
  failed: { tabId: string; leafId: string; code: string }[]
}

export type WorkingSetSaveOutcome =
  | {
      status: 'saved'
      workingSetId: string
      bytes: number
      scrollback: WorkingSetScrollbackSealReport
    }
  | {
      status: 'refused-invalid'
      reason: WorkingSetCorruptReason | 'non-canonical-id'
      detail: string
    }
  | { status: 'refused-unsupported-version'; manifestVersion: number }
  | { status: 'identity-collision'; workingSetId: string }
  | { status: 'write-failed'; code: string | null }
  | { status: 'durability-failed'; code: string | null }
  | { status: 'publish-failed'; code: string | null }
  /** Published, but this operation could not prove it; a later listing may still find it valid. */
  | { status: 'read-back-failed'; workingSetId: string; artifact: WorkingSetArtifactOutcome }
  /** Published and read, but not what was submitted; moved aside so history never lists it. */
  | { status: 'verify-failed'; workingSetId: string; quarantined: boolean }

export type WorkingSetHistoryItem =
  | { workingSetId: string; outcome: WorkingSetArtifactOutcome }
  | { workingSetId: string; outcome: { status: 'unverified' } }
  | { fileName: string; outcome: { status: 'unrecognized' } }

export type WorkingSetHistory =
  | {
      status: 'listed'
      /** Valid manifests, newest first; ties broken by id so the order never depends on readdir. */
      valid: ProjectWorkingSetManifest[]
      latestWorkingSetId: string | null
      /** Everything that is not a valid manifest, named only by what its path proves. */
      problems: WorkingSetHistoryItem[]
      tempArtifactCount: number
    }
  | { status: 'unreadable'; code: string }

/** The request itself was malformed; says nothing about what the store holds. */
export type WorkingSetInvalidRequest = {
  status: 'invalid-request'
  field: 'scope' | 'workingSetId'
}

/** This client has no sealed store (the browser client). Never an empty store. */
export type WorkingSetStoreUnavailable = { status: 'unavailable' }

export type WorkingSetReadResult =
  | WorkingSetArtifactOutcome
  | WorkingSetInvalidRequest
  | WorkingSetStoreUnavailable

export type WorkingSetListResult =
  | WorkingSetHistory
  | WorkingSetInvalidRequest
  | WorkingSetStoreUnavailable

export type WorkingSetSaveResult = WorkingSetSaveOutcome | WorkingSetStoreUnavailable
